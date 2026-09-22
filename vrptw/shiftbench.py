"""
Проверка подбора смен.

Два вопроса, и второй важнее первого:
  1. Даёт ли подобранное расписание больше, чем заданное руками?
  2. Можно ли вообще верить прокси? Если непокрытый спрос не связан с
     настоящим покрытием дня, то оптимизатор минимизирует красивое
     число, а не результат.
"""

from __future__ import annotations

import multiprocessing as mp
import random
import statistics
import sys

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .shiftopt import allowed_starts, apply, demand_curve, optimize, undercoverage
from .shifts import PROFILES, with_shifts
from .solvers import fast, improved
from .core.domain import require_valid
from .stats import ci95

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _coverage(day, seed: int, secs: float = 4.0) -> float:
    plan = fast.solve(day, params=improved.Params(lns_seconds=secs),
                      seed=seed)
    require_valid(plan, day)
    return monte_carlo(day, plan, runs=200, seed=seed).coverage * 100


def _one_day(seed: int):
    from .shiftopt import ShiftPlan, refine

    base = generate_day(seed=seed, network=_net())

    as_is = with_shifts(base, PROFILES["как есть"])
    manual = with_shifts(base, PROFILES["веер"])

    sp = optimize(base, restarts=12, seed=seed)

    # Доводка ведётся на своём наборе прогонов, оценивается ниже на другом —
    # иначе выигрыш окажется подгонкой под конкретные случайные числа.
    refined_starts, _ = refine(base, sp.starts, solver_seed=seed,
                               sim_seed=seed + 7000, rounds=2)

    return {
        "seed": seed,
        "as_is": _coverage(as_is, seed),
        "manual": _coverage(manual, seed),
        "tuned": _coverage(apply(base, sp.starts), seed),
        "refined": _coverage(apply(base, refined_starts), seed),
        "gap": sp.gap_hours,
        "profile": ShiftPlan(refined_starts, sp.gap_hours).describe(),
    }


def _proxy_point(args):
    """Одно случайное расписание: прокси против настоящего покрытия."""
    seed, trial = args
    base = generate_day(seed=seed, network=_net())
    rng = random.Random(trial * 977 + seed)
    # Часы выхода — от границы дня, а не константой. На синтетике список
    # тот же [7…12], так что и случайные выборы те же самые.
    starts = [rng.choice(allowed_starts(base)) for _ in base.engineers]
    gap = undercoverage(demand_curve(base), base.engineers, starts)
    return gap, _coverage(apply(base, starts), seed, secs=2.5)


def check_proxy(seed: int = 5, trials: int = 24):
    with mp.Pool(2) as pool:
        pts = pool.map(_proxy_point, [(seed, t) for t in range(trials)])

    gaps = [p[0] for p in pts]
    covs = [p[1] for p in pts]
    r = statistics.correlation(gaps, covs)

    print(f"Проверка прокси: {trials} случайных расписаний на дне {seed}")
    print(f"  непокрытый спрос: {min(gaps):.1f} … {max(gaps):.1f} ч")
    print(f"  покрытие дня:     {min(covs):.1f} … {max(covs):.1f}%")
    print(f"  корреляция:       {r:+.2f}")
    print("  → " + ("прокси ведёт в нужную сторону" if r < -0.5
                    else "прокси слабо связан с результатом, доверять нельзя"))


def main():
    seeds = list(range(1, 13))
    with mp.Pool(2) as pool:
        rows = pool.map(_one_day, seeds)

    print("Расписание смен: заданное руками против подобранного\n")
    print(f"{'день':>4} │ {'как есть':>9} {'веер':>8} {'прокси':>8} {'+ доводка':>10}")
    print("─" * 50)
    for r in rows:
        print(f"{r['seed']:>4} │ {r['as_is']:>8.1f}% {r['manual']:>7.1f}% "
              f"{r['tuned']:>7.1f}% {r['refined']:>9.1f}%")

    ci = ci95                          # по t: дней мало, 1,96 занижает

    print("─" * 50)
    for label, key in (("как есть", "as_is"), ("веер вручную", "manual"),
                       ("прокси", "tuned"), ("прокси + доводка", "refined")):
        print(f"  {label:<18}{statistics.mean(r[key] for r in rows):>6.1f}%")

    print()
    for label, a, b in (("прокси − веер вручную", "tuned", "manual"),
                        ("доводка − прокси", "refined", "tuned"),
                        ("доводка − веер вручную", "refined", "manual"),
                        ("доводка − как есть", "refined", "as_is")):
        m, h = ci([r[a] - r[b] for r in rows])
        mark = "значимо" if abs(m) - h > 0 else "не значимо"
        print(f"  {label:<24}{m:+6.1f} ± {h:.1f} п.п.   {mark}")

    print("\nПодобранные графики выхода:")
    for r in rows[:4]:
        print(f"  день {r['seed']}: {r['profile']}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "proxy":
        check_proxy()
    else:
        main()
