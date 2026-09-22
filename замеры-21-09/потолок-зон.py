"""Есть ли запас над нашим планом на данных заказчика — круг 21 сентября.

Копия `замеры-15-09/потолок-зон.py` с одной правкой: приоритет
распределения выключен и здесь. 21 сентября он вошёл в цель
(`562fa71`), а этот скрипт его не пришпиливал — и «наш как MILP»
максимизировал бы уже взвешенное несделанное, а не число визитов, то
есть решал бы не ту задачу, что точная модель. Так же, как
`optimumbench`, ставим все три веса в единицу.


MILP максимизирует просто число визитов, поэтому и наш солвер ставится в
тот же режим: без буфера, без выравнивания, без веса обязательств и без
уровня «меньше людей». Иначе сравнивались бы решения разных задач.

Рядом печатается и продакшен-план — тот, что реально поедет на демо.
"""
import sys, time
from vrptw.core.load import load_day
from vrptw.optimum import solve_exact, freeze
from vrptw.solvers import fast, improved

ЛИМИТ = float(sys.argv[1]) if len(sys.argv) > 1 else 300.0
ЧИСТО = improved.Params(buffer_step=0.0, balance_weight=0.0, sla_weight=1.0,
                        vehicle_weight=0.0, priority_weights=(1.0, 1.0, 1.0),
                        lns_seconds=0.0, lns_iterations=4000)
БОЕВОЙ = improved.Params(lns_seconds=0.0, lns_iterations=1500)

print(f"{'зона':13}{'заявок':>7}{'наш (как MILP)':>16}{'HiGHS':>8}"
      f"{'граница':>9}{'разрыв':>8}  доказан   сек")
print("─" * 78)
for з in ('югоцентр', 'восток', 'юго-восток'):
    d = load_day(з, quiet=True)
    наш = fast.solve(d, params=ЧИСТО, seed=0)
    assert not наш.check_invariants(d)
    t0 = time.time()
    r = solve_exact(freeze(d), time_limit=ЛИМИТ)
    сек = time.time() - t0
    разрыв = (r.bound - наш.assigned_count) / r.bound * 100 if r.bound else 0.0
    print(f"{з:13}{len(d.orders):>7}{наш.assigned_count:>16}{r.assigned:>8}"
          f"{r.bound:>9.1f}{разрыв:>7.1f}%  {'да' if r.proven else 'нет':>6}  {сек:>6.0f}")
    боевой = fast.solve(d, params=БОЕВОЙ, seed=0)
    m = боевой.metrics(d)
    print(f"{'':13}боевой план: {m['assigned']} заявок, {m['engineers_used']} инж, "
          f"{m['km_total']:.0f} км")
