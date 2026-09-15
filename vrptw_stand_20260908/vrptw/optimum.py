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

from .core.domain import Day, Plan
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

    def travel_minutes(self, a: int, b: int, depart_minute: int) -> float:
        return self._net.travel_minutes(a, b, self._at)

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
    """
    t0 = time.time()
    net = day.network
    orders = day.orders
    engineers = day.engineers
    n, m = len(orders), len(engineers)

    # --- индексация переменных ---
    idx: dict[tuple, int] = {}

    def var(*key) -> int:
        if key not in idx:
            idx[key] = len(idx)
        return idx[key]

    for k in range(m):
        for i in range(n + 1):
            for j in range(n + 1):
                if i != j:
                    var("x", k, i, j)
        for i in range(1, n + 1):
            var("y", k, i)
    for i in range(1, n + 1):
        var("t", i)

    n_vars = len(idx)

    # --- время в пути ---
    def node_of(k: int, i: int) -> int:
        return engineers[k].home_node if i == 0 else orders[i - 1].node

    travel = np.zeros((m, n + 1, n + 1))
    for k in range(m):
        for i in range(n + 1):
            for j in range(n + 1):
                if i != j:
                    travel[k, i, j] = net.travel_minutes(node_of(k, i), node_of(k, j), FROZEN_HOUR)

    BIG_M = 24 * 60 * 2

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

    # 1. Заявку обслуживают не более одного раза; без навыка — нельзя.
    for i in range(1, n + 1):
        add_ub([(var("y", k, i), 1.0) for k in range(m)], 1.0)
    for k, eng in enumerate(engineers):
        for i, order in enumerate(orders, start=1):
            if not eng.can_do(order):
                add_eq([(var("y", k, i), 1.0)], 0.0)

    # 2. Поток: у обслуженной заявки ровно одна входящая и одна исходящая дуга.
    for k in range(m):
        for i in range(1, n + 1):
            add_eq([(var("x", k, j, i), 1.0) for j in range(n + 1) if j != i]
                   + [(var("y", k, i), -1.0)], 0.0)
            add_eq([(var("x", k, i, j), 1.0) for j in range(n + 1) if j != i]
                   + [(var("y", k, i), -1.0)], 0.0)

        # Инженер выезжает из дома не более одного раза и возвращается.
        add_ub([(var("x", k, 0, j), 1.0) for j in range(1, n + 1)], 1.0)
        add_eq([(var("x", k, 0, j), 1.0) for j in range(1, n + 1)]
               + [(var("x", k, i, 0), -1.0) for i in range(1, n + 1)], 0.0)

    # 3. Время. Поехал из i в j — начать j не раньше, чем закончил i и доехал.
    for k in range(m):
        for i in range(1, n + 1):
            dur_i = orders[i - 1].est_minutes
            for j in range(1, n + 1):
                if i == j:
                    continue
                # t[i] + dur + travel - t[j] <= M (1 - x)
                add_ub([(var("t", i), 1.0), (var("t", j), -1.0),
                        (var("x", k, i, j), BIG_M)],
                       BIG_M - dur_i - travel[k, i, j])

            # Выезд из дома.
            add_ub([(var("t", i), -1.0), (var("x", k, 0, i), BIG_M)],
                   BIG_M - engineers[k].shift_start - travel[k, 0, i])

            # Смена должна успеть закрыться.
            add_ub([(var("t", i), 1.0), (var("y", k, i), BIG_M)],
                   BIG_M + engineers[k].shift_end - dur_i)

    A_ub = coo_matrix((vals_ub, (rows_ub, cols_ub)), shape=(len(b_ub), n_vars))
    A_eq = coo_matrix((vals_eq, (rows_eq, cols_eq)), shape=(len(b_eq), n_vars))

    # --- границы переменных и целочисленность ---
    lo = np.zeros(n_vars)
    hi = np.ones(n_vars)
    integrality = np.ones(n_vars)
    for i, order in enumerate(orders, start=1):
        v = var("t", i)
        lo[v] = order.window_start
        hi[v] = order.window_end
        integrality[v] = 0

    # --- целевая: максимум размещённых заявок ---
    c = np.zeros(n_vars)
    for k in range(m):
        for i in range(1, n + 1):
            c[var("y", k, i)] = -1.0

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
