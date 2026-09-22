"""
Где стена по размеру дня.

Все основные замеры сделаны на восьмидесяти заявках. `stress` проверяет,
что выводы держатся до двухсот сорока. Но настоящих заявок у выездной
службы города может быть и пятьсот, и тысяча, а масштаб мы узнаем только
15 сентября — и хорошо бы к этому моменту знать, где предел, а не
выяснять его в тот же день.

Меряется не покрытие само по себе — на разных размерах оно и не должно
совпадать, — а три вещи:

  · **сколько шагов поиска успевает солвер за отведённые восемь секунд.**
    Таблица сходимости говорит, что результат выходит на плато после
    двухсот. Размер, на котором двести шагов перестают укладываться в
    бюджет, и есть стена;
  · **сколько стоит первая сборка плана.** Regret-вставка квадратична по
    числу заявок, и на больших днях она может съесть весь бюджет ещё до
    того, как начнётся улучшение;
  · **держится ли преимущество над жадным.** Если на тысяче заявок оно
    исчезает, значит выводы были свойством размера.

Сеть строится под координаты самого дня — те же настоящие дороги, только
точки свои. Снимать масштаб на пуле из шестисот адресов нельзя: на
пятистах заявках половина оказалась бы в одном доме, и замер соврал бы в
нашу пользу. Матрица считается один раз на день и кэшируется; для больших
размеров нужен свой OSRM, см. `core/osm.py`.

    python3 -m vrptw.scalebench             размеры до 600 заявок
    python3 -m vrptw.scalebench 80,240,500  свои размеры
"""

from __future__ import annotations

import random
import statistics
import sys
import time

from .core.domain import Day, Engineer, Order, WORK_TYPES
from .core.geo import DISTRICTS
from .core.osm import network_for_points
from .core.simulate import monte_carlo
from .core.validate_day import check
from .solvers import fast, greedy, improved
from .core.domain import require_valid

SIZES = [80, 240, 400, 600]
SEEDS = [1, 2]
LNS_SECONDS = 8.0
RUNS = 100

# Пропорция та же, что в основной конфигурации: 6,7 заявки на инженера.
ORDERS_PER_ENGINEER = 6.7

# После скольки шагов результат перестаёт улучшаться — из таблицы
# сходимости (`validate converge`). Ниже этого бюджет перестаёт хватать.
PLATEAU_STEPS = 200

SLOTS = [(9 * 60, 13 * 60), (13 * 60, 17 * 60), (17 * 60, 21 * 60)]
WORK_WEIGHTS = {"install": 0.42, "repair": 0.28, "diag": 0.12, "cpe": 0.11, "line": 0.07}
SKILL_SETS = [{"install"}, {"repair"}, {"install", "repair"},
              {"repair", "line"}, {"install", "line"}]


def big_day(n_orders: int, seed: int) -> Day:
    """День любого размера на настоящих дорогах, с сетью под его точки."""
    rng = random.Random(seed * 7 + n_orders)
    n_eng = max(1, round(n_orders / ORDERS_PER_ENGINEER))
    weights = [d[3] for d in DISTRICTS]

    def spot():
        d = rng.choices(DISTRICTS, weights=weights)[0]
        return (round(d[1] + rng.gauss(0, 0.012), 6),
                round(d[2] + rng.gauss(0, 0.020), 6))

    order_pts = [spot() for _ in range(n_orders)]
    home_pts = [spot() for _ in range(n_eng)]
    net = network_for_points(order_pts + home_pts, quiet=True)

    codes = list(WORK_WEIGHTS)
    ww = [WORK_WEIGHTS[c] for c in codes]
    orders = []
    for i, (la, lo) in enumerate(order_pts):
        code = rng.choices(codes, weights=ww)[0]
        ws, we = rng.choice(SLOTS)
        est = int(round(WORK_TYPES[code].est_minutes * rng.uniform(0.9, 1.15) / 5) * 5)
        orders.append(Order(
            id=f"S{i:05d}", work_type=code, district="—", lat=la, lon=lo,
            node=net.nearest_node(la, lo), address=None,
            window_start=ws, window_end=we,
            sla_deadline=we + rng.choice([0, 0, 24 * 60]),
            priority=2 if rng.random() < 0.05 else 0, est_minutes=est))

    engineers = []
    for i, (la, lo) in enumerate(home_pts):
        start = rng.choice([8 * 60, 9 * 60, 10 * 60, 11 * 60, 12 * 60])
        engineers.append(Engineer(
            id=f"E{i:03d}", name=f"И{i}", skills=set(SKILL_SETS[i % len(SKILL_SETS)]),
            grade=2, home_node=net.nearest_node(la, lo), home_lat=la, home_lon=lo,
            shift_start=start, shift_end=start + 9 * 60,
            speed=round(rng.uniform(0.9, 1.1), 3)))

    return Day(date="масштаб", orders=orders, engineers=engineers, network=net)


def measure(n_orders: int, seed: int) -> dict:
    day = big_day(n_orders, seed)
    broken, _ = check(day)
    assert not broken, f"день {n_orders}/{seed} не годен: {broken[:2]}"

    plan_g = greedy.solve(day)
    require_valid(plan_g, day)

    # Первая сборка плана — сколько стоит она одна, без улучшения.
    t0 = time.time()
    fast.solve(day, params=improved.Params(lns_seconds=0.0), seed=seed)
    build_seconds = time.time() - t0

    report: dict = {}
    t0 = time.time()
    plan = fast.solve(day, params=improved.Params(lns_seconds=LNS_SECONDS),
                      seed=seed, report=report)
    total_seconds = time.time() - t0
    require_valid(plan, day)

    mc_g = monte_carlo(day, plan_g, runs=RUNS, seed=seed)
    mc = monte_carlo(day, plan, runs=RUNS, seed=seed)
    return {
        "n": n_orders, "m": len(day.engineers), "seed": seed,
        "greedy": mc_g.coverage * 100, "ours": mc.coverage * 100,
        "build_seconds": build_seconds,
        "steps": report["iterations"],
        "steps_per_second": report["iterations"] / max(total_seconds - build_seconds, 1e-9),
    }


def main(sizes: list[int]) -> None:
    print(f"Размер дня против бюджета поиска "
          f"({len(SEEDS)} дня на размер, {LNS_SECONDS:.0f} с на план)\n")
    print(f"{'заявок/инж':>12}{'жадный':>9}{'наш':>8}{'разница':>9}"
          f"{'сборка':>9}{'шагов':>8}{'шагов/с':>9}   бюджет")
    print("─" * 79)
    wall = None
    for n in sizes:
        rows = [measure(n, s) for s in SEEDS]
        g = statistics.mean(r["greedy"] for r in rows)
        o = statistics.mean(r["ours"] for r in rows)
        build = statistics.mean(r["build_seconds"] for r in rows)
        steps = statistics.mean(r["steps"] for r in rows)
        sps = statistics.mean(r["steps_per_second"] for r in rows)
        enough = steps >= PLATEAU_STEPS
        if not enough and wall is None:
            wall = n
        size = f"{n}/{rows[0]['m']}"
        print(f"{size:>12}{g:>8.1f}%{o:>7.1f}%{o - g:>+8.1f}"
              f"{build:>8.1f}с{steps:>8.0f}{sps:>9.1f}   "
              f"{'хватает' if enough else 'НЕ ХВАТАЕТ'}")
    print("─" * 79)
    print(f"\nПлато сходимости — {PLATEAU_STEPS} шагов: дальше результат не растёт.")
    if wall:
        print(f"Начиная с {wall} заявок восьми секунд на это уже не хватает.")
    else:
        print("На всех проверенных размерах бюджета хватает.")


if __name__ == "__main__":
    sizes = ([int(x) for x in sys.argv[1].split(",")]
             if len(sys.argv) > 1 else SIZES)
    main(sizes)
