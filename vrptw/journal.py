"""
Что на самом деле случилось за день.

До сих пор движок был чистой функцией: дал номер дня — получил план,
спросил пересчёт — получил пересчёт. Состояние дня на момент пересчёта
он брал из симулятора, то есть разыгрывал костями. Диспетчер не мог
сказать «этот визит закрыт, а сюда не пустили» — некуда было.

Здесь эта дырка и закрывается. Журнал — список событий, которые прислал
интерфейс, плюс актуальное назначение заявок по инженерам. Из него
собирается тот же самый `DayState`, который раньше собирал симулятор:
кто где находится, что выполнено, что сорвалось, что ещё впереди.
Дальше всё как было — `carve_remainder` режет остаток дня, солвер
пересобирает план.

Симулятор при этом никуда не девается. Он остаётся для замеров и для
демо без диспетчера: там нужно проиграть день сотни раз, а не один.
Выбор источника состояния явный, чтобы никто случайно не померил
качество планировщика на выдуманных событиях.

Хранится журнал файлом на каждый день. Никакой базы: событий за день
сотни, а не миллионы, и переживать перезапуск сервера — единственное,
что от хранилища требуется.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .core.domain import WORK_TYPES, Day, Order, Plan
from .core.geo import DISTRICTS
from .replan import DayState
from .state import journal_dir

# Чем может кончиться визит. Те же причины, что различает симулятор, —
# иначе отчёт диспетчера и замер говорили бы на разных языках.
FAILURE_REASONS = ("no_show", "no_access", "missed_window", "cancelled")

KINDS = ("done", "failed", "order_new", "assigned", "dispatched", "en_route",
         "engineer_out", "engineer_back", "engineer_delayed")

# Статусы заявки по ходу дня, в порядке жизни. Обратная связь
# организаторов 20 сентября просила различать «отправлено» и «в пути»:
# прежде журнал знал только «выполнено» и «сорвано», и пересчёт в 13:40
# мог отдать другому заявку, к которой исполнитель уже ехал.
#
#   назначено  — стоит в плане, человеку ещё не сказали;
#   отправлено — наряд у исполнителя. Это решение человека, и пересчёт
#                держится за него так же, как за ручное закрепление;
#   в пути     — исполнитель выехал. Заявку не перераспределяют вовсе, а
#                сам он освободится у неё после окончания работ.
#
# Ручное переназначение возвращает заявку в «назначено»: новому
# исполнителю наряд ещё не отправлен.
СТАТУСЫ = ("назначено", "отправлено", "в пути", "выполнено", "сорвано")

# Окно заявки, если диспетчер его не назвал: три часа от момента звонка.
# Столько же даёт синтетическая авария в замерах — чтобы «пришла заявка»
# на демо и «пришла заявка» в отчёте значили одно и то же.
DEFAULT_WINDOW_MINUTES = 180

# Вид работ, если его не назвали. Историческое значение; берётся только
# когда им в этом дне кто-то владеет — см. `_вид_по_умолчанию`.
ВИД_ПО_УМОЛЧАНИЮ = "repair"


def _вид_по_умолчанию(day: Day) -> str:
    """Вид работ для заявки, у которой его не назвали.

    Брать из справочника вслепую нельзя. В каталоге 22 кода на пять
    навыков, а у бригады заказчика навыков ровно три (`local`,
    `install`, `emergency`); прежнее безусловное умолчание `repair`
    давало на зонах заявку, которую не может взять никто — вечно
    неназначенную, с причиной «нет навыка „Ремонт"». Ровно этот баг уже
    чинился в `replan.urgent_orders`, но в журнал правка не доехала, и
    путь достижим снаружи: `POST /api/event` с `kind=order_new`.

    Порядок предпочтения: прежнее умолчание, если оно кому-то по силам —
    на синтетике так и есть, и там поведение не меняется ни на визит;
    иначе аварийный навык, потому что заявка, поступившая по ходу дня,
    чаще всего инцидент; иначе любой посильный вид. Перебор по
    отсортированному списку, чтобы выбор не зависел от порядка словаря.

    Умолчание — наша выдумка, и она обязана быть выполнимой. Явно
    названный диспетчером вид мы не подменяем: «никто не умеет» — это
    настоящий ответ, и ТЗ просит показать его причиной неназначения.
    """
    умеют: set[str] = set()
    for eng in day.engineers:
        умеют |= eng.skills

    if WORK_TYPES[ВИД_ПО_УМОЛЧАНИЮ].skill in умеют:
        return ВИД_ПО_УМОЛЧАНИЮ
    посильные = [k for k in sorted(WORK_TYPES) if WORK_TYPES[k].skill in умеют]
    аварийные = [k for k in посильные if WORK_TYPES[k].skill == "emergency"]
    if аварийные:
        return аварийные[0]
    return посильные[0] if посильные else ВИД_ПО_УМОЛЧАНИЮ


@dataclass
class Journal:
    """События дня плюс то, у кого какая заявка сейчас числится."""

    # Идентификатор дня: номер синтетического набора или имя зоны
    # заказчика. Строкой, потому что источников теперь два.
    day: str
    # Инженер -> его заявки по порядку маршрута. Обновляется при каждом
    # пересчёте: после него у людей на руках другой маршрут, и считать
    # оставшееся по утреннему плану было бы неверно.
    assignment: dict[str, list[str]] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    # Расчёт из архива, от плана которого ведётся журнал; None — от плана
    # компании. У каждого расчёта журнал свой: события, сообщённые по
    # плану R005, относятся к R005 и в чужой план не переезжают.
    base: str | None = None

    # ---------- хранение ----------

    @staticmethod
    def path(day, base: str | None = None) -> Path:
        ident = str(day)
        safe = f"{int(ident):02d}" if ident.isdigit() else f"зона-{ident}"
        return journal_dir() / (f"day-{safe}@{base}.json" if base else f"day-{safe}.json")

    @classmethod
    def load(cls, day, base: str | None = None) -> "Journal":
        p = cls.path(day, base)
        if not p.exists():
            return cls(day=day, base=base)
        raw = json.loads(p.read_text(encoding="utf-8"))
        return cls(day=day, assignment=raw.get("assignment", {}),
                   events=raw.get("events", []), base=base)

    def save(self) -> None:
        journal_dir().mkdir(parents=True, exist_ok=True)
        self.path(self.day, self.base).write_text(json.dumps(
            {"day": self.day, "base": self.base, "assignment": self.assignment,
             "events": self.events},
            ensure_ascii=False, indent=1), encoding="utf-8")

    # ---------- наполнение ----------

    def adopt(self, plan: Plan) -> None:
        """Запомнить, кто что везёт по текущему плану."""
        self.assignment = {eng_id: [v.order.id for v in route.visits]
                           for eng_id, route in plan.routes.items()}

    def add(self, day: Day, event: dict) -> dict:
        """
        Записать событие. Возвращает его же, дополненное.

        Проверки здесь не формальность: журнал — единственное место, где
        движок узнаёт о реальности, и мусор в нём тихо испортит все
        последующие пересчёты.
        """
        kind = event.get("kind")
        if kind not in KINDS:
            raise ValueError(f"неизвестное событие {kind!r}; бывают {', '.join(KINDS)}")

        at = event.get("at")
        if at is None:
            raise ValueError("у события нет времени: at, минуты от полуночи")
        at = int(at)
        if not 0 <= at <= 24 * 60:
            raise ValueError(f"время {at} вне суток")

        rec: dict = {"kind": kind, "at": at}

        if kind == "order_new":
            return self._add_order(day, event, rec)

        if kind == "assigned":
            return self._reassign(day, event, rec)

        if kind in ("dispatched", "en_route"):
            return self._advance(day, event, rec)

        if kind in ("done", "failed"):
            oid = event.get("order")
            # Заявка может быть и утренней, и поступившей по ходу дня.
            if oid not in {o.id for o in self.augmented(day).orders}:
                raise ValueError(f"нет заявки {oid}")
            if oid in self.reported():
                raise ValueError(f"по заявке {oid} уже отчитались; "
                                 f"чтобы переиграть — сбросьте журнал дня")
            holder = self.holder(oid)
            if holder is None:
                raise ValueError(f"заявка {oid} никому не назначена, "
                                 f"отчитываться по ней не о чем")
            rec["order"] = oid
            rec["engineer"] = holder
            if kind == "failed":
                reason = event.get("reason", "cancelled")
                if reason not in FAILURE_REASONS:
                    raise ValueError(f"причина {reason!r}; бывают "
                                     f"{', '.join(FAILURE_REASONS)}")
                rec["reason"] = reason
        else:
            eid = event.get("engineer")
            if eid not in {e.id for e in day.engineers}:
                raise ValueError(f"нет инженера {eid}")
            rec["engineer"] = eid
            if kind == "engineer_delayed":
                minutes = int(event.get("minutes", 0))
                if minutes <= 0:
                    raise ValueError(f"задержка {minutes} минут — не задержка")
                rec["minutes"] = minutes

        self.events.append(rec)
        return rec

    def _reassign(self, day: Day, event: dict, rec: dict) -> dict:
        """Диспетчер переназначил заявку руками.

        Единственное «необходимо заложить», прозвучавшее на сессии
        вопросов: человек не согласен с планом и должен иметь возможность
        сказать, кто поедет, а не только «пересчитайте».

        Решение человека — запрет, а не пожелание: заявка закрепляется за
        названным инженером, и следующий пересчёт не вправе отдать её
        другому. Иначе диспетчер подвинул бы заявку и увидел, как движок
        двигает её обратно, — такая кнопка хуже отсутствующей.

        Проверяется то же, что проверил бы солвер, и отказ приходит
        словами: невозможное закрепление, принятое молча, испортит все
        последующие пересчёты дня.
        """
        полный = self.augmented(day)
        by_id = {o.id: o for o in полный.orders}
        oid = event.get("order")
        if oid not in by_id:
            raise ValueError(f"нет заявки {oid}")
        if oid in self.reported():
            raise ValueError(f"по заявке {oid} уже отчитались; "
                             f"переназначать закрытую заявку не о чем")

        eid = event.get("engineer")
        инженер = next((e for e in day.engineers if e.id == eid), None)
        if инженер is None:
            raise ValueError(f"нет инженера {eid}")
        if eid in self.absent():
            raise ValueError(f"инженера {eid} сегодня не будет; "
                             f"назначать на него нельзя")
        нельзя = инженер.cannot_do_reason(by_id[oid])
        if нельзя:
            raise ValueError(f"инженер {eid} не может взять {oid}: {нельзя}")

        откуда = self.holder(oid)
        # Место в маршруте: диспетчер может не только отдать заявку
        # другому, но и подвинуть её у того же. Без номера — в конец.
        место = event.get("position")
        rec["order"] = oid
        rec["engineer"] = eid
        rec["from"] = откуда
        if место is not None:
            rec["position"] = int(место)

        for ids in self.assignment.values():
            if oid in ids:
                ids.remove(oid)
        свои = self.assignment.setdefault(eid, [])
        if место is None or not 0 <= int(место) <= len(свои):
            свои.append(oid)
        else:
            свои.insert(int(место), oid)

        self.events.append(rec)
        return rec

    def _advance(self, day: Day, event: dict, rec: dict) -> dict:
        """Наряд отправлен исполнителю или исполнитель выехал к заявке.

        Исполнитель — тот, за кем заявка сейчас числится: отправить чужую
        заявку нельзя, её сначала переназначают. Проверки те же, что у
        отчёта: невозможное событие, принятое молча, испортит все
        следующие пересчёты дня.
        """
        oid = event.get("order")
        if oid not in {o.id for o in self.augmented(day).orders}:
            raise ValueError(f"нет заявки {oid}")
        if oid in self.reported():
            raise ValueError(f"по заявке {oid} уже отчитались")
        holder = self.holder(oid)
        if holder is None:
            raise ValueError(f"заявка {oid} никому не назначена: сначала "
                             f"назначьте исполнителя")
        if holder in self.absent():
            raise ValueError(f"исполнителя {holder} сегодня нет")
        статусы = self.statuses()
        сейчас = статусы.get(oid, "назначено")
        if rec["kind"] == "dispatched" and сейчас != "назначено":
            raise ValueError(f"заявка {oid} уже «{сейчас}»")
        if rec["kind"] == "en_route":
            if сейчас == "в пути":
                raise ValueError(f"исполнитель уже едет к {oid}")
            едет = self.underway()
            занят = [o for o, e in едет.items() if e == holder]
            if занят:
                raise ValueError(f"{holder} уже в пути к {занят[0]}; сначала "
                                 f"отчитайтесь по ней")
        rec["order"] = oid
        rec["engineer"] = holder
        self.events.append(rec)
        return rec

    def statuses(self) -> dict[str, str]:
        """Заявка -> статус, по событиям в том порядке, в каком их сообщили.

        Заявки, о которых не сообщали ничего, — «назначено», если они в
        чьём-то маршруте; в ответ они не попадают, чтобы не раздувать его.
        """
        out: dict[str, str] = {}
        for e in self.events:
            kind = e["kind"]
            if kind == "dispatched":
                out[e["order"]] = "отправлено"
            elif kind == "en_route":
                out[e["order"]] = "в пути"
            elif kind == "assigned":
                out[e["order"]] = "назначено"
            elif kind == "done":
                out[e["order"]] = "выполнено"
            elif kind == "failed":
                out[e["order"]] = "сорвано"
        return out

    def underway(self) -> dict[str, str]:
        """Заявка -> инженер, который к ней едет прямо сейчас."""
        статусы = self.statuses()
        out: dict[str, str] = {}
        for e in self.events:
            if e["kind"] == "en_route" and статусы.get(e["order"]) == "в пути":
                out[e["order"]] = e["engineer"]
        return out

    def pinned(self) -> dict[str, str]:
        """Что держит решение человека: заявка -> инженер.

        Ручное закрепление и отправленный наряд — оба решения диспетчера,
        и пересчёт не вправе их переиграть. Только по незакрытым заявкам:
        закреплять выполненную незачем, а солверу лишний запрет — лишний
        повод не найти решения.
        """
        # Заявка «в пути» из пересчёта выбывает вовсе — закреплять её незачем.
        закрыто = self.reported() | set(self.underway())
        статусы = self.statuses()
        out: dict[str, str] = {}
        for e in self.events:
            if e["kind"] == "assigned" and e["order"] not in закрыто:
                out[e["order"]] = e["engineer"]
            elif (e["kind"] == "dispatched" and e["order"] not in закрыто
                  and статусы.get(e["order"]) == "отправлено"):
                out[e["order"]] = e["engineer"]
        return out

    def _add_order(self, day: Day, event: dict, rec: dict) -> dict:
        """
        Заявка, поступившая в течение дня.

        Координаты обязательны: интерфейс знает, куда ехать, а движок не
        умеет геокодировать и в момент показа не должен лезть в сеть.
        Всё остальное можно не называть — окно берётся трёхчасовым от
        момента звонка, длительность из справочника работ.
        """
        code = event.get("work_type")
        if code is None:
            code = _вид_по_умолчанию(day)
        elif code not in WORK_TYPES:
            raise ValueError(f"вид работ {code!r}; бывают "
                             f"{', '.join(sorted(WORK_TYPES))}")

        if event.get("lat") is None or event.get("lon") is None:
            raise ValueError("у новой заявки нет координат: нужны lat и lon")
        lat, lon = float(event["lat"]), float(event["lon"])

        oid = event.get("order") or self._next_order_id()
        taken = {o.id for o in day.orders} | {e["order"] for e in self.events
                                              if e["kind"] == "order_new"}
        if oid in taken:
            raise ValueError(f"заявка {oid} уже есть")

        at = rec["at"]
        w_start = int(event.get("window_start", at))
        w_end = int(event.get("window_end", at + DEFAULT_WINDOW_MINUTES))

        # Окно подрезается границей суток этого дня. Без подрезки заявка,
        # сообщённая в 21:30, получала окно до 24:30, а с ним и срок
        # обязательства за границей дня — и `Order.must_today`, который
        # сравнивает срок с `hard_end`, объявлял её переносимой на
        # завтра. То есть настоящее обязательство на сегодня теряло
        # двойной вес (`sla_weight`) ровно там, где оно и возникает.
        if w_start >= day.hard_end:
            raise ValueError(
                f"заявка в {w_start} мин, а день кончается в {day.hard_end}: "
                f"сегодня её уже не выполнить")
        w_end = min(w_end, day.hard_end)
        if w_end <= w_start:
            raise ValueError(f"окно {w_start}–{w_end} пустое")

        priority = int(event.get("priority", 2))
        if priority not in (0, 1, 2):
            raise ValueError(f"приоритет {priority}; бывает 0, 1 или 2")

        est = int(event.get("est_minutes", WORK_TYPES[code].est_minutes))
        if est <= 0:
            raise ValueError(f"длительность {est} минут")

        rec.update({
            "order": oid, "work_type": code, "lat": round(lat, 6),
            "lon": round(lon, 6), "window_start": w_start, "window_end": w_end,
            "sla_deadline": min(int(event.get("sla_deadline", w_end)),
                                day.hard_end),
            "priority": priority, "est_minutes": est,
            "address": event.get("address"),
        })
        self.events.append(rec)
        return rec

    def _next_order_id(self) -> str:
        n = sum(1 for e in self.events if e["kind"] == "order_new")
        return f"N{n:04d}"

    def orders(self, day: Day) -> list[Order]:
        """Заявки, поступившие за день, как обычные `Order`."""
        net = day.network
        out: list[Order] = []
        for e in self.events:
            if e["kind"] != "order_new":
                continue
            node = net.nearest_node(e["lat"], e["lon"])
            district = min(DISTRICTS, key=lambda d: (d[1] - e["lat"]) ** 2
                           + ((d[2] - e["lon"]) * 0.57) ** 2)[0]
            address = e.get("address")
            if address is None:
                address = getattr(net.nodes[node], "text", None)
            out.append(Order(
                id=e["order"], work_type=e["work_type"], district=district,
                lat=e["lat"], lon=e["lon"], node=node, address=address,
                window_start=e["window_start"], window_end=e["window_end"],
                sla_deadline=e["sla_deadline"], priority=e["priority"],
                est_minutes=e["est_minutes"],
                # Граница суток берётся у дня, а не из умолчания поля
                # (`DAY_HARD_END`, 21:00): у заказчика она 22:00, и с
                # чужой границей `must_today` у журнальной заявки
                # считался бы по синтетической. Остальные места, где
                # строится `Order`, ставят её явно — `load.py` и
                # `replan.py`; журнал был единственным исключением.
                hard_end=day.hard_end,
            ))
        return out

    def augmented(self, day: Day) -> Day:
        """День вместе с заявками, поступившими по ходу дела."""
        extra = self.orders(day)
        if not extra:
            return day
        import copy

        out = copy.copy(day)
        out.orders = list(day.orders) + extra
        return out

    def unplaced(self, day: Day) -> list[Order]:
        """Поступившие заявки, которые ещё никому не отданы и не закрыты."""
        placed = {oid for ids in self.assignment.values() for oid in ids}
        seen = self.reported()
        return [o for o in self.orders(day)
                if o.id not in placed and o.id not in seen]

    def reset(self) -> None:
        self.events = []

    # ---------- разбор ----------

    def reported(self) -> set[str]:
        return {e["order"] for e in self.events if e["kind"] in ("done", "failed")}

    def holder(self, order_id: str) -> str | None:
        for eng_id, ids in self.assignment.items():
            if order_id in ids:
                return eng_id
        return None

    def absent(self) -> set[str]:
        """Инженеры, которых сегодня уже не будет."""
        out: set[str] = set()
        for e in self.events:
            if e["kind"] == "engineer_out":
                out.add(e["engineer"])
            elif e["kind"] == "engineer_back":
                out.discard(e["engineer"])
        return out

    def delays(self) -> dict[str, int]:
        """Инженер -> на сколько минут задержится, по последнему сообщению."""
        out: dict[str, int] = {}
        for e in self.events:
            if e["kind"] == "engineer_delayed":
                out[e["engineer"]] = e["minutes"]
            elif e["kind"] == "engineer_back":
                out.pop(e["engineer"], None)
        return out

    def state(self, day: Day, at: int, duration_factor: float = 1.0) -> DayState:
        """
        Собрать состояние дня из того, о чём отчитались.

        Тот же `DayState`, что возвращает `simulate_until`, только факты в
        нём не разыграны, а сообщены. Инженер стоит там, где закончил
        последний свой визит, и свободен с того момента; о ком не
        сообщали ничего — тот дома и свободен с начала смены.

        Кто «в пути», тот занят своей заявкой: выехал оттуда, где стоял, в
        час, названный событием, и освободится у заявки, когда закончит
        работу. Дорога — по сети на час выезда, работа — по нормативу с
        множителем длительности: так же, как их считает планировщик.
        """
        state = DayState(at=at)
        by_id = {o.id: o for o in self.augmented(day).orders}
        инженеры = {e.id: e for e in day.engineers}
        едут = self.underway()

        last: dict[str, tuple[int, int]] = {}   # инженер -> (узел, когда освободился)
        for e in sorted(self.events, key=lambda x: x["at"]):
            if e["kind"] == "done":
                state.done.add(e["order"])
                state.done_by[e["order"]] = e["engineer"]
            elif e["kind"] == "failed":
                state.failed[e["order"]] = e["reason"]
            elif e["kind"] == "en_route" and едут.get(e["order"]) == e["engineer"]:
                order = by_id[e["order"]]
                eng = инженеры[e["engineer"]]
                node, _ = last.get(eng.id, (eng.home_node, eng.shift_start))
                дорога = int(round(day.network.travel_minutes(
                    node, order.node, e["at"], eng.transport)))
                начало = max(e["at"] + дорога, order.window_start)
                конец = начало + int(round(order.est_minutes * duration_factor))
                state.underway[order.id] = eng.id
                last[eng.id] = (order.node, конец)
                continue
            else:
                continue
            order = by_id.get(e["order"])
            if order is not None:
                last[e["engineer"]] = (order.node, e["at"])

        seen = self.reported() | set(state.underway)
        for eng in day.engineers:
            mine = self.assignment.get(eng.id, [])
            state.pending[eng.id] = [oid for oid in mine if oid not in seen]
            node, free_at = last.get(eng.id, (eng.home_node, eng.shift_start))
            state.position[eng.id] = (node, max(free_at, at))
        return state

    def summary(self) -> dict:
        """Что показать на экране: сколько закрыто, сколько сорвано, кого нет."""
        failed: dict[str, int] = {}
        for e in self.events:
            if e["kind"] == "failed":
                failed[e["reason"]] = failed.get(e["reason"], 0) + 1
        assigned = sum(len(v) for v in self.assignment.values())
        статусы = self.statuses()
        return {
            "dispatched": sum(1 for v in статусы.values() if v == "отправлено"),
            "underway": self.underway(),
            "events": len(self.events),
            "new_orders": len([e for e in self.events if e["kind"] == "order_new"]),
            "done": len([e for e in self.events if e["kind"] == "done"]),
            "failed": sum(failed.values()),
            "failed_by_reason": failed,
            "absent": sorted(self.absent()),
            "delayed": self.delays(),
            "assigned_now": assigned,
            "pending_now": assigned - len(self.reported()),
        }
