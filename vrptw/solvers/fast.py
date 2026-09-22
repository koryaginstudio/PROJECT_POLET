"""
Тот же алгоритм, что в improved.py, но с инкрементальными пересчётами.

Замер показал 74 итерации LNS за 8 секунд — на два порядка меньше, чем
нужно, чтобы поиск что-то нашёл. Плато «после двух секунд лучше не
становится» означало не сходимость, а то, что поиск не успевает
сделать и сотни шагов.

Два узких места и что с ними сделано:

1. Стоимость маршрута пересчитывалась целиком на каждую пробную
   вставку. Но она аддитивна по визитам, поэтому здесь хранятся
   префиксные суммы: вставка в позицию p считает только хвост,
   голова берётся готовой.

2. Regret требует опций вставки для всех заявок пула на каждом шаге,
   а после вставки меняется ровно один маршрут. Поэтому опции
   кэшируются, и обновляются только те, что относятся к изменённому
   маршруту.

Результат воспроизводит improved.py визит в визит — это проверяется
в `selfcheck` на каждом запуске, и не только на нулевом бюджете:
с `Params.lns_iterations` обе реализации делают одинаковое число шагов
поиска, поэтому сверяется весь алгоритм целиком, вместе с выбиванием,
пересборкой и инкрементальными префиксами. По секундам такая сверка
невозможна в принципе: быстрая версия успевает на два порядка больше
итераций, и это не расхождение, а её смысл.

Чтобы равенство было настоящим, а не приблизительным, сожаление и
стоимость вставки округляются до шестого знака: две одинаковые по смыслу
вставки различаются в пятнадцатом знаке из-за порядка сложения, и без
округления выбор зависел бы от этого шума.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

from ..core.domain import Day, Engineer, Order, Plan, Visit, require_valid, too_far
from .base import fits_stock, make_route
from .improved import (COMFORT_SLACK, COOLING, RUIN_GEO, RUIN_SEGMENT,
                       SINGLE_OPTION, SLA_REGRET, START_TEMPERATURE, Params)


class _Route:
    """Маршрут одного инженера с префиксными суммами."""

    __slots__ = ("eng", "p", "net", "seq", "_state", "_cost", "_load")

    def __init__(self, eng: Engineer, params: Params, net):
        self.eng = eng
        self.p = params
        self.net = net
        self.seq: list[Order] = []
        # _state[i] — (часы, узел) перед i-м визитом
        self._state: list[tuple[int, int]] = [(eng.shift_start, eng.home_node)]
        # _cost[i] — стоимость первых i визитов
        self._cost: list[float] = [0.0]
        # _load[i] — занятые минуты (работа + дорога) первых i визитов
        self._load: list[float] = [0.0]

    def _balance(self, load: float) -> float:
        """Штраф за загруженность маршрута.

        Квадрат по занятым часам: маргинальная цена визита растёт вместе
        с нагрузкой, поэтому вставка сама уходит к менее занятому
        инженеру. При нулевом весе член исчезает и решение не меняется.
        """
        if not self.p.balance_weight:
            return 0.0
        return self.p.balance_weight * (load / 60.0) ** 2

    @property
    def cost(self) -> float:
        return self._cost[-1] + self._balance(self._load[-1])

    def _step(self, clock: int, node: int, order: Order, position: int):
        """Один визит. Возвращает (clock, node, приращения) или None."""
        # То же ограничение, что в `base.schedule_upto`: две реализации
        # одного алгоритма обязаны отсекать одно и то же.
        if too_far(self.net, node, order.node, self.eng.transport):
            return None
        travel = int(round(self.net.travel_minutes(node, order.node, clock, self.eng.transport)))
        arrive = clock + travel
        start = arrive if arrive >= order.window_start else order.window_start

        if start + self.p.buffer_fn(position) > order.window_end:
            return None

        duration = int(round(order.est_minutes * self.p.duration_factor))
        finish = start + duration
        if finish > self.eng.shift_end:
            return None

        idle = start - arrive
        risk = COMFORT_SLACK - (order.window_end - start)
        delta = travel + self.p.idle_weight * idle
        if risk > 0:
            delta += self.p.risk_weight * risk

        # Авария ждать не должна: широкое окно у неё не свобода, а сутки
        # на устранение. Тот же член, что в `improved.route_cost`, только
        # начисляется повизитно — сумма по маршруту совпадает.
        if self.p.urgency_weight and order.priority >= 2:
            delta += self.p.urgency_weight * max(0, start - order.window_start) / 60.0

        # Заявку уже везёт другой инженер — переназначение стоит денег.
        if self.p.churn_penalty and self.p.anchor:
            previous = self.p.anchor.get(order.id)
            if previous is not None and previous != self.eng.id:
                delta += self.p.churn_penalty

        return finish, order.node, delta, travel + duration

    def insertion_cost(self, order: Order, pos: int) -> float | None:
        """Полная стоимость маршрута, если вставить order в позицию pos."""
        clock, node = self._state[pos]
        total = self._cost[pos]
        load = self._load[pos]

        step = self._step(clock, node, order, pos)
        if step is None:
            return None
        clock, node, delta, dload = step
        total += delta
        load += dload

        for i, nxt in enumerate(self.seq[pos:], start=pos + 1):
            step = self._step(clock, node, nxt, i)
            if step is None:
                return None
            clock, node, delta, dload = step
            total += delta
            load += dload

        return total + self._balance(load)

    def rebuild(self) -> int:
        """Пересчитать префиксы.

        Возвращает -1, если вся последовательность осуществима, иначе
        индекс первого визита, на котором она ломается. Префиксы
        обновляются в любом случае — до точки поломки они верны.
        """
        clock, node = self.eng.shift_start, self.eng.home_node
        state = [(clock, node)]
        cost = [0.0]
        load = [0.0]
        acc = busy = 0.0
        broken = -1

        for i, order in enumerate(self.seq):
            step = self._step(clock, node, order, i)
            if step is None:
                broken = i
                break
            clock, node, delta, dload = step
            acc += delta
            busy += dload
            state.append((clock, node))
            cost.append(acc)
            load.append(busy)

        self._state, self._cost, self._load = state, cost, load
        return broken

    def insert(self, order: Order, pos: int) -> None:
        self.seq.insert(pos, order)
        broken = self.rebuild()
        assert broken < 0, "вставка сделала маршрут неосуществимым"

    def remove(self, order: Order) -> list[Order]:
        """Убрать заявку из маршрута.

        Удаление сдвигает последующие визиты раньше — иногда прямо в
        час пик, и тогда время в пути растёт настолько, что остаток
        маршрута перестаёт быть осуществимым. Такие визиты тоже
        выбиваются и возвращаются вызывающему, чтобы он вернул их в пул.
        """
        self.seq.remove(order)
        evicted: list[Order] = []
        while True:
            broken = self.rebuild()
            if broken < 0:
                return evicted
            evicted.append(self.seq.pop(broken))

    def visits(self) -> list[Visit]:
        """Материализовать визиты для итогового плана."""
        out: list[Visit] = []
        clock, node = self.eng.shift_start, self.eng.home_node
        for order in self.seq:
            travel = int(round(self.net.travel_minutes(node, order.node, clock, self.eng.transport)))
            arrive = clock + travel
            start = max(arrive, order.window_start)
            finish = start + int(round(order.est_minutes * self.p.duration_factor))
            out.append(Visit(order=order, arrive=arrive, start=start,
                             finish=finish, travel=travel))
            clock, node = finish, order.node
        return out


class _Solution:
    def __init__(self, day: Day, params: Params):
        self.day = day
        self.p = params
        self.net = day.network
        self.routes: dict[str, _Route] = {
            e.id: _Route(e, params, day.network) for e in day.engineers
        }
        self.pool: list[Order] = []
        # какие инженеры вообще могут взять эту заявку
        #
        # Закрепление диспетчером сужает этот круг до одного: человек
        # сказал «поедет этот», и это запрет, а не пожелание. Зеркально с
        # отбором кандидатов в `improved.options_for`.
        def кто_может(o: Order) -> list[str]:
            за_кем = params.pinned.get(o.id) if params.pinned else None
            return [e.id for e in day.engineers
                    if e.can_do(o) and (за_кем is None or за_кем == e.id)]

        self.capable: dict[str, list[str]] = {
            o.id: кто_может(o) for o in day.orders
        }

    def clone(self) -> "_Solution":
        s = _Solution.__new__(_Solution)
        s.day, s.p, s.net = self.day, self.p, self.net
        s.capable = self.capable
        s.pool = list(self.pool)
        s.routes = {}
        for eid, r in self.routes.items():
            nr = _Route.__new__(_Route)
            nr.eng, nr.p, nr.net = r.eng, r.p, r.net
            nr.seq = list(r.seq)
            nr._state = list(r._state)
            nr._cost = list(r._cost)
            nr._load = list(r._load)
            s.routes[eid] = nr
        return s

    def unplaced_cost(self) -> float:
        """
        Чего стоит несделанное. При единичном весе — просто их число.

        С весом больше единицы заявка, которую нельзя перенести на завтра,
        считается за несколько: солверу выгоднее оставить лежать две
        переносимые, чем одну с обязательством на сегодня.
        """
        w = self.p.sla_weight
        pw = self.p.priority_weights
        if w == 1.0 and pw == (1.0, 1.0, 1.0):
            return float(len(self.pool))
        # Приоритет распределения: несделанная авария стоит дороже любого
        # числа несделанного ниже неё. Зеркально с `improved.unplaced_cost`.
        return sum(pw[o.priority] * (w if o.must_today else 1.0)
                   for o in self.pool)

    def engineers_used(self) -> int:
        """Сколько исполнителей задействовано — первая метрика ТЗ."""
        return sum(1 for r in self.routes.values() if r.seq)

    def objective(self) -> tuple[float, float, float]:
        """Лексикографически: несделанное, число людей, стоимость.
        Разбор — в `improved._State.objective`, здесь то же самое."""
        return (self.unplaced_cost(),
                self.p.vehicle_weight * self.engineers_used(),
                sum(r.cost for r in self.routes.values()))

    # ---------- опции вставки ----------

    def options_for(self, order: Order, only: str | None = None):
        """(дельта, eng_id, позиция) по всем допустимым местам."""
        out = []
        eng_ids = [only] if only else self.capable[order.id]
        for eid in eng_ids:
            if only and eid not in self.capable[order.id]:
                continue
            route = self.routes[eid]
            # Оборудование в машине. Зависит от того, что уже в маршруте,
            # поэтому здесь, а не в `capable`: после вставки опции этого
            # маршрута пересчитываются для всего пула. Зеркально с
            # `improved._State.best_insertion`.
            if self.p.stock is not None and not fits_stock(
                    route.seq, order, self.p.stock.get(eid, {})):
                continue
            base = route.cost
            for pos in range(len(route.seq) + 1):
                total = route.insertion_cost(order, pos)
                if total is not None:
                    out.append((total - base, eid, pos))
        # Regret читает первые два элемента как лучший и второй — порядок обязателен.
        out.sort(key=lambda x: (round(x[0], 6), x[1], x[2]))
        return out

    def recreate(self, rng: random.Random | None = None) -> None:
        """Regret-2 вставка пула с кэшем опций.

        С `rng` и ненулевым `noise` пересборка рандомизируется — иначе
        ruin & recreate возвращал бы одно и то же решение на каждой
        итерации.
        """
        jitter = self.p.noise if (rng is not None and self.p.noise) else 0.0
        cache: dict[str, list] = {o.id: self.options_for(o) for o in self.pool}

        while self.pool:
            best = None
            best_key = None

            for order in self.pool:
                opts = cache[order.id]
                if not opts:
                    continue
                if len(opts) == 1:
                    # Единственное место — берём немедленно. Конечное
                    # число вместо бесконечности: иначе шум на таких
                    # заявках не работает, а их порядок между собой
                    # оказывается жёстко задан идентификатором.
                    regret = SINGLE_OPTION
                    if jitter:
                        regret += rng.uniform(0.0, SINGLE_OPTION / 10)
                else:
                    regret = opts[1][0] - opts[0][0]
                    if jitter:
                        regret += rng.uniform(-jitter, jitter)
                # Аварии двигаем вперёд, а с ними — обязательства на
                # сегодня: они в той же шкале срочности.
                regret += order.priority * 25
                if self.p.sla_weight != 1.0 and order.must_today:
                    regret += (self.p.sla_weight - 1.0) * SLA_REGRET
                # Тот же ключ, что в improved.py: округление снимает шум
                # порядка сложения, идентификатор доводит порядок до
                # полностью определённого.
                key = (-round(regret, 6), order.id)
                if best_key is None or key < best_key:
                    best_key = key
                    if jitter:
                        # Шум в стоимости самих опций, а не только в
                        # сожалении: иначе исполнитель выбирается всегда
                        # один и тот же, и пересборка не даёт нового.
                        pick = min((c + rng.uniform(-jitter, jitter), e, q)
                                   for c, e, q in opts[:8])
                    else:
                        pick = opts[0]
                    best = (order, pick[1], pick[2])

            if best is None:
                break

            order, eid, pos = best
            self.routes[eid].insert(order, pos)
            self.pool.remove(order)
            del cache[order.id]

            # Изменился ровно один маршрут — обновляем только его опции.
            for other in self.pool:
                opts = [o for o in cache[other.id] if o[1] != eid]
                opts.extend(self.options_for(other, only=eid))
                opts.sort(key=lambda x: (round(x[0], 6), x[1], x[2]))
                cache[other.id] = opts

    def ruin(self, rng: random.Random, q: int) -> None:
        assigned = [(eid, o) for eid, r in self.routes.items() for o in r.seq]
        if not assigned:
            return
        q = min(q, len(assigned))
        roll = rng.random()

        if roll < RUIN_GEO:
            # Географический кластер вокруг случайной точки.
            mat = self.net._matrices[12]
            _, seed_order = rng.choice(assigned)
            assigned.sort(key=lambda pair: mat[seed_order.node, pair[1].node])
            victims = assigned[:q]
        elif roll < RUIN_SEGMENT:
            # Непрерывный кусок одного маршрута.
            live = [eid for eid, r in self.routes.items() if r.seq]
            eid = rng.choice(live)
            seq = self.routes[eid].seq
            start = rng.randrange(len(seq))
            victims = [(eid, o) for o in seq[start:start + q]]
            if len(victims) < q:
                taken = {v[1].id for v in victims}
                rest = [pair for pair in assigned if pair[1].id not in taken]
                rng.shuffle(rest)
                victims += rest[:q - len(victims)]
        else:
            # Самые рискованные визиты — те, что идут впритык к окну.
            def slack(pair):
                eid, o = pair
                r = self.routes[eid]
                i = r.seq.index(o)
                clock, node = r._state[i]
                travel = int(round(self.net.travel_minutes(node, o.node, clock, r.eng.transport)))
                start = max(clock + travel, o.window_start)
                return o.window_end - start
            assigned.sort(key=slack)
            victims = assigned[:q]

        # Выбивание одной заявки может утащить за собой следующие за ней:
        # маршрут без неё сдвигается раньше и перестаёт быть осуществимым.
        # Поэтому отслеживаем, кто уже покинул маршрут.
        gone: set[str] = set()
        for eid, o in victims:
            if o.id in gone:
                continue
            evicted = self.routes[eid].remove(o)
            self.pool.append(o)
            gone.add(o.id)
            for e in evicted:
                self.pool.append(e)
                gone.add(e.id)

    def to_plan(self) -> Plan:
        routes = {}
        for eid, r in self.routes.items():
            if r.seq:
                routes[eid] = make_route(r.eng, r.visits())
        return Plan(routes=routes, unassigned=list(self.pool), pinned=self.p.pinned,
                    duration_factor=self.p.duration_factor, stock=self.p.stock)


def solve(day: Day, params: Params | None = None, seed: int = 0,
          time_limit: float | None = None, report: dict | None = None) -> Plan:
    p = params or Params()
    if time_limit is not None:
        p.lns_seconds = time_limit
    rng = random.Random(seed)

    sol = _Solution(day, p)
    sol.pool = list(day.orders)
    sol.recreate()

    best = sol.clone()
    best_obj = best.objective()
    cur_obj = best_obj

    deadline = time.time() + p.lns_seconds
    budget = p.lns_iterations
    temperature = START_TEMPERATURE
    iterations = 0
    accepted = 0

    while (iterations < budget) if budget is not None else (time.time() < deadline):
        cand = sol.clone()
        cand.ruin(rng, rng.randint(p.ruin_min, p.ruin_max))
        cand.recreate(rng)
        obj = cand.objective()
        iterations += 1

        take = False
        if obj < cur_obj:
            take = True
        elif obj[:2] == cur_obj[:2]:
            # Отжиг ухудшает только стоимость и только внутри своего
            # уровня — см. тот же участок в improved.py.
            delta = obj[2] - cur_obj[2]
            if delta < temperature * -math.log(max(rng.random(), 1e-9)):
                take = True

        if take:
            sol, cur_obj = cand, obj
            accepted += 1
            if obj < best_obj:
                best, best_obj = cand.clone(), obj

        temperature = max(1.0, temperature * COOLING)

    if report is not None:
        report["iterations"] = iterations
        report["accepted"] = accepted
        report["objective"] = best_obj

    # План проверяет себя сам, до того как уйти из солвера. Тогда его не
    # надо не забыть проверить снаружи: доводка расписания, потолок смен
    # и подобранный план прежде строились без инвариантов вовсе.
    return require_valid(best.to_plan(), day, "план солвера невалиден")
