import { useSyncExternalStore } from 'react';
import type { RunId } from './load.ts';

/* Смены наблюдения — то, как диспетчер отработал день.

   Расчёт отвечает на «каким должен быть план», мониторинг — «что происходит
   сейчас». Но к вечеру и то и другое становится прошлым, и у руководителя
   появляется третий вопрос: «как прошли предыдущие дни». Ответа на него не
   было нигде: план остаётся в архиве расчётов, живой вид гаснет вместе с
   закрытой вкладкой, а всё, что диспетчер делал между ними, не оставляло
   следа вовсе.

   Здесь этот след и заводится. Запись — одна на календарный день работы:
   диспетчер заходит в мониторинг утром, возвращается к нему днём и вечером,
   и все эти заходы принадлежат одной смене, а не трём разным. Внутри смены
   лежит то, что о ней известно: за какими участками смотрели, какие расчёты
   их вели, сколько времени раздел был открыт, чем день кончился по
   последнему взгляду и что за день произошло.

   Ничего не выдумывается. Пустая история означает ровно то, что означает:
   мониторинг ещё не открывали. Первая запись появляется с первым заходом в
   живой вид, и дальше растёт сама.

   Живёт в браузере, рядом с настройками рабочего места и рабочими расчётами
   (`duty.ts`): это работа диспетчера, а не данные движка. Движок считает
   планы и не знает, кто и сколько на них смотрел.

   Состояние держит модуль, а не React: смену пишут мониторинг, ворота
   мониторинга и воздействие, а читает Главная, и родни между ними нет.
   Компоненты подписываются через `useShifts`, остальные зовут `shifts`. */

const STORE_KEY = 'polet.watch.v1';

/** Сколько смен храним. Месяц работы — предел, за которым список перестают
    пролистывать глазами; и это ещё и потолок для хранилища браузера. */
const KEEP_DAYS = 31;

/** Сколько событий храним в одной смене. День диспетчера — это десятки
    отметок, а не тысячи; потолок стоит на случай смены, которую не закрывали
    сутки. Лишнее отрезается с начала: свежее важнее. */
const KEEP_EVENTS = 200;

/** Перерыв, после которого наблюдение считается прерванным. Раздел открыт и
    отвечает каждую минуту; молчание дольше — это закрытая вкладка или
    ушедший от стола человек, и записывать это время как наблюдение нечестно. */
const GAP_MINUTES = 5;

/** Род события смены. Различаются не ради значков, а ради отбора: «что
    произошло за вчера» и «что я в этот день пересчитывал» — разные вопросы. */
export type WatchEventKind =
  /** Само наблюдение: начали смотреть, сменили состав участков, закончили. */
  | 'watch'
  /** Расчёт взят в работу на свой день. */
  | 'duty'
  /** Происшествие: авария, отмена, выбывший инженер, задержка. */
  | 'incident'
  /** Пересчёт остатка дня сохранён отдельной записью. */
  | 'replan'
  /** Посчитан новый расчёт. */
  | 'run';

export interface WatchEvent {
  /** Время события в этот день, «14:05». */
  at: string;
  kind: WatchEventKind;
  /** Событие словами — так, как о нём рассказал бы диспетчер. */
  text: string;
  /** Расчёт, которого событие касается. Есть — карточка события открывает
      его поверх экрана, как и всюду в базах. */
  run?: RunId;
}

/** Чем день кончился по последнему взгляду на живой вид. Снимок, а не
    итог: диспетчер мог уйти из мониторинга в три часа дня, и числа тогда
    трёхчасовые — смена честно говорит, на какую минуту они сняты. */
export interface WatchResult {
  /** Заявок в наблюдаемых днях. */
  orders: number;
  /** Из них закрыто к последнему взгляду. */
  done: number;
  /** Инженеров на смене. */
  onShift: number;
  /** Инженеров в штате наблюдаемых участков. */
  engineers: number;
  /** Опаздывали на последнюю минуту наблюдения. */
  late: number;
  /** Какая доля заявок наблюдаемых дней вообще досталась инженерам,
      проценты. Это не прогноз выполнения: прогноз обещает движок по своему
      плану, а здесь — сколько заявок в планах смены имеют исполнителя.
      Разница между ней и выполнением и есть то, что день не вывез. */
  assigned: number;
}

export interface WatchShift {
  /** Дата смены, ISO. Она же ключ: смена одна на календарный день. */
  date: string;
  /** Когда открыли мониторинг в первый раз за день, «08:12». */
  opened: string;
  /** Когда смотрели в последний раз. */
  seen: string;
  /** Сколько минут раздел был открыт. Копится отрезками наблюдения, а не
      считается разностью концов: между утренним и вечерним заходом
      диспетчер занят другим, и записывать этот промежуток в наблюдение
      значило бы обещать восемь часов слежения вместо сорока минут. */
  minutes: number;
  /** Дни участков под наблюдением словами: «Восток · 17.08.2026». */
  places: string[];
  /** Расчёты, которые вели эти дни. */
  runs: RunId[];
  result: WatchResult | null;
  events: WatchEvent[];
}

const pad = (value: number) => String(value).padStart(2, '0');

const isoOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const clockOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Смены из хранилища. Пересобираем по одной записи: в хранилище лежит то,
    что положила прошлая версия, и одна кривая смена не должна утаскивать за
    собой весь журнал. */
function read(): WatchShift[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    const clean: WatchShift[] = [];
    for (const row of saved) {
      if (!row || typeof row !== 'object') continue;
      const one = row as Partial<WatchShift>;
      if (!isText(one.date)) continue;
      clean.push({
        date: one.date,
        opened: isText(one.opened) ? one.opened : '',
        seen: isText(one.seen) ? one.seen : '',
        minutes: typeof one.minutes === 'number' && one.minutes >= 0 ? one.minutes : 0,
        places: Array.isArray(one.places) ? one.places.filter(isText) : [],
        runs: Array.isArray(one.runs) ? one.runs.filter(isText) : [],
        result: one.result && typeof one.result === 'object' ? (one.result as WatchResult) : null,
        events: Array.isArray(one.events)
          ? one.events
              .filter((event): event is WatchEvent => Boolean(event) && isText((event as WatchEvent).text))
              .slice(-KEEP_EVENTS)
          : []
      });
    }
    /* Свежие сверху — в этом порядке смены и читают. */
    return clean.sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
  } catch {
    /* Испорченная запись — не повод не открыться: журнал начинается заново. */
    return [];
  }
}

let current = read();
const watchers = new Set<() => void>();

function save(next: WatchShift[]): void {
  current = next.sort((a, b) => b.date.localeCompare(a.date)).slice(0, KEEP_DAYS);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(current));
    } catch {
      /* Приватный режим и переполненное хранилище: журнал тогда живёт до
         перезагрузки. Это хуже, чем ничего не делать, но не ошибка. */
    }
  }
  for (const watcher of watchers) watcher();
}

/** Смена этого дня, заводя её, если дня ещё нет. */
function shiftFor(now: Date): WatchShift {
  const date = isoOf(now);
  const found = current.find((one) => one.date === date);
  if (found) return found;
  return {
    date,
    opened: clockOf(now),
    seen: clockOf(now),
    minutes: 0,
    places: [],
    runs: [],
    result: null,
    events: []
  };
}

/** Кладёт смену на место — заменяя прежнюю запись того же дня. */
function put(shift: WatchShift): void {
  save([shift, ...current.filter((one) => one.date !== shift.date)]);
}

/* Когда наблюдение отметилось в последний раз. Держим в памяти, а не в
   записи: это не факт о смене, а состояние открытой вкладки. Две вкладки
   рядом считали бы время каждая по-своему — зато ни одна не запишет чужой
   простой как своё наблюдение. */
let lastBeat: number | null = null;

/** Начать наблюдение: раздел перешёл к живому виду.

    Зовётся и при первом за день заходе, и при каждом возвращении — смена от
    этого не заводится заново, а событие пишется только тогда, когда состав
    участков отличается от того, за которым смотрели прежде. Иначе журнал за
    день состоял бы из одной строки, повторённой двадцать раз. */
export function startWatch(places: string[], runs: RunId[]): void {
  const now = new Date();
  const shift = shiftFor(now);
  const same =
    shift.places.length === places.length && places.every((place) => shift.places.includes(place));
  lastBeat = now.getTime();
  const events = same
    ? shift.events
    : [
        ...shift.events,
        {
          at: clockOf(now),
          kind: 'watch' as const,
          text:
            places.length === 0
              ? 'Наблюдение начато'
              : `Наблюдение: ${places.join(', ')}`
        }
      ];
  put({
    ...shift,
    seen: clockOf(now),
    places,
    runs: [...new Set([...shift.runs, ...runs])],
    events: events.slice(-KEEP_EVENTS)
  });
}

/** Отметка живого вида: он открыт и вот что в нём видно.

    Зовётся с тем же шагом, с каким мониторинг перечитывает часы. Время
    наблюдения копится от отметки к отметке, а разрыв дольше пяти минут в
    счёт не идёт — см. `GAP_MINUTES`. Запись в хранилище идёт не чаще раза в
    минуту: чаще нечего записывать, а localStorage — вещь не бесплатная. */
export function markWatch(result: WatchResult): void {
  const now = new Date();
  const shift = shiftFor(now);
  const stamp = clockOf(now);
  const gap = lastBeat === null ? 0 : (now.getTime() - lastBeat) / 60_000;
  lastBeat = now.getTime();
  const grown = gap > 0 && gap <= GAP_MINUTES ? shift.minutes + gap : shift.minutes;
  /* Минута не сменилась и числа те же — писать нечего. */
  if (shift.seen === stamp && sameResult(shift.result, result) && grown === shift.minutes) return;
  put({ ...shift, seen: stamp, minutes: Math.round(grown * 10) / 10, result });
}

const sameResult = (was: WatchResult | null, now: WatchResult): boolean =>
  was !== null &&
  was.orders === now.orders &&
  was.done === now.done &&
  was.onShift === now.onShift &&
  was.engineers === now.engineers &&
  was.late === now.late &&
  Math.round(was.assigned) === Math.round(now.assigned);

/** Наблюдение прервано: ушли из живого вида или закрыли вкладку. Время
    перестаёт копиться, событие пишется одно на выход. */
export function stopWatch(): void {
  const now = new Date();
  const shift = current.find((one) => one.date === isoOf(now));
  lastBeat = null;
  if (!shift || shift.places.length === 0) return;
  const last = shift.events[shift.events.length - 1];
  if (last && last.kind === 'watch' && last.text === 'Наблюдение завершено') return;
  put({
    ...shift,
    seen: clockOf(now),
    events: [
      ...shift.events,
      { at: clockOf(now), kind: 'watch' as const, text: 'Наблюдение завершено' }
    ].slice(-KEEP_EVENTS)
  });
}

/** Записать событие в сегодняшнюю смену.

    Событие пишется и тогда, когда мониторинг сегодня не открывали: расчёт
    взяли в работу утром, происшествие объявили днём — это работа того же
    дня, и в его журнале ей место. Смена от этого заводится с нулевым
    наблюдением, и так и показывается: «в мониторинг не заходили». */
export function logWatch(kind: WatchEventKind, text: string, run?: RunId): void {
  const now = new Date();
  const shift = shiftFor(now);
  const event: WatchEvent = { at: clockOf(now), kind, text, ...(run ? { run } : {}) };
  /* Одно и то же событие подряд не удваиваем: «взять в работу» нажимают
     дважды чаще, чем кажется. */
  const last = shift.events[shift.events.length - 1];
  if (last && last.kind === kind && last.text === text) return;
  put({
    ...shift,
    seen: clockOf(now),
    runs: run ? [...new Set([...shift.runs, run])] : shift.runs,
    events: [...shift.events, event].slice(-KEEP_EVENTS)
  });
}

/** Сегодняшний день ключом журнала: по нему смену отличают от прошедших. */
export const todayKey = (): string => isoOf(new Date());

/** Весь журнал, свежие смены сверху. */
export const shifts = (): WatchShift[] => current;

/** Смена этого дня, если он в журнале есть. */
export const shiftOn = (date: string): WatchShift | null =>
  current.find((one) => one.date === date) ?? null;

/** Успешность смены: какая доля заявок наблюдаемых дней закрыта к
    последнему взгляду. Это не «покрытие» расчёта — покрытие обещает
    движок, а здесь то, что вышло на самом деле. Нет снимка — нет и ответа:
    ноль читался бы как сорванный день. */
export function successOf(shift: WatchShift): number | null {
  const result = shift.result;
  if (!result || result.orders <= 0) return null;
  return (result.done / result.orders) * 100;
}

/** Смотрели ли в этот день живой вид. Смена бывает и без наблюдения — от
    одних событий дня, — и говорить о ней надо по-другому. */
export const wasWatched = (shift: WatchShift): boolean => shift.places.length > 0;

/** Сколько времени заняло наблюдение, словами: «1 ч 20 мин». Меньше минуты —
    «меньше минуты»: «0 мин» читается как поломка счётчика. */
export function watchTime(minutes: number): string {
  const whole = Math.round(minutes);
  if (whole <= 0) return 'меньше минуты';
  if (whole < 60) return `${whole} мин`;
  const hours = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${hours} ч` : `${hours} ч ${rest} мин`;
}

/** Забыть журнал целиком. Нужен настройкам: данные рабочего места диспетчер
    вправе очистить, как и историю расчётов. */
export function clearShifts(): void {
  lastBeat = null;
  save([]);
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Подписка для компонентов: перерисовываются, когда смена пополнилась. */
export function useShifts(): WatchShift[] {
  return useSyncExternalStore(subscribe, shifts, () => []);
}
