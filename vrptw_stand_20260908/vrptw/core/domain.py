"""
Доменная модель.

Ключевой принцип: планировщик видит только оценки (`est_*`). Всё, чего он
знать не может — насколько работа затянется, будет ли абонент дома, пустят
ли в подъезд, — живёт в распределениях `WorkType` и разыгрывается
симулятором заново в каждом прогоне.

Раньше эта случайность записывалась в заявку один раз при генерации дня.
Так делать нельзя: заявка с выпавшей неявкой срывалась во всех прогонах
подряд, и «самый хрупкий визит» показывал не рискованное место плана, а
заявку, обречённую с самого начала.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Рабочий день: минуты от 00:00 суток.
DAY_START = 8 * 60      # 08:00 — начало смен
DAY_HARD_END = 21 * 60  # 21:00 — позже инженер не работает ни при каких условиях


@dataclass
class WorkType:
    code: str
    title: str
    skill: str            # какой навык нужен
    est_minutes: int      # априорная оценка длительности
    spread: float         # разброс истинной длительности (доля от оценки)
    needs_access: bool    # нужен доступ в подъезд/квартиру
    no_show_rate: float   # вероятность, что абонента не будет дома


WORK_TYPES: dict[str, WorkType] = {
    "install": WorkType("install", "Подключение", "install", 70, 0.40, True, 0.09),
    "repair": WorkType("repair", "Ремонт", "repair", 45, 0.55, True, 0.06),
    "diag": WorkType("diag", "Диагностика", "repair", 35, 0.45, True, 0.05),
    "cpe": WorkType("cpe", "Замена оборудования", "install", 30, 0.30, True, 0.07),
    "line": WorkType("line", "Работы на линии", "line", 55, 0.50, False, 0.00),
}


@dataclass
class Order:
    """Заявка в том виде, в каком её знает система: оценка, окно, SLA.
    Ничего о том, как визит пройдёт на самом деле, здесь нет."""

    id: str
    work_type: str
    district: str
    lat: float
    lon: float
    node: int

    window_start: int          # минуты от 00:00
    window_end: int
    sla_deadline: int          # крайний срок по SLA, минуты от 00:00
    priority: int              # 0 обычная, 1 повторный визит, 2 авария

    est_minutes: int           # оценка длительности, видна планировщику

    # Почтовый адрес, если день собран на настоящей карте: «улица
    # Россолимо, 8». На синтетической сети адреса нет — там координата
    # это «центр района плюс случайный сдвиг», и выдавать её за дом
    # было бы враньём.
    address: str | None = None

    @property
    def skill(self) -> str:
        return WORK_TYPES[self.work_type].skill

    @property
    def needs_access(self) -> bool:
        return WORK_TYPES[self.work_type].needs_access

    def window_len(self) -> int:
        return self.window_end - self.window_start


@dataclass
class Engineer:
    id: str
    name: str
    skills: set[str]
    grade: int                 # 1..3, выше — быстрее и сложнее работы
    home_node: int
    home_lat: float
    home_lon: float
    shift_start: int
    shift_end: int
    speed: float = 1.0         # множитель к длительности работ (истинный)
    home_address: str | None = None    # откуда выезжает, если карта настоящая

    def can_do(self, order: Order) -> bool:
        return order.skill in self.skills


@dataclass
class Visit:
    """Одна остановка в маршруте, как её запланировал планировщик."""

    order: Order
    arrive: int         # плановое время прибытия, минуты от 00:00
    start: int          # плановое начало работ (не раньше окна)
    finish: int         # плановое окончание
    travel: int         # время в пути до этой точки

    @property
    def slack(self) -> int:
        """Запас до закрытия окна: сколько можно опоздать и всё ещё успеть."""
        return self.order.window_end - self.start


@dataclass
class Route:
    engineer: Engineer
    visits: list[Visit] = field(default_factory=list)

    @property
    def orders(self) -> list[Order]:
        return [v.order for v in self.visits]

    @property
    def travel_minutes(self) -> int:
        return sum(v.travel for v in self.visits)

    @property
    def work_minutes(self) -> int:
        return sum(v.order.est_minutes for v in self.visits)

    @property
    def end_time(self) -> int:
        return self.visits[-1].finish if self.visits else self.engineer.shift_start


@dataclass
class Plan:
    routes: dict[str, Route]
    unassigned: list[Order]

    @property
    def assigned_count(self) -> int:
        return sum(len(r.visits) for r in self.routes.values())

    def check_invariants(self, day) -> list[str]:
        """
        Возвращает список нарушений. Пустой список = план валиден.

        Проверяется не только «непротиворечиво выглядит», но и
        «физически исполним»: время в пути пересчитывается по дорожной
        сети на тот час, в который инженер выезжает, и сверяется с тем,
        что записано в плане. Без этого плану ничто не мешает объявить
        дорогу короче, чем она есть, и получить красивое покрытие из
        воздуха.
        """
        problems: list[str] = []
        seen: set[str] = set()
        net = day.network

        for eng_id, route in self.routes.items():
            eng = route.engineer
            clock = eng.shift_start
            node = eng.home_node

            for i, v in enumerate(route.visits):
                if v.order.id in seen:
                    problems.append(f"{v.order.id}: назначена дважды")
                seen.add(v.order.id)

                if not eng.can_do(v.order):
                    problems.append(f"{v.order.id}: у {eng_id} нет навыка {v.order.skill}")
                if v.start < v.order.window_start:
                    problems.append(f"{v.order.id}: старт {v.start} раньше окна {v.order.window_start}")
                if v.start > v.order.window_end:
                    problems.append(f"{v.order.id}: старт {v.start} позже окна {v.order.window_end}")
                if v.finish > eng.shift_end:
                    problems.append(f"{v.order.id}: финиш {v.finish} за пределами смены")
                # После 21:00 инженер не работает ни при каких условиях.
                # Смена, залезающая за эту границу, — не право работать
                # дольше, а ошибка в расписании.
                if v.finish > DAY_HARD_END:
                    problems.append(
                        f"{v.order.id}: финиш {v.finish} позже жёсткой границы дня "
                        f"{DAY_HARD_END}")
                if i > 0 and v.arrive < route.visits[i - 1].finish:
                    problems.append(f"{v.order.id}: прибытие раньше, чем закончен предыдущий визит")

                # Дорога — та, что есть на самом деле, а не удобная.
                real = int(round(net.travel_minutes(node, v.order.node, clock)))
                if v.travel != real:
                    problems.append(
                        f"{v.order.id}: в плане дорога {v.travel} мин, по сети {real}")
                if v.arrive != clock + v.travel:
                    problems.append(
                        f"{v.order.id}: прибытие {v.arrive} не сходится с выездом "
                        f"{clock} и дорогой {v.travel}")
                clock, node = v.finish, v.order.node

        total = len(seen) + len(self.unassigned)
        if total != len(day.orders):
            problems.append(f"потеряны заявки: {len(seen)}+{len(self.unassigned)} != {len(day.orders)}")

        return problems


@dataclass
class Day:
    """Один синтетический рабочий день."""

    date: str
    orders: list[Order]
    engineers: list[Engineer]
    network: object  # OSMNetwork или RoadNetwork, см. core/network.py

    def order_by_id(self, oid: str) -> Order:
        return next(o for o in self.orders if o.id == oid)
