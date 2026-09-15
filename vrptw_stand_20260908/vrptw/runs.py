"""
Расчёты: то, что диспетчер завёл кнопкой и к чему потом возвращается.

У стенда до сих пор не было понятия «расчёт». `.vrptw-cache/` — это кэш
по номеру дня: он отвечает на вопрос «как выглядит день 7», но не на
вопрос «что получилось, когда я в 6:12 попросил посчитать день 7 с
запасом побольше». Второй вопрос и есть работа диспетчера, поэтому
запись о расчёте живёт отдельно от кэша и переживает перезапуск сервера.

Расчёт — это день плюс переменные движка плюс момент, когда его завели.
Из этих трёх вещей результат воспроизводится точно: солвер
детерминирован по паре «зерно + параметры». Тем не менее формы кладутся
на диск целиком, а не пересчитываются при открытии: расчёт открывают
чаще, чем заводят, и восемь секунд ожидания на каждое открытие архива
никому не нужны.

Что здесь намеренно НЕ делается:

- не трогается кэш дней. План с чужими параметрами не имеет права
  попасть туда, где лежит план с заводскими: это ровно та ошибка,
  из-за которой сервер молча отдавал бы старые числа;
- не пересчитывается график смен. Подбор смен — про расписание, а не
  про то, как солвер взвешивает варианты, и занимает около минуты
  против восьми секунд на план. Форма `shifts` берётся у дня целиком,
  и это написано в ответе полем `shifts_from_day`, чтобы никто не
  решил, будто её подобрали под эти переменные.

Раскладка на диске:

    .vrptw-runs/
    ├── index.json                  список расчётов, новые в конце
    └── <id>/
        ├── plan.json
        ├── explain.json
        ├── simulation.json
        └── shifts.json

Формы лежат по отдельности, а не одним файлом: интерфейсу для карты
нужен только план, и тянуть ради него объяснение на сто пятьдесят
килобайт незачем.
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path

from .export import (RISK_HIGH, RISK_MEDIUM, build_explain, build_plan,
                     build_simulation)
from .solvers import fast, improved

RUNS_DIR = Path(".vrptw-runs")
INDEX = RUNS_DIR / "index.json"
FORMS = ("plan", "explain", "simulation", "shifts")

# Сколько думает солвер над расчётом. Наружу не выставляется: это
# не решение диспетчера, а обещание интерфейсу про задержку ответа.
SOLVE_SECONDS = 8.0
MC_RUNS = 300


# ─── переменные движка ────────────────────────────────────────────────
#
# Наружу открыты ровно семь — те, что согласованы с интерфейсом. Пять
# читает солвер, две решают, при каком запасе визит подсвечивается на
# экране. Больше не открывается ничего, и это граница, а не забывчивость:
# у этих семи есть смысл на языке диспетчера, у остальных — нет.
#
# Бюджет поиска, размах выбивания, шум, веса простоя и риска остаются
# внутренними. Дотянуть их до сети дёшево — они уже лежат в `Params`, — но
# цена не в коде, а в том, что окажется перед диспетчером. Неудачное
# значение любой из них тихо ухудшает план, и обратной связи об этом нет
# ниоткуда. Если их нужно крутить без пересборки, место им в конфиге рядом
# с этим файлом, а не на экране.
#
# Границы не косметические. Солвер примет любое число, но
# `duration_factor = 50` даст день, в который не влезает ни одна заявка,
# и пустой план вместо внятной ошибки. Лучше сказать, что попросили
# лишнего.

LIMITS = {
    "churn_penalty": (0.0, 1000.0, 0.0),
    "duration_factor": (0.5, 3.0, 1.0),
    "buffer_step": (0.0, 120.0, improved.BUFFER_STEP),
    "buffer_base": (0.0, 120.0, 0.0),
    "balance_weight": (0.0, 100.0, improved.BALANCE_WEIGHT),
    # Пороги подсветки риска. В солвер они не идут — план от них не
    # меняется, — но в экспорт идут: это то, при каком запасе диспетчер
    # увидит предупреждение, и зависит оно от сроков в договоре компании.
    "risk_high": (0.0, 240.0, RISK_HIGH),
    "risk_medium": (0.0, 240.0, RISK_MEDIUM),
}

# Какие из них читает солвер. Остальные два — оформление ответа, и
# подсовывать их в Params нельзя: он их не знает.
SOLVER_KEYS = ("churn_penalty", "duration_factor", "buffer_step",
               "buffer_base", "balance_weight")


class BadParams(ValueError):
    """Переменные не прошли проверку — отвечаем 400, а не 500."""


def normalize(raw: dict | None) -> dict:
    """Приводит присланные переменные к тем семи, что мы обещали.

    Чужие ключи молча выбрасываются: интерфейс не должен иметь
    возможности дотянуться до внутренностей солвера, даже случайно.
    А вот число вне границ — это не «поправим потихоньку», это ошибка
    в том, кто его прислал, и о ней надо сказать.
    """
    raw = raw or {}
    out: dict = {}
    for name, (low, high, default) in LIMITS.items():
        if name not in raw or raw[name] is None:
            out[name] = float(default)
            continue
        try:
            value = float(raw[name])
        except (TypeError, ValueError):
            raise BadParams(f"{name}: ожидалось число, пришло {raw[name]!r}")
        if value != value or value in (float("inf"), float("-inf")):
            raise BadParams(f"{name}: не число")
        if not low <= value <= high:
            raise BadParams(f"{name}: {value:g} вне границ {low:g}…{high:g}")
        out[name] = value
    return out


def _solver_params(params: dict) -> improved.Params:
    """Только то, что читает солвер.

    Пороги подсветки сюда не идут: `Params` их не знает, и план от них не
    зависит вовсе — они решают, каким цветом визит покажут на экране.
    """
    return improved.Params(
        lns_seconds=SOLVE_SECONDS,
        churn_penalty=params["churn_penalty"],
        duration_factor=params["duration_factor"],
        buffer_step=params["buffer_step"],
        buffer_base=int(params["buffer_base"]),
        balance_weight=params["balance_weight"],
    )


def is_factory(params: dict) -> bool:
    """Стоят ли заводские значения. Пригодится интерфейсу, чтобы не
    подписывать «переменные изменены» там, где их не меняли."""
    return all(abs(params[name] - float(default)) < 1e-9
               for name, (_, _, default) in LIMITS.items())


# ─── реестр ───────────────────────────────────────────────────────────


class Runs:
    """Список расчётов и их формы на диске.

    Нужен стенд: день строится его генератором на его же дорожной сети,
    и заводить вторую сеть ради расчётов нельзя — это несколько секунд
    и десятки мегабайт.
    """

    def __init__(self, stand):
        self.stand = stand
        self._lock = threading.Lock()
        RUNS_DIR.mkdir(exist_ok=True)

    # ---------- индекс ----------

    def _read_index(self) -> list[dict]:
        if not INDEX.exists():
            return []
        try:
            return json.loads(INDEX.read_text())
        except json.JSONDecodeError:
            # Индекс могли оборвать на записи. Терять из-за этого весь
            # архив нельзя: папки расчётов на месте, и список
            # восстанавливается по ним.
            return self._rebuild_index()

    def _rebuild_index(self) -> list[dict]:
        found = []
        for folder in sorted(RUNS_DIR.iterdir()):
            card = folder / "run.json"
            if folder.is_dir() and card.is_file():
                try:
                    found.append(json.loads(card.read_text()))
                except json.JSONDecodeError:
                    continue
        found.sort(key=lambda r: r.get("created", ""))
        INDEX.write_text(json.dumps(found, ensure_ascii=False, indent=1))
        return found

    def list(self) -> list[dict]:
        with self._lock:
            return self._read_index()

    def get(self, run_id: str) -> dict | None:
        for record in self.list():
            if record["id"] == run_id:
                return record
        return None

    def forms(self, run_id: str) -> dict | None:
        """Все четыре формы расчёта. `None` — такого расчёта нет."""
        folder = self._folder(run_id)
        if folder is None:
            return None
        return {name: json.loads((folder / f"{name}.json").read_text())
                for name in FORMS}

    def form(self, run_id: str, name: str) -> dict | None:
        folder = self._folder(run_id)
        if folder is None:
            return None
        path = folder / f"{name}.json"
        return json.loads(path.read_text()) if path.is_file() else None

    def _folder(self, run_id: str) -> Path | None:
        """Папка расчёта, если она наша и существует.

        `run_id` приходит из адреса, то есть от кого угодно, поэтому
        путь проверяется, а не склеивается: «..» в номере расчёта не
        должно выводить за пределы архива.
        """
        if not run_id or "/" in run_id or "\\" in run_id or run_id.startswith("."):
            return None
        folder = (RUNS_DIR / run_id).resolve()
        if RUNS_DIR.resolve() not in folder.parents:
            return None
        return folder if folder.is_dir() else None

    # ---------- завести расчёт ----------

    def create(self, day_seed: int, params: dict, note: str = "") -> dict:
        """Считает день с этими переменными и кладёт результат в архив.

        Возвращает карточку расчёта — без форм: интерфейсу после
        создания нужно сначала показать строку в истории, а формы он
        заберёт, когда откроет расчёт.
        """
        if not 1 <= day_seed <= 30:
            raise BadParams(f"day: ожидалось 1…30, пришло {day_seed}")

        started = time.monotonic()
        day = self.stand.day_for(day_seed)
        solver = _solver_params(params)
        plan = fast.solve(day, params=solver, seed=day_seed)

        # Правило стенда: инварианты проверяются у каждого плана, не
        # только у заводского. План, нарушающий границу дня или врущий
        # про время в пути, в архив не попадает — иначе завтра кто-то
        # будет объяснять на защите красивую, но невыполнимую картинку.
        problems = plan.check_invariants(day)
        if problems:
            raise RuntimeError(f"план невалиден: {problems[:2]}")

        solve_seconds = round(time.monotonic() - started, 2)

        forms = {
            "plan": build_plan(day, plan, self.stand.net,
                               risk_high=int(params["risk_high"]),
                               risk_medium=int(params["risk_medium"])),
            "explain": build_explain(day, plan, solver),
            "simulation": build_simulation(day, plan, runs=MC_RUNS,
                                           seed=day_seed),
            # График смен берётся у дня как есть: он про расписание, а
            # не про то, как солвер взвешивает варианты. Что это чужая
            # форма, сказано в карточке полем shifts_from_day.
            "shifts": self.stand.forms(day_seed)["shifts"],
        }

        now = datetime.now()
        with self._lock:
            index = self._read_index()
            number = len(index) + 1
            record = {
                "id": f"run-{now:%Y%m%d-%H%M%S}-{number:03d}",
                "code": f"M{number:03d}",
                "day": day_seed,
                "date": f"{now:%Y-%m-%d}",
                "created": f"{now:%Y-%m-%dT%H:%M}",
                "note": (note or "")[:200],
                "params": params,
                "factory": is_factory(params),
                "shifts_from_day": True,
                "summary": _summary(forms, solve_seconds),
            }

            folder = RUNS_DIR / record["id"]
            folder.mkdir(parents=True, exist_ok=True)
            for name in FORMS:
                (folder / f"{name}.json").write_text(
                    json.dumps(forms[name], ensure_ascii=False))
            (folder / "run.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=1))

            index.append(record)
            INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))

        return record

    # ---------- сохранить пересчёт ----------

    def save_replan(self, forms: dict, source: str | None, incident: dict,
                    note: str = "") -> dict:
        """Кладёт в архив результат пересчёта.

        Пересчёт — это не новый день, а тот же день от середины: движок
        переложил остаток после аварии или ЧП с инженером. В архиве он живёт
        такой же записью, как обычный расчёт, но помечен: `kind` —
        «incident», и рядом лежит, от какого расчёта он отпочковался и что
        именно случилось.

        Без пометки два расчёта с одинаковым днём и разными цифрами
        выглядели бы необъяснимо: один на весь день, другой на его остаток.
        """
        plan = forms["plan"]
        meta = plan["meta"]
        now = datetime.now()

        with self._lock:
            index = self._read_index()
            number = len(index) + 1
            record = {
                "id": f"run-{now:%Y%m%d-%H%M%S}-{number:03d}",
                "code": f"M{number:03d}",
                "day": incident.get("day"),
                "date": f"{now:%Y-%m-%d}",
                "created": f"{now:%Y-%m-%dT%H:%M}",
                "note": (note or "")[:200],
                "kind": "incident",
                "source_run": source,
                "incident": incident,
                "params": None,
                "factory": False,
                "shifts_from_day": True,
                "summary": _summary(forms, meta.get("replan", {}).get("solve_seconds", 0)),
            }

            folder = RUNS_DIR / record["id"]
            folder.mkdir(parents=True, exist_ok=True)
            for name in FORMS:
                (folder / f"{name}.json").write_text(
                    json.dumps(forms[name], ensure_ascii=False))
            (folder / "run.json").write_text(
                json.dumps(record, ensure_ascii=False, indent=1))

            index.append(record)
            INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))

        return record

    # ---------- заметка ----------

    def annotate(self, run_id: str, note: str) -> dict | None:
        """Заметка человека к расчёту. Движок её не заполняет и не читает."""
        with self._lock:
            index = self._read_index()
            for record in index:
                if record["id"] != run_id:
                    continue
                record["note"] = (note or "")[:200]
                folder = RUNS_DIR / run_id
                if folder.is_dir():
                    (folder / "run.json").write_text(
                        json.dumps(record, ensure_ascii=False, indent=1))
                INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))
                return record
        return None


def _summary(forms: dict, solve_seconds: float) -> dict:
    """Строка расчёта в истории: то, по чему его отличают, не открывая.

    Числа берутся из уже собранных форм, а не считаются заново, — иначе
    в списке и внутри расчёта однажды окажутся разные цифры под одним
    именем.
    """
    plan = forms["plan"]
    meta = plan["meta"]
    balance = meta["balance"]
    return {
        "orders_total": meta["orders_total"],
        "orders_assigned": meta["orders_assigned"],
        "unassigned": len(plan["unassigned"]),
        "engineers_total": meta["engineers_total"],
        "engineers_on_route": len({r["engineer_id"] for r in plan["routes"]}),
        "coverage": forms["simulation"]["coverage"],
        "gini": balance["gini"],
        "occupancy_min": balance["occupancy_min"],
        "occupancy_max": balance["occupancy_max"],
        "solve_seconds": solve_seconds,
    }
