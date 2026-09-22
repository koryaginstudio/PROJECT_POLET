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
EARLIEST_START = 7

# Допустимые часы выхода — не самостоятельная константа, а следствие
# длины смены и границы дня: позже 12:00 девятичасовая смена уйдёт за
# 21:00, после которого инженер не работает.
#
# Пока граница была константой модуля, список тоже был константой. У
# заказчика окна доходят до 22:00, граница стала полем дня, и список
# теперь считается от него — `allowed_starts(day)`. Для синтетических
# дней он даёт ровно прежние [7…12], поэтому все снятые числа в силе.
# Сама константа `ALLOWED_STARTS` убрана: она дожила в `shiftbench` и на
# зоне не дала бы случайному расписанию выход в 13:00 никогда.


def shift_len_of(engineer: Engineer, shift_len: int | None) -> int:
    """
    Длина смены инженера.

    `shift_len` числом — навязать всем одну длину, как было всегда.
    `None` — оставить каждому его собственную: у заказчика есть
    частичные ставки, и превращать восьмичасовую смену в девятичасовую
    ради удобства перебора было бы подлогом.
    """
    return shift_len if shift_len is not None else engineer.shift_end - engineer.shift_start


def allowed_starts(day: Day, shift_len: int | None = SHIFT_LEN,
                   engineer: Engineer | None = None) -> list[int]:
    """Часы выхода, при которых смена укладывается в границу дня."""
    length = SHIFT_LEN if shift_len is None and engineer is None else (
        shift_len_of(engineer, shift_len) if engineer is not None else shift_len)
    last = (day.hard_end - length) // 60
    return list(range(EARLIEST_START, last + 1))

# Дорога съедает время сверх самой работы. Отношение взято из замера:
# 18,4 часа дороги на 58,8 часа работы.
TRAVEL_OVERHEAD = 1.31


def _slot(minute: int) -> int:
    """Слот, в котором лежит минута: начало отрезка, включительно."""
    return max(0, min(N_SLOTS - 1, (minute - GRID_START) // STEP))


def _slot_end(minute: int) -> int:
    """Исключающая верхняя граница среза для минуты, которой отрезок кончается.

    Отдельно от `_slot` нарочно. Тот зажимает к `N_SLOTS - 1` — для начала
    верно, но как конец среза `[lo:hi]` это выбрасывало последний слот: у
    заказчика окна и смены кончаются в 22:00, честный индекс 32, зажим
    давал 31, и слот 21:30–22:00 не заполнялся никогда. На графике «спрос
    против рук» вечер обрывался нулём по обеим линиям в час, когда четверо
    работают и восемь окон открыты, — а подбор смен, который оптимизирует
    по этой же кривой, был слеп ровно на границе дня заказчика.

    На синтетике зажим не срабатывал ни разу: там всё кончается в 21:00,
    индекс 30, и обе функции дают одно и то же. Все границы в данных
    кратны шагу сетки (проверено на трёх зонах и синтетике), поэтому
    `//` здесь точен и никакого округления вверх не нужно.
    """
    return max(0, min(N_SLOTS, (minute - GRID_START) // STEP))


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
        lo, hi = _slot(order.window_start), _slot_end(order.window_end)
        if hi <= lo:
            hi = lo + 1
        need = order.est_minutes * TRAVEL_OVERHEAD / ((hi - lo) * STEP)
        curves[order.skill][lo:hi] += need

    return curves


def supply_curves(engineers: list[Engineer], starts: list[int],
                  skills: list[str], shift_len: int | None = SHIFT_LEN
                  ) -> tuple[dict[str, np.ndarray], np.ndarray]:
    """Кто на смене в каждый момент: по каждому навыку и всего."""
    per_skill = {s: np.zeros(N_SLOTS) for s in skills}
    total = np.zeros(N_SLOTS)

    for eng, start_hour in zip(engineers, starts):
        lo = _slot(start_hour * 60)
        hi = _slot_end(start_hour * 60 + shift_len_of(eng, shift_len))
        total[lo:hi] += 1
        for s in eng.skills:
            if s in per_skill:
                per_skill[s][lo:hi] += 1

    return per_skill, total


def undercoverage(demand: dict[str, np.ndarray], engineers: list[Engineer],
                  starts: list[int], shift_len: int | None = SHIFT_LEN) -> float:
    """
    Непокрытый спрос в человеко-часах — то, что минимизируем.

    Две границы снизу, берётся худшая по каждому моменту:
      · по навыку   — спрос на навык минус те, кто им владеет;
      · суммарная   — весь спрос минус все, кто на смене, потому что
                      инженер с двумя навыками закрывает только один
                      из них за раз.
    """
    skills = list(demand)
    per_skill, total = supply_curves(engineers, starts, skills, shift_len)

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


def optimize(day: Day, restarts: int = 12, seed: int = 0,
             shift_len: int | None = SHIFT_LEN) -> ShiftPlan:
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

    # Допустимые часы выхода у каждого свои, если длина смены своя:
    # восьмичасовая смена может начаться на час позже девятичасовой и
    # всё равно закончиться до границы дня.
    allowed = [allowed_starts(day, shift_len, e) for e in engineers]

    best_starts: list[int] | None = None
    best_gap = float("inf")

    for r in range(restarts):
        if r == 0:
            # Текущее расписание — начальная точка. Его надо прижать к
            # допустимым: у заказчика инженер может выходить в 14:00, а
            # с навязанной длиной смены такой старт уже незаконен.
            starts = [min(max(e.shift_start // 60, allowed[i][0]), allowed[i][-1])
                      for i, e in enumerate(engineers)]
        else:
            starts = [rng.choice(allowed[i]) for i in range(n)]

        gap = undercoverage(demand, engineers, starts, shift_len)

        improved = True
        while improved:
            improved = False
            for i in range(n):
                current = starts[i]
                for h in allowed[i]:
                    if h == current:
                        continue
                    starts[i] = h
                    g = undercoverage(demand, engineers, starts, shift_len)
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
           min_gain: float = 0.3, km_gain: float = 5.0,
           shift_len: int | None = SHIFT_LEN,
           objective: str = "тз") -> tuple[list[int], float]:
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

    if objective not in ("тз", "покрытие"):
        raise ValueError(f"objective={objective!r}; бывает «тз» или «покрытие»")

    allowed = [allowed_starts(day, shift_len, e) for e in day.engineers]

    def score(candidate: list[int]) -> tuple[float, int, float]:
        """Покрытие, число задействованных исполнителей, пробег."""
        d = apply(day, candidate, shift_len)
        plan = fast.solve(d, params=params, seed=solver_seed)
        cov = monte_carlo(d, plan, runs=runs, seed=sim_seed).coverage * 100
        m = plan.metrics(d)
        return cov, m["engineers_used"], m["km_total"]

    def лучше(новый, текущий) -> bool:
        """
        Строго ли новое расписание лучше — в порядке, который задаёт ТЗ.

        «Выполнение всех заявок наименьшим количеством персонала» — это
        два уровня, а не один: сперва сделать работу, потом сделать её
        меньшим числом людей. Пробег — третий.

        Допуски обязательны. Покрытие приходит из симуляции и шумит,
        поэтому «не хуже» значит «в пределах `min_gain`», а не «больше
        или равно»: без этого подъём гонялся бы за случайными числами.
        Километры сравниваются с запасом `km_gain` по той же причине.
        """
        if objective == "покрытие":
            return новый[0] > текущий[0] + min_gain

        dc = новый[0] - текущий[0]
        if dc > min_gain:
            return True
        if dc < -min_gain:
            return False
        # Покрытие в пределах шума — решает число людей.
        if новый[1] != текущий[1]:
            return новый[1] < текущий[1]
        # Людей столько же — решает пробег.
        return текущий[2] - новый[2] > km_gain

    starts = list(starts)
    best = score(starts)

    for _ in range(rounds):
        moved = False
        for i in range(len(starts)):
            if neighbours_only:
                options = [h for h in (starts[i] - 1, starts[i] + 1) if h in allowed[i]]
            else:
                options = [h for h in allowed[i] if h != starts[i]]

            for h in options:
                trial = list(starts)
                trial[i] = h
                s = score(trial)
                if лучше(s, best):
                    best, starts, moved = s, trial, True

        if not moved:
            break

    # Наружу отдаём покрытие: так было всегда, и все четыре вызова
    # второе значение всё равно отбрасывают.
    return starts, best[0]


def apply(day: Day, starts: list[int], shift_len: int | None = SHIFT_LEN) -> Day:
    """
    Копия дня с новым расписанием смен. Заявки те же.

    Смена, кончающаяся позже 21:00, отвергается здесь, а не всплывает
    потом нарушением инварианта в плане: после этого часа инженер не
    работает ни при каких условиях, и расписание, которое это допускает,
    просто неверно. Раньше такой профиль существовал — ручной «веер»
    сажал последнего инженера на смену до 22:00.
    """
    import copy


    late = [(h, e) for h, e in zip(starts, day.engineers)
            if h * 60 + shift_len_of(e, shift_len) > day.hard_end]
    if late:
        raise ValueError(
            f"смена с началом в {late[0][0]}:00 кончается позже "
            f"{day.hard_end // 60}:00 — так работать нельзя")

    new = copy.copy(day)
    new.engineers = []
    for eng, h in zip(day.engineers, starts):
        e = copy.copy(eng)
        e.shift_start = h * 60
        e.shift_end = h * 60 + shift_len_of(eng, shift_len)
        new.engineers.append(e)
    return new
