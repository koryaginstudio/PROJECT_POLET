"""
Разрыв до оптимума.

Единственная метрика, которая доказывает качество солвера, а не просто
его превосходство над жадным. На малых днях оптимум считается точно
(HiGHS), на больших решатель не успевает, но выдаёт доказанную верхнюю
границу — и разрыв до неё есть оценка сверху для настоящего разрыва.

Обе стороны решают одну задачу: «замороженную» сеть с временем в пути
для 13:00 (зависимость от часа в линейной программе невыразима) и наш
планировщик без буфера до окна (буфер — защита от случайности, которой
в детерминированной задаче нет, он бы только мешал).

С той же оговоркой выключены штраф за неравномерность и вес
обязательства: MILP максимизирует просто число визитов, и если наш
планировщик будет считать иначе, сравниваться будут две разные задачи,
а не два решения одной.
"""

from __future__ import annotations

import multiprocessing as mp
import statistics
import sys

from .core.network import default_network
from .optimum import small_day, solve_exact
from .solvers import fast, improved
from .core.domain import require_valid

SIZES = [(20, 3), (27, 4), (34, 5), (45, 7), (60, 9)]
SEEDS = [1, 2, 3]
MILP_SECONDS = 90.0
# Бюджет нашего солвера — в шагах, а не в секундах. По секундам число
# доказанных совпадений гуляло от прогона к прогону (12 из 15, потом 11):
# сколько шагов успеет поиск, зависит от загрузки машины. Для утверждения
# «разрыв до оптимума такой-то» это недопустимо. 1500 шагов — тот же
# бюджет, что в остальных замерах, около восьми секунд.
OUR_ITERATIONS = 1500

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _one(args) -> dict:
    n, m, seed = args
    day = small_day(seed=seed, n_orders=n, n_engineers=m, network=_net())

    plan = fast.solve(day, params=improved.Params(buffer_step=0.0, balance_weight=0.0,
                                sla_weight=1.0, vehicle_weight=0.0,
                                priority_weights=(1.0, 1.0, 1.0), lns_seconds=0.0,
                                lns_iterations=OUR_ITERATIONS), seed=seed)
    require_valid(plan, day, "наш план невалиден")
    ours = plan.assigned_count

    r = solve_exact(day, time_limit=MILP_SECONDS)
    # Разрыв считаем до доказанной верхней границы: настоящий оптимум не
    # выше её, поэтому это оценка разрыва сверху.
    gap = (r.bound - ours) / r.bound * 100 if r.bound > 0 else 0.0

    return {"n": n, "m": m, "seed": seed, "ours": ours, "milp": r.assigned,
            "bound": r.bound, "proven": r.proven, "gap": gap,
            "milp_seconds": r.seconds}


def main():
    jobs = [(n, m, s) for n, m in SIZES for s in SEEDS]
    with mp.Pool(2) as pool:
        rows = pool.map(_one, jobs)

    print("Разрыв до оптимума\n")
    print(f"{'заявок/инж':>12}{'наш':>6}{'HiGHS':>7}{'граница':>9}"
          f"{'разрыв':>9}{'доказан':>9}{'сек HiGHS':>11}")
    print("─" * 64)

    for n, m in SIZES:
        group = [r for r in rows if r["n"] == n]
        for r in group:
            mark = "да" if r["proven"] else "нет"
            print(f"{f'{n}/{m}':>12}{r['ours']:>6}{r['milp']:>7}{r['bound']:>9.1f}"
                  f"{r['gap']:>8.1f}%{mark:>9}{r['milp_seconds']:>11.1f}")

    print("─" * 64)
    proven = [r for r in rows if r["proven"]]
    matched = [r for r in proven if r["ours"] >= r["bound"] - 1e-6]
    print(f"\nОптимум доказан в {len(proven)} случаях из {len(rows)}.")
    print(f"В них наш план совпал с оптимумом: {len(matched)} из {len(proven)}.")
    print(f"Средний разрыв до доказанной границы: "
          f"{statistics.mean(r['gap'] for r in rows):.2f}%")

    beaten = [r for r in rows if r["ours"] > r["milp"]]
    if beaten:
        print(f"\nСлучаи, где наш солвер обошёл HiGHS за отведённое время: {len(beaten)}")
        for r in beaten:
            print(f"  {r['n']}/{r['m']} день {r['seed']}: наш {r['ours']} "
                  f"за {OUR_ITERATIONS} шагов против {r['milp']} за {r['milp_seconds']:.0f} с")


def full():
    """Полный день: 80 заявок, 12 инженеров."""
    day = small_day(seed=1, n_orders=80, n_engineers=12, network=_net())
    plan = fast.solve(day, params=improved.Params(buffer_step=0.0, balance_weight=0.0,
                                sla_weight=1.0, vehicle_weight=0.0,
                                priority_weights=(1.0, 1.0, 1.0), lns_seconds=0.0,
                                lns_iterations=OUR_ITERATIONS),
                      seed=1)
    require_valid(plan, day)
    r = solve_exact(day, time_limit=240.0)

    print("Полный день: 80 заявок, 12 инженеров\n")
    print(f"  наш планировщик: {plan.assigned_count} за {OUR_ITERATIONS} шагов")
    print(f"  HiGHS:           {r.assigned} за {r.seconds:.0f} с")
    print(f"  доказанная верхняя граница: {r.bound:.0f}")
    gap = (r.bound - plan.assigned_count) / r.bound * 100
    print(f"  разрыв до границы: {max(0.0, gap):.1f}%")
    if plan.assigned_count >= r.bound - 1e-6:
        print("\n  → наш план совпал с верхней границей, то есть оптимален;")
        print("    HiGHS этого не доказал и сам нашёл меньше")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "full":
        full()
    else:
        main()
