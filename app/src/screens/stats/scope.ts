/* Срез, по которому считает статистика.

   Все семь разрезов раздела смотрят на одну и ту же историю расчётов, и срок у
   них общий: переключил «неделю» на заявках, ушёл к инженерам — там та же
   неделя. Поэтому срез считается один раз здесь, а не в каждом разрезе своим
   способом: два места, где из истории выбирают «то же самое», рано или поздно
   расходятся, и тогда за одну и ту же неделю база заявок и база инженеров
   называют разные числа.

   Границу срока держит расчёт, а не заявка: заявка сама по себе не имеет
   отметки времени, к которой можно приложить «неделю», — она попадает в
   историю ровно тогда, когда её посчитали. Поэтому и сказано «за неделю» —
   значит, по расчётам этой недели.

   Заявки в срезе лежат двумя списками, и путать их нельзя. `orderRows` — это
   строки «заявка в расчёте»: один и тот же участок, пересчитанный трижды,
   даёт три строки, и именно так считают нагрузку расчётов. `orders` — заявки
   по номерам, из всех прогонов оставлен самый свежий: так считают хозяйство —
   сколько у нас заявок, клиентов, услуг, — и здесь тройной пересчёт не должен
   утраивать аварию. */

import type { PeriodKey } from '../../app/DbWidgets.tsx';
import { withinPeriod } from '../../app/DbWidgets.tsx';
import type {
  ClientRecord,
  EngineerRecord,
  EngineerShift,
  OrderRecord,
  Registry,
  RouteRecord,
  RunStat,
  ServiceRecord
} from '../../data/registry.ts';
import { mergeEngineers, uniqueOrders } from '../../data/registry.ts';
import { isUrgent } from '../../data/dictionary.ts';

export interface StatsScope {
  period: PeriodKey;
  /** Расчёты срока, всегда в хронологии: линия отвечает на «как менялось», и
      порядок ей задаёт время, а не сортировка чужого списка. */
  runs: RunStat[];
  routes: RouteRecord[];
  /** Заявка в расчёте: столько строк, сколько раз её считали. */
  orderRows: OrderRecord[];
  /** Заявка по номеру: из всех прогонов самый свежий. */
  orders: OrderRecord[];
  /** Смены инженеров, попавшие в срок. */
  shifts: EngineerShift[];
}

export function scopeOf(registry: Registry, period: PeriodKey): StatsScope {
  const runs = [...registry.stats.byRun]
    .filter((row) => withinPeriod(row.run.created, period))
    .sort((a, b) => a.run.created.localeCompare(b.run.created));
  const ids = new Set(runs.map((row) => row.run.id));
  const orderRows = registry.orders.filter((order) => ids.has(order.run.id));

  return {
    period,
    runs,
    routes: registry.routes.filter((route) => ids.has(route.run.id)),
    orderRows,
    orders: uniqueOrders(orderRows),
    shifts: registry.engineers.flatMap((one) => one.byRun.filter((shift) => ids.has(shift.runId)))
  };
}

/* ─── ряд по расчётам ────────────────────────────────────────────────────

   Линия на плитке читается слева направо как время: первый расчёт срока слева,
   последний справа. Поэтому ряд собирается из `scope.runs`, который уже стоит
   в хронологии, а не из отсортированного списка на экране. */

export const runSeries = (scope: StatsScope, pick: (row: RunStat) => number) =>
  scope.runs.map((row) => ({ label: row.run.code, value: pick(row) }));

/** Ряд по расчётам из того, что лежит не в расчёте, а в его маршрутах или
    заявках: считаем по расчёту сами, чтобы «сколько всего» и «как менялось»
    сходились до последней единицы. */
export function groupSeries<T>(
  scope: StatsScope,
  rows: T[],
  runOf: (row: T) => string,
  pick: (group: T[]) => number
) {
  const byRun = new Map<string, T[]>();
  for (const row of rows) {
    const key = runOf(row);
    byRun.set(key, [...(byRun.get(key) ?? []), row]);
  }
  return scope.runs.map((row) => ({
    label: row.run.code,
    value: pick(byRun.get(row.run.id) ?? [])
  }));
}

/* ─── хозяйство за срок ──────────────────────────────────────────────────

   Клиенты, услуги и инженеры собраны реестром по всей истории: в их записях
   стоит «сколько всего заявок с этого адреса», и «за неделю» к такому числу не
   приложить. Поэтому за срок они пересчитываются здесь — из заявок среза, — а
   из записи реестра берётся только то, что от срока не зависит: номер, имя,
   адрес, навыки. */

export interface ClientTally {
  key: string;
  code: string;
  company: string;
  address: string;
  district: string;
  record: ClientRecord | null;
  orders: number;
  assigned: number;
  urgent: number;
  access: number;
  minutes: number;
  /** В скольких расчётах этот адрес встретился: повторные выезды. */
  runs: number;
  workTypes: Set<string>;
}

export function clientTally(registry: Registry, scope: StatsScope): ClientTally[] {
  const byKey = new Map<string, ClientTally & { runSet: Set<string> }>();
  const known = new Map(registry.clients.map((one) => [one.key, one]));

  for (const order of scope.orders) {
    let cell = byKey.get(order.clientKey);
    if (!cell) {
      const record = known.get(order.clientKey) ?? null;
      cell = {
        key: order.clientKey,
        code: order.clientCode || record?.code || '—',
        company: order.company || record?.company || '—',
        address: record?.address || order.address,
        district: record?.district || order.district,
        record,
        orders: 0,
        assigned: 0,
        urgent: 0,
        access: 0,
        minutes: 0,
        runs: 0,
        workTypes: new Set<string>(),
        runSet: new Set<string>()
      };
      byKey.set(order.clientKey, cell);
    }
    cell.orders += 1;
    if (order.engineerId) cell.assigned += 1;
    if (isUrgent(order.priorityClass, order.priority)) cell.urgent += 1;
    if (order.needsAccess) cell.access += 1;
    cell.minutes += order.estMinutes;
    cell.workTypes.add(order.workType);
    cell.runSet.add(order.run.id);
  }

  return [...byKey.values()].map((cell) => ({ ...cell, runs: cell.runSet.size }));
}

export interface ServiceTally {
  key: string;
  title: string;
  skill: string;
  record: ServiceRecord | null;
  orders: number;
  assigned: number;
  urgent: number;
  access: number;
  minutes: number;
  /** На сколько адресов эта услуга ездила: услуга на весь город и услуга к
      трём домам — разное хозяйство при одинаковом числе заявок. */
  clients: number;
}

export function serviceTally(registry: Registry, scope: StatsScope): ServiceTally[] {
  const byKey = new Map<string, ServiceTally & { clientSet: Set<string> }>();
  const known = new Map(registry.services.map((one) => [one.key, one]));

  for (const order of scope.orders) {
    let cell = byKey.get(order.workType);
    if (!cell) {
      const record = known.get(order.workType) ?? null;
      cell = {
        key: order.workType,
        title: order.workTitle || record?.title || order.workType,
        skill: order.skill || record?.skill || '',
        record,
        orders: 0,
        assigned: 0,
        urgent: 0,
        access: 0,
        minutes: 0,
        clients: 0,
        clientSet: new Set<string>()
      };
      byKey.set(order.workType, cell);
    }
    cell.orders += 1;
    if (order.engineerId) cell.assigned += 1;
    if (isUrgent(order.priorityClass, order.priority)) cell.urgent += 1;
    if (order.needsAccess) cell.access += 1;
    cell.minutes += order.estMinutes;
    cell.clientSet.add(order.clientKey);
  }

  return [...byKey.values()].map((cell) => ({ ...cell, clients: cell.clientSet.size }));
}

export interface CrewTally {
  record: EngineerRecord;
  /** Смены срока: столько, сколько расчётов его задело. */
  shifts: EngineerShift[];
  routed: number;
  visits: number;
  travelMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
  /** Средняя загрузка по сменам срока — той же функцией, что и везде. */
  occupancy: number;
  /** Сколько расчётов оставили инженера без маршрута. */
  idle: number;
  distanceKm: number | null;
}

/** Штат людьми, а не записями справочника.

    У движка записи заведены по участкам: один и тот же E00 стоит в плане
    Востока, Юго-востока и Югоцентра, и записей в справочнике выходит втрое
    больше, чем людей. База инженеров, услуги и карточки расчётов давно
    считают людьми — статистика считала записями, и на одном экране рядом
    стояли «42 из 42 в базе» и «13 из 14 инженеров с маршрутом». Число штата
    на сервисе одно, и собирается оно здесь. */
export const crewOf = (registry: Registry): EngineerRecord[] =>
  mergeEngineers(registry.engineers);

export function crewTally(registry: Registry, scope: StatsScope): CrewTally[] {
  const ids = new Set(scope.runs.map((row) => row.run.id));

  return crewOf(registry)
    .map((record) => {
      const shifts = record.byRun.filter((shift) => ids.has(shift.runId));
      const routed = shifts.filter((shift) => shift.routed);
      const known = routed.filter((shift) => shift.distanceKm !== null);
      return {
        record,
        shifts,
        routed: routed.length,
        visits: shifts.reduce((sum, shift) => sum + shift.visits, 0),
        travelMinutes: shifts.reduce((sum, shift) => sum + shift.travelMinutes, 0),
        workMinutes: shifts.reduce((sum, shift) => sum + shift.workMinutes, 0),
        overtimeMinutes: shifts.reduce((sum, shift) => sum + shift.overtimeMinutes, 0),
        /* Загрузку усредняем по тем сменам, где маршрут был: день без
           маршрута — это не «нулевая загрузка», а отсутствие смены, и в
           среднее он тянул бы вниз всех, кто работал. Сколько таких дней,
           сказано отдельным числом — `idle`. */
        occupancy:
          routed.length === 0
            ? 0
            : routed.reduce((sum, shift) => sum + shift.occupancy, 0) / routed.length,
        idle: shifts.length - routed.length,
        distanceKm:
          known.length === 0 ? null : known.reduce((sum, shift) => sum + (shift.distanceKm ?? 0), 0)
      };
    })
    .filter((cell) => cell.shifts.length > 0);
}
