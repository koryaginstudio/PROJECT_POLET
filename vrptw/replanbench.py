"""
Что даёт пересчёт внутри дня и сколько стоит промедление.

В 13:40 приходят две аварии: окно открывается немедленно и длится три
часа. Четыре способа ответить, от худшего к лучшему:

  как ехали   не пересчитываем вовсе — аварии уезжают на завтра;
  через час   пересчёт в ближайшем часовом окне, как у батчевых систем;
  через 20 м  пересчёт в следующем двадцатиминутном батче;
  сразу       пересчёт по факту поступления.

Все варианты идут по одной и той же случайной траектории дня —
одинаковые пробки, неявки и задержки. Различается только момент, когда
планировщик узнаёт об авариях, и узнаёт ли вообще.
"""

from __future__ import annotations

import multiprocessing as mp
import random
import statistics
import sys
import time

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import simulate_once
from .replan import (carve_remainder, morning_kit, plan_as_is, simulate_until,
                     stability, stock_left,
                     urgent_orders)
from .solvers import fast, improved
from .core.domain import require_valid
from .stats import ci95

EVENT_AT = 13 * 60 + 40
DELAYS = [0, 20, 60]
N_URGENT = 2
RUNS = 15
SOLVER_SECONDS = 1.5

# Штраф за смену исполнителя при пересчёте. На 40 стабильность выходит
# на плато (88%), и платить за неё не приходится ничем — см. режим churn.
CHURN_PENALTY = 40.0

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _one_day(args) -> dict:
    seed, secs = args
    day = generate_day(seed=seed, network=_net())
    plan = fast.solve(day, params=improved.Params(lns_seconds=4.0),
                      seed=seed)
    urgent = urgent_orders(day, EVENT_AT, N_URGENT, seed)
    urgent_ids = {o.id for o in urgent}
    kit = morning_kit(day, plan)

    acc: dict[str, list] = {"as_is_all": [], "solve_seconds": []}
    for d in DELAYS:
        acc[f"d{d}_all"] = []
        acc[f"d{d}_urgent"] = []
        acc[f"d{d}_stab"] = []

    for r in range(RUNS):
        def rest_rng():
            return random.Random(seed * 90_000 + r)

        def traj():
            return random.Random(seed * 1000 + r)

        # --- не пересчитываем ---
        st = simulate_until(day, plan, EVENT_AT, traj())
        rest = carve_remainder(day, st)
        # Базис «как ехали» проходит те же инварианты, что и пересчёт.
        as_is = plan_as_is(rest, st)
        require_valid(as_is, rest)
        out = simulate_once(rest, as_is, rest_rng())
        acc["as_is_all"].append(len(st.done) + out.done)

        # --- пересчёт с разной задержкой ---
        for d in DELAYS:
            at = EVENT_AT + d
            st_d = st if d == 0 else simulate_until(day, plan, at, traj())
            rest_d = carve_remainder(day, st_d, extra=urgent)

            anchor = {oid: eid for eid, ids in st_d.pending.items() for oid in ids}
            t0 = time.time()
            plan_d = fast.solve(rest_d, params=improved.Params(
                lns_seconds=secs,
                anchor=anchor, churn_penalty=CHURN_PENALTY,
                stock=stock_left(kit, st_d, day)), seed=seed)
            if d == 0:
                acc["solve_seconds"].append(time.time() - t0)
            require_valid(plan_d, rest_d)

            out = simulate_once(rest_d, plan_d, rest_rng())
            done_urgent = sum(1 for v in out.visits
                              if v.status == "done" and v.order_id in urgent_ids)
            acc[f"d{d}_all"].append(len(st_d.done) + out.done)
            acc[f"d{d}_urgent"].append(done_urgent)
            acc[f"d{d}_stab"].append(stability(plan, plan_d, st_d))

    res = {k: statistics.mean(v) for k, v in acc.items() if v}
    res["seed"] = seed
    res["orders"] = len(day.orders) + N_URGENT
    return res


def main():
    seeds = list(range(1, 7))
    with mp.Pool(2) as pool:
        rows = pool.map(_one_day, [(s, SOLVER_SECONDS) for s in seeds])

    def avg(key):
        return statistics.mean(r[key] for r in rows)

    total = avg("orders")
    print(f"Две аварии в 13:40, окно открыто немедленно, на три часа")
    print(f"{len(seeds)} дней × {RUNS} прогонов, бюджет пересчёта {SOLVER_SECONDS} с\n")
    print(f"{'реакция':<14}{'выполнено':>11}{'из 2 аварий':>13}{'покрытие':>11}{'стабильность':>14}")
    print("─" * 64)
    print(f"{'нет вовсе':<14}{avg('as_is_all'):>11.1f}{0.0:>13.2f}"
          f"{avg('as_is_all') / total * 100:>10.1f}%{'—':>14}")
    labels = {0: "сразу", 20: "через 20 мин", 60: "через час"}
    for d in DELAYS:
        print(f"{labels[d]:<14}{avg(f'd{d}_all'):>11.1f}{avg(f'd{d}_urgent'):>13.2f}"
              f"{avg(f'd{d}_all') / total * 100:>10.1f}%"
              f"{avg(f'd{d}_stab') * 100:>13.0f}%")
    print("─" * 64)

    # Интервалы — парно по дням, по t: прогоны одного дня делят план и
    # зерно солвера и независимыми единицами не считаются.
    def пара(a, b=None):
        return ci95([r[a] - (r[b] if b else 0.0) for r in rows])

    ав, ав_h = пара("d0_urgent")
    вс, вс_h = пара("d0_all", "as_is_all")
    ав60, ав60_h = пара("d0_urgent", "d60_urgent")
    вс60, вс60_h = пара("d0_all", "d60_all")
    print(f"\nпересчёт против его отсутствия: аварий {ав:+.2f} ± {ав_h:.2f}, "
          f"всего визитов {вс:+.2f} ± {вс_h:.2f}")
    print(f"сразу против часа промедления:  аварий {ав60:+.2f} ± {ав60_h:.2f}, "
          f"всего визитов {вс60:+.2f} ± {вс60_h:.2f}")
    print(f"(парно по {len(rows)} дням, 95%, по t с {len(rows) - 1} степенями свободы)")
    print(f"\nвремя реакции: {avg('solve_seconds'):.2f} с")


def _churn_day(args) -> dict:
    """Один день при заданном штрафе за переназначение."""
    seed, penalty = args
    day = generate_day(seed=seed, network=_net())
    plan = fast.solve(day, params=improved.Params(lns_seconds=4.0),
                      seed=seed)
    urgent = urgent_orders(day, EVENT_AT, N_URGENT, seed)
    urgent_ids = {o.id for o in urgent}

    all_done, urg_done, stab = [], [], []
    for r in range(10):
        st = simulate_until(day, plan, EVENT_AT, random.Random(seed * 1000 + r))
        rest = carve_remainder(day, st, extra=urgent)

        # Якорь: кому заявка была назначена до пересчёта.
        anchor = {oid: eid for eid, ids in st.pending.items() for oid in ids}
        # Оборудование в машинах — как в сервере: иначе замер мерил бы
        # другой пересчёт, чем тот, что едет на показ.
        params = improved.Params(lns_seconds=SOLVER_SECONDS,
                                 anchor=anchor, churn_penalty=penalty,
                                 stock=stock_left(morning_kit(day, plan), st, day))

        new_plan = fast.solve(rest, params=params, seed=seed)
        require_valid(new_plan, rest)
        out = simulate_once(rest, new_plan, random.Random(seed * 90_000 + r))

        all_done.append(len(st.done) + out.done)
        urg_done.append(sum(1 for v in out.visits
                            if v.status == "done" and v.order_id in urgent_ids))
        stab.append(stability(plan, new_plan, st))

    return {"all": statistics.mean(all_done), "urgent": statistics.mean(urg_done),
            "stab": statistics.mean(stab)}


def churn():
    """Сколько стабильности можно купить и чем за неё платим."""
    seeds = list(range(1, 7))
    print("Штраф за смену исполнителя при пересчёте\n")
    print(f"{'штраф':>7}{'стабильность':>15}{'выполнено':>12}{'из 2 аварий':>14}")
    print("─" * 48)
    for penalty in (0.0, 15.0, 40.0, 100.0, 250.0):
        with mp.Pool(2) as pool:
            rows = pool.map(_churn_day, [(s, penalty) for s in seeds])
        print(f"{penalty:>7.0f}{statistics.mean(r['stab'] for r in rows) * 100:>14.0f}%"
              f"{statistics.mean(r['all'] for r in rows):>12.1f}"
              f"{statistics.mean(r['urgent'] for r in rows):>14.2f}")


def budget():
    """Сколько качества теряется, если считать быстрее."""
    seeds = list(range(1, 5))
    print("Качество пересчёта против отведённого времени\n")
    print(f"{'бюджет':>9}{'аварий':>10}{'всего':>9}{'стабильность':>15}")
    for secs in (0.3, 0.8, 1.5, 4.0):
        with mp.Pool(2) as pool:
            rows = pool.map(_one_day, [(s, secs) for s in seeds])
        print(f"{secs:>8.1f}с{statistics.mean(r['d0_urgent'] for r in rows):>10.2f}"
              f"{statistics.mean(r['d0_all'] for r in rows):>9.1f}"
              f"{statistics.mean(r['d0_stab'] for r in rows) * 100:>14.0f}%")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "main"
    if mode == "budget":
        budget()
    elif mode == "churn":
        churn()
    else:
        main()
