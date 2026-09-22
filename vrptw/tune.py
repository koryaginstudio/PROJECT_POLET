"""
Подбор параметров планировщика по покрытию в симуляции.

Меряет `fast` — тот солвер, который поедет на демо, — и бюджетом в
итерациях, чтобы подобранное не зависело от скорости машины.
"""

from __future__ import annotations

import itertools
import multiprocessing as mp
import sys

from vrptw.core.generate import generate_day
from vrptw.core.network import default_network
from vrptw.core.simulate import monte_carlo
from vrptw.solvers import fast, improved
from vrptw.core.domain import require_valid

# Тот же бюджет, что в bench, только короче: подбор перебирает много точек.
LNS_ITERATIONS = 900

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _one(args):
    seed, buffer_step, duration_factor, iters = args
    day = generate_day(seed=seed, network=_net())
    p = improved.Params(buffer_step=buffer_step, duration_factor=duration_factor,
                        lns_seconds=0.0, lns_iterations=iters)
    plan = fast.solve(day, params=p, seed=seed)
    require_valid(plan, day, "план нарушает инварианты")
    mc = monte_carlo(day, plan, runs=200, seed=seed)
    return (buffer_step, duration_factor, seed, plan.assigned_count,
            mc.done_mean, mc.coverage, mc.reasons_mean.get("missed_window", 0.0))


def main():
    seeds = list(range(1, 7))
    # Сетка расширена вправо: на быстрой версии солвера оптимум
    # оказался за прежней границей 40.
    buffers = [16.0, 22.0, 30.0, 40.0, 55.0, 70.0, 90.0]
    factors = [1.0]
    iters = LNS_ITERATIONS

    if len(sys.argv) > 1 and sys.argv[1] == "factor":
        buffers = [16.0]
        factors = [1.0, 1.08, 1.15, 1.25]

    jobs = [(s, b, f, iters) for b, f, s in itertools.product(buffers, factors, seeds)]

    with mp.Pool(2) as pool:
        rows = pool.map(_one, jobs)

    agg: dict[tuple[float, float], list] = {}
    for b, f, seed, assigned, done, cov, mw in rows:
        agg.setdefault((b, f), []).append((assigned, done, cov, mw))

    print(f"{'буфер':>6} {'фактор':>7} {'назнач':>7} {'выполн':>7} {'покрытие':>9} {'окно':>6}")
    print("-" * 48)
    for (b, f), vals in sorted(agg.items()):
        n = len(vals)
        print(f"{b:6.0f} {f:7.2f} {sum(v[0] for v in vals)/n:7.1f} "
              f"{sum(v[1] for v in vals)/n:7.1f} "
              f"{sum(v[2] for v in vals)/n*100:8.1f}% {sum(v[3] for v in vals)/n:6.2f}")


if __name__ == "__main__":
    main()
