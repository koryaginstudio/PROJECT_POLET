import { useSyncExternalStore } from 'react';
import { engineDayTitle, RUNS, zoneTitle } from './load.ts';
import type { RunId } from './load.ts';

/* Расчёт, взятый в работу на свой день.

   Расчётов на один и тот же день бывает сколько угодно: день пересчитывают с
   другими переменными, пока результат не устроит. Все они остаются в истории —
   это и есть архив, — но работают в конце концов по одному. Кнопка «В работу»
   и говорит, по какому именно: этот расчёт с этой минуты принадлежит своему
   дню, а остальные прогоны того же дня становятся черновиками к нему.

   День здесь — день участка, а не календарный. Три зоны выгрузки разложены
   на одну и ту же дату, и по календарной дате взятый в работу Центр молча
   снимал с работы Восток: у дня оказывался один хозяин на три участка.
   Поэтому ключ — источник расчёта вместе с датой: у каждого участка свой
   рабочий расчёт на день, и соседний участок ему не мешает.

   Отсюда и устройство хранилища: не флажок на записи расчёта, а список
   «день участка → расчёт». Флажок пришлось бы снимать у соседей вручную и
   следить, чтобы у дня не оказалось двух хозяев; здесь двух не бывает по
   самому виду записи — ключ один, значение одно.

   Живёт в браузере, рядом с настройками рабочего места. Движок об этом не
   знает и знать не должен: он считает планы, а какой из них взяли в работу —
   решение диспетчера, и делается оно уже после расчёта.

   Состояние держит модуль, а не React: спросить «этот расчёт в работе?» нужно
   и карточке в базе, и подшапке диспетчерской, и они друг другу не родня.
   Компоненты подписываются через `useDuty`, остальные зовут `onDuty` и
   `holderOf` — ключ собирается здесь, и знать его устройство снаружи незачем. */

const STORE_KEY = 'polet.duty.v1';

/** День участка (`восток|2026-08-17`) → расчёт, который на нём работает. */
export type DutyMap = Record<string, RunId>;

/** Источник расчёта — участок или загруженный набор. У расчёта движка
    источника нет, и участок у него — день движка (`run.day`: «восток»,
    «югоцентр»). Прежде все расчёты движка сходились под одним именем
    `engine`: при одной дате у трёх зон взятый в работу Восток молча снимал
    с работы Югоцентр — та самая беда, от которой ключ по участку и заведён. */
const sourceOf = (id: RunId): string => {
  const run = RUNS.find((one) => one.id === id);
  return run?.source ?? (run?.day ? `engine:${run.day}` : 'engine');
};

/** Ключ дня участка для расчёта. */
const dayKey = (id: RunId, date: string) => `${sourceOf(id)}|${date}`;

/** День участка словами: «Восток · 17.08.2026».

    Подпись живёт рядом с ключом нарочно. Ключ собран из участка и даты, и
    всякий вопрос перед взятием в работу обязан называть ровно это: «взять на
    сегодня» без участка — обещание, которого кнопка не держит, у соседнего
    участка свой рабочий расчёт на ту же дату. */
export const dayLabel = (id: RunId, date: string): string => {
  const run = RUNS.find((one) => one.id === id);
  const place = run?.source
    ? zoneTitle(run.source)
    : run?.day
      ? engineDayTitle(run.day)
      : 'участок';
  return `${place} · ${date.split('-').reverse().join('.')}`;
};

function read(): DutyMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    /* Пересобираем по одной паре, а не берём объект целиком: в хранилище
       лежит то, что туда положила прошлая версия, и одна кривая запись не
       должна утаскивать за собой весь список. Запись прошлой версии ключевалась
       одной датой — переводим её на день участка по расчёту, который она
       называет; расчёт стёрт — стирается и запись. */
    const clean: DutyMap = {};
    for (const [key, id] of Object.entries(saved)) {
      if (typeof key !== 'string' || typeof id !== 'string' || !key || !id) continue;
      /* Запись под общим `engine|дата` — от версии, где расчёты движка не
         различались по участку. Переводим на участок по самому расчёту, если
         он уже в истории. Обычно архив движка приезжает позже чтения
         хранилища — тогда запись лежит до `migrateEngineDuty`, которую зовут
         после подтягивания архива. */
      if (key.startsWith('engine|') && RUNS.some((run) => run.id === id)) {
        clean[dayKey(id, key.slice('engine|'.length))] = id;
        continue;
      }
      if (key.includes('|')) {
        clean[key] = id;
        continue;
      }
      if (RUNS.some((run) => run.id === id)) clean[dayKey(id, key)] = id;
    }
    return clean;
  } catch {
    return {};
  }
}

let current = read();

/** Переводит отметки старого вида `engine|дата` на день участка — после
    того как архив движка попал в историю. При чтении хранилища архива ещё
    нет, и без этого шага у всех расчётов движка молча пропадало «в работе»,
    а сами отметки навсегда оставались сиротами. Расчёта в истории нет —
    отметка стирается: взять её не на что. Свежая отметка дня участка важнее
    переведённой старой и не перезаписывается. */
export function migrateEngineDuty(): void {
  const stale = Object.keys(current).filter((key) => key.startsWith('engine|'));
  if (stale.length === 0) return;
  const next: DutyMap = { ...current };
  for (const key of stale) {
    const id = next[key];
    delete next[key];
    if (!id || !RUNS.some((run) => run.id === id)) continue;
    const fresh = dayKey(id, key.slice('engine|'.length));
    if (!(fresh in next)) next[fresh] = id;
  }
  save(next);
}
const watchers = new Set<() => void>();

function save(next: DutyMap): void {
  current = next;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* Приватный режим и переполненное хранилище — не повод ронять экран:
         выбор просто не переживёт перезагрузку. */
    }
  }
  for (const watcher of watchers) watcher();
}

/** День участка со всем, что о нём известно: какие расчёты на него посчитаны
    и какой из них ведёт работу. */
export interface WorkDay {
  /** Ключ дня участка — тот же, что в хранилище. */
  key: string;
  /** Участок словами: «Восток». */
  place: string;
  /** Дата дня, ISO. */
  date: string;
  /** «Восток · 17.08.2026» — то же, чем кнопка называет день. */
  label: string;
  /** Все расчёты этого дня участка, свежие сверху. */
  runs: RunId[];
  /** Расчёт, который ведёт день. `null` — рабочий не выбран. */
  holder: RunId | null;
}

/** Дни участков, на которые что-то посчитано.

    Собирается из истории, а не из хранилища: день существует потому, что на
    него есть расчёты, а не потому, что кто-то нажал «В работу». Иначе
    мониторингу нечего было бы предложить на пустом месте — он показывал бы
    пустой список вместо «вот дни, выберите рабочий расчёт». */
export function workDays(): WorkDay[] {
  const byKey = new Map<string, WorkDay>();
  for (const run of RUNS) {
    if (!run.date) continue;
    const key = dayKey(run.id, run.date);
    const day = byKey.get(key);
    if (day) {
      day.runs.unshift(run.id);
      continue;
    }
    byKey.set(key, {
      key,
      place: dayLabel(run.id, run.date).split(' · ')[0],
      date: run.date,
      label: dayLabel(run.id, run.date),
      runs: [run.id],
      holder: current[key] ?? null
    });
  }
  /* Сначала свежие дни, а внутри дня — свежие расчёты: и то и другое ищут
     глазами сверху. */
  return [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date) || a.place.localeCompare(b.place));
}

/** Весь список «день участка → расчёт». Для всего, что живёт вне дерева
    компонентов и хочет видеть список целиком. */
export const duty = (): DutyMap => current;

/** Какой расчёт работает на дне того же участка, что и этот. Пусто — ни
    один не взят. Это и есть «кто держит день»: подсказке у кнопки нужно
    различать «взять» и «отобрать день у соседа». */
export const holderOf = (id: RunId, date: string): RunId | null =>
  date && id ? (current[dayKey(id, date)] ?? null) : null;

/** Этот ли расчёт работает на своём дне. */
export const onDuty = (id: RunId, date: string): boolean =>
  Boolean(date) && Boolean(id) && current[dayKey(id, date)] === id;

/** Берёт расчёт в работу на его день. Прежний хозяин дня освобождается сам:
    день участка в списке один, и второй записи о нём быть не может. */
export function takeDuty(id: RunId, date: string): void {
  if (!date || !id) return;
  const key = dayKey(id, date);
  if (current[key] === id) return;
  save({ ...current, [key]: id });
}

/** Снимает расчёт с работы. День после этого остаётся без рабочего расчёта —
    это законное состояние: пересчитали, а какой брать, ещё не решили. Снять
    можно только того, кто держит день: чужой расчёт с работы не снимается. */
export function dropDuty(id: RunId, date: string): void {
  if (!date || !id) return;
  const key = dayKey(id, date);
  if (current[key] !== id) return;
  const next = { ...current };
  delete next[key];
  save(next);
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Подписка для компонентов: перерисовываются, когда день сменил хозяина.
    Возвращает список целиком; кто держит конкретный день, спрашивают у
    `onDuty` и `holderOf` — ключ списка снаружи собирать не надо. */
export function useDuty(): DutyMap {
  return useSyncExternalStore(subscribe, duty, () => ({}));
}
