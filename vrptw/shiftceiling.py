"""
Сколько мы теряем на прокси.

Подбор по непокрытому спросу не отличим от веера, заданного руками
(+1,1 ± 1,4 п.п.). Два возможных объяснения, и они требуют разных
действий:

  · прокси недобирает — тогда есть смысл его уточнять (география,
    навыки, пересчёт спроса с учётом дороги);
  · подобранное уже у потолка — тогда уточнять нечего, и следующий
    выигрыш лежит вообще не здесь.

Различить их можно, продолжив поиск от прокси-решения, но оценивая
шаги настоящим солвером с симуляцией. Если он находит заметно лучшее
расписание — прокси недобирает.

Поиск ведётся на одном наборе прогонов симуляции, а найденное
проверяется на другом: иначе улучшение окажется подгонкой под
конкретные случайные числа.
"""

from __future__ import annotations

import multiprocessing as mp
import statistics

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import monte_carlo
from .shiftopt import allowed_starts, apply, optimize
from .solvers import fast, improved

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _coverage(day, solver_seed: int, sim_seed: int, secs: float = 2.5) -> float:
    plan = fast.solve(day, params=improved.Params(lns_seconds=secs),
                      seed=solver_seed)
    return monte_carlo(day, plan, runs=150, seed=sim_seed).coverage * 100


def _probe(args):
    """Одна пробная перестановка: оценить расписание настоящим солвером."""
    seed, starts, sim_seed = args
    base = generate_day(seed=seed, network=_net())
    return _coverage(apply(base, starts), seed, sim_seed)


def climb(seed: int, rounds: int = 2) -> dict:
    """Локальный подъём от прокси-решения по настоящей метрике."""
    base = generate_day(seed=seed, network=_net())
    starts = list(optimize(base, restarts=12, seed=seed).starts)
    # Часы выхода считаются от границы дня, а не берутся константой:
    # у синтетики это прежние [7…12], но на дне заказчика граница 22:00,
    # и зашитый список молча обрезал бы поздние смены.
    часы = allowed_starts(base)

    search_sim, holdout_sim = seed, seed + 500

    start_score = _probe((seed, starts, search_sim))
    best = start_score

    with mp.Pool(2) as pool:
        for _ in range(rounds):
            improved_any = False
            for i in range(len(starts)):
                cands = []
                for h in часы:
                    if h == starts[i]:
                        continue
                    trial = list(starts)
                    trial[i] = h
                    cands.append(trial)

                scores = pool.map(_probe, [(seed, c, search_sim) for c in cands])
                j = max(range(len(scores)), key=lambda k: scores[k])
                if scores[j] > best + 0.3:
                    best = scores[j]
                    starts = cands[j]
                    improved_any = True
            if not improved_any:
                break

    return {
        "seed": seed,
        "proxy_search": start_score,
        "climbed_search": best,
        "proxy_holdout": _probe((seed, list(optimize(base, restarts=12, seed=seed).starts), holdout_sim)),
        "climbed_holdout": _probe((seed, starts, holdout_sim)),
    }


def main():
    rows = [climb(s) for s in (1, 3, 9)]

    print("Подъём по настоящей метрике от прокси-решения\n")
    print(f"{'день':>4} │ {'прокси':>8} {'после подъёма':>14} │ {'то же на другой симуляции':>26}")
    print("─" * 66)
    for r in rows:
        print(f"{r['seed']:>4} │ {r['proxy_search']:>7.1f}% {r['climbed_search']:>13.1f}% │ "
              f"{r['proxy_holdout']:>11.1f}% → {r['climbed_holdout']:>7.1f}%")

    gain_search = statistics.mean(r["climbed_search"] - r["proxy_search"] for r in rows)
    gain_hold = statistics.mean(r["climbed_holdout"] - r["proxy_holdout"] for r in rows)

    print("─" * 66)
    print(f"  прирост на поисковых прогонах:  {gain_search:+.1f} п.п.")
    print(f"  он же на независимых прогонах:  {gain_hold:+.1f} п.п.")
    print()
    if gain_hold > 1.5:
        print("  → прокси недобирает: есть смысл его уточнять")
    elif gain_search > 1.5:
        print("  → прирост не переносится на другие прогоны: это подгонка под шум,")
        print("    прокси у потолка")
    else:
        print("  → подъём ничего не нашёл: прокси у потолка, выигрыш не здесь")


if __name__ == "__main__":
    main()
