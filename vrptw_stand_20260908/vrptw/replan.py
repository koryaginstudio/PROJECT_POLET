"""
Переоценка внутри дня.

В 13:40 приходит аварийная заявка. Два визита к этому моменту уже
сорвались, один инженер застрял в пробке, половина маршрутов пройдена.
Коробочные системы отвечают на это следующим батчем — через двадцать
минут, а то и утром следующего дня. Здесь план на остаток дня
пересобирается за секунды.

Второй солвер для этого не нужен. День «обрезается» по текущему моменту:
у каждого инженера начало смены сдвигается на время, когда он
освободится, а дом заменяется на точку, где он сейчас находится.
Выполненные и сорванные заявки выбрасываются, окна, которые уже
закрылись, — тоже. Получается обычный день, только короче, и его берёт
тот же планировщик.

Отсюда две метрики, которые эксперт умеет читать:
  · время реакции — секунды от поступления заявки до нового плана;
  · стабильность плана — какая доля оставшихся визитов сохранила
    исполнителя. План, который при каждом пересчёте перетасовывает всех,
    в диспетчерской невозможен: люди уже едут.
"""

from __future__ import annotations

import copy
import random
import time
from dataclasses import dataclass, field

from .core.domain import DAY_HARD_END, WORK_TYPES, Day, Engineer, Order, Plan
from .core.simulate import (MAX_OVERTIME, NO_ACCESS_MINUTES, NO_ACCESS_RATE,
                            NO_SHOW_MINUTES, TRAVEL_SIGMA)


@dataclass
class DayState:
    """Что известно о дне на момент `at`."""

    at: int
    position: dict[str, tuple[int, int]] = field(default_factory=dict)  # eng -> (узел, когда свободен)
    done: set[str] = field(default_factory=set)
    failed: dict[str, str] = field(default_factory=dict)                # заявка -> причина
    pending: dict[str, list[str]] = field(default_factory=dict)         # eng -> ещё не начатые по плану

    @property
    def pending_ids(self) -> list[str]:
        return [oid for ids in self.pending.values() for oid in ids]


def simulate_until(day: Day, plan: Plan, until: int, rng: random.Random) -> DayState:
    """
    Проиграть день до момента `until` и вернуть состояние.

    Визит, начатый до этого момента, доигрывается: инженер не бросает
    работу на полуслове. Всё, к чему он ещё не приступал, остаётся
    в плане и будет переназначено.
    """
    net = day.network
    state = DayState(at=until)

    for eng_id, route in plan.routes.items():
        eng = route.engineer
        clock = eng.shift_start
        node = eng.home_node
        pending: list[str] = []
        stopped = False

        for visit in route.visits:
            order = visit.order

            if stopped or clock >= until:
                pending.append(order.id)
                continue

            travel = net.travel_minutes(node, order.node, clock)
            factor = max(0.7, rng.lognormvariate(-0.5 * TRAVEL_SIGMA ** 2, TRAVEL_SIGMA))
            arrive = clock + int(round(travel * factor))
            start = max(arrive, order.window_start)

            # К этому визиту инженер ещё не приступил — он переназначаем.
            if start >= until:
                pending.append(order.id)
                clock = min(clock, until)
                continue

            node = order.node
            wt = WORK_TYPES[order.work_type]

            if start > order.window_end:
                state.failed[order.id] = "missed_window"
                clock = start
            elif rng.random() < wt.no_show_rate:
                state.failed[order.id] = "no_show"
                clock = start + NO_SHOW_MINUTES
            elif order.needs_access and rng.random() < NO_ACCESS_RATE:
                state.failed[order.id] = "no_access"
                clock = start + NO_ACCESS_MINUTES
            else:
                dur = max(10, int(round(order.est_minutes
                                        * max(0.55, rng.lognormvariate(0.0, wt.spread))
                                        * eng.speed)))
                state.done.add(order.id)
                clock = start + dur

            if clock > eng.shift_end + MAX_OVERTIME or clock > DAY_HARD_END:
                stopped = True

        state.position[eng_id] = (node, max(clock, until))
        state.pending[eng_id] = pending

    # Инженеры без маршрута стоят дома и свободны.
    for eng in day.engineers:
        state.position.setdefault(eng.id, (eng.home_node, max(eng.shift_start, until)))
        state.pending.setdefault(eng.id, [])

    return state


def carve_remainder(day: Day, state: DayState, extra: list[Order] | None = None) -> Day:
    """
    Остаток дня как самостоятельная задача.

    Инженер начинает не из дома в 8 утра, а оттуда, где он сейчас, и с
    того момента, когда освободится. Заявки — те, к которым ещё не
    приступали, плюс новые; окна, которые уже закрылись, отброшены.
    """
    net = day.network
    engineers: list[Engineer] = []

    for eng in day.engineers:
        node, free_at = state.position[eng.id]
        e = copy.copy(eng)
        e.home_node = node
        e.home_lat = net.nodes[node].lat
        e.home_lon = net.nodes[node].lon
        # «Дом» на остатке дня — это где инженер сейчас, а не где он живёт.
        # На настоящей карте у этой точки есть адрес, и на экране должен
        # стоять он, а не утренний.
        e.home_address = getattr(net.nodes[node], "text", None)
        e.shift_start = min(max(free_at, state.at), eng.shift_end)
        engineers.append(e)

    by_id = {o.id: o for o in day.orders}
    remaining = [by_id[oid] for oid in state.pending_ids]
    if extra:
        remaining += extra

    # Окно закрылось — заявка на сегодня потеряна, что бы мы ни планировали.
    alive = [o for o in remaining if o.window_end > state.at]

    rest = copy.copy(day)
    rest.engineers = engineers
    rest.orders = alive
    return rest


def apply_dropout(rest: Day, eng_id: str, back_after: int | None = None) -> Day:
    """
    Инженер выбыл в момент, на котором обрезан остаток дня.

    `back_after=None` — до конца дня: машина уехала в сервис, человек
    ушёл на больничный. Инженер исчезает из бригады остатка.

    `back_after=N` — вернётся через N минут: прокол, поломка, которую
    чинят на месте. Инженер остаётся, но следующий визит может начать
    только через N минут и **оттуда, где застрял**: точку `carve_remainder`
    уже проставил, трогать её не нужно.

    Пул заявок не меняется ни в одном случае: `carve_remainder` собирает
    незаконченное со всех инженеров сразу, так что заявки выбывшего уже
    лежат в общем пуле и достанутся кому-то другому — или никому.
    """
    out = copy.copy(rest)

    if back_after is None:
        out.engineers = [e for e in rest.engineers if e.id != eng_id]
        return out

    engineers: list[Engineer] = []
    for eng in rest.engineers:
        if eng.id == eng_id:
            eng = copy.copy(eng)
            eng.shift_start = min(eng.shift_start + back_after, eng.shift_end)
        engineers.append(eng)
    out.engineers = engineers
    return out


# Разброс аварий вокруг инженера, градусы. Примерно два-три километра:
# «авария на его участке», а не «авария где-то в городе».
NEAR_SIGMA_LAT = 0.012
NEAR_SIGMA_LON = 0.020


def urgent_orders(day: Day, at: int, count: int, seed: int,
                  near: tuple[float, float] | None = None) -> list[Order]:
    """
    Аварии, поступившие в момент `at`.

    Окно открывается немедленно и длится три часа: у аварии нет
    «согласованного слота», её надо закрыть сегодня. Каждая минута
    задержки пересчёта — минус минута доступного времени, и именно это
    делает скорость реакции измеримой.

    `near=(широта, долгота)` — авария случилась там, а не «где-то по
    городу»: точку даёт место, где сейчас стоит названный инженер.
    Диспетчер обычно знает не только время, но и чей это участок, и без
    привязки пересчёт отвечал на другой вопрос — про среднюю аварию в
    среднем районе. Ближайший ему инженер при этом ничем не выделен:
    заявка кладётся в общий пул, и кто поедет — решает планировщик.
    """
    rng = random.Random(seed * 7919 + at)
    from .core.geo import DISTRICTS

    net = day.network
    real_map = getattr(net, "has_addresses", False)
    out: list[Order] = []
    weights = [d[3] for d in DISTRICTS]
    for i in range(count):
        if near is not None:
            # Район берётся по самой точке: он нужен только подписью на
            # экране, а решает всё координата.
            alat = near[0] + rng.gauss(0, NEAR_SIGMA_LAT)
            alon = near[1] + rng.gauss(0, NEAR_SIGMA_LON)
            name = min(DISTRICTS, key=lambda d: (d[1] - alat) ** 2
                       + ((d[2] - alon) / 1.75) ** 2)[0]
            lat, lon = alat, alon
            node = net.nearest_node(lat, lon)
            address = getattr(net.nodes[node], "text", None) if real_map else None
        else:
            name, dlat, dlon, _ = rng.choices(DISTRICTS, weights=weights)[0]
            if real_map:
                node, lat, lon, address = net.pick_address(name, rng)
            else:
                lat = dlat + rng.gauss(0, NEAR_SIGMA_LAT)
                lon = dlon + rng.gauss(0, NEAR_SIGMA_LON)
                node, address = net.nearest_node(lat, lon), None
        start = at
        out.append(Order(
            id=f"U{i:02d}",
            work_type="repair",
            district=name,
            lat=lat,
            lon=lon,
            node=node,
            address=address,
            window_start=start,
            window_end=min(start + 180, DAY_HARD_END),
            sla_deadline=min(start + 180, DAY_HARD_END),
            priority=2,
            est_minutes=45,
        ))
    return out


def plan_as_is(rest: Day, state: DayState) -> Plan:
    """
    «Едем как ехали» — исходный план, наложенный на остаток дня.

    Это поведение системы, которая не пересчитывает: инженер продолжает
    по вчерашнему маршруту. Визиты, в окно которых он из-за накопившихся
    задержек уже не попадает, просто не состоятся — их и отбрасываем,
    ровно как это произошло бы в жизни.
    """
    from .core.domain import Route, Visit

    net = rest.network
    by_id = {o.id: o for o in rest.orders}
    routes: dict[str, Route] = {}
    placed: set[str] = set()

    for eng in rest.engineers:
        clock, node = eng.shift_start, eng.home_node
        visits: list[Visit] = []

        for oid in state.pending.get(eng.id, []):
            order = by_id.get(oid)
            if order is None:          # окно закрылось до пересчёта
                continue

            travel = int(round(net.travel_minutes(node, order.node, clock)))
            arrive = clock + travel
            start = max(arrive, order.window_start)
            finish = start + order.est_minutes

            if start > order.window_end or finish > eng.shift_end:
                continue               # не успевает — визит выпадает

            visits.append(Visit(order=order, arrive=arrive, start=start,
                                finish=finish, travel=travel))
            placed.add(oid)
            clock, node = finish, order.node

        if visits:
            routes[eng.id] = Route(engineer=eng, visits=visits)

    return Plan(routes=routes,
                unassigned=[o for o in rest.orders if o.id not in placed])


def stability(before: Plan, after: Plan, state: DayState) -> float:
    """
    Доля ещё не начатых визитов, сохранивших исполнителя.

    Считается только по тем заявкам, что были в плане до пересчёта и
    остались после: новые заявки сравнивать не с чем.
    """
    old: dict[str, str] = {}
    for eng_id, ids in state.pending.items():
        for oid in ids:
            old[oid] = eng_id

    new: dict[str, str] = {}
    for eng_id, route in after.routes.items():
        for v in route.visits:
            new[v.order.id] = eng_id

    common = [oid for oid in old if oid in new]
    if not common:
        return 1.0
    kept = sum(1 for oid in common if old[oid] == new[oid])
    return kept / len(common)
