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

from .core.domain import (DAY_HARD_END, EQUIPMENT, RESERVE_PER_TYPE, WORK_TYPES,
                          Day, Engineer, Order, Plan, equipment_sum)
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
    # Заявка -> инженер, который к ней уже едет. Её не перераспределяют:
    # человек в дороге, и развернуть его — решение диспетчера, а не
    # пересчёта. Инженер освобождается у этой заявки после её окончания.
    underway: dict[str, str] = field(default_factory=dict)
    # Заявка -> кто её выполнил. Нужно оборудованию: установленный роутер
    # из машины исполнителя ушёл.
    done_by: dict[str, str] = field(default_factory=dict)

    @property
    def pending_ids(self) -> list[str]:
        return [oid for ids in self.pending.values() for oid in ids]


def simulate_until(day: Day, plan: Plan, until: int, rng: random.Random) -> DayState:
    """
    Проиграть день до момента `until` и вернуть состояние.

    Визит, к которому инженер выехал до этого момента, доигрывается: он
    в дороге или уже на месте, и развернуть его — решение диспетчера, а
    не пересчёта. Тот же смысл, что у статуса «в пути» в журнале. Прежде
    доигрывался только начатый визит, а едущего к нему инженера пересчёт
    возвращал в точку выезда и отдавал визит другому. Всё, к чему он ещё
    не выехал, остаётся в плане и будет переназначено.
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

            # Выехал раньше `until` — значит, едет или уже на месте, и
            # визит его: доигрываем, как начатый.
            travel = net.travel_minutes(node, order.node, clock, eng.transport)
            factor = max(0.7, rng.lognormvariate(-0.5 * TRAVEL_SIGMA ** 2, TRAVEL_SIGMA))
            arrive = clock + int(round(travel * factor))
            start = max(arrive, order.window_start)

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
                state.done_by[order.id] = eng_id
                clock = start + dur

            if clock > eng.shift_end + MAX_OVERTIME or clock > day.hard_end:
                stopped = True

        state.position[eng_id] = (node, max(clock, until))
        state.pending[eng_id] = pending

    # Инженеры без маршрута стоят дома и свободны.
    for eng in day.engineers:
        state.position.setdefault(eng.id, (eng.home_node, max(eng.shift_start, until)))
        state.pending.setdefault(eng.id, [])

    return state


def carve_remainder(day: Day, state: DayState, extra: list[Order] | None = None,
                    drop: set[str] | None = None) -> Day:
    """
    Остаток дня как самостоятельная задача.

    Инженер начинает не из дома в 8 утра, а оттуда, где он сейчас, и с
    того момента, когда освободится. Заявки — те, к которым ещё не
    приступали, плюс новые; окна, которые уже закрылись, отброшены.

    `drop` — заявки, отменённые абонентом. Это одно из трёх событий
    пересчёта, которые называет ТЗ, и от двух других оно отличается
    знаком: выбытие инженера и срочная заявка отнимают ёмкость, отмена
    её возвращает. Отменённую заявку нельзя записывать в невыполненные —
    её никто и не просил выполнять.
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
        # На московской карте у узла свой почтовый адрес. У сети участка
        # узлы — точки заявок, офис и выездные точки, без улицы и дома:
        # прежде отсюда шло «None, None» в карточку инженера. Там адрес —
        # заявки в этой точке, а если он ещё не выехал — утренний.
        узел = net.nodes[node]
        if getattr(узел, "street", None) and getattr(узел, "house", None):
            e.home_address = узел.text
        elif node == eng.home_node:
            e.home_address = eng.home_address
        else:
            e.home_address = next((o.address for o in day.orders
                                   if o.node == node and o.address), None)
        e.shift_start = min(max(free_at, state.at), eng.shift_end)
        engineers.append(e)

    by_id = {o.id: o for o in day.orders}
    remaining = [by_id[oid] for oid in state.pending_ids]

    # Заявки, которых утренний план не вместил вовсе. Раньше они в
    # остаток не попадали, и пересчёт их не видел: освободилась ёмкость —
    # занять нечем, хотя работа стоит и окно ещё открыто. Диспетчер,
    # которому после отмены визита говорят «сделать больше нечего»,
    # справедливо решит, что система врёт.
    учтено = (set(state.pending_ids) | set(state.done) | set(state.failed)
              | set(state.underway))
    remaining += [o for o in day.orders if o.id not in учтено]

    if extra:
        remaining += extra
    if drop:
        remaining = [o for o in remaining if o.id not in drop]

    # Дубли: одна и та же заявка могла прийти и из журнала, и из дня.
    видели: set[str] = set()
    без_дублей = []
    for o in remaining:
        if o.id not in видели:
            видели.add(o.id)
            без_дублей.append(o)
    remaining = без_дублей

    # Окно закрылось — заявка на сегодня потеряна, что бы мы ни планировали.
    alive = [o for o in remaining if o.window_end > state.at]

    rest = copy.copy(day)
    rest.engineers = engineers
    rest.orders = alive
    return rest


def morning_kit(day: Day, plan: Plan,
                reserve: int = RESERVE_PER_TYPE) -> dict[str, dict[str, int]]:
    """
    Что каждый исполнитель везёт с утра: под свой маршрут и по штуке
    запаса каждого прибора.

    Так устроен базовый сценарий постановщика: «в начале дня старшие
    инженеры получили всё необходимое оборудование». Выдача считается от
    утреннего плана, а не от нынешнего: что утром не выдали, того в
    машине и нет, как бы потом ни перераспределяли.
    """
    out: dict[str, dict[str, int]] = {}
    for eng in day.engineers:
        route = plan.routes.get(eng.id)
        нужно = equipment_sum(v.order for v in route.visits) if route else {}
        out[eng.id] = {k: нужно.get(k, 0) + reserve for k in EQUIPMENT}
    return out


def stock_left(kit: dict[str, dict[str, int]], state: DayState,
               day: Day) -> dict[str, dict[str, int]]:
    """
    Что осталось в машине к моменту пересчёта: утренняя выдача минус
    установленное и минус то, что везут на заявку «в пути».

    Сорванный визит прибор не расходует — абонента не было, роутер
    остался в машине. Это и есть ограничение, которое обратная связь
    20 сентября просила учесть при перепланировании: заявку с роутером
    можно отдать только тому, у кого роутер ещё есть.
    """
    by_id = {o.id: o for o in day.orders}
    out = {eid: dict(v) for eid, v in kit.items()}
    расход = list(state.done_by.items()) + list(state.underway.items())
    for oid, eid in расход:
        order = by_id.get(oid)
        if order is None or eid not in out:
            continue
        for kind, n in order.equipment.items():
            out[eid][kind] = max(0, out[eid].get(kind, 0) - n)
    return out


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


def _минут_как_в_дне(day: Day, work) -> int:
    """Длительность подставной аварии — такая же, как у аварий этого дня.

    С 16 сентября длительности у данных заказчика берутся из норматива
    организаторов, а не из таблицы типов: у заказчика авария это 80 минут,
    в таблице — 55. Подставная авария, собранная по таблице, оказалась бы
    вдвое легче настоящих на том же дне, и замер реакции на ЧП мерил бы
    не то. Берём то, что чаще всего стоит у заявок этого дня с тем же
    навыком; если таких нет — свою оценку по типу работ.
    """
    свои = [o.est_minutes for o in day.orders if o.skill == work.skill]
    if not свои:
        return work.est_minutes
    return max(set(свои), key=свои.count)


# Сколько ближайших домов считать «участком» инженера, когда авария
# приходит на его трассу. Восемь — чтобы было из чего выбрать и чтобы это
# всё ещё были соседние дома, а не половина зоны.
NEAR_HOMES = 8


def urgent_orders(day: Day, at: int, count: int, seed: int,
                  near_node: int | None = None) -> list[Order]:
    """
    Аварии, поступившие в момент `at`.

    Окно открывается немедленно и длится три часа: у аварии нет
    «согласованного слота», её надо закрыть сегодня. Каждая минута
    задержки пересчёта — минус минута доступного времени, и именно это
    делает скорость реакции измеримой.

    Где. У московского пула адресов — район по весу и дом в районе, как
    было всегда. У сети зоны домов в большинстве московских районов нет, и
    прежде за таким районом вставал ближайший к его центру дом зоны: на
    юго-востоке 41 авария из 80 падала в один дом на краю участка, все 80 —
    в семь домов, а адрес у всех был «None, None»: у узлов сети зоны нет
    улицы и дома. Для зоны авария приходит в дом одной из заявок дня —
    туда, где её абоненты, — и адрес берётся у этой заявки. Офис и
    выездные точки в выбор не входят.

    `near_node` — точка, где сейчас инженер, на чьей трассе случилась
    авария («у кого на участке» в окне правки). Тогда дом — из
    `NEAR_HOMES` ближайших к ней по дороге домов заявок. За самим
    инженером авария не закрепляется: кто поедет — он или сосед, —
    решает пересчёт.
    """
    rng = random.Random(seed * 7919 + at)
    from .core.geo import DISTRICTS
    from .core.domain import WORK_TYPES

    # Тип работ для аварии. На синтетике это «Ремонт», и так было всегда.
    # Но у заказчика навыка «repair» нет вовсе — бригада умеет только
    # local, install и emergency, — и авария с таким типом не досталась бы
    # никому: шаг 5 сценария ТЗ («срочная заявка») молча показывал бы
    # вечно неназначенную заявку с причиной «нет навыка „Ремонт"».
    # Берём тип, который в этом дне действительно кто-то умеет, предпочитая
    # аварийный. На синтетике условие не срабатывает и всё как было.
    умеют: set[str] = set()
    for e in day.engineers:
        умеют |= e.skills
    тип = "repair"
    if WORK_TYPES[тип].skill not in умеют:
        аварийные = [k for k, w in WORK_TYPES.items()
                     if w.skill == "emergency" and w.skill in умеют]
        тип = аварийные[0] if аварийные else next(
            (k for k, w in WORK_TYPES.items() if w.skill in умеют), тип)

    net = day.network
    real_map = getattr(net, "has_addresses", False)
    полный_пул = real_map and all(net._by_district.get(d[0]) for d in DISTRICTS)
    # Дома зоны — это дома её заявок. В сети зоны есть ещё офис и выездные
    # точки, и у её узлов нет улицы и дома: адрес берётся у заявки.
    по_узлу: dict[int, Order] = {}
    for o in day.orders:
        по_узлу.setdefault(o.node, o)
    дома = sorted(по_узлу)
    ближние: list[int] = []
    if real_map and near_node is not None and дома:
        ближние = sorted((n for n in дома if n != near_node),
                         key=lambda n: (net.road_km_between(near_node, n), n))[:NEAR_HOMES]
    out: list[Order] = []
    weights = [d[3] for d in DISTRICTS]
    for i in range(count):
        if ближние or (real_map and not полный_пул and дома):
            заявка = по_узлу[rng.choice(ближние or дома)]
            node, lat, lon = заявка.node, заявка.lat, заявка.lon
            address, name = заявка.address, заявка.district
        else:
            name, dlat, dlon, _ = rng.choices(DISTRICTS, weights=weights)[0]
            if real_map:
                node, lat, lon, address = net.pick_address(name, rng)
            else:
                lat = dlat + rng.gauss(0, 0.012)
                lon = dlon + rng.gauss(0, 0.020)
                node, address = net.nearest_node(lat, lon), None
        start = at
        out.append(Order(
            id=f"U{i:02d}",
            work_type=тип,
            district=name,
            lat=lat,
            lon=lon,
            node=node,
            address=address,
            window_start=start,
            window_end=min(start + 180, day.hard_end),
            sla_deadline=min(start + 180, day.hard_end),
            hard_end=day.hard_end,
            priority=2,
            est_minutes=_минут_как_в_дне(day, WORK_TYPES[тип]),
        ))
    return out


def plan_as_is(rest: Day, state: DayState, duration_factor: float = 1.0) -> Plan:
    """
    «Едем как ехали» — исходный план, наложенный на остаток дня.

    Это поведение системы, которая не пересчитывает: инженер продолжает
    по вчерашнему маршруту. Визиты, в окно которых он из-за накопившихся
    задержек уже не попадает, просто не состоятся — их и отбрасываем,
    ровно как это произошло бы в жизни.

    Пропуск, а не обрыв — в этом отличие от `schedule_upto`. Солвер на
    первом невлезающем визите останавливается: дальше последовательность
    надо пересобирать. Здесь пересобирать некому, инженер пропускает
    закрытое окно и едет к следующему адресу.

    Правила осуществимости при этом те же, что у солвера и у инвариантов.
    Раньше их тут не было: визит строился без предела дальности перегона,
    без границы суток и без `duration_factor`, и пешеход в базисе «как
    ехали» проходил 19,8 км. Причём не только в лаборатории: пропуск
    визита склеивает два коротких перегона в один длинный, которого в
    исходном плане не было, — 2,4 + 1,8 км законных превращались в 3,5
    при пределе 3. Базис, с которым сравнивается выигрыш пересчёта, был
    физически неисполним, а `assigned_as_is` из него уходил на экран.
    """
    from .core.domain import Route, Visit, too_far

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
            # Перегон не по силам транспорту. После пропущенного визита
            # это обычное дело: два коротких перегона склеились в один.
            if too_far(net, node, order.node, eng.transport):
                continue

            travel = int(round(net.travel_minutes(node, order.node, clock, eng.transport)))
            arrive = clock + travel
            start = max(arrive, order.window_start)
            finish = start + int(round(order.est_minutes * duration_factor))

            if (start > order.window_end or finish > eng.shift_end
                    or finish > rest.hard_end):
                continue               # не успевает — визит выпадает

            visits.append(Visit(order=order, arrive=arrive, start=start,
                                finish=finish, travel=travel))
            placed.add(oid)
            clock, node = finish, order.node

        if visits:
            routes[eng.id] = Route(engineer=eng, visits=visits)

    return Plan(routes=routes,
                unassigned=[o for o in rest.orders if o.id not in placed],
                duration_factor=duration_factor)


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
