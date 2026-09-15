"""
Быстрая самопроверка стенда — первое, что стоит запустить.

Проходит весь путь: граф, генерация дня, оба планировщика, проверка
инвариантов плана, симуляция, выгрузка для интерфейса и проверка
контракта. Около полутора минут вместо пятнадцати у полных замеров.

Если здесь всё зелёное — стенд собран правильно, и длинные замеры
можно запускать с доверием.

Запуск:  python3 -m vrptw.selfcheck
"""

from __future__ import annotations

import shutil
import sys
import tempfile
import time
from pathlib import Path

OK = "  ✓"
FAIL = "  ✗"

failures: list[str] = []


def step(title: str):
    print(f"\n{title}")


def ok(msg: str):
    print(f"{OK} {msg}")


def bad(msg: str):
    print(f"{FAIL} {msg}")
    failures.append(msg)


def _cascade_day(net):
    """
    День из двух заявок, на котором снятие визита ломает хвост маршрута.

    Выезд из дома в 8:57 попадает в утренний пик, выезд в 9:01 — уже нет,
    и та же дорога занимает на десять минут меньше. Поэтому короткий
    первый визит маршрут не задерживает, а спасает: без него инженер
    выезжает раньше и приезжает позже, чем закрывается окно второй
    заявки. Время в пути немонотонно по часу выезда — вот на чём это
    держится.

    На синтетическом дне такое не выпадает: 70 тысяч выбиваний и
    исчерпывающий перебор всех снятий не дали ни одного случая. Поэтому
    ветка каскада проверяется здесь, а не ждёт настоящих данных.
    """
    from .core.domain import Day, Engineer, Order

    shift_start = 8 * 60 + 57
    depart_after = shift_start + 4          # 3 минуты «последней мили» плюс визит на минуту

    # Узел, до которого разница между выездом в пик и сразу после него
    # больше, чем длится снятый визит.
    node = max(range(1, len(net.nodes)),
               key=lambda b: (net.travel_minutes(0, b, shift_start)
                              - net.travel_minutes(0, b, depart_after)))
    late = int(round(net.travel_minutes(0, node, depart_after)))

    def order(oid, at_node, window_end, est):
        return Order(id=oid, work_type="repair", district="—", lat=0.0, lon=0.0,
                     node=at_node, window_start=shift_start, window_end=window_end,
                     sla_deadline=22 * 60, priority=0, est_minutes=est)

    first = order("A0", 0, shift_start + 60, 1)
    # Окно второй заявки закрывается ровно в момент прибытия с первой.
    second = order("B0", node, depart_after + late, 30)
    eng = Engineer(id="E00", name="—", skills={"repair"}, grade=2, home_node=0,
                   home_lat=0.0, home_lon=0.0, shift_start=shift_start,
                   shift_end=20 * 60, speed=1.0)
    return Day(date="каскад", orders=[first, second], engineers=[eng], network=net)


def main() -> int:
    t_all = time.time()

    # --- 1. окружение ---
    step("1. Окружение")
    if sys.version_info < (3, 10):
        bad(f"нужен Python 3.10 или новее, у вас {sys.version.split()[0]}")
        return 1
    ok(f"Python {sys.version.split()[0]}")

    try:
        import numpy
        import scipy
        ok(f"numpy {numpy.__version__}, scipy {scipy.__version__}")
    except ImportError as e:
        bad(f"не хватает библиотеки: {e.name}. Поставьте: pip install numpy scipy")
        return 1

    # --- 2. дорожная сеть ---
    step("2. Дорожная сеть Москвы")
    t = time.time()
    from .core.network import default_network
    net = default_network()
    ok(f"{len(net.nodes)} узлов, матрицы времени по 14 часам — {time.time() - t:.1f} с")

    mid_day = net.travel_minutes(0, 200, 13 * 60)
    rush = net.travel_minutes(0, 200, 18 * 60)
    if rush > mid_day:
        ok(f"час пик учитывается: та же поездка 13:00 — {mid_day:.0f} мин, 18:00 — {rush:.0f} мин")
    else:
        bad(f"час пик не работает: 13:00 {mid_day:.0f} мин, 18:00 {rush:.0f} мин")

    # --- 3. день ---
    step("3. Синтетический день")
    from .core.generate import day_stats, generate_day
    day = generate_day(seed=1, network=net)
    st = day_stats(day)
    ok(f"{st['orders']} заявок, {st['engineers']} инженеров, "
       f"{st['est_work_hours']} ч работы на {st['capacity_hours']} ч смен")
    ok(f"навыки — заявок {st['orders_by_skill']}, инженеров {st['engineers_by_skill']}")

    leaked = [f for f in ("true_minutes", "true_no_show", "true_no_access")
              if hasattr(day.orders[0], f)]
    if leaked:
        bad(f"в заявке остались поля скрытой истины: {leaked} — планировщик может подглядеть")
    else:
        ok("скрытой истины в заявках нет: случайность разыгрывается в прогоне")

    # --- 4. планировщики ---
    step("4. Планировщики")
    from .solvers import fast, greedy, improved

    t = time.time()
    plan_g = greedy.solve(day)
    problems = plan_g.check_invariants(day)
    if problems:
        bad(f"жадный нарушил инварианты: {problems[:2]}")
    else:
        ok(f"жадный: назначено {plan_g.assigned_count} из 80, "
           f"инварианты чисты — {time.time() - t:.1f} с")

    t = time.time()
    # Бюджет в шагах, а не в секундах: иначе selfcheck печатает каждый раз
    # немного разные числа — на сколько успел поиск, зависит от того, чем
    # занята машина. С фиксированным числом шагов два прогона сравнимы
    # построчно, и расхождение сразу видно.
    params = improved.Params(lns_seconds=0.0, lns_iterations=900)
    plan_i = fast.solve(day, params=params, seed=1)
    problems = plan_i.check_invariants(day)
    if problems:
        bad(f"улучшенный нарушил инварианты: {problems[:2]}")
    else:
        ok(f"улучшенный: назначено {plan_i.assigned_count} из 80, "
           f"инварианты чисты — {time.time() - t:.1f} с")

    if plan_i.assigned_count <= plan_g.assigned_count:
        bad(f"улучшенный назначил не больше жадного "
            f"({plan_i.assigned_count} против {plan_g.assigned_count})")

    # Ускоренная версия обязана давать ровно то же, что медленная: иначе
    # все замеры меряют один солвер, а объясняются другим. Нулевых штрафов
    # для этого мало: продакшен считает с ненулевыми balance_weight и
    # churn_penalty, а они дольше всего прожили в одной реализации из двух.
    # Якорь берём из жадного плана — он детерминирован, поэтому расхождение
    # воспроизводится тем же запуском, а не «иногда».
    def seq_of(plan):
        return {e: [v.order.id for v in r.visits] for e, r in plan.routes.items()}

    anchor = {v.order.id: eid for eid, r in plan_g.routes.items() for v in r.visits}
    cases = [
        ("без штрафов", {}),
        ("штраф за неравномерность", {"balance_weight": improved.BALANCE_WEIGHT}),
        ("штраф за смену исполнителя", {"anchor": anchor, "churn_penalty": 40.0}),
        ("оба штрафа сразу", {"balance_weight": improved.BALANCE_WEIGHT,
                              "anchor": anchor, "churn_penalty": 40.0}),
    ]

    diverged, inert = [], []
    reference = None
    for label, extra in cases:
        slow = improved.Params(lns_seconds=0.0, **extra)
        seq_ref = seq_of(improved.solve(day, params=slow, seed=1))
        seq_new = seq_of(fast.solve(day, params=slow, seed=1))
        if seq_ref != seq_new:
            diverged.append(label)
        if reference is None:
            reference = seq_ref
        elif seq_ref == reference:
            inert.append(label)

    if diverged:
        bad(f"конструкция разошлась между реализациями "
            f"({', '.join(diverged)}) — замеры и объяснения относятся "
            f"к разным алгоритмам")
    else:
        ok(f"конструкция плана совпадает визит в визит "
           f"на {len(cases)} наборах параметров")

    # Сверка на параметре, который ничего не меняет, ничего и не проверяет:
    # план обязан отличаться от плана без штрафов, иначе строчка выше
    # зелёная просто потому, что штраф не дошёл ни до одной реализации.
    if inert:
        bad(f"план не меняется от штрафа ({', '.join(inert)}) — "
            f"сверка на нём вырождена")

    # Нулевой бюджет проверяет только конструктор. Весь цикл поиска —
    # выбивание, пересборка, инкрементальные префиксы — до сих пор не
    # сверялся ничем: по секундам это невозможно, быстрая версия успевает
    # на два порядка больше шагов. С бюджетом в итерациях обе делают
    # одинаковое число шагов, и сверяется алгоритм целиком.
    # День меньше основного: на нём те же ветки поиска стоят вчетверо
    # дешевле, а медленная реализация тут — обычная эталонная, не быстрая.
    small = generate_day(seed=4, n_orders=40, n_engineers=6, network=net)
    small_anchor = {v.order.id: eid
                    for eid, r in greedy.solve(small).routes.items() for v in r.visits}
    ITERS = 25
    lns_diverged = []
    for label, extra in [
        ("без штрафов", {}),
        ("штраф за неравномерность", {"balance_weight": improved.BALANCE_WEIGHT}),
        ("штраф за смену исполнителя",
         {"anchor": small_anchor, "churn_penalty": 40.0}),
        ("оба штрафа сразу", {"balance_weight": improved.BALANCE_WEIGHT,
                              "anchor": small_anchor, "churn_penalty": 40.0}),
    ]:
        p_lns = improved.Params(lns_seconds=0.0,
                                lns_iterations=ITERS, **extra)
        rep_ref, rep_new = {}, {}
        a = improved.solve(small, params=p_lns, seed=4, report=rep_ref)
        b = fast.solve(small, params=p_lns, seed=4, report=rep_new)
        # Кроме плана сверяется и значение целевой функции. Одним планом
        # мелкий численный дрейф в инкрементальных префиксах не поймать:
        # он меняет стоимость, но не порядок вставок, и план выходит тот
        # же. Порядок сложения у двух реализаций разный, поэтому равенство
        # тут не побитовое, а с допуском — но допуск на восемь порядков
        # меньше самой дешёвой вставки.
        obj_ref, obj_new = rep_ref["objective"], rep_new["objective"]
        if (seq_of(a) != seq_of(b)
                or rep_ref["accepted"] != rep_new["accepted"]
                or rep_ref["iterations"] != rep_new["iterations"]
                or obj_ref[0] != obj_new[0]
                or abs(obj_ref[1] - obj_new[1]) > 1e-6):
            lns_diverged.append(label)

    if lns_diverged:
        bad(f"поиск разошёлся между реализациями ({', '.join(lns_diverged)}) — "
            f"инкрементальные пересчёты в fast.py считают не то же самое")
    else:
        ok(f"поиск совпадает шаг в шаг: {ITERS} итераций LNS, те же принятые "
           f"ходы, та же целевая функция, 4 набора параметров")

    # Выбивание заявки может утащить за собой соседей: без неё инженер
    # выезжает раньше, попадает в час пик и приезжает позже, чем
    # закрывается окно следующей заявки. На синтетическом дне это не
    # случается ни разу — ветка живёт страховкой, и потому не проверена
    # ничем. Проверяем на дне, построенном ровно под этот случай.
    casc = _cascade_day(net)
    ref_state = improved._State(casc, improved.Params(lns_seconds=0.0))
    ref_state.seq["E00"] = list(casc.orders)
    evicted_ref = ref_state.remove(casc.orders[0])

    new_sol = fast._Solution(casc, improved.Params(lns_seconds=0.0))
    new_sol.routes["E00"].seq = list(casc.orders)
    new_sol.routes["E00"].rebuild()
    evicted_new = new_sol.routes["E00"].remove(casc.orders[0])

    ids_ref = [o.id for o in evicted_ref]
    ids_new = [o.id for o in evicted_new]
    if ids_ref != ["B0"] or ids_new != ["B0"]:
        bad(f"каскадное выбивание отработало не так: медленная {ids_ref}, "
            f"быстрая {ids_new}, ожидалось ['B0'] у обеих")
    elif ref_state.seq["E00"] or new_sol.routes["E00"].seq:
        bad("после каскада в маршруте остались визиты, которых там быть не должно")
    else:
        ok("каскад при выбивании: обе реализации одинаково утащили соседа")

    # --- 4б. равномерность загрузки ---
    from .diagnose import balance

    flat = fast.solve(day, params=improved.Params(
        lns_seconds=0.0, lns_iterations=900,
        balance_weight=improved.BALANCE_WEIGHT), seed=1)
    b0, b1 = balance(day, plan_i), balance(day, flat)
    if b1["occupancy_gini"] > b0["occupancy_gini"] + 1e-9:
        bad(f"штраф за неравномерность не выравнивает загрузку: "
            f"Джини {b0['occupancy_gini']:.3f} → {b1['occupancy_gini']:.3f}")
    else:
        ok(f"загрузка выравнивается: Джини {b0['occupancy_gini']:.3f} → "
           f"{b1['occupancy_gini']:.3f}, занятость "
           f"{b1['occupancy_min'] * 100:.0f}–{b1['occupancy_max'] * 100:.0f}% "
           f"(назначено {flat.assigned_count} против {plan_i.assigned_count})")

    # --- 5. симуляция ---
    step("5. Симуляция дня (300 прогонов)")
    from .core.simulate import monte_carlo

    t = time.time()
    mc_g = monte_carlo(day, plan_g, runs=300, seed=1)
    mc_i = monte_carlo(day, plan_i, runs=300, seed=1)
    ok(f"два прогона по 300 симуляций — {time.time() - t:.1f} с")

    print(f"\n      {'':<22}{'жадный':>10}{'улучшенный':>13}")
    print(f"      {'назначено':<22}{plan_g.assigned_count:>10}{plan_i.assigned_count:>13}")
    print(f"      {'выполнено':<22}{mc_g.done_mean:>10.1f}{mc_i.done_mean:>13.1f}")
    print(f"      {'покрытие дня':<22}{mc_g.coverage * 100:>9.1f}%{mc_i.coverage * 100:>12.1f}%")
    print(f"      {'срывов по окну':<22}"
          f"{mc_g.reasons_mean.get('missed_window', 0):>10.2f}"
          f"{mc_i.reasons_mean.get('missed_window', 0):>13.2f}")
    print()

    if mc_i.coverage <= mc_g.coverage:
        bad("улучшенный не обогнал жадный по покрытию — это ненормально")
    else:
        ok(f"улучшенный впереди на {(mc_i.coverage - mc_g.coverage) * 100:.1f} п.п. "
           f"(на одном дне; значимость даёт bench на 12 днях)")

    if mc_i.done_sd < 1.0:
        bad(f"разброс подозрительно мал (sd {mc_i.done_sd:.2f}): "
            f"похоже, случайность разыгрывается не в каждом прогоне")
    else:
        ok(f"разброс живой: sd {mc_i.done_sd:.2f}, p10 {mc_i.done_p10} … p90 {mc_i.done_p90}")

    top = mc_i.fragile[0] if mc_i.fragile else None
    if top and top[1] > 0.95:
        bad(f"визит {top[0]} срывается в {top[1] * 100:.0f}% прогонов — "
            f"признак предзаписанной случайности")
    elif top:
        ok(f"самый хрупкий визит {top[0]} срывается в {top[1] * 100:.0f}% прогонов")

    # --- 6. подбор смен ---
    step("6. Подбор смен (только прокси, без долгой доводки)")
    from .shiftopt import apply, optimize

    t = time.time()
    sp = optimize(day, restarts=6, seed=1)
    tuned = apply(day, sp.starts)
    plan_t = fast.solve(tuned, params=params, seed=1)
    mc_t = monte_carlo(tuned, plan_t, runs=200, seed=1)
    ok(f"подобрано за {time.time() - t:.1f} с: {sp.describe()}")
    ok(f"покрытие {mc_i.coverage * 100:.1f}% → {mc_t.coverage * 100:.1f}% "
       f"только за счёт графика выхода")

    # --- 7. выбытие инженера посреди дня ---
    step("7. Инженер выбыл посреди дня")
    import random as _random

    from .replan import apply_dropout, carve_remainder, simulate_until

    st = simulate_until(day, plan_i, 13 * 60, _random.Random(1))
    busy = sorted(e for e, ids in st.pending.items() if ids)
    if not busy:
        bad("к 13:00 ни у кого не осталось работы — проверять нечего")
    else:
        gone = busy[0]
        whole = carve_remainder(day, st)
        pool = {o.id for o in whole.orders}

        # Полное выбытие: инженера нет, а его заявки остались в пуле.
        maimed = apply_dropout(whole, gone, None)
        lost = [o for o in st.pending[gone] if o not in pool]
        if any(e.id == gone for e in maimed.engineers):
            bad(f"{gone} выбыл, но остался в списке инженеров")
        elif lost:
            bad(f"заявки выбывшего пропали из пула, а не осели в нём: {lost[:3]}")
        else:
            anchor = {oid: eid for eid, ids in st.pending.items()
                      for oid in ids if eid != gone}
            p = fast.solve(maimed, params=improved.Params(
                lns_seconds=1.0, anchor=anchor,
                churn_penalty=40.0), seed=1)
            problems = p.check_invariants(maimed)
            picked = sum(1 for r in p.routes.values() for v in r.visits
                         if v.order.id in set(st.pending[gone]))
            if problems:
                bad(f"план после выбытия невалиден: {problems[:2]}")
            elif gone in p.routes:
                bad(f"выбывшему {gone} всё равно назначили визиты")
            else:
                ok(f"{gone} выбыл с {len(st.pending[gone])} визитами впереди, "
                   f"{picked} из них подхватили остальные, план валиден")

        # Прокол: инженер на месте, но следующий визит только через 40 минут.
        was = {e.id: e.shift_start for e in whole.engineers}[gone]
        flat = apply_dropout(whole, gone, 40)
        now = {e.id: e.shift_start for e in flat.engineers}[gone]
        p2 = fast.solve(flat, params=improved.Params(
            lns_seconds=1.0), seed=1)
        if now <= was and now != {e.id: e.shift_end for e in flat.engineers}[gone]:
            bad(f"прокол не сдвинул начало смены: было {was}, стало {now}")
        elif p2.check_invariants(flat):
            bad(f"план после прокола невалиден: {p2.check_invariants(flat)[:2]}")
        else:
            ok(f"после прокола {gone} продолжает с {now // 60:02d}:{now % 60:02d} "
               f"оттуда, где встал; план валиден")

    # --- 8. выгрузка и контракт ---
    step("8. Выгрузка для интерфейса")
    tmp = Path(tempfile.mkdtemp(prefix="vrptw_check_"))
    try:
        t = time.time()
        from .export import export_day
        sizes = export_day(seed=1, out_dir=str(tmp), runs=200,
                           lns_seconds=3.0, tune_shifts=False)
        ok(f"четыре формы за {time.time() - t:.1f} с: " +
           ", ".join(f"{n} {s // 1024} КБ" for n, s in sizes.items()))

        from .validate_fixtures import check
        problems = check(tmp)
        if problems:
            bad(f"контракт нарушен ({len(problems)}): {problems[:2]}")
        else:
            ok("контракт соблюдён: заявки не теряются, окна и смены не нарушены, "
               "explain и simulation сходятся с планом")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- итог ---
    print("\n" + "─" * 62)
    if failures:
        print(f"✗ Проблем: {len(failures)}")
        for f in failures:
            print(f"    {f}")
        return 1

    print(f"✓ Стенд собран правильно. Всё заняло {time.time() - t_all:.0f} с.")
    print("\n  Дальше можно запускать длинные замеры — см. README, раздел «Запуск».")
    return 0


if __name__ == "__main__":
    sys.exit(main())
