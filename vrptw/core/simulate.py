"""
Симулятор исполнения дня.

Главное, ради чего он существует: **каскад**. Визит, который затянулся,
сдвигает все последующие, и следующий может не успеть в своё окно.
Именно на это влияет качество планирования — и именно это отличает
хороший план от плана, который красиво выглядит на бумаге.

Источники случайности, разыгрываются заново в каждом прогоне:
  1. время в пути отличается от планового (пробки),
  2. работа длится дольше или короче оценки,
  3. абонента может не быть дома,
  4. может не быть доступа в подъезд.

Первые два вносят каскад. Последние два — нет: это одиночные потери.

Важно, что всё это разыгрывается в прогоне, а не записывается в заявку
при генерации дня. Иначе Монте-Карло меряет одну лишь дорожную
неопределённость, разброс выходит втрое заниженным, а список хрупких
визитов вырождается: наверху оказываются заявки с однажды выпавшей
неявкой, обречённые во всех прогонах сразу, вместо тех мест плана, где
действительно нет запаса.
"""

from __future__ import annotations

import random
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from .domain import DAY_HARD_END, WORK_TYPES, Day, Plan

# Сколько инженер готов переработать сверх смены, минут.
MAX_OVERTIME = 60

# Штрафное время на неудачной попытке.
NO_SHOW_MINUTES = 12      # позвонил, подождал, уехал
NO_ACCESS_MINUTES = 15    # не пустили в подъезд

# Разброс времени в пути относительно планового.
TRAVEL_SIGMA = 0.22

# Вероятность, что не пустят в подъезд, для работ, требующих доступа.
NO_ACCESS_RATE = 0.025


@dataclass
class VisitOutcome:
    order_id: str
    engineer_id: str
    status: str            # done | missed_window | no_show | no_access | dropped
    planned_start: int
    actual_start: int | None
    lateness: int          # на сколько позже плана приступил (или пытался)


@dataclass
class DayOutcome:
    done: int = 0
    failed_by_reason: Counter = field(default_factory=Counter)
    overtime_minutes: int = 0
    idle_minutes: int = 0
    visits: list[VisitOutcome] = field(default_factory=list)

    @property
    def failed(self) -> int:
        return sum(self.failed_by_reason.values())


def simulate_once(day: Day, plan: Plan, rng: random.Random) -> DayOutcome:
    out = DayOutcome()
    net = day.network

    for route in plan.routes.values():
        eng = route.engineer
        clock = eng.shift_start
        node = eng.home_node
        stopped = False

        for visit in route.visits:
            order = visit.order

            if stopped:
                out.failed_by_reason["dropped"] += 1
                out.visits.append(VisitOutcome(
                    order.id, eng.id, "dropped", visit.start, None, 0))
                continue

            # 1. Дорога. Плановое время в пути умножается на случайный фактор.
            planned_travel = net.travel_minutes(node, order.node, clock, eng.transport)
            factor = max(0.7, rng.lognormvariate(-0.5 * TRAVEL_SIGMA ** 2, TRAVEL_SIGMA))
            actual_travel = planned_travel * factor
            arrive = clock + int(round(actual_travel))
            node = order.node

            # 2. Приехал раньше окна — ждём его открытия.
            if arrive < order.window_start:
                out.idle_minutes += order.window_start - arrive
                start = order.window_start
            else:
                start = arrive

            lateness = max(0, start - visit.start)

            # 3. Не успел в окно — срыв, но время уже потрачено.
            if start > order.window_end:
                out.failed_by_reason["missed_window"] += 1
                out.visits.append(VisitOutcome(
                    order.id, eng.id, "missed_window", visit.start, start, lateness))
                clock = start
                if clock > eng.shift_end + MAX_OVERTIME or clock > day.hard_end:
                    stopped = True
                continue

            wt = WORK_TYPES[order.work_type]

            # 4. Абонента нет дома.
            if rng.random() < wt.no_show_rate:
                clock = start + NO_SHOW_MINUTES
                out.failed_by_reason["no_show"] += 1
                out.visits.append(VisitOutcome(
                    order.id, eng.id, "no_show", visit.start, start, lateness))
                if clock > eng.shift_end + MAX_OVERTIME:
                    stopped = True
                continue

            # 5. Нет доступа.
            if order.needs_access and rng.random() < NO_ACCESS_RATE:
                clock = start + NO_ACCESS_MINUTES
                out.failed_by_reason["no_access"] += 1
                out.visits.append(VisitOutcome(
                    order.id, eng.id, "no_access", visit.start, start, lateness))
                if clock > eng.shift_end + MAX_OVERTIME:
                    stopped = True
                continue

            # 6. Работаем. Длительность лог-нормальная: медиана равна оценке,
            # но хвост вправо длинный — работа редко кончается раньше срока
            # и регулярно затягивается вдвое. Опытный справляется быстрее.
            factor = max(0.55, rng.lognormvariate(0.0, wt.spread))
            duration = max(10, int(round(order.est_minutes * factor * eng.speed)))
            clock = start + duration

            out.done += 1
            out.visits.append(VisitOutcome(
                order.id, eng.id, "done", visit.start, start, lateness))

            if clock > eng.shift_end + MAX_OVERTIME or clock > day.hard_end:
                stopped = True

        if clock > eng.shift_end:
            out.overtime_minutes += min(clock - eng.shift_end, MAX_OVERTIME)

    return out


@dataclass
class MonteCarloResult:
    runs: int
    planned: int
    total_orders: int
    done_mean: float
    done_p10: int
    done_p50: int
    done_p90: int
    done_sd: float
    reasons_mean: dict[str, float]
    overtime_mean: float
    idle_mean: float
    fragile: list[tuple[str, float]]     # (order_id, доля прогонов со срывом)

    # Сорванные обязательства: заявки, которые нельзя перенести на завтра
    # (срок по SLA истекает раньше конца дня) и которые не выполнены.
    # Это то, что считает заказчик, — покрытие считаем мы.
    breaches_mean: float = 0.0
    must_today: int = 0

    @property
    def execution_rate(self) -> float:
        """Доля запланированных визитов, которые реально выполнены."""
        return self.done_mean / self.planned if self.planned else 0.0

    @property
    def breach_rate(self) -> float:
        """Доля обязательств, которые сорвались."""
        return self.breaches_mean / self.must_today if self.must_today else 0.0

    @property
    def coverage(self) -> float:
        """Доля ВСЕХ заявок дня, которые реально выполнены. Главная метрика."""
        return self.done_mean / self.total_orders if self.total_orders else 0.0


def monte_carlo(day: Day, plan: Plan, runs: int = 300, seed: int = 0) -> MonteCarloResult:
    done_counts: list[int] = []
    reasons: Counter = Counter()
    overtime: list[int] = []
    idle: list[int] = []
    failures: defaultdict[str, int] = defaultdict(int)

    # Заявки, которые нельзя перенести на завтра. Считаем от всех заявок
    # дня, а не от запланированных: необслуженное обязательство сорвано
    # и тогда, когда его вовсе не поставили в план.
    must = {o.id for o in day.orders if o.must_today}
    breaches: list[int] = []

    for i in range(runs):
        rng = random.Random(seed * 100_000 + i)
        out = simulate_once(day, plan, rng)
        done_counts.append(out.done)
        served = {v.order_id for v in out.visits if v.status == "done"}
        breaches.append(len(must - served))
        reasons.update(out.failed_by_reason)
        overtime.append(out.overtime_minutes)
        idle.append(out.idle_minutes)
        for v in out.visits:
            if v.status != "done":
                failures[v.order_id] += 1

    done_counts.sort()
    fragile = sorted(
        ((oid, cnt / runs) for oid, cnt in failures.items()),
        key=lambda x: -x[1],
    )[:10]

    return MonteCarloResult(
        runs=runs,
        planned=plan.assigned_count,
        total_orders=len(day.orders),
        done_mean=sum(done_counts) / runs,
        done_p10=done_counts[runs // 10],
        done_p50=done_counts[runs // 2],
        done_p90=done_counts[min(runs - 1, 9 * runs // 10)],
        done_sd=statistics.pstdev(done_counts),
        reasons_mean={k: v / runs for k, v in sorted(reasons.items(), key=lambda x: -x[1])},
        overtime_mean=sum(overtime) / runs,
        idle_mean=sum(idle) / runs,
        fragile=fragile,
        breaches_mean=sum(breaches) / runs,
        must_today=len(must),
    )
