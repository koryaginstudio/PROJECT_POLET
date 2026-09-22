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

from .core.domain import (EQUIPMENT, SKILL_TITLES, TRANSPORT, WORK_TYPES, Day, Plan,
                          equipment_sum, equipment_text)
from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .diagnose import balance
from .shiftopt import (allowed_starts, apply, demand_curve, optimize, refine,
                       supply_curves)
from .shiftopt import N_SLOTS, GRID_START, STEP
from .solvers import fast, improved, sequential
from .solvers.base import fits_stock
from .core.domain import require_valid

SCHEMA_VERSION = "1.5"

# Пороги запаса до закрытия окна, минут.
RISK_HIGH = 20
RISK_MEDIUM = 45


def _risk(slack: int, high: float = RISK_HIGH, medium: float = RISK_MEDIUM) -> str:
    """
    Подсветка «впритык» на экране. На план не влияет вовсе: это то, как
    диспетчер видит запас, а не то, как планировщик его считает.
    Пороги — одна из семи настроек интерфейса, поэтому передаются извне.
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
        # Требуемый тип транспорта — третья обязательная группа
        # ограничений ТЗ. null означает «ограничения нет».
        "requires_transport": order.requires_transport,
        # Что везти: прибор -> штук, пусто — ничего. Состав выведен из вида
        # работ, см. `domain.EQUIPMENT`: в выгрузке его нет.
        "equipment": dict(order.equipment),
    }


def _stock_blocks(plan: Plan | None, order, eng) -> bool:
    """Не влезает ли заявка в машину этого инженера при нынешнем маршруте."""
    if plan is None or plan.stock is None or not order.equipment:
        return False
    route = plan.routes.get(eng.id)
    seq = [v.order for v in route.visits] if route else []
    return not fits_stock(seq, order, plan.stock.get(eng.id, {}))


def _why_unassigned(day: Day, order, pinned: dict | None = None,
                    plan: Plan | None = None) -> str:
    """
    Почему заявку не удалось назначить — человеческим языком.

    Разбирается по составу препятствий, а не по тому, что подумал
    солвер: диспетчеру нужно знать, чего не хватило — рук, навыка,
    транспорта или времени, — чтобы понимать, что с этим делать.
    """
    # Закрепление диспетчером разбирается первым: если человек сказал
    # «поедет этот», то все остальные причины — про других инженеров, а
    # их солвер и не рассматривал. Сказать «подходящих семеро, но все
    # заняты» про закреплённую заявку значит соврать.
    за_кем = (pinned or {}).get(order.id)
    if за_кем is not None:
        кто = next((e for e in day.engineers if e.id == за_кем), None)
        if кто is None:
            return (f"закреплена диспетчером за {за_кем}, "
                    f"а такого инженера в смене нет")
        нельзя = кто.cannot_do_reason(order)
        if нельзя:
            return f"закреплена диспетчером за {за_кем}, но у него {нельзя}"
        if _stock_blocks(plan, order, кто):
            return (f"закреплена диспетчером за {за_кем}, но у него в машине "
                    f"не осталось нужного: {equipment_text(order.equipment)}")
        return (f"закреплена диспетчером за {за_кем}, и в его смене "
                f"для неё не нашлось места")

    по_навыку = [e for e in day.engineers if order.skill in e.skills]
    if not по_навыку:
        return (f"никто в смене не владеет навыком "
                f"«{SKILL_TITLES.get(order.skill, order.skill)}»")

    годные = [e for e in по_навыку if e.can_do(order)]
    if not годные:
        # Сегодня отсеять после навыка может только транспорт. Если
        # `can_do` когда-нибудь обзаведётся третьим условием, эта ветка
        # не должна падать на `None` — она должна сказать, что причину
        # знает `Engineer.cannot_do_reason`, и он её и скажет.
        причины = {e.cannot_do_reason(order) for e in по_навыку}
        причины.discard(None)
        if причины:
            return f"ни один инженер с этим навыком не подходит: {'; '.join(sorted(причины))}"
        return "ни один инженер с этим навыком не подходит"

    в_окне = [e for e in годные
              if e.shift_start < order.window_end and e.shift_end > order.window_start]
    if not в_окне:
        return (f"окно {order.window_start // 60}:{order.window_start % 60:02d}–"
                f"{order.window_end // 60}:{order.window_end % 60:02d} "
                f"не пересекается ни с одной сменой подходящего инженера")

    # Оборудование: утром выдали под маршрут и по штуке запаса, и в
    # пересчёте заявку с роутером можно отдать только тому, у кого он
    # остался. Если не осталось ни у кого — это и есть причина, и она
    # подсказывает диспетчеру действие: подвезти прибор.
    с_прибором = [e for e in в_окне if not _stock_blocks(plan, order, e)]
    if not с_прибором:
        return (f"нужно {equipment_text(order.equipment)}, а ни у одного из "
                f"{len(в_окне)} подходящих инженеров в машине столько не осталось")

    return (f"подходящих инженеров {len(в_окне)}, но у всех это время "
            f"занято более срочными заявками")


def _comparison(day: Day, plan: Plan, baseline: Plan) -> dict:
    """
    Сравнение с базовым вариантом по двум обязательным метрикам ТЗ.

    Пробег валом сравнивать бессмысленно: план, который выполняет втрое
    больше заявок, и проедет больше. Поэтому рядом с суммой идёт пробег
    на выполненный визит — это единственное честное сопоставление, и
    именно его надо показывать на экране.
    """
    наш = plan.metrics(day)
    баз = baseline.metrics(day)

    def на_визит(m):
        return round(m["km_total"] / m["assigned"], 2) if m["assigned"] else 0.0

    return {
        "solver": "sequential — базовый вариант из ТЗ",
        "note": ("заявки по порядку поступления, первому по порядку "
                 "доступному инженеру, порядок посещения равен порядку "
                 "назначения, без оптимизации"),
        "assigned": баз["assigned"],
        "engineers_used": баз["engineers_used"],
        "km_total": баз["km_total"],
        "km_per_visit": на_визит(баз),
        "delta": {
            "assigned": наш["assigned"] - баз["assigned"],
            "engineers_used": наш["engineers_used"] - баз["engineers_used"],
            "km_total": round(наш["km_total"] - баз["km_total"], 2),
            "km_per_visit": round(на_визит(наш) - на_визит(баз), 2),
        },
    }


def build_plan(day: Day, plan: Plan, network,
               risk_high: float = RISK_HIGH,
               risk_medium: float = RISK_MEDIUM,
               baseline: Plan | None = None) -> dict:
    bal = balance(day, plan)
    # Обе обязательные метрики ТЗ разом. Живут в одном месте — в
    # `Plan.metrics`, — чтобы выгрузка и замеры считали одно и то же.
    metrics = plan.metrics(day)
    km_by_engineer = metrics["km_by_engineer"]
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
            "transport": e.transport,
            "transport_title": TRANSPORT[e.transport]["title"],
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
                # Пробег — вторая обязательная метрика ТЗ. Считается по
                # настоящему километражу дорожной сети, а не по прямой.
                # Обратный перегон домой не входит: ТЗ для обязательного
                # MVP возвращения в стартовую точку не требует.
                "km": km_by_engineer.get(eng_id, 0.0),
                "travel_minutes": route.travel_minutes,
                "work_minutes": route.work_minutes,
                "idle_minutes": idle,
                "start": eng.shift_start,
                "end": route.end_time,
                "overtime_minutes": max(0, route.end_time - eng.shift_end),
                # Доля смены на работу и дорогу. Ожидание окна сюда не
                # входит: инженер занят не по своей вине.
                "occupancy": round((route.work_minutes + route.travel_minutes) / shift, 3),
                # Что везти по этому маршруту — утренняя выдача без запаса.
                "equipment": equipment_sum(v.order for v in route.visits),
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
            # Чем этот день зовут снаружи: зона выгрузки либо номер
            # синтетического. По дате не различить — у всех трёх зон она
            # одна, и интерфейс без этого поля не знал, что ему ответили.
            "day": day.ident,
            "date": day.date,
            "generated_at": int(time.time()),
            "time_format": "minutes_from_midnight",
            # Жёсткая граница суток этого дня: у синтетики 21:00, у
            # настоящих данных заказчика 22:00. Раньше была константой и
            # у нас, и в проверке контракта — теперь едет вместе с днём.
            "hard_end": day.hard_end,
            "solver": "fast/regret+lns",
            "orders_total": len(day.orders),
            "orders_assigned": plan.assigned_count,
            "engineers_total": len(day.engineers),
            # Две обязательные метрики ТЗ: сколько людей задействовано и
            # сколько накатано. Диспетчеру они нужны рядом с планом, а не
            # в отдельной панели.
            "metrics": {
                "engineers_used": metrics["engineers_used"],
                "km_total": metrics["km_total"],
                "km_per_engineer": metrics["km_per_engineer"],
                "km_per_visit": (round(metrics["km_total"] / metrics["assigned"], 2)
                                 if metrics["assigned"] else 0.0),
            },
            # Сравнение с базовым вариантом — обязательное по ТЗ. `null`,
            # если базовый план не посчитан (например, в ответе пересчёта:
            # там сравнивают не с базовым, а с «как ехали»).
            "baseline": (_comparison(day, plan, baseline)
                         if baseline is not None else None),
            # Равномерность загрузки: Джини по занятости, 0 — все заняты
            # одинаково. Инженеры без единого визита учтены нулём.
            # Что закрепил диспетчер: заявка -> инженер. Экрану это нужно,
            # чтобы отличить «так решил движок» от «так сказал человек»:
            # у второго и вид другой, и трогать его нельзя молча.
            "pinned": dict(plan.pinned) if plan.pinned else {},
            # Оборудование: названия приборов и сколько всего нужно по
            # плану. `stock` — что оставалось в машинах, если план строился
            # с этим ограничением (пересчёт); у утреннего плана `null`:
            # выдача делается под него.
            "equipment": {
                "titles": dict(EQUIPMENT),
                "needed": equipment_sum(v.order for r in plan.routes.values()
                                        for v in r.visits),
                "stock": plan.stock,
            },
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
        # ТЗ: «Для неназначенной заявки — явная причина понятным
        # диспетчеру языком». Причина считается здесь дёшево, по составу
        # препятствий; развёрнутый разбор «кто ещё мог бы взять» живёт в
        # explain.json и стоит дороже.
        "unassigned_detail": [
            {"order_id": o.id, "reason": _why_unassigned(day, o, plan.pinned, plan)}
            for o in plan.unassigned
        ],
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
    params = params or improved.Params()
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
            # Навык и транспорт — жёсткие проверки ТЗ, и причина у каждой
            # своя. Прежде инженер без нужного транспорта попадал в «маршрут
            # занят», а сводка неназначенной заявки говорила «все подходящие
            # заняты» — про заявку, которую подходящим никто и не был.
            if order.skill not in eng.skills:
                verdict, note, delta = "no_skill", eng.cannot_do_reason(order), None
            elif order.requires_transport and order.requires_transport != eng.transport:
                verdict, note, delta = "no_vehicle", eng.cannot_do_reason(order), None
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
                elif blockers <= {"no_skill", "no_vehicle"}:
                    нужен = TRANSPORT[order.requires_transport]["title"].lower()
                    summary = f"ни у кого из владеющих навыком нет транспорта «{нужен}»"
                elif "shift_mismatch" in blockers and "no_room" not in blockers:
                    summary = "в окно этой заявки никто не работает"
                else:
                    summary = "все подходящие инженеры заняты в это время"
            else:
                summary = "не влезла: место занято более срочными заявками"
        elif len(feasible) == 1:
            # «Дешевле всех остальных из 1 подходящих» — сравнение не с кем.
            summary = (f"назначен {by_engineer[holder].name}: единственный, кому "
                       f"она подходит и влезает в маршрут")
        else:
            n = len(feasible)
            из = "подходящего" if n % 10 == 1 and n % 100 != 11 else "подходящих"
            summary = (f"назначен {by_engineer[holder].name}: дешевле всех остальных "
                       f"из {n} {из}")

        out[order.id] = {
            "assigned_to": holder,
            "summary": summary,
            "candidates": candidates,
        }

    return {
        "schema": SCHEMA_VERSION,
        "kind": "explain",
        "meta": {"day": day.ident, "date": day.date,
                 "cost_units": "минуты пути плюс штрафы за простой и риск"},
        "orders": out,
    }


def build_simulation(day: Day, plan: Plan, runs: int = 300, seed: int = 0) -> dict:
    mc = monte_carlo(day, plan, runs=runs, seed=seed)
    return {
        "schema": SCHEMA_VERSION,
        "kind": "simulation",
        "meta": {"day": day.ident, "date": day.date, "runs": runs},
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
        # Обязательства: сколько заявок нельзя было перенести на завтра и
        # сколько из них сорвалось. Это то, что считает заказчик.
        "must_today": mc.must_today,
        "breaches": round(mc.breaches_mean, 2),
        "breach_rate": round(mc.breach_rate * 100, 1),
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

    sup_now, tot_now = supply_curves(day.engineers, current, skills, None)
    sup_rec, tot_rec = supply_curves(day.engineers, recommended, skills, None)

    # Объединение по инженерам: у частичных ставок смена короче, и им
    # позволен более поздний выход.
    разрешённые = sorted({h for e in day.engineers
                          for h in allowed_starts(day, None, e)})

    # Длина смены берётся у бригады, а не пишется числом. Стояло «9», и
    # это была неправда: у заказчика двое из четырнадцати работают с
    # 14:00 до 22:00, то есть восемь часов. Экран смен писал «смена 9 ч»
    # рядом с профилем, где выход в 14:00 и граница 22:00, — арифметика
    # не сходилась на глазах.
    #
    # Одним числом бригаду с разными сменами описать нельзя, поэтому
    # рядом идёт разбивка. Само число — самая частая длина: на неё
    # смотрит тот, кому нужен один ответ, а кому нужен точный — берёт
    # разбивку. При равенстве побеждает длинная.
    по_длине: dict[float, int] = {}
    for e in day.engineers:
        часы = round((e.shift_end - e.shift_start) / 60, 1)
        по_длине[часы] = по_длине.get(часы, 0) + 1
    самая_частая = max(по_длине.items(), key=lambda kv: (kv[1], kv[0]))[0]

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
            "day": day.ident,
            "date": day.date,
            "shift_hours": самая_частая,
            # Сколько инженеров на смене какой длины. Пусто не бывает:
            # у бригады из одинаковых смен здесь одна запись.
            "shift_hours_by_count": {str(ч): n for ч, n in sorted(по_длине.items())},
            # Сколько инженеров на смене какой длины. Пусто не бывает:
            # у бригады из одинаковых смен здесь одна запись.
            
            # Допустимые часы выхода считаются от границы дня и длины
            # смены, а не берутся константой: у заказчика граница 22:00,
            # и смена может начаться позже, чем на синтетическом дне.
            "allowed_starts": [f"{h:02d}:00" for h in разрешённые],
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


def export_day(day_id: str = "1", out_dir: str = "fixtures", runs: int = 300,
               lns_seconds: float = 8.0, tune_shifts: bool = True) -> dict:
    """
    Четыре формы для интерфейса по идентификатору дня.

    Идентификатор — либо номер синтетического дня, либо имя зоны
    заказчика. У зон своя дорожная сеть: она построена под их адреса и
    лежит в кэше рядом с данными.
    """
    from .core.load import REGIONS, load_day

    ident = str(day_id).strip().lower()
    if ident in REGIONS:
        day = load_day(ident, quiet=True)
        net = day.network
        seed = 9000 + list(REGIONS).index(ident)
    else:
        seed = int(ident)
        net = default_network()
        day = generate_day(seed=seed, network=net)

    params = improved.Params(lns_seconds=lns_seconds)

    plan = fast.solve(day, params=params, seed=seed)
    require_valid(plan, day)

    # Базовый вариант ТЗ — для обязательного сравнения.
    base = sequential.solve(day)
    require_valid(base, day, "базовый план невалиден")

    coverage_now = monte_carlo(day, plan, runs=runs, seed=seed).coverage * 100

    if tune_shifts:
        # Длина смены у каждого своя: у заказчика есть частичные ставки.
        # На синтетике все смены девятичасовые, результат тот же.
        starts = optimize(day, restarts=12, seed=seed, shift_len=None).starts
        starts, _ = refine(day, starts, solver_seed=seed, sim_seed=seed + 7000,
                           rounds=2, shift_len=None)
        tuned_day = apply(day, starts, shift_len=None)
        tuned_plan = fast.solve(tuned_day, params=params, seed=seed)
        coverage_rec = monte_carlo(tuned_day, tuned_plan, runs=runs, seed=seed).coverage * 100
    else:
        starts = [e.shift_start // 60 for e in day.engineers]
        coverage_rec = coverage_now

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)

    files = {
        "plan.json": build_plan(day, plan, net, baseline=base),
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

    day_id = sys.argv[1] if len(sys.argv) > 1 else "1"
    out_dir = sys.argv[2] if len(sys.argv) > 2 else "fixtures"

    sizes = export_day(day_id=day_id, out_dir=out_dir)
    print(f"Выгружено в {out_dir}/ (день {day_id}):")
    for name, size in sizes.items():
        print(f"  {name:<18}{size / 1024:>7.1f} КБ")
