import { useSyncExternalStore } from 'react';
import type { Minutes } from './contract.ts';

/* Настройки сервиса.

   Это не настройки движка. Движок отвечает на вопрос «как раскладывать», и
   его переменные живут в своём разделе — там каждая меняет результат расчёта.
   Здесь другое: границы рабочего дня и пороги, по которым интерфейс называет
   число проблемой. Расчёт от них не меняется ни на визит; меняется то, что мы
   считаем нормой.

   Раньше всё это было зашито числами в `derive.ts` и там же честно подписано
   как «грубые и общие для всех дней — это подсказка, а не оценка плана».
   Подсказка, которую нельзя подвинуть, на чужих данных превращается в помеху:
   у одной компании 75 % загрузки — перегруз, у другой — норма, а смена с
   ночными бригадами не укладывается в 07:00–21:00 вовсе.

   Хранится в браузере. Это настройка рабочего места, а не свойство данных:
   движок про неё не знает и знать не должен.

   Состояние держится модулем, а не React-контекстом: пороги нужны и
   `derive.ts`, который считает день вне всякого дерева компонентов. Компоненты
   подписываются через `useService`, остальные зовут `service()`. */

export type ThemeMode = 'light' | 'dark' | 'system';
export type StartAt = 'home' | 'dispatch' | 'last';
export type HoursFormat = 'decimal' | 'words';

/** Пороги, по которым интерфейс ставит точки и красит числа. Все — в тех же
    единицах, в каких их читает человек: проценты процентами, разы разами. */
export interface Thresholds {
  /** Покрытие ниже — плохо; ниже второго — присмотреться. Проценты. */
  coverageBad: number;
  coverageWatch: number;
  /** Загрузка инженера, от которой он считается перегруженным. Проценты. */
  occupancy: number;
  /** Доля смены, ушедшая в простой. Проценты. */
  idleBad: number;
  idleWatch: number;
  /** Разрыв между самым загруженным и самым свободным. Разы. */
  gapBad: number;
  gapWatch: number;
  /** Неравномерность нагрузки, коэффициент Джини, 0…1. */
  giniBad: number;
  giniWatch: number;
}

export interface ServiceSettings {
  /** Границы рабочего дня. На них стоят шкала времени, канбан и воронка. */
  dayStart: Minutes;
  dayEnd: Minutes;
  thresholds: Thresholds;
  theme: ThemeMode;
  /** С чего открывается программа. */
  startAt: StartAt;
  /** Меню свёрнуто до значков сразу при загрузке. */
  navCollapsed: boolean;
  /** Сколько карточек в строке по умолчанию там, где плотность выбирают. */
  perRow: '2' | '4' | '6';
  /** С чем открывается база данных: с раскрытой доской виджетов над списком
      или со свёрнутой. Свёрнутая — не то же самое, что убранная: доска на
      месте, её раскрывают строкой над базой. Заводское — свёрнутая: в базу
      приходят за записями, а сводку над ними смотрят тогда, когда спросили. */
  dbStats: 'open' | 'hidden';
  /** Часы дробью («4,9 ч») или словами («4 ч 54 мин»). */
  hours: HoursFormat;
}

export const SERVICE_DEFAULTS: ServiceSettings = {
  dayStart: 7 * 60,
  dayEnd: 21 * 60,
  thresholds: {
    coverageBad: 80,
    coverageWatch: 92,
    occupancy: 75,
    idleBad: 25,
    idleWatch: 12,
    gapBad: 3,
    gapWatch: 2,
    giniBad: 0.25,
    giniWatch: 0.12
  },
  theme: 'light',
  startAt: 'home',
  navCollapsed: false,
  dbStats: 'hidden',
  perRow: '4',
  hours: 'decimal'
};

const STORE = 'polet.service';

/** Смена короче двух часов и длиннее суток — это не настройка, а опечатка. */
const MIN_SHIFT = 120;
const DAY = 24 * 60;

/* Границы удерживаются внутри суток с обеих сторон. Начало не позже, чем за
   минимальную смену до полуночи: иначе конец, отодвинутый от начала на два
   часа, уходил за полночь, и день кончался в «25:00». */
function sane(next: ServiceSettings): ServiceSettings {
  const dayStart = Math.max(0, Math.min(DAY - MIN_SHIFT, Math.round(next.dayStart)));
  const dayEnd = Math.max(dayStart + MIN_SHIFT, Math.min(DAY, Math.round(next.dayEnd)));
  return { ...next, dayStart, dayEnd };
}

function read(): ServiceSettings {
  if (typeof localStorage === 'undefined') return SERVICE_DEFAULTS;
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return SERVICE_DEFAULTS;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return SERVICE_DEFAULTS;
    /* Разложено по полям, а не одним `...saved`: в хранилище лежит запись
       прошлой версии, и недостающее должно браться из заводского, а не
       превращаться в `undefined` посреди расчёта. */
    return sane({
      ...SERVICE_DEFAULTS,
      ...saved,
      thresholds: { ...SERVICE_DEFAULTS.thresholds, ...(saved.thresholds ?? {}) }
    });
  } catch {
    return SERVICE_DEFAULTS;
  }
}

let current = read();
const watchers = new Set<() => void>();

function announce(): void {
  for (const watcher of watchers) watcher();
}

/** Текущие настройки. Для всего, что живёт вне дерева компонентов. */
export const service = (): ServiceSettings => current;

/** Меняет часть настроек и запоминает. */
export function setService(patch: Partial<ServiceSettings>): void {
  const next = sane({
    ...current,
    ...patch,
    thresholds: { ...current.thresholds, ...(patch.thresholds ?? {}) }
  });
  current = next;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* Приватный режим и переполненное хранилище — не повод ронять экран:
         настройка просто не переживёт перезагрузку. */
    }
  }
  announce();
}

/** Возвращает всё заводское. */
export function resetService(): void {
  setService(SERVICE_DEFAULTS);
}

/** Уведено ли хоть что-то от заводского — и сколько именно. */
export function servicePatched(): number {
  let count = 0;
  const base = SERVICE_DEFAULTS;
  for (const key of Object.keys(base) as (keyof ServiceSettings)[]) {
    if (key === 'thresholds') continue;
    if (current[key] !== base[key]) count += 1;
  }
  for (const key of Object.keys(base.thresholds) as (keyof Thresholds)[]) {
    if (current.thresholds[key] !== base.thresholds[key]) count += 1;
  }
  return count;
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Подписка для компонентов: перерисовываются, когда настройку подвинули. */
export function useService(): ServiceSettings {
  return useSyncExternalStore(subscribe, service, () => SERVICE_DEFAULTS);
}

/* ─── производные величины ────────────────────────────────────────────── */

/* Граница суток открытого плана. Настройка `dayEnd` задаёт ось по вкусу
   диспетчера, но ось не вправе кончаться раньше, чем кончается день: у
   выгрузки заказчика граница 22:00, заводская ось — 21:00, и визиты после
   девяти вечера выпадали с таймлайна, а ползунок момента не доходил до
   последнего часа. Ставит её тот, кто открывает план. */
let горизонтПлана = 0;

export function setPlanHorizon(hardEnd: Minutes | undefined): void {
  горизонтПлана = hardEnd ?? 0;
}

const конецОси = (): Minutes => Math.max(current.dayEnd, горизонтПлана);

export const dayStart = (): Minutes => current.dayStart;
export const dayEnd = (): Minutes => конецОси();
export const daySpan = (): number => конецОси() - current.dayStart;

/** Прижимает момент к границам смены. */
export const clampDay = (minutes: Minutes): Minutes =>
  Math.min(конецОси(), Math.max(current.dayStart, minutes));

/** Часы гребёнки: целые часы внутри смены. */
export function dayHours(step = 60): Minutes[] {
  const list: Minutes[] = [];
  for (let m = Math.ceil(current.dayStart / 60) * 60; m <= конецОси(); m += step) list.push(m);
  return list;
}
