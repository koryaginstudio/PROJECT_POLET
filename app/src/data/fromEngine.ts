/* План движка на языке вёрстки.

   Вёрстка написана под контракт 1.2 из `frontend_kit/CONTRACT-1.2.md` —
   предложение, которое движок реализовал другими именами (контракт 1.3–1.5,
   `vrptw/CONTRACT.md`). Пока ответ движка клался на экран как есть, всё, что
   названо по-разному, молча пустело: у планов движка не было ни километров,
   ни сравнения с базовым вариантом, ни требуемого транспорта, ни
   закреплений диспетчера. А километры и число задействованных людей — обе
   обязательные метрики ТЗ.

   Переводим в одном месте, на входе: каждый ответ движка с планом проходит
   через `изДвижка`. Поля 1.2, которые план уже несёт, не трогаем — так
   функция безопасна и для браузерного планировщика, и для движка, если он
   когда-нибудь начнёт отдавать имена вёрстки сам.

   | вёрстка (1.2)              | движок (1.5)                         |
   |----------------------------|--------------------------------------|
   | `required_transport`       | `requires_transport`                 |
   | `required_equipment`       | `equipment` — прибор → штук           |
   | `locked_to`, `assigned_by` | `meta.pinned` — заявка → инженер      |
   | `unassigned_reason`        | `unassigned_detail` — готовая фраза   |
   | `totals.distance_km`       | `totals.km`                          |
   | `meta.engineers_used`      | `meta.metrics.engineers_used`        |
   | `meta.distance_km_total`   | `meta.metrics.km_total`              |
   | `meta.baseline` (сводка)   | `meta.baseline` (своя форма)         |
   | транспорт `walk`           | `foot`                               | */

import type { Baseline, Engineer, Order, Plan, Route } from './contract.ts';

/** Поля движка, которых нет в типах вёрстки. Все необязательные: план из
    браузерного планировщика их не несёт. */
interface EngineOrder extends Order {
  requires_transport?: string | null;
  equipment?: Record<string, number>;
}

/** Сводка базового варианта так, как её отдаёт движок. */
interface EngineBaseline {
  solver: string;
  assigned: number;
  engineers_used: number;
  km_total: number;
  km_per_visit?: number;
}

/* Типы движка собраны без пересечений с типами вёрстки: у пересечения
   массивов `map` берёт первую сигнатуру, и поле `km` пропадало бы из вида. */
type EngineMeta = Omit<Plan['meta'], 'baseline'> & {
  metrics?: {
    engineers_used: number;
    km_total: number;
    km_per_engineer?: number;
    km_per_visit?: number;
  };
  baseline?: EngineBaseline | Baseline | null;
};

interface EngineRoute extends Omit<Route, 'totals'> {
  totals: Route['totals'] & { km?: number };
}

interface EnginePlan extends Omit<Plan, 'meta' | 'orders' | 'routes'> {
  meta: EngineMeta;
  orders: EngineOrder[];
  routes: EngineRoute[];
  unassigned_detail?: { order_id: string; reason: string }[];
}

/* Транспорт: коды движка там, где у вёрстки свои. Подписи приходят
   справочником движка и совпадают; код нужен значкам и сортировке. */
const TRANSPORT: Record<string, string> = { foot: 'walk' };

/* Навык подключений: `install` у движка, `connect` у вёрстки. Без перевода
   в базе вставали две кнопки навыка, порядок и подпись сбивались, а в
   правке инженера не горела ни одна. Обратно не переводим: ни одна ручка
   движка код навыка не принимает. */
const SKILL: Record<string, string> = { install: 'connect' };

/** Оборудование списком, по штуке на прибор: «роутер, роутер» для двух. */
const поштучно = (equipment: Record<string, number> | undefined): string[] | null =>
  equipment
    ? Object.entries(equipment).flatMap(([kind, count]) => Array<string>(count).fill(kind))
    : null;

function сводкаБазового(raw: EngineBaseline | Baseline | null | undefined): Baseline | null {
  if (!raw) return null;
  if ('orders_assigned' in raw) return raw;
  return {
    solver: raw.solver,
    orders_assigned: raw.assigned,
    engineers_used: raw.engineers_used,
    distance_km_total: raw.km_total,
    /* Минут в пути у базового движок не отдаёт: в ТЗ это не метрика.
       Пусто, а не ноль: ноль в книге читался как «в дороге не были». */
    travel_minutes_total: null
  };
}

/** План движка на языке вёрстки. Уже переведённый план не меняется. */
export function изДвижка<P extends Plan>(input: P): P {
  const plan = input as unknown as EnginePlan;
  const meta = plan.meta;
  const pinned = meta.pinned ?? {};
  const причины = new Map((plan.unassigned_detail ?? []).map((d) => [d.order_id, d.reason]));

  const orders = plan.orders.map((order) => ({
    ...order,
    skill: SKILL[order.skill] ?? order.skill,
    required_transport:
      order.required_transport ??
      (order.requires_transport
        ? TRANSPORT[order.requires_transport] ?? order.requires_transport
        : null),
    required_equipment: order.required_equipment ?? поштучно(order.equipment),
    locked_to: order.locked_to ?? pinned[order.id] ?? null,
    assigned_by:
      order.assigned_by ??
      (order.assigned_to ? (pinned[order.id] ? 'dispatcher' : 'solver') : null),
    unassigned_reason:
      order.unassigned_reason ??
      (причины.has(order.id) ? { code: 'engine', text: причины.get(order.id)! } : null)
  }));

  const engineers: Engineer[] = plan.engineers.map((engineer) => ({
    ...engineer,
    transport: engineer.transport
      ? TRANSPORT[engineer.transport] ?? engineer.transport
      : engineer.transport,
    skills: engineer.skills.map((s) => SKILL[s] ?? s)
  }));

  const routes = plan.routes.map((route) =>
    route.totals.distance_km == null && route.totals.km != null
      ? { ...route, totals: { ...route.totals, distance_km: route.totals.km } }
      : route
  );

  return {
    ...input,
    meta: {
      ...meta,
      engineers_used: meta.engineers_used ?? meta.metrics?.engineers_used ?? null,
      distance_km_total: meta.distance_km_total ?? meta.metrics?.km_total ?? null,
      baseline: сводкаБазового(meta.baseline)
    },
    orders,
    engineers,
    routes
  } as unknown as P;
}
