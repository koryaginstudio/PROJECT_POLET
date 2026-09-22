"""
Равномерность загрузки: сколько она стоит и кто её на самом деле портит.

В техзадании «неравномерная загрузка инженеров» названа болью прямым
текстом. Мерить её принято по занятости: доля смены, ушедшая на работу
и дорогу. Простой в ожидании окна в занятость не входит — инженер,
который час ждёт открытия окна, занят не по своей вине.

Два вопроса, и порядок здесь важен.

  1. Чем вызвана неравномерность? Диагностика дня показывает картину,
     которую невозможно исправить маршрутизацией: при утренних сменах
     двое установщиков не получают ни одной заявки, потому что весь
     неразмещённый спрос — вечерний. Их незанятость — свойство
     расписания, а не плана поездок.

  2. Сколько стоит выравнивание там, где оно возможно? Штраф
     `balance_weight` квадратичен по занятости маршрута, поэтому
     очередной визит тем дороже, чем более загружен инженер. Вопрос
     в том, чем за это платит покрытие.

Режимы:
    python3 -m vrptw.balancebench            вес штрафа против покрытия
    python3 -m vrptw.balancebench asis       то же на утренних сменах
    python3 -m vrptw.balancebench shifts     равномерность по расписаниям
"""

from __future__ import annotations

import multiprocessing as mp
import statistics
import sys

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .diagnose import balance
from .shifts import PROFILES, with_shifts
from .solvers import fast, improved
from .stats import ci95
from .core.domain import require_valid

WEIGHTS = [0.0, 1.0, 4.0, 8.0, 16.0, 40.0]
SEEDS = list(range(1, 9))
RUNS = 200
LNS_SECONDS = 4.0

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _measure(day, plan, seed: int) -> dict:
    b = balance(day, plan)
    mc = monte_carlo(day, plan, runs=RUNS, seed=seed)
    return {
        "assigned": plan.assigned_count,
        "coverage": mc.coverage * 100,
        "done": mc.done_mean,
        "gini": b["occupancy_gini"],
        "spread": (b["occupancy_max"] - b["occupancy_min"]) * 100,
        "idle_engineers": b["idle_engineers"],
        "visits_min": b["visits_min"],
        "visits_max": b["visits_max"],
    }


def _one(args) -> dict:
    seed, profile, weight = args
    day = generate_day(seed=seed, network=_net())
    if profile is not None:
        day = with_shifts(day, PROFILES[profile])
    plan = fast.solve(day, params=improved.Params(
        lns_seconds=LNS_SECONDS, balance_weight=weight), seed=seed)
    require_valid(plan, day, f"невалидный план, seed {seed}")
    row = _measure(day, plan, seed)
    row.update(seed=seed, profile=profile, weight=weight)
    return row


def _paired(rows: list[dict], key: str, weight: float, base: float = 0.0):
    """Парная разница по дням против нулевого веса."""
    ref = {r["seed"]: r[key] for r in rows if r["weight"] == base}
    diffs = [r[key] - ref[r["seed"]] for r in rows if r["weight"] == weight]
    return ci95(diffs)                   # по t: дней восемь, а не бесконечность


def weights(profile: str = "веер"):
    jobs = [(s, profile, w) for w in WEIGHTS for s in SEEDS]
    with mp.Pool(2) as pool:
        rows = pool.map(_one, jobs)

    print(f"Штраф за неравномерность, смены «{profile}», "
          f"{len(SEEDS)} дней × {RUNS} прогонов\n")
    print(f"{'вес':>6}{'Джини':>8}{'разрыв':>9}{'визитов':>11}"
          f"{'покрытие':>11}{'простаивают':>13}")
    print("─" * 58)
    for w in WEIGHTS:
        g = [r for r in rows if r["weight"] == w]
        print(f"{w:>6.0f}{statistics.mean(r['gini'] for r in g):>8.3f}"
              f"{statistics.mean(r['spread'] for r in g):>8.0f}п"
              f"{statistics.mean(r['visits_min'] for r in g):>7.1f}—"
              f"{statistics.mean(r['visits_max'] for r in g):<3.1f}"
              f"{statistics.mean(r['coverage'] for r in g):>10.1f}%"
              f"{statistics.mean(r['idle_engineers'] for r in g):>13.2f}")
    print("─" * 58)

    print("\nПарно против нулевого веса:")
    for w in WEIGHTS[1:]:
        dg, hg = _paired(rows, "gini", w)
        dc, hc = _paired(rows, "coverage", w)
        print(f"  вес {w:>5.0f}:  Джини {dg:+.3f} ± {hg:.3f}   "
              f"покрытие {dc:+.1f} ± {hc:.1f} п.п.")


def shifts_view():
    """Равномерность как функция расписания, а не алгоритма."""
    order = ["как есть", "две волны", "веер"]
    jobs = [(s, p, 0.0) for p in order for s in SEEDS]
    with mp.Pool(2) as pool:
        rows = pool.map(_one, jobs)

    print(f"Равномерность при разных расписаниях смен, штраф выключен\n")
    print(f"{'расписание':<14}{'Джини':>8}{'разрыв':>9}{'простаивают':>14}{'покрытие':>11}")
    print("─" * 58)
    for p in order:
        g = [r for r in rows if r["profile"] == p]
        print(f"{p:<14}{statistics.mean(r['gini'] for r in g):>8.3f}"
              f"{statistics.mean(r['spread'] for r in g):>8.0f}п"
              f"{statistics.mean(r['idle_engineers'] for r in g):>14.2f}"
              f"{statistics.mean(r['coverage'] for r in g):>10.1f}%")
    print("─" * 58)
    print("\nПростаивающий инженер при утренних сменах — не ошибка плана:")
    print("весь неразмещённый спрос в такие дни открывается после 17:00,")
    print("и взять его человеку со сменой до 17:00 нечем.")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "main"
    if mode == "shifts":
        shifts_view()
    elif mode == "asis":
        weights("как есть")
    else:
        weights()
