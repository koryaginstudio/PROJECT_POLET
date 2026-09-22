"""
Обязательства перед абонентом: сколько мы их срываем и чем за это платим.

У каждой заявки есть срок по SLA. Половина дня — заявки, которые нельзя
отложить на завтра: срок истекает раньше, чем кончится рабочий день.
Остальные можно, и «не поехали сегодня» для них не срыв, а перенос.

До сих пор планировщик не различал эти две группы вовсе. Он максимизирует
число визитов, а заказчик считает нарушенные обещания. Заявка, которую
можно было отложить, и заявка, по которой сегодня истекает срок, стоили
для него одинаково.

Здесь меряется, что даёт разделение. `Params.sla_weight` — во сколько раз
несделанное обязательство дороже переноса; единица означает прежнее
поведение. Замер парный по дням: один и тот же день, один и тот же набор
прогонов симуляции, разница считается по каждому дню отдельно.

Главный вопрос не «стало ли меньше срывов» — он очевиден, — а **чем за
это платит покрытие**. Если защита обязательств стоит визитов, это надо
знать и предъявить, а не спрятать.

    python3 -m vrptw.slabench            вес против срывов и покрытия
    python3 -m vrptw.slabench heldout    выбранный вес на незнакомых днях
"""

from __future__ import annotations

import multiprocessing as mp
import random
import statistics
import sys

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import simulate_once
from .solvers import fast, improved
from .stats import ci95
from .core.domain import require_valid

WEIGHTS = [1.0, 1.5, 2.0, 3.0, 5.0]
LNS_ITERATIONS = 1500
RUNS = 200

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _one(args) -> tuple:
    seed, weight = args
    day = generate_day(seed=seed, network=_net())
    plan = fast.solve(day, params=improved.Params(
        lns_seconds=0.0, lns_iterations=LNS_ITERATIONS, sla_weight=weight), seed=seed)
    require_valid(plan, day, f"план невалиден, день {seed}")

    must = {o.id for o in day.orders if o.must_today}
    free = {o.id for o in day.orders} - must

    breaches, done_free, done_all = [], [], []
    for run in range(RUNS):
        out = simulate_once(day, plan, random.Random(seed * 1000 + run))
        done = {v.order_id for v in out.visits if v.status == "done"}
        breaches.append(len(must - done))
        done_free.append(len(free & done))
        done_all.append(out.done)

    return (weight, seed,
            statistics.mean(breaches),
            statistics.mean(done_all) / len(day.orders) * 100,
            statistics.mean(done_free),
            plan.assigned_count,
            len(must),
            # Сколько заявок в дне. Нужно знаменателем ниже: на синтетике
            # это 80, а на зоне заказчика 68 (205 на три участка), и
            # зашитая восьмидесятка превращала «обязательны все» в
            # «68 из 80» — то есть единственный файл, которым мы
            # подтверждаем «sla_weight здесь ничего не делает»,
            # утверждал обратное.
            len(day.orders))


# Интервал — общий, по t (`vrptw/stats.py`): здесь стоял свой, по 1,96.


def _table(rows, seeds, weights, title):
    by: dict = {}
    for w, seed, br, cov, fr, asg, must, всего_заявок in rows:
        by.setdefault(w, {})[seed] = (br, cov, fr, asg, must, всего_заявок)

    base = by[1.0]
    n_must = statistics.mean(v[4] for v in base.values())
    print(f"{title}\n")
    всего = statistics.mean(v[5] for v in base.values())
    print(f"  обязательств на сегодня: {n_must:.0f} из {всего:.0f} заявок в день\n")
    print(f"  {'вес':>5}{'срывов':>9}{'покрытие':>11}{'назначено':>11}"
          f"   срывов к весу 1      покрытие к весу 1")
    print("  " + "─" * 76)
    for w in weights:
        d = by[w]
        br = statistics.mean(v[0] for v in d.values())
        cov = statistics.mean(v[1] for v in d.values())
        asg = statistics.mean(v[3] for v in d.values())
        if w == 1.0:
            tail = f"{'— (опорный)':>21}{'':>23}"
        else:
            mb, hb = ci95([d[s][0] - base[s][0] for s in seeds])
            mc, hc = ci95([d[s][1] - base[s][1] for s in seeds])
            tail = f"{mb:>+13.2f} ± {hb:.2f}{mc:>+15.2f} ± {hc:.2f} п.п."
        print(f"  {w:>5.1f}{br:>9.1f}{cov:>10.1f}%{asg:>11.1f}   {tail}")
    print("  " + "─" * 76)
    return by


def main():
    seeds = list(range(1, 13))
    with mp.Pool(2) as pool:
        rows = pool.map(_one, [(s, w) for w in WEIGHTS for s in seeds])
    by = _table(rows, seeds, WEIGHTS,
                f"Вес обязательства против срывов и покрытия "
                f"({len(seeds)} дней × {RUNS} прогонов)")

    base = by[1.0]
    print("\nЧто это значит:")
    for w in WEIGHTS[1:]:
        d = by[w]
        mb, hb = ci95([d[s][0] - base[s][0] for s in seeds])
        mc, hc = ci95([d[s][1] - base[s][1] for s in seeds])
        verdict = ("срывов меньше, покрытие не пострадало" if mb + hb < 0 and mc + hc > 0
                   else "срывов меньше, но покрытие просело" if mb + hb < 0
                   else "разницы нет")
        print(f"  вес {w:>3.1f}: {verdict}")


def heldout(weight: float = 2.0):
    """Выбранный вес на днях, которых при подборе не было."""
    seeds = list(range(13, 31))
    with mp.Pool(2) as pool:
        rows = pool.map(_one, [(s, w) for w in (1.0, weight) for s in seeds])
    _table(rows, seeds, [1.0, weight],
           f"Held-out: дни 13–30 ({len(seeds)} дней), при подборе не использовались")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "heldout":
        heldout(float(sys.argv[2]) if len(sys.argv) > 2 else 2.0)
    else:
        main()
