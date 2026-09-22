"""
Почему заявка не попала в план.

Ускорение поиска в 18 раз не дало прироста покрытия — значит предел
не в качестве поиска, а в ресурсе. Этот модуль разбирает, в чём именно
упирается день: в компетенции, в окна, в смены или в конкуренцию за
время. Ответ нужен и алгоритму (куда копать), и заказчику (что
поменять в организации работы, чтобы стало лучше).
"""

from __future__ import annotations

import statistics
from collections import Counter

from .core.domain import Day, Order, Plan
from .solvers.base import schedule


def balance(day: Day, plan: Plan) -> dict:
    """Насколько ровно день разложен между инженерами.

    Занятость считается как доля смены, ушедшая на работу и дорогу.
    Простой в ожидании окна сюда не входит: инженер, который час ждёт
    открытия окна, занят не по своей вине, и записывать это ему в
    нагрузку нечестно.

    Джини выбран потому, что он не зависит от масштаба: 0 — все заняты
    одинаково, 1 — весь день везёт один. Разброс в процентных пунктах
    рядом с ним нужен, чтобы число можно было прочитать вслух.
    """
    occ, visits = [], []
    for eng in day.engineers:
        shift = eng.shift_end - eng.shift_start
        route = plan.routes.get(eng.id)
        if route is None:
            occ.append(0.0)
            visits.append(0)
            continue
        busy = sum(v.order.est_minutes for v in route.visits) + route.travel_minutes
        occ.append(busy / shift)
        visits.append(len(route.visits))

    n = len(occ)
    mean = statistics.mean(occ) if occ else 0.0
    if n > 1 and mean > 0:
        pairs = sum(abs(a - b) for a in occ for b in occ)
        gini = pairs / (2 * n * n * mean)
        sd = statistics.stdev(occ)
    else:
        gini = sd = 0.0

    return {
        "occupancy": occ,
        "visits": visits,
        "occupancy_mean": mean,
        "occupancy_sd": sd,
        "occupancy_gini": gini,
        "occupancy_min": min(occ) if occ else 0.0,
        "occupancy_max": max(occ) if occ else 0.0,
        "visits_min": min(visits) if visits else 0,
        "visits_max": max(visits) if visits else 0,
        "idle_engineers": sum(1 for v in visits if v == 0),
    }


def why_unassigned(day: Day, order: Order) -> str:
    """Причина, по которой заявка не размещена, от самой жёсткой к мягкой."""
    net = day.network

    capable = [e for e in day.engineers if e.can_do(order)]
    if not capable:
        return "нет компетенции"

    # Пересекается ли окно заявки хоть с чьей-то сменой?
    overlapping = [
        e for e in capable
        if e.shift_start < order.window_end and e.shift_end > order.window_start
    ]
    if not overlapping:
        return "окно вне смен"

    # Влезает ли она в пустой день хоть одному подходящему инженеру?
    for e in overlapping:
        if schedule(e, [order], net) is not None:
            return "конкуренция за время"

    return "недостижима в одиночку"


def diagnose(day: Day, plan: Plan) -> dict:
    reasons = Counter(why_unassigned(day, o) for o in plan.unassigned)

    # Загрузка инженеров: работа, дорога, простой, хвост смены.
    busy = work = travel = idle = tail = 0
    per_engineer = []
    for eng in day.engineers:
        route = plan.routes.get(eng.id)
        shift = eng.shift_end - eng.shift_start
        if route is None:
            per_engineer.append((eng.id, 0, 0, 0, 0, shift))
            tail += shift
            continue
        w = sum(v.order.est_minutes for v in route.visits)
        t = route.travel_minutes
        i = sum(max(0, v.start - v.arrive) for v in route.visits)
        rest = shift - (w + t + i)
        per_engineer.append((eng.id, len(route.visits), w, t, i, rest))
        work += w
        travel += t
        idle += i
        tail += max(0, rest)
        busy += shift

    capacity = sum(e.shift_end - e.shift_start for e in day.engineers)

    # Спрос и предложение по навыкам.
    demand = Counter(o.skill for o in day.orders)
    supply = Counter(s for e in day.engineers for s in e.skills)
    unassigned_skill = Counter(o.skill for o in plan.unassigned)

    # Спрос по слотам: сколько человеко-часов требует каждое окно.
    slot_demand: Counter = Counter()
    for o in day.orders:
        slot_demand[(o.window_start // 60, o.window_end // 60)] += o.est_minutes

    return {
        "unassigned": len(plan.unassigned),
        "reasons": dict(reasons),
        "balance": balance(day, plan),
        "capacity_min": capacity,
        "work_min": work,
        "travel_min": travel,
        "idle_min": idle,
        "free_min": tail,
        "utilization": round((work + travel) / capacity, 3),
        "idle_share": round(idle / capacity, 3),
        "per_engineer": per_engineer,
        "demand_by_skill": dict(demand),
        "supply_by_skill": dict(supply),
        "unassigned_by_skill": dict(unassigned_skill),
        "slot_demand_hours": {f"{a:02d}-{b:02d}": round(v / 60, 1)
                              for (a, b), v in sorted(slot_demand.items())},
    }


def report(day: Day, plan: Plan) -> str:
    d = diagnose(day, plan)
    lines = []
    lines.append(f"Не размещено: {d['unassigned']} из {len(day.orders)}")
    for reason, n in sorted(d["reasons"].items(), key=lambda x: -x[1]):
        lines.append(f"    {reason}: {n}")

    lines.append("")
    lines.append("Куда уходит смена (сумма по всем инженерам, часов):")
    cap = d["capacity_min"] / 60
    for label, key in [("работа", "work_min"), ("дорога", "travel_min"),
                       ("простой в ожидании окна", "idle_min"),
                       ("свободный хвост", "free_min")]:
        v = d[key] / 60
        lines.append(f"    {label:<26}{v:6.1f}  ({v / cap * 100:4.1f}%)")
    lines.append(f"    {'итого ёмкость':<26}{cap:6.1f}")

    lines.append("")
    b = d["balance"]
    lines.append("Равномерность загрузки:")
    lines.append(f"    занятость: от {b['occupancy_min'] * 100:.0f}% "
                 f"до {b['occupancy_max'] * 100:.0f}%, "
                 f"среднее {b['occupancy_mean'] * 100:.0f}%")
    lines.append(f"    визитов:   от {b['visits_min']} до {b['visits_max']}")
    lines.append(f"    Джини {b['occupancy_gini']:.3f}, "
                 f"разброс {b['occupancy_sd'] * 100:.1f} п.п.")
    if b["idle_engineers"]:
        lines.append(f"    инженеров без единого визита: {b['idle_engineers']}")

    lines.append("")
    lines.append("Навыки — спрос против числа инженеров:")
    for skill in sorted(d["demand_by_skill"]):
        lines.append(f"    {skill:<10}заявок {d['demand_by_skill'][skill]:>3}   "
                     f"инженеров {d['supply_by_skill'].get(skill, 0):>2}   "
                     f"не размещено {d['unassigned_by_skill'].get(skill, 0):>3}")

    lines.append("")
    lines.append("Спрос по слотам, человеко-часов:")
    for slot, hours in d["slot_demand_hours"].items():
        bar = "█" * int(hours)
        lines.append(f"    {slot}  {hours:5.1f}  {bar}")

    return "\n".join(lines)


if __name__ == "__main__":
    import statistics
    from .core.generate import generate_day
    from .core.network import default_network
    from .solvers import fast, improved

    net = default_network()
    day = generate_day(seed=3, network=net)
    plan = fast.solve(day, params=improved.Params(lns_seconds=8.0), seed=3)
    print(report(day, plan))

    print("\n" + "─" * 60)
    print("Среднее по 12 дням:")
    agg: Counter = Counter()
    util, idle_sh, gini, spread = [], [], [], []
    for seed in range(1, 13):
        d = generate_day(seed=seed, network=net)
        p = fast.solve(d, params=improved.Params(lns_seconds=3.0), seed=seed)
        info = diagnose(d, p)
        agg.update(info["reasons"])
        util.append(info["utilization"])
        idle_sh.append(info["idle_share"])
        gini.append(info["balance"]["occupancy_gini"])
        spread.append(info["balance"]["occupancy_max"] - info["balance"]["occupancy_min"])
    for reason, n in agg.most_common():
        print(f"    {reason}: {n / 12:.1f} заявки в день")
    print(f"    занятость смены (работа+дорога): {statistics.mean(util) * 100:.1f}%")
    print(f"    простой в ожидании окна:         {statistics.mean(idle_sh) * 100:.1f}%")
    print(f"    Джини по занятости:              {statistics.mean(gini):.3f}")
    print(f"    разрыв между самым и наименее занятым: "
          f"{statistics.mean(spread) * 100:.0f} п.п.")
