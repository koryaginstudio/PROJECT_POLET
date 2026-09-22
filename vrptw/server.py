"""
HTTP-сервер поверх стенда: то же, что лежит в фикстурах, но живьём.

Фикстуры годятся, пока интерфейс рисуют. Дальше нужен работающий
механизм: нажали «авария в 13:40» — и через полторы секунды пришёл
новый план, а не заранее записанный файл. Этот модуль и есть та
граница, вдоль которой фронт и солвер разъезжаются по разным людям.

Сервер отдаёт ровно то, что описано в `CONTRACT.md`, ничего сверх.
Поэтому переключение с фикстур на сервер — это замена

    fetch('day-01/plan.json')   →   fetch('http://localhost:8000/api/plan?day=1')

и больше ничего.

Зависимостей нет: только стандартная библиотека, numpy и scipy, которые
и так нужны стенду. Никакого Flask ставить не требуется.

    python3 -m vrptw.server              порт 8000, день 1 прогрет заранее
    python3 -m vrptw.server 8080         другой порт
    python3 -m vrptw.server 8000 1,2,7   прогреть несколько дней
    python3 -m vrptw.server 8000 восток  прогреть зону заказчика

Счёт дня занимает несколько секунд, поэтому готовые формы кладутся в
`.vrptw-cache/` рядом с рабочей папкой и переживают перезапуск сервера.
"""

from __future__ import annotations

import copy
import hashlib
import json
import random
import sys
import threading
import time
import traceback
import uuid
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .core.generate import generate_day
from .core.load import REGIONS, TRANSPORT_REQUIRED, load_day
from . import uploads
from .core.domain import (EQUIPMENT, REAL_WORK_TYPES, RESERVE_PER_TYPE,
                          SKILL_TITLES, TRANSPORT, Plan, Route, Visit,
                          equipment_text)
from .core.network import default_network
from .core.simulate import monte_carlo
from .core.validate_day import check as validate_day_check
from .export import (SCHEMA_VERSION, build_explain, build_plan, build_shifts,
                     build_simulation)
from .journal import Journal
from .settings import LIMITS as SETTING_LIMITS
from .settings import Settings
from .replan import (apply_dropout, carve_remainder, morning_kit, plan_as_is,
                     simulate_until, stability, stock_left, urgent_orders)
from .shiftopt import apply as apply_shifts
from .shiftopt import optimize, refine
from .staffing import сколько_нужно
from .state import (compares_path, изменить_список, прочитать_список,
                    replans_dir, runs_path, use_state_dir)
from .solvers import fast, improved, sequential

_CHURN_LIMITS = SETTING_LIMITS["churn_penalty"]

CACHE_DIR = Path(".vrptw-cache")

# Готовые планы: то же, что `.vrptw-cache`, но лежит в репозитории и только
# читается. Без них первый запуск на чужой машине — три с лишним минуты
# счёта трёх зон; с ними — секунды. Кладёт их `python3 -m vrptw.server
# готовые`, и это последний шаг перед отправкой: имя файла несёт отпечаток
# кода, и после любой правки движка готовые планы молча перестают
# подходить — тогда движок просто посчитает сам, как без них.
READY_DIR = Path(__file__).resolve().parent / "data" / "готовые"


def _кэш(имя: str) -> Path | None:
    """Файл кэша по имени: сперва свой `.vrptw-cache`, потом готовые."""
    for каталог in (CACHE_DIR, READY_DIR):
        путь = каталог / имя
        if путь.exists():
            return путь
    return None


def _план_в_словарь(plan: Plan, секунд: float | None = None) -> dict:
    """План целиком, с временами визитов: прочитанный обратно, он тот же.

    `solve_seconds` — сколько солвер думал над ним, когда решал: карточка
    расчёта показывает это число, и у плана с диска оно должно быть тем
    же, а не нулём."""
    return {
        "solve_seconds": секунд,
        "routes": {e: [[v.order.id, v.arrive, v.start, v.finish, v.travel]
                       for v in r.visits] for e, r in plan.routes.items()},
        "unassigned": [o.id for o in plan.unassigned],
        "duration_factor": plan.duration_factor,
        "pinned": plan.pinned,
        "stock": plan.stock,
    }


def _план_из_словаря(day, raw: dict) -> Plan:
    """Обратно в план этого дня. Чужой день — KeyError на первом же номере."""
    заявки = {o.id: o for o in day.orders}
    люди = {e.id: e for e in day.engineers}
    return Plan(
        routes={e: Route(engineer=люди[e],
                         visits=[Visit(order=заявки[i], arrive=a, start=s,
                                       finish=f, travel=t)
                                 for i, a, s, f, t in визиты])
                for e, визиты in raw["routes"].items()},
        unassigned=[заявки[i] for i in raw["unassigned"]],
        duration_factor=raw["duration_factor"],
        pinned=raw["pinned"],
        stock=raw["stock"],
    )


@lru_cache(maxsize=1)
def отпечаток_кода() -> str:
    """Короткий хэш всего, из чего складывается план.

    Дисковый кэш знал только отпечаток пользовательских настроек и не
    замечал правку самого движка: после неё возвращался вчерашний план, и
    заметить это было нечем — ответ не несёт ни версии кода, ни времени
    расчёта. Отсюда и правило «после правки солвера — `rm -rf
    .vrptw-cache` руками», то есть ручная дисциплина там, где можно
    посчитать.

    **Хэш содержимого, а не mtime.** Время правки здесь врёт дважды:
    в самом репозитории у `replan.py` mtime 16-го, а закоммичен он 17-м —
    порядок mtime и порядок правок уже разошлись; а после `git clone` или
    `checkout` mtime сбрасывается в момент выкладки, и весь код выглядит
    новее любого кэша.

    Берём все `.py` движка целиком, без списка «важных»: список надо
    помнить и пополнять, а забытый в нём модуль — это молчаливо
    протухший кэш, то есть ровно то, от чего мы тут защищаемся. Цена —
    лишний пересчёт после правки замера, который на план не влияет; она
    несопоставима с ценой одного тихо устаревшего плана.

    Данные — только те файлы, которые читает загрузчик (`REGIONS`).
    Контрольных выгрузок среди них нет и быть не должно: постановщик
    запретил их во всех расчётах, а хэш содержимого — это чтение.
    """
    корень = Path(__file__).resolve().parent
    файлы = sorted(p for p in корень.rglob("*.py")
                   if "__pycache__" not in p.parts)
    файлы += [Path(p) for p in sorted(map(str, REGIONS.values()))]

    # Нечитаемое пропускаем. `rglob("*.py")` возвращает и каталоги с
    # таким именем, и битые ссылки, а отпечаток считается на каждом
    # запросе плана и в `/api/health` — падение здесь роняет весь стенд,
    # включая ручку «жив ли он». Пропуск безопаснее: в худшем случае
    # отпечаток не заметит правку в файле, который всё равно не читается.
    файлы = [p for p in файлы if p.is_file()]

    h = hashlib.sha1()
    for путь in файлы:
        # Имя в хэш тоже: переименование модуля меняет поведение импорта,
        # а содержимое при этом может не измениться ни на байт.
        try:
            h.update(str(путь.relative_to(корень.parent)).encode("utf-8"))
        except ValueError:
            h.update(путь.name.encode("utf-8"))
        h.update(путь.read_bytes())
    return h.hexdigest()[:8]


def чужие_ломаные(d: dict) -> list[str]:
    """Перегоны, чья ломаная начинается не там, откуда выезжают.

    Конец ломаной сверять бесполезно: выгрузка сама пристёгивает к ней
    дом заявки. Так эта проверка и пропускала чужие ломаные: сети зон
    читали московский кэш по номерам узлов, и перегон E05 на
    югоцентре начинался в 13,7 км от точки выезда — а конец был на
    месте. Начало пристегнуть некому, оно и выдаёт подмену. Допуск —
    полкилометра: OSRM прижимает дом к ближайшей дороге."""
    from .core.geo import haversine_km
    дом = {e["id"]: (e["home_lat"], e["home_lon"]) for e in d["engineers"]}
    где = {o["id"]: (o["lat"], o["lon"]) for o in d["orders"]}
    плохие = []
    for r in d["routes"]:
        откуда = дом[r["engineer_id"]]
        for s in r["stops"]:
            начало = s["geometry"][0]
            if haversine_km(откуда[0], откуда[1], начало[0], начало[1]) > 0.5:
                плохие.append(s["order_id"])
            откуда = где[s["order_id"]]
    return плохие


def ключ_кэша(st: Settings) -> str:
    """Хвост имени файла кэша: отпечаток настроек и отпечаток кода.

    Двумя токенами, а не одним слитым: так `/api/days` может отличить
    файл, посчитанный нынешним кодом, от оставшегося от прежнего. Со
    слитым токеном устаревшие файлы продолжали бы числиться «готовыми»,
    хотя отданы уже не будут, — то есть на месте одной тихой неправды
    завелась бы другая.
    """
    return f"{st.fingerprint()}-{отпечаток_кода()}"

# Архив расчётов. Интерфейс заводит расчёт кнопкой «Создать расчёт»,
# открывает его из истории и пишет к нему заметку — значит история
# должна пережить перезапуск движка, как журнал и настройки.
# Путь — в `state.py`: состояние умеет уезжать во временный каталог.

# Сохранённые сравнения. Движок их не считает: он складывает рядом уже
# посчитанное и помнит, что и когда сравнивали. Цифры хранятся снимком, а
# не ссылками на расчёты: расчёт могут переименовать или удалить, а
# сравнение обязано остаться читаемым — оно отвечает на вопрос «что мы
# видели, когда принимали решение».
# Путь — там же, по той же причине.

# Границы набора сравнения. Одного расчёта мало — сравнивать не с чем;
# больше восьми на экран не влезет, и это не таблица, а витрина.
COMPARE_MIN, COMPARE_MAX = 2, 8


class NotFound(LookupError):
    """Запрошенной записи нет. Отдаётся кодом 404, а не 400.

    Раньше пропавший расчёт или сравнение отвечали 400 «плохой параметр» —
    и интерфейс не мог отличить свою ошибку в запросе от записи, которую
    удалили из другого окна."""


class Устарело(Exception):
    """Запрос опирается на состояние, которого уже нет. Отдаётся кодом 409.

    «Принять» пересчёт, после которого в журнал уже что-то сообщили, —
    не ошибка в запросе (400) и не пропавшая запись (404): человек видел
    план, посчитанный от другого дня, и его надо пересчитать заново."""


def _отпечаток_журнала(assignment: dict, events: list) -> str:
    """Короткий хэш журнала: назначения и события, без порядка ключей."""
    return hashlib.sha1(json.dumps({"a": assignment, "e": events}, sort_keys=True,
                                   ensure_ascii=False).encode()).hexdigest()[:16]

# ---------------------------------------------------------------------
# Идентификатор дня
# ---------------------------------------------------------------------
#
# До 15 сентября день был просто номером синтетического набора, 1…30.
# Теперь источников два: синтетика для замеров и три зоны обслуживания
# заказчика для демонстрации. Идентификатор стал строкой — либо номер,
# либо имя зоны, — чтобы обе жили в одних и тех же ручках и фронту не
# пришлось знать про два разных мира.
#
# Заодно закрыта старая дыра: `?day=999` считался как ни в чём не бывало,
# отъедал минуту процессорного времени и клал мусор в кэш. Теперь
# идентификатор проверяется на входе.

ZONES: tuple[str, ...] = tuple(REGIONS)
SYNTHETIC_DAYS = range(1, 31)


def parse_day(raw) -> str:
    """Проверить и привести идентификатор дня. Кидает ValueError."""
    ident = str(raw).strip().lower()
    if ident in ZONES:
        return ident
    # Выгрузка, которую принёс диспетчер (`uploads.py`): день такой же
    # настоящий, как зона, но живёт в каталоге состояния, а не в
    # репозитории, и существует, только пока лежит там.
    if ident.startswith(uploads.ПРЕФИКС):
        if uploads.это_выгрузка(ident):
            return ident
        raise ValueError(f"выгрузки {raw!r} нет: её не загружали или удалили")
    try:
        n = int(ident)
    except ValueError:
        raise ValueError(
            f"день {raw!r} не опознан: это либо зона "
            f"({', '.join(ZONES)}), либо выгрузка «{uploads.ПРЕФИКС}…», "
            f"либо номер от 1 до 30")
    if n not in SYNTHETIC_DAYS:
        raise ValueError(f"синтетический день {n} вне диапазона 1…30")
    return str(n)


def is_zone(ident: str) -> bool:
    return ident in ZONES


def is_real(ident: str) -> bool:
    """Настоящий день: зона заказчика или выгрузка, которую принесли."""
    return is_zone(ident) or uploads.это_выгрузка(ident)


def seed_of(ident: str) -> int:
    """Зерно случайности. У зон своё, вне диапазона синтетических дней,
    чтобы прогон зоны нельзя было спутать с прогоном дня номер N; у
    выгрузок — своё у каждой, вне обоих."""
    if is_zone(ident):
        return 9000 + ZONES.index(ident)
    if ident.startswith(uploads.ПРЕФИКС):
        return uploads.сид(ident)
    return int(ident)


def slug(ident: str) -> str:
    """Безопасное имя для файла кэша."""
    return f"{int(ident):02d}" if ident.isdigit() else f"зона-{ident}"
# Если рядом есть папка web/, сервер отдаёт её как статику: интерфейс и
# данные открываются с одного адреса, и CORS перестаёт существовать.
WEB_DIR = Path("web")
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".map": "application/json",
}
DEFAULT_PORT = 8000
LNS_SECONDS = 8.0
REPLAN_SECONDS = 1.5
MC_RUNS = 300

def _params(settings: Settings, seconds: float = LNS_SECONDS,
            **extra) -> improved.Params:
    """Параметры солвера по текущим настройкам пользователя."""
    return settings.params(lns_seconds=seconds, **extra)


class Stand:
    """Стенд целиком: сеть, дни, планы, кэш форм.

    Дорожная сеть строится один раз — это несколько секунд и десятки
    мегабайт, держать её на запрос нельзя. Всё остальное считается
    лениво и запоминается.
    """

    def __init__(self):
        self.net = default_network()
        self._days: dict[str, tuple] = {}
        self._forms: dict[str, dict] = {}
        self._baselines: dict[str, object] = {}
        self._tuned: dict[int, dict] = {}
        self._replans: dict[tuple, dict] = {}
        # Последний показанный пересчёт от журнала по каждому дню: журнал
        # до него, план после и ярлык. «Принять» усваивает ровно его.
        self._показанные: dict[str, dict] = {}
        # Замок на день: пока прогрев считает зону, запрос по ней ждёт его,
        # а не считает ту же зону второй раз параллельно.
        self._замки: dict[str, threading.RLock] = {}
        # Откуда взят план дня: каталог кэша либо None — решён только что.
        # Формы читаются только оттуда же: они — пара к своему плану.
        # Ключ — день и отпечаток переменных: у расчёта с переменными свой
        # план, у компании свой, и оба живут на диске одинаково.
        self._откуда: dict[tuple, Path | None] = {}
        self._решал: dict[tuple, float | None] = {}
        # Сам день — один на все переменные: заявки и бригада от них не
        # зависят, зависит только план.
        self._голые: dict[str, object] = {}
        self._journals: dict[int, Journal] = {}
        self.settings = Settings.load()
        self._lock = threading.Lock()
        self._runs: list[dict] = self._load_runs()
        self._compares: list[dict] = self._load_compares()
        CACHE_DIR.mkdir(exist_ok=True)

    # ---------- день и план ----------

    def day_and_plan(self, ident: str, st: Settings | None = None):
        """
        День и план по идентификатору: зона заказчика или номер синтетики.

        `st` — переменные расчёта; без них — настройки компании. План
        расчёта с переменными живёт так же, как план компании: на диске по
        ключу переменных и кода. Прежде он решался отдельно внутри форм и
        не хранился — и пересчёт от такого расчёта опереть было не на что.

        У зон своя дорожная сеть — она построена под их собственные
        адреса и лежит в кэше рядом с данными. Подставлять сюда общую
        московскую значило бы приклеивать настоящий дом к ближайшему из
        шестисот синтетических и ошибаться на километр в каждом перегоне.
        """
        st = st or self.settings
        ключ = (ident, ключ_кэша(st))
        with self._lock:
            if ключ in self._days:
                return self._days[ключ]
        with self._замок_дня(ident):
            with self._lock:
                if ключ in self._days:
                    return self._days[ключ]

            rng = seed_of(ident)
            with self._lock:
                day = self._голые.get(ident)
            if day is None:
                if is_zone(ident):
                    day = load_day(ident, quiet=True)
                elif uploads.это_выгрузка(ident):
                    day = uploads.день(ident)
                else:
                    day = generate_day(seed=rng, network=self.net)
                with self._lock:
                    self._голые[ident] = day

            # План дня лежит на диске рядом с формами. Прежде он решался
            # заново при каждом запуске — восемь секунд по бюджету, и
            # маршруты от запуска к запуску могли выйти другими: экран
            # показывал формы с диска, а пересчёт и журнал вели от нового
            # плана. Прочитанный план проверяется, как решённый.
            имя = f"plan-{slug(ident)}-{ключ_кэша(st)}.json"
            plan, откуда, секунд = None, None, None
            путь = _кэш(имя)
            if путь is not None:
                try:
                    сырой = json.loads(путь.read_text())
                    plan = _план_из_словаря(day, сырой)
                    if plan.check_invariants(day):
                        plan = None
                    else:
                        откуда, секунд = путь.parent, сырой.get("solve_seconds")
                except (KeyError, ValueError, TypeError, OSError):
                    plan = None
            if plan is None:
                начало = time.time()
                plan = fast.solve(day, params=_params(st), seed=rng)
                секунд = round(time.time() - начало, 2)
                # Проверяется, как и всякий отдаваемый план, — в том числе с
                # переменными расчёта: `duration_factor` от 0,5 до 2,0.
                problems = plan.check_invariants(day)
                if problems:
                    raise RuntimeError(f"план невалиден: {problems[:2]}")
                CACHE_DIR.mkdir(exist_ok=True)
                (CACHE_DIR / имя).write_text(json.dumps(
                    _план_в_словарь(plan, секунд), ensure_ascii=False))
            with self._lock:
                self._days[ключ] = (day, plan)
                self._откуда[ключ] = откуда
                self._решал[ключ] = секунд
            return day, plan

    def _замок_дня(self, ident: str) -> threading.RLock:
        with self._lock:
            return self._замки.setdefault(ident, threading.RLock())

    def baseline(self, ident: str):
        """
        План базового варианта, заданного в ТЗ дословно.

        Нужен для обязательного сравнения: «количество задействованных
        исполнителей, пробег по каждому исполнителю и суммарно по плану,
        сравнение с базовым вариантом». Наш `greedy` на эту роль не
        годится — он сортирует заявки и выбирает самого дешёвого
        исполнителя, то есть уже оптимизирует.
        """
        with self._lock:
            if ident in self._baselines:
                return self._baselines[ident]
        day, _ = self.day_and_plan(ident)
        plan = sequential.solve(day)
        problems = plan.check_invariants(day)
        if problems:
            raise RuntimeError(f"базовый план невалиден: {problems[:2]}")
        with self._lock:
            self._baselines[ident] = plan
        return plan

    # ---------- четыре формы ----------

    def forms(self, ident: str, fresh: bool = False,
              settings: Settings | None = None,
              timings: dict | None = None) -> dict:
        """Четыре формы дня — под замком дня, чтобы не считать вдвоём."""
        with self._замок_дня(ident):
            return self._формы(ident, fresh, settings, timings)

    def _формы(self, ident: str, fresh: bool = False,
               settings: Settings | None = None,
               timings: dict | None = None) -> dict:
        """Четыре формы дня.

        `settings` задаётся, когда считаем расчёт с переменными, которые
        прислал интерфейс: трогать глобальные настройки ради одного
        расчёта нельзя — они общие для всех запросов. Без аргумента
        поведение в точности прежнее.
        """
        st = settings or self.settings
        ключ = (ident, ключ_кэша(st))
        # План — тот же, что у пересчёта и журнала от этого расчёта: один на
        # день и переменные, с диска. Формы — пара к нему.
        day, plan = self.day_and_plan(ident, st)
        if timings is not None:
            # Только счёт плана. Подбор смен и симуляция — это другие формы,
            # и складывать их в «сколько думал солвер» нельзя: интерфейс
            # показывает это число как нашу заслугу.
            timings["solve_seconds"] = self._решал.get(ключ)
        with self._lock:
            if not fresh and ключ in self._forms:
                return self._forms[ключ]
        rng = seed_of(ident)

        # В имени файла — отпечаток настроек: посчитанный на прежних
        # значениях день не должен выдаваться за нынешний. Формы читаются
        # только из того каталога, откуда взят план; план решён только что —
        # считаем и формы, какие бы ни лежали: они от другого плана.
        path = CACHE_DIR / f"day-{slug(ident)}-{ключ_кэша(st)}.json"
        откуда = self._откуда.get(ключ)
        if not fresh and откуда is not None and (откуда / path.name).exists():
            forms = json.loads((откуда / path.name).read_text())
            with self._lock:
                self._forms[ключ] = forms
            return forms
        params = _params(st)

        # Длина смены у каждого своя: в наборе заказчика есть частичные
        # ставки. На синтетике все смены девятичасовые, поэтому `None`
        # даёт там ровно прежний результат.
        starts = optimize(day, restarts=12, seed=rng, shift_len=None).starts
        starts, _ = refine(day, starts, solver_seed=rng,
                           sim_seed=rng + 7000, rounds=2, shift_len=None)
        tuned = apply_shifts(day, starts, shift_len=None)
        tuned_plan = fast.solve(tuned, params=params, seed=rng)

        coverage_now = monte_carlo(day, plan, runs=MC_RUNS, seed=rng).coverage * 100
        coverage_rec = monte_carlo(tuned, tuned_plan, runs=MC_RUNS,
                                   seed=rng).coverage * 100

        forms = {
            # Сеть берём у дня, а не общую: у зон заказчика она своя,
            # построенная под их адреса. С общей номера узлов остались бы
            # в допустимом диапазоне, и ломаная на карте молча указывала
            # бы не туда.
            "plan": build_plan(day, plan, day.network, st.risk_high,
                              st.risk_medium,
                              baseline=self.baseline(ident)),
            "explain": build_explain(day, plan, params),
            "simulation": build_simulation(day, plan, runs=MC_RUNS, seed=rng),
            "shifts": build_shifts(day, starts, coverage_now, coverage_rec),
        }
        path.write_text(json.dumps(forms, ensure_ascii=False))
        with self._lock:
            self._forms[ключ] = forms
        return forms

    # ---------- пересчёт внутри дня ----------

    # ---------- настройки ----------

    def update_settings(self, changes: dict) -> dict:
        """
        Поменять настройки и забыть всё, что посчитано на прежних.

        Кэш сбрасывается целиком нарочно. Он существует, чтобы день не
        считался заново на каждый запрос, а не чтобы показывать вчерашние
        числа под сегодняшними настройками.
        """
        with self._lock:
            changed = self.settings.apply(changes)
            self.settings.save()
            if changed:
                self._days.clear()
                self._forms.clear()
                self._tuned.clear()
                self._replans.clear()
        return {"changed": changed, "settings": self.settings.describe()}

    # ---------- журнал: то, о чём отчитался диспетчер ----------

    def основа(self, ident: str | None, base: str | None) -> tuple[str, Settings, str]:
        """От чего считать пересчёт и вести журнал: день, переменные, ключ.

        `base` — расчёт из архива, открытый у диспетчера: его день, его
        переменные, его план и свой журнал. Без него — план компании, как
        было. Прежде пересчёт и журнал всегда шли от плана компании, и у
        расчёта с множителем длительности 2,0 «Воздействия» и статусы
        работали с другим планом, чем был на экране.
        """
        if not base:
            if ident is None:
                raise ValueError("нет ни day, ни base: не знаю, от чего считать")
            return ident, self.settings, ident
        запись = self._run(base)
        if запись.get("replan") is not None or запись.get("kind"):
            raise ValueError(
                f"{запись['code']} — сохранённый пересчёт, остаток дня: основой "
                f"пересчёта и журнала он быть не может — откройте расчёт дня")
        день = parse_day(запись["day"])
        if ident is not None and ident != день:
            raise ValueError(f"расчёт {запись['code']} — по дню {день}, а спрошен {ident}")
        st, _ = self._settings_for(запись["params"])
        return день, st, f"{день}@{base}"

    def journal(self, ident: str, base: str | None = None) -> Journal:
        """Журнал дня или открытого расчёта. Пустой заводится от его плана."""
        ident, st, ключ = self.основа(ident, base)
        with self._lock:
            j = self._journals.get(ключ)
            if j is None:
                j = Journal.load(ident, base)
                self._journals[ключ] = j
        if not j.assignment:
            _day, plan = self.day_and_plan(ident, st)
            j.adopt(plan)
            j.save()
        return j

    def record(self, ident: str, event: dict, base: str | None = None) -> dict:
        """Записать событие и вернуть его вместе со сводкой по дню."""
        ident, st, _ключ = self.основа(ident, base)
        day, plan = self.day_and_plan(ident, st)
        j = self.journal(ident, base)
        with self._lock:
            if event.get("kind") == "assigned":
                self._check_equipment(day, plan, j, event, st)
            rec = j.add(day, event)
            j.save()
        return {"recorded": rec, "summary": j.summary()}

    def _check_equipment(self, day, plan, j: Journal, event: dict,
                         st: Settings) -> None:
        """Закрепить заявку можно только за тем, у кого есть нужный прибор.

        Остаток — утренняя выдача минус установленное и везомое на заявку
        «в пути». Сравнивается одна заявка с остатком, без прочего
        маршрута: что из маршрута не влезет рядом с ней, решит пересчёт, и
        лишнее он оставит без исполнителя с причиной. А заявку, которой
        прибора не хватает даже одной, закреплять бессмысленно — отказ
        словами сейчас честнее, чем «не нашлось места» после пересчёта.
        """
        полный = j.augmented(day)
        заявка = next((o for o in полный.orders if o.id == event.get("order")), None)
        кто = event.get("engineer")
        if заявка is None or not заявка.equipment:
            return
        at = int(event.get("at", 0))
        остаток = stock_left(morning_kit(day, plan),
                             j.state(day, at, st.duration_factor),
                             полный).get(кто)
        if остаток is None:
            return
        нехватка = {k: n - остаток.get(k, 0) for k, n in заявка.equipment.items()
                    if n > остаток.get(k, 0)}
        if нехватка:
            raise ValueError(
                f"у {кто} в машине не хватает для {заявка.id}: "
                f"{equipment_text(нехватка)}")

    def reset_journal(self, ident: str, base: str | None = None) -> dict:
        """Забыть всё сообщённое и вернуться к утреннему плану."""
        ident, st, ключ = self.основа(ident, base)
        _day, plan = self.day_and_plan(ident, st)
        j = self.journal(ident, base)
        with self._lock:
            j.reset()
            j.adopt(plan)
            j.save()
            self._показанные.pop(ключ, None)
        return {"summary": j.summary()}

    def adopt_shown(self, ident: str, token: str, base: str | None = None) -> dict:
        """«Принять» в окне правки: показанный пересчёт от журнала
        становится назначением дня.

        Усваивается ровно показанный план, без нового счёта: пересчёт
        живёт по секундам, и второй счёт дал бы другой. Если после показа
        в журнал что-то сообщили или показан уже другой пересчёт — 409:
        человек видел план от дня, которого больше нет. Повторное «Принять»
        того же ярлыка ничего не меняет.
        """
        ident, _st, ключ = self.основа(ident, base)
        j = self.journal(ident, base)
        with self._lock:
            показ = self._показанные.get(ключ)
            if not показ or показ["token"] != token:
                raise Устарело("этот пересчёт уже не последний показанный по дню — "
                               "пересчитайте заново")
            if not показ["принят"]:
                было = показ["journal_before"]
                if (_отпечаток_журнала(j.assignment, j.events)
                        != _отпечаток_журнала(было["assignment"], было["events"])):
                    raise Устарело("журнал дня изменился после пересчёта — "
                                   "пересчитайте заново")
                j.assignment = copy.deepcopy(показ["assignment"])
                j.save()
                показ["принят"] = True
        return {"adopted": token, "summary": j.summary()}

    def day_state(self, ident: str, at: int, base: str | None = None) -> dict:
        """Что движок думает о дне прямо сейчас — по отчётам диспетчера."""
        ident, настройки, _ключ = self.основа(ident, base)
        day, _plan = self.day_and_plan(ident, настройки)
        j = self.journal(ident, base)
        st = j.state(day, at, настройки.duration_factor)
        return {
            "schema": SCHEMA_VERSION,
            "kind": "state",
            "day": ident,
            "at": at,
            "source": "journal",
            "done": sorted(st.done),
            "failed": st.failed,
            # Статус каждой заявки, о которой что-то сообщили. Остальные в
            # чьём-то маршруте — «назначено».
            "statuses": j.statuses(),
            "underway": st.underway,
            "pending": {e: list(ids) for e, ids in st.pending.items() if ids},
            "position": {e: {"node": n, "free_at": t}
                         for e, (n, t) in st.position.items()},
            "summary": j.summary(),
        }

    # ---------- пересчёт внутри дня ----------

    def replan(self, ident: str, at: int, urgent_count: int = 2,
               cancelled: str | None = None,
               seconds: float = REPLAN_SECONDS, run: int = 0,
               disabled: str | None = None, delayed: str | None = None,
               source: str = "sim", churn_penalty: float | None = None,
               journal_snapshot: dict | None = None,
               urgent_near: str | None = None,
               cached_only: bool = False, base: str | None = None) -> dict:
        """
        Что произойдёт, если в момент `at` придут аварии — и, если задано,
        одновременно выбудет инженер.

        День проигрывается до этого момента одной случайной траекторией
        (`run` выбирает какой именно — интерфейсу нужна повторяемость),
        затем остаток дня пересобирается вместе с авариями.

        `disabled=E03` — инженера сегодня не будет: машина уехала в сервис,
        человек ушёл на больничный. Он исчезает из бригады остатка, его
        незакрытые заявки падают в общий пул.

        `delayed=E03:40` — задержится на 40 минут: прокол, поломка на
        месте. Инженер остаётся, но следующий визит начнёт позже и оттуда,
        где встал.

        Это два разных события, и путать их нельзя. Замер на зонах
        (`замеры-22-09/выбытие-на-зонах.txt`, `прокол-на-зонах.txt`)
        говорит: выбытие утром стоит дню 4,4 визита и пересчёт возвращает
        2,9 ± 1,1 из них — жать надо обязательно. А задержка на 40 минут
        стоит 0,1–0,2 визита, потому что буферы в маршруте её и так съедают, и
        пересчёт из неё не возвращает ничего. Кнопка при этом покажет
        прирост побольше — но это обычная переоптимизация остатка,
        которая была бы полезна и без всякого ЧП. Поэтому в
        ответе разделено: `rescued` — визиты выбывшего, которые
        подхватили другие, `assigned_as_is` — сколько было бы без
        пересчёта.
        """
        if source not in ("sim", "journal"):
            raise ValueError(f"source={source!r}; бывает sim или journal")

        # От чего считать: открытый расчёт (`base`) — его план и переменные,
        # без него — план компании. Прежде пересчёт и журнал всегда шли от
        # плана компании: у открытого расчёта с множителем длительности 2,0
        # «Воздействия» пересчитывали не тот план, что был на экране.
        ident, st, ключ_журнала = self.основа(ident, base)

        # Живой контрол на экране инцидента: диспетчер двигает ползунок и
        # сразу видит, во что обходится стабильность. Не переданный —
        # берётся из настроек компании.
        churn = (st.churn_penalty if churn_penalty is None
                 else float(churn_penalty))
        lo, hi, _what = _CHURN_LIMITS
        if not lo <= churn <= hi:
            raise ValueError(f"churn_penalty = {churn:g} вне пределов {lo:g}…{hi:g}")

        rng = seed_of(ident)
        # Привязка аварии к инженеру без аварий ничего не значит — и не
        # должна ни дробить кэш, ни попадать в ответ.
        if not urgent_count:
            urgent_near = None
        # Журнал и состояние дня в момент `at` — те же, от которых пойдёт
        # пересчёт. По ним же разбираются `auto`: «самый занятой сейчас» и
        # «самая дорогая отмена». Состояние строится, только когда нужно.
        day, plan = self.day_and_plan(ident, st)
        журнал = None
        if source == "journal":
            # Снимок — это журнал, каким он был в момент сохранения
            # карточки. Без него пересчёт из архива считался бы по
            # сегодняшнему журналу, и карточка «46 из 52» открывалась бы
            # «50 из 56»: та же ошибка, что и с утренним планом, только
            # источник состояния другой.
            журнал = (Journal(day=ident,
                              assignment=dict(journal_snapshot.get("assignment", {})),
                              events=list(journal_snapshot.get("events", [])),
                              base=base)
                      if journal_snapshot is not None else self.journal(ident, base))
        готовое_состояние: list = []

        def состояние():
            if not готовое_состояние:
                готовое_состояние.append(
                    журнал.state(day, at, st.duration_factor) if журнал is not None
                    else simulate_until(day, plan, at, random.Random(rng * 1000 + run)))
            return готовое_состояние[0]

        день_заявок = журнал.augmented(day) if журнал is not None else day
        incident = self._incident(ident, disabled, delayed, at, день_заявок, состояние)
        cancelled_ids = self._cancelled(ident, cancelled, at, день_заявок, состояние)
        if cancelled_ids and incident:
            raise ValueError(
                "отмена заявки и ЧП с инженером — разные события; ТЗ просит "
                "показать одно, и мерить их вместе значит не понять, что "
                "дало эффект")
        if cancelled_ids:
            incident = {"kind": "cancelled", "engineer_id": None,
                        "minutes": None, "order_ids": cancelled_ids}
        # Пересчёт по журналу не кэшируется: он зависит от того, что
        # сообщили, а сообщают постоянно. Полторы секунды того стоят.
        key = (ident, at, urgent_count, round(seconds, 2), run,
               incident["engineer_id"] if incident else None,
               incident["minutes"] if incident else None,
               tuple(cancelled_ids),
               round(churn, 3), st.fingerprint(), urgent_near, base)
        if source == "sim":
            with self._lock:
                if key in self._replans:
                    return self._replans[key]
            # Сохранить можно только показанное. Пересчёт живёт по секундам,
            # и новый счёт дал бы другой план: прежде после перезапуска
            # сервера или смены настроек «Сохранить» молча считало заново.
            if cached_only:
                raise Устарело("показанного пересчёта у движка уже нет — сервер "
                               "перезапускали или меняли настройки; пересчитайте "
                               "и сохраните заново")

        journal_new: list = []

        if source == "journal":
            j = журнал
            # Журнал, от которого считаем, — чтобы «Принять» могло
            # убедиться, что с тех пор ничего не сообщили. У карточки из
            # архива (снимок) принимать нечего.
            if journal_snapshot is None:
                with self._lock:
                    до_пересчёта = {"assignment": copy.deepcopy(j.assignment),
                                    "events": copy.deepcopy(j.events)}
            state = состояние()
            # Заявки, поступившие за день, становятся частью дня: их надо
            # видеть и когда они уже кому-то отданы, и когда ещё ничьи.
            day = j.augmented(day)
            # Единственное место, где день перед планированием меняется от
            # того, что ввёл человек. Утренний день проверен загрузчиком, а
            # этот — нет: ловим порчу, которую могла внести запись в
            # журнал, — повторы номеров, пустые окна, узлы вне сети.
            #
            # «Навыком никто не владеет» здесь НЕ поломка. Диспетчер
            # вправе завести заявку на работу, которую в эту смену некому
            # взять; ТЗ просит показать это причиной неназначения, а не
            # отказом считать день. Пока это было поломкой, заявка с явно
            # названным видом работ роняла весь экран инцидента в 400 —
            # причём насовсем: журнал лежит файлом и переживает
            # перезапуск, так что вылечить можно было только сбросив всё,
            # что диспетчер ввёл.
            поломки, _ = validate_day_check(day, навык_без_владельца="предупреждение")
            if поломки:
                raise ValueError(
                    "день с заявками из журнала не годен к планированию:\n  "
                    + "\n  ".join(поломки))
            journal_new = j.unplaced(day)
            # ЧП, о которых сообщили в журнал, действуют без отдельного
            # параметра: диспетчер уже сказал, что человека нет.
            if incident is None:
                gone_ids = sorted(j.absent())
                delayed_now = j.delays()
                if gone_ids:
                    incident = {"kind": "disabled", "engineer_id": gone_ids[0],
                                "minutes": None}
                elif delayed_now:
                    eid = sorted(delayed_now)[0]
                    incident = {"kind": "delayed", "engineer_id": eid,
                                "minutes": delayed_now[eid]}
        else:
            state = состояние()
        # «У кого на участке»: авария приходит на трассу названного
        # инженера — в дом рядом с тем местом, где он сейчас. Прежде вёрстка
        # это поле слала, а движок его молча выбрасывал, и окно правки
        # писало «на участке у N» про аварию где-то по зоне.
        near_node = None
        if urgent_near:
            if urgent_near not in state.position:
                raise ValueError(f"нет инженера {urgent_near}: аварию не к кому привязать")
            near_node = state.position[urgent_near][0]
        urgent = (urgent_orders(day, at, urgent_count, seed=rng, near_node=near_node)
                  if urgent_count else [])
        # Отменить можно только то, что ещё не случилось. Молча принять
        # отмену выполненного визита значило бы соврать диспетчеру, что
        # она учтена.
        поздно = [i for i in cancelled_ids
                  if i in state.done or i in state.failed]
        if поздно:
            raise ValueError(
                f"заявки {', '.join(поздно)} уже завершены на {at // 60}:"
                f"{at % 60:02d} — отменять нечего")

        # Отменённые заявки уходят из остатка: их никто не просит делать,
        # и записывать их в невыполненные было бы враньём.
        rest = carve_remainder(day, state, extra=journal_new + urgent,
                               drop=set(cancelled_ids))

        gone = incident["engineer_id"] if incident else None
        his = set(state.pending.get(gone, [])) if gone else set()
        if incident and incident["kind"] in ("disabled", "delayed"):
            rest = apply_dropout(rest, gone, incident["minutes"])

        # Якорь: кому заявка была назначена до пересчёта. Заявки выбывшего
        # насовсем из якоря исключаются — держаться за исполнителя,
        # которого сегодня не будет, значит штрафовать любую попытку их
        # пристроить кому-то другому.
        anchor = {oid: eid for eid, ids in state.pending.items() for oid in ids}
        if incident and incident["kind"] == "disabled":
            anchor = {oid: eid for oid, eid in anchor.items() if eid != gone}

        # Оборудование в машинах. Утром выдали под утренний план и по
        # штуке запаса; к моменту пересчёта установленное и везомое на
        # заявку «в пути» из машины ушло. Заявку с роутером пересчёт
        # отдаст только тому, у кого роутер остался, — это ограничение
        # обратная связь 20 сентября просила учесть при перепланировании.
        # Работает на обоих источниках состояния: и на разыгранном, и на
        # сообщённом, иначе замер мерил бы другой пересчёт, чем показ.
        запас = stock_left(morning_kit(day, plan), state, day)

        # Закреплённое диспетчером идёт в пересчёт запретом, а не
        # штрафом: человек сказал «поедет этот». Берётся из журнала —
        # значит только на пути от фактов; разыгранная траектория ничьих
        # решений не помнит и помнить не может.
        закреплено = журнал.pinned() if журнал is not None else None

        t0 = time.time()
        new_plan = fast.solve(rest, params=_params(st, seconds, anchor=anchor,
                                                   churn_penalty=churn,
                                                   pinned=закреплено,
                                                   stock=запас),
                              seed=rng)
        elapsed = time.time() - t0
        problems = new_plan.check_invariants(rest)
        if problems:
            raise RuntimeError(f"план пересчёта невалиден: {problems[:2]}")

        # «Как ехали» — для сравнения: столько было бы без пересчёта.
        # Считается по тому же остатку дня, то есть уже с учётом ЧП.
        # И проверяется теми же инвариантами, что и пересчёт: раньше это
        # был единственный план, уходивший на экран без проверки.
        as_is = plan_as_is(rest, state, st.duration_factor)
        problems = as_is.check_invariants(rest)
        if problems:
            raise RuntimeError(f"план «как ехали» невалиден: {problems[:2]}")

        out = build_plan(rest, new_plan, rest.network, st.risk_high,
                             st.risk_medium)
        out["kind"] = "replan"
        out["meta"]["replan"] = {
            "at": at,
            "run": run,
            "source": source,
            "solve_seconds": round(elapsed, 2),
            "churn_penalty": churn,
            "stability": round(stability(plan, new_plan, state), 3),
            "urgent_ids": [o.id for o in urgent],
            # У кого на участке пришла авария; `null` — по зоне.
            "urgent_near": urgent_near,
            # От какого расчёта считали; `null` — от плана компании.
            "base": base,
            "urgent_assigned": sum(
                1 for r in new_plan.routes.values() for v in r.visits
                if v.order.id in {o.id for o in urgent}),
            # Заявки, о которых сообщил диспетчер, и сколько из них влезло.
            "reported_ids": [o.id for o in journal_new],
            "reported_assigned": sum(
                1 for r in new_plan.routes.values() for v in r.visits
                if v.order.id in {o.id for o in journal_new}),
            "done_before": sorted(state.done),
            "failed_before": state.failed,
            # Заявки, к которым исполнитель уже едет: в пересчёте их нет,
            # они его, и он освободится у них после окончания работ.
            "underway": state.underway,
            "assigned_now": new_plan.assigned_count,
            "assigned_as_is": as_is.assigned_count,
        }
        if incident and incident["kind"] == "cancelled":
            # У отмены вопрос другой, чем у ЧП с инженером. Там спрашивают
            # «куда делись его визиты», здесь — «что купила освободившаяся
            # ёмкость»: какие заявки, не влезавшие в исходный план, теперь
            # влезли. Урезанное время считаем по оценке, а не по факту:
            # факта у невыполненного визита нет.
            было = {v.order.id for r in plan.routes.values() for v in r.visits}
            стало = {v.order.id for r in new_plan.routes.values() for v in r.visits}
            свежие = {o.id for o in urgent} | {o.id for o in journal_new}
            подобрано = sorted(стало - было - свежие)

            by_id = {o.id: o for o in day.orders}
            освобождено = sum(by_id[i].est_minutes for i in cancelled_ids
                              if i in by_id)
            out["meta"]["replan"]["incident"] = {
                **incident,
                "freed_minutes": освобождено,
                # Заявки, которые исходный план не брал, а теперь берёт.
                "picked_up": подобрано,
                "picked_up_count": len(подобрано),
                "stability_others": round(stability(plan, new_plan, state), 3),
            }
        elif incident:
            # Куда делись визиты, которые были у него впереди. Три исхода,
            # и на экране это три разных цвета: подхватил кто-то другой,
            # остались за ним (при задержке так и должно быть), не влезли
            # никуда вовсе.
            now_at = {v.order.id: eid for eid, r in new_plan.routes.items()
                      for v in r.visits}
            rescued = sorted(o for o in his if now_at.get(o) not in (None, gone))
            kept = sorted(o for o in his if now_at.get(o) == gone)
            lost = sorted(o for o in his if o not in now_at)

            # Стабильность по тем, кто ни при чём: визиты выбывшего обязаны
            # сменить исполнителя, ставить это в упрёк пересчёту нечестно.
            others = copy.copy(state)
            others.pending = {e: ids for e, ids in state.pending.items() if e != gone}
            out["meta"]["replan"]["incident"] = {
                **incident,
                "pending_was": sorted(his),
                "rescued": rescued,
                "kept": kept,
                "lost": lost,
                "stability_others": round(stability(plan, new_plan, others), 3),
            }
        if source == "journal":
            j = журнал if журнал is not None else self.journal(ident, base)
            # Показ — не решение. Прежде здесь стоял `j.adopt(new_plan)`, и
            # журнал дня переписывался, как только окно правки показывало
            # пересчёт: «Отменить правку» уже ничего не отменяла, а у 6 из 13
            # инженеров востока менялись маршруты от одного взгляда. Теперь
            # пересчёт запоминается как показанный, а назначением дня его
            # делает `POST /api/journal/adopt` с ярлыком — кнопка «Принять».
            if journal_snapshot is None:
                ярлык = hashlib.sha1(repr((key, _отпечаток_журнала(
                    до_пересчёта["assignment"], до_пересчёта["events"]))).encode()
                ).hexdigest()[:16]
                out["meta"]["replan"]["adopt_token"] = ярлык
                with self._lock:
                    self._показанные[ключ_журнала] = {
                        "token": ярлык,
                        "out": out,
                        "journal_before": до_пересчёта,
                        "assignment": {e: [v.order.id for v in r.visits]
                                       for e, r in new_plan.routes.items()},
                        "принят": False,
                    }
            out["meta"]["replan"]["journal"] = j.summary()
            return out

        with self._lock:
            self._replans[key] = out
        return out

    @staticmethod
    def _самый_занятой(state, at: int) -> str:
        """Инженер, у которого в момент `at` больше всего работы впереди.

        Нужен для `auto`. Событие с тем, у кого впереди пусто, — это не
        демонстрация, а пустой ответ: ноль подхваченных, ноль потерянных,
        стабильность единица. Ровно это и случилось с командой из README:
        на зоне «восток» у `E03` вообще нет маршрута, он четырнадцатый при
        тринадцати маршрутах.

        Состояние — то же, от которого пойдёт пересчёт: при пересчёте от
        журнала — сообщённое диспетчером, при разыгранном — та же
        траектория. Прежде «самый занятой» выбирался по своей симуляции
        с другим зерном, и от журнала — тоже по симуляции: выбывшим
        назывался тот, у кого по журналу всё уже сделано.
        """
        по_людям = {eid: len(ids) for eid, ids in state.pending.items() if ids}
        if not по_людям:
            raise ValueError(
                f"в {at // 60:02d}:{at % 60:02d} ни у кого нет работы впереди — "
                f"выберите момент раньше")
        # По числу заявок, при равенстве — по идентификатору, чтобы выбор
        # не зависел от порядка словаря и повторялся от запуска к запуску.
        return max(sorted(по_людям), key=lambda e: по_людям[e])

    @staticmethod
    def _самая_дорогая_отмена(day, state, at: int) -> str:
        """Заявка, отказ от которой освободит больше всего времени.

        Берём из ещё не начатых: отменять уже выполненное бессмысленно.
        При равной длительности — меньший номер, чтобы выбор повторялся.
        Состояние и день — те же, от которых пойдёт пересчёт; день — вместе
        с заявками из журнала.
        """
        впереди = {oid for ids in state.pending.values() for oid in ids}
        годные = [o for o in day.orders if o.id in впереди]
        if not годные:
            raise ValueError(
                f"в {at // 60:02d}:{at % 60:02d} впереди нет ни одного визита — "
                f"отменять нечего, выберите момент раньше")
        return max(sorted(годные, key=lambda o: o.id),
                   key=lambda o: o.est_minutes).id

    def _incident(self, ident: str, disabled: str | None,
                  delayed: str | None, at: int, day,
                  состояние) -> dict | None:
        """Разобрать `disabled=E03` или `delayed=E03:40`. None, если ЧП нет.

        Вместо идентификатора можно написать `auto` — движок возьмёт того,
        у кого в этот момент больше всего работы впереди. Так команда из
        документации остаётся рабочей на любом дне и любой зоне: номера
        инженеров у синтетики и у заказчика разные, а «самый занятой» есть
        везде.
        """
        if disabled and delayed:
            raise ValueError("disabled и delayed вместе не имеют смысла: "
                             "инженер либо задержится, либо не выйдет вовсе")
        if not disabled and not delayed:
            return None

        if disabled:
            eng_id, minutes, kind = disabled, None, "disabled"
        else:
            eng_id, _, raw = delayed.partition(":")
            if not raw:
                raise ValueError("delayed задаётся как E03:40 или auto:40 — "
                                 "инженер и минуты")
            minutes = int(raw)
            if minutes <= 0:
                raise ValueError(f"задержка {minutes} минут — не задержка")
            kind = "delayed"

        if eng_id == "auto":
            eng_id = self._самый_занятой(состояние(), at)

        known = {e.id for e in day.engineers}
        if eng_id not in known:
            raise ValueError(f"нет инженера {eng_id}; есть {sorted(known)} "
                             f"либо auto — самый занятой в этот момент")

        return {"kind": kind, "engineer_id": eng_id, "minutes": minutes}

    def _cancelled(self, ident: str, raw: str | None, at: int, day,
                   состояние) -> list[str]:
        """
        Разобрать `cancelled=R0012,R0031` — абонент отказался от визита.

        Третье из трёх событий пересчёта, которые называет ТЗ. От двух
        других отличается знаком: выбытие инженера и срочная заявка
        отнимают ёмкость дня, отмена её возвращает.

        Вместо номера можно написать `auto` — движок возьмёт заявку, от
        которой отказ освободит больше всего времени. Номера заявок у
        синтетики (`R0038`) и у заказчика (`74198`) устроены по-разному,
        и команда с зашитым номером на зоне отвечает «нет такой заявки».

        Здесь проверяется только существование заявки. Что визит ещё не
        состоялся — проверяется ниже, когда известно состояние дня.
        """
        if not raw:
            return []
        ids = [x.strip() for x in str(raw).split(",") if x.strip()]
        if not ids:
            return []
        if ids == ["auto"]:
            return [self._самая_дорогая_отмена(day, состояние(), at)]

        # День — вместе с заявками из журнала: отменить можно и заявку,
        # которую диспетчер завёл по ходу дня. Прежде её номер отвергался.
        known = {o.id for o in day.orders}
        неизвестные = [i for i in ids if i not in known]
        if неизвестные:
            raise ValueError(
                f"нет заявок {', '.join(неизвестные)} в этом дне")
        return ids

    # ---------- применить подобранные смены ----------

    def with_tuned_shifts(self, ident: str) -> dict:
        """План на том же дне, но по подобранному графику выхода."""
        with self._lock:
            if ident in self._tuned:
                return self._tuned[ident]

        rng = seed_of(ident)
        day, _ = self.day_and_plan(ident)
        starts = optimize(day, restarts=12, seed=rng, shift_len=None).starts
        starts, _ = refine(day, starts, solver_seed=rng,
                           sim_seed=rng + 7000, rounds=2, shift_len=None)
        tuned = apply_shifts(day, starts, shift_len=None)
        plan = fast.solve(tuned, params=_params(self.settings), seed=rng)
        problems = plan.check_invariants(tuned)
        if problems:
            raise RuntimeError(f"план невалиден: {problems[:2]}")

        out = build_plan(tuned, plan, tuned.network, self.settings.risk_high,
                              self.settings.risk_medium)
        out["kind"] = "plan"
        out["meta"]["shifts_applied"] = {
            "starts_by_engineer": {e.id: f"{h:02d}:00"
                                   for e, h in zip(day.engineers, starts)},
            "coverage": round(monte_carlo(tuned, plan, runs=MC_RUNS,
                                          seed=rng).coverage * 100, 1),
        }
        with self._lock:
            self._tuned[ident] = out
        return out

    # ---------- архив расчётов ----------
    #
    # Интерфейс устроен так: человек жмёт «Создать расчёт», выбирает зону и
    # переменные, расчёт попадает в историю, и из неё же открывается — с
    # заметкой, которую человек к нему приписал. Движок до сих пор такого
    # не умел: он считал день по запросу и кэшировал. Здесь — тонкая
    # надстройка над тем, что уже есть: сам счёт идёт через `forms`,
    # архив только помнит, кто, когда и с какими переменными его завёл.

    def _load_runs(self) -> list[dict]:
        # Битый архив — не повод не открыться. История дешёвая: расчёт
        # повторяется по зоне и переменным один в один.
        return прочитать_список(runs_path())

    def _изменить_архив(self, действие):
        """Правка архива на диске, а не в памяти.

        `self._runs` — снимок, сделанный при загрузке, и писать его
        целиком значило бы затирать всё, что дописали другие: рядом
        работают браузер диспетчера, замер из терминала и проверка.
        Поэтому список берётся с диска под блокировкой, правится и
        кладётся обратно, а своя память обновляется тем, что вышло.
        """
        свежие, итог = изменить_список(runs_path(), действие)
        with self._lock:
            self._runs = свежие
        return итог

    def _settings_for(self, params: dict | None) -> tuple[Settings, bool]:
        """Настройки этого расчёта и признак «стоят заводские».

        Переменные приходят в теле запроса и трогать глобальные настройки
        ради одного расчёта нельзя: они общие для всех запросов. Поэтому
        правится копия, а проверка значений переиспользуется та же, что у
        экрана настроек.
        """
        своё = copy.deepcopy(self.settings)
        if params:
            # `apply` возвращает список изменённых имён, а на плохое
            # значение кидает ValueError — её ловит обработчик и отвечает
            # понятной четырёхсоткой. Возвращённое нам не нужно: мы правим
            # копию, глобальные настройки остаются как были.
            своё.apply({k: v for k, v in params.items()
                        if k in SETTING_LIMITS})
        заводские = Settings()
        return своё, своё.fingerprint() == заводские.fingerprint()

    def _add_run(self, ident: str, forms_or_plan: dict, note: str = "",
                 factory: bool | None = True, seconds: float | None = None,
                 params: dict | None = None, пометка: str = "",
                 замысел: dict | None = None) -> dict:
        """Одна запись архива — из четырёх форм или из ответа пересчёта.

        Форма записи общая нарочно: интерфейс читает список одинаково, и
        расчёт, заведённый кнопкой, и сохранённый пересчёт обязаны
        выглядеть одинаково. Разводить их по двум сборщикам значило бы
        завести два места, где поля могут разъехаться.
        """
        план = forms_or_plan.get("plan", forms_or_plan)
        meta = план["meta"]
        balance = meta.get("balance", {})
        симуляция = forms_or_plan.get("simulation") or {}
        # У пересчёта своей симуляции нет: он отвечает планом остатка дня.
        покрытие = симуляция.get("coverage")
        if покрытие is None and meta.get("orders_total"):
            покрытие = round(meta["orders_assigned"] / meta["orders_total"] * 100, 1)
        если_пересчёт = meta.get("replan") or {}
        if seconds is None:
            seconds = если_пересчёт.get("solve_seconds", 0.0)

        now = time.localtime()

        def дописать(текущие: list) -> dict:
            # Номер — по тому, что лежит на диске сейчас, а не по своей
            # памяти: рядом могли дописать, и тогда два расчёта получили
            # бы один код R00N.
            номер = len(текущие) + 1
            запись = {
                # Идентификатор случайный, а не «миллисекунда плюс длина
                # своего списка»: двое, начавшие с одинакового архива в
                # одну миллисекунду, получали один и тот же id.
                "id": f"run-{uuid.uuid4().hex[:12]}",
                "code": f"R{номер:03d}",
                "day": ident,
                "date": meta.get("date", ""),
                "created": time.strftime("%Y-%m-%dT%H:%M", now),
                "note": note,
                "params": params if params is not None
                          else {k: getattr(self.settings, k) for k in SETTING_LIMITS},
                "factory": factory,
                # График смен берётся у дня целиком. Подобранный лежит
                # отдельной формой и частью этого расчёта не является —
                # выдавать его за неё значило бы показать чужой план.
                "shifts_from_day": True,
                "summary": {
                    "orders_total": meta.get("orders_total", 0),
                    "orders_assigned": meta.get("orders_assigned", 0),
                    "unassigned": len(план.get("unassigned", [])),
                    "engineers_total": meta.get("engineers_total", 0),
                    "engineers_on_route": meta.get("metrics", {}).get("engineers_used", 0),
                    "coverage": покрытие or 0.0,
                    "gini": balance.get("gini", 0.0),
                    "occupancy_min": balance.get("occupancy_min", 0.0),
                    "occupancy_max": balance.get("occupancy_max", 0.0),
                    "solve_seconds": round(float(seconds), 2),
                },
            }
            if пометка:
                запись["kind"] = пометка
            # Чем этот расчёт был. Без этого запись помнила только сводку,
            # а `run_forms` пересчитывал по `day` обычный полный день — и
            # карточка «срочные заявки в 13:40, 39 из 42» открывалась
            # утренним планом на 66 заявок. Две разные вещи под одним
            # заголовком, и заметить это можно было только глазами.
            if замысел:
                запись["replan"] = замысел
            запись["forms"] = self._формы_записи(запись)
            текущие.append(запись)
            return запись

        return self._изменить_архив(дописать)

    def create_run(self, ident: str, params: dict | None,
                   note: str = "") -> dict:
        st, factory = self._settings_for(params)
        сроки: dict = {}
        started = time.time()
        forms = self.forms(ident, settings=st, timings=сроки)
        # Если формы пришли из кэша, солвер не работал вовсе — тогда
        # честное число это время чтения, а не выдуманные восемь секунд.
        seconds = сроки.get("solve_seconds")
        if seconds is None:
            seconds = round(time.time() - started, 2)
        return self._add_run(ident, forms, note=note, factory=factory,
                             seconds=seconds,
                             params={k: getattr(st, k) for k in SETTING_LIMITS})

    def save_replan(self, spec: dict, source: str = "sim",
                    note: str = "") -> dict:
        """Положить в архив уже посчитанный пересчёт.

        Движок не считает заново: `replan` с тем же набором попадёт в свой
        кэш и вернётся мгновенно. Пересчитывать здесь было бы не только
        медленно, но и неверно — интерфейс сохраняет ровно то, что человек
        видел на экране, а новый счёт мог бы дать другой план.
        """
        # День обязателен: прежде без него сохранялся пересчёт синтетического
        # дня 1 — тот же класс ошибки, что у остальных записей без `day`.
        if "day" not in spec:
            raise ValueError("в замысле пересчёта нет day")
        ident = parse_day(spec["day"])
        # От какого расчёта считали: его переменные — переменные записи, его
        # журнал — снимок, его показанные — что принять. Без `base` — план
        # компании, как было.
        base = spec.get("base") or None
        ident, st_основы, ключ_журнала = self.основа(ident, base)
        at = int(spec.get("at", 13 * 60 + 40))
        delayed = spec.get("delayed")
        # Замысел сохраняем нормализованным, тем же набором, каким считали:
        # по нему `run_forms` потом поднимет именно этот пересчёт, а не
        # обычный день. Пересчёт кэшируется по этому же набору, так что
        # повторный подъём — чтение, а не счёт.
        # Ползунок с экрана инцидента — часть замысла, а не настройка
        # компании. Прежде он сюда не попадал вовсе, и карточка, снятая
        # при нулевом штрафе, открывалась общей настройкой: устойчивость
        # 0.370 превращалась в 0.915, то есть в другой план.
        ползунок = spec.get("churn_penalty")
        замысел = {
            "day": ident, "at": at,
            "urgent": int(spec.get("urgent", 0) or 0),
            "cancelled": spec.get("cancelled"),
            "run": int(spec.get("run", 0)),
            "disabled": spec.get("disabled"),
            "delayed": delayed,
            "source": source,
            "churn_penalty": None if ползунок is None else float(ползунок),
            # Без аварий привязке не к чему относиться: `replan` её так же
            # обнуляет, и замысел не должен помнить того, чего не считали.
            "urgent_near": ((spec.get("urgent_near") or None)
                            if int(spec.get("urgent", 0) or 0) else None),
            "base": base,
        }
        ярлык_показа, показанный = None, None
        if source == "journal":
            # Снимок журнала на момент сохранения. Без него карточка
            # пересчёта не воспроизводима: журнал живёт файлом и меняется
            # дальше, и открытая назавтра карточка показывала бы другой
            # день, а не тот, который человек видел и сохранил.
            # Снимок — журнал, от которого считали показанный пересчёт, а
            # не нынешний: после «Принять» нынешний уже содержит сам этот
            # план, и карточка, посчитанная от него, показала бы стабильность
            # 1,0 вместо увиденной. Ярлык приходит от вёрстки; без него —
            # нынешний журнал, как было.
            ярлык = spec.get("adopt_token")
            with self._lock:
                показ = self._показанные.get(ключ_журнала)
                if ярлык and (not показ or показ["token"] != ярлык):
                    raise Устарело("этот пересчёт уже не последний показанный по дню — "
                                   "пересчитайте заново")
            if ярлык:
                ярлык_показа, показанный = ярлык, показ
                замысел["journal_snapshot"] = copy.deepcopy(показ["journal_before"])
            else:
                j = self.journal(ident, base)
                with self._lock:
                    замысел["journal_snapshot"] = {
                        "assignment": copy.deepcopy(j.assignment),
                        "events": copy.deepcopy(j.events),
                    }
        if source == "journal" and ярлык_показа and показанный.get("out") is not None:
            # Ровно показанный план, без нового счёта: второй счёт по
            # секундам дал бы другой.
            готовое = copy.deepcopy(показанный["out"])
        else:
            готовое = self.replan(
                ident=ident, at=at,
                urgent_count=замысел["urgent"],
                cancelled=замысел["cancelled"],
                run=замысел["run"],
                disabled=замысел["disabled"],
                delayed=delayed,
                source=source,
                churn_penalty=замысел["churn_penalty"],
                journal_snapshot=замысел.get("journal_snapshot"),
                urgent_near=замысел["urgent_near"],
                cached_only=source == "sim",
                base=base,
            )

        # Замысел нормализуется по тому, что вышло. `auto` — это не выбор,
        # а вопрос «кто сейчас самый занятой» и «от какой заявки отказ
        # освободит больше времени»; ответ на него завтра другой, и
        # карточка «инженер выбыл в 11:40» открывалась бы другим
        # инженером. Записываем ответ, а не вопрос.
        мета_п = готовое["meta"]["replan"]
        инц = мета_п.get("incident") or {}
        замысел["churn_penalty"] = мета_п["churn_penalty"]
        if инц.get("kind") == "disabled":
            замысел["disabled"] = инц["engineer_id"]
        elif инц.get("kind") == "delayed":
            замысел["delayed"] = f"{инц['engineer_id']}:{инц['minutes']}"
        elif инц.get("kind") == "cancelled":
            замысел["cancelled"] = ",".join(инц.get("order_ids") or [])

        # Переменные записи — те, которыми считали, а не те, что стоят у
        # компании сейчас. Сводка на карточке и её переменные обязаны
        # описывать один и тот же счёт.
        переменные = {k: getattr(st_основы, k) for k in SETTING_LIMITS}
        переменные["churn_penalty"] = мета_п["churn_penalty"]

        вид = ("срочные заявки" if spec.get("urgent") else
               "отмена заявки" if spec.get("cancelled") else
               "инженер задержится" if delayed else
               "инженер выбыл" if spec.get("disabled") else "пересчёт")
        запись = self._add_run(ident, готовое, note=note, factory=None,
                               params=переменные,
                               пометка=f"{вид} в {at // 60:02d}:{at % 60:02d}",
                               замысел=замысел)
        # План пересчёта хранится рядом с архивом: карточка открывается им,
        # а не новым счётом. Прежде `run_forms` пересчитывал заново, и после
        # перезапуска сервера сохранённая карточка открывалась другим планом.
        replans_dir().mkdir(parents=True, exist_ok=True)
        (replans_dir() / f"{запись['id']}.json").write_text(
            json.dumps(готовое, ensure_ascii=False))
        return запись

    def staffing(self, ident: str, base: str | None = None) -> dict:
        """Сколько ещё людей нужно, чтобы закрыть остаток дня.

        Считается солвером на нескольких зёрнах — это десяток пересчётов,
        секунды, а не миллисекунды. Поэтому кэшируется на диск тем же
        ключом, что и формы дня: настройки плюс код. Правка кода или
        настроек — и ответ пересчитается сам.
        """
        ident, st, _ключ = self.основа(ident, base)
        имя = f"staffing-{slug(ident)}-{ключ_кэша(st)}.json"
        # Свой замок, не замок дня: «сколько людей» считается десятки
        # секунд, и формы той же зоны ждать его не должны.
        with self._замок_дня("staffing:" + ident):
            путь = _кэш(имя)
            if путь is not None:
                try:
                    return json.loads(путь.read_text())
                except (json.JSONDecodeError, OSError):
                    pass
            day, _ = self.day_and_plan(ident, st)
            ответ = сколько_нужно(day, _params(st))
            ответ = {"schema": SCHEMA_VERSION, **ответ,
                     "meta": {"day": day.ident, "date": day.date}}
            CACHE_DIR.mkdir(exist_ok=True)
            (CACHE_DIR / имя).write_text(json.dumps(ответ, ensure_ascii=False))
            return ответ

    @staticmethod
    def _формы_записи(запись: dict) -> list[str]:
        """Какие формы у этой записи можно попросить.

        Раньше узнать это было нечем: клиент просил все четыре и на
        лишних получал 400 — а `Promise.all` в вёрстке ронял от одного
        отказа весь список расчётов. Угадать по полям тоже не выходит:
        `kind` это подпись человека («срочные заявки в 13:40»), она
        стоит и у обычных расчётов.

        Три случая, и третий неприятный: запись, сохранённая до того,
        как движок стал помнить замысел пересчёта, не открывается вовсе.
        Показать по ней можно только сводку на карточке — и пусть
        интерфейс знает это заранее, а не через отказ.
        """
        if запись.get("replan"):
            return ["plan"]
        if запись.get("kind"):
            return []
        return ["plan", "explain", "simulation", "shifts"]

    def catalogue(self) -> dict:
        """Справочники: навыки, виды работ, типы транспорта.

        Заводится ради интерфейса. До этого русские названия навыков
        жили в `SKILL_TITLES` и наружу не отдавались ни одной ручкой —
        вёрстка видела их случайно, внутри готовой фразы про
        нераспределённую заявку, а в остальных местах показывала голые
        коды `install` и `emergency`.

        Виды работ отдаются списком целиком, а не выводятся из того, что
        случилось сегодня: фильтр «по виду работ», собранный по одному
        дню, на разных зонах получался разным — в выгрузке 22 кода, а на
        «востоке» встречается 14.
        """
        return {
            "schema": SCHEMA_VERSION,
            "kind": "catalogue",
            "skills": [{"code": код, "title": имя}
                       for код, имя in SKILL_TITLES.items()],
            "work_types": [
                {"code": w.code, "title": w.title, "skill": w.skill,
                 "est_minutes": w.est_minutes, "needs_access": w.needs_access,
                 # Часть работ требует машины: туда надо привезти
                 # лестницу, кабель и измеритель. Это наше допущение, и
                 # интерфейс вправе его показать.
                 "requires_transport": TRANSPORT_REQUIRED.get(w.code)}
                for w in REAL_WORK_TYPES.values()],
            "transport": [
                {"code": код, "title": сведения["title"],
                 "max_km": сведения["max_km"]}
                for код, сведения in TRANSPORT.items()],
            # Приборы, которые везут на заявку. Состав по виду работ —
            # наше допущение: в выгрузке оборудования нет. `reserve` —
            # сколько каждого сверх маршрута выдают утром.
            "equipment": [{"code": код, "title": имя, "reserve": RESERVE_PER_TYPE}
                          for код, имя in EQUIPMENT.items()],
        }

    def list_runs(self) -> dict:
        # Записям, заведённым до появления поля, оно достаётся здесь:
        # оно выводится из самой записи, поэтому старый архив переписывать
        # незачем — а интерфейсу нужно, чтобы поле было у всех.
        with self._lock:
            записи = [r if "forms" in r
                      else {**r, "forms": self._формы_записи(r)}
                      for r in self._runs]
        return {"runs": записи}

    def _run(self, run_id: str) -> dict:
        with self._lock:
            for r in self._runs:
                if r["id"] == run_id:
                    return r
        raise NotFound(f"расчёта {run_id!r} в архиве нет")

    def run_forms(self, run_id: str) -> dict:
        """Формы расчёта плюс сама запись.

        Формы расчёта не хранятся: они лежат в кэше по ключу переменных и
        кода. План сохранённого пересчёта хранится файлом (`replans_dir`):
        пересчёт живёт по секундам, и новый счёт дал бы другой план.

        У сохранённого пересчёта форма одна — план остатка дня. Своих
        `explain`, `simulation` и `shifts` у него нет и быть не может:
        это формы целого дня, и подставлять их сюда значило бы показать
        рядом с планом на 42 заявки сводку на 66.
        """
        запись = self._run(run_id)
        st, _ = self._settings_for(запись["params"])

        замысел = запись.get("replan")
        # Пересчёт, сохранённый до того, как движок стал помнить замысел.
        # Такие записи в архиве уже лежат, и открывать их полным днём —
        # ровно та ошибка, ради которой всё это писалось. Лучше честно
        # сказать, что показать нечего: сводка на карточке верная.
        if замысел is None and запись.get("kind"):
            raise ValueError(
                f"расчёт {запись['code']} — пересчёт, сохранённый старой "
                f"версией движка: чем он был, запись не помнит. Показать "
                f"можно только сводку на карточке; чтобы получить план, "
                f"повторите пересчёт и сохраните заново")
        сохранённый = replans_dir() / f"{run_id}.json"
        if замысел and сохранённый.exists():
            return {"run": {**запись, "forms": self._формы_записи(запись)},
                    "plan": json.loads(сохранённый.read_text())}
        if замысел:
            # Записи, сохранённые до 22 сентября, своего плана не хранят —
            # только замысел: их по-прежнему пересчитываем.
            план = self.replan(
                ident=замысел["day"], at=замысел["at"],
                urgent_count=замысел.get("urgent", 0),
                cancelled=замысел.get("cancelled"),
                run=замысел.get("run", 0),
                disabled=замысел.get("disabled"),
                delayed=замысел.get("delayed"),
                source=замысел.get("source", "sim"),
                # У записей, сохранённых до того, как ползунок стал частью
                # замысла, его нет — там `None`, и берётся настройка
                # компании, как и было.
                churn_penalty=замысел.get("churn_penalty"),
                journal_snapshot=замысел.get("journal_snapshot"),
                urgent_near=замысел.get("urgent_near"),
                base=замысел.get("base"),
            )
            # Пересчёт считается по нынешним настройкам компании: своих
            # он не принимает. Пока это верно — `save_replan` считал ими
            # же. Если настройки менять между сохранением и открытием,
            # план поедет, и тогда `replan` придётся учить принимать
            # `settings`, как это умеет `forms`.
            return {"run": {**запись, "forms": self._формы_записи(запись)},
                    "plan": план}

        forms = self.forms(запись["day"], settings=st)
        return {"run": {**запись, "forms": self._формы_записи(запись)}, **forms}

    def run_form(self, run_id: str, kind: str) -> dict:
        if kind not in ("plan", "explain", "simulation", "shifts"):
            raise ValueError(f"нет такой формы: {kind!r}")
        формы = self.run_forms(run_id)
        if kind not in формы:
            raise ValueError(
                f"у сохранённого пересчёта нет формы {kind!r}: "
                f"есть только план остатка дня")
        return формы[kind]

    # ---------- сохранённые сравнения ----------
    #
    # Движок здесь ничего не считает. Он складывает рядом уже посчитанное
    # и помнит, что и когда сравнивали. Цифры хранятся снимком, а не
    # ссылками на расчёты: расчёт могут переименовать или удалить, а
    # сравнение обязано остаться читаемым — оно отвечает на вопрос «что мы
    # видели, когда принимали решение».

    def _load_compares(self) -> list[dict]:
        return прочитать_список(compares_path())

    def _изменить_сравнения(self, действие):
        """То же, что `_изменить_архив`, но для сохранённых сравнений."""
        свежие, итог = изменить_список(compares_path(), действие)
        with self._lock:
            self._compares = свежие
        return итог

    def list_compares(self) -> dict:
        with self._lock:
            return {"compares": list(self._compares)}

    def save_compare(self, runs: list, note: str = "") -> dict:
        """Положить набор в архив. Границы набора движок проверяет сам."""
        if not isinstance(runs, list):
            raise ValueError("runs: ожидался список расчётов")
        if not COMPARE_MIN <= len(runs) <= COMPARE_MAX:
            raise ValueError(
                f"в сравнении {len(runs)} расчётов, а должно быть от "
                f"{COMPARE_MIN} до {COMPARE_MAX}: одного сравнивать не с чем, "
                f"больше {COMPARE_MAX} на экран не помещается")
        без_кода = [i for i, r in enumerate(runs)
                    if not isinstance(r, dict) or not r.get("id")]
        if без_кода:
            raise ValueError(f"расчёты без идентификатора: позиции {без_кода}")
        # Снимок хранится, чтобы сравнение пережило расчёт, — но заводится
        # оно только из того, что в архиве есть. Прежде принимался любой
        # `id`, и в архив сравнений ложилась выдуманная строка.
        with self._lock:
            есть = {r["id"] for r in self._runs}
        чужие = [r["id"] for r in runs if r["id"] not in есть]
        if чужие:
            raise ValueError(f"расчётов нет в архиве: {', '.join(map(str, чужие))}")

        now = time.localtime()

        def дописать(текущие: list) -> dict:
            запись = {
                "id": f"cmp-{uuid.uuid4().hex[:12]}",
                "code": f"C{len(текущие) + 1:03d}",
                "date": time.strftime("%Y-%m-%d", now),
                "created": time.strftime("%Y-%m-%dT%H:%M", now),
                "note": str(note),
                "runs": runs,
            }
            текущие.append(запись)
            return запись

        return self._изменить_сравнения(дописать)

    def delete_compare(self, compare_id: str) -> dict:
        """Убрать сравнение. Расчёты при этом не трогаются."""
        def убрать(текущие: list) -> int:
            остаток = [c for c in текущие if c["id"] != compare_id]
            if len(остаток) == len(текущие):
                raise NotFound(f"сравнения {compare_id!r} в архиве нет")
            текущие[:] = остаток
            return len(остаток)

        # Правка идёт по тому, что на диске: сравнение могли завести из
        # другого окна уже после того, как это загрузило свой список.
        осталось = self._изменить_сравнения(убрать)
        return {"deleted": compare_id, "left": осталось}

    def note_run(self, run_id: str, note: str) -> dict:
        def подписать(текущие: list) -> dict:
            for r in текущие:
                if r["id"] == run_id:
                    r["note"] = str(note)
                    return r
            raise NotFound(f"расчёта {run_id!r} в архиве нет")

        return self._изменить_архив(подписать)

STAND: Stand | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "vrptw/1.0"

    # ---------- служебное ----------

    def _send(self, payload, status: int = 200):
        # У 204 тела не бывает по протоколу.
        body = (b"" if status == 204
                else json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # Фронт живёт на другом порту, поэтому браузер иначе не пустит.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        # DELETE здесь обязателен: без него браузер с другого порта не
        # пропускал удаление сравнения — сервер его умел, а CORS запрещал.
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _error(self, message: str, status: int = 400):
        self._send({"error": message}, status)

    def log_message(self, fmt, *args):
        sys.stderr.write(f"  {self.address_string()} — {fmt % args}\n")

    def do_OPTIONS(self):  # noqa: N802
        self._send({}, 204)

    # ---------- маршруты ----------

    def do_GET(self):  # noqa: N802
        url = urlparse(self.path)
        query = parse_qs(url.query)
        path = url.path.rstrip("/") or "/"

        def day_arg(default: str = "1") -> str:
            """Идентификатор дня из запроса, с проверкой.

            Раньше здесь был голый `int()`, и `?day=999` считался как ни
            в чём не бывало: минута процессорного времени и мусорный файл
            в кэше.

            Отдельно ловится `?date=`: так было написано в `CONTRACT.md`,
            и фронт, сделанный по букве документа, получал код 200 и
            синтетический день 1 — с датой 15 сентября в заголовке и без
            единого признака, что зону ему не отдали. Неизвестное
            значение отвергалось, а неизвестное имя параметра — нет."""
            if "day" not in query and "date" in query:
                raise ValueError(
                    "параметр называется day, а не date: "
                    f"/api/plan?day={query['date'][0]}")
            return parse_day(query.get("day", [default])[0])

        def base_arg() -> str | None:
            """Открытый расчёт: `base=run-…`; пусто — план компании."""
            return query.get("base", [None])[0] or None

        try:
            if path == "/api":
                return self._send(self._index())

            # Статика интерфейса, если она положена рядом. Тогда всё
            # открывается с одного адреса и вопрос CORS не возникает
            # вовсе — удобно на защите, где браузер чужой.
            if not path.startswith("/api"):
                served = self._serve_static(path)
                if served:
                    return
                if path == "/":
                    return self._send(self._index())
                return self._error(f"нет такого пути: {path}", 404)

            if path == "/api/health":
                return self._send({"status": "ok", "schema": SCHEMA_VERSION,
                                   "code": отпечаток_кода(),
                                   "cached_days": sorted(
                                       i for i, к in STAND._forms
                                       if к == ключ_кэша(STAND.settings)),
                                   "warming": прогрев_сейчас()})

            if path == "/api/staffing":
                return self._send(STAND.staffing(day_arg(), base_arg()))

            if path == "/api/uploads":
                return self._send({"uploads": uploads.список()})
            if path.startswith("/api/uploads/"):
                return self._send(uploads.запись(unquote(path[len("/api/uploads/"):])))

            if path == "/api/catalogue":
                return self._send(STAND.catalogue())

            if path == "/api/days":
                # Считанные дни: имя файла это
                # «day-<слаг>-<настройки>-<код>», и один и тот же день на
                # трёх наборах настроек лежит тремя файлами. Раньше он и
                # показывался трижды.
                #
                # Чужой код отсеиваем: «готов» должно значить «вернётся
                # мгновенно», а файл, посчитанный прежней версией движка,
                # теперь не вернётся вовсе — по нему день пересчитается.
                # Заодно это отбрасывает файлы старого трёхчастного вида,
                # которые иначе развалили бы разбор имени.
                #
                # И чужие настройки тоже: день, посчитанный при другом
                # множителе длительности, по нынешним настройкам не
                # вернётся — он пересчитается. Прежде такой день числился
                # готовым, и интерфейс обещал мгновенный ответ там, где
                # предстояла минута счёта.
                свой = ключ_кэша(STAND.settings)
                ready = sorted({
                    p.stem.split("-", 1)[1].rsplit("-", 2)[0]
                    for каталог in (CACHE_DIR, READY_DIR)
                    for p in каталог.glob("day-*.json")
                    if p.stem.endswith("-" + свой)})
                ready = [r[len("зона-"):] if r.startswith("зона-")
                         else str(int(r)) for r in ready]
                выгрузки = uploads.список()
                return self._send({
                    "ready": sorted(set(ready)),
                    "zones": list(ZONES),
                    "available": (list(ZONES) + [в["day"] for в in выгрузки]
                                  + [str(n) for n in SYNTHETIC_DAYS]),
                    # Выгрузки, которые принёс диспетчер: день, название,
                    # дата и готова ли к расчёту (`uploads.py`).
                    "uploads": [{"day": в["day"], "title": в["title"],
                                 "date": в["date"], "orders": в["to_plan"],
                                 "engineers": в["engineers"], "status": в["status"]}
                                for в in выгрузки],
                    "note": "day — зона заказчика (настоящие данные "
                            "за 17.08.2026), выгрузка, загруженная через "
                            "/api/uploads, или номер синтетического дня "
                            "от 1 до 30; не посчитанный считается по "
                            "первому запросу за несколько секунд",
                })

            # Архив расчётов. Пути без префикса `/api` интерфейс не
            # знает: у него один адрес движка и один префикс.
            if path == "/api/runs":
                return self._send(STAND.list_runs())
            if path == "/api/compares":
                return self._send(STAND.list_compares())
            if path.startswith("/api/runs/"):
                хвост = path[len("/api/runs/"):].split("/")
                if len(хвост) == 1:
                    return self._send(STAND.run_forms(unquote(хвост[0])))
                if len(хвост) == 2:
                    return self._send(STAND.run_form(unquote(хвост[0]), хвост[1]))
                return self._error(f"нет такого пути: {path}", 404)

            if path == "/api/day":
                return self._send(STAND.forms(day_arg(),
                                              fresh="fresh" in query))

            for name in ("plan", "explain", "simulation", "shifts"):
                if path == f"/api/{name}":
                    forms = STAND.forms(day_arg(), fresh="fresh" in query)
                    return self._send(forms[name])

            if path == "/api/tuned":
                return self._send(STAND.with_tuned_shifts(day_arg()))

            if path == "/api/settings":
                return self._send({"settings": STAND.settings.describe(),
                                   "fingerprint": STAND.settings.fingerprint()})

            if path == "/api/journal":
                j = STAND.journal(day_arg(), base_arg())
                return self._send({"day": day_arg(), "base": base_arg(),
                                   "assignment": j.assignment,
                                   "events": j.events, "summary": j.summary()})

            if path == "/api/state":
                return self._send(STAND.day_state(
                    day_arg(), int(query.get("at", [13 * 60 + 40])[0]),
                    base_arg()))

            if path == "/api/orders":
                j = STAND.journal(day_arg(), base_arg())
                day, _ = STAND.day_and_plan(day_arg())
                return self._send({
                    "day": day_arg(),
                    "new": [{"id": o.id, "work_type": o.work_type,
                             "address": o.address, "district": o.district,
                             "lat": round(o.lat, 6), "lon": round(o.lon, 6),
                             "window_start": o.window_start,
                             "window_end": o.window_end,
                             "priority": o.priority,
                             "est_minutes": o.est_minutes}
                            for o in j.orders(day)],
                    "unplaced": [o.id for o in j.unplaced(day)],
                })

            if path == "/api/baseline":
                # Базовый вариант ТЗ целиком, в той же форме, что и наш
                # план: чтобы его можно было нарисовать на карте рядом.
                ident = day_arg()
                day, _ = STAND.day_and_plan(ident)
                base = STAND.baseline(ident)
                out = build_plan(day, base, day.network,
                                 STAND.settings.risk_high,
                                 STAND.settings.risk_medium)
                out["kind"] = "baseline"
                out["meta"]["solver"] = "sequential — базовый вариант из ТЗ"
                return self._send(out)

            if path == "/api/replan":
                return self._send(STAND.replan(
                    ident=day_arg(),
                    at=int(query.get("at", [13 * 60 + 40])[0]),
                    urgent_count=int(query.get("urgent", [2])[0]),
                    cancelled=query.get("cancelled", [None])[0],
                    seconds=float(query.get("seconds", [REPLAN_SECONDS])[0]),
                    run=int(query.get("run", [0])[0]),
                    disabled=query.get("disabled", [None])[0],
                    delayed=query.get("delayed", [None])[0],
                    source=query.get("source", ["sim"])[0],
                    churn_penalty=(float(query["churn_penalty"][0])
                                   if "churn_penalty" in query else None),
                    urgent_near=query.get("urgent_near", [None])[0] or None,
                    base=base_arg(),
                ))

            return self._error(f"нет такого пути: {path}", 404)

        except (NotFound, uploads.НетВыгрузки) as exc:
            return self._error(str(exc), 404)
        except ValueError as exc:
            return self._error(f"плохой параметр: {exc}", 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(exc).__name__}: {exc}", 500)

    def do_POST(self):  # noqa: N802
        url = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError as exc:
            return self._error(f"тело не разобралось как JSON: {exc}", 400)

        try:
            path = url.path.rstrip("/")

            if path == "/api/settings":
                return self._send(STAND.update_settings(body))

            if path == "/api/uploads":
                # Файл едет в JSON строкой base64: у движка одна форма тела
                # на все ручки, а cp1251 в JSON-строке не довезти без порчи.
                import base64
                import binascii
                try:
                    data = base64.b64decode(str(body.get("data", "")), validate=True)
                except (binascii.Error, ValueError):
                    raise ValueError("data — не base64: файл надо прислать строкой base64")
                return self._send(uploads.принять(
                    body.get("name", ""), data,
                    body.get("engineers", uploads.ИНЖЕНЕРОВ_ПО_УМОЛЧАНИЮ)))
            if path.startswith("/api/uploads/") and path.endswith("/prepare"):
                ident = unquote(path[len("/api/uploads/"):-len("/prepare")])
                return self._send(uploads.подготовить(STAND, ident))

            def day_of_body() -> str:
                """День из тела запроса — обязательно.

                Прежде без `day` подставлялся синтетический день 1: расчёт
                по зоне, заведённый без поля, молча считал выдуманный день,
                а событие диспетчера ложилось в чужой журнал."""
                if "day" not in body:
                    raise ValueError("в теле нет day: укажите зону "
                                     f"({', '.join(ZONES)}), выгрузку или номер дня")
                return parse_day(body["day"])

            if path == "/api/runs":
                # Две разные вещи под одним путём — так устроен интерфейс.
                # С телом `replan` он просит СОХРАНИТЬ уже посчитанное, а
                # не считать заново: результат у движка в кэше, и новый
                # счёт мог бы дать другой план, чем человек видел.
                if body.get("replan"):
                    return self._send(STAND.save_replan(
                        spec=body["replan"],
                        source=body.get("source", "sim"),
                        note=body.get("note", ""),
                    ))
                return self._send(STAND.create_run(
                    ident=day_of_body(),
                    params=body.get("params"),
                    note=body.get("note", ""),
                ))

            if path == "/api/compares":
                return self._send(STAND.save_compare(
                    runs=body.get("runs", []), note=body.get("note", "")))

            if path.startswith("/api/runs/") and path.endswith("/note"):
                run_id = unquote(path[len("/api/runs/"):-len("/note")])
                return self._send(STAND.note_run(run_id, body.get("note", "")))

            if path == "/api/event":
                return self._send(STAND.record(day_of_body(), body,
                                               body.get("base") or None))

            if path == "/api/journal/reset":
                return self._send(
                    STAND.reset_journal(day_of_body(), body.get("base") or None))

            if path == "/api/journal/adopt":
                return self._send(
                    STAND.adopt_shown(day_of_body(), str(body.get("token", "")),
                                      body.get("base") or None))

            if path == "/api/replan":
                return self._send(STAND.replan(
                    ident=day_of_body(),
                    at=int(body.get("at", 13 * 60 + 40)),
                    urgent_count=int(body.get("urgent", 2)),
                    cancelled=body.get("cancelled"),
                    seconds=float(body.get("seconds", REPLAN_SECONDS)),
                    run=int(body.get("run", 0)),
                    disabled=body.get("disabled"),
                    delayed=body.get("delayed"),
                    source=body.get("source", "sim"),
                    churn_penalty=body.get("churn_penalty"),
                    urgent_near=body.get("urgent_near") or None,
                    base=body.get("base") or None,
                ))
            return self._error(f"нет такого пути: {url.path}", 404)
        except (NotFound, uploads.НетВыгрузки) as exc:
            return self._error(str(exc), 404)
        except (Устарело, uploads.Занято) as exc:
            return self._error(str(exc), 409)
        except ValueError as exc:
            return self._error(f"плохой параметр: {exc}", 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(exc).__name__}: {exc}", 500)

    def do_DELETE(self):  # noqa: N802
        """Удаление. Пока единственное удаляемое — сохранённое сравнение.

        Метода DELETE у сервера не было вовсе, и запрос на него падал
        как «нет такого пути». Расчёты этим методом не удаляются
        намеренно: историю счёта затирать нельзя, а сравнение — это
        заметка человека, и её он вправе убрать.
        """
        url = urlparse(self.path)
        try:
            path = url.path.rstrip("/")
            if path.startswith("/api/compares/"):
                cid = unquote(path[len("/api/compares/"):])
                return self._send(STAND.delete_compare(cid))
            if path.startswith("/api/uploads/"):
                # Выгрузка — не история счёта, а принесённый файл: его можно
                # убрать, пока по нему нет расчётов (`uploads.удалить`).
                ident = unquote(path[len("/api/uploads/"):])
                return self._send(uploads.удалить(ident, STAND._load_runs()))
            return self._error(f"нет такого пути: {url.path}", 404)
        except (NotFound, uploads.НетВыгрузки) as exc:
            return self._error(str(exc), 404)
        except uploads.Занято as exc:
            return self._error(str(exc), 409)
        except ValueError as exc:
            return self._error(f"плохой параметр: {exc}", 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(exc).__name__}: {exc}", 500)

    def _serve_static(self, path: str) -> bool:
        """Отдать файл из `web/`, если он там есть. Иначе False."""
        root = WEB_DIR.resolve()
        if not root.is_dir():
            return False

        rel = path.lstrip("/") or "index.html"
        target = (root / rel).resolve()
        if target.is_dir():
            target = (target / "index.html").resolve()
        # Выход за пределы папки — единственное, чего здесь нельзя.
        if root not in target.parents and target != root:
            return False
        if not target.is_file():
            return False

        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)
        return True

    def _index(self) -> dict:
        return {
            "service": "стенд планировщика выездов",
            "schema": SCHEMA_VERSION,
            "contract": "CONTRACT.md — формы те же, что в фикстурах",
            "endpoints": {
                "GET /api/days": "какие дни готовы: зоны заказчика, выгрузки и синтетика",
                "POST /api/uploads": "принять выгрузку дня: {name, data: base64, "
                                     "engineers} → предпросмотр",
                "GET /api/uploads": "выгрузки, которые принесли, с состоянием",
                "POST /api/uploads/<day>/prepare": "подготовить выгрузку в фоне: адреса, "
                                                   "сеть, план; ход — GET /api/uploads/<day>",
                "DELETE /api/uploads/<day>": "убрать выгрузку, если по ней нет расчётов",
                "GET /api/baseline?day=восток":
                    "базовый вариант из ТЗ тем же форматом — для сравнения",
                "GET /api/day?day=1": "все четыре формы одним ответом",
                "GET /api/plan?day=1": "маршруты, карта, таймлайн",
                "GET /api/explain?day=1": "почему заявка у этого инженера",
                "GET /api/simulation?day=1": "сводка дня и хрупкие визиты",
                "GET /api/shifts?day=1": "график выхода: спрос против смен",
                "GET /api/tuned?day=1": "план по подобранному графику смен",
                "GET /api/replan?day=1&at=820&urgent=2":
                    "пересчёт: аварии в момент at, минуты от полуночи",
                "GET /api/replan?day=1&at=820&disabled=E03":
                    "инженера сегодня не будет — заявки уходят другим",
                "GET /api/replan?day=1&at=820&delayed=E03:40":
                    "инженер задержится на 40 минут и поедет дальше оттуда, где встал",
                "GET /api/replan?day=1&at=820&cancelled=R0038":
                    "абонент отказался от визита — третье событие из ТЗ",
                "POST /api/replan":
                    "то же телом {day, at, urgent, cancelled, seconds, run, "
                    "disabled, delayed}",
                "POST /api/event":
                    "сообщить, что случилось: {day, kind, order|engineer, at, ...}",
                "GET /api/journal?day=1": "что уже сообщили и сводка по дню",
                "GET /api/orders?day=1": "заявки, поступившие за день",
                "GET /api/settings": "семь настроек: значения, пределы, описания",
                "POST /api/settings": "поменять их, телом {имя: значение}",
                "GET /api/state?day=1&at=820":
                    "что движок думает о дне: выполнено, сорвано, кто где",
                "POST /api/journal/reset": "забыть сообщённое, {day}",
                "GET /api/health": "жив ли стенд и какая на нём схема",
                "GET /api/runs": "архив расчётов: что считали и с чем",
                "POST /api/runs":
                    "завести расчёт: {day, note, params} либо {replan: {...}} — "
                    "во втором случае сохраняется уже показанный пересчёт, "
                    "а не считается заново",
                "GET /api/runs/<id>": "запись расчёта и все четыре формы",
                "GET /api/runs/<id>/<форма>": "одна форма отдельно",
                "POST /api/runs/<id>/note": "заметка человека к расчёту",
                "GET /api/compares": "сохранённые сравнения расчётов",
                "POST /api/compares":
                    "сохранить сравнение: {runs: [{id, code, ...}, ...]}, "
                    "от двух до восьми расчётов объектами, не номерами",
                "DELETE /api/compares/<id>": "убрать сравнение, расчёты целы",
            },
            "hints": {
                "time_format": "минуты от полуночи: 820 = 13:40",
                "fresh": "добавьте &fresh=1, чтобы пересчитать день заново",
                "run": "номер случайной траектории дня для пересчёта; "
                       "один и тот же run даёт один и тот же ход дня",
                "churn_penalty": "живой контрол на экране инцидента: "
                       "можно передать прямо в /api/replan, не трогая "
                       "настройки компании",
                "source": "откуда берётся состояние дня при пересчёте: "
                       "sim — разыграть костями (для демо и замеров), "
                       "journal — взять из того, о чём отчитался диспетчер",
                "disabled и delayed": "два разных события, и это принципиально. "
                       "Выбытие на день стоит 4,7 визита и пересчёт возвращает "
                       "3,9 — жать надо. Прокол стоит 0,4–0,7 визита, буферы "
                       "съедают его сами. В ответе смотрите meta.replan.incident: "
                       "rescued — визиты выбывшего, которые подхватили другие",
            },
        }


# Что прогрев делает сейчас. Сервер открывает порт сразу и считает дни в
# фоне: прежде порт открывался после прогрева, и на чистой машине страница
# три с лишним минуты отвечала «не удаётся подключиться» — проверяющий
# вправе решить, что ничего не работает.
ПРОГРЕВ: dict = {"дни": [], "готово": [], "идёт": None, "начало": None, "конец": None}


def прогрев_сейчас() -> dict | None:
    """Для /api/health: None — прогрев закончен или не начинался."""
    if not ПРОГРЕВ["дни"] or ПРОГРЕВ["конец"] is not None:
        return None
    return {"ready": list(ПРОГРЕВ["готово"]),
            "pending": [d for d in ПРОГРЕВ["дни"] if d not in ПРОГРЕВ["готово"]],
            "current": ПРОГРЕВ["идёт"],
            "seconds": round(time.time() - ПРОГРЕВ["начало"])}


def warm(stand: Stand, seeds: list[int]):
    ПРОГРЕВ.update(дни=list(seeds), готово=[], идёт=None,
                   начало=time.time(), конец=None)
    for seed in seeds:
        ПРОГРЕВ["идёт"] = seed
        t0 = time.time()
        try:
            # Формы могут прийти с диска, а план для пересчёта — нет:
            # без этой строки первый запрос пересчёта ждал бы восемь
            # секунд на постройку исходного плана.
            stand.day_and_plan(seed)
            stand.forms(seed)
            # Базовый вариант и «сколько людей» — тоже кнопки показа, и
            # первая из них не должна ждать счёта. `staffing` кэшируется
            # на диск, базовый план — в памяти процесса.
            stand.baseline(seed)
            if is_real(seed):
                stand.staffing(seed)
            print(f"  день {seed} готов за {time.time() - t0:.1f} с")
        except Exception as exc:  # noqa: BLE001
            print(f"  день {seed} не собрался: {exc}")
        ПРОГРЕВ["готово"].append(seed)
    ПРОГРЕВ.update(идёт=None, конец=time.time())
    print(f"  прогрев закончен за {ПРОГРЕВ['конец'] - ПРОГРЕВ['начало']:.0f} с")


def _dropout_ok(d) -> bool:
    """Выбывшего нет ни в бригаде, ни в маршрутах, заявки не потерялись."""
    inc = d["meta"]["replan"].get("incident")
    if not inc or inc["kind"] != "disabled" or inc["engineer_id"] != "E00":
        return False
    if any(e["id"] == "E00" for e in d["engineers"]):
        return False
    if any(r["engineer_id"] == "E00" for r in d["routes"]):
        return False
    if inc["kept"]:                       # его сегодня нет — держать нечем
        return False
    outcomes = set(inc["rescued"]) | set(inc["kept"]) | set(inc["lost"])
    return outcomes == set(inc["pending_was"])


def _delay_ok(d) -> bool:
    """Задержавшийся остаётся в бригаде, и смена у него сдвинута."""
    inc = d["meta"]["replan"].get("incident")
    if not inc or inc["kind"] != "delayed" or inc["minutes"] != 40:
        return False
    eng = next((e for e in d["engineers"] if e["id"] == "E00"), None)
    if eng is None or eng["shift_start"] < 820:
        return False
    outcomes = set(inc["rescued"]) | set(inc["kept"]) | set(inc["lost"])
    return outcomes == set(inc["pending_was"])


def check():
    """Поднять сервер на свободном порту и постучаться во все эндпоинты.

    Нужно ровно для одного вопроса: «api живой или у меня фронт
    сломался?». Считается один день, поэтому занимает минуту.
    """
    global STAND, CACHE_DIR, READY_DIR
    import socket
    import tempfile
    import urllib.error
    import urllib.parse
    import urllib.request

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    # Состояние проверки — во временном каталоге, а не в боевом.
    # Прежде `check` работал по тем же файлам, что и диспетчер: дописывал
    # три записи в архив и звал `journal/reset` по дню 1 и зоне «восток»,
    # то есть стирал введённое человеком. Обе записки передачи велят
    # прогнать эту команду первым делом — и она молча уносила день.
    # Кэш планов остаётся общим: он не состояние, а сбережённый счёт, и
    # расчёт зоны стоит около восьмидесяти секунд.
    песочница = tempfile.mkdtemp(prefix="vrptw-check-")
    use_state_dir(песочница)

    print("Проверка сервера\n")
    Handler.log_message = lambda *a, **k: None   # без построчного лога запросов
    STAND = Stand()
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    def get(path: str):
        t0 = time.time()
        with urllib.request.urlopen(_url(path), timeout=300) as resp:
            payload = json.load(resp)
        return payload, time.time() - t0

    def _url(path: str) -> str:
        """Процентное кодирование: имена зон кириллические.

        Браузер сделал бы это сам, а `urllib` — нет: он падает на
        UnicodeEncodeError ещё до отправки."""
        head, _, query = path.partition("?")
        if not query:
            return base + head
        pairs = []
        for part in query.split("&"):
            k, _, v = part.partition("=")
            pairs.append(f"{k}={urllib.parse.quote(v)}")
        return base + head + "?" + "&".join(pairs)

    def get_any(path: str):
        """Как `get`, но отказ — тоже ответ: часть проверок именно о том,
        что плохой запрос отвергается понятной ошибкой, а не считается."""
        try:
            with urllib.request.urlopen(_url(path), timeout=300) as resp:
                return json.load(resp), 200
        except urllib.error.HTTPError as exc:
            return json.loads(exc.read().decode("utf-8")), exc.code

    def post(path: str, body: dict):
        req = urllib.request.Request(
            base + path, data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"}, method="POST")
        t0 = time.time()
        with urllib.request.urlopen(req, timeout=300) as resp:
            payload = json.load(resp)
        return payload, time.time() - t0

    def delete(path: str):
        req = urllib.request.Request(base + path, method="DELETE")
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.load(resp)

    def _cancel_ok(d) -> bool:
        """Отмена заявки: третье событие пересчёта из ТЗ.

        Проверяем не только что ответ пришёл, но и что отменённой заявки
        нет ни в маршрутах, ни в неназначенных: она выбыла из дня, а не
        превратилась в невыполненную."""
        inc = d["meta"]["replan"].get("incident")
        if not inc or inc["kind"] != "cancelled" or not inc["order_ids"]:
            return False
        отменена = set(inc["order_ids"])
        в_маршрутах = {s["order_id"] for r in d["routes"] for s in r["stops"]}
        if отменена & в_маршрутах:
            return False
        if отменена & set(d["unassigned"]):
            return False
        return inc["freed_minutes"] > 0

    def _zone_ok(d) -> bool:
        """План зоны: наш формат, сравнение с базовым и настоящая геометрия."""
        if d["kind"] != "plan" or not d["routes"]:
            return False
        base = d["meta"].get("baseline")
        if not base or "km_total" not in base:
            return False
        # Геометрия должна вести по адресам этой зоны, а не по чужим.
        точки = [p for r in d["routes"] for s in r["stops"] for p in s["geometry"]]
        свои = {(round(o["lat"], 4), round(o["lon"], 4)) for o in d["orders"]}
        концы = {(round(s["geometry"][-1][0], 4), round(s["geometry"][-1][1], 4))
                 for r in d["routes"] for s in r["stops"]}
        return bool(точки) and концы <= свои and not чужие_ломаные(d)


    checks = [
        ("/api/health", lambda d: d["status"] == "ok"),
        ("/api/days", lambda d: "1" in d["available"]
                                and "восток" in d["zones"]),
        ("/api/plan?day=1", lambda d: d["kind"] == "plan" and d["routes"]),
        ("/api/explain?day=1", lambda d: d["kind"] == "explain" and d["orders"]),
        ("/api/simulation?day=1", lambda d: d["kind"] == "simulation"),
        ("/api/shifts?day=1", lambda d: d["kind"] == "shifts" and d["curve"]),
        ("/api/replan?day=1&at=820&urgent=2",
         lambda d: d["meta"]["replan"]["solve_seconds"] < 10),
        # Выбытие инженера: его нет в бригаде остатка, и то, что у него
        # было впереди, разложено по трём исходам без потерь.
        ("/api/replan?day=1&at=820&disabled=E00", _dropout_ok),
        ("/api/replan?day=1&at=820&delayed=E00:40", _delay_ok),
        # Отмена заявки — третье из трёх событий пересчёта, которые
        # называет ТЗ. Заявку берём из плана дня по факту, ниже.

        # Настоящие данные заказчика через те же ручки. Отдельная
        # проверка нужна потому, что у зон своя дорожная сеть: с общей
        # номера узлов остались бы в диапазоне, а ломаная на карте молча
        # указывала бы не туда.
        ("/api/plan?day=восток", _zone_ok),

        # Сравнение с базовым вариантом — обязательное по ТЗ.
        ("/api/baseline?day=восток", lambda d: d["kind"] == "baseline" and d["routes"]),

        # Идентификатор дня проверяется на входе: раньше ?day=999
        # считался как ни в чём не бывало и клал мусор в кэш.
    ]

    failed = 0
    for path, ok in checks:
        try:
            payload, secs = get(path)
            good = ok(payload)
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ {path} — {type(exc).__name__}: {exc}")
            failed += 1
            continue
        mark = "✓" if good else "✗"
        failed += 0 if good else 1
        print(f"  {mark} {path:<38}{secs:>6.1f} с")

    # ---------- архив расчётов ----------
    #
    # Интерфейс заводит расчёт кнопкой, открывает его из истории и пишет
    # к нему заметку. Проверяем на зоне заказчика, а не на синтетическом
    # дне: именно зоны поедут на защиту, и именно на зоне вылезла разница
    # между тем, что движок умеет, и тем, что интерфейс ждёт.
    runs_ok = 0
    try:
        было = len(get("/api/runs")[0]["runs"])
        запись, _ = post("/api/runs", {"day": "восток", "note": "проверка",
                                       "params": {"balance_weight": 8}})
        поля = {"id", "code", "day", "date", "created", "note", "params",
                "factory", "shifts_from_day", "summary"}
        сводка = {"orders_total", "orders_assigned", "unassigned",
                  "engineers_total", "engineers_on_route", "coverage",
                  "gini", "occupancy_min", "occupancy_max", "solve_seconds"}
        if поля <= set(запись) and сводка <= set(запись["summary"]):
            print(f"  ✓ POST /api/runs: расчёт {запись['code']} по зоне "
                  f"«{запись['day']}», {запись['summary']['orders_assigned']} из "
                  f"{запись['summary']['orders_total']} за "
                  f"{запись['summary']['solve_seconds']:.1f} с")
            runs_ok += 1
        else:
            print(f"  ✗ POST /api/runs: не хватает полей "
                  f"{sorted(поля - set(запись)) or sorted(сводка - set(запись['summary']))}")
            failed += 1

        rid = запись["id"]
        стало = get("/api/runs")[0]["runs"]
        if len(стало) == было + 1 and any(r["id"] == rid for r in стало):
            print(f"  ✓ GET /api/runs: в архиве {len(стало)}, новый на месте")
            runs_ok += 1
        else:
            print("  ✗ GET /api/runs: архив не пополнился"); failed += 1

        формы, _ = get(f"/api/runs/{rid}")
        if {"run", "plan", "explain", "simulation", "shifts"} <= set(формы) \
                and формы["plan"]["kind"] == "plan":
            print("  ✓ GET /api/runs/<id>: все четыре формы и сама запись")
            runs_ok += 1
        else:
            print("  ✗ GET /api/runs/<id>: форм не хватает"); failed += 1

        одна, _ = get(f"/api/runs/{rid}/simulation")
        if одна.get("kind") == "simulation":
            print("  ✓ GET /api/runs/<id>/<форма>: одна форма отдельно")
            runs_ok += 1
        else:
            print("  ✗ GET /api/runs/<id>/<форма>"); failed += 1

        с_заметкой, _ = post(f"/api/runs/{rid}/note", {"note": "наш план"})
        снова, _ = get(f"/api/runs/{rid}")
        if с_заметкой["note"] == "наш план" == снова["run"]["note"]:
            print("  ✓ POST /api/runs/<id>/note: заметка сохранена")
            runs_ok += 1
        else:
            print("  ✗ POST /api/runs/<id>/note"); failed += 1

        # Сохранение пересчёта. Интерфейс сперва зовёт /replan, потом
        # кладёт увиденное в архив — движок обязан взять готовое из кэша,
        # а не считать заново: новый счёт мог бы дать другой план.
        get("/api/replan?day=восток&at=820&urgent=2")
        сохранён, _ = post("/api/runs", {
            "source": "sim", "note": "проверка",
            "replan": {"day": "восток", "at": 820, "urgent": 2}})
        if поля <= set(сохранён) and сохранён.get("kind"):
            print(f"  ✓ POST /api/runs (пересчёт): сохранён как "
                  f"{сохранён['code']}, «{сохранён['kind']}», "
                  f"{сохранён['summary']['solve_seconds']:.2f} с без пересчёта")
            runs_ok += 1
        else:
            print("  ✗ POST /api/runs (пересчёт): запись не та"); failed += 1

        # Открытая запись обязана быть тем же планом, что и её карточка.
        # Прежняя проверка утверждала только «все четыре формы на месте»,
        # и потому не замечала, что формы эти — от другого плана: карточка
        # «39 из 42» открывалась утренним днём на 66 заявок.
        откр, _ = get(f"/api/runs/{сохранён['id']}")
        св = сохранён["summary"]
        м = откр.get("plan", {}).get("meta", {})
        ok_тот_же = (м.get("orders_total") == св["orders_total"]
                     and м.get("orders_assigned") == св["orders_assigned"]
                     and откр["plan"]["kind"] == "replan")
        # Форм целого дня у пересчёта нет и подставлять их нельзя.
        try:
            get(f"/api/runs/{сохранён['id']}/simulation")
            ok_нет_лишних = False
        except urllib.error.HTTPError as exc:
            ok_нет_лишних = exc.code == 400
        if ok_тот_же and ok_нет_лишних:
            print(f"  ✓ {'сохранённый пересчёт открывается собой':<38}"
                  f"{м['orders_assigned']:>4} из {м['orders_total']}")
            runs_ok += 1
        else:
            print(f"  ✗ сохранённый пересчёт: план тот же {ok_тот_же} "
                  f"(карточка {св['orders_assigned']}/{св['orders_total']}, "
                  f"план {м.get('orders_assigned')}/{м.get('orders_total')}), "
                  f"лишних форм нет {ok_нет_лишних}")
            failed += 1

        # «У кого на участке»: авария приходит в один из восьми ближайших по
        # дороге домов заявок к точке, где инженер в момент пересчёта.
        # Прежде движок поле молча выбрасывал — аварии ложились по зоне, а
        # окно правки писало «на участке у N»; неизвестный инженер проходил.
        import random as _random
        from .replan import simulate_until as _до_момента
        д_в, п_в = STAND.day_and_plan("восток")
        кто = д_в.engineers[0].id
        около = _до_момента(д_в, п_в, 820,
                            _random.Random(seed_of("восток") * 1000)).position[кто][0]
        дома_в: dict[int, list] = {}
        for o in д_в.orders:
            дома_в.setdefault(o.node, []).append(o)
        ближ = sorted((n for n in дома_в if n != около),
                      key=lambda n: (д_в.network.road_km_between(около, n), n))[:8]
        точки = {(round(o.lat, 6), round(o.lon, 6)) for n in ближ for o in дома_в[n]}

        def _аварии(план) -> set:
            ид = set(план["meta"]["replan"]["urgent_ids"])
            return {(round(o["lat"], 6), round(o["lon"], 6))
                    for o in план["orders"] if o["id"] in ид}

        рп, _ = get(f"/api/replan?day=восток&at=820&urgent=2&urgent_near={кто}")
        _, код_чужой = get_any("/api/replan?day=восток&at=820&urgent=2&urgent_near=E99")
        без, _ = get("/api/replan?day=восток&at=820&urgent=2")
        ав = _аварии(рп)
        if (рп["meta"]["replan"].get("urgent_near") == кто and len(ав) == 2
                and ав <= точки and код_чужой == 400
                and без["meta"]["replan"].get("urgent_near", "нет поля") is None):
            print(f"  ✓ {'авария у кого на участке':<38}{кто}: обе в 8 ближайших домах, "
                  f"чужой — 400")
            runs_ok += 1
        else:
            print(f"  ✗ urgent_near={кто}: в ответе "
                  f"{рп['meta']['replan'].get('urgent_near', 'нет поля')}, аварий "
                  f"{len(ав)}, вне 8 ближайших {len(ав - точки)}, E99 — код {код_чужой}")
            failed += 1

        # Сохранённый пересчёт помнит привязку и открывается теми же авариями.
        с_near, _ = post("/api/runs", {
            "source": "sim", "note": "проверка urgent_near",
            "replan": {"day": "восток", "at": 820, "urgent": 2, "urgent_near": кто}})
        о_near, _ = get(f"/api/runs/{с_near['id']}")
        if (о_near["plan"]["meta"]["replan"].get("urgent_near") == кто
                and _аварии(о_near["plan"]) == ав):
            print(f"  ✓ {'сохранённый пересчёт помнит участок':<38}{кто}")
            runs_ok += 1
        else:
            print(f"  ✗ сохранённый пересчёт с urgent_near: в плане "
                  f"{о_near['plan']['meta']['replan'].get('urgent_near', 'нет поля')}, "
                  f"аварии те же {_аварии(о_near['plan']) == ав}")
            failed += 1

        # Сохранённые сравнения: движок их не считает, только хранит.
        было_с = len(get("/api/compares")[0]["compares"])
        набор = [{"id": r["id"], "code": r["code"], "created": r["created"],
                  "orders": r["summary"]["orders_total"],
                  "assigned": r["summary"]["orders_assigned"],
                  "coverage": r["summary"]["coverage"], "assigned_share": 0.9,
                  "routes": 1, "visits": 1, "travel_minutes": 1, "occupancy": 0.5,
                  "engineers_total": r["summary"]["engineers_total"],
                  "engineers_on_route": r["summary"]["engineers_on_route"]}
                 for r in get("/api/runs")[0]["runs"][:2]]
        сравнение, _ = post("/api/compares", {"runs": набор, "note": "проверка"})
        стало_с = get("/api/compares")[0]["compares"]
        if len(стало_с) == было_с + 1 and len(сравнение["runs"]) == 2:
            print(f"  ✓ POST /api/compares: {сравнение['code']}, "
                  f"расчётов в наборе {len(сравнение['runs'])}")
            runs_ok += 1
        else:
            print("  ✗ POST /api/compares"); failed += 1

        # Границы набора движок проверяет сам — так обещано интерфейсу.
        try:
            post("/api/compares", {"runs": набор[:1]})
            print("  ✗ /api/compares принял набор из одного расчёта"); failed += 1
        except Exception:
            print("  ✓ набор из одного расчёта отвергнут")
            runs_ok += 1

        удалено = delete(f"/api/compares/{сравнение['id']}")
        if удалено.get("deleted") == сравнение["id"]:
            print("  ✓ DELETE /api/compares/<id>: сравнение убрано, расчёты целы")
            runs_ok += 1
        else:
            print("  ✗ DELETE /api/compares/<id>"); failed += 1

        # Переменные расчёта не трогают глобальные настройки: они общие
        # для всех запросов, и один расчёт не вправе их менять.
        до = get("/api/settings")[0]
        post("/api/runs", {"day": "восток", "params": {"balance_weight": 0}})
        после = get("/api/settings")[0]
        if до == после:
            print("  ✓ переменные расчёта не меняют глобальные настройки")
            runs_ok += 1
        else:
            print("  ✗ расчёт подменил глобальные настройки"); failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ архив расчётов — {type(exc).__name__}: {exc}")
        failed += 1

    # Журнал: сообщённое переживает пересчёт и меняет план.
    try:
        post("/api/journal/reset", {"day": 1})
        j, _ = get("/api/journal?day=1")
        first_eng = sorted(j["assignment"])[0]
        first_order = j["assignment"][first_eng][0]
        gone = sorted(j["assignment"])[1]

        post("/api/event", {"day": 1, "kind": "done", "order": first_order,
                            "at": 9 * 60 + 40})
        post("/api/event", {"day": 1, "kind": "engineer_out", "engineer": gone,
                            "at": 13 * 60})
        # Заявка, поступившая по ходу дня, — координаты берём у любой
        # утренней, чтобы точка заведомо лежала на карте.
        plan_doc, _ = get("/api/plan?day=1")
        somewhere = plan_doc["orders"][5]
        made, _ = post("/api/event", {
            "day": 1, "kind": "order_new", "at": 13 * 60,
            "lat": somewhere["lat"], "lon": somewhere["lon"],
            "work_type": "repair", "window_start": 13 * 60,
            "window_end": 17 * 60, "est_minutes": 45})
        new_id = made["recorded"]["order"]

        st_now, _ = get("/api/state?day=1&at=820")
        ok_state = (first_order in st_now["done"]
                    and gone in st_now["summary"]["absent"]
                    and first_order not in st_now["pending"].get(first_eng, [])
                    and st_now["summary"]["new_orders"] == 1)

        rp, secs = get("/api/replan?day=1&at=820&urgent=2&source=journal")
        meta = rp["meta"]["replan"]
        in_plan = any(st["order_id"] == new_id
                      for r in rp["routes"] for st in r["stops"])
        ok_replan = (meta["source"] == "journal"
                     and meta["incident"]["engineer_id"] == gone
                     and not any(r["engineer_id"] == gone for r in rp["routes"])
                     and new_id in meta["reported_ids"]
                     and in_plan
                     and "journal" in meta)

        # Повторный отчёт по той же заявке должен быть отбит.
        try:
            post("/api/event", {"day": 1, "kind": "done", "order": first_order,
                                "at": 900})
            ok_dup = False
        except urllib.error.HTTPError as exc:
            ok_dup = exc.code == 400

        post("/api/journal/reset", {"day": 1})
        after, _ = get("/api/journal?day=1")
        ok_reset = after["summary"]["events"] == 0

        if ok_state and ok_replan and ok_dup and ok_reset:
            print(f"  ✓ {'журнал: отчёт, новая заявка, пересчёт, сброс':<38}"
                  f"{secs:>6.1f} с")
        else:
            print(f"  ✗ журнал сработал не полностью: состояние {ok_state}, "
                  f"пересчёт {ok_replan}, дубль отбит {ok_dup}, сброс {ok_reset}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ журнал — {type(exc).__name__}: {exc}")
        failed += 1

    # Журнал на зоне заказчика. Блок выше работает на синтетическом дне, и
    # это было слепое пятно: там есть навык «Ремонт», а у бригады
    # заказчика навыков ровно три, и заявка с умолчанием `repair`
    # оказывалась вечно неназначенной. Тот же баг уже чинился в
    # `replan.urgent_orders` и вернулся в журнал, потому что проверки на
    # зоне не было ни одной. Здесь же сверяется граница суток: у зоны она
    # 22:00, а поле `Order.hard_end` по умолчанию 21:00.
    try:
        post("/api/journal/reset", {"day": "восток"})
        plan_z, _ = get("/api/plan?day=восток")
        граница = plan_z["meta"]["hard_end"]
        точка = plan_z["orders"][0]

        # Вид работ не называем нарочно: подобрать посильный — работа
        # движка, и проверяем мы её по результату, а не по механике.
        # Время позднее, чтобы окно упёрлось в границу суток.
        поздно = граница - 90
        made_z, _ = post("/api/event", {
            "day": "восток", "kind": "order_new", "at": поздно,
            "lat": точка["lat"], "lon": точка["lon"]})
        запись = made_z["recorded"]

        ok_окно = (запись["window_end"] <= граница
                   and запись["sla_deadline"] <= граница)

        rp_z, secs_z = get(f"/api/replan?day=восток&at={поздно}"
                           f"&urgent=0&source=journal")
        ok_взяли = any(st["order_id"] == запись["order"]
                       for r in rp_z["routes"] for st in r["stops"])

        post("/api/journal/reset", {"day": "восток"})
        # Диспетчер вправе завести работу, которую в эту смену некому
        # взять. Это не поломка дня, а ответ: заявка обязана остаться
        # неназначенной с внятной причиной, а день — спланироваться.
        # Пока это считалось поломкой, экран инцидента отдавал 400 по
        # всему дню, и журнал на диске делал это состояние постоянным.
        post("/api/event", {
            "day": "восток", "kind": "order_new", "at": поздно,
            "work_type": "repair",          # навыка «repair» у зоны нет
            "lat": точка["lat"], "lon": точка["lon"]})
        rp_н, _ = get(f"/api/replan?day=восток&at={поздно}"
                      f"&urgent=0&source=journal")
        новые = rp_н["meta"]["replan"]["reported_ids"]
        причины = {d["order_id"]: d["reason"]
                   for d in rp_н.get("unassigned_detail", [])}
        ok_не_упал = bool(новые)
        ok_причина = all("навык" in причины.get(o, "") for o in новые)
        ok_не_взяли = not any(st["order_id"] in новые
                              for r in rp_н["routes"] for st in r["stops"])

        post("/api/journal/reset", {"day": "восток"})
        after_z, _ = get("/api/journal?day=восток")
        ok_сброс = after_z["summary"]["events"] == 0

        if not (ok_не_упал and ok_причина and ok_не_взяли):
            print(f"  ✗ заявка на навык, которым никто не владеет: "
                  f"пересчёт прошёл {ok_не_упал}, причина названа {ok_причина}, "
                  f"не назначена {ok_не_взяли}")
            failed += 1
        else:
            print(f"  ✓ {'некому взять — причина, а не отказ считать день':<38}")

        if ok_взяли and ok_окно and ok_сброс:
            print(f"  ✓ {'журнал на зоне: заявка назначена, окно в сутках':<38}"
                  f"{secs_z:>6.1f} с")
        else:
            print(f"  ✗ журнал на зоне: заявку назначили {ok_взяли} "
                  f"(вид работ «{запись['work_type']}»), "
                  f"окно подрезано {ok_окно}, сброс {ok_сброс}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ журнал на зоне — {type(exc).__name__}: {exc}")
        failed += 1

    # Три вещи, которых интерфейсу не хватало, чтобы перестать угадывать.
    #
    # `meta.day`: зона не приходила ни в одной форме, а по дате её не
    # различить — у всех трёх зон она одна, 2026-08-17. Вёрстка держала
    # таблицу зон руками и не могла сказать, на какой из двух запросов в
    # полёте пришёл ответ.
    #
    # `/api/catalogue`: русские названия навыков лежали в `SKILL_TITLES` и
    # наружу не отдавались, вёрстка показывала голые `install` и
    # `emergency`. Виды работ собирались по одному дню, и фильтр выходил
    # разным на разных зонах.
    #
    # `forms`: какие формы у записи есть, было нечем узнать заранее —
    # клиент просил все четыре и на лишних получал 400.
    try:
        формы_дня = {}
        for ручка, вид in (("plan", "plan"), ("explain", "explain"),
                           ("simulation", "simulation"), ("shifts", "shifts")):
            тело, _ = get(f"/api/{ручка}?day=югоцентр")
            формы_дня[вид] = тело.get("meta", {}).get("day")
        ok_день = all(v == "югоцентр" for v in формы_дня.values())
        # Синтетический день зовут его номером, и это тоже должно приходить.
        синт, _ = get("/api/plan?day=1")
        ok_синт = синт["meta"].get("day") == "1"

        спр, _ = get("/api/catalogue")
        навыки = {s["code"] for s in спр.get("skills", [])}
        ok_навыки = navyki_ok = навыки == {"local", "install", "emergency"} and all(
            s["title"] and s["title"] != s["code"] for s in спр["skills"])
        # Видов работ должно быть больше, чем встречается в одной зоне:
        # фильтр по одному дню и был тем, что чинится.
        в_зоне = {o["work_type"] for o in get("/api/plan?day=югоцентр")[0]["orders"]}
        ok_работы = len(спр.get("work_types", [])) > len(в_зоне)
        ok_транспорт = {t["code"] for t in спр.get("transport", [])} == {
            "car", "foot", "bike", "transit"}

        полный = [r for r in get("/api/runs")[0]["runs"] if not r.get("replan")
                  and not r.get("kind")]
        пересчёты = [r for r in get("/api/runs")[0]["runs"] if r.get("replan")]
        ok_формы = (bool(полный) and bool(пересчёты)
                    and полный[0].get("forms") == ["plan", "explain",
                                                   "simulation", "shifts"]
                    and пересчёты[0].get("forms") == ["plan"])
        # И обещанное полем обязано сбываться: что названо — отдаётся,
        # что не названо — отвергается.
        ok_сбылось = True
        for вид in пересчёты[0]["forms"]:
            get(f"/api/runs/{пересчёты[0]['id']}/{вид}")
        for вид in ("explain", "simulation", "shifts"):
            try:
                get(f"/api/runs/{пересчёты[0]['id']}/{вид}")
                ok_сбылось = False
            except urllib.error.HTTPError:
                pass

        if (ok_день and ok_синт and ok_навыки and ok_работы and ok_транспорт
                and ok_формы and ok_сбылось):
            print(f"  ✓ {'формы называют свой день, справочник и forms':<38}"
                  f"{len(спр['work_types']):>4} вида работ")
            runs_ok += 1
        else:
            print(f"  ✗ то, чего ждёт интерфейс: meta.day по зоне {ok_день} "
                  f"({формы_дня}), по синтетике {ok_синт}, навыки "
                  f"{ok_навыки}, виды работ {ok_работы}, транспорт "
                  f"{ok_транспорт}, forms {ok_формы}, обещание сбылось "
                  f"{ok_сбылось}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ справочники и meta.day — {type(exc).__name__}: {exc}")
        failed += 1

    # Ручное переназначение заявки. Единственное «необходимо заложить»,
    # прозвучавшее на сессии вопросов: диспетчер не согласен с планом и
    # должен мочь сказать, кто поедет, а не только «пересчитайте».
    #
    # Проверяется не «кнопка нажалась», а то, ради чего она нужна:
    # решение человека переживает пересчёт. Закреплённая заявка либо у
    # названного инженера, либо не назначена вовсе — у третьего она
    # оказаться не может, иначе диспетчер подвинул бы её и увидел, как
    # движок двигает обратно.
    try:
        post("/api/journal/reset", {"day": "восток"})
        план_р, _ = get("/api/plan?day=восток")
        занятость = {r["engineer_id"]: len(r["stops"]) for r in план_р["routes"]}
        маршрут = план_р["routes"][0]
        заявка_р = маршрут["stops"][0]["order_id"]
        был_у = маршрут["engineer_id"]
        о = next(o for o in план_р["orders"] if o["id"] == заявка_р)

        # Кому отдать: самый свободный из тех, кто вообще может взять.
        годные = [e for e in план_р["engineers"]
                  if e["id"] != был_у and о["skill"] in e["skills"]
                  and (not о.get("requires_transport")
                       or о["requires_transport"] == e["transport"])]
        кому = min(годные, key=lambda e: занятость.get(e["id"], 0))["id"]

        событие, _ = post("/api/event", {
            "day": "восток", "kind": "assigned", "at": 540,
            "order": заявка_р, "engineer": кому})
        ok_запись = (событие["recorded"]["engineer"] == кому
                     and событие["recorded"]["from"] == был_у)

        журнал_р, _ = get("/api/journal?day=восток")
        ok_держит = заявка_р in журнал_р["assignment"].get(кому, [])

        пересчёт_р, _ = get(f"/api/replan?day=восток&at=540&urgent=0&source=journal")
        где_р = {s["order_id"]: r["engineer_id"]
                 for r in пересчёт_р["routes"] for s in r["stops"]}
        у_кого = где_р.get(заявка_р)
        # Вот оно: у третьего оказаться не может.
        ok_пережило = у_кого in (кому, None)
        назначена = у_кого == кому

        # Невозможное закрепление обязано быть отвергнуто словами, а не
        # принято молча: молча принятое испортит все пересчёты дня.
        нет_навыка = next((e["id"] for e in план_р["engineers"]
                           if о["skill"] not in e["skills"]), None)
        ok_отказ = False
        if нет_навыка:
            try:
                post("/api/event", {"day": "восток", "kind": "assigned",
                                    "at": 540, "order": заявка_р,
                                    "engineer": нет_навыка})
            except urllib.error.HTTPError as exc:
                ok_отказ = exc.code == 400
        post("/api/journal/reset", {"day": "восток"})

        if ok_запись and ok_держит and ok_пережило and ok_отказ:
            print(f"  ✓ {'ручное переназначение переживает пересчёт':<40}"
                  f"{был_у}→{кому}"
                  f"{', назначена' if назначена else ', места не нашлось'}")
            runs_ok += 1
        else:
            print(f"  ✗ ручное переназначение: записано {ok_запись}, журнал "
                  f"держит {ok_держит}, пережило пересчёт {ok_пережило} "
                  f"(закрепили за {кому}, оказалась у {у_кого}), "
                  f"невозможное отвергнуто {ok_отказ}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ ручное переназначение — {type(exc).__name__}: {exc}")
        failed += 1

    # Статусы «отправлено» и «в пути» — обратная связь организаторов
    # 20 сентября. Тот же путь, что пройдёт интерфейс: события по HTTP,
    # состояние, пересчёт от журнала на зоне заказчика.
    try:
        post("/api/journal/reset", {"day": "восток"})
        план_с, _ = get("/api/plan?day=восток")
        длинные = [r for r in план_с["routes"] if len(r["stops"]) >= 2]
        м1, м2 = длинные[0], длинные[1]
        отпр, кто_отпр = м1["stops"][0]["order_id"], м1["engineer_id"]
        едет, кто_едет = м2["stops"][0]["order_id"], м2["engineer_id"]
        выезд = м2["stops"][0]["arrive"] - м2["stops"][0]["travel_minutes"]
        post("/api/event", {"day": "восток", "kind": "dispatched",
                            "order": отпр, "at": 540})
        post("/api/event", {"day": "восток", "kind": "en_route",
                            "order": едет, "at": выезд})
        try:
            post("/api/event", {"day": "восток", "kind": "en_route",
                                "order": м2["stops"][1]["order_id"],
                                "at": выезд + 1})
            ok_второй = False
        except urllib.error.HTTPError as exc:
            ok_второй = exc.code == 400

        сейчас = выезд + 5
        сост, _ = get(f"/api/state?day=восток&at={сейчас}")
        ok_статусы = (сост["statuses"].get(отпр) == "отправлено"
                      and сост["statuses"].get(едет) == "в пути"
                      and сост["underway"].get(едет) == кто_едет)
        пересчёт_с, _ = get(f"/api/replan?day=восток&at={сейчас}&urgent=0"
                            f"&source=journal&churn_penalty=0")
        где_с = {s["order_id"]: r["engineer_id"]
                 for r in пересчёт_с["routes"] for s in r["stops"]}
        ok_едет = (едет not in где_с and едет not in пересчёт_с["unassigned"]
                   and пересчёт_с["meta"]["replan"]["underway"].get(едет) == кто_едет)
        # Едущий освобождается у заявки после её окончания — не раньше.
        его = [r for r in пересчёт_с["routes"] if r["engineer_id"] == кто_едет]
        конец = м2["stops"][0]["finish"]
        ok_после = all(r["stops"][0]["arrive"] >= конец for r in его if r["stops"])
        ok_держит = (пересчёт_с["meta"].get("pinned", {}).get(отпр) == кто_отпр
                     and где_с.get(отпр) in (кто_отпр, None))
        post("/api/journal/reset", {"day": "восток"})
        if ok_второй and ok_статусы and ok_едет and ok_после and ok_держит:
            print(f"  ✓ {'«отправлено» и «в пути» переживают пересчёт':<40}"
                  f"{едет} едет с {кто_едет}")
            runs_ok += 1
        else:
            print(f"  ✗ статусы: второй выезд отвергнут {ok_второй}, статусы "
                  f"{ok_статусы}, «в пути» вне пересчёта {ok_едет}, едущий "
                  f"свободен после окончания {ok_после}, наряд держит {ok_держит}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ статусы — {type(exc).__name__}: {exc}")
        failed += 1

    # Оборудование — обратная связь 20 сентября: при перепланировании
    # заявку с прибором можно отдать только тому, у кого прибор в машине.
    try:
        план_о, _ = get("/api/plan?day=восток")
        заявки_о = {o["id"]: o for o in план_о["orders"]}

        def сумма(ids) -> dict:
            out: dict = {}
            for i in ids:
                for k, n in заявки_о[i]["equipment"].items():
                    out[k] = out.get(k, 0) + n
            return out

        ok_поля = (all("equipment" in o for o in план_о["orders"])
                   and any(o["equipment"] for o in план_о["orders"]))
        ok_итоги = all(r["totals"]["equipment"] == сумма(s["order_id"] for s in r["stops"])
                       for r in план_о["routes"])
        ok_утро = план_о["meta"]["equipment"]["stock"] is None
        кат, _ = get("/api/catalogue")
        ok_кат = ({e["code"] for e in кат["equipment"]}
                  == set(план_о["meta"]["equipment"]["titles"]))

        пересчёт_о, _ = get("/api/replan?day=восток&at=780&urgent=0&disabled=auto")
        запас_о = пересчёт_о["meta"]["equipment"]["stock"]
        ok_запас = запас_о is not None and all(
            all(n <= запас_о.get(r["engineer_id"], {}).get(k, 0)
                for k, n in r["totals"]["equipment"].items())
            for r in пересчёт_о["routes"])

        # Закрепление за тем, у кого прибора не хватит даже на эту заявку.
        # Строится, а не ищется: утром выдают под маршрут и штуку запаса, и
        # на живом утре такой пары может не быть — на «востоке» её нет, и
        # проверка молча проходила, ни разу не исполнив отказ. Поэтому
        # исполнитель сперва отчитывается по всем своим заявкам с этим
        # прибором: в машине остаётся одна запасная штука, а заявке нужно
        # больше.
        пара = None
        for о in план_о["orders"]:
            for вид, n in о["equipment"].items():
                if n < 2:
                    continue
                for r in план_о["routes"]:
                    e = next(x for x in план_о["engineers"] if x["id"] == r["engineer_id"])
                    if (e["id"] != о["assigned_to"] and о["skill"] in e["skills"]
                            and о.get("requires_transport") in (None, e["transport"])):
                        пара = (о["id"], e["id"], вид,
                                [s["order_id"] for s in r["stops"]
                                 if заявки_о[s["order_id"]]["equipment"].get(вид)])
                        break
                if пара:
                    break
            if пара:
                break
        ok_отказ = False
        if пара:
            post("/api/journal/reset", {"day": "восток"})
            for i, своя in enumerate(пара[3]):
                post("/api/event", {"day": "восток", "kind": "done",
                                    "order": своя, "at": 600 + i})
            try:
                post("/api/event", {"day": "восток", "kind": "assigned", "at": 700,
                                    "order": пара[0], "engineer": пара[1]})
            except urllib.error.HTTPError as exc:
                ok_отказ = exc.code == 400
            post("/api/journal/reset", {"day": "восток"})

        if ok_поля and ok_итоги and ok_утро and ok_кат and ok_запас and ok_отказ:
            print(f"  ✓ {'оборудование: выдача, остаток, отказ':<40}"
                  f"{пара[0]} за {пара[1]} не закрепить")
        else:
            print(f"  ✗ оборудование: поля {ok_поля}, итоги маршрутов {ok_итоги}, "
                  f"утром без остатка {ok_утро}, справочник {ok_кат}, пересчёт в "
                  f"пределах остатка {ok_запас}, отказ в закреплении {ok_отказ}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ оборудование — {type(exc).__name__}: {exc}")
        failed += 1

    # «Сколько ещё людей нужно». Постановщик продиктовал формат дословно:
    # «для того чтобы выполнить оставшиеся заявки, нужно ещё плюс 5
    # исполнителей». Здесь проверяется путь по HTTP: фраза в этом виде,
    # слоты складываются в названное число, пустой участок отвечает
    # «не нужны», ответ кэшируется.
    #
    # Выбор НАИБОЛЬШЕГО числа среди закрывших прогонов — то, на чём
    # держится честность числа, — здесь НЕ проверяется, хоть и сверяется:
    # на живых данных закрывшие прогоны совпадают по числу слотов, и
    # замена `max` на `min` проходит зелёной (проверено). Это правило
    # сторожит selfcheck на прогонах, которые расходятся.
    try:
        import time as _t
        шт, _ = get("/api/staffing?day=восток")
        закрывшие = [s["needed"] for s in шт["seeds"] if s["left"] == 0]
        ok_надёжно = bool(закрывшие) and шт["needed"] == max(закрывшие)
        ok_сумма = sum(с["count"] for с in шт["slots"]) == шт["needed"]
        ok_фраза = (f"нужно ещё +{шт['needed']} " in шт["phrase"]
                    and "оставшиеся" in шт["phrase"])
        ok_день = шт["meta"]["day"] == "восток"

        пусто, _ = get("/api/staffing?day=югоцентр")
        ok_ноль = (пусто["unassigned_now"] == 0 and пусто["needed"] == 0
                   and "не нужны" in пусто["phrase"])

        старт = _t.time()
        get("/api/staffing?day=восток")
        ok_кэш = _t.time() - старт < 2.0

        if ok_надёжно and ok_сумма and ok_фраза and ok_день and ok_ноль and ok_кэш:
            print(f"  ✓ {'сколько людей нужно: надёжное число':<40}"
                  f"восток +{шт['needed']}, югоцентр +0")
            runs_ok += 1
        else:
            print(f"  ✗ сколько людей нужно: надёжное число {ok_надёжно} "
                  f"(в голове +{шт.get('needed')}, закрывшие прогоны "
                  f"{закрывшие}), сумма слотов {ok_сумма}, фраза {ok_фраза} "
                  f"(«{шт.get('phrase')}»), день {ok_день}, пустой участок "
                  f"{ok_ноль}, кэш {ok_кэш}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ сколько людей нужно — {type(exc).__name__}: {exc}")
        failed += 1

    # Пользовательская ручка `duration_factor` доезжает до плана, и план
    # при этом проверяется. Это самое крупное слагаемое времени и
    # единственная настройка, которой можно «сократить работу вдвое и
    # показать красивое покрытие»; до 20 сентября её не проверял никто:
    # инварианты длительность не смотрели вовсе, а расчёт с переменными
    # интерфейса — единственный путь, где эта ручка не единица, — уходил
    # наружу вообще без проверки инвариантов.
    try:
        по_фактору = {}
        for фактор in (0.5, 2.0):
            расчёт, _ = post("/api/runs", {
                "day": "восток", "note": f"фактор {фактор}",
                "params": {"duration_factor": фактор}})
            формы_ф, _ = get(f"/api/runs/{расчёт['id']}")
            план_ф = формы_ф["plan"]
            в_маршрутах = {s["order_id"] for r in план_ф["routes"]
                           for s in r["stops"]}
            работа = sum(s["finish"] - s["start"] for r in план_ф["routes"]
                         for s in r["stops"])
            норматив = sum(o["est_minutes"] for o in план_ф["orders"]
                           if o["id"] in в_маршрутах)
            по_фактору[фактор] = работа / норматив if норматив else 0.0

        ok_фактор = all(abs(по_фактору[ф] - ф) < 0.01 for ф in (0.5, 2.0))
        if ok_фактор:
            print(f"  ✓ {'множитель длительности доезжает до плана':<38}"
                  f"{по_фактору[0.5]:>5.2f} и {по_фактору[2.0]:.2f}")
            runs_ok += 1
        else:
            print(f"  ✗ множитель длительности не доехал: просили 0.5 и 2.0, "
                  f"в плане {по_фактору}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ множитель длительности — {type(exc).__name__}: {exc}")
        failed += 1

    # Сохранённый пересчёт по журналу: открыть карточку — читать, а не
    # писать. Это ровно та ошибка, которую чинил `def3e19`, уехавшая в
    # ветку `source=journal`: `run_forms` зовёт `replan` заново, а та
    # ветка делает `journal.adopt(); journal.save()`. Получалось, что
    # обычный GET по архиву переписывал день диспетчера — а вёрстка
    # подгружает карточки списком, то есть делала это пачкой и молча.
    #
    # Проверяется двумя разными вопросами, и оба обязательны: карточка
    # обязана открыться собой (а не сегодняшним журналом), и журнал после
    # чтения обязан остаться прежним до байта.
    try:
        post("/api/journal/reset", {"day": "восток"})
        план_ж, _ = get("/api/plan?day=восток")
        точка_ж = план_ж["orders"][0]
        момент = 12 * 60
        for _ in range(3):
            post("/api/event", {"day": "восток", "kind": "order_new",
                                "at": момент, "lat": точка_ж["lat"],
                                "lon": точка_ж["lon"]})

        get(f"/api/replan?day=восток&at={момент}&urgent=0&source=journal")
        сохр_ж, _ = post("/api/runs", {
            "source": "journal", "note": "пересчёт по журналу",
            "replan": {"day": "восток", "at": момент, "urgent": 0}})
        карточка = сохр_ж["summary"]

        # День диспетчера поехал дальше: ещё одна заявка после сохранения.
        post("/api/event", {"day": "восток", "kind": "order_new",
                            "at": момент, "lat": точка_ж["lat"],
                            "lon": точка_ж["lon"]})
        журнал_до, _ = get("/api/journal?day=восток")

        откр_ж, _ = get(f"/api/runs/{сохр_ж['id']}")
        журнал_после, _ = get("/api/journal?day=восток")

        м_ж = откр_ж.get("plan", {}).get("meta", {})
        ok_собой = (м_ж.get("orders_total") == карточка["orders_total"]
                    and м_ж.get("orders_assigned") == карточка["orders_assigned"])
        ok_не_тронул = (журнал_после["assignment"] == журнал_до["assignment"]
                        and журнал_после["events"] == журнал_до["events"])
        post("/api/journal/reset", {"day": "восток"})

        if ok_собой and ok_не_тронул:
            print(f"  ✓ {'пересчёт по журналу: открылся собой, журнал цел':<38}"
                  f"{м_ж['orders_assigned']:>4} из {м_ж['orders_total']}")
            runs_ok += 1
        else:
            print(f"  ✗ сохранённый пересчёт по журналу: открылся собой "
                  f"{ok_собой} (карточка "
                  f"{карточка['orders_assigned']}/{карточка['orders_total']}, "
                  f"план {м_ж.get('orders_assigned')}/{м_ж.get('orders_total')}), "
                  f"журнал не тронут {ok_не_тронул}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ пересчёт по журналу — {type(exc).__name__}: {exc}")
        failed += 1

    # Показ пересчёта от журнала — не решение. Прежде GET /api/replan с
    # source=journal сразу усваивал план в журнал дня: окно правки только
    # показывало пересчёт, а у 6 из 13 инженеров востока уже менялись
    # маршруты, и «Отменить правку» ничего не отменяла. Назначением дня его
    # делает «Принять» — POST /api/journal/adopt с ярлыком из ответа.
    def _журнал_без_пустых(ж: dict) -> dict:
        return {e: ids for e, ids in ж["assignment"].items() if ids}

    try:
        post("/api/journal/reset", {"day": "восток"})
        план_п, _ = get("/api/plan?day=восток")
        точка_п = план_п["orders"][0]
        момент = 12 * 60
        новая = {"day": "восток", "kind": "order_new", "at": момент,
                 "lat": точка_п["lat"], "lon": точка_п["lon"]}
        for _ in range(3):
            post("/api/event", новая)
        ж0, _ = get("/api/journal?day=восток")
        показ, _ = get(f"/api/replan?day=восток&at={момент}&urgent=0&source=journal")
        ж1, _ = get("/api/journal?day=восток")
        рп = показ["meta"]["replan"]
        ярлык = рп.get("adopt_token")
        маршруты = {r["engineer_id"]: [s["order_id"] for s in r["stops"]]
                    for r in показ["routes"] if r["stops"]}
        # Показанный план обязан отличаться от журнала — иначе и «Принять»,
        # и снимок проверялись бы на пустом месте и покраснеть не могли.
        есть_что = (маршруты != _журнал_без_пустых(ж0)
                    and рп["assigned_now"] != рп["assigned_as_is"])
        if ж1 == ж0 and ярлык and есть_что:
            print(f"  ✓ {'показ пересчёта от журнала не пишет':<38}"
                  f"журнал цел, {рп['assigned_as_is']} → {рп['assigned_now']}")
            runs_ok += 1
        else:
            print(f"  ✗ показ пересчёта от журнала: журнал цел {ж1 == ж0}, "
                  f"ярлык {ярлык!r}, план отличается от журнала {есть_что}")
            failed += 1

        post("/api/journal/adopt", {"day": "восток", "token": ярлык})
        ж2, _ = get("/api/journal?day=восток")
        if _журнал_без_пустых(ж2) == маршруты and ж2["events"] == ж0["events"]:
            print(f"  ✓ {'«Принять» — журнал = показанный план':<38}"
                  f"{sum(map(len, маршруты.values()))} визитов")
            runs_ok += 1
        else:
            print("  ✗ «Принять»: журнал не совпал с показанным планом")
            failed += 1

        # Сохранённый после «Принять» — от журнала на момент показа. От
        # нынешнего (уже принятого) «как ехали» было бы самим этим планом.
        вызовы_ж: list = []
        прежний_ж = fast.solve
        fast.solve = lambda *a, **k: (вызовы_ж.append(1), прежний_ж(*a, **k))[1]
        try:
            сохр_п, _ = post("/api/runs", {
                "source": "journal", "note": "принятый пересчёт",
                "replan": {"day": "восток", "at": момент, "urgent": 0,
                           "adopt_token": ярлык}})
        finally:
            fast.solve = прежний_ж
        откр_п, _ = get(f"/api/runs/{сохр_п['id']}")
        как_ехали = откр_п["plan"]["meta"]["replan"]["assigned_as_is"]
        if как_ехали == рп["assigned_as_is"] and not вызовы_ж:
            print(f"  ✓ {'принятый и сохранённый — от показа':<38}"
                  f"как ехали {как_ехали}, как на экране, без счёта")
            runs_ok += 1
        else:
            print(f"  ✗ принятый и сохранённый: как ехали {как_ехали}, "
                  f"на экране было {рп['assigned_as_is']}, солвер звали {len(вызовы_ж)}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ показ и «Принять» — {type(exc).__name__}: {exc}")
        failed += 1

    # «Принять» после того, как в журнал что-то сообщили, — 409: человек
    # видел план от дня, которого больше нет.
    try:
        показ_2, _ = get(f"/api/replan?day=восток&at={момент}&urgent=0&source=journal")
        post("/api/event", новая)
        try:
            post("/api/journal/adopt", {"day": "восток",
                                        "token": показ_2["meta"]["replan"]["adopt_token"]})
            код = 200
        except urllib.error.HTTPError as exc:
            код = exc.code
        post("/api/journal/reset", {"day": "восток"})
        if код == 409:
            print(f"  ✓ {'«Принять» после нового события — 409':<38}")
            runs_ok += 1
        else:
            print(f"  ✗ «Принять» после нового события: код {код}, ожидалось 409")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ «Принять» после события — {type(exc).__name__}: {exc}")
        failed += 1

    # Сохранённый пересчёт обязан помнить, чем он был. Комментарий к
    # `save_replan` обещает «ровно то, что человек видел на экране», и
    # обещание не выполнялось дважды: ползунок `churn_penalty` в замысел
    # не попадал вовсе — открытая карточка считалась общей настройкой
    # компании, — а `disabled=auto` ложился строкой «auto», и запись не
    # помнила, кто именно выбыл: при открытии `auto` разрешался заново, и
    # это мог оказаться другой инженер.
    try:
        пересчёт_и, _ = get("/api/replan?day=восток&at=720&urgent=0"
                            "&disabled=auto&churn_penalty=0")
        мета_и = пересчёт_и["meta"]["replan"]
        выбыл = (мета_и.get("incident") or {}).get("engineer_id")

        сохр_и, _ = post("/api/runs", {
            "source": "sim", "note": "инцидент с ползунком",
            "replan": {"day": "восток", "at": 720, "urgent": 0,
                       "disabled": "auto", "churn_penalty": 0}})
        откр_и, _ = get(f"/api/runs/{сохр_и['id']}")
        замысел_и = откр_и["run"].get("replan") or {}
        мета_о = откр_и["plan"]["meta"]["replan"]

        ok_кто = bool(выбыл) and замысел_и.get("disabled") == выбыл
        ok_ползунок = (мета_о.get("churn_penalty") == 0
                       and abs(мета_о.get("stability", -1)
                               - мета_и["stability"]) < 1e-9)
        ok_params = откр_и["run"].get("params", {}).get("churn_penalty") == 0

        if ok_кто and ok_ползунок and ok_params:
            print(f"  ✓ {'пересчёт помнит ползунок и кто выбыл':<38}"
                  f"{выбыл:>6}, устойчивость {мета_о['stability']:.3f}")
            runs_ok += 1
        else:
            print(f"  ✗ сохранённый пересчёт забыл себя: кто выбыл "
                  f"{ok_кто} (в замысле {замысел_и.get('disabled')!r}, "
                  f"а выбыл {выбыл!r}), ползунок {ok_ползунок} "
                  f"(сохраняли 0, открылось "
                  f"{мета_о.get('churn_penalty')}, устойчивость "
                  f"{мета_и['stability']:.3f} → {мета_о.get('stability')}), "
                  f"переменные записи {ok_params}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ память пересчёта — {type(exc).__name__}: {exc}")
        failed += 1

    # Архив пишут двое: диспетчер из браузера и, скажем, замер из
    # терминала. Прежде каждый писал файл целиком из своей памяти, и
    # записи одного бесследно исчезали под записями другого; хуже того,
    # `id` складывался из миллисекунды и длины своего списка, так что
    # двое, начавшие с одинакового архива, получали одинаковые
    # идентификаторы. Второй `Stand` здесь — это и есть «другой процесс»:
    # он загрузил архив до того, как первый в него дописал.
    try:
        второй = Stand()
        до_двоих = {r["id"] for r in json.loads(runs_path().read_text())}

        # Сохраняется только показанное: оба стенда сперва показывают.
        get("/api/replan?day=восток&at=820&urgent=2")
        второй.replan(ident="восток", at=820, urgent_count=2)
        первый_id = post("/api/runs", {
            "source": "sim", "note": "писал диспетчер",
            "replan": {"day": "восток", "at": 820, "urgent": 2}})[0]["id"]
        запись_2 = второй.save_replan(
            {"day": "восток", "at": 820, "urgent": 2},
            source="sim", note="писал замер")

        на_диске = json.loads(runs_path().read_text())
        ids = [r["id"] for r in на_диске]
        коды = [r["code"] for r in на_диске]
        ok_оба = первый_id in ids and запись_2["id"] in ids
        ok_старое = до_двоих <= set(ids)
        ok_без_дублей = len(ids) == len(set(ids)) and len(коды) == len(set(коды))

        if ok_оба and ok_старое and ok_без_дублей:
            print(f"  ✓ {'архив пишут двое: обе записи уцелели':<38}"
                  f"{len(ids):>4} записей")
            runs_ok += 1
        else:
            print(f"  ✗ архив при двух пишущих: обе записи на месте {ok_оба}, "
                  f"прежние целы {ok_старое}, без дублей {ok_без_дублей} "
                  f"(записей {len(ids)}, разных id {len(set(ids))}, "
                  f"разных кодов {len(set(коды))})")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ архив при двух пишущих — {type(exc).__name__}: {exc}")
        failed += 1

    # Демонстрационные команды обязаны работать на данных заказчика.
    # Прежние — `disabled=E03`, `cancelled=R0038` — писались под
    # синтетический день и на зоне мертвы: E03 там единственный из
    # четырнадцати без маршрута, а номера заявок у заказчика числовые.
    # Первое молча возвращало пустой инцидент (ноль подхваченных, ноль
    # потерянных), второе — ошибку «нет такой заявки». Два шага сценария
    # ТЗ из шести. `auto` выбирает участника по самому дню, поэтому не
    # протухает при смене данных — но проверять это надо на зоне.
    try:
        ok_demo, подробно = True, []
        for параметр in ("disabled=auto", "delayed=auto:40", "cancelled=auto"):
            от, _ = get(f"/api/replan?day=восток&at=720&urgent=0&{параметр}")
            инц = от["meta"]["replan"].get("incident") or {}
            if инц.get("kind") in ("disabled", "delayed"):
                занят = len(инц.get("pending_was") or [])
                подробно.append(f"{инц.get('engineer_id')}:{занят}")
                # Событие с пустым инженером — не демонстрация.
                if занят == 0:
                    ok_demo = False
            else:
                свободно = инц.get("freed_minutes") or 0
                подробно.append(f"{(инц.get('order_ids') or ['?'])[0]}:{свободно}м")
                if свободно <= 0:
                    ok_demo = False
        if ok_demo:
            print(f"  ✓ {'демо-события auto на зоне не пустые':<38}"
                  f"{', '.join(подробно)}")
        else:
            print(f"  ✗ демо-события auto дали пустой инцидент: {', '.join(подробно)}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ демо-события auto — {type(exc).__name__}: {exc}")
        failed += 1

    # Кривая смен на зоне заказчика доходит до границы дня. `_slot`
    # зажимал конец отрезка к предпоследнему слоту, и слот 21:30–22:00 не
    # заполнялся никогда: график обрывался нулём по обеим линиям в час,
    # когда четверо работают, а подбор смен, оптимизирующий по этой же
    # кривой, был слеп ровно на границе дня заказчика. На синтетике
    # (граница 21:00) зажим не срабатывал — поэтому проверка на зоне.
    try:
        см, _ = get("/api/shifts?day=восток")
        план_з, _ = get("/api/plan?day=восток")
        граница = план_з["meta"]["hard_end"]
        последняя, предпоследняя = см["curve"][-1], см["curve"][-2]
        шаг = последняя["minute"] - предпоследняя["minute"]
        до_границы = sum(1 for e in план_з["engineers"] if e["shift_end"] == граница)
        ok_минута = последняя["minute"] + шаг == граница
        ok_спрос = последняя["demand_total"] > 0
        ok_руки = последняя["supply_current"] == до_границы
        if ok_минута and ok_спрос and ok_руки:
            print(f"  ✓ {'кривая смен доходит до границы дня':<38}"
                  f"{последняя['supply_current']:>4} чел. в последнем слоте")
        else:
            print(f"  ✗ кривая смен: последняя точка {последняя['minute']} при "
                  f"границе {граница} ({ok_минута}), спрос {последняя['demand_total']} "
                  f"({ok_спрос}), руки {последняя['supply_current']} из "
                  f"{до_границы} ({ok_руки})")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ кривая смен на зоне — {type(exc).__name__}: {exc}")
        failed += 1

    # Семь настроек: читаются, меняются, влияют на выдачу, сбрасывают кэш.
    try:
        was, _ = get("/api/settings")
        names = set(was["settings"])
        expected = {"churn_penalty", "duration_factor", "buffer_base", "buffer_step",
                    "balance_weight", "risk_high", "risk_medium"}
        ok_list = names == expected

        # Пороги подсветки: подняли — красного и жёлтого стало больше.
        def risk_counts():
            doc, _ = get("/api/plan?day=1")
            all_risks = [st["risk"] for r in doc["routes"] for st in r["stops"]]
            return sum(1 for x in all_risks if x != "low")

        before = risk_counts()
        upd, _ = post("/api/settings", {"risk_high": 45, "risk_medium": 90})
        ok_change = set(upd["changed"]) == {"risk_high", "risk_medium"}
        after = risk_counts()
        ok_effect = after > before

        # Живой контрол на экране инцидента: передан в запрос, виден в ответе.
        rp, _ = get("/api/replan?day=1&at=820&urgent=2&churn_penalty=250")
        ok_churn = rp["meta"]["replan"]["churn_penalty"] == 250.0

        # Мусор отбивается.
        try:
            post("/api/settings", {"churn_penalty": 99999})
            ok_bad = False
        except urllib.error.HTTPError as exc:
            ok_bad = exc.code == 400

        post("/api/settings", {"risk_high": was["settings"]["risk_high"]["default"],
                               "risk_medium": was["settings"]["risk_medium"]["default"]})

        if ok_list and ok_change and ok_effect and ok_churn and ok_bad:
            print("  ✓ настройки: семь ручек, меняются и меняют выдачу")
        else:
            print(f"  ✗ настройки: список {ok_list}, правка {ok_change}, "
                  f"эффект {ok_effect}, живой контрол {ok_churn}, отбой {ok_bad}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ настройки — {type(exc).__name__}: {exc}")
        failed += 1

    # Отмена заявки: третье событие пересчёта из ТЗ. Номер берём из
    # состояния дня, а не зашиваем — он зависит от того, как разыгрался
    # день до момента пересчёта.
    try:
        # Заявку берём из самого пересчёта, а не из `/api/state`: тот
        # смотрит в журнал диспетчера, а пересчёт с `source=sim`
        # разыгрывает день костями, и что именно к 13:40 уже выполнено,
        # эти двое знают по-разному.
        сначала, _ = get("/api/replan?day=1&at=820&urgent=0")
        впереди = [st["order_id"] for r in сначала["routes"] for st in r["stops"]]
        if not впереди:
            print("  ✗ отмена заявки: в 13:40 не осталось незакрытых визитов")
            failed += 1
        else:
            payload, secs = get(f"/api/replan?day=1&at=820&urgent=0"
                                f"&cancelled={впереди[0]}")
            if _cancel_ok(payload):
                inc = payload["meta"]["replan"]["incident"]
                print(f"  ✓ отмена заявки {впереди[0]}: освободилось "
                      f"{inc['freed_minutes']} мин, план пересобран   {secs:.1f} с")
            else:
                print("  ✗ отмена заявки: отменённая осталась в плане "
                      "или в неназначенных")
                failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ отмена заявки — {type(exc).__name__}: {exc}")
        failed += 1

    # Отменить уже выполненное нельзя.
    try:
        payload, code = get_any("/api/replan?day=1&at=820&cancelled=НЕТТАКОЙ")
        if code == 400 and payload.get("error"):
            print("  ✓ отмена несуществующей заявки отвергнута")
        else:
            print(f"  ✗ отмена несуществующей заявки принята (код {code})")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ отмена несуществующей — {type(exc).__name__}: {exc}")
        failed += 1

    # Идентификатор дня проверяется на входе: раньше ?day=999 считался
    # как ни в чём не бывало — минута процессорного времени и мусор в кэше.
    for плохой in ("999", "0", "нетзоны"):
        try:
            payload, code = get_any(f"/api/plan?day={плохой}")
            if code == 400 and payload.get("error"):
                print(f"  ✓ day={плохой} отвергнут: {payload['error'][:60]}")
            else:
                print(f"  ✗ day={плохой} принят (код {code}), а должен быть отвергнут")
                failed += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  ✗ day={плохой} — {type(exc).__name__}: {exc}")
            failed += 1

    # Неизвестное ИМЯ параметра раньше проходило молча: `?date=восток` —
    # так было написано в CONTRACT.md — давал код 200 и синтетический
    # день 1. Фронт по букве документа показал бы 80 заявок и 15 сентября
    # вместо зоны, без единого признака ошибки.
    try:
        payload, code = get_any("/api/plan?date=восток")
        if code == 400 and "day" in payload.get("error", ""):
            print(f"  ✓ {'date= отвергнут и назван верный параметр':<38}")
        else:
            print(f"  ✗ ?date=восток принят (код {code}), а должен быть отвергнут")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ ?date= — {type(exc).__name__}: {exc}")
        failed += 1

    # Кэш обязан знать о правке кода. Раньше в имени файла стоял только
    # отпечаток пользовательских настроек, и после правки солвера молча
    # возвращался вчерашний план — заметить это было нечем, потому что
    # ответ не несёт ни версии кода, ни времени расчёта.
    try:
        здоровье, _ = get("/api/health")
        свой = здоровье.get("code", "")
        get("/api/plan?day=восток")
        имена = [p.stem for p in CACHE_DIR.glob("day-зона-восток-*.json")]
        ok_в_имени = bool(свой) and any(и.rsplit("-", 1)[-1] == свой for и in имена)
        дни, _ = get("/api/days")
        ok_готов = "восток" in дни.get("ready", [])
        if ok_в_имени and ok_готов:
            print(f"  ✓ {'кэш помнит отпечаток кода ' + свой:<38}")
        else:
            print(f"  ✗ кэш и код: отпечаток в имени файла {ok_в_имени} "
                  f"(код «{свой}»), день числится готовым {ok_готов}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ отпечаток кода — {type(exc).__name__}: {exc}")
        failed += 1

    # Кривой запрос должен получить понятный отказ, а не пятисотку.
    try:
        get("/api/replan?day=1&disabled=E99")
        print("  ✗ несуществующий инженер принят, а должен быть отвергнут")
        failed += 1
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            print("  ✓ несуществующий инженер отвергнут с понятной ошибкой")
        else:
            print(f"  ✗ несуществующий инженер: код {exc.code}, ожидался 400")
            failed += 1

    # Пропавшая запись — 404, а не 400: интерфейс должен отличать свою
    # ошибку в запросе от записи, которую удалили из другого окна.
    try:
        _, код_расчёта = get_any("/api/runs/no-such-run")
        _, код_формы = get_any("/api/runs/no-such-run/plan")
        try:
            delete("/api/compares/no-such-compare"); код_сравнения = 200
        except urllib.error.HTTPError as exc:
            код_сравнения = exc.code
        if (код_расчёта, код_формы, код_сравнения) == (404, 404, 404):
            print("  ✓ пропавшая запись архива — 404, а не 400")
        else:
            print(f"  ✗ пропавшая запись: расчёт {код_расчёта}, форма {код_формы}, "
                  f"сравнение {код_сравнения}; ожидалось 404")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ пропавшая запись — {type(exc).__name__}: {exc}")
        failed += 1

    # Сравнение — только из того, что лежит в архиве.
    try:
        настоящий = get("/api/runs")[0]["runs"][0]
        post("/api/compares", {"runs": [настоящий, {"id": "run-выдуманный"}]})
        print("  ✗ сравнение приняло расчёт, которого в архиве нет")
        failed += 1
    except urllib.error.HTTPError as exc:
        if exc.code == 400:
            print("  ✓ сравнение с несуществующим расчётом отвергнуто")
        else:
            print(f"  ✗ сравнение с несуществующим расчётом: код {exc.code}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ сравнение с выдуманным расчётом — {type(exc).__name__}: {exc}")
        failed += 1

    # Запись без дня — отказ. Прежде подставлялся синтетический день 1, и
    # событие диспетчера ложилось в чужой журнал.
    try:
        коды = []
        for путь, тело in (("/api/runs", {"note": "без дня"}),
                           # Пересчёт без дня: прежде сохранялся синтетический
                           # день 1 — запрос с днём проходит выше.
                           ("/api/runs", {"source": "sim",
                                          "replan": {"at": 820, "urgent": 2}}),
                           # Событие, которое с днём прошло бы: иначе отказ
                           # пришёл бы по другой причине и проверка не могла
                           # бы покраснеть.
                           ("/api/event", {"kind": "engineer_delayed",
                                           "engineer": "E00", "minutes": 10,
                                           "at": 600}),
                           ("/api/journal/reset", {})):
            try:
                post(путь, тело); коды.append(200)
            except urllib.error.HTTPError as exc:
                коды.append(exc.code)
        if коды == [400, 400, 400, 400]:
            print("  ✓ запись без day отвергнута, а не отнесена к дню 1")
        else:
            print(f"  ✗ запись без day: коды {коды}, ожидалось 400")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ запись без day — {type(exc).__name__}: {exc}")
        failed += 1

    # Браузер с другого порта спрашивает разрешение до DELETE.
    try:
        req = urllib.request.Request(base + "/api/compares/x", method="OPTIONS")
        with urllib.request.urlopen(req, timeout=60) as resp:
            методы = resp.headers.get("Access-Control-Allow-Methods", "")
            тело = resp.read()
        if "DELETE" in методы and resp.status == 204 and not тело:
            print("  ✓ CORS пускает DELETE, предзапрос 204 без тела")
        else:
            print(f"  ✗ CORS: методы «{методы}», код {resp.status}, тело {len(тело)} байт")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ CORS — {type(exc).__name__}: {exc}")
        failed += 1

    # «Готов» — значит посчитан при нынешних настройках, а не при каких-то.
    try:
        было, _ = get("/api/settings")
        шаг = было["settings"]["buffer_step"]["value"]
        готов_до = "восток" in get("/api/days")[0]["ready"]
        post("/api/settings", {"buffer_step": шаг + 0.5})
        try:
            готов_после = "восток" in get("/api/days")[0]["ready"]
        finally:
            post("/api/settings", {"buffer_step": шаг})
        if готов_до and not готов_после:
            print("  ✓ /api/days: день готов только при тех настройках, "
                  "при которых посчитан")
        else:
            print(f"  ✗ /api/days: готов до правки {готов_до}, после правки "
                  f"настроек {готов_после} — ожидалось да и нет")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ /api/days и настройки — {type(exc).__name__}: {exc}")
        failed += 1

    # Контракт проверяется тем же валидатором, что и фикстуры.
    import tempfile
    from .validate_fixtures import check as check_contract

    def контракт(формы: dict) -> list:
        with tempfile.TemporaryDirectory() as tmp:
            for name, payload in формы.items():
                if name in ("plan", "explain", "simulation", "shifts"):
                    (Path(tmp) / f"{name}.json").write_text(
                        json.dumps(payload, ensure_ascii=False))
            return check_contract(Path(tmp))

    # Синтетический день на заводских настройках — как было.
    problems = контракт(get("/api/day?day=1")[0])

    # И зона с неединичным множителем длительности. Прежде валидатор
    # гонялся только по первому случаю, а там норматив и занятое время
    # совпадают по определению — то есть целый класс расхождений между
    # «сколько работы по справочнику» и «сколько её стоит в плане»
    # проверкой не задевался вовсе.
    с_множителем, _ = post("/api/runs", {
        "day": "югоцентр", "note": "контракт при множителе 2,0",
        "params": {"duration_factor": 2.0}})
    problems += [f"множитель 2,0: {p}"
                 for p in контракт(get(f"/api/runs/{с_множителем['id']}")[0])]

    if problems:
        print(f"  ✗ контракт нарушен ({len(problems)}): {problems[:2]}")
        failed += 1
    else:
        print("  ✓ то, что отдаёт сервер, проходит проверку контракта "
              "(синтетика и зона с множителем 2,0)")

    # Пересчёт и журнал — от открытого расчёта. Прежде они всегда шли от
    # плана компании: у расчёта с множителем длительности 2,0 «Воздействия»,
    # статусы и «сохранить» работали с другим планом, чем был на экране.
    # Основа — расчёт югоцентра при множителе 2,0 из проверки контракта.
    try:
        основа_id = с_множителем["id"]
        с_основой, _ = get(f"/api/replan?day=югоцентр&at=820&urgent=2&base={основа_id}")
        без_основы, _ = get("/api/replan?day=югоцентр&at=820&urgent=2")
        м_о, м_б = с_основой["meta"]["replan"], без_основы["meta"]["replan"]
        if (м_о.get("base") == основа_id
                and м_о["assigned_as_is"] != м_б["assigned_as_is"]):
            print(f"  ✓ {'пересчёт от открытого расчёта':<38}как ехали "
                  f"{м_о['assigned_as_is']}, у компании {м_б['assigned_as_is']}")
            runs_ok += 1
        else:
            print(f"  ✗ пересчёт от открытого расчёта: base {м_о.get('base')!r}, "
                  f"как ехали {м_о['assigned_as_is']} и у компании {м_б['assigned_as_is']}")
            failed += 1

        # Журнал у расчёта свой: заведён от его плана, события — в нём.
        post("/api/journal/reset", {"day": "югоцентр", "base": основа_id})
        post("/api/journal/reset", {"day": "югоцентр"})
        план_о = get(f"/api/runs/{основа_id}")[0]["plan"]
        первая = план_о["routes"][0]["stops"][0]["order_id"]
        post("/api/event", {"day": "югоцентр", "base": основа_id,
                            "kind": "dispatched", "order": первая, "at": 480})
        ж_о, _ = get(f"/api/journal?day=югоцентр&base={основа_id}")
        ж_к, _ = get("/api/journal?day=югоцентр")
        по_плану = {r["engineer_id"]: [x["order_id"] for x in r["stops"]]
                    for r in план_о["routes"] if r["stops"]}
        if (len(ж_о["events"]) == 1 and not ж_к["events"]
                and {e: ids for e, ids in ж_о["assignment"].items() if ids} == по_плану):
            print(f"  ✓ {'журнал расчёта свой':<38}от его плана, событие в нём")
            runs_ok += 1
        else:
            print(f"  ✗ журнал расчёта: событий у расчёта {len(ж_о['events'])}, "
                  f"у компании {len(ж_к['events'])}, заведён от его плана "
                  f"{ {e: ids for e, ids in ж_о['assignment'].items() if ids} == по_плану}")
            failed += 1
        post("/api/journal/reset", {"day": "югоцентр", "base": основа_id})

        # Сохранённый пересчёт помнит расчёт и его переменные.
        сохр_о, _ = post("/api/runs", {
            "source": "sim", "note": "от расчёта",
            "replan": {"day": "югоцентр", "at": 820, "urgent": 2, "base": основа_id}})
        if (сохр_о.get("replan", {}).get("base") == основа_id
                and сохр_о["params"]["duration_factor"] == 2.0):
            print(f"  ✓ {'сохранённый пересчёт помнит расчёт':<38}и его множитель 2,0")
            runs_ok += 1
        else:
            print(f"  ✗ сохранённый пересчёт от расчёта: base "
                  f"{сохр_о.get('replan', {}).get('base')!r}, множитель "
                  f"{сохр_о['params']['duration_factor']}")
            failed += 1

        # Чужая основа — отказ словами, а не молча план компании.
        коды_о = [get_any(f"/api/replan?day=восток&at=820&urgent=2&base={основа_id}")[1],
                  get_any("/api/replan?day=югоцентр&at=820&urgent=2&base=run-нет")[1],
                  get_any(f"/api/replan?day=югоцентр&at=820&urgent=2&base={сохр_о['id']}")[1]]
        if коды_о == [400, 404, 400]:
            print(f"  ✓ {'чужая основа — отказ':<38}чужой день, нет такого, пересчёт")
            runs_ok += 1
        else:
            print(f"  ✗ чужая основа: коды {коды_о}, ожидалось [400, 404, 400]")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ от открытого расчёта — {type(exc).__name__}: {exc}")
        failed += 1

    # «auto» при пересчёте от журнала — по журналу. Прежде «самый занятой
    # сейчас» и «самая дорогая отмена» выбирались по своей симуляции:
    # выбывшим называли того, у кого по журналу всё уже сделано. Случай
    # строится так, чтобы журнал и симуляция разошлись: у самого занятого
    # по симуляции (так выбирал прежний код) все его заявки в журнале
    # выполнены, и самая дорогая по симуляции заявка — тоже.
    try:
        import random as _random_a
        from .replan import simulate_until as _до_момента_а
        T_а = 720
        день_а, план_а = STAND.day_and_plan("восток")
        сим_а = _до_момента_а(день_а, план_а, T_а, _random_a.Random(seed_of("восток")))
        по_сим_а = {e: len(ids) for e, ids in сим_а.pending.items() if ids}
        занятой_сим = max(sorted(по_сим_а), key=lambda e: по_сим_а[e])
        впереди_сим = {o for ids in сим_а.pending.values() for o in ids}
        дорогая_сим = max(sorted((o for o in день_а.orders if o.id in впереди_сим),
                                 key=lambda o: o.id), key=lambda o: o.est_minutes).id

        post("/api/journal/reset", {"day": "восток"})
        было_а = get(f"/api/state?day=восток&at={T_а}")[0]["pending"]
        сделать = set(было_а.get(занятой_сим, []))
        if any(дорогая_сим in ids for ids in было_а.values()):
            сделать.add(дорогая_сим)
        for oid in sorted(сделать):
            post("/api/event", {"day": "восток", "kind": "done", "order": oid,
                                "at": T_а - 1})
        стало_а = get(f"/api/state?day=восток&at={T_а}")[0]["pending"]
        занятой_жур = max(sorted(e for e, ids in стало_а.items() if ids),
                          key=lambda e: len(стало_а[e]))
        впереди_жур = {o for ids in стало_а.values() for o in ids}

        выбыл, _ = get(f"/api/replan?day=восток&at={T_а}&urgent=0&source=journal"
                       f"&disabled=auto")
        кто_а = выбыл["meta"]["replan"]["incident"]["engineer_id"]
        if кто_а == занятой_жур != занятой_сим:
            print(f"  ✓ {'самый занятой — по журналу':<38}{кто_а}, "
                  f"а по симуляции {занятой_сим}")
            runs_ok += 1
        else:
            print(f"  ✗ самый занятой от журнала: выбран {кто_а}, по журналу "
                  f"{занятой_жур}, по симуляции {занятой_сим}")
            failed += 1

        отмена_а, код_а = get_any(f"/api/replan?day=восток&at={T_а}&urgent=0"
                                  f"&source=journal&cancelled=auto")
        что_а = (отмена_а.get("meta", {}).get("replan", {}).get("incident") or {}
                 ).get("order_ids", [None])[0] if код_а == 200 else None
        if код_а == 200 and что_а in впереди_жур and что_а != дорогая_сим:
            print(f"  ✓ {'самая дорогая отмена — по журналу':<38}{что_а}, "
                  f"а по симуляции {дорогая_сим} (выполнена)")
            runs_ok += 1
        else:
            print(f"  ✗ отмена auto от журнала: код {код_а}, выбрана {что_а}, "
                  f"по симуляции {дорогая_сим}")
            failed += 1

        # Заявку, заведённую в журнале по ходу дня, можно и отменить.
        новая_а = post("/api/event", {"day": "восток", "kind": "order_new",
                                      "at": T_а - 5, "lat": день_а.orders[0].lat,
                                      "lon": день_а.orders[0].lon})[0]["recorded"]
        номер_а = новая_а.get("order") or новая_а.get("id")
        отм_н, код_н = get_any(f"/api/replan?day=восток&at={T_а}&urgent=0"
                               f"&source=journal&cancelled={номер_а}")
        if код_н == 200 and (отм_н["meta"]["replan"]["incident"] or {}).get(
                "order_ids") == [номер_а]:
            print(f"  ✓ {'отмена заявки из журнала':<38}{номер_а}")
            runs_ok += 1
        else:
            print(f"  ✗ отмена заявки из журнала {номер_а}: код {код_н}")
            failed += 1
        post("/api/journal/reset", {"day": "восток"})
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ auto от журнала — {type(exc).__name__}: {exc}")
        failed += 1

    # «Не тот транспорт» — своим вердиктом. Прежде инженер с навыком, но без
    # машины для заявки, где она нужна, числился «маршрут занят», и сводка
    # говорила «все подходящие заняты» про заявку без подходящих вовсе.
    try:
        пл_т, _ = get("/api/plan?day=восток")
        об_т, _ = get("/api/explain?day=восток")
        люди_т = {e["id"]: e for e in пл_т["engineers"]}
        нужно_т = верно_т = 0
        for o in пл_т["orders"]:
            if not o.get("requires_transport"):
                continue
            for c in об_т["orders"][o["id"]]["candidates"]:
                e = люди_т[c["engineer_id"]]
                if o["skill"] in e["skills"] and e["transport"] != o["requires_transport"]:
                    нужно_т += 1
                    верно_т += c["verdict"] == "no_vehicle"
        if нужно_т and верно_т == нужно_т:
            print(f"  ✓ {'не тот транспорт — своим вердиктом':<38}{нужно_т} кандидатов")
            runs_ok += 1
        else:
            print(f"  ✗ не тот транспорт: из {нужно_т} кандидатов no_vehicle у {верно_т}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ не тот транспорт — {type(exc).__name__}: {exc}")
        failed += 1

    # Адрес инженера в пересчёте — настоящий. У узлов сети участка нет
    # улицы и дома, и прежде в карточке стояло «None, None».
    try:
        рп_а, _ = get("/api/replan?day=восток&at=820&urgent=2")
        плохие_а = [e["id"] for e in рп_а["engineers"]
                    if not e.get("home_address") or "None" in e["home_address"]]
        if not плохие_а:
            print(f"  ✓ {'адрес инженера в пересчёте':<38}"
                  f"у всех {len(рп_а['engineers'])} настоящий")
            runs_ok += 1
        else:
            print(f"  ✗ адрес инженера в пересчёте пуст или «None» у {плохие_а}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ адрес инженера в пересчёте — {type(exc).__name__}: {exc}")
        failed += 1

    # Сохранённый пересчёт — ровно показанный, и после перезапуска тоже.
    # Прежде карточка при каждом открытии считалась заново (1,5 с по
    # бюджету) и после перезапуска открывалась другим планом, а «Сохранить»
    # без показанного в кэше молча считало заново.
    вызовы_с: list = []
    прежний_с = fast.solve
    try:
        показ_с, _ = get("/api/replan?day=восток&at=780&urgent=2")
        сохр_с, _ = post("/api/runs", {
            "source": "sim", "note": "перезапуск",
            "replan": {"day": "восток", "at": 780, "urgent": 2}})
        with STAND._lock:
            STAND._replans.clear()               # как после перезапуска
        fast.solve = lambda *a, **k: (вызовы_с.append(1), прежний_с(*a, **k))[1]
        откр_с, _ = get(f"/api/runs/{сохр_с['id']}")
        fast.solve = прежний_с
        те_же_с = (json.dumps(откр_с["plan"]["routes"], sort_keys=True)
                   == json.dumps(показ_с["routes"], sort_keys=True))
        if not вызовы_с and те_же_с:
            print(f"  ✓ {'сохранённый пересчёт: перезапуск':<38}"
                  f"тот же, без счёта")
            runs_ok += 1
        else:
            print(f"  ✗ сохранённый пересчёт после перезапуска: солвер звали "
                  f"{len(вызовы_с)} раз, маршруты те же {те_же_с}")
            failed += 1
        try:
            post("/api/runs", {"source": "sim", "note": "непоказанный",
                               "replan": {"day": "восток", "at": 780, "urgent": 2}})
            код_с = 200
        except urllib.error.HTTPError as exc:
            код_с = exc.code
        if код_с == 409:
            print(f"  ✓ {'сохранить непоказанный пересчёт — 409':<38}")
            runs_ok += 1
        else:
            print(f"  ✗ сохранить непоказанный пересчёт: код {код_с}, ожидалось 409")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ сохранённый пересчёт — {type(exc).__name__}: {exc}")
        failed += 1
    finally:
        fast.solve = прежний_с

    # План дня переживает перезапуск: второй стенд берёт его с диска, а не
    # решает заново. Прежде решал — восемь секунд по бюджету, и маршруты
    # могли выйти другими: экран показывал формы с диска, а пересчёт и
    # журнал вели от нового плана. Совпадение маршрутов ничего не доказывает
    # — бюджетный солвер может и повториться, — поэтому считаем его вызовы.
    import shutil
    вызовы: list = []
    прежний_solve = fast.solve

    def _считающий(*a, **k):
        вызовы.append(1)
        return прежний_solve(*a, **k)

    свой_кэш, свои_готовые = CACHE_DIR, READY_DIR
    fast.solve = _считающий
    try:
        _, план_1 = STAND.day_and_plan("восток")
        STAND.staffing("восток")
        вызовы.clear()
        второй = Stand()
        _, план_2 = второй.day_and_plan("восток")
        второй.forms("восток")

        def _маршруты(п):
            return {e: [v.order.id for v in r.visits] for e, r in п.routes.items()}

        if not вызовы and _маршруты(план_2) == _маршруты(план_1):
            print(f"  ✓ {'план дня переживает перезапуск':<38}солвер не звали")
            runs_ok += 1
        else:
            print(f"  ✗ план дня после перезапуска: солвер звали {len(вызовы)} раз, "
                  f"маршруты те же {_маршруты(план_2) == _маршруты(план_1)}")
            failed += 1

        # Готовые планы: свой кэш пуст, в готовых — тройка файлов востока.
        # Так приходит проверяющий: репозиторий есть, `.vrptw-cache` нет.
        ключ = ключ_кэша(STAND.settings)
        CACHE_DIR = Path(tempfile.mkdtemp(prefix="vrptw-check-пустой-"))
        READY_DIR = Path(tempfile.mkdtemp(prefix="vrptw-check-готовые-"))
        for вид in ("plan", "day", "staffing"):
            имя = f"{вид}-{slug('восток')}-{ключ}.json"
            shutil.copy2(свой_кэш / имя, READY_DIR / имя)
        вызовы.clear()
        третий = Stand()
        формы_3 = третий.forms("восток")
        третий.staffing("восток")
        те_же = (json.dumps(формы_3, sort_keys=True, ensure_ascii=False)
                 == json.dumps(STAND.forms("восток"), sort_keys=True, ensure_ascii=False))
        if not вызовы and те_же:
            print(f"  ✓ {'готовые планы: считать не пришлось':<38}"
                  f"формы те же")
            runs_ok += 1
        else:
            print(f"  ✗ готовые планы: солвер звали {len(вызовы)} раз, "
                  f"формы те же {те_же}")
            failed += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  ✗ план с диска и готовые — {type(exc).__name__}: {exc}")
        failed += 1
    finally:
        fast.solve = прежний_solve
        CACHE_DIR, READY_DIR = свой_кэш, свои_готовые

    ok_в, bad_в = _проверка_выгрузок(base)
    runs_ok += ok_в
    failed += bad_в

    server.shutdown()
    print()
    if failed:
        print(f"✗ Проблем: {failed}")
        return 1
    print("✓ Сервер отвечает как обещано в CONTRACT.md.")
    return 0


def _проверка_выгрузок(base: str) -> tuple[int, int]:
    """Выгрузка дня, принесённая кнопкой (`uploads.py`). Семь отметок.

    Отдельной функцией, а не внутри `check`: каждую отметку надо увидеть
    красной (правило 8), и гонять ради этого весь `check` по полторы
    минуты незачем — её можно позвать на одном свежем сервере.
    Работает без сети (`VRPTW_OFFLINE`): у проверяющего её может не быть,
    и путь «всё уже есть» обязан проходить без единого запроса наружу.
    """
    import base64
    import os
    import urllib.error
    import urllib.parse
    import urllib.request

    import numpy as np

    ok = bad = 0

    def отметка(да: bool, что: str, подробно: str) -> None:
        nonlocal ok, bad
        if да:
            print(f"  ✓ {что:<38}{подробно}")
            ok += 1
        else:
            print(f"  ✗ {что}: {подробно}")
            bad += 1

    def запрос(метод: str, path: str, тело: dict | None = None):
        path = urllib.parse.quote(path, safe="/?=&")
        data = json.dumps(тело).encode("utf-8") if тело is not None else None
        req = urllib.request.Request(base + path, data=data, method=метод,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.load(resp), resp.status
        except urllib.error.HTTPError as exc:
            return json.loads(exc.read().decode("utf-8")), exc.code

    def принять(имя: str, сырой: bytes, инженеров: int = 14):
        return запрос("POST", "/api/uploads", {
            "name": имя, "data": base64.b64encode(сырой).decode("ascii"),
            "engineers": инженеров})

    def дождаться(ident: str, секунд: int = 300) -> dict:
        запрос("POST", f"/api/uploads/{ident}/prepare", {})
        конец = time.time() + секунд
        while time.time() < конец:
            з, _ = запрос("GET", f"/api/uploads/{ident}")
            if з.get("status") in ("готова", "ошибка"):
                return з
            time.sleep(0.5)
        return {"status": "не дождались"}

    def суть(day) -> tuple:
        return ([(o.id, o.work_type, o.lat, o.lon, o.node, o.window_start,
                  o.window_end, o.priority, o.est_minutes, o.requires_transport,
                  sorted((o.equipment or {}).items())) for o in day.orders],
                [(e.id, e.name, sorted(e.skills), e.transport, e.shift_start,
                  e.shift_end, e.home_node) for e in day.engineers],
                day.date, day.hard_end)

    сырой = Path(REGIONS["восток"]).read_bytes()
    текст = сырой.decode("cp1251")
    строки = текст.split("\r\n")
    шапка, заявки = строки[0], [с for с in строки[1:] if с and not с.startswith(";")]
    хвост = [с for с in строки if с.startswith(";") or с.lower().startswith("адрес оф")]
    зона = load_day("восток", quiet=True)
    было_без_сети = os.environ.get("VRPTW_OFFLINE")
    os.environ["VRPTW_OFFLINE"] = "1"
    try:
        # 1. Два пути к одним данным — один день. Иначе выгрузка зоны,
        # принесённая кнопкой, считалась бы не тем, что замерено.
        з, код = принять("восток.csv", сырой)
        день_в = uploads.день(з["day"]) if код == 200 else None
        отметка(код == 200 and з["orders"] == 66 and з["date"] == "2026-08-17"
                and з["addresses"]["to_search"] == 0 and з["network"] == "готова"
                and день_в is not None and суть(день_в) == суть(зона)
                and np.array_equal(день_в.network.road_km, зона.network.road_km),
                "выгрузка восток.csv = зона «восток»",
                f"66 заявок, {len(зона.engineers)} инженеров, та же сеть"
                if код == 200 else f"{код}: {з}")

        # 2. Пересохранённая в редакторе — UTF-8, с BOM и без, — та же
        # выгрузка.
        з8, код8 = принять("восток-utf8.csv", b"\xef\xbb\xbf" + текст.encode("utf-8"))
        з9, код9 = принять("восток-utf8-без-bom.csv", текст.encode("utf-8"))
        дни_8 = [uploads.день(з["day"]) for з, к in ((з8, код8), (з9, код9)) if к == 200]
        отметка(код8 == код9 == 200 and з8["encoding"] == з9["encoding"] == "UTF-8"
                and len(дни_8) == 2 and all(суть(д) == суть(зона) for д in дни_8),
                "UTF-8 и cp1251 — один разбор",
                "с BOM и без: заявки, бригада и дата те же" if код8 == код9 == 200
                else f"с BOM {код8}, без {код9}: {з9 if код9 != 200 else з8}")

        # 3. Непригодный файл — отказ словами: что не так и что сделать.
        xlsx, к1 = принять("день.xlsx", b"PK\x03\x04" + b"\0" * 64)
        без_офиса, к2 = принять("без офиса.csv",
                                "\r\n".join([шапка] + заявки[:3]).encode("cp1251"))
        мусор, к3 = запрос("POST", "/api/uploads", {"name": "x.csv", "data": "@@@"})
        отметка(к1 == 400 and "Excel" in xlsx["error"]
                and к2 == 400 and "Адрес офиса" in без_офиса["error"]
                and к3 == 400 and "base64" in мусор["error"],
                "непригодный файл — отказ словами",
                "Excel, нет офиса, не base64" if к1 == к2 == к3 == 400
                else f"{к1} {к2} {к3}")

        # 4. Строка, которую нельзя спланировать, названа с номером и
        # причиной, а остальные считаются.
        поля = заявки[0].split(";")
        без_адреса = ";".join(поля[:6] + [""] + поля[7:])
        кривое_время = ";".join(поля[:3] + ["17.08 10:00"] + поля[4:])
        файл = [шапка, без_адреса, кривое_время] + заявки[1:6] + хвост
        зо, ко = принять("с кривыми строками.csv", "\r\n".join(файл).encode("cp1251"))
        отложены = [(s["line"], s["reason"].split(":")[0]) for s in зо.get("skipped", [])]
        отметка(ко == 200 and зо["orders"] == 5
                and отложены == [(2, "нет адреса"), (3, "время не разобрано")],
                "кривые строки отложены с причиной",
                f"отложено {отложены}, к расчёту {зо.get('orders')}")

        # 5. Без сети: все точки выгрузки есть в готовой сети зоны —
        # подсеть вырезается из неё, и выгрузка считается до расчёта.
        часть, кч = принять("восток, 20 заявок.csv",
                            "\r\n".join([шапка] + заявки[:20] + хвост).encode("cp1251"))
        сеть_до = часть.get("network")
        готова = дождаться(часть["day"]) if кч == 200 else {}
        расчёт, кр = (запрос("POST", "/api/runs", {"day": часть["day"]})
                      if готова.get("status") == "готова" else ({}, 0))
        дни, _ = запрос("GET", "/api/days")
        в_днях = any(в["day"] == часть.get("day") and в["status"] == "готова"
                     for в in дни.get("uploads", []))
        отметка(кч == 200 and сеть_до == "готова" and готова.get("status") == "готова"
                and кр == 200 and расчёт.get("day") == часть["day"] and в_днях,
                "без сети: подсеть из готовой, расчёт",
                f"{часть.get('orders')} заявок, расчёт {расчёт.get('code')}"
                if кр == 200 else f"сеть {сеть_до}, {готова.get('status')}: "
                                  f"{готова.get('error')}")

        # 6. Новый адрес, а сеть молчит: предпросмотр честно просит поиск,
        # подготовка отказывает словами, а в кэш адрес «ненайденным» не
        # ложится — иначе заявка так и осталась бы без координаты, когда
        # сеть появится. Молчание сети — подменой запросов к геокодерам, а
        # не флагом `VRPTW_OFFLINE`: флаг обрывает поиск раньше, чем дело
        # доходит до места, где «не ответил» отличают от «не нашёл».
        from .core import geocode as _геокодер
        выдумка = "Город Москва, ул.Проверочная, д. 1"
        с_новым = ";".join(поля[:6] + [выдумка] + поля[7:])
        зн, кн = принять("с новым адресом.csv",
                         "\r\n".join([шапка, с_новым] + заявки[1:5] + хвост).encode("cp1251"))

        def молчит(*_a, **_k):
            raise _геокодер.ОтказСервиса("проверка: сеть молчит")

        подмена = {имя: getattr(_геокодер, имя) for имя in ("_search_uporno", "_search_photon")}
        for имя in подмена:
            setattr(_геокодер, имя, молчит)
        os.environ.pop("VRPTW_OFFLINE", None)
        try:
            исход = дождаться(зн["day"]) if кн == 200 else {}
        finally:
            for имя, прежняя in подмена.items():
                setattr(_геокодер, имя, прежняя)
            os.environ["VRPTW_OFFLINE"] = "1"
        свой = uploads.кэш_адресов()
        в_кэше = свой.exists() and выдумка in свой.read_text(encoding="utf-8")
        отметка(кн == 200 and зн["addresses"]["to_search"] == 1
                and исход.get("status") == "ошибка" and "нет связи" in (исход.get("error") or "")
                and not в_кэше,
                "новый адрес без сети — не «не найден»",
                "отказ словами, кэш чист" if not в_кэше
                else "адрес лёг в кэш ненайденным")

        # 7. Выгрузку с расчётом не удалить — без неё он не откроется; без
        # расчётов — удаляется, и день больше не опознаётся.
        _, кд1 = запрос("DELETE", f"/api/uploads/{часть.get('day')}")
        _, кд2 = запрос("DELETE", f"/api/uploads/{зн.get('day')}")
        _, кд3 = запрос("GET", f"/api/plan?day={зн.get('day')}")
        отметка(кд1 == 409 and кд2 == 200 and кд3 == 400,
                "удаление выгрузки",
                "с расчётом — 409, без — убрана" if кд1 == 409
                else f"с расчётом {кд1}, без {кд2}, после {кд3}")
    except Exception as exc:  # noqa: BLE001
        traceback.print_exc()
        отметка(False, "выгрузки", f"{type(exc).__name__}: {exc}")
    finally:
        if было_без_сети is None:
            os.environ.pop("VRPTW_OFFLINE", None)
        else:
            os.environ["VRPTW_OFFLINE"] = было_без_сети
    return ok, bad


def готовые() -> int:
    """Положить в `vrptw/data/готовые/` всё, что прогрев считает по трём
    зонам, — на нынешнем коде и заводских настройках.

    Последний шаг перед отправкой: с готовыми планами первый запуск у
    проверяющего — секунды, без них — три с лишним минуты. Считается с
    нуля во временном кэше: ни свой `.vrptw-cache`, ни прежние готовые не
    подмешиваются — иначе в репозиторий уехал бы план, посчитанный
    неизвестно чем. Боевые настройки тоже не берутся: у проверяющего их
    нет, у него заводские.
    """
    global CACHE_DIR, READY_DIR
    import shutil
    import tempfile
    use_state_dir(tempfile.mkdtemp(prefix="vrptw-готовые-"))
    итог = READY_DIR
    CACHE_DIR = Path(tempfile.mkdtemp(prefix="vrptw-готовые-кэш-"))
    READY_DIR = CACHE_DIR / "прежних-не-читать"
    stand = Stand()
    ключ = ключ_кэша(stand.settings)
    print(f"Готовые планы: код {отпечаток_кода()}, заводские настройки\n")
    warm(stand, [parse_day(з) for з in REGIONS])
    файлы = sorted(p for p in CACHE_DIR.glob(f"*-{ключ}.json")
                   if p.name.split("-", 1)[0] in ("plan", "day", "staffing"))
    if len(файлы) != 3 * len(REGIONS):
        print(f"  ✗ ждали {3 * len(REGIONS)} файлов, вышло {len(файлы)} — не кладу")
        return 1
    итог.mkdir(parents=True, exist_ok=True)
    for старый in итог.glob("*.json"):
        старый.unlink()
    for p in файлы:
        shutil.copy2(p, итог / p.name)
    вес = sum(p.stat().st_size for p in итог.glob("*.json")) / 1e6
    print(f"\n  ✓ {len(файлы)} файлов, {вес:.1f} МБ → {итог}")
    return 0


def main():
    global STAND
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    # Прогревать можно и зоны заказчика, и синтетические дни: с 15
    # сентября идентификатор дня это строка, а не число.
    try:
        seeds = ([parse_day(x) for x in sys.argv[2].split(",")]
                 if len(sys.argv) > 2 else ["1"])
    except ValueError as exc:
        print(f"  ✗ {exc}")
        raise SystemExit(2)

    print("Стенд планировщика выездов — HTTP-сервер\n")
    print("  строю дорожную сеть…")
    t0 = time.time()
    STAND = Stand()
    print(f"  сеть готова за {time.time() - t0:.1f} с")

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    готовых = len(list(READY_DIR.glob(f"*-{ключ_кэша(STAND.settings)}.json")))
    print(f"\n  слушаю http://localhost:{port} — страница открывается сразу")
    print(f"  дни считаются в фоне; готовых планов на этом коде: {готовых} "
          f"({'секунды' if готовых else 'на чистой машине около трёх минут'})")
    threading.Thread(target=warm, args=(STAND, seeds), daemon=True).start()
    print(f"  описание api: http://localhost:{port}/api")
    print(f"  проверить:    curl 'http://localhost:{port}/api/plan?day=1'")
    print(f"  на данных заказчика: curl "
          f"'http://localhost:{port}/api/plan?day=восток'\n")
    print("  Ctrl+C чтобы остановить\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  остановлен")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        sys.exit(check())
    if len(sys.argv) > 1 and sys.argv[1] == "готовые":
        sys.exit(готовые())
    main()
