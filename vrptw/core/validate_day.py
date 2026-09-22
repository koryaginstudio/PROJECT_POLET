"""
Пригоден ли день к планированию.

Пятнадцатого сентября `generate.py` заменится на загрузчик настоящих
заявок. Солвер и симулятор трогать не нужно — но только если то, что
загрузчик вернул, действительно похоже на рабочий день. Молчаливо
неверный `Day` не падает: он планируется, даёт покрытие 30% и часы
разбирательств, почему «алгоритм стал хуже».

Поэтому здесь проверяется не формат файла — формата мы пока не знаем и
угадывать его не собираемся, — а сам `Day`: то единственное, во что
обязан превратиться любой источник данных.

Три уровня. **Поломки** — с таким днём работать нельзя, планировщик
выдаст ерунду или упадёт. **Предупреждения** — день посчитается, но
что-то в нём странное и стоит перепроверить. **Сводка** — то, что полезно
прочитать глазами перед первым запуском: во что упирается день.

    python3 -m vrptw.core.validate_day        проверить синтетический день
"""

from __future__ import annotations

from collections import Counter

from .domain import DAY_HARD_END, WORK_TYPES, Day

# Ниже этого отношения работы к ёмкости день слишком лёгкий, чтобы на нём
# что-то мерить: любой планировщик разместит всё.
LOAD_TOO_LIGHT = 0.35
# Выше — заведомо невыполнимый, и покрытие будет говорить о нехватке рук,
# а не о качестве плана.
LOAD_TOO_HEAVY = 3.0


def check(day: Day, навык_без_владельца: str = "поломка"
          ) -> tuple[list[str], list[str]]:
    """Возвращает (поломки, предупреждения). Пустые списки — день годен.

    `навык_без_владельца` — куда класть «навыком X не владеет никто». В
    выгрузке заказчика это поломка: планировать день, часть которого
    некому взять, бессмысленно, и лучше отказаться сразу.

    А вот когда заявку ввёл диспетчер и сам назвал вид работ, которым в
    этой смене никто не владеет, — это не поломка дня, а **настоящий
    ответ**, и ТЗ просит показать его причиной неназначения. Такой день
    обязан спланироваться, заявка — остаться в `unassigned_detail` с
    внятной фразой. Поэтому журнальный путь передаёт «предупреждение».
    """
    if навык_без_владельца not in ("поломка", "предупреждение"):
        raise ValueError(f"навык_без_владельца: {навык_без_владельца!r}")
    bad: list[str] = []
    warn: list[str] = []
    net = day.network

    if not day.orders:
        bad.append("в дне нет ни одной заявки")
    if not day.engineers:
        bad.append("в дне нет ни одного инженера")
    if bad:
        return bad, warn

    # --- заявки ---
    ids = Counter(o.id for o in day.orders)
    dup = [i for i, n in ids.items() if n > 1]
    if dup:
        bad.append(f"повторяющиеся номера заявок: {sorted(dup)[:5]}")

    n_nodes = len(net.nodes)
    # Про заявку с неизвестным видом работ нельзя спросить навык: свойство
    # лезет в справочник и падает. Проверяльщик, который падает на том,
    # что сам забраковал, бесполезен — поэтому такие заявки отмечаем и
    # дальше о навыках не спрашиваем.
    typed_ok = True
    for o in day.orders:
        if o.work_type not in WORK_TYPES:
            bad.append(f"{o.id}: вид работ {o.work_type!r} не из справочника")
            typed_ok = False
        if o.window_end <= o.window_start:
            bad.append(f"{o.id}: окно {o.window_start}–{o.window_end} пустое")
        if o.est_minutes <= 0:
            bad.append(f"{o.id}: длительность {o.est_minutes} минут")
        if not 0 <= o.node < n_nodes:
            bad.append(f"{o.id}: узел {o.node} вне дорожной сети")
        if o.window_end > day.hard_end:
            warn.append(f"{o.id}: окно закрывается в {o.window_end} — "
                        f"позже жёсткой границы дня {day.hard_end}")
        if o.sla_deadline < o.window_start:
            warn.append(f"{o.id}: срок по SLA раньше начала окна")
        if o.est_minutes > o.window_len():
            warn.append(f"{o.id}: работа на {o.est_minutes} минут "
                        f"в окно {o.window_len()} минут — не влезет никогда")
    if len(bad) > 12:
        bad = bad[:12] + [f"…и ещё {len(bad) - 12} того же рода"]

    # --- инженеры ---
    eng_ids = Counter(e.id for e in day.engineers)
    dup_e = [i for i, n in eng_ids.items() if n > 1]
    if dup_e:
        bad.append(f"повторяющиеся номера инженеров: {sorted(dup_e)[:5]}")
    for e in day.engineers:
        if e.shift_end <= e.shift_start:
            bad.append(f"{e.id}: смена {e.shift_start}–{e.shift_end} пустая")
        if not e.skills:
            warn.append(f"{e.id}: ни одного навыка — он никому не пригодится")
        if not 0 <= e.home_node < n_nodes:
            bad.append(f"{e.id}: дом в узле {e.home_node} вне дорожной сети")
        if e.shift_end > day.hard_end:
            bad.append(f"{e.id}: смена кончается в {e.shift_end}, "
                       f"позже жёсткой границы дня {day.hard_end}")

    # --- сходятся ли заявки с бригадой ---
    if not typed_ok:
        bad.append("про навыки сказать нечего, пока есть заявки "
                   "с неизвестным видом работ")
        return bad, warn

    need = Counter(o.skill for o in day.orders)
    have = Counter(s for e in day.engineers for s in e.skills)
    куда = bad if навык_без_владельца == "поломка" else warn
    for skill, n in need.items():
        if not have.get(skill):
            куда.append(f"навыком «{skill}» не владеет никто, "
                        f"а он нужен {n} заявкам")

    covered = 0
    for o in day.orders:
        if any(e.can_do(o) and e.shift_start < o.window_end
               and e.shift_end > o.window_start for e in day.engineers):
            covered += 1
    if covered == 0:
        bad.append("ни одну заявку некому взять: окна не пересекаются со сменами")
    elif covered < len(day.orders) * 0.5:
        warn.append(f"больше половины заявок ({len(day.orders) - covered} из "
                    f"{len(day.orders)}) некому взять — проверьте смены и навыки")

    work = sum(o.est_minutes for o in day.orders)
    capacity = sum(e.shift_end - e.shift_start for e in day.engineers)
    ratio = work / capacity if capacity else 0.0
    if ratio < LOAD_TOO_LIGHT:
        warn.append(f"работы всего {ratio:.2f} от ёмкости смен — день слишком "
                    f"лёгкий, на нём не видно разницы между планировщиками")
    elif ratio > LOAD_TOO_HEAVY:
        warn.append(f"работы {ratio:.2f} от ёмкости смен — покрытие будет "
                    f"говорить о нехватке рук, а не о качестве плана")

    return bad, warn


def summary(day: Day) -> dict:
    """Во что упирается день. Читать глазами перед первым запуском."""
    work = sum(o.est_minutes for o in day.orders)
    capacity = sum(e.shift_end - e.shift_start for e in day.engineers)
    must = sum(1 for o in day.orders if o.must_today)

    by_slot: Counter = Counter()
    for o in day.orders:
        by_slot[(o.window_start // 60, o.window_end // 60)] += o.est_minutes

    tight = []
    for a, b in sorted({(s, e) for s, e in by_slot}):
        need = sum(v for (x, y), v in by_slot.items() if x >= a and y <= b)
        cap = sum(max(0, min(e.shift_end, b * 60) - max(e.shift_start, a * 60))
                  for e in day.engineers)
        if cap and need / cap > 1.2:
            tight.append((f"{a:02d}–{b:02d}", round(need / 60, 1), round(cap / 60, 1)))

    return {
        "orders": len(day.orders),
        "engineers": len(day.engineers),
        "work_hours": round(work / 60, 1),
        "capacity_hours": round(capacity / 60, 1),
        "load_ratio": round(work / capacity, 2) if capacity else 0.0,
        "must_today": must,
        "skills_needed": dict(Counter(o.skill for o in day.orders)),
        "skills_available": dict(Counter(s for e in day.engineers for s in e.skills)),
        "tight_windows": tight,
    }


def report(day: Day) -> str:
    """Готовый текст: годен ли день и во что упирается."""
    bad, warn = check(day)
    s = summary(day)
    lines = []

    if bad:
        lines.append(f"✗ День не годен к планированию, поломок {len(bad)}:")
        lines += [f"    {b}" for b in bad[:12]]
    else:
        lines.append("✓ День годен к планированию")
    if warn:
        lines.append(f"\n  Предупреждений {len(warn)} (посчитается, но проверьте):")
        lines += [f"    {w}" for w in warn[:10]]
        if len(warn) > 10:
            lines.append(f"    …и ещё {len(warn) - 10}")

    lines.append("")
    lines.append(f"  заявок {s['orders']}, инженеров {s['engineers']}")
    lines.append(f"  работы {s['work_hours']} ч на {s['capacity_hours']} ч смен "
                 f"(отношение {s['load_ratio']})")
    lines.append(f"  обязательств на сегодня: {s['must_today']} из {s['orders']}")
    lines.append(f"  навыки — нужно {s['skills_needed']}, есть {s['skills_available']}")
    if s["tight_windows"]:
        lines.append("  узкие места по времени (работы больше, чем смен):")
        for slot, need, cap in s["tight_windows"]:
            lines.append(f"    {slot}: {need} ч работы против {cap} ч смен")
    return "\n".join(lines)


if __name__ == "__main__":
    from .generate import generate_day
    from .network import default_network

    print(report(generate_day(seed=1, network=default_network())))
