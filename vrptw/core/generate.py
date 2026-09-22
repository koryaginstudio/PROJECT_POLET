"""
Генератор синтетического рабочего дня.

Отдельно генерирует то, что видит планировщик (оценки, окна, SLA),
и скрытую истину, которую увидит только симулятор.
"""

from __future__ import annotations

import random

from .domain import DAY_START, Day, Engineer, Order, WORK_TYPES, equipment_for
from .geo import DISTRICTS
from .network import default_network

# Слоты выдачи абоненту. Реальные окна у домашнего интернета — 4 часа,
# премиальные — 2 часа.
SLOTS_4H = [(9 * 60, 13 * 60), (13 * 60, 17 * 60), (17 * 60, 21 * 60)]
SLOTS_2H = [(9 * 60, 11 * 60), (11 * 60, 13 * 60), (13 * 60, 15 * 60),
            (15 * 60, 17 * 60), (17 * 60, 19 * 60), (19 * 60, 21 * 60)]

WORK_WEIGHTS = {"install": 0.42, "repair": 0.28, "diag": 0.12, "cpe": 0.11, "line": 0.07}

ENGINEER_NAMES = [
    "Соколов", "Кузнецов", "Морозов", "Волков", "Лебедев", "Новиков",
    "Козлов", "Егоров", "Павлов", "Семёнов", "Голубев", "Виноградов",
    "Титов", "Крылов", "Никитин", "Осипов",
]


def generate_day(
    seed: int,
    n_orders: int = 80,
    n_engineers: int = 12,
    network=None,          # сеть: настоящая карта или синтетическая
    date: str = "2026-09-15",
) -> Day:
    rng = random.Random(seed)
    net = network or default_network()

    district_weights = [d[3] for d in DISTRICTS]

    # --- заявки ---
    orders: list[Order] = []
    codes = list(WORK_WEIGHTS)
    weights = [WORK_WEIGHTS[c] for c in codes]

    real_map = getattr(net, "has_addresses", False)

    for i in range(n_orders):
        name, dlat, dlon, _ = rng.choices(DISTRICTS, weights=district_weights)[0]
        if real_map:
            node, lat, lon, address = net.pick_address(name, rng)
        else:
            lat = dlat + rng.gauss(0, 0.012)
            lon = dlon + rng.gauss(0, 0.020)
            node, address = net.nearest_node(lat, lon), None

        code = rng.choices(codes, weights=weights)[0]
        wt = WORK_TYPES[code]

        # Окно: 25% узкие двухчасовые, остальные четырёхчасовые.
        if rng.random() < 0.25:
            w_start, w_end = rng.choice(SLOTS_2H)
        else:
            w_start, w_end = rng.choice(SLOTS_4H)

        # Приоритет: аварии и повторные визиты приходят с узким окном.
        if code == "repair" and rng.random() < 0.18:
            priority = 2
        elif rng.random() < 0.12:
            priority = 1
        else:
            priority = 0

        # SLA: ремонт — сутки от обращения, подключение — двое-трое суток.
        # Считаем от начала дня; отрицательного запаса не допускаем.
        if code in ("repair", "diag"):
            sla = w_end + rng.choice([0, 0, 60, 24 * 60])
        else:
            sla = w_end + rng.choice([0, 24 * 60, 48 * 60])

        est = wt.est_minutes
        # Оценка сама по себе шумная: диспетчер округляет.
        est = int(round(est * rng.uniform(0.9, 1.15) / 5) * 5)

        order = Order(
            id=f"R{i:04d}",
            work_type=code,
            district=name,
            lat=lat,
            lon=lon,
            node=node,
            address=address,
            window_start=w_start,
            window_end=w_end,
            sla_deadline=sla,
            priority=priority,
            est_minutes=est,
            # Не из `rng`: состав оборудования не должен сдвигать поток
            # случайных чисел, иначе все синтетические дни стали бы другими.
            equipment=equipment_for(f"R{i:04d}", code),
        )

        orders.append(order)

    # --- инженеры ---
    engineers: list[Engineer] = []
    skill_sets = [
        ({"install"}, 1), ({"install"}, 1), ({"install"}, 2), ({"install"}, 2),
        ({"install", "repair"}, 2), ({"install", "repair"}, 2),
        ({"repair"}, 2), ({"repair"}, 3),
        ({"repair", "line"}, 3), ({"install", "repair", "line"}, 3),
        ({"install", "line"}, 2), ({"install", "repair"}, 3),
        ({"install"}, 1), ({"repair"}, 2), ({"install", "repair"}, 2), ({"line"}, 3),
    ]

    for i in range(n_engineers):
        skills, grade = skill_sets[i % len(skill_sets)]
        # Дом инженера — случайный район, живут по всему городу.
        hname, hlat, hlon, _ = rng.choices(DISTRICTS, weights=district_weights)[0]
        if real_map:
            hnode, hlat, hlon, haddr = net.pick_address(hname, rng)
        else:
            hlat += rng.gauss(0, 0.01)
            hlon += rng.gauss(0, 0.015)
            hnode, haddr = net.nearest_node(hlat, hlon), None

        start = rng.choice([8 * 60, 8 * 60, 9 * 60, 9 * 60, 10 * 60])
        engineers.append(Engineer(
            id=f"E{i:02d}",
            name=ENGINEER_NAMES[i % len(ENGINEER_NAMES)],
            skills=set(skills),
            grade=grade,
            home_node=hnode,
            home_lat=hlat,
            home_lon=hlon,
            home_address=haddr,
            shift_start=start,
            shift_end=start + 9 * 60,
            # Опытный работает быстрее. Это скрытая истина.
            speed=round(rng.uniform(1.15, 1.30) - 0.12 * grade, 3),
        ))

    # Синтетический день зовут его зерном — тем же числом, каким его
    # просят у сервера.
    return Day(date=date, orders=orders, engineers=engineers, network=net,
               ident=str(seed))


def day_stats(day: Day) -> dict:
    """Сводка по дню — для проверки, что задача осмысленная."""
    import statistics

    est_total = sum(o.est_minutes for o in day.orders)
    capacity = sum(e.shift_end - e.shift_start for e in day.engineers)
    windows = [o.window_len() for o in day.orders]

    by_skill: dict[str, int] = {}
    for o in day.orders:
        by_skill[o.skill] = by_skill.get(o.skill, 0) + 1

    skill_capacity: dict[str, int] = {}
    for e in day.engineers:
        for s in e.skills:
            skill_capacity[s] = skill_capacity.get(s, 0) + 1

    return {
        "orders": len(day.orders),
        "engineers": len(day.engineers),
        "est_work_hours": round(est_total / 60, 1),
        "capacity_hours": round(capacity / 60, 1),
        "load_ratio": round(est_total / capacity, 2),
        "median_window_h": round(statistics.median(windows) / 60, 1),
        "orders_by_skill": by_skill,
        "engineers_by_skill": skill_capacity,
        "expected_no_show": round(
            sum(WORK_TYPES[o.work_type].no_show_rate for o in day.orders), 1),
    }
