"""
Точный оптимум и нижняя граница разрыва.

«Наш план хуже оптимума на столько-то» — единственная фраза, которая
доказывает качество солвера, а не просто его превосходство над жадным.
Для этого нужен оптимум, а не ещё одна эвристика.

Здесь задача выписывается как смешанно-целочисленная программа и
решается HiGHS через scipy. На двадцати заявках оптимум доказывается за
секунды; на больших днях решатель не успевает, но возвращает **dual
bound** — доказанную верхнюю границу. Разрыв до неё честнее, чем разрыв
до неизвестного оптимума: настоящий оптимум лежит между нашим решением
и этой границей, поэтому измеренный разрыв — оценка сверху.

Одна оговорка, без которой сравнение было бы нечестным. В стенде время
в пути зависит от часа выезда, а в линейной программе такая зависимость
невыразима. Поэтому обе стороны — и MILP, и наш планировщик — решают
задачу на «замороженной» сети, где время в пути взято для 13:00.
Сравниваются два решения одной задачи, а не разных.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from scipy.optimize import LinearConstraint, milp
from scipy.sparse import coo_matrix

from .core.domain import Day, Plan, too_far
from .core.generate import generate_day

FROZEN_HOUR = 13 * 60


class FrozenNetwork:
    """Дорожная сеть с временем в пути, взятым для одного часа."""

    def __init__(self, net, at_minute: int = FROZEN_HOUR):
        self._net = net
        self._at = at_minute
        self.nodes = net.nodes
        # Солвер заглядывает сюда для географической кластеризации в ruin.
        self._matrices = net._matrices

    def travel_minutes(self, a: int, b: int, depart_minute: int,
                       transport: str = "car") -> float:
        # Транспорт пробрасывается дальше, час — заморожен. Третья
        # реализация сети в проекте, и про неё легко забыть: когда
        # транспорт добавляли, забыли именно про неё, и `optimumbench`
        # упал на пятьдесят девятой минуте перегенерации замеров.
        return self._net.travel_minutes(a, b, self._at, transport)

    def road_km_between(self, a: int, b: int) -> float:
        return self._net.road_km_between(a, b)

    def nearest_node(self, lat: float, lon: float) -> int:
        return self._net.nearest_node(lat, lon)

    def path_nodes(self, a: int, b: int, depart_minute: int):
        return self._net.path_nodes(a, b, self._at)


def freeze(day: Day) -> Day:
    """Копия дня с замороженной сетью."""
    import copy

    frozen = copy.copy(day)
    frozen.network = FrozenNetwork(day.network)
    return frozen


@dataclass
class ExactResult:
    assigned: int          # сколько заявок разместил MILP
    bound: float           # доказанная верхняя граница
    proven: bool           # оптимум доказан?
    seconds: float
    orders: int
    engineers: int


def solve_exact(day: Day, time_limit: float = 60.0) -> ExactResult:
    """
    Максимальное число размещаемых заявок как MILP.

    Переменные:
      x[k,i,j] — инженер k едет из i в j (0 — его дом, 1..n — заявки);
      y[k,i]   — инженер k обслуживает заявку i;
      t[i]     — время начала обслуживания заявки i.

    Целевая: максимум суммы y. Связь времени и маршрута — обычные
    ограничения с большой константой: если инженер поехал из i в j, то
    начать j он может не раньше, чем закончил i и доехал.

    Формулировка написана так, чтобы решателю было что доказывать. В
    наивном виде она этого не позволяла: на полном дне HiGHS находил
    единицы визитов и не двигал верхнюю границу. Три вещи, каждая из
    которых ничего не меняет в оптимуме, но резко сужает поиск.

    **Мёртвые дуги не создаются.** Переменная заводится, только если
    инженер владеет нужным навыком в обоих концах дуги и по этой дуге
    вообще можно успеть: выехав в самое раннее допустимое время из i,
    попасть в окно j. На дне из 80 заявок это выбрасывает три четверти
    из восьмидесяти тысяч переменных.

    **Большая константа своя у каждой дуги.** Была одна на всех, в двое
    суток; настоящая нужная величина — насколько ограничение может быть
    нарушено в худшем случае, то есть `конец окна i + длительность +
    дорога − начало окна j`. Обычно это три-десять часов вместо сорока
    восьми. Именно на этот множитель и была разболтана линейная
    релаксация — а по ней решатель и судит, насколько он далёк от
    оптимума.

    **Ёмкость смены записана явно.** Её не было вовсе: осуществимость
    держалась на цепочке временных ограничений, а дробное решение
    удовлетворяет их почти даром. Работа и дорога не пересекаются во
    времени и обе укладываются в смену, поэтому сумма длительностей плюс
    минимальный подъезд к каждой заявке не может превысить смену.

    **Ёмкость по интервалам времени.** Того же самого мало: узкое место
    дня не в сумме за смену, а в том, что весь вечерний спрос приходится
    на те несколько часов, когда почти никто уже не работает. Поэтому для
    каждого интервала суток отдельно считается, сколько минут работы он
    обязан вместить и сколько человеко-минут смен в нём открыто. Подробно
    — у пятого блока ограничений.
    """
    t0 = time.time()
    net = day.network
    orders = day.orders
    engineers = day.engineers
    n, m = len(orders), len(engineers)

    def node_of(k: int, i: int) -> int:
        return engineers[k].home_node if i == 0 else orders[i - 1].node

    # --- время в пути ---
    travel = np.zeros((m, n + 1, n + 1))
    for k in range(m):
        for i in range(n + 1):
            for j in range(n + 1):
                if i != j:
                    travel[k, i, j] = net.travel_minutes(node_of(k, i), node_of(k, j),
                                                         FROZEN_HOUR,
                                                         engineers[k].transport)

    # --- какие заявки кому вообще доступны ---
    servable: list[set[int]] = []
    for k, eng in enumerate(engineers):
        ok = set()
        for i, order in enumerate(orders, start=1):
            if not eng.can_do(order):
                continue
            # Перегон от офиса не по силам транспорту — заявка ему
            # недоступна, как если бы не хватало навыка.
            if too_far(net, node_of(k, 0), order.node, eng.transport):
                continue
            # Успеть доехать из дома до закрытия окна и закончить в смену.
            if eng.shift_start + travel[k, 0, i] > order.window_end:
                continue
            if max(order.window_start, eng.shift_start + travel[k, 0, i]) \
                    + order.est_minutes > eng.shift_end:
                continue
            ok.add(i)
        servable.append(ok)

    # --- какие дуги имеют смысл ---
    def arc_alive(k: int, i: int, j: int) -> bool:
        if i == j:
            return False
        # Дуга длиннее того, на что годится транспорт. Это такая же
        # мёртвая дуга, как та, по которой не успеть в окно: без этого
        # точная модель считала бы доступным то, чего планировщику не
        # разрешено, и её граница была бы завышена.
        if too_far(net, node_of(k, i), node_of(k, j), engineers[k].transport):
            return False
        if i != 0 and i not in servable[k]:
            return False
        if j != 0 and j not in servable[k]:
            return False
        if i == 0 and j == 0:
            return False
        if j == 0:
            return True                      # возврат домой ничем не ограничен
        earliest = (engineers[k].shift_start if i == 0
                    else orders[i - 1].window_start + orders[i - 1].est_minutes)
        return earliest + travel[k, i, j] <= orders[j - 1].window_end

    arcs: list[list[tuple[int, int]]] = []
    for k in range(m):
        arcs.append([(i, j) for i in range(n + 1) for j in range(n + 1)
                     if arc_alive(k, i, j)])

    # --- индексация переменных ---
    idx: dict[tuple, int] = {}

    def var(*key) -> int:
        if key not in idx:
            idx[key] = len(idx)
        return idx[key]

    for k in range(m):
        for i, j in arcs[k]:
            var("x", k, i, j)
        for i in sorted(servable[k]):
            var("y", k, i)
    for i in range(1, n + 1):
        var("t", i)

    n_vars = len(idx)
    has = idx.__contains__

    rows_ub, cols_ub, vals_ub, b_ub = [], [], [], []
    rows_eq, cols_eq, vals_eq, b_eq = [], [], [], []

    def add_ub(terms, rhs):
        r = len(b_ub)
        for c, v in terms:
            rows_ub.append(r); cols_ub.append(c); vals_ub.append(v)
        b_ub.append(rhs)

    def add_eq(terms, rhs):
        r = len(b_eq)
        for c, v in terms:
            rows_eq.append(r); cols_eq.append(c); vals_eq.append(v)
        b_eq.append(rhs)

    # 1. Заявку обслуживают не более одного раза.
    for i in range(1, n + 1):
        terms = [(idx[("y", k, i)], 1.0) for k in range(m) if i in servable[k]]
        if terms:
            add_ub(terms, 1.0)

    # 2. Поток: у обслуженной заявки ровно одна входящая и одна исходящая дуга.
    for k in range(m):
        for i in sorted(servable[k]):
            add_eq([(idx[("x", k, j, i)], 1.0) for j in range(n + 1)
                    if has(("x", k, j, i))] + [(idx[("y", k, i)], -1.0)], 0.0)
            add_eq([(idx[("x", k, i, j)], 1.0) for j in range(n + 1)
                    if has(("x", k, i, j))] + [(idx[("y", k, i)], -1.0)], 0.0)

        out_home = [(idx[("x", k, 0, j)], 1.0) for j in range(1, n + 1)
                    if has(("x", k, 0, j))]
        back_home = [(idx[("x", k, i, 0)], -1.0) for i in range(1, n + 1)
                     if has(("x", k, i, 0))]
        if out_home:
            add_ub(out_home, 1.0)             # выезжает не более одного раза
            add_eq(out_home + back_home, 0.0)  # и возвращается

        # 3. Ёмкость смены: работа и дорога не пересекаются во времени и обе
        #    укладываются в смену. У каждой обслуженной заявки есть хотя бы
        #    один подъезд, дешевле минимального он быть не может.
        shift = engineers[k].shift_end - engineers[k].shift_start
        cap = []
        for i in sorted(servable[k]):
            incoming = [travel[k, j, i] for j in range(n + 1) if has(("x", k, j, i))]
            weight = orders[i - 1].est_minutes + (min(incoming) if incoming else 0.0)
            cap.append((idx[("y", k, i)], float(weight)))
        if cap:
            add_ub(cap, float(shift))

    # 4. Время. Поехал из i в j — начать j не раньше, чем закончил i и доехал.
    #    Большая константа у каждой дуги своя: ровно настолько ограничение
    #    может быть нарушено при выключенной переменной, и ни минутой больше.
    for k in range(m):
        for i, j in arcs[k]:
            if j == 0:
                continue
            if i == 0:
                # t[j] >= shift_start + travel
                big = max(0.0, engineers[k].shift_start + travel[k, 0, j]
                          - orders[j - 1].window_start)
                add_ub([(idx[("t", j)], -1.0), (idx[("x", k, 0, j)], big)],
                       big - engineers[k].shift_start - travel[k, 0, j])
            else:
                dur_i = orders[i - 1].est_minutes
                big = max(0.0, orders[i - 1].window_end + dur_i + travel[k, i, j]
                          - orders[j - 1].window_start)
                add_ub([(idx[("t", i)], 1.0), (idx[("t", j)], -1.0),
                        (idx[("x", k, i, j)], big)],
                       big - dur_i - travel[k, i, j])

        # Смена должна успеть закрыться.
        for i in sorted(servable[k]):
            dur_i = orders[i - 1].est_minutes
            big = max(0.0, orders[i - 1].window_end + dur_i - engineers[k].shift_end)
            if big > 0:
                add_ub([(idx[("t", i)], 1.0), (idx[("y", k, i)], big)],
                       big + engineers[k].shift_end - dur_i)

    # 5. Энергетическое отсечение по интервалам времени.
    #
    #    Диагностика полного дня: в окно 17–21 приходит 24 часа работы, а
    #    смен в это время открыто 7 часов. Отношение три с половиной — вот
    #    настоящее узкое место дня. Линейная релаксация о нём не знала
    #    ничего: её граница просто равнялась числу заявок, доступных хоть
    #    кому-нибудь.
    #
    #    Рассуждение простое. Заявку обслуживают непрерывно `dur` минут,
    #    начиная где-то внутри её окна. Значит внутри любого интервала
    #    [a, b] она обязана занять хотя бы столько минут, сколько остаётся
    #    при самом удобном сдвиге — минимум по двум крайним положениям
    #    старта. Сумма этих минут по обслуженным заявкам не может
    #    превысить того, сколько человеко-минут смен вообще открыто в
    #    [a, b]. Дорога сюда не входит, поэтому отсечение заведомо
    #    валидно: с ней ограничение было бы только жёстче.
    bounds_grid = [h * 60 for h in range(7, 22)]
    for ai, a in enumerate(bounds_grid):
        for b in bounds_grid[ai + 1:]:
            capacity = sum(max(0, min(e.shift_end, b) - max(e.shift_start, a))
                           for e in engineers)
            need_of: dict[int, float] = {}
            for i, order in enumerate(orders, start=1):
                dur = order.est_minutes

                def overlap(start: int) -> int:
                    return max(0, min(start + dur, b) - max(start, a))

                need = min(overlap(order.window_start), overlap(order.window_end))
                if need > 0:
                    need_of[i] = float(need)

            if not need_of:
                continue

            # Общее по бригаде.
            add_ub([(idx[("y", k, i)], need)
                    for i, need in need_of.items()
                    for k in range(m) if i in servable[k]], float(capacity))

            # И то же самое по каждому инженеру отдельно. Это строго
            # сильнее: общая версия получается их суммой, но сама по себе
            # разрешает дробному решению «сложить» вечер в одного
            # человека, которого в это время на смене нет.
            for k, eng in enumerate(engineers):
                own = max(0, min(eng.shift_end, b) - max(eng.shift_start, a))
                terms = [(idx[("y", k, i)], need)
                         for i, need in need_of.items() if i in servable[k]]
                if terms:
                    add_ub(terms, float(own))

    A_ub = coo_matrix((vals_ub, (rows_ub, cols_ub)), shape=(len(b_ub), n_vars))
    A_eq = coo_matrix((vals_eq, (rows_eq, cols_eq)), shape=(len(b_eq), n_vars))

    # --- границы переменных и целочисленность ---
    lo = np.zeros(n_vars)
    hi = np.ones(n_vars)
    integrality = np.ones(n_vars)
    for i, order in enumerate(orders, start=1):
        v = idx[("t", i)]
        lo[v] = order.window_start
        hi[v] = order.window_end
        integrality[v] = 0

    # --- целевая: максимум размещённых заявок ---
    c = np.zeros(n_vars)
    for k in range(m):
        for i in servable[k]:
            c[idx[("y", k, i)]] = -1.0

    res = milp(
        c=c,
        constraints=[LinearConstraint(A_ub, -np.inf, np.array(b_ub)),
                     LinearConstraint(A_eq, np.array(b_eq), np.array(b_eq))],
        integrality=integrality,
        bounds=(lo, hi),
        options={"time_limit": time_limit, "disp": False},
    )

    elapsed = time.time() - t0
    if res.x is None:
        return ExactResult(0, float(n), False, elapsed, n, m)

    assigned = int(round(-res.fun))
    bound = -res.mip_dual_bound if res.mip_dual_bound is not None else float(n)
    return ExactResult(
        assigned=assigned,
        bound=bound,
        proven=abs(bound - assigned) < 1e-6,
        seconds=elapsed,
        orders=n,
        engineers=m,
    )


def small_day(seed: int, n_orders: int, n_engineers: int, network=None) -> Day:
    """Уменьшенный день: те же правила, меньше масштаб."""
    day = generate_day(seed=seed, n_orders=n_orders, n_engineers=n_engineers,
                       network=network)
    return freeze(day)
