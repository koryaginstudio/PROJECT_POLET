/* Всё, что интерфейс считает из контракта. Ни одного зашитого справочника:
   типы работ, навыки и районы перечисляются из того, что пришло в файле. */

import type { Day, Engineer, Minutes, Order, Risk, Route, Stop } from './contract.ts';
import { skillName } from './dictionary.ts';
import { clampDay, dayEnd, service } from './service.ts';

export const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* ─── доли и распределения ───────────────────────────────────────────────
   Подписи в процентах округляются вместе, а не поодиночке: шесть независимых
   округлений дают в сумме 101%. Раздаём остаток по наибольшим хвостам. */

export function wholePercents(counts: number[]): number[] {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum <= 0) return counts.map(() => 0);
  const raw = counts.map((count) => (count / sum) * 100);
  const whole = raw.map(Math.floor);
  const order = raw
    .map((value, index) => ({ rest: value - Math.floor(value), index }))
    .sort((a, b) => b.rest - a.rest);
  let left = 100 - whole.reduce((a, b) => a + b, 0);
  for (const { index } of order) {
    if (left <= 0) break;
    whole[index] += 1;
    left -= 1;
  }
  return whole;
}

/** Один сектор кольца: непересекающаяся группа. */
export interface DistributionSlice {
  key: string;
  label: string;
  count: number;
  ids: string[];
  /** Из каких категорий сложилась группа. Длина > 1 — это совмещение. */
  categoryKeys: string[];
}

/** Категория целиком, вместе с теми, кто попал ещё куда-то. */
export interface DistributionCategory {
  key: string;
  label: string;
  count: number;
  ids: string[];
}

export interface Distribution {
  total: number;
  slices: DistributionSlice[];
  categories: DistributionCategory[];
  /** Сколько элементов попали больше чем в одну категорию. */
  overlapping: number;
  /** Сумма по категориям: больше total ровно на величину совмещений. */
  categorySum: number;
}

/* Круг обязан складываться в целое, поэтому его секторы — не категории, а их
   непересекающиеся сочетания: инженер с двумя навыками занимает один сектор
   «Подключение + Ремонт», а не половинки двух. Категории считаются рядом и
   честно дают сумму больше целого — ровно на величину совмещений. */
export function buildDistribution<T>(
  items: T[],
  idOf: (item: T) => string,
  keysOf: (item: T) => string[],
  labelOf: (key: string) => string
): Distribution {
  const combos = new Map<string, { keys: string[]; ids: string[] }>();
  const categories = new Map<string, string[]>();
  let overlapping = 0;
  let categorySum = 0;

  for (const item of items) {
    const id = idOf(item);
    const keys = [...new Set(keysOf(item))].sort();
    if (keys.length === 0) continue;
    if (keys.length > 1) overlapping += 1;
    categorySum += keys.length;

    const comboKey = keys.join('+');
    const combo = combos.get(comboKey) ?? { keys, ids: [] };
    combo.ids.push(id);
    combos.set(comboKey, combo);

    for (const key of keys) categories.set(key, [...(categories.get(key) ?? []), id]);
  }

  const slices = [...combos.entries()]
    .map(([key, combo]) => ({
      key,
      label: combo.keys.map(labelOf).join(' + '),
      count: combo.ids.length,
      ids: combo.ids,
      categoryKeys: combo.keys
    }))
    /* Сначала чистые категории, потом совмещения — так кольцо читается
       от простого к сложному, а не прыгает. */
    .sort((a, b) =>
      a.categoryKeys.length - b.categoryKeys.length || b.count - a.count || a.label.localeCompare(b.label)
    );

  return {
    total: items.length,
    slices,
    categories: [...categories.entries()]
      .map(([key, ids]) => ({ key, label: labelOf(key), count: ids.length, ids }))
      .sort((a, b) => b.count - a.count),
    overlapping,
    categorySum
  };
}

/* Крайние сроки в контракте уходят за полночь: 2220 минут — это 13:00
   следующего дня, а не «37:00». Часы без даты здесь врут, поэтому день
   выносится словом. */
export function deadline(m: number) {
  const days = Math.floor(m / (24 * 60));
  const rest = m % (24 * 60);
  if (days === 0) return hhmm(rest);
  if (days === 1) return `${hhmm(rest)} завтра`;
  return `${hhmm(rest)} через ${days} дн.`;
}

/** Русский десятичный разделитель — запятая. */
export const dec = (n: number, digits = 1) =>
  n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const pct = (n: number) => `${dec(n)}`;

/** Русская форма числительного: 1 визит, 2 визита, 5 визитов. */
export function plural(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return `${n} ${many}`;
  if (last > 1 && last < 5) return `${n} ${few}`;
  if (last === 1) return `${n} ${one}`;
  return `${n} ${many}`;
}

export const visits = (n: number) => plural(n, 'визит', 'визита', 'визитов');
export const stops = (n: number) => plural(n, 'остановка', 'остановки', 'остановок');
export const engineers = (n: number) => plural(n, 'инженер', 'инженера', 'инженеров');
export const orders = (n: number) => plural(n, 'заявка', 'заявки', 'заявок');

/* Границы рабочего дня живут в настройках сервиса, а не здесь константами:
   смена с ночными бригадами в 07:00–21:00 не укладывается вовсе. Отсюда они
   только переизлучаются — чтобы всё, что считает день, брало их из одного
   места и не расходилось между экранами. Функции, а не значения: настройку
   двигают на ходу, и вычисленное при загрузке модуля осталось бы прежним. */
export { dayStart, dayEnd, daySpan, clampDay, dayHours } from './service.ts';
export type { ServiceSettings, Thresholds } from './service.ts';

/** Часы одной строкой. Формат — настройка сервиса: «4,9 ч» короче в таблице,
    «4 ч 54 мин» точнее в карточке, и спорить об этом должен не код. */
export function hoursText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (service().hours === 'words') {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
  }
  return `${dec(total / 60)} ч`;
}

/* ─── где заявка ─────────────────────────────────────────────────────────
   С 1.1 у заявки есть почтовый адрес дома, и место называется им: район —
   это полгорода, а инженер едет в подъезд. Район остаётся второй строкой
   там, где для неё есть место. На синтетической сети адрес приходит пустым,
   и тогда местом снова становится район — интерфейс от этого не ломается. */

export const placeOf = (order: Order) => order.address ?? order.district;

/** Адрес выезда инженера. Пусто на синтетической сети — тогда говорим о том,
    что достоверно известно, а не выдумываем адрес. */
export const homeOf = (engineer: Engineer) => engineer.home_address ?? 'Адрес не указан';

/* ─── линия маршрута ─────────────────────────────────────────────────────
   Маршрут на карте — не прямые между точками, а ломаная по улицам: каждый
   перегон приходит от маршрутизатора внутри своей остановки. Склеиваем их в
   одну линию, выбрасывая стык — конец предыдущего перегона и начало
   следующего это один и тот же дом.

   Перегон, у которого геометрии нет, заменяем прямой до точки заявки: соврать
   про дорогу нельзя, а порядок объезда известен и без неё. */
export function roadPath(
  route: Route,
  home: [number, number],
  pointOf: (orderId: string) => [number, number] | undefined
): [number, number][] {
  const path: [number, number][] = [home];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

  for (const stop of route.stops) {
    const leg = stop.geometry;
    if (leg && leg.length >= 2) {
      for (const point of leg) {
        const last = path[path.length - 1];
        if (!last || !same(last, point)) path.push(point);
      }
      continue;
    }
    const point = pointOf(stop.order_id);
    if (point) {
      const last = path[path.length - 1];
      if (!last || !same(last, point)) path.push(point);
    }
  }

  return path;
}

export interface EngineerLoad {
  engineer: Engineer;
  route?: Route;
  visits: number;
  occupancy: number;
  idle: boolean;
}

export interface Metric {
  key: string;
  label: string;
  value: string;
  unit?: string;
  caption: string;
  /** Точка у подписи: на это число стоит посмотреть, и насколько срочно. */
  flag: 'ok' | 'watch' | 'bad';
  /** Чем оно плохо — расшифровка точки. */
  hint?: string;
  /** Куда ведёт число: раздел правой панели, где оно разложено по строкам. */
  group: string;
}

export type StageKey = 'planned' | 'enroute' | 'working' | 'done' | 'overdue' | 'unassigned';

export interface Stage {
  key: StageKey;
  label: string;
  /** Чем этап на самом деле является, если название оставляет вопрос. */
  hint?: string;
  /** Сколько заявок на этапе на момент среза. */
  count: number;
  /** Сколько пришло на этап за последний час до среза. Null там, где перехода нет. */
  delta: number | null;
  /** Сколько из них стоят впритык. */
  atRisk: number;
  /** Сколько инженеров задействовано на этапе. */
  crew: number;
  tone: 'planned' | 'accent' | 'success' | 'danger' | 'idle';
  orderIds: string[];
}

/** Куда и когда инженер выехал к этой заявке. `departure` — момент выезда:
    для первой точки это начало смены, дальше — конец предыдущего визита. */
export interface Placement {
  stop: Stop;
  engineerId: string;
  departure: Minutes;
  slaBreached: boolean;
}

export interface Funnel {
  cut: Minutes;
  stages: Stage[];
  lost: { count: number; deferrable: number; orderIds: string[] };
  attention: { count: number; urgent: number; fragile: number; orderIds: string[] };
  total: number;
}

export interface DayView {
  metrics: Metric[];
  loads: EngineerLoad[];
  unassigned: Order[];
  orderById: Map<string, Order>;
  engineerById: Map<string, Engineer>;
  routeByEngineer: Map<string, Route>;
  stopByOrder: Map<string, Placement>;
  riskCounts: Record<Risk, number>;
  tightCount: number;
  workTypes: { key: string; title: string; count: number }[];
  deferrable: Order[];
  fragile: { order: Order; failureRate: number }[];
  reasons: { key: string; label: string; value: number }[];
  /** Сколько раз симуляция прогнала этот день. */
  runs: number;
  funnel: Funnel;
}

/** Срез внутри рабочего дня. Данные — план на дату, поэтому «сейчас» берём
    по часам и прижимаем к границам смены. */
export function cutMinutes(now = new Date()): Minutes {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return clampDay(minutes);
}

/** Подписи, тон и пояснение этапов. Экспортированы, потому что канбану они
    нужны и для пустой колонки: колонка без заявок должна называться так же,
    как с ними.

    «Прогноз срыва», а не «не выполнено»: смена ещё не прожита. Движок
    раскладывает план и прогоняет его сотнями итераций, и это число — оценка:
    доля заявок, по которым план выходит за крайний срок и которые с той или
    иной вероятностью сорвутся. Подпись «не выполнено» читалась как факт и
    обещала то, чего в расчёте нет, — диспетчер видел срыв там, где речь о его
    вероятности. «Без инженера» рядом остаётся фактом плана и оговорки не
    требует: этим заявкам движок исполнителя действительно не нашёл.

    Двух слов хватает и по делу, и по месту: этап — это ячейка в ряду из семи,
    и подпись, которая в ней одна переносится на вторую строку, разваливает
    ряд. «Потенциально не выполнено» было точнее по букве и хуже по всему
    остальному.

    Строка `hint` есть только там, где название само оставляет вопрос;
    остальным этапам объяснять нечего. */
export const STAGE_META: Record<StageKey, { label: string; tone: Stage['tone']; hint?: string }> = {
  planned: { label: 'Запланированы', tone: 'planned' },
  enroute: { label: 'Инженер в пути', tone: 'accent' },
  working: { label: 'В работе', tone: 'accent' },
  done: { label: 'Выполнено', tone: 'success' },
  overdue: {
    label: 'Прогноз срыва',
    tone: 'danger',
    hint: 'Оценка движка, а не факт: по этим заявкам план выходит за крайний срок, и они сорвутся с той или иной вероятностью. Сколько на самом деле, покажет смена'
  },
  unassigned: { label: 'Без инженера', tone: 'idle' }
};

/** Этапы заявки, у которой есть маршрут. «Без инженера» живёт отдельно:
    оно не выводится из маршрута и добавляется только в воронку смены. */
const ROUTED_STAGES: StageKey[] = ['planned', 'enroute', 'working', 'done', 'overdue'];

const REASON_LABELS: Record<string, string> = {
  no_show: 'Абонента не было дома',
  missed_window: 'Приехали после закрытия окна',
  no_access: 'Не попали в подъезд',
  dropped: 'Смена кончилась раньше визита'
};

/** Раскладывает назначенные заявки по взаимоисключающим этапам на момент среза.
    Этап — это состояние на срез, а не свойство плана: заявка, которую план
    закрывает после крайнего срока, до самого визита честно стоит в
    «запланированы», и только потом попадает в «прогноз срыва». Иначе в семь
    утра, когда ещё никто не выехал, часть смены уже числилась бы сорванной. */
export function stageOf(
  placement: Placement,
  cut: Minutes,
  slaDeadline: Minutes | null = null
): { key: StageKey; enteredAt: Minutes | null } {
  const { stop, departure } = placement;
  if (cut >= stop.finish) {
    return { key: placement.slaBreached ? 'overdue' : 'done', enteredAt: stop.finish };
  }
  /* Срок вышел, а визит ещё не закрыт — это уже срыв, ждать конца работы незачем. */
  if (slaDeadline !== null && cut >= slaDeadline) return { key: 'overdue', enteredAt: slaDeadline };
  if (cut < departure) return { key: 'planned', enteredAt: null };
  if (cut < stop.start) return { key: 'enroute', enteredAt: departure };
  return { key: 'working', enteredAt: stop.start };
}

interface Bucket {
  ids: string[];
  delta: number;
  atRisk: number;
  crew: Set<string>;
}

const emptyBuckets = (): Record<StageKey, Bucket> => ({
  planned: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  enroute: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  working: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  done: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  overdue: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  unassigned: { ids: [], delta: 0, atRisk: 0, crew: new Set() }
});

function stagesFrom(
  placements: Iterable<[string, Placement]>,
  cut: Minutes,
  slaOf: (placement: Placement) => Minutes | null
): Stage[] {
  const buckets = emptyBuckets();
  for (const [orderId, placement] of placements) {
    const { key, enteredAt } = stageOf(placement, cut, slaOf(placement));
    const bucket = buckets[key];
    bucket.ids.push(orderId);
    bucket.crew.add(placement.engineerId);
    if (placement.stop.risk !== 'low') bucket.atRisk += 1;
    if (enteredAt !== null && cut >= enteredAt && cut - enteredAt <= 60) bucket.delta += 1;
  }
  return ROUTED_STAGES.map((key) => ({
    key,
    label: STAGE_META[key].label,
    hint: STAGE_META[key].hint,
    tone: STAGE_META[key].tone,
    count: buckets[key].ids.length,
    delta: key === 'planned' ? null : buckets[key].delta,
    atRisk: buckets[key].atRisk,
    crew: buckets[key].crew.size,
    orderIds: buckets[key].ids
  }));
}

/** Воронка смены на произвольный срез: где заявки находятся в этот момент.
    Этапы разбивают смену без остатка: сумма шести чисел равна общему числу заявок,
    потому что заявки без маршрута вынесены отдельным этапом, а не выброшены. */
export function buildFunnel(
  ordersTotal: number,
  stopByOrder: Map<string, Placement>,
  unassigned: Order[],
  deferrable: Order[],
  fragileIds: string[],
  cut: Minutes,
  slaOf: (placement: Placement) => Minutes | null = () => null
): Funnel {
  const urgent = unassigned.filter((o) => o.sla_deadline <= dayEnd());
  const attentionIds = [...new Set([...urgent.map((o) => o.id), ...fragileIds])];

  /* Заявка без инженера «горит», если её окно уже открыто: раздать её
     без потерь уже нельзя. */
  const burning = unassigned.filter((o) => o.window_start <= cut);
  const unassignedStage: Stage = {
    key: 'unassigned',
    label: STAGE_META.unassigned.label,
    tone: STAGE_META.unassigned.tone,
    count: unassigned.length,
    delta: null,
    atRisk: burning.length,
    crew: 0,
    orderIds: unassigned.map((o) => o.id)
  };

  return {
    cut,
    total: ordersTotal,
    stages: [...stagesFrom(stopByOrder, cut, slaOf), unassignedStage],
    lost: {
      count: unassigned.length,
      deferrable: deferrable.length,
      orderIds: unassigned.map((o) => o.id)
    },
    attention: {
      count: attentionIds.length,
      urgent: urgent.length,
      fragile: fragileIds.length,
      orderIds: attentionIds
    }
  };
}

/** Те же этапы, но по одному инженеру. */
export function engineerStages(
  stopByOrder: Map<string, Placement>,
  engineerId: string,
  cut: Minutes,
  slaOf: (placement: Placement) => Minutes | null = () => null
): { total: number; stages: Stage[] } {
  const mine = [...stopByOrder.entries()].filter(([, p]) => p.engineerId === engineerId);
  return { total: mine.length, stages: stagesFrom(mine, cut, slaOf) };
}

/** Этап конкретной заявки на срез — для списков и таблиц. */
export function stageOfOrder(
  view: DayView,
  orderId: string,
  cut: Minutes
): { key: StageKey; label: string; tone: Stage['tone'] } {
  const placement = view.stopByOrder.get(orderId);
  if (!placement) return { key: 'unassigned', ...STAGE_META.unassigned };
  const { key } = stageOf(placement, cut, view.orderById.get(orderId)?.sla_deadline ?? null);
  return { key, ...STAGE_META[key] };
}

export type SegmentKind = 'travel' | 'wait' | 'work' | 'idle' | 'lunch';

export interface Segment {
  kind: SegmentKind;
  from: Minutes;
  to: Minutes;
  orderId?: string;
  /** Обед выведен из простоя: поля перерыва в контракте пока нет. */
  inferred?: boolean;
}

const LUNCH_WINDOW: [Minutes, Minutes] = [11 * 60, 16 * 60];
const LUNCH_MIN = 45;
const LUNCH_MAX = 120;

/** Лента дня инженера: дорога, ожидание окна, работа, простой.
    Перерыва в контракте нет, поэтому самое длинное дневное ожидание
    помечается как окно под обед — и подписывается как вывод, а не факт. */
export function engineerTimeline(
  route: Route | undefined,
  engineer: Engineer,
  stopByOrder: Map<string, Placement>
): Segment[] {
  if (!route || route.stops.length === 0) return [];
  const segments: Segment[] = [];
  let cursor = engineer.shift_start;

  for (const stop of route.stops) {
    const placement = stopByOrder.get(stop.order_id);
    const departure = placement ? placement.departure : cursor;
    if (departure > cursor) segments.push({ kind: 'idle', from: cursor, to: departure });
    if (stop.arrive > departure) segments.push({ kind: 'travel', from: departure, to: stop.arrive });
    if (stop.start > stop.arrive) segments.push({ kind: 'wait', from: stop.arrive, to: stop.start });
    segments.push({ kind: 'work', from: stop.start, to: stop.finish, orderId: stop.order_id });
    cursor = stop.finish;
  }
  if (engineer.shift_end > cursor) segments.push({ kind: 'idle', from: cursor, to: engineer.shift_end });

  /* Хвост смены после последнего визита — это незанятый вечер, а не перерыв,
     и пятичасовое окно тоже обедом не назовёшь. Ищем паузу разумной длины
     внутри дня. */
  const lastWorkIndex = segments.map((segment) => segment.kind).lastIndexOf('work');
  let lunchIndex = -1;
  let lunchLength = 0;
  segments.forEach((segment, index) => {
    if (segment.kind !== 'wait' && segment.kind !== 'idle') return;
    if (index > lastWorkIndex) return;
    const length = segment.to - segment.from;
    if (length < LUNCH_MIN || length > LUNCH_MAX) return;
    if (segment.to <= LUNCH_WINDOW[0] || segment.from >= LUNCH_WINDOW[1]) return;
    if (length > lunchLength) {
      lunchIndex = index;
      lunchLength = length;
    }
  });
  if (lunchIndex >= 0) {
    segments[lunchIndex].kind = 'lunch';
    segments[lunchIndex].inferred = true;
  }

  return segments;
}

export type LiveStatus = 'no-route' | 'before' | 'enroute' | 'working' | 'overdue' | 'done';

const LIVE_STATUS_META: Record<LiveStatus, { label: string; tone: Stage['tone'] }> = {
  'no-route': { label: 'Без маршрута', tone: 'idle' },
  before: { label: 'Смена не началась', tone: 'planned' },
  enroute: { label: 'В пути', tone: 'accent' },
  working: { label: 'На объекте', tone: 'accent' },
  overdue: { label: 'Опаздывает', tone: 'danger' },
  done: { label: 'Свободен', tone: 'success' }
};

export interface LiveEngineer {
  engineer: Engineer;
  route?: Route;
  status: LiveStatus;
  label: string;
  tone: Stage['tone'];
  /** Заявка, к которой относится статус: инженер едет туда, работает на ней
      или только что закрыл. Null — на маршруте сейчас нет активной точки. */
  orderId: string | null;
  /** На сколько минут задержан относительно крайнего срока. 0, если в графике. */
  lateMinutes: number;
  visitsDone: number;
  visitsTotal: number;
}

/** Живой статус каждого инженера на срез `cut`. В отличие от `stageOf`, который
    смотрит на одну заявку, здесь для инженера ищется его текущая точка —
    первая в маршруте, ещё не закрытая к этому моменту, — и по ней читается,
    где он сейчас: едет, работает или опаздывает. */
export function buildLiveRoster(view: DayView, cut: Minutes): LiveEngineer[] {
  return view.loads.map(({ engineer, route }): LiveEngineer => {
    const base = { engineer, route, orderId: null, lateMinutes: 0 };

    if (!route || route.stops.length === 0) {
      return { ...base, status: 'no-route', ...LIVE_STATUS_META['no-route'], visitsDone: 0, visitsTotal: 0 };
    }

    const visitsTotal = route.stops.length;
    if (cut < engineer.shift_start) {
      return { ...base, status: 'before', ...LIVE_STATUS_META.before, visitsDone: 0, visitsTotal };
    }

    const visitsDone = route.stops.filter((stop) => cut >= stop.finish).length;
    /* Первая точка маршрута, которую срез ещё не закрыл: до неё все уже
       позади, а departure у неё — либо конец предыдущей, либо начало смены,
       и в обоих случаях он уже наступил, раз мы досюда дошли. */
    const current = route.stops.find((stop) => cut < stop.finish);
    if (!current) {
      return {
        ...base,
        status: 'done',
        ...LIVE_STATUS_META.done,
        orderId: route.stops[visitsTotal - 1]?.order_id ?? null,
        visitsDone,
        visitsTotal
      };
    }

    const placement = view.stopByOrder.get(current.order_id);
    if (!placement) {
      return { ...base, status: 'no-route', ...LIVE_STATUS_META['no-route'], visitsDone, visitsTotal };
    }
    const slaDeadline = view.orderById.get(current.order_id)?.sla_deadline ?? null;
    const { key } = stageOf(placement, cut, slaDeadline);
    const status: LiveStatus = key === 'overdue' ? 'overdue' : key === 'working' ? 'working' : 'enroute';
    const lateMinutes = key === 'overdue' ? Math.max(0, cut - (slaDeadline ?? current.finish)) : 0;

    return {
      ...base,
      status,
      ...LIVE_STATUS_META[status],
      orderId: current.order_id,
      lateMinutes,
      visitsDone,
      visitsTotal
    };
  });
}

/** Порядок для списка мониторинга: сперва то, что требует внимания. */
export const LIVE_STATUS_ORDER: LiveStatus[] = ['overdue', 'working', 'enroute', 'before', 'done', 'no-route'];

export function buildDayView(day: Day): DayView {
  const { plan, simulation } = day;

  const orderById = new Map(plan.orders.map((o) => [o.id, o]));
  const engineerById = new Map(plan.engineers.map((e) => [e.id, e]));
  const routeByEngineer = new Map(plan.routes.map((r) => [r.engineer_id, r]));

  const stopByOrder = new Map<string, Placement>();
  for (const route of plan.routes) {
    const engineer = engineerById.get(route.engineer_id);
    let previousFinish = engineer ? engineer.shift_start : route.totals.start;
    for (const stop of route.stops) {
      const order = orderById.get(stop.order_id);
      stopByOrder.set(stop.order_id, {
        stop,
        engineerId: route.engineer_id,
        departure: Math.min(previousFinish, stop.arrive),
        slaBreached: order ? stop.finish > order.sla_deadline : false
      });
      previousFinish = stop.finish;
    }
  }

  const riskCounts: Record<Risk, number> = { low: 0, medium: 0, high: 0 };
  for (const { stop } of stopByOrder.values()) riskCounts[stop.risk] += 1;
  const tightCount = riskCounts.medium + riskCounts.high;

  const loads: EngineerLoad[] = plan.engineers
    .map((engineer) => {
      const route = routeByEngineer.get(engineer.id);
      return {
        engineer,
        route,
        visits: route?.totals.visits ?? 0,
        occupancy: route?.totals.occupancy ?? 0,
        idle: !route || route.totals.visits === 0
      };
    })
    .sort((a, b) => b.occupancy - a.occupancy);


  const unassigned = plan.unassigned
    .map((id) => orderById.get(id))
    .filter((o): o is Order => Boolean(o));

  /* Заявка переносима на завтра, если её крайний срок выходит за пределы дня. */
  const deferrable = unassigned.filter((o) => o.sla_deadline > dayEnd());

  const byType = new Map<string, { title: string; count: number }>();
  for (const order of plan.orders) {
    const entry = byType.get(order.work_type) ?? { title: order.work_title, count: 0 };
    entry.count += 1;
    byType.set(order.work_type, entry);
  }
  const workTypes = [...byType.entries()]
    .map(([key, v]) => ({ key, title: v.title, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const fragile = simulation.fragile
    .map((f) => ({ order: orderById.get(f.order_id), failureRate: f.failure_rate }))
    .filter((f): f is { order: Order; failureRate: number } => Boolean(f.order));

  const reasons = Object.entries(simulation.reasons)
    .map(([key, value]) => ({ key, label: REASON_LABELS[key] ?? key, value }))
    .sort((a, b) => b.value - a.value);

  const slaOf = (placement: Placement) => orderById.get(placement.stop.order_id)?.sla_deadline ?? null;
  const funnel = buildFunnel(
    plan.meta.orders_total,
    stopByOrder,
    unassigned,
    deferrable,
    fragile.map((f) => f.order.id),
    cutMinutes(),
    slaOf
  );

  const spread = plan.meta.balance;

  /* Точка у подписи вместо цветного числа: цифры на пульте одинаково
     чёрные, а отметка говорит, с какой из них начинать разбор. Пороги
     грубые и общие для всех дней — это подсказка, а не оценка плана. */
  const shiftMinutes = plan.engineers.reduce(
    (sum, engineer) => sum + Math.max(0, engineer.shift_end - engineer.shift_start),
    0
  );
  const idleShare = shiftMinutes > 0 ? simulation.idle_minutes / shiftMinutes : 0;
  const lostShare = plan.meta.orders_total > 0 ? unassigned.length / plan.meta.orders_total : 0;
  const gap = spread.occupancy_max / Math.max(spread.occupancy_min, 0.01);

  const mark = (bad: boolean, watch: boolean, hint: string): Pick<Metric, 'flag' | 'hint'> =>
    bad ? { flag: 'bad', hint } : watch ? { flag: 'watch', hint } : { flag: 'ok' };

  /* Пороги приходят из настроек сервиса. Прежде они стояли здесь числами и
     были подписаны как «грубые и общие для всех дней»; общими они и остались,
     но теперь их можно подвинуть под свою норму, не трогая код. */
  const limit = service().thresholds;

  const metrics: Metric[] = [
    {
      key: 'coverage',
      label: 'Покрытие',
      value: pct(simulation.coverage),
      unit: '%',
      caption: `${simulation.done.p50} из ${simulation.orders_total} заявок`,
      group: 'metric:coverage',
      ...mark(
        simulation.coverage < limit.coverageBad,
        simulation.coverage < limit.coverageWatch,
        'Итерации в среднем не закрывают смену целиком'
      )
    },
    {
      /* Нераспределённые стоят рядом с покрытием не случайно: это первая
         причина, по которой оно не сходится к сотне. */
      key: 'unassigned',
      label: 'Без инженера',
      value: String(unassigned.length),
      unit: 'з.',
      caption: 'Не найден инженер',
      group: 'unassigned',
      ...mark(lostShare > 0.1, unassigned.length > 0, 'Для этих заявок не найден инженер')
    },
    {
      key: 'idle',
      label: 'Общий простой',
      value: dec(simulation.idle_minutes / 60),
      unit: 'ч',
      caption: 'Ожидание свободных окон',
      group: 'metric:idle',
      ...mark(
        idleShare > limit.idleBad / 100,
        idleShare > limit.idleWatch / 100,
        'Ожидание свободных окон занимает заметную долю смены'
      )
    },
    {
      key: 'balance',
      label: 'Разрыв загрузки',
      value: dec(gap),
      unit: '\u00d7',
      caption: `Загрузка от ${Math.round(spread.occupancy_min * 100)}% до ${Math.round(spread.occupancy_max * 100)}%`,
      group: 'metric:spread',
      ...mark(
        gap >= limit.gapBad,
        gap >= limit.gapWatch,
        'Разница между самым загруженным и самым свободным инженером велика'
      )
    },
    {
      /* Разрыв показывает только края, а неравномерность — всех инженеров:
         один перегруженный и один свободный при ровной середине дают тот же
         разрыв, что и смена, разъехавшаяся целиком. */
      key: 'gini',
      label: 'Неравномерность',
      value: dec(spread.gini, 2),
      caption: 'Ближе к нулю — нагрузка ровнее',
      group: 'metric:gini',
      ...mark(
        spread.gini > limit.giniBad,
        spread.gini > limit.giniWatch,
        'Нагрузка распределена между инженерами неравномерно'
      )
    }
  ];

  return {
    metrics,
    loads,
    unassigned,
    orderById,
    engineerById,
    routeByEngineer,
    stopByOrder,
    riskCounts,
    tightCount,
    workTypes,
    deferrable,
    fragile,
    reasons,
    runs: simulation.meta.runs,
    funnel
  };
}

/* ─── статус смены, не зависящий от среза ────────────────────────────────
   Кольца отвечают на вопрос «как собран день», а не «что происходит сейчас»:
   их три доли берутся из плана и симуляции и не меняются, когда диспетчер
   двигает время. Всё, что живёт по часам, показывают этапы и шкала выше. */

export interface StatusSplit {
  key: string;
  label: string;
  count: number;
  ids: string[];
  tone: 'ok' | 'wait' | 'bad';
}

/** Заявка проблемная, если инженер есть, но план по ней шаткий:
    нарушен крайний срок, нет запаса времени или её роняют прогоны. */
export function ordersStatus(view: DayView): StatusSplit[] {
  const fragile = new Set(view.fragile.map((f) => f.order.id));
  const assigned = [...view.stopByOrder.entries()];
  const problem = assigned.filter(
    ([id, placement]) => placement.slaBreached || placement.stop.risk !== 'low' || fragile.has(id)
  );
  const problemIds = new Set(problem.map(([id]) => id));
  const clean = assigned.filter(([id]) => !problemIds.has(id));

  return [
    { key: 'assigned', label: 'Назначен', count: clean.length, ids: clean.map(([id]) => id), tone: 'ok' },
    {
      key: 'unassigned',
      label: 'Без инженера',
      count: view.unassigned.length,
      ids: view.unassigned.map((o) => o.id),
      tone: 'wait'
    },
    { key: 'problem', label: 'Проблема', count: problem.length, ids: [...problemIds], tone: 'bad' }
  ];
}

/** У инженера проблема, если маршрут есть, но он перегружен или рвёт срок. */
export function crewStatus(view: DayView): StatusSplit[] {
  const breached = new Set(
    [...view.stopByOrder.values()].filter((p) => p.slaBreached).map((p) => p.engineerId)
  );
  const withRoute = view.loads.filter((l) => !l.idle);
  const heavy = service().thresholds.occupancy / 100;
  const problem = withRoute.filter((l) => l.occupancy >= heavy || breached.has(l.engineer.id));
  const problemIds = new Set(problem.map((l) => l.engineer.id));
  const clean = withRoute.filter((l) => !problemIds.has(l.engineer.id));
  const idle = view.loads.filter((l) => l.idle);

  return [
    {
      key: 'routed',
      label: 'В работе',
      count: clean.length,
      ids: clean.map((l) => l.engineer.id),
      tone: 'ok'
    },
    {
      key: 'idle',
      label: 'Свободны',
      count: idle.length,
      ids: idle.map((l) => l.engineer.id),
      tone: 'wait'
    },
    {
      key: 'problem',
      label: 'Проблема',
      count: problem.length,
      ids: [...problemIds],
      tone: 'bad'
    }
  ];
}

/* ─── доски «Заявки» и «Инженеры» ──────────────────────────────────────
   Обе зависят от среза: «горит» и «свободен сейчас» имеют смысл только
   относительно момента, на который смотрит диспетчер. */

export interface ProblemBucket {
  key: string;
  label: string;
  count: number;
  orderIds: string[];
}

export interface BoardValue {
  key: string;
  label: string;
  icon: string;
  value: number;
  note: string;
  tone: 'neutral' | 'success' | 'danger' | 'accent';
  /** Раскрывается списком в правой панели. */
  groupKey?: string;
  orderIds: string[];
}

export interface OrdersBoard {
  values: BoardValue[];
  byType: { key: string; title: string; count: number; orderIds: string[] }[];
  problemBuckets: ProblemBucket[];
  /** С инженером: заявка стоит в чьём-то маршруте. */
  assignedIds: string[];
  /** Без инженера, окно ещё впереди. */
  freshIds: string[];
  /** Без инженера, окно уже открыто. */
  burningIds: string[];
  /** Уникальные id всего проблемного — то же число, что в квадрате «Проблемные». */
  problemIds: string[];
}

/** Заявка «новая», если исполнителя нет, а окно ещё даже не начиналось:
    её никто не тронул, и время пока есть. */
export function buildOrdersBoard(view: DayView, cut: Minutes): OrdersBoard {
  const assigned = [...view.stopByOrder.keys()];
  const fresh = view.unassigned.filter((o) => o.window_start > cut);
  const burning = view.unassigned.filter((o) => o.window_start <= cut);
  const sla = [...view.stopByOrder.entries()].filter(([, p]) => p.slaBreached);
  const tight = [...view.stopByOrder.entries()].filter(([, p]) => p.stop.risk !== 'low');
  const fragile = view.fragile;

  /* Заявки без инженера считаются в своём квадрате и в своей доле кольца,
     поэтому сюда они не попадают: иначе одно и то же число уезжало бы в два
     места и «проблемных» к вечеру становилось больше, чем заявок с риском. */
  const problemBuckets: ProblemBucket[] = [
    { key: 'sla', label: 'План нарушает крайний срок', count: sla.length, orderIds: sla.map(([id]) => id) },
    { key: 'tight', label: 'Стоят впритык', count: tight.length, orderIds: tight.map(([id]) => id) },
    {
      key: 'fragile',
      label: 'Держатся на честном слове',
      count: fragile.length,
      orderIds: fragile.map((f) => f.order.id)
    }
  ].filter((bucket) => bucket.count > 0);

  const problemIds = [...new Set(problemBuckets.flatMap((b) => b.orderIds))];

  const byType = view.workTypes.map((type) => ({
    key: type.key,
    title: type.title,
    count: type.count,
    orderIds: [...view.orderById.values()].filter((o) => o.work_type === type.key).map((o) => o.id)
  }));

  /* Первые три квадрата — разбиение без остатка: всего = с инженером + без инженера.
     Четвёртый считает другое: он режет те же заявки поперёк, поэтому и подписан
     как срез, а не как ещё одна доля. */
  return {
    values: [
      {
        key: 'total',
        label: 'Всего заявок',
        icon: 'clipboard-list',
        value: view.orderById.size,
        note: `${assigned.length} с инженером + ${view.unassigned.length} без`,
        tone: 'neutral',
        groupKey: 'all',
        orderIds: [...view.orderById.keys()]
      },
      {
        key: 'inwork',
        label: 'С инженером',
        icon: 'check-circle',
        value: assigned.length,
        note: 'Стоят в маршрутах',
        tone: 'success',
        groupKey: 'inwork',
        orderIds: assigned
      },
      {
        key: 'unassigned',
        label: 'Без инженера',
        icon: 'user',
        value: view.unassigned.length,
        note: burning.length > 0 ? `${burning.length} с открытым окном` : 'Окна ещё не открылись',
        tone: burning.length > 0 ? 'danger' : 'accent',
        groupKey: 'unassigned',
        orderIds: view.unassigned.map((o) => o.id)
      },
      {
        key: 'problems',
        label: 'Проблемные',
        icon: 'warning',
        value: problemIds.length,
        note: 'Инженер есть, но план шаткий',
        tone: 'danger',
        groupKey: 'problems',
        orderIds: problemIds
      }
    ],
    byType,
    problemBuckets,
    assignedIds: assigned,
    freshIds: fresh.map((o) => o.id),
    burningIds: burning.map((o) => o.id),
    problemIds
  };
}

export interface CrewBoard {
  values: BoardValue[];
  bySkill: { key: string; label: string; count: number; engineerIds: string[] }[];
  problemBuckets: { key: string; label: string; count: number; engineerIds: string[] }[];
  /** Движок не поставил в маршрут ни одной заявки. */
  freeIds: string[];
}

/* Доска инженеров, как и доска заявок, описывает собранный день, а не текущую
   минуту: срез сюда не приходит вовсе. «Свободен» здесь значит «движок не дал
   ни одной заявки», а не «сейчас не на визите». */
export function buildCrewBoard(view: DayView): CrewBoard {
  const onShift = view.loads.filter((l) => !l.idle);
  const free = view.loads.filter((l) => l.idle);
  const heavy = service().thresholds.occupancy / 100;
  const overloaded = onShift.filter((l) => l.occupancy >= heavy);
  const withBreach = onShift.filter((load) =>
    [...view.stopByOrder.values()].some((p) => p.engineerId === load.engineer.id && p.slaBreached)
  );

  /* Незадействованные инженеры стоят отдельным квадратом и отдельной долей
     кольца, поэтому в «проблемных» их нет — иначе одно число уехало бы в два
     места. Остаются перегруз и сорванный срок. */
  const problemBuckets = [
    {
      key: 'overloaded',
      label: `Загрузка выше ${Math.round(heavy * 100)}%`,
      count: overloaded.length,
      engineerIds: overloaded.map((l) => l.engineer.id)
    },
    {
      key: 'breach',
      label: 'В маршруте есть нарушение срока',
      count: withBreach.length,
      engineerIds: withBreach.map((l) => l.engineer.id)
    }
  ].filter((bucket) => bucket.count > 0);

  const problemIds = [...new Set(problemBuckets.flatMap((b) => b.engineerIds))];

  const skills = new Map<string, string[]>();
  for (const load of view.loads) {
    for (const skill of load.engineer.skills) {
      skills.set(skill, [...(skills.get(skill) ?? []), load.engineer.id]);
    }
  }

  return {
    values: [
      {
        key: 'total',
        label: 'Всего инженеров',
        icon: 'users',
        value: view.loads.length,
        note: 'В смене',
        tone: 'neutral',
        groupKey: 'crew-all',
        orderIds: view.loads.map((l) => l.engineer.id)
      },
      {
        key: 'onshift',
        label: 'С маршрутом',
        icon: 'check-circle',
        value: onShift.length,
        note: 'Движок дал заявки',
        tone: 'success',
        groupKey: 'crew-onshift',
        orderIds: onShift.map((l) => l.engineer.id)
      },
      {
        key: 'problems',
        label: 'Проблемные',
        icon: 'warning',
        value: problemIds.length,
        note: 'Перегруз или срыв срока',
        tone: 'danger',
        groupKey: 'crew-problems',
        orderIds: problemIds
      },
      {
        key: 'free',
        label: 'Свободны',
        icon: 'info',
        value: free.length,
        note: 'Движок не дал ни одной заявки',
        tone: 'accent',
        groupKey: 'crew-free',
        orderIds: free.map((l) => l.engineer.id)
      }
    ],
    bySkill: [...skills.entries()]
      .map(([key, ids]) => ({ key, label: skillName(key), count: ids.length, engineerIds: ids }))
      .sort((a, b) => b.count - a.count),
    problemBuckets,
    freeIds: free.map((l) => l.engineer.id)
  };
}
