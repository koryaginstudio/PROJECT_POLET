"""
Улучшенный планировщик: regret-вставка + LNS (ruin & recreate).

Три отличия от жадного, каждое лечит свою болезнь:

1. Вставка в ЛЮБУЮ позицию маршрута, а не только в конец.
   Жадный идёт по дню слева направо и потому оставляет инженера
   простаивать между окнами. Здесь заявка садится туда, где она
   заполняет дыру.

2. Regret-2 вместо «первая попавшаяся».
   На каждом шаге выбираем не самую дешёвую заявку, а ту, которой
   дороже всего обойдётся ожидание: разницу между лучшей вставкой и
   второй лучшей. Заявки с одним-единственным местом размещаются
   первыми, пока это место свободно.

3. Буфер под неопределённость.
   Визит не ставится впритык к закрытию окна: чем он дальше по
   маршруту, тем больше накопленный риск опоздания и тем больший
   запас требуется. Это прямо снижает каскад missed_window.

Поверх этого — LNS: выбиваем часть заявок и пересобираем, много раз.

В стоимость маршрута входят ещё два слагаемых, выключенных нулём по
умолчанию: штраф за неравномерность загрузки (`balance_weight`) и штраф
за смену исполнителя при пересчёте внутри дня (`churn_penalty`).
Продакшен считает с ними, замеры из README — без них. Оба обязаны
совпадать с `fast.py` слагаемое в слагаемое: selfcheck сверяет две
реализации не только на нулевых штрафах, но и на каждом по отдельности,
и на обоих сразу.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass

from ..core.domain import Day, Engineer, Order, Plan
from .base import make_route, schedule, schedule_upto

# Комфортный запас до закрытия окна, минут. Ниже него визит считается
# рискованным и штрафуется в целевой функции.
COMFORT_SLACK = 40

# Сожаление заявки, для которой есть ровно одно место. Конечное, а не
# бесконечное: бесконечность не даёт рандомизировать порядок таких
# заявок между собой, а на маленьких днях именно они определяют весь план.
SINGLE_OPTION = 1e6

# Отжиг и выбивание: числа, по которым две реализации обязаны совпадать.
# Сверка на коротком бюджете такое расхождение не ловит — скорость
# охлаждения расходится заметно только через сотни итераций, — поэтому
# константы не дублируются, а живут в одном месте, и fast.py берёт их
# отсюда же.
START_TEMPERATURE = 30.0
COOLING = 0.9995
RUIN_GEO = 0.45        # доля случаев: географический кластер
RUIN_SEGMENT = 0.85    # до этой границы — кусок одного маршрута, дальше риск

# Рабочий прирост буфера до закрытия окна на каждый следующий визит.
# Значение живёт здесь одно на всех: раньше оно было продублировано по
# двум десяткам вызовов, и поменять его означало двадцать шансов
# промахнуться — при том, что правка этого числа по правилу «параметр
# меняет все замеры» требует перегенерации всего.
#
# Почему именно 16, хотя сетка `tune` на утренних сменах уверенно тянет
# вправо до 55. Буфер — это ставка против дефицита ёмкости, и правильный
# размер ставки зависит от расписания смен (`validate buffer`):
#
#   · когда работы заметно больше, чем рук (утренние смены), лишний визит
#     всё равно почти наверняка сорвётся, и выгоднее защищать уже
#     поставленные: буфер 45 даёт там +1,0 п.п.;
#   · когда рук хватает (веер, подобранные смены), маршруты длиннее,
#     `шаг · √позиция` на девятой позиции требует уже два часа запаса,
#     и буфер начинает вычёркивать визиты, которые прошли бы: тот же
#     буфер 45 стоит там −2,8 п.п.
#
# Компромисс структурный, а не свойство формулы: потолок над буфером его
# не снимает, а только двигает по той же кривой. Зато ниже 16 обе кривые
# плоские — от 0 до 22 всё внутри шума на обоих расписаниях. Поэтому взято
# 16: единственная точка, безопасная для обоих режимов. Продукт при этом
# ведёт клиента к подобранным сменам, а `buffer_step` вынесен в настройки
# компании — развёртывание, которое остаётся на утренних сменах, может
# поднять его само.
BUFFER_STEP = 16.0

# Рабочее значение штрафа за неравномерность. Подобрано замером
# (`balancebench`): дальше него Джини почти не улучшается, а покрытие
# не меняется ни при каком весе. По умолчанию поле остаётся нулевым,
# чтобы старые замеры воспроизводились визит в визит; продакшен-вызовы
# берут эту константу.
BALANCE_WEIGHT = 8.0


@dataclass
class Params:
    buffer_base: int = 0        # запас для первого визита в маршруте
    buffer_step: float = BUFFER_STEP   # прирост запаса на каждый следующий визит
    duration_factor: float = 1.0
    idle_weight: float = 0.35
    risk_weight: float = 0.6
    lns_seconds: float = 8.0

    # Второй режим бюджета: фиксированное число итераций LNS вместо
    # секунд на стене. Секунды — то, чем меряется продукт: в
    # диспетчерской важна задержка ответа. Но число, снятое по секундам,
    # зависит от машины и от того, что на ней ещё крутится, — на медленном
    # ноутбуке поиск успеет меньше и результат будет другим. Поэтому
    # замеры идут по итерациям: их столько же у всех, и цифра из README
    # воспроизводится у любого, кто скачал репозиторий. Заодно только
    # так две реализации солвера сравнимы при ненулевом бюджете.
    # Заполненное поле отменяет lns_seconds.
    lns_iterations: int | None = None

    ruin_min: int = 6
    ruin_max: int = 18

    # Пересчёт внутри дня: кому заявка была назначена до него.
    # Смена исполнителя штрафуется — инженер, которому уже сказали ехать,
    # не должен переназначаться ради минуты экономии. Ноль отключает.
    anchor: dict | None = None
    churn_penalty: float = 0.0

    # Равномерность загрузки. Штраф квадратичен по занятости маршрута
    # (работа + дорога, в часах), поэтому очередной визит тем дороже,
    # чем более загружен инженер. Ноль отключает — тогда решение
    # совпадает с прежним визит в визит.
    balance_weight: float = 0.0

    # Шум при пересборке в LNS, минут сожаления.
    #
    # Ruin & recreate работает, только если пересборка может дать не то
    # же самое, что и в прошлый раз. Пересборка детерминирована, поэтому
    # на маленьких днях, где выбивается весь план, все итерации
    # возвращали одно и то же решение — поиск вырождался в одну попытку.
    # На дне из 20 заявок это стоило целой заявки от оптимума.
    # Первая конструкция идёт без шума, чтобы результат при нулевом
    # бюджете оставался воспроизводимым.
    noise: float = 15.0

    def buffer_fn(self, position: int):
        return int(self.buffer_base + self.buffer_step * math.sqrt(position))


class _State:
    """Решение: последовательности заявок по инженерам + нераспределённые."""

    def __init__(self, day: Day, params: Params):
        self.day = day
        self.net = day.network
        self.params = params
        self.engineers = {e.id: e for e in day.engineers}
        self.seq: dict[str, list[Order]] = {e.id: [] for e in day.engineers}
        self.pool: list[Order] = []

    # ---------- расчёт ----------

    def visits_for(self, eng_id: str, seq: list[Order] | None = None):
        seq = self.seq[eng_id] if seq is None else seq
        return schedule(
            self.engineers[eng_id], seq, self.net,
            buffer_fn=self.params.buffer_fn,
            duration_factor=self.params.duration_factor,
        )

    def route_cost(self, visits, eng_id: str) -> float:
        if not visits:
            return 0.0
        p = self.params
        travel = sum(v.travel for v in visits)
        idle = sum(max(0, v.start - v.arrive) for v in visits)
        risk = sum(max(0, COMFORT_SLACK - v.slack) for v in visits)
        cost = travel + p.idle_weight * idle + p.risk_weight * risk

        # Заявку уже везёт другой инженер — переназначение стоит денег.
        if p.churn_penalty and p.anchor:
            moved = 0
            for v in visits:
                previous = p.anchor.get(v.order.id)
                if previous is not None and previous != eng_id:
                    moved += 1
            cost += p.churn_penalty * moved

        # Занятость маршрута — работа плюс дорога, в часах. Квадрат делает
        # маргинальную цену визита тем выше, чем более загружен инженер,
        # поэтому очередная вставка сама уходит к менее занятому.
        if p.balance_weight:
            load = sum(v.travel + (v.finish - v.start) for v in visits)
            cost += p.balance_weight * (load / 60.0) ** 2

        return cost

    def objective(self) -> tuple[int, float]:
        """Минимизируем: сперва число нераспределённых, затем стоимость."""
        cost = 0.0
        for eng_id in self.seq:
            v = self.visits_for(eng_id)
            if v is None:
                return (10_000, 0.0)   # невалидное состояние
            cost += self.route_cost(v, eng_id)
        return (len(self.pool), cost)

    def copy(self) -> "_State":
        s = _State(self.day, self.params)
        s.seq = {k: list(v) for k, v in self.seq.items()}
        s.pool = list(self.pool)
        return s

    # ---------- вставка ----------

    def best_insertion(self, order: Order, skip_eng: set[str] | None = None):
        """Лучшая и вторая лучшая вставка заявки. Возвращает список
        (стоимость, eng_id, позиция), отсортированный по возрастанию."""
        options = []
        for eng_id, seq in self.seq.items():
            if skip_eng and eng_id in skip_eng:
                continue
            eng = self.engineers[eng_id]
            if not eng.can_do(order):
                continue

            base_visits = self.visits_for(eng_id)
            base = self.route_cost(base_visits, eng_id) if base_visits else 0.0

            for pos in range(len(seq) + 1):
                cand = seq[:pos] + [order] + seq[pos:]
                visits = self.visits_for(eng_id, cand)
                if visits is None:
                    continue
                options.append((self.route_cost(visits, eng_id) - base, eng_id, pos))

        # При равных стоимостях выбор не должен зависеть от порядка обхода
        # словаря: иначе два одинаковых по смыслу решения различаются.
        options.sort(key=lambda x: (round(x[0], 6), x[1], x[2]))
        return options

    def insert(self, order: Order, eng_id: str, pos: int) -> None:
        self.seq[eng_id].insert(pos, order)

    def remove(self, order: Order) -> list[Order]:
        """
        Убрать заявку из маршрута.

        Удаление сдвигает последующие визиты раньше — иногда прямо в
        час пик, и тогда время в пути растёт настолько, что остаток
        маршрута перестаёт быть осуществимым. Такие визиты тоже
        выбиваются и возвращаются вызывающему, чтобы он вернул их в пул.
        """
        for eng_id, seq in self.seq.items():
            for i, o in enumerate(seq):
                if o.id != order.id:
                    continue
                del seq[i]
                evicted: list[Order] = []
                while True:
                    _, broken = schedule_upto(
                        self.engineers[eng_id], seq, self.net,
                        buffer_fn=self.params.buffer_fn,
                        duration_factor=self.params.duration_factor,
                    )
                    if broken < 0:
                        return evicted
                    evicted.append(seq.pop(broken))
        return []

    # ---------- конструирование ----------

    def recreate(self, rng: random.Random | None = None) -> None:
        """Regret-2 вставка всех заявок из пула.

        С `rng` и ненулевым `noise` пересборка рандомизируется: без
        этого каждая итерация LNS возвращала бы одно и то же решение.
        """
        jitter = self.params.noise if (rng is not None and self.params.noise) else 0.0
        while self.pool:
            best_choice = None
            best_key = None

            for order in self.pool:
                opts = self.best_insertion(order)
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
                # Аварии двигаем вперёд.
                regret += order.priority * 25

                # Сожаление округляется: две одинаковые по смыслу вставки
                # различаются в пятнадцатом знаке из-за порядка сложения,
                # и без округления выбор зависит от этого шума. Идентификатор
                # в ключе доводит порядок до полностью определённого.
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
                    best_choice = (order, pick[1], pick[2])

            if best_choice is None:
                break     # ничего больше не вставляется

            order, eng_id, pos = best_choice
            self.insert(order, eng_id, pos)
            self.pool.remove(order)

    def ruin(self, rng: random.Random, q: int) -> None:
        """
        Выбить q заявок одним из трёх способов: географический кластер
        вокруг случайной точки, непрерывный кусок одного маршрута или
        самые рискованные визиты — те, что стоят впритык к окну.
        """
        assigned = [(eng_id, o) for eng_id, seq in self.seq.items() for o in seq]
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
            live = [eng_id for eng_id, seq in self.seq.items() if seq]
            eng_id = rng.choice(live)
            seq = self.seq[eng_id]
            start = rng.randrange(len(seq))
            victims = [(eng_id, o) for o in seq[start:start + q]]
            if len(victims) < q:
                taken = {pair[1].id for pair in victims}
                rest = [pair for pair in assigned if pair[1].id not in taken]
                rng.shuffle(rest)
                victims += rest[:q - len(victims)]
        else:
            # Самые рискованные визиты — те, что идут впритык к окну.
            slack_of: dict[str, int] = {}
            for eng_id in self.seq:
                for v in self.visits_for(eng_id) or []:
                    slack_of[v.order.id] = v.slack
            assigned.sort(key=lambda pair: slack_of[pair[1].id])
            victims = assigned[:q]

        # Выбивание одной заявки может утащить за собой следующие за ней:
        # маршрут без неё сдвигается раньше и перестаёт быть осуществимым.
        # Поэтому отслеживаем, кто уже покинул маршрут.
        gone: set[str] = set()
        for _eng_id, o in victims:
            if o.id in gone:
                continue
            evicted = self.remove(o)
            self.pool.append(o)
            gone.add(o.id)
            for e in evicted:
                self.pool.append(e)
                gone.add(e.id)

    def to_plan(self) -> Plan:
        routes = {}
        for eng_id, seq in self.seq.items():
            if not seq:
                continue
            visits = self.visits_for(eng_id)
            if visits:
                routes[eng_id] = make_route(self.engineers[eng_id], visits)
        return Plan(routes=routes, unassigned=list(self.pool))


def solve(day: Day, params: Params | None = None, seed: int = 0,
          time_limit: float | None = None, report: dict | None = None) -> Plan:
    p = params or Params()
    if time_limit is not None:
        p.lns_seconds = time_limit
    rng = random.Random(seed)

    state = _State(day, p)
    state.pool = list(day.orders)
    state.recreate()

    best = state.copy()
    best_obj = best.objective()
    current_obj = best_obj

    deadline = time.time() + p.lns_seconds
    budget = p.lns_iterations
    temperature = START_TEMPERATURE
    iterations = 0
    accepted = 0

    while (iterations < budget) if budget is not None else (time.time() < deadline):
        cand = state.copy()
        cand.ruin(rng, rng.randint(p.ruin_min, p.ruin_max))
        cand.recreate(rng)
        obj = cand.objective()
        iterations += 1

        accept = False
        if obj < current_obj:
            accept = True
        elif obj[0] == current_obj[0]:
            delta = obj[1] - current_obj[1]
            if delta < temperature * -math.log(max(rng.random(), 1e-9)):
                accept = True

        if accept:
            state = cand
            current_obj = obj
            accepted += 1
            if obj < best_obj:
                best, best_obj = cand.copy(), obj

        temperature = max(1.0, temperature * COOLING)

    if report is not None:
        report["iterations"] = iterations
        report["accepted"] = accepted
        report["objective"] = best_obj

    return best.to_plan()
