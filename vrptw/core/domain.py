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


# ---------------------------------------------------------------------
# Справочники настоящих данных (выгрузка «Билайн Бизнес», 17.08.2026)
# ---------------------------------------------------------------------
#
# ТЗ задаёт ровно три навыка, и «Тип заявки BK» ложится на них один в
# один — выдумывать навык не пришлось, он в данных есть:
#
#     Локальная заявка              → local      «Локальные работы»
#     Подключение + Дозаказ         → install    «Подключение и дозаказы»
#     Глобальная проблема           → emergency  «Аварийные работы»
#
# Длительности в выгрузке нет вообще. Берём наши откалиброванные оценки
# по семействам работ (подключение 70, ремонт 45, диагностика 35, замена
# оборудования 30, работы на линии 55) и раскладываем по «Типу заявки
# HD». Это допущение, и оно записано в README: ТЗ прямо разрешает
# достраивать недостающие поля, требуя назвать принятые допущения.
#
# `no_show_rate` и `spread` тоже априорные — истории выполнения в
# выгрузке нет, оценить их не по чему. Как только история появится,
# пересчитать по шагу 5 MIGRATION.md; до тех пор симулятор судит по
# нашим прежним распределениям, и это надо говорить вслух.

# Тип транспорта — третья обязательная группа ограничений ТЗ («Ресурс»).
# У исполнителя ровно один тип; у заявки требование указывается только
# там, где оно действительно есть.
#
# Множитель — к автомобильному времени в пути; `kmh` используется, когда
# у сети есть настоящий километраж (OSRM отдаёт его рядом с временем), и
# тогда пешком и на велосипеде время считается по расстоянию, а не по
# автомобильному времени: в пробке пешеход быстрее машины, и множителем
# это не выразить. `wait` — накладные на посадку/ожидание рейса.
# `max_km` — предельная длина одного перегона. Без неё модель
# соглашалась на пеший перегон 7,6 км и велосипедный 21,7 км: формально
# они влезают в девятичасовую смену, солвер платит временем и едет.
# Но человек так не ходит. Время само по себе это не отсекает — нужен
# явный предел, и он же делает выбор транспорта осмысленным: пешеход
# работает свой микрорайон, велосипедист — район, а дальше берут машину
# или общественный транспорт.
#
# Значения — из того, сколько человек готов потратить на один перегон:
# 3 км пешком это 35–40 минут, 10 км на велосипеде — 40–45 минут.
# У машины и общественного транспорта предела нет: зона обслуживания
# доходит до Каширы и Ступина, и туда именно едут.
TRANSPORT: dict[str, dict] = {
    "car":    {"title": "Автомобиль",            "kmh": None, "mult": 1.00,
               "wait": 0, "max_km": None},
    "foot":   {"title": "Пешеход",               "kmh": 4.8,  "mult": 2.40,
               "wait": 0, "max_km": 3.0},
    "bike":   {"title": "Велосипед",             "kmh": 14.0, "mult": 1.25,
               "wait": 0, "max_km": 10.0},
    "transit":{"title": "Общественный транспорт","kmh": None, "mult": 1.55,
               "wait": 8, "max_km": None},
}


def too_far(net, from_node: int, to_node: int, transport: str) -> bool:
    """Перегон длиннее того, на что этот транспорт годится."""
    limit = TRANSPORT[transport]["max_km"]
    if limit is None or from_node == to_node:
        return False
    return net.road_km_between(from_node, to_node) > limit


SKILL_TITLES: dict[str, str] = {
    "local": "Локальные работы",
    "install": "Работы на подключение и дозаказы",
    "emergency": "Аварийные работы",
}

REAL_WORK_TYPES: dict[str, WorkType] = {
    # --- подключение и дозаказы ---
    "конвергенция": WorkType(
        "конвергенция", "Конвергенция абонента", "install", 70, 0.40, True, 0.09),
    "подключение": WorkType(
        "подключение", "Заявка на подключение", "install", 70, 0.40, True, 0.09),
    "заказ_дозаказ": WorkType(
        "заказ_дозаказ", "Заказ подключения/Дозаказ оборудования",
        "install", 60, 0.40, True, 0.08),
    "дозаказ": WorkType(
        "дозаказ", "Дозаказ оборудования", "install", 30, 0.30, True, 0.07),

    # --- локальные работы ---
    "нет_линка": WorkType(
        "нет_линка", "Нет линка", "local", 45, 0.55, True, 0.06),
    "кабель": WorkType(
        "кабель", "Работа с кабелем", "local", 55, 0.50, False, 0.00),
    "гигабит": WorkType(
        "гигабит", "Переключение на Гбит/с", "local", 30, 0.30, True, 0.07),
    "ip169": WorkType(
        "ip169", "IP-адрес 169...", "local", 35, 0.45, True, 0.05),
    "разрывы": WorkType(
        "разрывы", "Разрывы", "local", 35, 0.45, True, 0.05),
    "ошибки_порта": WorkType(
        "ошибки_порта", "Рост ошибок на порту", "local", 35, 0.45, True, 0.05),
    "низкая_скорость": WorkType(
        "низкая_скорость", "Низкая скорость", "local", 35, 0.45, True, 0.05),
    "роутер": WorkType(
        "роутер", "Роутер. Замена техническим специалистом",
        "local", 30, 0.30, True, 0.07),
    "приставка": WorkType(
        "приставка", "Замена ТВ-приставки техником", "local", 30, 0.30, True, 0.07),
    "тв_ошибки": WorkType(
        "тв_ошибки", "TVE/ENT. Другие ошибки", "local", 35, 0.45, True, 0.05),
    "мониторинг": WorkType(
        "мониторинг", "Мониторинг", "local", 35, 0.45, True, 0.05),

    # --- аварийные работы ---
    # Авария — работа на линии: в подъезд не нужно, абонента ждать не надо.
    "авария": WorkType(
        "авария", "Авария", "emergency", 55, 0.50, False, 0.00),
    "информация": WorkType(
        "информация", "Информация", "emergency", 30, 0.40, False, 0.00),
}

WORK_TYPES.update(REAL_WORK_TYPES)


# ---------------------------------------------------------------------
# Оборудование
# ---------------------------------------------------------------------
#
# Что сказал постановщик на сессии вопросов: оборудование — «дополнительный
# параметр в заявке», когда клиент выбирает установку роутера, приставки
# или колонки; данные «могут быть полностью синтетические»; «в начале дня
# старшие инженеры получили всё необходимое оборудование». Обратная связь
# 20 сентября вернула его ограничением при перепланировании.
#
# В выгрузке оборудования нет — колонки «Подключение» и «Гигабитное
# подключение» про технологию, а её постановщик назвал независимым
# фактором. Поэтому состав выводится из вида работ, и это наше допущение:
#
#   конвергенция           роутер и ТВ-приставка — связка услуг;
#   заявка на подключение  роутер;
#   заказ/дозаказ          роутер и один дополнительный прибор;
#   дозаказ оборудования   один-два дополнительных прибора;
#   замена роутера         роутер;
#   замена ТВ-приставки    ТВ-приставка.
#
# Какой именно дополнительный прибор и сколько — от номера заявки, через
# crc32, а не `hash()`: у того зерно своё в каждом процессе, и состав
# заявки менялся бы от запуска к запуску.
EQUIPMENT: dict[str, str] = {
    "router": "Роутер",
    "stb": "ТВ-приставка",
    "speaker": "Умная колонка",
}

# Сколько сверх утреннего маршрута у исполнителя в машине — по штуке
# каждого прибора. Без запаса ограничение запрещало бы любую передачу
# заявки с оборудованием: утром выдают ровно под маршрут. Штука запаса —
# допущение того же рода, что и состав заявки.
RESERVE_PER_TYPE = 1

_ДОПОЛНИТЕЛЬНЫЕ = ("router", "stb", "speaker")


def equipment_for(order_id: str, work_type: str) -> dict[str, int]:
    """Что везти на заявку. Детерминированно по номеру и виду работ."""
    import zlib

    k = zlib.crc32(str(order_id).encode("utf-8"))
    extra = _ДОПОЛНИТЕЛЬНЫЕ[k % len(_ДОПОЛНИТЕЛЬНЫЕ)]
    if work_type == "конвергенция":
        return {"router": 1, "stb": 1}
    if work_type in ("подключение", "роутер", "install"):
        return {"router": 1}
    if work_type == "заказ_дозаказ":
        return {"router": 1, extra: 1} if extra != "router" else {"router": 2}
    if work_type in ("дозаказ", "cpe"):
        return {extra: 1 + (k >> 8) % 2}
    if work_type == "приставка":
        return {"stb": 1}
    return {}


def equipment_sum(orders) -> dict[str, int]:
    """Сколько приборов нужно на набор заявок."""
    out: dict[str, int] = {}
    for o in orders:
        for kind, n in o.equipment.items():
            out[kind] = out.get(kind, 0) + n
    return out


def equipment_text(need: dict[str, int]) -> str:
    """«2 × Роутер, 1 × ТВ-приставка» — для объяснений диспетчеру."""
    return ", ".join(f"{n} × {EQUIPMENT.get(k, k)}"
                     for k, n in sorted(need.items()) if n)


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

    # Требуемый тип транспорта, если у заявки есть такое ограничение.
    # `None` — ограничения нет, годится любой исполнитель по навыку.
    requires_transport: str | None = None

    # Что везти на заявку: прибор -> штук. Пусто — ничего. См. `EQUIPMENT`.
    equipment: dict = field(default_factory=dict)

    # Жёсткая граница суток этого дня. Была константой модуля, стала
    # полем: в настоящих данных окна доходят до 22:00, а все синтетические
    # замеры сняты при 21:00, и молча сдвинуть границу значило бы
    # переписать задним числом 38 заявок из 960 — ровно то, от чего
    # правило про «перегенерировать целиком» и защищает.
    hard_end: int = DAY_HARD_END

    @property
    def skill(self) -> str:
        return WORK_TYPES[self.work_type].skill

    @property
    def needs_access(self) -> bool:
        return WORK_TYPES[self.work_type].needs_access

    @property
    def must_today(self) -> bool:
        """
        Обязательство на сегодня: срок по SLA истекает раньше, чем кончится
        рабочий день, и перенести заявку на завтра нельзя.

        Сравнивать надо именно с концом дня, а не с окном: у части заявок
        SLA даёт всего час сверх окна — это запас внутри сегодняшнего дня,
        а не лишние сутки.
        """
        return self.sla_deadline <= self.hard_end

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
    transport: str = "car"             # ровно один тип на исполнителя

    def can_do(self, order: Order) -> bool:
        """Обе жёсткие проверки ТЗ разом: квалификация и транспорт.

        Третья группа — время — проверяется не здесь, а при вставке в
        маршрут: она зависит от того, что уже стоит рядом."""
        if order.skill not in self.skills:
            return False
        if order.requires_transport and order.requires_transport != self.transport:
            return False
        return True

    def cannot_do_reason(self, order: Order) -> str | None:
        """Почему не может — человеческим языком, для панели объяснений."""
        if order.skill not in self.skills:
            return f"нет навыка «{SKILL_TITLES.get(order.skill, order.skill)}»"
        if order.requires_transport and order.requires_transport != self.transport:
            need = TRANSPORT[order.requires_transport]["title"]
            have = TRANSPORT[self.transport]["title"]
            return f"нужен транспорт «{need}», у него «{have}»"
        return None


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
        """Сколько работа занимает в этом плане, а не по нормативу.

        Это разные числа, когда `duration_factor` не единица — а это
        пользовательская настройка от 0,5 до 2,0. Возвращался норматив, и
        при множителе 2,0 инженер, у которого день забит на 93%,
        показывался на экране с загрузкой 56%: `occupancy` считается
        отсюда.
        """
        return sum(v.finish - v.start for v in self.visits)

    @property
    def end_time(self) -> int:
        return self.visits[-1].finish if self.visits else self.engineer.shift_start


@dataclass
class Plan:
    routes: dict[str, Route]
    unassigned: list[Order]
    # Во сколько раз работа планировалась дольше оценки. Живёт в плане, а
    # не в аргументе проверки, нарочно: инвариант, который надо не забыть
    # чем-то снабдить, однажды забудут снабдить. План помнит, чем он
    # построен, и проверяется сам по себе.
    #
    # Это пользовательская настройка от 0,5 до 2,0, и до 20 сентября она
    # не проверялась вовсе: план, где каждый визит длится минуту вместо
    # часа, проходил инварианты чисто.
    duration_factor: float = 1.0
    # Что диспетчер закрепил руками: заявка -> инженер. Здесь по той же
    # причине, что и множитель: объяснение «почему заявка без инженера»
    # обязано знать, что круг исполнителей сузил человек, а не солвер.
    pinned: dict | None = None
    # Что у исполнителей в машине: инженер -> прибор -> штук. `None` —
    # не ограничено: утренний план сам решает, что выдать. Задаётся в
    # пересчёте: к полудню в машине то, что выдали утром, минус
    # установленное, и отдать заявку с роутером можно только тому, у кого
    # роутер остался.
    stock: dict | None = None

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

        # Исполнитель и заявка берутся из дня, а не из плана. План несёт
        # в себе копии, и до 21 сентября проверялись именно они: план,
        # собранный на дне с растянутой сменой или с сокращённой работой,
        # сверялся сам с собой и проходил чисто.
        инженеры = {e.id: e for e in day.engineers}
        заявки = {o.id: o for o in day.orders}

        for eng_id, route in self.routes.items():
            eng = инженеры.get(eng_id)
            if eng is None:
                problems.append(f"{eng_id}: такого исполнителя в дне нет")
                continue
            свой = route.engineer
            if свой.id != eng_id:
                problems.append(f"маршрут {eng_id} числит исполнителем {свой.id}")
            if (свой.shift_start, свой.shift_end, свой.home_node, свой.transport,
                    set(свой.skills)) != (eng.shift_start, eng.shift_end,
                                          eng.home_node, eng.transport, set(eng.skills)):
                problems.append(f"{eng_id}: в плане у исполнителя не те смена, "
                                f"дом, транспорт или навыки, что в дне")
            clock = eng.shift_start
            node = eng.home_node

            for i, v in enumerate(route.visits):
                if v.order.id in seen:
                    problems.append(f"{v.order.id}: назначена дважды")
                seen.add(v.order.id)

                order = заявки.get(v.order.id)
                if order is None:
                    problems.append(f"{v.order.id}: такой заявки в дне нет")
                    clock, node = v.finish, v.order.node
                    continue
                if v.order is not order and (
                        v.order.window_start, v.order.window_end, v.order.est_minutes,
                        v.order.node, v.order.work_type, v.order.requires_transport
                ) != (order.window_start, order.window_end, order.est_minutes,
                      order.node, order.work_type, order.requires_transport):
                    problems.append(f"{order.id}: в плане у заявки не те окно, "
                                    f"адрес, вид работ или норматив, что в дне")

                if not eng.can_do(order):
                    problems.append(f"{order.id}: у {eng_id} нет навыка {order.skill}")
                if v.start < order.window_start:
                    problems.append(f"{order.id}: старт {v.start} раньше окна {order.window_start}")
                if v.start > order.window_end:
                    problems.append(f"{order.id}: старт {v.start} позже окна {order.window_end}")
                if v.finish > eng.shift_end:
                    problems.append(f"{v.order.id}: финиш {v.finish} за пределами смены")
                # После 21:00 инженер не работает ни при каких условиях.
                # Смена, залезающая за эту границу, — не право работать
                # дольше, а ошибка в расписании.
                if v.finish > day.hard_end:
                    problems.append(
                        f"{v.order.id}: финиш {v.finish} позже жёсткой границы дня "
                        f"{day.hard_end}")
                if i > 0 and v.arrive < route.visits[i - 1].finish:
                    problems.append(f"{v.order.id}: прибытие раньше, чем закончен предыдущий визит")

                # Работа занимает столько, сколько её планировали занимать.
                #
                # Самое крупное слагаемое времени, и до 20 сентября оно не
                # проверялось вовсе: план, где каждый визит длится минуту
                # вместо часа, проходил чисто — с согласованно пересчитанной
                # дорогой его не отличала ни одна проверка. А
                # `duration_factor` это ручка пользователя от 0,5 до 2,0,
                # то есть «сократить работу вдвое и показать красивое
                # покрытие» было ровно ничем не закрыто.
                #
                # Сверяем с тем же выражением, каким считает планировщик
                # (`base.schedule_upto`): округление до минуты входит в
                # план, а не в допуск.
                должно = int(round(order.est_minutes * self.duration_factor))
                если_есть = v.finish - v.start
                if если_есть != должно:
                    problems.append(
                        f"{v.order.id}: работа занимает {если_есть} мин, "
                        f"а по нормативу {order.est_minutes} × "
                        f"{self.duration_factor:g} = {должно}")
                # Работать до приезда нельзя. Из формулы планировщика
                # (`start = max(arrive, window_start)`) это следует, но
                # инвариант проверяет план, а не формулу.
                if v.start < v.arrive:
                    problems.append(
                        f"{v.order.id}: работа начата в {v.start}, "
                        f"а инженер приехал в {v.arrive}")

                # Перегон должен быть по силам транспорту.
                if too_far(net, node, order.node, eng.transport):
                    km = net.road_km_between(node, order.node)
                    problems.append(
                        f"{v.order.id}: перегон {km:.1f} км не по силам "
                        f"транспорту «{TRANSPORT[eng.transport]['title']}» "
                        f"(предел {TRANSPORT[eng.transport]['max_km']} км)")

                # Дорога — та, что есть на самом деле, а не удобная.
                real = int(round(net.travel_minutes(node, order.node, clock, eng.transport)))
                if v.travel != real:
                    problems.append(
                        f"{v.order.id}: в плане дорога {v.travel} мин, по сети {real}")
                if v.arrive != clock + v.travel:
                    problems.append(
                        f"{v.order.id}: прибытие {v.arrive} не сходится с выездом "
                        f"{clock} и дорогой {v.travel}")
                clock, node = v.finish, order.node

        # В машине не больше, чем в ней есть. Проверяется, только если
        # план строился с ограничением: утренний план сам задаёт выдачу.
        if self.stock is not None:
            for eng_id, route in self.routes.items():
                нужно = equipment_sum(заявки.get(v.order.id, v.order)
                                      for v in route.visits)
                есть = self.stock.get(eng_id, {})
                нехватка = {k: n - есть.get(k, 0) for k, n in нужно.items()
                            if n > есть.get(k, 0)}
                if нехватка:
                    problems.append(
                        f"{eng_id}: маршруту не хватает в машине "
                        f"{equipment_text(нехватка)}")

        # Итог сверяется множеством, а не счётом. По счёту потеря одной
        # заявки и дубль другой в неназначенных гасили друг друга, и план,
        # в котором заявки не было нигде, проходил чисто.
        не_назначено: set[str] = set()
        for o in self.unassigned:
            if o.id in не_назначено:
                problems.append(f"{o.id}: дважды в неназначенных")
            if o.id not in заявки:
                problems.append(f"{o.id}: в неназначенных заявка, которой в дне нет")
            if o.id in seen:
                problems.append(f"{o.id}: и в маршруте, и в неназначенных")
            не_назначено.add(o.id)
        потеряны = sorted(set(заявки) - seen - не_назначено)
        if потеряны:
            problems.append(f"потеряны заявки, их нет ни в маршрутах, ни в "
                            f"неназначенных: {', '.join(потеряны[:5])}"
                            + (f" и ещё {len(потеряны) - 5}" if len(потеряны) > 5 else ""))

        return problems

    # ------------------------------------------------------------------
    # Обязательные метрики ТЗ
    # ------------------------------------------------------------------
    #
    # ТЗ называет ровно две метрики, по которым сравниваются допустимые
    # планы: «выполнение всех заявок наименьшим количеством персонала»
    # и «пробег по маршруту каждого исполнителя». Ни та, ни другая не
    # совпадают с нашим покрытием дня, и считать их надо отдельно.
    #
    # Считаются здесь, по готовому плану, а не внутри солверов: у нас две
    # реализации одного алгоритма, они обязаны идти шаг в шаг, и любая
    # правка, продублированная в обе, — это лишнее место разъехаться.

    def engineers_used(self) -> int:
        """Сколько исполнителей реально задействовано — первая метрика ТЗ.

        Считаются те, кому назначена хотя бы одна заявка: инженер,
        просидевший день без визитов, в наряд не попадает."""
        return sum(1 for r in self.routes.values() if r.visits)

    def km_by_engineer(self, day) -> dict[str, float]:
        """Пробег по каждому исполнителю — вторая метрика ТЗ.

        Маршрут начинается в стартовой точке инженера; возвращение туда
        после последнего визита ТЗ для обязательного MVP не требует,
        поэтому обратный перегон в пробег не входит."""
        net = day.network
        out: dict[str, float] = {}
        for eng_id, route in self.routes.items():
            node = route.engineer.home_node
            km = 0.0
            for v in route.visits:
                km += net.road_km_between(node, v.order.node)
                node = v.order.node
            out[eng_id] = round(km, 2)
        return out

    def metrics(self, day) -> dict:
        """Обе обязательные метрики разом, в том виде, в каком их ждёт ТЗ."""
        km = self.km_by_engineer(day)
        used = self.engineers_used()
        return {
            "engineers_used": used,
            "engineers_total": len(self.routes),
            "km_by_engineer": km,
            "km_total": round(sum(km.values()), 2),
            "km_per_engineer": round(sum(km.values()) / used, 2) if used else 0.0,
            "assigned": self.assigned_count,
            "unassigned": len(self.unassigned),
        }


class InvalidPlan(RuntimeError):
    """План нарушает инварианты. Такой план не отдаётся и не мерится."""

    def __init__(self, what: str, problems: list[str]):
        self.problems = problems
        super().__init__(f"{what}: {problems[:3]}"
                         + (f" и ещё {len(problems) - 3}" if len(problems) > 3 else ""))


def require_valid(plan: Plan, day, what: str = "план невалиден") -> Plan:
    """
    Проверить план и вернуть его же — или бросить `InvalidPlan`.

    Вместо `assert not plan.check_invariants(day)`: голый `assert`
    исчезает под `python3 -O`, и 23 проверки в замерах и выгрузке
    выключались одним флагом интерпретатора. Правило проекта — проверка
    идёт на каждом плане, и её нельзя отключить.
    """
    problems = plan.check_invariants(day)
    if problems:
        raise InvalidPlan(what, problems)
    return plan


@dataclass
class Day:
    """Один синтетический рабочий день."""

    date: str
    orders: list[Order]
    engineers: list[Engineer]
    network: object  # OSMNetwork или RoadNetwork, см. core/network.py
    hard_end: int = DAY_HARD_END   # 21:00 у синтетики, 22:00 у настоящих данных
    # Чем этот день зовут снаружи: зона выгрузки («восток») либо номер
    # синтетического дня строкой. Нужен выгрузке: все четыре формы
    # обязаны сказать, по какому дню посчитаны, и по дате это не
    # различить — у всех трёх зон она одна, 2026-08-17. Интерфейс без
    # этого поля держал таблицу зон руками и не мог различить два
    # запроса в полёте.
    ident: str = ""

    def order_by_id(self, oid: str) -> Order:
        return next(o for o in self.orders if o.id == oid)
