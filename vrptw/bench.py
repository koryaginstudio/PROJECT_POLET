"""
Парное сравнение планировщиков.

Оба планировщика видят один и тот же день и оцениваются одним и тем же
симулятором на одних и тех же случайных прогонах. Разница считается
по каждому дню отдельно, затем усредняется — это парный тест, он
устойчивее к тому, что дни различаются по трудности.

Два решения, без которых числу отсюда нельзя верить.

**Меряется тот солвер, который поедет на демо** — `fast`. Раньше здесь
стоял `improved`: тот же алгоритм, но эталонная реализация, которая за
восемь секунд успевает на два порядка меньше шагов поиска. Число,
снятое с одной реализации и объясняемое другой, ничего не стоит.
`improved` остался эталоном корректности — `selfcheck` сверяет с ним
`fast` шаг в шаг, — но не измерительным прибором.

**Бюджет задан в итерациях, а не в секундах.** Секунда — это про
задержку ответа, и она у каждой машины своя: на медленном ноутбуке
поиск успеет меньше и число выйдет другое. С фиксированным числом
итераций замер воспроизводится у любого, кто скачал репозиторий.
Сколько это в секундах — печатается тут же, отдельной строкой.
"""

from __future__ import annotations

import json
import multiprocessing as mp
import statistics
import sys
import time

from vrptw.core.generate import generate_day, day_stats
from vrptw.core.network import default_network
from vrptw.core.simulate import monte_carlo
from vrptw.solvers import fast, greedy, improved
from vrptw.core.domain import require_valid
from vrptw.stats import ci95

RUNS = 300

# Бюджет поиска в шагах LNS. 1500 — примерно то, что быстрая версия
# успевает за восемь секунд на двух ядрах; в секундах это печатается
# в шапке замера, но само число от машины не зависит.
LNS_ITERATIONS = 1500

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _one_day(seed: int) -> dict:
    day = generate_day(seed=seed, network=_net())

    plan_g = greedy.solve(day)
    require_valid(plan_g, day, f"жадный нарушил инварианты, seed {seed}")
    mc_g = monte_carlo(day, plan_g, runs=RUNS, seed=seed)

    params = improved.Params(lns_seconds=0.0,
                             lns_iterations=LNS_ITERATIONS)
    report: dict = {}
    t0 = time.time()
    plan_i = fast.solve(day, params=params, seed=seed, report=report)
    solve_seconds = time.time() - t0
    require_valid(plan_i, day, f"улучшенный нарушил инварианты, seed {seed}")
    mc_i = monte_carlo(day, plan_i, runs=RUNS, seed=seed)

    return {
        "seed": seed,
        "stats": day_stats(day),
        "greedy": {
            "assigned": plan_g.assigned_count,
            "done": mc_g.done_mean,
            "coverage": mc_g.coverage,
            "execution": mc_g.execution_rate,
            "p10": mc_g.done_p10, "p90": mc_g.done_p90, "sd": mc_g.done_sd,
            "reasons": mc_g.reasons_mean,
            "idle": mc_g.idle_mean,
            "overtime": mc_g.overtime_mean,
        },
        "improved": {
            "assigned": plan_i.assigned_count,
            "done": mc_i.done_mean,
            "coverage": mc_i.coverage,
            "execution": mc_i.execution_rate,
            "p10": mc_i.done_p10, "p90": mc_i.done_p90, "sd": mc_i.done_sd,
            "reasons": mc_i.reasons_mean,
            "idle": mc_i.idle_mean,
            "overtime": mc_i.overtime_mean,
            "fragile": mc_i.fragile[:3],
            "solve_seconds": solve_seconds,
            "iterations": report["iterations"],
        },
    }


def main():
    n_days = int(sys.argv[1]) if len(sys.argv) > 1 else 12
    seeds = list(range(1, n_days + 1))

    with mp.Pool(2) as pool:
        rows = pool.map(_one_day, seeds)

    secs = statistics.mean(r["improved"]["solve_seconds"] for r in rows)
    print(f"Парное сравнение на {n_days} днях, {RUNS} прогонов симуляции на день")
    print(f"LNS: {LNS_ITERATIONS} итераций на день — на этой машине "
          f"{secs:.1f} с, но число итераций одно у всех\n")
    print(f"{'день':>4} │ {'назначено':^13} │ {'выполнено':^15} │ {'покрытие':^15}")
    print(f"{'':>4} │ {'жадн':>5} {'улучш':>6} │ {'жадн':>6} {'улучш':>7} │ {'жадн':>6} {'улучш':>7}")
    print("─" * 62)

    deltas_cov, deltas_done, deltas_assigned = [], [], []
    for r in rows:
        g, i = r["greedy"], r["improved"]
        deltas_cov.append((i["coverage"] - g["coverage"]) * 100)
        deltas_done.append(i["done"] - g["done"])
        deltas_assigned.append(i["assigned"] - g["assigned"])
        print(f"{r['seed']:>4} │ {g['assigned']:>5} {i['assigned']:>6} │ "
              f"{g['done']:>6.1f} {i['done']:>7.1f} │ "
              f"{g['coverage']*100:>5.1f}% {i['coverage']*100:>6.1f}%")

    m_cov, h_cov = ci95(deltas_cov)
    m_done, h_done = ci95(deltas_done)
    m_asg, h_asg = ci95(deltas_assigned)

    print("─" * 62)
    print("\nРазница улучшенный − жадный (парная, 95% доверительный интервал):")
    print(f"  назначено заявок:  {m_asg:+.1f} ± {h_asg:.1f}")
    print(f"  выполнено визитов: {m_done:+.1f} ± {h_done:.1f}")
    print(f"  покрытие дня:      {m_cov:+.1f} ± {h_cov:.1f} п.п.")
    if m_cov - h_cov > 0:
        print("  → интервал не включает ноль: улучшение статистически значимо")
    else:
        print("  → интервал включает ноль: значимость не доказана")

    def avg(key, sub=None):
        vals = [r[key][sub] if sub else r[key] for r in rows]
        return statistics.mean(vals)

    def avg_reason(key, reason):
        return statistics.mean(r[key]["reasons"].get(reason, 0.0) for r in rows)

    print("\nСредние по всем дням:")
    print(f"{'':<22}{'жадный':>10}{'улучшенный':>13}")
    for label, key in [("назначено", "assigned"), ("выполнено", "done"),
                       ("простой, мин", "idle"), ("переработка, мин", "overtime")]:
        print(f"  {label:<20}{avg('greedy', key):>10.1f}{avg('improved', key):>13.1f}")
    print(f"  {'выполнение плана':<20}{avg('greedy','execution')*100:>9.1f}%{avg('improved','execution')*100:>12.1f}%")
    print(f"  {'покрытие дня':<20}{avg('greedy','coverage')*100:>9.1f}%{avg('improved','coverage')*100:>12.1f}%")
    print("\n  причины срыва:")
    for reason in ("missed_window", "no_show", "no_access", "dropped"):
        g, i = avg_reason("greedy", reason), avg_reason("improved", reason)
        if g or i:
            print(f"  {'  '+reason:<20}{g:>10.2f}{i:>13.2f}")

    with open("bench_results.json", "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False, indent=2, default=str)
    print("\nПодробности: bench_results.json")


if __name__ == "__main__":
    main()
