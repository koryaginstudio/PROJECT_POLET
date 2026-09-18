import { useSyncExternalStore } from 'react';
import type { RunId } from './load.ts';

/* Расчёт, взятый в работу на свой день.

   Расчётов на один и тот же день бывает сколько угодно: день пересчитывают с
   другими переменными, пока результат не устроит. Все они остаются в истории —
   это и есть архив, — но работают в конце концов по одному. Кнопка «В работу»
   и говорит, по какому именно: этот расчёт с этой минуты принадлежит своему
   дню, а остальные прогоны того же дня становятся черновиками к нему.

   Отсюда и устройство хранилища: не флажок на записи расчёта, а список «день →
   расчёт». Флажок пришлось бы снимать у соседей вручную и следить, чтобы у
   дня не оказалось двух хозяев; здесь двух не бывает по самому виду записи —
   ключ один, значение одно.

   Живёт в браузере, рядом с настройками рабочего места. Движок об этом не
   знает и знать не должен: он считает планы, а какой из них взяли в работу —
   решение диспетчера, и делается оно уже после расчёта.

   Состояние держит модуль, а не React: спросить «этот расчёт в работе?» нужно
   и карточке в базе, и подшапке диспетчерской, и они друг другу не родня.
   Компоненты подписываются через `useDuty`, остальные зовут `duty()`. */

const STORE_KEY = 'polet.duty.v1';

/** День (ISO, `2026-08-17`) → расчёт, который на нём работает. */
export type DutyMap = Record<string, RunId>;

function read(): DutyMap {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    /* Пересобираем по одной паре, а не берём объект целиком: в хранилище
       лежит то, что туда положила прошлая версия, и одна кривая запись не
       должна утаскивать за собой весь список. */
    const clean: DutyMap = {};
    for (const [date, id] of Object.entries(saved)) {
      if (typeof date === 'string' && typeof id === 'string' && date && id) clean[date] = id;
    }
    return clean;
  } catch {
    return {};
  }
}

let current = read();
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

/** Весь список «день → расчёт». Для всего, что живёт вне дерева компонентов. */
export const duty = (): DutyMap => current;

/** Какой расчёт работает на этом дне. Пусто — ни один не взят. */
export const dutyOf = (date: string): RunId | null => (date ? (current[date] ?? null) : null);

/** Этот ли расчёт работает на своём дне. */
export const onDuty = (id: RunId, date: string): boolean => Boolean(date) && current[date] === id;

/** Берёт расчёт в работу на его день. Прежний хозяин дня освобождается сам:
    день в списке один, и второй записи о нём быть не может. */
export function takeDuty(id: RunId, date: string): void {
  if (!date || !id) return;
  if (current[date] === id) return;
  save({ ...current, [date]: id });
}

/** Снимает расчёт с работы. День после этого остаётся без рабочего расчёта —
    это законное состояние: пересчитали, а какой брать, ещё не решили. */
export function dropDuty(date: string): void {
  if (!date || !(date in current)) return;
  const next = { ...current };
  delete next[date];
  save(next);
}

/** Переключатель под кнопку: взять, если не взят, и снять, если взят. */
export function toggleDuty(id: RunId, date: string): void {
  if (onDuty(id, date)) dropDuty(date);
  else takeDuty(id, date);
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Подписка для компонентов: перерисовываются, когда день сменил хозяина. */
export function useDuty(): DutyMap {
  return useSyncExternalStore(subscribe, duty, () => ({}));
}
