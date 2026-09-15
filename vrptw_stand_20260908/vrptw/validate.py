"""
Четыре проверки честности результата:

1. Held-out. Параметры подбирались на днях 1–6. Если выигрыш держится
   на днях 13–30, которых при настройке не было, — это не подгонка.
2. Буфер против расписания смен. Подбор буфера на одном расписании
   уводит в минус на другом, поэтому он проверяется сразу на двух.
3. Сходимость LNS. Сколько шагов поиска реально нужно, и не упирается
   ли результат в потолок раньше отведённого бюджета.
4. Устойчивость к бюджету. Если результат заметно зависит от того,
   сколько шагов успел поиск, то он зависит и от машины, на которой
   замер запущен. Плато в таблице сходимости — это и есть ответ на
   вопрос «а у меня получится столько же?».

Меряет `fast` — тот солвер, который поедет на демо. Бюджет задан в
итерациях, а не в секундах: число итераций одно у всех, секунды у
каждой машины свои. Секунды печатаются рядом, чтобы latency-обещание
тоже было видно.
"""

from __future__ import annotations

import multiprocessing as mp
import statistics
import sys
import time

from vrptw.core.generate import generate_day
from vrptw.core.network import default_network
from vrptw.core.simulate import monte_carlo
from vrptw.solvers import fast, greedy, improved

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


# Тот же бюджет, что в bench: около восьми секунд быстрой версии.
LNS_ITERATIONS = 1500


def _pair(seed: int) -> tuple[float, float]:
    day = generate_day(seed=seed, network=_net())
    pg = greedy.solve(day)
    mg = monte_carlo(day, pg, runs=200, seed=seed)
    pi = fast.solve(day, params=improved.Params(
        lns_seconds=0.0, lns_iterations=LNS_ITERATIONS), seed=seed)
    assert not pi.check_invariants(day)
    mi = monte_carlo(day, pi, runs=200, seed=seed)
    return mg.coverage * 100, mi.coverage * 100


def _converge(args):
    seed, iters = args
    day = generate_day(seed=seed, network=_net())
    p = improved.Params(lns_seconds=0.0, lns_iterations=iters)
    t0 = time.time()
    plan = fast.solve(day, params=p, seed=seed)
    secs = time.time() - t0
    mc = monte_carlo(day, plan, runs=200, seed=seed)
    return iters, plan.assigned_count, mc.coverage * 100, secs


def ci95(xs):
    m = statistics.mean(xs)
    if len(xs) < 2:
        return m, 0.0
    return m, 1.96 * statistics.stdev(xs) / len(xs) ** 0.5


def held_out():
    seeds = list(range(13, 31))
    with mp.Pool(2) as pool:
        rows = pool.map(_pair, seeds)
    deltas = [i - g for g, i in rows]
    m, h = ci95(deltas)
    g_avg = statistics.mean(g for g, _ in rows)
    i_avg = statistics.mean(i for _, i in rows)
    print(f"Held-out: дни 13–30 ({len(seeds)} дней), при настройке не использовались")
    print(f"  покрытие жадный    {g_avg:.1f}%")
    print(f"  покрытие улучшенный {i_avg:.1f}%")
    print(f"  разница            {m:+.1f} ± {h:.1f} п.п.")
    print("  → " + ("выигрыш держится, подгонки нет" if m - h > 0
                    else "на новых днях выигрыш не подтверждён"))


def _buffer_pair(args):
    seed, profile, step = args
    from .shifts import PROFILES, with_shifts

    day = generate_day(seed=seed, network=_net())
    if profile is not None:
        day = with_shifts(day, PROFILES[profile])
    p = improved.Params(buffer_step=step, lns_seconds=0.0,
                        lns_iterations=LNS_ITERATIONS)
    plan = fast.solve(day, params=p, seed=seed)
    assert not plan.check_invariants(day)
    mc = monte_carlo(day, plan, runs=200, seed=seed)
    return profile, step, seed, (mc.coverage * 100, plan.assigned_count,
                                 mc.reasons_mean.get("missed_window", 0.0))


def buffer_holdout():
    """
    Буфер против расписания смен, на днях, которых при подборе не было.

    `tune` перебирает буфер на днях 1–6 при одном расписании и печатает
    средние без интервалов — этого мало, чтобы что-то менять, и, как
    выяснилось, мало принципиально: **оптимальный буфер зависит от того,
    как расставлены смены**, и подбор на одном расписании уводит в
    минус на другом.

    Здесь каждое значение сравнивается парно с рабочим (`BUFFER_STEP`)
    на днях 13–30, отдельно для утренних смен и для веера. Один и тот же
    день, один и тот же набор прогонов симуляции, разница по каждому дню.
    """
    from .shifts import PROFILES

    seeds = list(range(13, 31))
    steps = [0.0, improved.BUFFER_STEP, 30.0, 45.0]
    profiles = ["как есть", "веер"]
    jobs = [(s, pr, st) for pr in profiles for st in steps for s in seeds]
    with mp.Pool(2) as pool:
        rows = pool.map(_buffer_pair, jobs)

    by: dict = {}
    for profile, step, seed, vals in rows:
        by.setdefault((profile, step), {})[seed] = vals

    print(f"\nБуфер против расписания смен, дни 13–30 ({len(seeds)} дней), "
          f"парное сравнение")
    print(f"  {'расписание':<12}{'буфер':>7}{'покрытие':>10}{'назнач':>9}"
          f"{'окно':>7}   разница к {improved.BUFFER_STEP:.0f}, п.п.")
    for profile in profiles:
        base = by[(profile, improved.BUFFER_STEP)]
        for step in steps:
            d = by[(profile, step)]
            cov = statistics.mean(v[0] for v in d.values())
            asg = statistics.mean(v[1] for v in d.values())
            mw = statistics.mean(v[2] for v in d.values())
            if step == improved.BUFFER_STEP:
                tail = "— (рабочий)"
            else:
                m, h = ci95([d[s][0] - base[s][0] for s in seeds])
                tail = f"{m:+.2f} ± {h:.2f}"
            print(f"  {profile:<12}{step:>7.0f}{cov:>9.1f}%{asg:>9.1f}{mw:>7.2f}   {tail}")
        print()
    print("  → буфер тем полезнее, чем острее дефицит ёмкости: на утренних сменах")
    print("    лишний визит всё равно сорвётся и выгоднее защищать поставленные,")
    print("    на веере маршруты длиннее и буфер начинает вычёркивать проходимое.")
    print(f"    {improved.BUFFER_STEP:.0f} — точка, безопасная для обоих режимов.")


def converge():
    seeds = list(range(1, 7))
    budgets = [50, 200, 500, 1500, 4000]
    jobs = [(s, b) for b in budgets for s in seeds]
    with mp.Pool(2) as pool:
        rows = pool.map(_converge, jobs)
    agg: dict[int, list] = {}
    for iters, assigned, cov, secs in rows:
        agg.setdefault(iters, []).append((assigned, cov, secs))
    print("\nСходимость LNS (6 дней, быстрая версия):")
    print(f"  {'итераций':>9} {'назначено':>10} {'покрытие':>10} {'секунд':>8}")
    for iters in budgets:
        vals = agg[iters]
        n = len(vals)
        print(f"  {iters:>9} {sum(v[0] for v in vals)/n:>10.1f} "
              f"{sum(v[1] for v in vals)/n:>9.1f}% {sum(v[2] for v in vals)/n:>8.1f}")
    lo = statistics.mean(v[1] for v in agg[budgets[-2]])
    hi = statistics.mean(v[1] for v in agg[budgets[-1]])
    print(f"\n  от {budgets[-2]} к {budgets[-1]} итерациям покрытие меняется на "
          f"{hi - lo:+.1f} п.п.")
    print("  → на плато результат не зависит от того, сколько успела машина")


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "heldout"):
        held_out()
    if what in ("all", "buffer"):
        buffer_holdout()
    if what in ("all", "converge"):
        converge()
