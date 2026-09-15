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

Счёт дня занимает несколько секунд, поэтому готовые формы кладутся в
`.vrptw-cache/` рядом с рабочей папкой и переживают перезапуск сервера.
"""

from __future__ import annotations

import copy
import json
import random
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .export import (SCHEMA_VERSION, build_explain, build_plan, build_shifts,
                     build_simulation)
from .replan import (apply_dropout, carve_remainder, plan_as_is, simulate_until,
                     stability, urgent_orders)
from .compares import BadCompare, Compares
from .runs import BadParams, Runs, normalize
from .shiftopt import apply as apply_shifts
from .shiftopt import optimize, refine
from .solvers import fast, improved

CACHE_DIR = Path(".vrptw-cache")
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

# Штраф за смену исполнителя при пересчёте — то же значение, что в замере.
CHURN_PENALTY = 40.0


def _params(seconds: float = LNS_SECONDS, **extra) -> improved.Params:
    return improved.Params(lns_seconds=seconds,
                           balance_weight=improved.BALANCE_WEIGHT, **extra)


class Stand:
    """Стенд целиком: сеть, дни, планы, кэш форм.

    Дорожная сеть строится один раз — это несколько секунд и десятки
    мегабайт, держать её на запрос нельзя. Всё остальное считается
    лениво и запоминается.
    """

    def __init__(self):
        self.net = default_network()
        self._days: dict[int, tuple] = {}
        self._raw_days: dict[int, object] = {}
        self._forms: dict[int, dict] = {}
        self._tuned: dict[int, dict] = {}
        self._replans: dict[tuple, dict] = {}
        # Остаток дня и новый план того же пересчёта, объектами. Нужны,
        # когда пересчёт решают сохранить: по ним строятся объяснение и
        # симуляция, а пересчитывать всё заново ради этого незачем —
        # солвер уже отработал полторы секунды.
        self._replan_parts: dict[tuple, tuple] = {}
        self._lock = threading.Lock()
        CACHE_DIR.mkdir(exist_ok=True)

    # ---------- день и план ----------

    def day_for(self, seed: int):
        """Сам день без плана.

        Расчёту с чужими переменными нужен день, но не заводский план:
        он всё равно будет решать заново. Держать день отдельно дешевле,
        чем каждый раз собирать его генератором.
        """
        with self._lock:
            if seed in self._days:
                return self._days[seed][0]
            if seed in self._raw_days:
                return self._raw_days[seed]
        day = generate_day(seed=seed, network=self.net)
        with self._lock:
            self._raw_days[seed] = day
        return day

    def day_and_plan(self, seed: int):
        with self._lock:
            if seed in self._days:
                return self._days[seed]
        day = self.day_for(seed)
        plan = fast.solve(day, params=_params(), seed=seed)
        problems = plan.check_invariants(day)
        if problems:
            raise RuntimeError(f"план невалиден: {problems[:2]}")
        with self._lock:
            self._days[seed] = (day, plan)
        return day, plan

    # ---------- четыре формы ----------

    def forms(self, seed: int, fresh: bool = False) -> dict:
        with self._lock:
            if not fresh and seed in self._forms:
                return self._forms[seed]

        path = CACHE_DIR / f"day-{seed:02d}.json"
        if not fresh and path.exists():
            forms = json.loads(path.read_text())
            with self._lock:
                self._forms[seed] = forms
            return forms

        day, plan = self.day_and_plan(seed)
        params = _params()

        starts = optimize(day, restarts=12, seed=seed).starts
        starts, _ = refine(day, starts, solver_seed=seed,
                           sim_seed=seed + 7000, rounds=2)
        tuned = apply_shifts(day, starts)
        tuned_plan = fast.solve(tuned, params=params, seed=seed)

        coverage_now = monte_carlo(day, plan, runs=MC_RUNS, seed=seed).coverage * 100
        coverage_rec = monte_carlo(tuned, tuned_plan, runs=MC_RUNS,
                                   seed=seed).coverage * 100

        forms = {
            "plan": build_plan(day, plan, self.net),
            "explain": build_explain(day, plan, params),
            "simulation": build_simulation(day, plan, runs=MC_RUNS, seed=seed),
            "shifts": build_shifts(day, starts, coverage_now, coverage_rec),
        }
        path.write_text(json.dumps(forms, ensure_ascii=False))
        with self._lock:
            self._forms[seed] = forms
        return forms

    # ---------- пересчёт внутри дня ----------

    def replan(self, seed: int, at: int, urgent_count: int = 2,
               seconds: float = REPLAN_SECONDS, run: int = 0,
               disabled: str | None = None, delayed: str | None = None,
               urgent_near: str | None = None) -> dict:
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

        `urgent_near=E03` — авария случилась там, где сейчас работает E03,
        а не «где-то по городу». Это не третье ЧП, а адрес у первого:
        диспетчер знает участок, и без него пересчёт отвечал на вопрос про
        среднюю аварию в среднем районе. Самому E03 заявка при этом не
        назначается: она идёт в общий пул, и кто поедет — решает
        планировщик. Обычно ближайший, но это вывод, а не условие.

        Это два разных события, и путать их нельзя. Замер
        (`dropoutbench`) говорит: выбытие утром стоит дню 4,7 визита и
        пересчёт возвращает 3,9 из них — жать надо обязательно. А прокол
        стоит 0,4–0,7 визита, потому что буферы в маршруте его и так
        съедают, и пересчёт возвращает из них 0,1–0,5. Кнопка при этом
        покажет прирост побольше — но это обычная переоптимизация
        остатка, которая была бы полезна и без всякого ЧП. Поэтому в
        ответе разделено: `rescued` — визиты выбывшего, которые
        подхватили другие, `assigned_as_is` — сколько было бы без
        пересчёта.
        """
        incident = self._incident(seed, disabled, delayed)
        near_id = urgent_near if urgent_count else None
        key = (seed, at, urgent_count, round(seconds, 2), run,
               incident["engineer_id"] if incident else None,
               incident["minutes"] if incident else None, near_id)
        with self._lock:
            if key in self._replans:
                return self._replans[key]

        self._last_replan_key = key
        day, plan = self.day_and_plan(seed)

        if near_id:
            known = {e.id for e in day.engineers}
            if near_id not in known:
                raise ValueError(f"нет инженера {near_id}; есть {sorted(known)}")

        state = simulate_until(day, plan, at, random.Random(seed * 1000 + run))
        # Точка аварии — там, где названный инженер стоит в момент `at`:
        # его положение уже проиграно симуляцией, отдельно считать нечего.
        near = None
        if near_id:
            node = state.position[near_id][0]
            near = (day.network.nodes[node].lat, day.network.nodes[node].lon)
        urgent = (urgent_orders(day, at, urgent_count, seed, near=near)
                  if urgent_count else [])
        rest = carve_remainder(day, state, extra=urgent)

        gone = incident["engineer_id"] if incident else None
        his = set(state.pending.get(gone, [])) if gone else set()
        if incident:
            rest = apply_dropout(rest, gone, incident["minutes"])

        # Якорь: кому заявка была назначена до пересчёта. Заявки выбывшего
        # насовсем из якоря исключаются — держаться за исполнителя,
        # которого сегодня не будет, значит штрафовать любую попытку их
        # пристроить кому-то другому.
        anchor = {oid: eid for eid, ids in state.pending.items() for oid in ids}
        if incident and incident["kind"] == "disabled":
            anchor = {oid: eid for oid, eid in anchor.items() if eid != gone}

        t0 = time.time()
        new_plan = fast.solve(rest, params=_params(seconds, anchor=anchor,
                                                   churn_penalty=CHURN_PENALTY),
                              seed=seed)
        elapsed = time.time() - t0
        problems = new_plan.check_invariants(rest)
        if problems:
            raise RuntimeError(f"план пересчёта невалиден: {problems[:2]}")

        # «Как ехали» — для сравнения: столько было бы без пересчёта.
        # Считается по тому же остатку дня, то есть уже с учётом ЧП.
        as_is = plan_as_is(rest, state)

        out = build_plan(rest, new_plan, self.net)
        out["kind"] = "replan"
        out["meta"]["replan"] = {
            "at": at,
            "run": run,
            "solve_seconds": round(elapsed, 2),
            "stability": round(stability(plan, new_plan, state), 3),
            "urgent_ids": [o.id for o in urgent],
            "urgent_near": near_id,
            "urgent_assigned": sum(
                1 for r in new_plan.routes.values() for v in r.visits
                if v.order.id in {o.id for o in urgent}),
            "done_before": sorted(state.done),
            "failed_before": state.failed,
            "assigned_now": new_plan.assigned_count,
            "assigned_as_is": as_is.assigned_count,
        }
        if incident:
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
        with self._lock:
            self._replans[key] = out
            self._replan_parts[key] = (rest, new_plan)
        return out

    def replan_forms(self, **kwargs) -> dict:
        """Пересчёт со всеми четырьмя формами — то, что кладётся в архив.

        План берётся из `replan`, объяснение и симуляция строятся по тому же
        остатку дня и тому же новому плану: они уже посчитаны, второй раз
        гонять солвер незачем. График смен приходит от дня целиком — он про
        расписание, а пересчёт его не меняет.

        Важно, что объяснение и симуляция здесь честно про остаток, а не про
        весь день: подставить сюда формы исходного расчёта было бы проще, но
        они описывали бы план, которого больше нет.
        """
        out = self.replan(**kwargs)
        key = self._last_replan_key
        with self._lock:
            parts = self._replan_parts.get(key)
        if parts is None:
            raise RuntimeError("части пересчёта потерялись")
        rest, new_plan = parts

        plan_form = copy.deepcopy(out)
        # В архиве это обычный план: контракт знает четыре формы, и пятой
        # «replan» в нём нет. Разбор самого пересчёта остаётся в meta.
        plan_form["kind"] = "plan"
        seed = kwargs["seed"]
        return {
            "plan": plan_form,
            "explain": build_explain(rest, new_plan, _params(kwargs.get("seconds",
                                                                       REPLAN_SECONDS))),
            "simulation": build_simulation(rest, new_plan, runs=MC_RUNS, seed=seed),
            "shifts": self.forms(seed)["shifts"],
        }

    def _incident(self, seed: int, disabled: str | None,
                  delayed: str | None) -> dict | None:
        """Разобрать `disabled=E03` или `delayed=E03:40`. None, если ЧП нет."""
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
                raise ValueError("delayed задаётся как E03:40 — инженер и минуты")
            minutes = int(raw)
            if minutes <= 0:
                raise ValueError(f"задержка {minutes} минут — не задержка")
            kind = "delayed"

        day, _ = self.day_and_plan(seed)
        known = {e.id for e in day.engineers}
        if eng_id not in known:
            raise ValueError(f"нет инженера {eng_id}; есть {sorted(known)}")

        return {"kind": kind, "engineer_id": eng_id, "minutes": minutes}

    # ---------- применить подобранные смены ----------

    def with_tuned_shifts(self, seed: int) -> dict:
        """План на том же дне, но по подобранному графику выхода."""
        with self._lock:
            if seed in self._tuned:
                return self._tuned[seed]

        day, _ = self.day_and_plan(seed)
        starts = optimize(day, restarts=12, seed=seed).starts
        starts, _ = refine(day, starts, solver_seed=seed,
                           sim_seed=seed + 7000, rounds=2)
        tuned = apply_shifts(day, starts)
        plan = fast.solve(tuned, params=_params(), seed=seed)
        problems = plan.check_invariants(tuned)
        if problems:
            raise RuntimeError(f"план невалиден: {problems[:2]}")

        out = build_plan(tuned, plan, self.net)
        out["kind"] = "plan"
        out["meta"]["shifts_applied"] = {
            "starts_by_engineer": {e.id: f"{h:02d}:00"
                                   for e, h in zip(day.engineers, starts)},
            "coverage": round(monte_carlo(tuned, plan, runs=MC_RUNS,
                                          seed=seed).coverage * 100, 1),
        }
        with self._lock:
            self._tuned[seed] = out
        return out


STAND: Stand | None = None
# Архив сохранённых сравнений. Солвера не трогает: сравнение складывает
# рядом уже посчитанное, и заводить его можно даже на холодном стенде.
COMPARES = Compares()
# Архив расчётов. Заводится вместе со стендом: ему нужны его день и его
# дорожная сеть.
ARCHIVE: Runs | None = None


class Handler(BaseHTTPRequestHandler):
    server_version = "vrptw/1.0"

    # ---------- служебное ----------

    def _send(self, payload, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # Фронт живёт на другом порту, поэтому браузер иначе не пустит.
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods",
                         "GET, POST, DELETE, OPTIONS")
        self.end_headers()
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

        def day_arg(default: int = 1) -> int:
            return int(query.get("day", [default])[0])

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
                                   "cached_days": sorted(STAND._forms)})

            if path == "/api/days":
                ready = sorted(int(p.stem.split("-")[1])
                               for p in CACHE_DIR.glob("day-*.json"))
                return self._send({
                    "ready": ready,
                    "available": list(range(1, 31)),
                    "note": "любой day от 1 до 30; не посчитанный считается "
                            "по первому запросу за несколько секунд",
                })

            if path == "/api/day":
                return self._send(STAND.forms(day_arg(),
                                              fresh="fresh" in query))

            for name in ("plan", "explain", "simulation", "shifts"):
                if path == f"/api/{name}":
                    forms = STAND.forms(day_arg(), fresh="fresh" in query)
                    return self._send(forms[name])

            # Архив расчётов. `/api/runs` — история, `/api/runs/<id>` —
            # все четыре формы, `/api/runs/<id>/plan` — одна: карте
            # нужен только план, и тянуть ради неё объяснение незачем.
            if path == "/api/runs":
                return self._send({"runs": ARCHIVE.list()})

            # Архив сохранённых сравнений. Запись целиком лежит в списке:
            # она мелкая, и второй запрос за её содержимым был бы лишним.
            if path == "/api/compares":
                return self._send({"compares": COMPARES.list()})

            if path.startswith("/api/compares/"):
                compare_id = path[len("/api/compares/"):]
                record = COMPARES.get(compare_id)
                if record is None:
                    return self._error(f"нет такого сравнения: {compare_id}", 404)
                return self._send(record)

            if path.startswith("/api/runs/"):
                rest = path[len("/api/runs/"):].split("/")
                run_id = rest[0]
                record = ARCHIVE.get(run_id)
                if record is None:
                    return self._error(f"нет такого расчёта: {run_id}", 404)
                if len(rest) == 1:
                    forms = ARCHIVE.forms(run_id)
                    return self._send({"run": record, **forms})
                if len(rest) == 2 and rest[1] in ("plan", "explain",
                                                  "simulation", "shifts"):
                    return self._send(ARCHIVE.form(run_id, rest[1]))
                return self._error(f"нет такого пути: {path}", 404)

            if path == "/api/tuned":
                return self._send(STAND.with_tuned_shifts(day_arg()))

            if path == "/api/replan":
                return self._send(STAND.replan(
                    seed=day_arg(),
                    at=int(query.get("at", [13 * 60 + 40])[0]),
                    urgent_count=int(query.get("urgent", [2])[0]),
                    seconds=float(query.get("seconds", [REPLAN_SECONDS])[0]),
                    run=int(query.get("run", [0])[0]),
                    disabled=query.get("disabled", [None])[0],
                    delayed=query.get("delayed", [None])[0],
                    urgent_near=query.get("urgent_near", [None])[0],
                ))

            return self._error(f"нет такого пути: {path}", 404)

        except ValueError as exc:
            return self._error(f"плохой параметр: {exc}", 400)
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            return self._error(f"{type(exc).__name__}: {exc}", 500)

    def do_DELETE(self):  # noqa: N802
        path = urlparse(self.path).path.rstrip("/") or "/"
        try:
            if path.startswith("/api/compares/"):
                compare_id = path[len("/api/compares/"):]
                if not COMPARES.delete(compare_id):
                    return self._error(f"нет такого сравнения: {compare_id}", 404)
                return self._send({"deleted": compare_id})
            return self._error(f"нет такого пути: {path}", 404)
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

        path = url.path.rstrip("/") or "/"
        try:
            # Завести расчёт: посчитать день с этими переменными и
            # положить результат в архив. Ответ — карточка без форм:
            # интерфейсу сначала нужна строка в истории, формы он
            # заберёт, когда откроет расчёт.
            if path == "/api/runs":
                # Расчёт заводят двумя путями: посчитать день заново или
                # сохранить уже сделанный пересчёт. Второй приходит с блоком
                # replan — тогда солвер не запускается вовсе, результат у
                # него уже есть.
                spec = body.get("replan")
                if spec:
                    args = dict(
                        seed=int(spec.get("day", 1)),
                        at=int(spec.get("at", 13 * 60 + 40)),
                        urgent_count=int(spec.get("urgent", 0)),
                        seconds=float(spec.get("seconds", REPLAN_SECONDS)),
                        run=int(spec.get("run", 0)),
                        disabled=spec.get("disabled"),
                        delayed=spec.get("delayed"),
                        urgent_near=spec.get("urgent_near"),
                    )
                    forms = STAND.replan_forms(**args)
                    incident = dict(forms["plan"]["meta"]["replan"].get("incident") or {})
                    incident["day"] = args["seed"]
                    incident["at"] = args["at"]
                    incident["urgent"] = args["urgent_count"]
                    incident["urgent_near"] = args["urgent_near"]
                    return self._send(ARCHIVE.save_replan(
                        forms=forms,
                        source=body.get("source"),
                        incident=incident,
                        note=body.get("note", ""),
                    ), 201)

                return self._send(ARCHIVE.create(
                    day_seed=int(body.get("day", 1)),
                    params=normalize(body.get("params")),
                    note=body.get("note", ""),
                ), 201)

            # Сохранить сравнение: набор расчётов, который сложили рядом.
            # Движок ничего не считает — цифры приходят от интерфейса
            # снимком, и он же их показывал.
            if path == "/api/compares":
                return self._send(COMPARES.create(
                    runs=body.get("runs") or [],
                    note=body.get("note", ""),
                ), 201)

            if (path.startswith("/api/compares/") and path.endswith("/note")):
                compare_id = path[len("/api/compares/"):-len("/note")]
                record = COMPARES.annotate(compare_id, body.get("note", ""))
                if record is None:
                    return self._error(f"нет такого сравнения: {compare_id}", 404)
                return self._send(record)

            # Заметка человека к расчёту. Движок её не читает.
            if path.startswith("/api/runs/") and path.endswith("/note"):
                run_id = path[len("/api/runs/"):-len("/note")]
                record = ARCHIVE.annotate(run_id, body.get("note", ""))
                if record is None:
                    return self._error(f"нет такого расчёта: {run_id}", 404)
                return self._send(record)

            if path == "/api/replan":
                return self._send(STAND.replan(
                    seed=int(body.get("day", 1)),
                    at=int(body.get("at", 13 * 60 + 40)),
                    urgent_count=int(body.get("urgent", 2)),
                    seconds=float(body.get("seconds", REPLAN_SECONDS)),
                    run=int(body.get("run", 0)),
                    disabled=body.get("disabled"),
                    delayed=body.get("delayed"),
                    urgent_near=body.get("urgent_near"),
                ))
            return self._error(f"нет такого пути: {url.path}", 404)
        except BadCompare as exc:
            # Набор не складывается в сравнение — говорим прямо, что не так,
            # без обёртки «плохой параметр»: параметр тут ни при чём.
            return self._error(str(exc), 400)
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
                "GET /api/days": "какие дни готовы",
                "GET /api/day?day=1": "все четыре формы одним ответом",
                "GET /api/plan?day=1": "маршруты, карта, таймлайн",
                "GET /api/explain?day=1": "почему заявка у этого инженера",
                "GET /api/simulation?day=1": "сводка дня и хрупкие визиты",
                "GET /api/shifts?day=1": "график выхода: спрос против смен",
                "GET /api/tuned?day=1": "план по подобранному графику смен",
                "POST /api/runs":
                    "завести расчёт: {day, params, note} — считает день с "
                    "этими переменными и кладёт в архив, ~8 секунд",
                "GET /api/runs": "история расчётов, новые в конце",
                "GET /api/runs/<id>": "все четыре формы расчёта",
                "GET /api/runs/<id>/plan": "одна форма: карте больше не нужно",
                "POST /api/runs/<id>/note": "заметка человека к расчёту",
                "GET /api/replan?day=1&at=820&urgent=2":
                    "пересчёт: аварии в момент at, минуты от полуночи",
                "GET /api/replan?day=1&at=820&disabled=E03":
                    "инженера сегодня не будет — заявки уходят другим",
                "GET /api/replan?day=1&at=820&delayed=E03:40":
                    "инженер задержится на 40 минут и поедет дальше оттуда, где встал",
                "POST /api/replan":
                    "то же телом {day, at, urgent, seconds, run, disabled, delayed}",
            },
            "hints": {
                "time_format": "минуты от полуночи: 820 = 13:40",
                "fresh": "добавьте &fresh=1, чтобы пересчитать день заново",
                "run": "номер случайной траектории дня для пересчёта; "
                       "один и тот же run даёт один и тот же ход дня",
                "params": "пять переменных движка: churn_penalty, "
                       "duration_factor, buffer_step, buffer_base, "
                       "balance_weight. Чужие ключи выбрасываются, число "
                       "вне границ — ошибка 400, а не тихая подгонка",
                "расчёт против дня": "GET /api/plan?day=N — день с заводскими "
                       "переменными, кэш общий. POST /api/runs — расчёт "
                       "человека со своими переменными, лежит отдельно и "
                       "кэш дней не портит",
                "disabled и delayed": "два разных события, и это принципиально. "
                       "Выбытие на день стоит 4,7 визита и пересчёт возвращает "
                       "3,9 — жать надо. Прокол стоит 0,4–0,7 визита, буферы "
                       "съедают его сами. В ответе смотрите meta.replan.incident: "
                       "rescued — визиты выбывшего, которые подхватили другие",
            },
        }


def warm(stand: Stand, seeds: list[int]):
    for seed in seeds:
        t0 = time.time()
        try:
            # Формы могут прийти с диска, а план для пересчёта — нет:
            # без этой строки первый запрос пересчёта ждал бы восемь
            # секунд на постройку исходного плана.
            stand.day_and_plan(seed)
            stand.forms(seed)
            print(f"  день {seed} готов за {time.time() - t0:.1f} с")
        except Exception as exc:  # noqa: BLE001
            print(f"  день {seed} не собрался: {exc}")


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
    global STAND, ARCHIVE
    import socket
    import urllib.request

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    print("Проверка сервера\n")
    Handler.log_message = lambda *a, **k: None   # без построчного лога запросов
    STAND = Stand()
    ARCHIVE = Runs(STAND)
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"

    def get(path: str):
        t0 = time.time()
        with urllib.request.urlopen(base + path, timeout=300) as resp:
            payload = json.load(resp)
        return payload, time.time() - t0

    checks = [
        ("/api/health", lambda d: d["status"] == "ok"),
        ("/api/days", lambda d: 1 in d["available"]),
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

    # Кривой запрос должен получить понятный отказ, а не пятисотку.
    import urllib.error
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

    # Контракт проверяется тем же валидатором, что и фикстуры.
    import tempfile
    from .validate_fixtures import check as check_contract

    forms, _ = get("/api/day?day=1")
    with tempfile.TemporaryDirectory() as tmp:
        for name, payload in forms.items():
            (Path(tmp) / f"{name}.json").write_text(
                json.dumps(payload, ensure_ascii=False))
        problems = check_contract(Path(tmp))
    if problems:
        print(f"  ✗ контракт нарушен ({len(problems)}): {problems[:2]}")
        failed += 1
    else:
        print("  ✓ то, что отдаёт сервер, проходит проверку контракта")

    server.shutdown()
    print()
    if failed:
        print(f"✗ Проблем: {failed}")
        return 1
    print("✓ Сервер отвечает как обещано в CONTRACT.md.")
    return 0


def main():
    global STAND, ARCHIVE
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    seeds = ([int(x) for x in sys.argv[2].split(",")]
             if len(sys.argv) > 2 else [1])

    print("Стенд планировщика выездов — HTTP-сервер\n")
    print("  строю дорожную сеть…")
    t0 = time.time()
    STAND = Stand()
    ARCHIVE = Runs(STAND)
    print(f"  сеть готова за {time.time() - t0:.1f} с")

    print("  считаю дни для прогрева (первый запрос не будет ждать):")
    warm(STAND, seeds)

    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"\n  слушаю http://localhost:{port}")
    print(f"  описание api: http://localhost:{port}/api")
    print(f"  проверить:    curl http://localhost:{port}/api/plan?day=1\n")
    print("  Ctrl+C чтобы остановить\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  остановлен")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        sys.exit(check())
    main()
