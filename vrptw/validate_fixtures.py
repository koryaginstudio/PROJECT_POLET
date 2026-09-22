"""
Проверка выгруженных JSON на соответствие контракту.

Раздел «Что гарантируется» в CONTRACT.md — это обещание интерфейсу.
Обещание, которое никто не проверяет, рано или поздно перестаёт
выполняться, поэтому оно проверяется здесь.

Запуск: python3 -m vrptw.validate_fixtures fixtures
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCHEMA = "1.5"
# Граница суток по умолчанию. Настоящее значение берётся из
# `meta.hard_end` выгрузки: у синтетики 21:00, у данных заказчика 22:00.
DAY_HARD_END = 21 * 60


def check(path: Path) -> list[str]:
    bad: list[str] = []

    def load(name: str):
        f = path / name
        if not f.exists():
            bad.append(f"{name}: файла нет")
            return None
        return json.loads(f.read_text(encoding="utf-8"))

    plan = load("plan.json")
    explain = load("explain.json")
    sim = load("simulation.json")
    shifts = load("shifts.json")
    if plan is None:
        return bad

    for name, doc, kind in (("plan.json", plan, "plan"), ("explain.json", explain, "explain"),
                            ("simulation.json", sim, "simulation"), ("shifts.json", shifts, "shifts")):
        if doc is None:
            continue
        if doc.get("schema") != SCHEMA:
            bad.append(f"{name}: schema {doc.get('schema')!r}, ожидалась {SCHEMA!r}")
        if doc.get("kind") != kind:
            bad.append(f"{name}: kind {doc.get('kind')!r}, ожидался {kind!r}")

    # --- plan.json ---
    # Граница суток — из выгрузки; старые фикстуры её не несут.
    hard_end = plan["meta"].get("hard_end", DAY_HARD_END)

    orders = {o["id"]: o for o in plan["orders"]}
    if len(orders) != len(plan["orders"]):
        bad.append("plan: id заявок повторяются")

    eng_ids = {e["id"] for e in plan["engineers"]}
    engineers = {e["id"]: e for e in plan["engineers"]}

    for o in plan["orders"]:
        a = o["assigned_to"]
        if a is not None and a not in eng_ids:
            bad.append(f"plan: {o['id']} назначена несуществующему {a}")

    declared = set(plan["unassigned"])
    actual = {o["id"] for o in plan["orders"] if o["assigned_to"] is None}
    if declared != actual:
        bad.append(f"plan: unassigned не сходится с assigned_to "
                   f"(лишние {sorted(declared - actual)[:3]}, "
                   f"недостающие {sorted(actual - declared)[:3]})")

    seen_in_routes: set[str] = set()
    for route in plan["routes"]:
        eid = route["engineer_id"]
        if eid not in eng_ids:
            bad.append(f"plan: маршрут неизвестного инженера {eid}")
            continue
        eng = engineers[eid]
        prev_finish = None

        for i, s in enumerate(route["stops"]):
            oid = s["order_id"]
            if s["seq"] != i:
                bad.append(f"plan: {eid} остановка {i} имеет seq={s['seq']}")
            if oid in seen_in_routes:
                bad.append(f"plan: {oid} встречается в маршрутах дважды")
            seen_in_routes.add(oid)

            if oid not in orders:
                bad.append(f"plan: {eid} везёт неизвестную заявку {oid}")
                continue
            o = orders[oid]

            if o["assigned_to"] != eid:
                bad.append(f"plan: {oid} в маршруте {eid}, а assigned_to={o['assigned_to']}")
            if not (s["arrive"] <= s["start"] <= s["finish"]):
                bad.append(f"plan: {oid} времена не по порядку: "
                           f"{s['arrive']}/{s['start']}/{s['finish']}")
            if not (o["window_start"] <= s["start"] <= o["window_end"]):
                bad.append(f"plan: {oid} старт {s['start']} вне окна "
                           f"{o['window_start']}–{o['window_end']}")
            if s["finish"] > eng["shift_end"]:
                bad.append(f"plan: {oid} финиш {s['finish']} за сменой {eid}")
            if s["finish"] > hard_end:
                bad.append(f"plan: {oid} финиш {s['finish']} позже жёсткой "
                           f"границы дня {hard_end}")
            if prev_finish is not None and s["arrive"] < prev_finish:
                bad.append(f"plan: {eid} прибыл в {oid} раньше, чем закончил предыдущий")
            # Маршрут должен сходиться арифметически: выехал, ехал, приехал.
            depart = eng["shift_start"] if prev_finish is None else prev_finish
            if s["arrive"] != depart + s["travel_minutes"]:
                bad.append(f"plan: {oid} прибытие {s['arrive']} не сходится с выездом "
                           f"{depart} и дорогой {s['travel_minutes']}")
            if s["slack_minutes"] != o["window_end"] - s["start"]:
                bad.append(f"plan: {oid} slack_minutes не сходится")
            if s["risk"] not in ("low", "medium", "high"):
                bad.append(f"plan: {oid} risk={s['risk']!r}")
            if len(s["geometry"]) < 2:
                bad.append(f"plan: {oid} геометрия из {len(s['geometry'])} точек")
            prev_finish = s["finish"]

    if seen_in_routes != actual ^ set(orders):
        missing = set(orders) - seen_in_routes - actual
        if missing:
            bad.append(f"plan: заявки потеряны, ни в маршрутах, ни в unassigned: "
                       f"{sorted(missing)[:3]}")

    if plan["meta"]["orders_assigned"] != len(seen_in_routes):
        bad.append("plan: meta.orders_assigned не сходится с числом остановок")

    # Оборудование: у каждой заявки поле есть, выдача маршрута — сумма по
    # его остановкам, а если план строился с остатком в машинах, маршрут
    # в него укладывается.
    if any(not isinstance(o.get("equipment"), dict) for o in orders.values()):
        bad.append("plan: у заявки нет equipment или это не словарь")
    else:
        stock = (plan["meta"].get("equipment") or {}).get("stock")
        for r in plan["routes"]:
            need: dict = {}
            for s in r["stops"]:
                for k, n in orders[s["order_id"]]["equipment"].items():
                    need[k] = need.get(k, 0) + n
            if r["totals"].get("equipment") != need:
                bad.append(f"plan: {r['engineer_id']} totals.equipment не сходится "
                           f"с суммой по остановкам")
            if stock is not None:
                есть = stock.get(r["engineer_id"], {})
                if any(n > есть.get(k, 0) for k, n in need.items()):
                    bad.append(f"plan: {r['engineer_id']} везёт больше, чем в машине")

    # Занятость: доля смены на работу и дорогу, без ожидания окна.
    for r in plan["routes"]:
        t = r["totals"]
        eng = engineers[r["engineer_id"]]
        shift = eng["shift_end"] - eng["shift_start"]
        # Работа в итогах — та, что стоит в остановках, а не норматив.
        # Пока здесь сверялась только занятость с `work_minutes`, проверка
        # была тавтологией: оба числа брались из одного неверного места, и
        # при `duration_factor` = 2,0 сходились между собой на загрузке
        # вдвое меньше настоящей.
        по_остановкам = sum(s["finish"] - s["start"] for s in r["stops"])
        if t["work_minutes"] != по_остановкам:
            bad.append(f"plan: {r['engineer_id']} work_minutes "
                       f"{t['work_minutes']} не сходится с остановками "
                       f"({по_остановкам})")
        expected = round((t["work_minutes"] + t["travel_minutes"]) / shift, 3)
        if abs(t["occupancy"] - expected) > 1e-3:
            bad.append(f"plan: {r['engineer_id']} occupancy {t['occupancy']} "
                       f"не сходится с работой и дорогой ({expected})")
        if not (0.0 <= t["occupancy"] <= 1.5):
            bad.append(f"plan: {r['engineer_id']} occupancy вне диапазона")

    # Схема 1.3: обе обязательные метрики ТЗ и причины неназначения.
    m = plan["meta"].get("metrics")
    if m is None:
        bad.append("plan: в meta нет обязательных метрик ТЗ")
    else:
        used = sum(1 for r in plan["routes"] if r["totals"]["visits"] > 0)
        if m["engineers_used"] != used:
            bad.append(f"plan: engineers_used {m['engineers_used']} не сходится "
                       f"с числом непустых маршрутов ({used})")
        km = round(sum(r["totals"]["km"] for r in plan["routes"]), 2)
        if abs(m["km_total"] - km) > 0.05:
            bad.append(f"plan: km_total {m['km_total']} не сходится с суммой "
                       f"по маршрутам ({km})")
        for r in plan["routes"]:
            if r["totals"]["km"] < 0:
                bad.append(f"plan: {r['engineer_id']} отрицательный пробег")

    # Схема 1.4: сравнение с базовым вариантом — обязательное по ТЗ.
    base = plan["meta"].get("baseline")
    if base is None:
        bad.append("plan: в meta нет сравнения с базовым вариантом")
    else:
        for поле in ("assigned", "engineers_used", "km_total", "km_per_visit"):
            if поле not in base:
                bad.append(f"plan: в baseline нет поля {поле}")
        d = base.get("delta") or {}
        if m is not None and "assigned" in base:
            ожид = plan["meta"]["orders_assigned"] - base["assigned"]
            if d.get("assigned") != ожид:
                bad.append(f"plan: baseline.delta.assigned {d.get('assigned')} "
                           f"не сходится с планом ({ожид})")
        if base.get("assigned", 0) > plan["meta"]["orders_total"]:
            bad.append("plan: базовый вариант назначил больше заявок, чем есть")

    detail = plan.get("unassigned_detail")
    if detail is None:
        bad.append("plan: нет unassigned_detail с причинами неназначения")
    else:
        if {d["order_id"] for d in detail} != set(plan["unassigned"]):
            bad.append("plan: unassigned_detail не совпадает с unassigned")
        for d in detail:
            if not d.get("reason"):
                bad.append(f"plan: {d['order_id']} без причины неназначения")

    b = plan["meta"].get("balance")
    if b is None:
        bad.append("plan: в meta нет сводки по равномерности")
    elif not (0.0 <= b["gini"] <= 1.0):
        bad.append(f"plan: meta.balance.gini={b['gini']} вне [0, 1]")

    # --- explain.json ---
    if explain is not None:
        if set(explain["orders"]) != set(orders):
            bad.append("explain: набор заявок не совпадает с планом")
        allowed = {"chosen", "feasible", "no_room", "shift_mismatch", "no_skill",
                   "no_vehicle"}
        for oid, rec in explain["orders"].items():
            if rec["assigned_to"] != orders.get(oid, {}).get("assigned_to"):
                bad.append(f"explain: {oid} назначение расходится с планом")
            verdicts = [c["verdict"] for c in rec["candidates"]]
            unknown = set(verdicts) - allowed
            if unknown:
                bad.append(f"explain: {oid} неизвестные вердикты {unknown}")
            if {c["engineer_id"] for c in rec["candidates"]} != eng_ids:
                bad.append(f"explain: {oid} перечислены не все инженеры")
            chosen = verdicts.count("chosen")
            if rec["assigned_to"] and chosen != 1:
                bad.append(f"explain: {oid} ровно один chosen ожидался, найдено {chosen}")
            if not rec["assigned_to"] and chosen:
                bad.append(f"explain: {oid} не назначена, но есть chosen")

    # --- simulation.json ---
    if sim is not None:
        if sim["planned"] != len(seen_in_routes):
            bad.append("simulation: planned не сходится с планом")
        if sim["orders_total"] != len(orders):
            bad.append("simulation: orders_total не сходится с планом")
        d = sim["done"]
        if not (d["p10"] <= d["p50"] <= d["p90"]):
            bad.append("simulation: перцентили не по порядку")
        if not (0 <= sim["coverage"] <= 100):
            bad.append("simulation: coverage вне 0–100")
        if not (0 <= sim["breaches"] <= sim["must_today"]):
            bad.append(f"simulation: срывов {sim['breaches']} при "
                       f"{sim['must_today']} обязательствах")
        if sim["must_today"] > sim["orders_total"]:
            bad.append("simulation: обязательств больше, чем заявок в дне")
        if sim["done"]["mean"] > sim["planned"]:
            bad.append("simulation: выполнено больше, чем запланировано")
        for f in sim["fragile"]:
            if f["order_id"] not in orders:
                bad.append(f"simulation: хрупкая заявка {f['order_id']} не из этого дня")

    # --- shifts.json ---
    if shifts is not None:
        rec = shifts["recommended"]["starts_by_engineer"]
        if set(rec) != eng_ids:
            bad.append("shifts: starts_by_engineer перечисляет не тех инженеров")
        allowed_starts = set(shifts["meta"]["allowed_starts"])
        for eid, h in rec.items():
            if h not in allowed_starts:
                bad.append(f"shifts: {eid} выходит в {h}, это вне allowed_starts")
        prof_sum = sum(shifts["recommended"]["profile"].values())
        if prof_sum != len(eng_ids):
            bad.append(f"shifts: в профиле {prof_sum} человек, а инженеров {len(eng_ids)}")
        # Длина смены — из бригады, а не число в мете. Стояла девятка, а
        # у заказчика двое работают восемь часов; проверяем по плану, где
        # смены каждого инженера лежат как есть.
        разбивка = shifts["meta"].get("shift_hours_by_count")
        if not разбивка:
            bad.append("shifts: нет shift_hours_by_count — длину смены "
                       "нечем проверить")
        elif plan is not None:
            по_плану: dict[str, int] = {}
            for e in plan["engineers"]:
                ч = str(round((e["shift_end"] - e["shift_start"]) / 60, 1))
                по_плану[ч] = по_плану.get(ч, 0) + 1
            # Сравниваем числами, а не подписями: «9» и «9.0» это одна и
            # та же смена, и сторож, спотыкающийся о запись числа, ловил
            # бы не то, ради чего написан.
            как_числа = {float(ч): n for ч, n in разбивка.items()}
            if как_числа != {float(ч): n for ч, n in по_плану.items()}:
                bad.append(f"shifts: разбивка смен {разбивка} не сходится "
                           f"с бригадой в плане ({по_плану})")
            if float(shifts["meta"]["shift_hours"]) not in как_числа:
                bad.append(f"shifts: shift_hours "
                           f"{shifts['meta']['shift_hours']} — такой смены "
                           f"в бригаде нет")

        minutes = [c["minute"] for c in shifts["curve"]]
        if minutes != sorted(minutes):
            bad.append("shifts: точки кривой не по возрастанию времени")

    return bad


def main():
    path = Path(sys.argv[1] if len(sys.argv) > 1 else "fixtures")
    problems = check(path)
    if problems:
        print(f"✗ {path}: нарушений {len(problems)}")
        for p in problems[:20]:
            print("   ", p)
        sys.exit(1)
    print(f"✓ {path}: контракт соблюдён")


if __name__ == "__main__":
    main()
