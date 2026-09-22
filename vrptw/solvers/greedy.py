"""
Базовый жадный планировщик.

Берёт заявки по порядку срочности и пристраивает каждую в конец того
маршрута, где она обойдётся дешевле всего. Ничего не переигрывает.
Это тот уровень, который получается «за вечер», и он служит точкой
отсчёта для всего остального.
"""

from __future__ import annotations

from ..core.domain import Day, Order, Plan, Route, require_valid
from .base import make_route, route_cost, schedule


def _key(order: Order):
    """Идём по дню слева направо: сначала ранние окна, внутри — узкие
    и аварийные. Пристраивание в конец маршрута только так и осмысленно."""
    return (order.window_start, -order.priority, order.window_len())


def solve(day: Day) -> Plan:
    net = day.network
    seqs: dict[str, list] = {e.id: [] for e in day.engineers}
    routes: dict[str, list] = {e.id: [] for e in day.engineers}
    engineers = {e.id: e for e in day.engineers}

    unassigned = []

    for order in sorted(day.orders, key=_key):
        best_eng = None
        best_visits = None
        best_delta = float("inf")

        for eng in day.engineers:
            if not eng.can_do(order):
                continue

            candidate = seqs[eng.id] + [order]
            visits = schedule(eng, candidate, net)
            if visits is None:
                continue

            delta = route_cost(visits, eng) - route_cost(routes[eng.id], eng)
            if delta < best_delta:
                best_delta = delta
                best_eng = eng
                best_visits = visits

        if best_eng is None:
            unassigned.append(order)
        else:
            seqs[best_eng.id].append(order)
            routes[best_eng.id] = best_visits

    return require_valid(Plan(
        routes={eid: make_route(engineers[eid], v) for eid, v in routes.items() if v},
        unassigned=unassigned,
    ), day, "жадный план невалиден")
