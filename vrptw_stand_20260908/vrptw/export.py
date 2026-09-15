"""
Выгрузка данных для интерфейса.

Четыре формы, каждая отвечает своему экрану:

  plan.json        карта и таймлайн смены — маршруты, времена, запасы
  explain.json     панель объяснений — почему эта заявка у этого инженера
  simulation.json  сводка дня — сколько выполнится и что сорвётся
  shifts.json      график выхода — спрос против смен и рекомендация

Спецификация форм лежит в CONTRACT.md. Все времена — минуты от полуночи
(целые числа): по ним напрямую считаются позиции на таймлайне, а
форматирование в «14:35» остаётся на стороне интерфейса.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from .core.domain import WORK_TYPES, Day, Plan
from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .diagnose import balance
from .shiftopt import ALLOWED_STARTS, apply, demand_curve, optimize, refine, supply_curves
from .shiftopt import N_SLOTS, GRID_START, STEP
from .solvers import fast, improved

SCHEMA_VERSION = "1.1"

# Пороги запаса до закрытия окна, минут. Значения по умолчанию — те, на
# которых стенд мерили; компания вправе их поднять, и это единственная пара
# констант этого модуля, которая выставляется наружу. Остальное здесь —
# внутренние решения экспорта, а эта пара про то, когда предупреждать
# диспетчера, и зависит от жёсткости сроков в договоре.
RISK_HIGH = 20
RISK_MEDIUM = 45


def _risk(slack: int, high: int = RISK_HIGH, medium: int = RISK_MEDIUM) -> str:
    """Насколько визит под угрозой по остатку запаса.

    Пороги приходят аргументами, а не читаются из модуля: их задаёт
    компания, и два расчёта с разными порогами обязаны раскрашиваться
    по-разному. Значения по умолчанию оставлены, чтобы старые вызовы
    продолжали работать без правок.
    """
    if slack < high:
        return "high"
    if slack < medium:
        return "medium"
    return "low"


def _order_public(order) -> dict:
    """Заявка так, как её видит интерфейс."""
    wt = WORK_TYPES[order.work_type]
    return {
        "id": order.id,
        "work_type": order.work_type,
        "work_title": wt.title,
        "skill": order.skill,
        "district": order.district,
        # Почтовый адрес — только если день собран на настоящей карте.
        # На синтетической сети здесь null, и это честнее, чем выдумать
        # улицу под случайную точку.
        "address": order.address,
        "lat": round(order.lat, 6),
        "lon": round(order.lon, 6),
        "window_start": order.window_start,
        "window_end": order.window_end,
        "sla_deadline": order.sla_deadline,
        "priority": order.priority,
        "est_minutes": order.est_minutes,
        "needs_access": order.needs_access,
    }


def build_plan(day: Day, plan: Plan, network,
               risk_high: int = RISK_HIGH,
               risk_medium: int = RISK_MEDIUM) -> dict:
    bal = balance(day, plan)
    engineers = []
    for e in day.engineers:
        engineers.append({
            "id": e.id,
            "name": e.name,
            "skills": sorted(e.skills),
            "grade": e.grade,
            "shift_start": e.shift_start,
            "shift_end": e.shift_end,
            "home_address": e.home_address,
            "home_lat": round(e.home_lat, 6),
            "home_lon": round(e.home_lon, 6),
        })

    assigned_to: dict[str, str] = {}
    routes = []
    for eng_id, route in plan.routes.items():
        eng = route.engineer
        stops = []
        prev_node = eng.home_node
        prev_minute = eng.shift_start

        for i, v in enumerate(route.visits):
            assigned_to[v.order.id] = eng_id
            geometry = [[round(lat, 6), round(lon, 6)] for lat, lon
                        in network.path_latlon(prev_node, v.order.node, prev_minute)]
            # Последняя точка — сам адрес. У синтетической сети он не
            # совпадает с узлом, у настоящей узел и есть адрес — тогда
            # точка уже на месте и дублировать её незачем. Исключение —
            # следующий визит в том же доме: инженер никуда не едет, и
            # ломаная вырождается в точку. Контракт обещает интерфейсу
            # минимум две точки, поэтому точку дублируем: полилиния из
            # двух совпадающих концов на карте просто ничего не рисует,
            # и обрабатывать этот случай отдельно фронту не приходится.
            tail = [round(v.order.lat, 6), round(v.order.lon, 6)]
            if len(geometry) < 2 or geometry[-1] != tail:
                geometry.append(tail)

            stops.append({
                "seq": i,
                "order_id": v.order.id,
                "arrive": v.arrive,
                "start": v.start,
                "finish": v.finish,
                "travel_minutes": v.travel,
                "wait_minutes": max(0, v.start - v.arrive),
                "slack_minutes": v.slack,
                "risk": _risk(v.slack, risk_high, risk_medium),
                "geometry": geometry,
            })
            prev_node = v.order.node
            prev_minute = v.finish

        idle = sum(s["wait_minutes"] for s in stops)
        shift = max(1, eng.shift_end - eng.shift_start)
        routes.append({
            "engineer_id": eng_id,
            "stops": stops,
            "totals": {
                "visits": len(stops),
                "travel_minutes": route.travel_minutes,
                "work_minutes": route.work_minutes,
                "idle_minutes": idle,
                "start": eng.shift_start,
                "end": route.end_time,
                "overtime_minutes": max(0, route.end_time - eng.shift_end),
                # Доля смены на работу и дорогу. Ожидание окна сюда не
                # входит: инженер занят не по своей вине.
                "occupancy": round((route.work_minutes + route.travel_minutes) / shift, 3),
            },
        })

    routes.sort(key=lambda r: r["engineer_id"])

    orders = []
    for o in day.orders:
        rec = _order_public(o)
        rec["assigned_to"] = assigned_to.get(o.id)
        orders.append(rec)

    return {
        "schema": SCHEMA_VERSION,
        "kind": "plan",
        "meta": {
            "date": day.date,
            "generated_at": int(time.time()),
            "time_format": "minutes_from_midnight",
            "solver": "fast/regret+lns",
            "orders_total": len(day.orders),
            "orders_assigned": plan.assigned_count,
            "engineers_total": len(day.engineers),
            # Равномерность загрузки: Джини по занятости, 0 — все заняты
            # одинаково. Инженеры без единого визита учтены нулём.
            "balance": {
                "gini": round(bal["occupancy_gini"], 3),
                "occupancy_min": round(bal["occupancy_min"], 3),
                "occupancy_max": round(bal["occupancy_max"], 3),
                "occupancy_mean": round(bal["occupancy_mean"], 3),
                "idle_engineers": bal["idle_engineers"],
            },
        },
        "engineers": engineers,
        "orders": orders,
        "routes": routes,
        "unassigned": [o.id for o in plan.unassigned],
    }


def build_explain(day: Day, plan: Plan, params: improved.Params | None = None) -> dict:
    """
    Для каждой заявки — кто ещё мог её взять и почему взял не он.

    Считается так: заявка снимается с маршрута, после чего для каждого
    инженера проверяется лучшая возможная вставка. Разница стоимости с
    фактическим исполнителем и есть ответ «почему не он».
    """
    # Стоимость должна считаться теми же параметрами, какими строился
    # план: иначе «почему не он» объясняет не тот план, что показан.
    params = params or improved.Params(balance_weight=improved.BALANCE_WEIGHT)
    sol = fast._Solution(day, params)
    for eng_id, route in plan.routes.items():
        sol.routes[eng_id].seq = [v.order for v in route.visits]
        sol.routes[eng_id].rebuild()
    sol.pool = list(plan.unassigned)

    by_engineer = {e.id: e for e in day.engineers}
    out: dict[str, dict] = {}

    for order in day.orders:
        holder = next((eid for eid, r in sol.routes.items()
                       if any(o.id == order.id for o in r.seq)), None)

        probe = sol.clone()
        if holder is not None:
            target = next(o for o in probe.routes[holder].seq if o.id == order.id)
            probe.routes[holder].remove(target)

        options = probe.options_for(order)
        best_by_eng: dict[str, float] = {}
        for delta, eid, _pos in options:
            if eid not in best_by_eng or delta < best_by_eng[eid]:
                best_by_eng[eid] = delta

        chosen_cost = best_by_eng.get(holder)
        candidates = []
        for eng in day.engineers:
            if order.skill not in eng.skills:
                verdict, note, delta = "no_skill", f"нет навыка «{order.skill}»", None
            elif eng.shift_start >= order.window_end or eng.shift_end <= order.window_start:
                verdict, note, delta = "shift_mismatch", "окно заявки вне его смены", None
            elif eng.id not in best_by_eng:
                verdict, note, delta = "no_room", "маршрут уже занят в это время", None
            else:
                delta = round(best_by_eng[eng.id], 1)
                if eng.id == holder:
                    verdict, note = "chosen", "назначен"
                elif chosen_cost is not None:
                    extra = round(best_by_eng[eng.id] - chosen_cost, 1)
                    verdict = "feasible"
                    note = (f"мог бы, но обошёлся бы дороже на {extra:.0f}"
                            if extra > 0 else "мог бы с той же стоимостью")
                else:
                    verdict, note = "feasible", "мог бы взять"

            candidates.append({
                "engineer_id": eng.id,
                "verdict": verdict,
                "cost": delta,
                "note": note,
            })

        feasible = [c for c in candidates if c["verdict"] in ("chosen", "feasible")]
        if holder is None:
            if not feasible:
                blockers = {c["verdict"] for c in candidates}
                if blockers == {"no_skill"}:
                    summary = "никто не владеет нужным навыком"
                elif "shift_mismatch" in blockers and "no_room" not in blockers:
                    summary = "в окно этой заявки никто не работает"
                else:
                    summary = "все подходящие инженеры заняты в это время"
            else:
                summary = "не влезла: место занято более срочными заявками"
        else:
            summary = (f"назначен {by_engineer[holder].name}: дешевле всех остальных "
                       f"из {len(feasible)} подходящих")

        out[order.id] = {
            "assigned_to": holder,
            "summary": summary,
            "candidates": candidates,
        }

    return {
        "schema": SCHEMA_VERSION,
        "kind": "explain",
        "meta": {"date": day.date, "cost_units": "минуты пути плюс штрафы за простой и риск"},
        "orders": out,
    }


def build_simulation(day: Day, plan: Plan, runs: int = 300, seed: int = 0) -> dict:
    mc = monte_carlo(day, plan, runs=runs, seed=seed)
    return {
        "schema": SCHEMA_VERSION,
        "kind": "simulation",
        "meta": {"date": day.date, "runs": runs},
        "planned": mc.planned,
        "orders_total": mc.total_orders,
        "done": {
            "mean": round(mc.done_mean, 2),
            "p10": mc.done_p10,
            "p50": mc.done_p50,
            "p90": mc.done_p90,
            "sd": round(mc.done_sd, 2),
        },
        "coverage": round(mc.coverage * 100, 1),
        "execution_rate": round(mc.execution_rate * 100, 1),
        "reasons": {k: round(v, 2) for k, v in mc.reasons_mean.items()},
        "overtime_minutes": round(mc.overtime_mean, 1),
        "idle_minutes": round(mc.idle_mean, 1),
        "fragile": [{"order_id": oid, "failure_rate": round(rate * 100, 1)}
                    for oid, rate in mc.fragile],
    }


def build_shifts(day: Day, recommended: list[int], coverage_now: float,
                 coverage_rec: float) -> dict:
    demand = demand_curve(day)
    skills = sorted(demand)
    current = [e.shift_start // 60 for e in day.engineers]

    sup_now, tot_now = supply_curves(day.engineers, current, skills)
    sup_rec, tot_rec = supply_curves(day.engineers, recommended, skills)

    curve = []
    for i in range(N_SLOTS):
        minute = GRID_START + i * STEP
        if minute < 6 * 60 or minute > 22 * 60:
            continue
        curve.append({
            "minute": minute,
            "demand": {s: round(float(demand[s][i]), 2) for s in skills},
            "demand_total": round(float(sum(demand[s][i] for s in skills)), 2),
            "supply_current": int(tot_now[i]),
            "supply_recommended": int(tot_rec[i]),
        })

    def profile(starts: list[int]) -> dict[str, int]:
        out: dict[str, int] = {}
        for h in sorted(starts):
            out[f"{h:02d}:00"] = out.get(f"{h:02d}:00", 0) + 1
        return out

    return {
        "schema": SCHEMA_VERSION,
        "kind": "shifts",
        "meta": {
            "date": day.date,
            "shift_hours": 9,
            "allowed_starts": [f"{h:02d}:00" for h in ALLOWED_STARTS],
            "demand_units": "инженеров одновременно, с учётом дороги",
        },
        "current": {
            "profile": profile(current),
            "expected_coverage": round(coverage_now, 1),
        },
        "recommended": {
            "profile": profile(recommended),
            "expected_coverage": round(coverage_rec, 1),
            "starts_by_engineer": {e.id: f"{h:02d}:00"
                                   for e, h in zip(day.engineers, recommended)},
        },
        "curve": curve,
    }


def export_day(seed: int = 1, out_dir: str = "fixtures", runs: int = 300,
               lns_seconds: float = 8.0, tune_shifts: bool = True) -> dict:
    net = default_network()
    day = generate_day(seed=seed, network=net)
    params = improved.Params(lns_seconds=lns_seconds,
                             balance_weight=improved.BALANCE_WEIGHT)

    plan = fast.solve(day, params=params, seed=seed)
    problems = plan.check_invariants(day)
    assert not problems, f"план невалиден: {problems[:3]}"

    coverage_now = monte_carlo(day, plan, runs=runs, seed=seed).coverage * 100

    if tune_shifts:
        starts = optimize(day, restarts=12, seed=seed).starts
        starts, _ = refine(day, starts, solver_seed=seed, sim_seed=seed + 7000, rounds=2)
        tuned_day = apply(day, starts)
        tuned_plan = fast.solve(tuned_day, params=params, seed=seed)
        coverage_rec = monte_carlo(tuned_day, tuned_plan, runs=runs, seed=seed).coverage * 100
    else:
        starts = [e.shift_start // 60 for e in day.engineers]
        coverage_rec = coverage_now

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    files = {
        "plan.json": build_plan(day, plan, net),
        "explain.json": build_explain(day, plan, params),
        "simulation.json": build_simulation(day, plan, runs=runs, seed=seed),
        "shifts.json": build_shifts(day, starts, coverage_now, coverage_rec),
    }

    sizes = {}
    for name, payload in files.items():
        path = out / name
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=1))
        sizes[name] = path.stat().st_size

    # Настоящая геометрия дорог достаётся по сети; складываем её рядом с
    # данными, чтобы следующий запуск обошёлся без интернета.
    if hasattr(net, "save_geometry"):
        net.save_geometry()

    return sizes


if __name__ == "__main__":
    import sys

    seed = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "fixtures"

    sizes = export_day(seed=seed, out_dir=out_dir)
    print(f"Выгружено в {out_dir}/ (день {seed}):")
    for name, size in sizes.items():
        print(f"  {name:<18}{size / 1024:>7.1f} КБ")
