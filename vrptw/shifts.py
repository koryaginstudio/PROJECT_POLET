"""
Эксперимент: что даёт подгонка смен под спрос.

Диагностика показала, что почти четверть ёмкости уходит в пустой хвост
смены и ещё 8% — в ожидание открытия окна, а 4.0 заявки в день физически
не выполнимы: их окно не пересекается ни с одной сменой. При этом спрос
смещён в вечер — слот 17–21 требует около 17 человеко-часов, а
большинство смен к 17:00 уже кончается.

Здесь один и тот же набор заявок планируется одним и тем же солвером
при разных расписаниях смен. Заявки не меняются — меняется только то,
кто когда работает.
"""

from __future__ import annotations

import multiprocessing as mp
import statistics

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .shiftopt import SHIFT_LEN
from .shiftopt import apply as with_shifts
from .solvers import fast, greedy, improved
from .core.domain import require_valid
from .stats import ci95

PROFILES: dict[str, list[int]] = {
    # Как сейчас: почти все утренние.
    "как есть": [8, 8, 9, 9, 10, 8, 9, 8, 10, 9, 8, 9],
    # Две волны: утро и вечер.
    "две волны": [8, 8, 8, 9, 9, 9, 11, 11, 12, 12, 12, 12],
    # Плавный веер под спрос. Последний старт — 12:00, а не 13:00:
    # девятичасовая смена с 13:00 кончается в 22:00, за жёсткой границей
    # дня, и такой план нарушает инвариант.
    "веер": [8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 12, 12],
    # Все поздно — контрольный, заведомо плохой вариант.
    "все поздно": [12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12],
}


def _run(args):
    seed, name = args
    net = default_network()
    base = generate_day(seed=seed, network=net)
    day = with_shifts(base, PROFILES[name])
    params = improved.Params(lns_seconds=4.0)
    plan = fast.solve(day, params=params, seed=seed)
    require_valid(plan, day)
    mc = monte_carlo(day, plan, runs=200, seed=seed)
    return name, plan.assigned_count, mc.done_mean, mc.coverage * 100, mc.overtime_mean


def _both(args):
    """Оба планировщика на одном и том же расписании."""
    seed, name = args
    net = default_network()
    day = with_shifts(generate_day(seed=seed, network=net), PROFILES[name])

    plan_g = greedy.solve(day)
    require_valid(plan_g, day)
    cov_g = monte_carlo(day, plan_g, runs=200, seed=seed).coverage * 100

    plan_i = fast.solve(day, params=improved.Params(lns_seconds=4.0),
                        seed=seed)
    require_valid(plan_i, day)
    cov_i = monte_carlo(day, plan_i, runs=200, seed=seed).coverage * 100

    return name, seed, cov_g, cov_i


def grid():
    """Таблица «расписание × планировщик» — обе оси в одном замере.

    Числа для питча берутся отсюда, а не из разных запусков: смешивать
    замеры, сделанные в разное время разными версиями кода, нельзя.
    """
    seeds = list(range(1, 13))
    order = ["как есть", "две волны", "веер"]
    with mp.Pool(2) as pool:
        rows = pool.map(_both, [(s, n) for n in order for s in seeds])

    print(f"Покрытие дня: расписание против планировщика ({len(seeds)} дней)\n")
    print(f"{'расписание':<14}{'жадный':>10}{'улучшенный':>13}{'разница':>11}")
    print("─" * 48)
    for name in order:
        g = [r for r in rows if r[0] == name]
        cg = statistics.mean(r[2] for r in g)
        ci = statistics.mean(r[3] for r in g)
        diffs = [r[3] - r[2] for r in g]
        _, h = ci95(diffs)
        print(f"{name:<14}{cg:>9.1f}%{ci:>12.1f}%{statistics.mean(diffs):>+8.1f} ± {h:.1f}")
    print("─" * 48)
    print("\nВклад расписания при одном и том же планировщике:")
    base = {r[1]: r for r in rows if r[0] == "как есть"}
    for name in order[1:]:
        g = [r for r in rows if r[0] == name]
        dg = [r[2] - base[r[1]][2] for r in g]
        di = [r[3] - base[r[1]][3] for r in g]
        print(f"  {name:<12} жадный {statistics.mean(dg):+5.1f} п.п.   "
              f"улучшенный {statistics.mean(di):+5.1f} п.п.")


def main():
    seeds = list(range(1, 13))
    jobs = [(s, name) for name in PROFILES for s in seeds]

    with mp.Pool(2) as pool:
        rows = pool.map(_run, jobs)

    agg: dict[str, list] = {}
    for name, assigned, done, cov, ot in rows:
        agg.setdefault(name, []).append((assigned, done, cov, ot))

    print("Одни и те же заявки, разные расписания смен (12 дней)\n")
    print(f"{'профиль смен':<14}{'назначено':>10}{'выполнено':>11}{'покрытие':>11}{'переработка':>13}")
    print("─" * 60)
    baseline = None
    for name in PROFILES:
        vals = agg[name]
        n = len(vals)
        cov = sum(v[2] for v in vals) / n
        if name == "как есть":
            baseline = cov
        print(f"{name:<14}{sum(v[0] for v in vals)/n:>10.1f}"
              f"{sum(v[1] for v in vals)/n:>11.1f}{cov:>10.1f}%"
              f"{sum(v[3] for v in vals)/n:>12.0f}м")

    print("\nПрирост покрытия относительно «как есть» (парно по дням):")
    base_by_seed = {s: c for (n, _, _, c, _), s in
                    zip([r for r in rows if r[0] == "как есть"], seeds)}
    for name in PROFILES:
        if name == "как есть":
            continue
        deltas = [c - base_by_seed[s] for (n, _, _, c, _), s in
                  zip([r for r in rows if r[0] == name], seeds)]
        m, h = ci95(deltas)
        print(f"  {name:<14}{m:+6.1f} ± {h:.1f} п.п.")


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "grid":
        grid()
    else:
        main()
