"""
Подбор расписания смен под дневной спрос.

Замер показал, что расстановка смен даёт больше, чем сам алгоритм
маршрутизации (+9,8 против +8,0 пункта покрытия). Там профили были
заданы руками; здесь они подбираются.

Перебирать расписания настоящим солвером слишком дорого — один прогон
занимает секунды, а вариантов у двенадцати инженеров и семи возможных
стартов больше тринадцати миллиардов. Поэтому работа идёт в два этапа:

  1. Дешёвый прокси. Спрос размазывается по окну: заявка на 60 минут с
     четырёхчасовым окном требует четверти инженера на протяжении всего
     окна. Предложение — кто в этот момент на смене. Недопокрытие
     считается по каждому навыку отдельно и по всем сразу (инженер с
     двумя навыками закрывает любой из них, но только один за раз).
     Оценка одного расписания — доли миллисекунды.

  2. Верификация. Лучшие кандидаты прогоняются настоящим солвером с
     симуляцией — прокси решает, что стоит проверять, а не что верно.

Оптимизатор видит только оценки длительности и окна: это то, что знает
диспетчер, составляя график на завтра.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

import numpy as np

from .core.domain import Day, Engineer

# Сетка времени, минут.
STEP = 30
GRID_START = 6 * 60
GRID_END = 22 * 60
N_SLOTS = (GRID_END - GRID_START) // STEP

SHIFT_LEN = 9 * 60
# Допустимые часы выхода. Позже 12:00 нельзя: смена уйдёт за 21:00,
# после которого инженер не работает ни при каких условиях.
ALLOWED_STARTS = [7, 8, 9, 10, 11, 12]

# Дорога съедает время сверх самой работы. Отношение взято из замера:
# 18,4 часа дороги на 58,8 часа работы.
TRAVEL_OVERHEAD = 1.31


def _slot(minute: int) -> int:
    return max(0, min(N_SLOTS - 1, (minute - GRID_START) // STEP))


def demand_curve(day: Day) -> dict[str, np.ndarray]:
    """
    Сколько инженеров каждого навыка нужно в каждый момент дня.

    Заявка размазывается ровно по своему окну: планировщик волен
    поставить её в любую минуту внутри, поэтому спрос она создаёт по
    всей ширине.
    """
    skills = {o.skill for o in day.orders}
    curves = {s: np.zeros(N_SLOTS) for s in skills}

    for order in day.orders:
        lo, hi = _slot(order.window_start), _slot(order.window_end)
        if hi <= lo:
            hi = lo + 1
        need = order.est_minutes * TRAVEL_OVERHEAD / ((hi - lo) * STEP)
        curves[order.skill][lo:hi] += need

    return curves


def supply_curves(engineers: list[Engineer], starts: list[int],
                  skills: list[str]) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Кто на смене в каждый момент: по каждому навыку и всего."""
    per_skill = {s: np.zeros(N_SLOTS) for s in skills}
    total = np.zeros(N_SLOTS)

    for eng, start_hour in zip(engineers, starts):
        lo = _slot(start_hour * 60)
        hi = _slot(start_hour * 60 + SHIFT_LEN)
        total[lo:hi] += 1
        for s in eng.skills:
            if s in per_skill:
                per_skill[s][lo:hi] += 1

    return per_skill, total


def undercoverage(demand: dict[str, np.ndarray], engineers: list[Engineer],
                  starts: list[int]) -> float:
    """
    Непокрытый спрос в человеко-часах — то, что минимизируем.

    Две границы снизу, берётся худшая по каждому моменту:
      · по навыку   — спрос на навык минус те, кто им владеет;
      · суммарная   — весь спрос минус все, кто на смене, потому что
                      инженер с двумя навыками закрывает только один
                      из них за раз.
    """
    skills = list(demand)
    per_skill, total = supply_curves(engineers, starts, skills)

    by_skill = np.zeros(N_SLOTS)
    all_demand = np.zeros(N_SLOTS)
    for s in skills:
        by_skill = np.maximum(by_skill, demand[s] - per_skill[s])
        all_demand += demand[s]

    gap = np.maximum(np.maximum(by_skill, all_demand - total), 0.0)
    return float(gap.sum() * STEP / 60)


@dataclass
class ShiftPlan:
    starts: list[int]
    gap_hours: float

    def profile(self) -> dict[int, int]:
        """Сколько человек выходит в каждый час — для диспетчера."""
        out: dict[int, int] = {}
        for h in sorted(self.starts):
            out[h] = out.get(h, 0) + 1
        return out

    def describe(self) -> str:
        parts = [f"{h}:00 — {n} чел." for h, n in sorted(self.profile().items())]
        return "; ".join(parts)


def optimize(day: Day, restarts: int = 12, seed: int = 0) -> ShiftPlan:
    """
    Локальный поиск по стартам смен.

    Навыки инженеров не трогаем — это живые люди с их квалификацией.
    Меняется только час выхода. На каждом шаге ищется перестановка
    одного инженера, дающая наибольшее снижение непокрытого спроса;
    поиск повторяется из разных случайных начальных точек.
    """
    rng = random.Random(seed)
    demand = demand_curve(day)
    engineers = day.engineers
    n = len(engineers)

    best_starts: list[int] | None = None
    best_gap = float("inf")

    for r in range(restarts):
        if r == 0:
            starts = [e.shift_start // 60 for e in engineers]
        else:
            starts = [rng.choice(ALLOWED_STARTS) for _ in range(n)]

        gap = undercoverage(demand, engineers, starts)

        improved = True
        while improved:
            improved = False
            for i in range(n):
                current = starts[i]
                for h in ALLOWED_STARTS:
                    if h == current:
                        continue
                    starts[i] = h
                    g = undercoverage(demand, engineers, starts)
                    if g < gap - 1e-9:
                        gap, current, improved = g, h, True
                    else:
                        starts[i] = current
                starts[i] = current

        if gap < best_gap:
            best_gap, best_starts = gap, list(starts)

    return ShiftPlan(starts=best_starts, gap_hours=best_gap)


def refine(day: Day, starts: list[int], solver_seed: int = 0, sim_seed: int = 0,
           rounds: int = 2, neighbours_only: bool = True,
           lns_iterations: int = 300, runs: int = 120,
           min_gain: float = 0.3) -> tuple[list[int], float]:
    """
    Доводка расписания настоящим солвером.

    Прокси размазывает спрос по времени, но ничего не знает о географии:
    он не видит, что инженер не может быть в двух районах сразу, и что
    солвер уплотняет маршруты. Замер показал, что из-за этого прокси
    недобирает около четырёх пунктов покрытия, причём выигрыш переносится
    на независимые прогоны симуляции — то есть он настоящий, а не подгонка.

    Поэтому от прокси-решения делается локальный подъём, где каждый шаг
    оценивается настоящим солвером. Дорого, но это планирование графика
    на завтра, а не реакция на срочную заявку.

    Оценка идёт на одном наборе прогонов (`sim_seed`); проверять результат
    следует на другом, иначе подъём подгонит расписание под конкретные
    случайные числа.

    Бюджет солвера здесь задан в шагах, а не в секундах. Расписание
    попадает в выгрузку для интерфейса, а по секундам две сборки на одной
    машине давали разные рекомендации — на быстрой она успевала больше
    шагов. Триста шагов — это те же полторы секунды, но одинаковые у всех.
    """
    from .core.simulate import monte_carlo
    from .solvers import fast, improved

    params = improved.Params(lns_seconds=0.0, lns_iterations=lns_iterations)

    def score(candidate: list[int]) -> float:
        d = apply(day, candidate)
        plan = fast.solve(d, params=params, seed=solver_seed)
        return monte_carlo(d, plan, runs=runs, seed=sim_seed).coverage * 100

    starts = list(starts)
    best = score(starts)

    for _ in range(rounds):
        moved = False
        for i in range(len(starts)):
            if neighbours_only:
                options = [h for h in (starts[i] - 1, starts[i] + 1) if h in ALLOWED_STARTS]
            else:
                options = [h for h in ALLOWED_STARTS if h != starts[i]]

            for h in options:
                trial = list(starts)
                trial[i] = h
                s = score(trial)
                if s > best + min_gain:
                    best, starts, moved = s, trial, True

        if not moved:
            break

    return starts, best


def apply(day: Day, starts: list[int]) -> Day:
    """
    Копия дня с новым расписанием смен. Заявки те же.

    Смена, кончающаяся позже 21:00, отвергается здесь, а не всплывает
    потом нарушением инварианта в плане: после этого часа инженер не
    работает ни при каких условиях, и расписание, которое это допускает,
    просто неверно. Раньше такой профиль существовал — ручной «веер»
    сажал последнего инженера на смену до 22:00.
    """
    import copy

    from .core.domain import DAY_HARD_END

    late = [h for h in starts if h * 60 + SHIFT_LEN > DAY_HARD_END]
    if late:
        raise ValueError(
            f"смена с началом в {late[0]}:00 кончается позже "
            f"{DAY_HARD_END // 60}:00 — так работать нельзя")

    new = copy.copy(day)
    new.engineers = []
    for eng, h in zip(day.engineers, starts):
        e = copy.copy(eng)
        e.shift_start = h * 60
        e.shift_end = h * 60 + SHIFT_LEN
        new.engineers.append(e)
    return new
