"""
Стресс-тест: держится ли стенд на других размерах дня.

Все замеры до сих пор делались на одной конфигурации — 80 заявок,
12 инженеров. С 15 сентября придут настоящие данные, и их масштаб
заранее неизвестен: бригада может оказаться вдвое больше, заявок —
вдвое меньше. Поэтому проверяется три вещи.

  1. Ничего не падает и план остаётся валидным на любом размере.
  2. Время решения растёт предсказуемо. Regret-вставка квадратична по
     числу заявок, поэтому итераций в секунду обязано становиться
     меньше — вопрос в том, насколько резко.
  3. Выводы не разваливаются. Если на 150 заявках улучшенный вдруг
     перестанет обгонять жадный, значит выводы были свойством одного
     конкретного размера, а не алгоритма.

Отдельно проверяется перекос: тот же день при заведомо избыточной и
заведомо недостаточной бригаде.

    python3 -m vrptw.stress          размеры дня
    python3 -m vrptw.stress load     перекос по загрузке
    python3 -m vrptw.stress edge     вырожденные случаи
"""

from __future__ import annotations

import multiprocessing as mp
import statistics
import sys
import time

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .diagnose import balance
from .solvers import fast, greedy, improved

# Пропорция взята из базовой конфигурации: 80/12 ≈ 6,7 заявки на инженера.
SIZES = [(20, 3), (40, 6), (80, 12), (120, 18), (150, 22), (240, 36)]

# Перекос: те же 80 заявок при разной бригаде.
LOADS = [(80, 6), (80, 9), (80, 12), (80, 16), (80, 24)]

SEEDS = [1, 2, 3, 4]
RUNS = 150
LNS_SECONDS = 8.0

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _one(args) -> dict:
    n, m, seed = args
    day = generate_day(seed=seed, n_orders=n, n_engineers=m, network=_net())

    t0 = time.time()
    plan_g = greedy.solve(day)
    greedy_seconds = time.time() - t0
    problems_g = plan_g.check_invariants(day)

    report: dict = {}
    t0 = time.time()
    plan = fast.solve(day, params=improved.Params(lns_seconds=LNS_SECONDS),
                      seed=seed, report=report)
    solve_seconds = time.time() - t0
    problems = plan.check_invariants(day)

    mc_g = monte_carlo(day, plan_g, runs=RUNS, seed=seed)
    mc = monte_carlo(day, plan, runs=RUNS, seed=seed)
    b = balance(day, plan)

    return {
        "n": n, "m": m, "seed": seed,
        "greedy_assigned": plan_g.assigned_count,
        "greedy_coverage": mc_g.coverage * 100,
        "greedy_seconds": greedy_seconds,
        "assigned": plan.assigned_count,
        "coverage": mc.coverage * 100,
        "seconds": solve_seconds,
        "iterations": report.get("iterations", 0),
        "gini": b["occupancy_gini"],
        "problems": len(problems) + len(problems_g),
        "first_problem": (problems + problems_g)[:1],
    }


def _table(rows: list[dict], groups: list[tuple[int, int]], title: str,
           first_col: str):
    print(f"{title}\n")
    print(f"{first_col:>12}{'жадный':>9}{'наш':>7}{'разница':>10}"
          f"{'сек':>7}{'итер/с':>9}{'Джини':>8}{'инварианты':>12}")
    print("─" * 74)

    for n, m in groups:
        g = [r for r in rows if r["n"] == n and r["m"] == m]
        if not g:
            continue
        cov_g = statistics.mean(r["greedy_coverage"] for r in g)
        cov = statistics.mean(r["coverage"] for r in g)
        secs = statistics.mean(r["seconds"] for r in g)
        iters = statistics.mean(r["iterations"] for r in g) / max(secs, 1e-9)
        gini = statistics.mean(r["gini"] for r in g)
        bad = sum(r["problems"] for r in g)
        mark = "чисто" if bad == 0 else f"{bad} нарушений"
        print(f"{f'{n}/{m}':>12}{cov_g:>8.1f}%{cov:>6.1f}%{cov - cov_g:>+9.1f}"
              f"{secs:>7.1f}{iters:>9.0f}{gini:>8.3f}{mark:>12}")
    print("─" * 74)

    broken = [r for r in rows if r["problems"]]
    if broken:
        print("\nНарушенные инварианты:")
        for r in broken[:5]:
            print(f"  {r['n']}/{r['m']} день {r['seed']}: {r['first_problem']}")
    else:
        print("\nИнварианты чисты на всех конфигурациях.")


def sizes():
    jobs = [(n, m, s) for n, m in SIZES for s in SEEDS]
    with mp.Pool(2) as pool:
        rows = pool.map(_one, jobs)
    _table(rows, SIZES,
           f"Размер дня: пропорция 6,7 заявки на инженера сохраняется "
           f"({len(SEEDS)} дня × {RUNS} прогонов, бюджет LNS {LNS_SECONDS:.0f} с)",
           "заявок/инж")

    print("\nМасштабирование поиска:")
    base = None
    for n, m in SIZES:
        g = [r for r in rows if r["n"] == n]
        secs = statistics.mean(r["seconds"] for r in g)
        rate = statistics.mean(r["iterations"] for r in g) / max(secs, 1e-9)
        if base is None:
            base = rate
        print(f"  {n:>4} заявок: {rate:>6.0f} итераций/с "
              f"({rate / base * 100:>5.1f}% от скорости на {SIZES[0][0]} заявках)")


def load():
    jobs = [(n, m, s) for n, m in LOADS for s in SEEDS]
    with mp.Pool(2) as pool:
        rows = pool.map(_one, jobs)
    _table(rows, LOADS,
           f"Перекос по загрузке: 80 заявок, бригада от 6 до 24 человек "
           f"({len(SEEDS)} дня × {RUNS} прогонов)",
           "заявок/инж")

    print("\nЗаявок на инженера против покрытия:")
    for n, m in LOADS:
        g = [r for r in rows if r["m"] == m]
        cov = statistics.mean(r["coverage"] for r in g)
        gini = statistics.mean(r["gini"] for r in g)
        print(f"  {n / m:>4.1f} заявки на инженера: покрытие {cov:>5.1f}%, "
              f"Джини {gini:.3f}")


def edge():
    """Вырожденные случаи, на которых обычно всё и ломается."""
    cases = [
        ("один инженер", 12, 1),
        ("одна заявка", 1, 3),
        ("две заявки, один инженер", 2, 1),
        ("инженеров больше, чем заявок", 4, 10),
        ("огромная бригада", 30, 40),
    ]
    print("Вырожденные случаи\n")
    print(f"{'случай':<28}{'заявок/инж':>12}{'назначено':>11}"
          f"{'сек':>7}{'инварианты':>12}")
    print("─" * 70)

    failures = []
    for label, n, m in cases:
        for seed in (1, 2):
            try:
                day = generate_day(seed=seed, n_orders=n, n_engineers=m,
                                   network=_net())
                t0 = time.time()
                plan = fast.solve(day, params=improved.Params(
                    lns_seconds=1.0), seed=seed)
                secs = time.time() - t0
                problems = plan.check_invariants(day)
                # Симуляция тоже должна пережить вырожденный день.
                monte_carlo(day, plan, runs=50, seed=seed)
            except Exception as exc:  # noqa: BLE001 — тут ловим ровно всё
                failures.append((label, seed, repr(exc)))
                print(f"{label:<28}{f'{n}/{m}':>12}{'—':>11}{'—':>7}{'ПАДЕНИЕ':>12}")
                break
            if seed == 1:
                mark = "чисто" if not problems else f"{len(problems)} нарушений"
                if problems:
                    failures.append((label, seed, str(problems[:1])))
                print(f"{label:<28}{f'{n}/{m}':>12}{plan.assigned_count:>11}"
                      f"{secs:>7.1f}{mark:>12}")
    print("─" * 70)

    if failures:
        print(f"\nПроблемы ({len(failures)}):")
        for label, seed, msg in failures:
            print(f"  {label}, день {seed}: {msg}")
    else:
        print("\nВсе вырожденные случаи проходят: ни падений, ни нарушений.")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "sizes"
    if mode == "load":
        load()
    elif mode == "edge":
        edge()
    else:
        sizes()
