"""
Инженер выбыл посреди дня.

Прокол колеса, машина в сервис, человек слёг. Это случается на порядок
чаще аварийной заявки, и болит сильнее: у выбывшего впереди несколько
визитов с окнами и допусками, а свободных рук в бригаде нет — день и так
не резиновый.

Два сценария:

  выбыл       до конца дня — бригада уменьшилась на человека;
  прокол      вернётся через 40 минут и поедет дальше оттуда, где встал.

Сравниваем с тем, что было бы без пересчёта: остальные едут по прежнему
плану, визиты выбывшего просто не состоятся (а при проколе — состоятся
те, в окна которых он ещё попадает после починки).

Считать «выбыл и не пересчитали» против «выбыл и пересчитали» в лоб
нельзя: в эту разницу попадает не только спасение визитов выбывшего, но
и обычная польза от переоптимизации маршрутов всех остальных, которая
есть и без всякого выбытия. Поэтому веток четыре — с выбытием и без,
с пересчётом и без:

              не пересчитываем   пересчитываем
  никто не выбыл        A               B
  инженер выбыл         C               D

Отсюда два разных вопроса, которые легко перепутать:

  D−C            «инженер выбыл — жать кнопку пересчёта или нет?»
                 Это то, что решает диспетчер, и в отчёте это главное.
  (A−C)−(B−D)    «насколько пересчёт компенсирует именно потерю
                 инженера — сверх той пользы, которую он приносит и без
                 всякого ЧП?» Вопрос аналитика: величина может быть
                 нулевой или отрицательной при том, что D−C уверенно
                 положительно. Это не противоречие: пересчёт помогает,
                 просто помогает он не только из-за выбытия.

Все четыре ветки идут по одной случайной траектории дня: одинаковые
пробки, неявки и задержки до момента выбытия.

Ключевая метрика здесь не одна, а две, и вторая важнее, чем кажется:
сколько визитов удалось спасти — и **скольким непричастным инженерам
пришлось за это переиграть маршрут**. Спасти всё, разворошив бригаду
целиком, диспетчеру не нужно: людям уже позвонили.
"""

from __future__ import annotations

import copy
import multiprocessing as mp
import random
import statistics
import sys
import time
from collections import defaultdict

from .stats import ci95

from .core.generate import generate_day
from .core.network import default_network
from .core.simulate import simulate_once
from .replan import (apply_dropout, carve_remainder, morning_kit, plan_as_is,
                     simulate_until, stability, stock_left)
from .solvers import fast, improved
from .core.domain import require_valid

TIMES = [10 * 60, 13 * 60, 16 * 60]
SEEDS = list(range(1, 7))
RUNS = 8
SOLVER_SECONDS = 1.5
CHURN_PENALTY = 40.0
REPAIR_MINUTES = 40

_NET = None


def _net():
    global _NET
    if _NET is None:
        _NET = default_network()
    return _NET


def _hhmm(minutes: int) -> str:
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _ci(values: list[float]) -> tuple[float, float]:
    """Среднее и половина 95% интервала — по t, парно по дням.

    Прежде здесь стояло 1,96: при шести днях это занижало интервал в
    2,571 / 1,96 ≈ 1,31 раза (круг 21 сентября, «+3,2 ± 1,3» — на деле ±1,7).
    """
    return ci95(values)


def _one(args) -> dict:
    seed, at, back_after = args
    day = generate_day(seed=seed, network=_net())
    plan = fast.solve(day, params=improved.Params(lns_seconds=4.0),
                      seed=seed)

    acc: dict[str, list] = defaultdict(list)

    for r in range(RUNS):
        st = simulate_until(day, plan, at, random.Random(seed * 1000 + r))

        # Выбывает случайный из тех, у кого впереди ещё есть работа:
        # прокол не выбирает самый загруженный фургон.
        pool = sorted(eng for eng, ids in st.pending.items() if ids)
        if not pool:
            continue
        dropped = random.Random(seed * 331 + r).choice(pool)
        his = set(st.pending[dropped])

        whole = carve_remainder(day, st)
        maimed = apply_dropout(whole, dropped, back_after)

        # Якорь: кому заявка была назначена до выбытия. Заявки выбывшего
        # из якоря исключаются — держаться за исполнителя, которого нет,
        # значит штрафовать любую попытку их пристроить.
        anchor = {oid: eid for eid, ids in st.pending.items() for oid in ids}
        anchor_maimed = {oid: eid for oid, eid in anchor.items()
                         if not (back_after is None and eid == dropped)}

        # Оборудование в машинах — как в сервере: иначе замер мерил бы
        # другой пересчёт, чем тот, что едет на показ.
        запас = stock_left(morning_kit(day, plan), st, day)

        def replan(rest, anc):
            t0 = time.time()
            p = fast.solve(rest, params=improved.Params(
                lns_seconds=SOLVER_SECONDS,
                anchor=anc, churn_penalty=CHURN_PENALTY, stock=запас), seed=seed)
            require_valid(p, rest)
            return p, time.time() - t0

        def played(rest, p):
            out = simulate_once(rest, p, random.Random(seed * 90_000 + r))
            done = {v.order_id for v in out.visits if v.status == "done"}
            return len(st.done) + out.done, len(done & his)

        plan_d, secs = replan(maimed, anchor_maimed)
        plan_b, _ = replan(whole, anchor)

        # Базисы «как ехали» проверяются инвариантами наравне с
        # пересчётами: раньше это были единственные планы замера без
        # проверки, и пешеход в них ходил дальше предела.
        as_is_whole = plan_as_is(whole, st)
        require_valid(as_is_whole, whole)
        as_is_maimed = plan_as_is(maimed, st)
        require_valid(as_is_maimed, maimed)

        a_total, a_his = played(whole, as_is_whole)               # A
        b_total, b_his = played(whole, plan_b)                    # B
        c_total, c_his = played(maimed, as_is_maimed)             # C
        d_total, d_his = played(maimed, plan_d)                   # D

        # Стабильность считаем только по тем, кто ни при чём: визиты
        # выбывшего обязаны сменить исполнителя, ставить это в упрёк
        # пересчёту нечестно.
        others = copy.copy(st)
        others.pending = {e: ids for e, ids in st.pending.items() if e != dropped}

        acc["ahead"].append(len(his))
        acc["a_total"].append(a_total)
        acc["b_total"].append(b_total)
        acc["c_total"].append(c_total)
        acc["d_total"].append(d_total)
        acc["c_his"].append(c_his)
        acc["d_his"].append(d_his)
        acc["stab"].append(stability(plan, plan_d, others))
        acc["solve_seconds"].append(secs)

    row = {k: statistics.mean(v) for k, v in acc.items()}
    row.update(seed=seed, at=at, n=len(acc["ahead"]),
               orders=len(day.orders))
    return row


def _report(back_after: int | None):
    title = ("Инженер выбыл до конца дня" if back_after is None
             else f"Прокол: инженер возвращается через {back_after} минут")
    jobs = [(s, at, back_after) for at in TIMES for s in SEEDS]

    with mp.Pool(2) as pool:
        rows = [r for r in pool.map(_one, jobs) if r["n"]]

    print(f"{title}\n")
    print(f"{len(SEEDS)} дней × {RUNS} прогонов, бюджет пересчёта {SOLVER_SECONDS} с, "
          f"выбывает случайный инженер с незакрытой работой\n")

    print("Инженер выбыл: жать пересчёт или ехать как ехали?"
          "  (визитов за день, парно по дням, 95%, по t)\n")
    print(f"{'момент':<9}{'у него впереди':>16}{'как ехали':>12}{'пересчёт':>11}"
          f"{'разница':>17}{'его визитов':>14}{'стабильн.':>12}")
    print("─" * 92)

    summary = []
    for at in TIMES:
        sub = [r for r in rows if r["at"] == at]
        ahead = statistics.mean(r["ahead"] for r in sub)
        c = statistics.mean(r["c_total"] for r in sub)
        d = statistics.mean(r["d_total"] for r in sub)
        m_g, h_g = _ci([r["d_total"] - r["c_total"] for r in sub])
        m_h, _ = _ci([r["d_his"] - r["c_his"] for r in sub])
        stab = statistics.mean(r["stab"] for r in sub)
        print(f"{_hhmm(at):<9}{ahead:>16.1f}{c:>12.1f}{d:>11.1f}"
              f"{m_g:>+12.1f} ± {h_g:<4.1f}{m_h:>+14.1f}{stab * 100:>11.0f}%")
        summary.append((at, sub))
    print("─" * 92)
    print("«его визитов» — сколько визитов выбывшего подхватили остальные.")
    print("«стабильность» — доля визитов НЕ выбывших инженеров, сохранивших "
          "исполнителя.")

    print("\n\nВо что обходится само выбытие, и что из этого лечит пересчёт\n")
    print(f"{'момент':<9}{'цена без пересчёта':>20}{'цена с пересчётом':>20}"
          f"{'компенсировано':>19}")
    print("─" * 68)
    for at, sub in summary:
        loss_a = statistics.mean(r["a_total"] - r["c_total"] for r in sub)
        loss_b = statistics.mean(r["b_total"] - r["d_total"] for r in sub)
        m_s, h_s = _ci([(r["a_total"] - r["c_total"]) - (r["b_total"] - r["d_total"])
                        for r in sub])
        print(f"{_hhmm(at):<9}{-loss_a:>+20.1f}{-loss_b:>+20.1f}"
              f"{m_s:>+13.1f} ± {h_s:<4.1f}")
    print("─" * 68)
    print("Это уже не про кнопку: здесь пересчёт включён в обеих ветках, и")
    print("меряется, насколько он гасит именно потерю инженера. Ноль здесь")
    print("не значит «пересчёт бесполезен» — см. таблицу выше.")

    secs = statistics.mean(r["solve_seconds"] for r in rows)
    print(f"\nвремя реакции: {secs:.2f} с")


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "out"
    _report(REPAIR_MINUTES if mode == "flat" else None)
