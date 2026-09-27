import { useSyncExternalStore } from 'react';
import type { RunId } from './load.ts';
import type { WatchResult } from './watch.ts';

/* Мониторинги — записи о запусках живого вида.

   Смена (`watch.ts`) отвечает на «как диспетчер отработал календарный день»:
   она одна на дату и копит в себе все заходы. Но запуск наблюдения — это
   отдельная работа со своим набором районов и своими расчётами: утром
   смотрели за Востоком по R-1207, после обеда добавили Центр и сменили план.
   В одной суточной записи эти два наблюдения сливаются в кашу, и ответить,
   по какому расчёту шёл Восток утром, уже нечем.

   Поэтому здесь запись — на запуск. Она заводится сама, в ту минуту, когда
   нажали «Смотреть», получает сквозной номер (M0001 по всей базе, не заново
   в каждом дне) и дальше растёт, пока живой вид открыт: копится время
   наблюдения, обновляются числа и разбор по районам.

   Разбор по районам — то, чего нет ни в смене, ни в архиве расчётов: у
   каждого наблюдаемого района свой расчёт, свой штат и свои маршруты, и
   вопрос «сколько инженеров было на Востоке и сколько маршрутов они
   закрыли» задают о районе, а не о смене целиком.

   Живёт в браузере, как и смены с рабочими расчётами: это работа диспетчера,
   а не данные движка. Состояние держит модуль, а не React: пишет мониторинг,
   читают ворота раздела, и родни между ними нет. */

const STORE_KEY = 'polet.monitor.v1';

/** Сколько записей храним. Два месяца запусков — предел, за которым список
    перестают пролистывать глазами. */
const KEEP = 60;

/** Перерыв, после которого наблюдение считается прерванным: то же правило,
    что и у смены, — раздел отвечает каждую минуту, молчание дольше значит
    закрытую вкладку. */
const GAP_MINUTES = 5;

/** Район под наблюдением со всем, что о нём известно к последнему взгляду.

    Числа снимаются с плана того расчёта, который вёл район в это
    наблюдение, — поэтому запись честно называет и расчёт, и дату его дня. */
export interface MonitorPart {
  /** Расчёт, который вёл район. */
  run: RunId;
  /** Район словами: «Восток». */
  place: string;
  /** Дата дня участка, ISO. */
  date: string;
  /** Инженеров в штате района. */
  engineers: number;
  /** Из них на смене к последнему взгляду. */
  onShift: number;
  /** Маршрутов в плане района. */
  routes: number;
  /** Маршрутов, пройденных до конца. */
  routesDone: number;
  /** Заявок в плане района. */
  orders: number;
  /** Из них закрыто к последнему взгляду. */
  done: number;
}

export interface MonitorRun {
  /** Ключ записи — её день. Мониторинг один на календарный день: диспетчер
      заходит в раздел утром, возвращается днём и вечером, и все эти заходы
      принадлежат одной работе, а не трём разным. */
  id: string;
  /** Сквозной номер записи. */
  no: number;
  /** Дата запуска, ISO. */
  date: string;
  /** Когда нажали «Смотреть», «09:12». */
  started: string;
  /** Когда смотрели в последний раз. */
  seen: string;
  /** Сколько минут живой вид был открыт. Копится отрезками наблюдения, а не
      считается разностью концов. */
  minutes: number;
  /** Дни районов под наблюдением словами: «Восток · 17.08.2026». */
  places: string[];
  /** Расчёты, которые их вели. */
  runs: RunId[];
  /** Разбор по районам на последний взгляд. */
  parts: MonitorPart[];
  /** Итог по всем районам разом — те же числа, что на полосе живого вида. */
  result: WatchResult | null;
}

const pad = (value: number) => String(value).padStart(2, '0');

const isoOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const clockOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** Номер записи словами: «G0001». Четыре знака — как у маршрутов и заявок.

    Буква своя: «M» по всей базе занята маршрутами, и мониторинг под тем же
    знаком читался бы как маршрут — в поиске, в журнале и в разговоре. */
export const monitorCode = (no: number): string => `G${String(no).padStart(4, '0')}`;

const num = (value: unknown): number => (typeof value === 'number' && value >= 0 ? value : 0);

function cleanPart(row: unknown): MonitorPart | null {
  if (!row || typeof row !== 'object') return null;
  const one = row as Partial<MonitorPart>;
  if (!isText(one.run) || !isText(one.place)) return null;
  return {
    run: one.run,
    place: one.place,
    date: isText(one.date) ? one.date : '',
    engineers: num(one.engineers),
    onShift: num(one.onShift),
    routes: num(one.routes),
    routesDone: num(one.routesDone),
    orders: num(one.orders),
    done: num(one.done)
  };
}

/** Записи из хранилища. Пересобираем по одной: лежит то, что положила
    прошлая версия, и одна кривая запись не должна утащить за собой список. */
function read(): MonitorRun[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    const clean: MonitorRun[] = [];
    for (const row of saved) {
      if (!row || typeof row !== 'object') continue;
      const one = row as Partial<MonitorRun>;
      if (!isText(one.id) || typeof one.no !== 'number') continue;
      clean.push({
        id: one.id,
        no: one.no,
        date: isText(one.date) ? one.date : '',
        started: isText(one.started) ? one.started : '',
        seen: isText(one.seen) ? one.seen : '',
        minutes: num(one.minutes),
        places: Array.isArray(one.places) ? one.places.filter(isText) : [],
        runs: Array.isArray(one.runs) ? one.runs.filter(isText) : [],
        parts: Array.isArray(one.parts)
          ? one.parts.map(cleanPart).filter((part): part is MonitorPart => part !== null)
          : [],
        result:
          one.result && typeof one.result === 'object' ? (one.result as WatchResult) : null
      });
    }
    return sort(fold(clean)).slice(0, KEEP);
  } catch {
    return [];
  }
}

/** Сводит записи одного дня в одну.

    Прежде запись заводилась на каждый запуск наблюдения, и за день их
    набиралось несколько. Дня это не отражало: диспетчер весь день вёл одну
    работу, а карточек о ней оставалось три. Здесь такие записи сходятся
    обратно — номер берётся первый, время наблюдения складывается, районы и
    их разбор собираются вместе. */
function fold(list: MonitorRun[]): MonitorRun[] {
  const byDate = new Map<string, MonitorRun>();
  for (const row of [...list].sort((a, b) => a.id.localeCompare(b.id))) {
    const date = row.date || row.id;
    const was = byDate.get(date);
    if (!was) {
      byDate.set(date, { ...row, id: date });
      continue;
    }
    byDate.set(date, {
      ...was,
      no: Math.min(was.no, row.no),
      started: was.started && was.started <= row.started ? was.started : row.started,
      seen: was.seen >= row.seen ? was.seen : row.seen,
      minutes: Math.round((was.minutes + row.minutes) * 10) / 10,
      places: [...new Set([...was.places, ...row.places])],
      runs: [...new Set([...was.runs, ...row.runs])],
      parts: mergeParts(was.parts, row.parts),
      result: row.result ?? was.result
    });
  }
  return [...byDate.values()];
}

/** Разбор по районам: свежая отметка района вытесняет прежнюю, районы,
    которых в ней нет, остаются. За день смотрели и за Востоком, и за
    Центром — в записи дня должны быть оба, даже если под конец наблюдения
    на карте остался один. */
function mergeParts(was: MonitorPart[], now: MonitorPart[]): MonitorPart[] {
  const byRun = new Map(was.map((part) => [part.run, part]));
  for (const part of now) byRun.set(part.run, part);
  return [...byRun.values()];
}

/** Свежие сверху: список читают глазами с верхней записи. */
const sort = (list: MonitorRun[]): MonitorRun[] =>
  [...list].sort((a, b) => b.id.localeCompare(a.id));

let current = read();
const watchers = new Set<() => void>();

function save(next: MonitorRun[]): void {
  current = sort(next).slice(0, KEEP);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(current));
    } catch {
      /* Приватный режим и переполненное хранилище: записи тогда живут до
         перезагрузки. Это хуже, чем ничего не делать, но не ошибка. */
    }
  }
  for (const watcher of watchers) watcher();
}

/* Запись, которую сейчас ведут, и минута её последней отметки. Держим в
   памяти, а не в хранилище: это состояние открытой вкладки, а не факт о
   наблюдении. Две вкладки рядом ведут каждая свою запись — зато ни одна не
   запишет чужой простой как своё наблюдение. */
let openId: string | null = null;
let lastBeat: number | null = null;

/** Сквозной номер следующей записи: за наибольшим из тех, что уже есть.
    Не длина списка — стёртая из потолка запись вернула бы чужой номер. */
const nextNo = (): number => current.reduce((top, one) => Math.max(top, one.no), 0) + 1;

/** Запускает наблюдение: живой вид открыт по этим районам.

    Зовётся на каждое нажатие «Смотреть». Запись заводится новая — это и есть
    смысл записи на запуск: сменили состав районов, вернулись к наблюдению
    через час — это другая работа, и в списке она стоит отдельной карточкой.

    Возвращает номер записи — той, что с этой минуты растёт. */
export function startMonitor(places: string[], runs: RunId[]): number {
  const now = new Date();
  const date = isoOf(now);
  openId = date;
  lastBeat = now.getTime();

  /* Запись дня уже есть — наблюдение просто продолжается. Состав районов
     дополняется, а не заменяется: утром смотрели за Востоком, после обеда
     добавили Центр — за день работали с обоими. */
  const found = current.find((one) => one.id === date);
  if (found) {
    save([
      {
        ...found,
        seen: clockOf(now),
        places: [...new Set([...found.places, ...places])],
        runs: [...new Set([...found.runs, ...runs])]
      },
      ...current.filter((one) => one.id !== date)
    ]);
    return found.no;
  }

  const no = nextNo();
  save([
    {
      id: date,
      no,
      date,
      started: clockOf(now),
      seen: clockOf(now),
      minutes: 0,
      places,
      runs,
      parts: [],
      result: null
    },
    ...current
  ]);
  return no;
}

/** Отметка живого вида: он открыт, и вот что в нём видно на эту минуту.

    Зовётся с тем же шагом, с каким мониторинг перечитывает часы. Время
    копится от отметки к отметке, разрыв дольше пяти минут в счёт не идёт.
    Записи в хранилище не идут чаще, чем что-то меняется: минута, числа или
    разбор по районам. */
export function markMonitor(result: WatchResult, parts: MonitorPart[]): void {
  if (openId === null) return;
  const row = current.find((one) => one.id === openId);
  if (!row) return;
  const now = new Date();
  const stamp = clockOf(now);
  const gap = lastBeat === null ? 0 : (now.getTime() - lastBeat) / 60_000;
  lastBeat = now.getTime();
  const grown = gap > 0 && gap <= GAP_MINUTES ? row.minutes + gap : row.minutes;
  const minutes = Math.round(grown * 10) / 10;
  if (row.seen === stamp && minutes === row.minutes && same(row, result, parts)) return;
  save([
    {
      ...row,
      seen: stamp,
      minutes,
      result,
      /* Разбор по районам слипается с тем, что уже записано за день:
         свежая отметка обновляет свои районы, а те, за которыми смотрели
         утром и сняли с карты днём, из записи дня не пропадают. */
      parts: mergeParts(row.parts, parts),
      places: row.places,
      runs: [...new Set([...row.runs, ...parts.map((part) => part.run)])]
    },
    ...current.filter((one) => one.id !== row.id)
  ]);
}

/** Ничего не изменилось с прошлой отметки. Сравниваем по числам, а не по
    ссылкам: вид пересобирается каждые двадцать секунд, и по ссылкам запись
    шла бы в хранилище всегда. */
function same(row: MonitorRun, result: WatchResult, parts: MonitorPart[]): boolean {
  const was = row.result;
  if (
    !was ||
    was.orders !== result.orders ||
    was.done !== result.done ||
    was.onShift !== result.onShift ||
    was.engineers !== result.engineers ||
    was.late !== result.late ||
    Math.round(was.assigned) !== Math.round(result.assigned)
  ) {
    return false;
  }
  /* Разбор сравниваем по районам, а не по местам в списке: в записи дня
     лежат все районы, за которыми смотрели, а в свежей отметке — только те,
     что на карте сейчас. */
  return parts.every((part) => {
    const old = row.parts.find((one) => one.run === part.run);
    return (
      old !== undefined &&
      old.engineers === part.engineers &&
      old.onShift === part.onShift &&
      old.routes === part.routes &&
      old.routesDone === part.routesDone &&
      old.orders === part.orders &&
      old.done === part.done
    );
  });
}

/** Наблюдение кончилось: ушли из живого вида, сняли все районы или закрыли
    вкладку. Запись остаётся как есть — числа в ней сняты на последнюю
    минуту, когда живой вид был открыт, и подменять их итогом дня нечем. */
export function endMonitor(): void {
  openId = null;
  lastBeat = null;
}

/** Запись, которую ведут прямо сейчас. Пусто — наблюдение не идёт. */
export const openMonitor = (): MonitorRun | null =>
  openId === null ? null : (current.find((one) => one.id === openId) ?? null);

/** Все записи, свежие сверху. */
export const monitors = (): MonitorRun[] => current;

/** Какая доля заявок наблюдаемых районов закрыта к последнему взгляду. Нет
    снимка — нет и ответа: ноль читался бы как сорванное наблюдение. */
export function monitorDone(row: MonitorRun): number | null {
  if (!row.result || row.result.orders <= 0) return null;
  return (row.result.done / row.result.orders) * 100;
}

/** Забыть записи целиком. Нужно настройкам: данные рабочего места диспетчер
    вправе очистить, как и историю расчётов. */
export function clearMonitors(): void {
  openId = null;
  lastBeat = null;
  save([]);
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Подписка для компонентов: перерисовываются, когда запись пополнилась. */
export function useMonitors(): MonitorRun[] {
  return useSyncExternalStore(subscribe, monitors, () => []);
}
