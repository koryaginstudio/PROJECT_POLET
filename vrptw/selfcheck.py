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

import json
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


# Отпечаток потока аварий на московском пуле и на синтетической сети —
# снят на коде до правки 21 сентября (дом зоны, `urgent_near`). Правка
# трогала только сети зон; здесь поток обязан остаться прежним до байта,
# иначе сдвинутся все замеры пересчёта на синтетике.
ПОТОК_АВАРИЙ = {"москва": "fd77b8f52c5815f1", "синтетика": "88b289d425527900"}


def _поток_аварий(net, срочные=None) -> str:
    """Отпечаток аварий на синтетических днях: зёрна 1, 2, 7, в 10:00 и 13:40."""
    import hashlib
    from .core.generate import generate_day
    from .replan import urgent_orders
    срочные = срочные or urgent_orders
    поток = [(s, at, o.node, o.district, round(o.lat, 6), round(o.lon, 6), o.address)
             for s in (1, 2, 7) for at in (600, 820)
             for o in срочные(generate_day(seed=s, network=net), at, 10, s)]
    return hashlib.sha1(repr(поток).encode()).hexdigest()[:16]


def _аварии_на_зонах(дни: dict, срочные=None) -> tuple[list[str], list[str]]:
    """
    Где встают аварии на сетях зон: что не так с разбросом по домам и что
    не так с привязкой к инженеру. Пустые списки — всё в порядке.

    Прежде адрес аварии брался по московскому району, района в зоне не
    было, и вставал ближайший к его центру дом: на юго-востоке 51 авария
    из 80 падала в один дом, на всех зонах адрес был «None, None», одна —
    в точку выезда. Порог — 25 домов из 80 и не больше 10 в одном: прежнее
    поведение давало 7–20 домов и 19–51 в одном, нынешнее — 43–50 и 4–6.
    """
    from collections import Counter
    from .replan import urgent_orders
    срочные = срочные or urgent_orders
    разброс: list[str] = []
    привязка: list[str] = []
    for з, д in дни.items():
        адреса: dict[int, set] = {}
        for o in д.orders:
            адреса.setdefault(o.node, set()).add(o.address)
        ав = срочные(д, 820, 80, 0)
        c = Counter(o.node for o in ав)
        чужие = sum(o.node not in адреса for o in ав)
        без_адреса = sum(not o.address or o.address not in адреса.get(o.node, ()) for o in ав)
        if len(c) < 25 or c.most_common(1)[0][1] > 10 or чужие or без_адреса:
            разброс.append(f"{з}: домов {len(c)}, в одном до {c.most_common(1)[0][1]}, "
                           f"не в доме заявки {чужие}, с чужим адресом {без_адреса}")
        # «У кого на участке»: восемь ближайших по дороге домов заявок к
        # точке, где инженер сейчас. Восемь — договорённость из CONTRACT.md,
        # здесь она записана числом, а не взята из replan, чтобы сторож
        # не двигался вместе с кодом.
        около = д.engineers[0].home_node
        сеть = д.network
        ближ = set(sorted((n for n in адреса if n != около),
                          key=lambda n: (сеть.road_km_between(около, n), n))[:8])
        try:
            рядом = {o.node for o in срочные(д, 820, 20, 0, near_node=около)}
        except TypeError as e:
            привязка.append(f"{з}: {e}")
            continue
        if not рядом <= ближ or len(рядом) < 3:
            привязка.append(f"{з}: домов {len(рядом)}, вне восьми ближайших {len(рядом - ближ)}")
    return разброс, привязка


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

    # Без файлов карты — отказ, а не молчаливая синтетика. Прежде сеть
    # откатывалась на выдуманную одной строкой в выводе, и все числа
    # дальше были бы сняты на другой карте.
    import os as _os
    from .core import osm as _osm
    _было_адреса, _было_синт = _osm.ADDRESS_FILE, _os.environ.pop("VRPTW_SYNTHETIC_MAP", None)
    _osm.ADDRESS_FILE = _osm.DATA_DIR / "нет-такого-файла.json"
    try:
        _без_данных = type(default_network()).__name__
    except FileNotFoundError:
        _без_данных = None
    finally:
        _osm.ADDRESS_FILE = _было_адреса
        if _было_синт is not None:
            _os.environ["VRPTW_SYNTHETIC_MAP"] = _было_синт
    if _без_данных is None:
        ok("без файлов карты — отказ с объяснением, а не синтетика молча")
    else:
        bad(f"без файлов карты стенд молча взял {_без_данных}")

    # Без интернета недостающий перегон рисуется прямой сразу и в кэш не
    # ложится. Прежде он стоил пятнадцать секунд — два захода с паузами —
    # и прямая оставалась в кэше навсегда.
    if hasattr(net, "_geometry"):
        _было_osrm, _было_офлайн = _osm.OSRM, _osm._offline_until
        _осрм_env = _os.environ.pop("VRPTW_OFFLINE", None)
        _osm.OSRM, _osm._offline_until = "http://127.0.0.1:9", 0.0
        пары = [(a, b) for a in range(40) for b in range(40)
                if a != b and not net.has_geometry(a, b)][:3]
        t0 = time.time()
        линии = [net.path_latlon(a, b, 12 * 60) for a, b in пары]
        сек = time.time() - t0
        _osm.OSRM, _osm._offline_until = _было_osrm, _было_офлайн
        if _осрм_env is not None:
            _os.environ["VRPTW_OFFLINE"] = _осрм_env
        застряли = [f"{a}-{b}" for a, b in пары if net.has_geometry(a, b)]
        if сек < 8 and all(len(x) == 2 for x in линии) and not застряли:
            ok(f"без сети {len(пары)} недостающих перегона — прямые за {сек:.1f} с, "
               f"в кэш не легли")
        else:
            bad(f"без сети {len(пары)} перегона заняли {сек:.1f} с, в кэше "
                f"осели {застряли}")

    # Кэш ломаных у каждой сети свой, и каждая ломаная ведёт от своего
    # дома к своему. Номера узлов у сетей свои: прежде сети зон читали
    # московский кэш, и 47 его перегонов попадали в номера югоцентра —
    # чужая ломаная начиналась в 13,7 км от точки выезда. У зон кэш полный:
    # на защите ни один перегон не должен идти в сеть.
    from .core.geo import haversine_km as _km
    from .core.load import REGIONS as _ЗОНЫ, load_day as _load_day

    def _кривые(сеть) -> list[str]:
        плохо = []
        for ключ, линия in сеть._geometry.items():
            номера = [int(x) for x in ключ.split("-")]
            if max(номера) >= len(сеть.nodes):      # ключ чужой сети
                плохо.append(ключ)
                continue
            a, b = (сеть.nodes[i] for i in номера)
            if (_km(a.lat, a.lon, линия[0][0], линия[0][1]) > 0.5
                    or _km(b.lat, b.lon, линия[-1][0], линия[-1][1]) > 0.5):
                плохо.append(ключ)
        return плохо

    дни_зон = {з: _load_day(з, quiet=True) for з in _ЗОНЫ}
    сети = [("Москва", net)] + [(з, д.network) for з, д in дни_зон.items()]
    кривых = {имя: _кривые(с) for имя, с in сети if hasattr(с, "_geometry")}
    неполные = {имя: f"{len(с._geometry)} из {len(с.nodes) * (len(с.nodes) - 1)}"
                for имя, с in сети[1:]
                if len(с._geometry) < len(с.nodes) * (len(с.nodes) - 1)}
    общий = [имя for имя, с in сети[1:] if с._geometry_file == net._geometry_file]
    if any(кривых.values()) or неполные or общий:
        bad(f"ломаные: чужие {({k: len(v) for k, v in кривых.items() if v})}, "
            f"неполные {неполные}, общий с Москвой кэш {общий}")
    else:
        ok(f"ломаные своих сетей ведут от дома к дому; у зон все "
           f"{sum(len(с._geometry) for _, с in сети[1:])} пар в кэше")

    разброс, привязка = _аварии_на_зонах(дни_зон)
    if разброс:
        bad(f"аварии на зонах падают в немногие дома или не в дома заявок: {разброс}")
    else:
        ok("аварии на зонах — по домам заявок зоны, с их адресами, не кучей")
    if привязка:
        bad(f"авария «у кого на участке» не у его точки: {привязка}")
    else:
        ok("авария «у кого на участке» — в восьми ближайших к инженеру домах")

    # «г.Город Москва» — только показ. Строка выгрузки остаётся ключом
    # кэша адресов: заявка с таким адресом обязана сохранить координату.
    from .core.load import read_orders_csv as _строки
    дубль, потеряны = [], []
    for з, д in дни_зон.items():
        заявки = {o.id: o for o in д.orders}
        дубль += [o.id for o in д.orders if (o.address or "").lower().startswith("г.город")]
        потеряны += [r["id"] for r in _строки(_ЗОНЫ[з])[0]
                     if (r["address"] or "").lower().startswith("г.город")
                     and not (r["id"] in заявки and заявки[r["id"]].lat)]
    if дубль or потеряны:
        bad(f"адреса: «г.Город» на показе у {дубль}, без координаты {потеряны}")
    else:
        ok("адреса на показ без «г.Город», координаты по строке выгрузки")

    # --- 3. день ---
    step("3. Синтетический день")
    from .core.generate import day_stats, generate_day
    day = generate_day(seed=1, network=net)
    st = day_stats(day)
    ok(f"{st['orders']} заявок, {st['engineers']} инженеров, "
       f"{st['est_work_hours']} ч работы на {st['capacity_hours']} ч смен")
    ok(f"навыки — заявок {st['orders_by_skill']}, инженеров {st['engineers_by_skill']}")

    карта = "москва" if getattr(net, "has_addresses", False) else "синтетика"
    отпечаток = _поток_аварий(net)
    if отпечаток == ПОТОК_АВАРИЙ[карта]:
        ok(f"поток аварий на {карта == 'москва' and 'московском пуле' or 'синтетике'} прежний: {отпечаток}")
    else:
        bad(f"поток аварий ({карта}) сдвинулся: {отпечаток} вместо "
            f"{ПОТОК_АВАРИЙ[карта]} — замеры пересчёта на синтетике не сравнимы")

    # Пятнадцатого сентября генератор заменится на загрузчик настоящих
    # заявок, и первое, что понадобится, — ответ «годен ли этот день».
    from .core.validate_day import check as check_day

    broken, warned = check_day(day)
    if broken:
        bad(f"синтетический день не проходит собственную проверку: {broken[:2]}")
    else:
        ok(f"день годен к планированию, предупреждений {len(warned)}")

    # Проверяльщик, который ничего не ловит, хуже отсутствующего.
    import copy as _copy

    probe = _copy.copy(day)
    probe.orders = [_copy.copy(o) for o in day.orders]
    probe.orders[0].est_minutes = 0
    probe.engineers = [_copy.copy(e) for e in day.engineers]
    probe.engineers[0].shift_end = 23 * 60
    caught, _ = check_day(probe)
    if len(caught) < 2:
        bad(f"проверка дня не заметила ни нулевой длительности, ни смены "
            f"за 21:00: нашла {caught}")
    else:
        ok("проверка дня ловит порчу: нулевая длительность и смена за 21:00")

    # Инвариант плана — тоже проверяльщик, и к нему то же требование.
    # Самое крупное слагаемое времени — длительность работ — не
    # проверялось до 20 сентября вовсе: план, где каждый визит длится
    # минуту вместо часа, проходил чисто, если согласованно пересчитать
    # дорогу. А `duration_factor` это ручка пользователя от 0,5 до 2,0.
    #
    # Подделка строится ровно так, как её построил бы желающий показать
    # красивое покрытие: дорога честная, окна соблюдены, сокращена только
    # работа. Прежде такой план не отличался от настоящего ничем.
    from .solvers import fast as _fast
    from .solvers import improved as _improved

    честный = _fast.solve(day, params=_improved.Params(lns_seconds=0.0,
                                                       lns_iterations=120))
    поддельный = _copy.deepcopy(честный)
    for _r in поддельный.routes.values():
        for _v in _r.visits:
            _v.finish = _v.start + 1          # «работа длится минуту»
    # Считаем именно жалобы на длительность: подделка задевает и дорогу
    # (следующий визит выезжает раньше), и такие жалобы к делу не
    # относятся — засчитать их значило бы отчитаться чужой работой.
    сокращено = sum(1 for p in поддельный.check_invariants(day)
                    if "по нормативу" in p)
    # И вторая половина: работа не может начаться раньше приезда.
    рано = _copy.deepcopy(честный)
    for _r in рано.routes.values():
        for _v in _r.visits:
            _v.start = _v.arrive - 15
            _v.finish = _v.start + _v.order.est_minutes
    до_приезда = sum(1 for p in рано.check_invariants(day) if "приехал" in p)

    if сокращено == 0 or до_приезда == 0:
        bad(f"инварианты не ловят подделку длительности: сокращённая работа "
            f"{сокращено} нарушений, работа до приезда {до_приезда}")
    else:
        ok(f"инварианты ловят подделку длительности: {сокращено} визитов "
           f"сокращено до минуты, {до_приезда} начато до приезда")

    # Инвариант судит по дню, а не по копиям, которые несёт план. План,
    # собранный на дне со сдвинутыми сменами или с облегчённой работой,
    # прежде сверялся сам с собой и проходил чисто.
    from .core.domain import InvalidPlan, Plan as _Plan
    from .shiftopt import apply as _apply_shifts

    _мало = _improved.Params(lns_seconds=0.0, lns_iterations=60)
    раньше = _apply_shifts(day, [e.shift_start // 60 - 1 for e in day.engineers],
                           shift_len=None)
    чужие_смены = _fast.solve(раньше, params=_мало).check_invariants(day)
    легче = _copy.copy(day)
    легче.orders = [_copy.copy(o) for o in day.orders]
    for _o in легче.orders:
        _o.est_minutes = max(1, _o.est_minutes // 2)
    чужая_работа = _fast.solve(легче, params=_мало).check_invariants(day)

    # Итог — множеством, а не счётом: одна заявка потеряна, другая дважды
    # в неназначенных, и по счёту всё сходилось.
    подмена = _copy.copy(честный)
    подмена.unassigned = честный.unassigned[1:] + [честный.unassigned[-1]]
    по_счёту = [p for p in подмена.check_invariants(day)
                if "потеряны" in p or "дважды" in p]
    if чужие_смены and чужая_работа and len(по_счёту) >= 2:
        ok(f"инвариант судит по дню: чужие смены — {len(чужие_смены)} нарушений, "
           f"облегчённая работа — {len(чужая_работа)}, потеря с дублем пойманы")
    else:
        bad(f"инвариант верит плану: чужие смены {len(чужие_смены)}, облегчённая "
            f"работа {len(чужая_работа)}, потеря с дублем {по_счёту}")

    # План проверяет себя сам, до того как уйти из солвера: подложенное
    # нарушение обязано остановить каждый из четырёх.
    from .solvers import greedy as _greedy
    from .solvers import sequential as _sequential
    _настоящая = _Plan.check_invariants
    _ноль = _improved.Params(lns_seconds=0.0, lns_iterations=0)
    _Plan.check_invariants = lambda self, d: ["подложено проверкой"]
    остановили = []
    try:
        for имя, решить in (("fast", lambda: _fast.solve(day, params=_ноль)),
                            ("improved", lambda: _improved.solve(day, params=_ноль)),
                            ("greedy", lambda: _greedy.solve(day)),
                            ("sequential", lambda: _sequential.solve(day))):
            try:
                решить()
            except InvalidPlan:
                остановили.append(имя)
    finally:
        _Plan.check_invariants = _настоящая

    # И голого `assert` на инвариантах нет нигде: под `python3 -O` он
    # исчезает, и проверка выключалась флагом интерпретатора.
    import re as _re
    _голые = [f"{p.name}:{i}" for p in Path(__file__).parent.rglob("*.py")
              for i, строка in enumerate(p.read_text().splitlines(), 1)
              if _re.match(r"\s*assert\b.*check_invariants", строка)]
    if len(остановили) == 4 and not _голые:
        ok("каждый солвер проверяет свой план сам; голых assert на инвариантах нет")
    else:
        bad(f"невалидный план выпускают: остановили только {остановили}; "
            f"голые assert: {_голые[:4]}")

    # «Сколько ещё людей нужно»: в голову ответа идёт НАИБОЛЬШЕЕ число
    # слотов среди прогонов, закрывших остаток, — надёжное, а не удачное.
    # Проверяется на выдуманных прогонах, а не на живых данных, нарочно:
    # на живых закрывшие прогоны совпадают по числу слотов, и замена
    # `max` на `min` там проходит зелёной — проверено.
    from .staffing import выбрать_голову

    def _прогон(открыто, осталось):
        return {"открыто": [None] * открыто, "не_закрыть": [None] * осталось}

    # Закрыли двое, +3 и +5: надёжное число — +5.
    расходятся = [_прогон(3, 0), _прогон(5, 0), _прогон(2, 1)]
    # Не закрыл никто: берём оставивший меньше всего, а из равных по
    # остатку — с меньшим числом слотов.
    никто = [_прогон(4, 2), _прогон(6, 1), _прогон(3, 1)]
    ok_надёжное = len(выбрать_голову(расходятся)["открыто"]) == 5
    г = выбрать_голову(никто)
    ok_лучший_из_худших = len(г["не_закрыть"]) == 1 and len(г["открыто"]) == 3
    from .staffing import описать_надёжность
    ok_разброс = ("от +3 до +5" in описать_надёжность(
        [_прогон(3, 0), _прогон(5, 0), _прогон(4, 0)]))
    ok_совпали = ("Одно и то же" in описать_надёжность(
        [_прогон(3, 0), _прогон(3, 0), _прогон(3, 0)]))
    if not (ok_разброс and ok_совпали):
        bad("«сколько людей нужно» неверно говорит о разбросе: при +3, +5 и "
            "+4 обязано назвать разброс, при трёх одинаковых — «одно и то же»")

    if ok_надёжное and ok_лучший_из_худших:
        ok("«сколько людей нужно» берёт надёжное число, а не лучшее зерно")
    else:
        bad(f"«сколько людей нужно» выбирает не то: из закрывших +3 и +5 "
            f"взято +{len(выбрать_голову(расходятся)['открыто'])}, ожидалось "
            f"+5 — это лучшее зерно, выданное за вывод")

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

    # Закрепление диспетчером: берём заявки жадного плана и отдаём их
    # СОСЕДУ по списку инженеров — так набор заведомо меняет решение, а
    # не совпадает с тем, что солвер выбрал бы сам. Инженер подбирается
    # из тех, кто вообще может взять заявку: закрепление за неспособным
    # это отдельный случай, и проверяется он не здесь.
    by_id = {o.id: o for o in day.orders}
    pinned = {}
    for oid, eid in list(anchor.items())[:8]:
        годные = [e.id for e in day.engineers if e.can_do(by_id[oid])]
        сосед = next((x for x in годные if x != eid), None)
        if сосед:
            pinned[oid] = сосед

    # Каждый набор отличается от «без штрафов» ровно одним слагаемым —
    # иначе ярлык врёт, а проверка `inert` ниже перестаёт что-либо
    # значить: случай, чей штраф не дошёл ни до одной реализации, всё
    # равно прошёл бы за счёт остальных отличий. Считать от нуля
    # приходится потому, что рабочие значения `balance_weight` и
    # `sla_weight` ненулевые по умолчанию: набор `{balance_weight:
    # BALANCE_WEIGHT}` — это `Params()` поле в поле, а вовсе не
    # «включённый штраф».
    БЕЗ_ШТРАФОВ = {"balance_weight": 0.0, "sla_weight": 1.0,
                   "priority_weights": (1.0, 1.0, 1.0)}

    def тесно(d, extra) -> dict:
        """Запас в машинах вдвое меньше того, что план без него везёт."""
        from .core.domain import equipment_sum
        base = improved.solve(d, params=improved.Params(lns_seconds=0.0, **extra))
        return {e.id: {k: n // 2 for k, n in equipment_sum(
                    v.order for v in base.routes[e.id].visits).items()}
                if e.id in base.routes else {} for e in d.engineers}

    cases = [
        ("без штрафов", БЕЗ_ШТРАФОВ),
        ("штраф за неравномерность",
         {**БЕЗ_ШТРАФОВ, "balance_weight": improved.BALANCE_WEIGHT}),
        ("вес обязательства", {**БЕЗ_ШТРАФОВ, "sla_weight": 2.0}),
        # Приоритета распределения здесь нет нарочно. Он живёт в первом
        # уровне цели, а цель при нулевом бюджете не спрашивают вовсе:
        # сборка ставит всё, что влезает, и приоритет в неё входит только
        # надбавкой к сожалению — она была и раньше. Здесь его набор
        # совпал бы с «без штрафов», и сторож ниже справедливо назвал бы
        # сверку вырожденной. Приоритет сверяется ниже, в поиске.
        ("штраф за смену исполнителя",
         {**БЕЗ_ШТРАФОВ, "anchor": anchor, "churn_penalty": 40.0}),
        # Тяга аварий к раннему началу. В `fast` член начисляется
        # повизитно, в `improved` — суммой по маршруту, и сверка здесь
        # единственное место, где видно, что это одно и то же.
        ("срочность аварий", {**БЕЗ_ШТРАФОВ, "urgency_weight": 30.0}),
        # Закрепление диспетчером. В `fast` оно сужает `capable`, в
        # `improved` отсекает кандидата в цикле — две разные строки, и
        # сверка единственное место, где видно, что они про одно.
        ("закреплено диспетчером", {**БЕЗ_ШТРАФОВ, "pinned": pinned}),
        # Оборудование в машине. Одна проверка `base.fits_stock` на обе
        # реализации, но зовут её из разных мест: `fast` — при отборе
        # опций маршрута, `improved` — в цикле кандидатов. Запас нарочно
        # вдвое меньше того, что везёт план без штрафов: иначе набор
        # совпал бы с базой и сверка на нём была бы вырожденной.
        ("запас оборудования", {**БЕЗ_ШТРАФОВ, "stock": тесно(day, БЕЗ_ШТРАФОВ)}),
        # И два составных: отдельно то, что реально уезжает на демо
        # (`Params()` без аргументов), отдельно все слагаемые разом —
        # штрафы могут быть верны поодиночке и разъехаться вместе.
        ("боевые значения", {}),
        ("всё сразу", {"anchor": anchor, "churn_penalty": 40.0,
                       "urgency_weight": 30.0, "pinned": pinned}),
    ]

    diverged, inert = [], []
    reference = None
    for label, extra in cases:
        slow = improved.Params(lns_seconds=0.0, **extra)
        # Невалидный план солвер не выпускает: он бросает `InvalidPlan`.
        # Для сверки это расхождение с названием набора, а не падение.
        try:
            seq_ref = seq_of(improved.solve(day, params=slow, seed=1))
            seq_new = seq_of(fast.solve(day, params=slow, seed=1))
        except InvalidPlan as exc:
            diverged.append(f"{label}: {str(exc)[:80]}")
            continue
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
    # Наборы те же и по тому же правилу, что при нулевом бюджете:
    # отличие от базы ровно в одном слагаемом. Срочность аварий здесь
    # обязательна — это единственное слагаемое, начисляемое в двух
    # реализациях по-разному, и без неё весь цикл поиска на нём не
    # сверялся бы ничем.
    lns_cases = [
        ("без штрафов", БЕЗ_ШТРАФОВ),
        # Приоритет распределения: «Авария → Подключение → Ремонт /
        # Дозаказ». Живёт в первом уровне цели и решает, что останется
        # лежать, — дрейф между реализациями здесь хуже любого другого.
        ("приоритет распределения",
         {**БЕЗ_ШТРАФОВ, "priority_weights": improved.PRIORITY_WEIGHTS}),
        ("штраф за неравномерность",
         {**БЕЗ_ШТРАФОВ, "balance_weight": improved.BALANCE_WEIGHT}),
        ("штраф за смену исполнителя",
         {**БЕЗ_ШТРАФОВ, "anchor": small_anchor, "churn_penalty": 40.0}),
        ("срочность аварий", {**БЕЗ_ШТРАФОВ, "urgency_weight": 30.0}),
        # Закрепление диспетчером. В `fast` оно сужает `capable`, в
        # `improved` отсекает кандидата в цикле — две разные строки, и
        # сверка единственное место, где видно, что они про одно.
        ("закреплено диспетчером", {**БЕЗ_ШТРАФОВ, "pinned": pinned}),
        ("запас оборудования", {**БЕЗ_ШТРАФОВ, "stock": тесно(small, БЕЗ_ШТРАФОВ)}),
        ("боевые значения", {}),
        ("всё сразу", {"anchor": small_anchor, "churn_penalty": 40.0,
                       "urgency_weight": 30.0}),
    ]
    for label, extra in lns_cases:
        p_lns = improved.Params(lns_seconds=0.0,
                                lns_iterations=ITERS, **extra)
        rep_ref, rep_new = {}, {}
        try:
            a = improved.solve(small, params=p_lns, seed=4, report=rep_ref)
            b = fast.solve(small, params=p_lns, seed=4, report=rep_new)
        except InvalidPlan as exc:
            lns_diverged.append(f"{label}: {str(exc)[:80]}")
            continue
        # Кроме плана сверяется и значение целевой функции. Одним планом
        # мелкий численный дрейф в инкрементальных префиксах не поймать:
        # он меняет стоимость, но не порядок вставок, и план выходит тот
        # же. Порядок сложения у двух реализаций разный, поэтому равенство
        # тут не побитовое, а с допуском — но допуск на восемь порядков
        # меньше самой дешёвой вставки.
        #
        # Сверяются все три уровня цели. Первые два без третьего не
        # проверяют ничего сверх плана: `obj[0]` — несделанное, `obj[1]` —
        # число непустых маршрутов, и то и другое однозначно следует из
        # плана, сверенного строкой выше. Дрейф живёт ровно в `obj[2]`,
        # ради него проверка и написана; до появления среднего уровня
        # стоимость и была вторым элементом, а при вставке `vehicle_weight`
        # в кортеж индекс не поправили.
        obj_ref, obj_new = rep_ref["objective"], rep_new["objective"]
        if (seq_of(a) != seq_of(b)
                or rep_ref["accepted"] != rep_new["accepted"]
                or rep_ref["iterations"] != rep_new["iterations"]
                or obj_ref[0] != obj_new[0]
                or abs(obj_ref[1] - obj_new[1]) > 1e-6
                or abs(obj_ref[2] - obj_new[2]) > 1e-6):
            lns_diverged.append(label)

    if lns_diverged:
        bad(f"поиск разошёлся между реализациями ({', '.join(lns_diverged)}) — "
            f"инкрементальные пересчёты в fast.py считают не то же самое")
    else:
        ok(f"поиск совпадает шаг в шаг: {ITERS} итераций LNS, те же принятые "
           f"ходы, все три уровня целевой функции, "
           f"{len(lns_cases)} наборов параметров")

    # Приоритет распределения, как его сформулировали организаторы:
    # «Авария → Подключение → Ремонт / Дозаказ. Авария имеет максимальный
    # приоритет. Если аварийная заявка появляется уже в течение рабочего
    # дня, она может стать основанием для изменения ранее сформированного
    # маршрута бригады».
    #
    # Проба построена так, что исход известен заранее. Перегруженный день,
    # все заявки — ремонт; берём ту, что не влезла, но в одиночку кому-то
    # по силам, и делаем её аварией. Прежний план идёт якорем со штрафом
    # за смену исполнителя — «маршрут сформирован, людям позвонили». При
    # равных весах авария обязана остаться лежать: для прежней цели
    # замена ремонта на неё ничего не давала, а штраф делал её невыгодной.
    # При весах приоритета — обязана встать, вытеснив ремонт.
    #
    # Обе половины проверяются вместе: без первой проба не доказывала бы,
    # что на этом дне приоритету вообще есть что менять.
    import copy as _cp

    def _план(d, веса, **extra):
        пп = improved.Params(lns_seconds=0.0, lns_iterations=300,
                             priority_weights=веса, **extra)
        пл = fast.solve(d, params=пп, seed=1)
        if пл.check_invariants(d):
            bad(f"план пробы приоритета невалиден: {пл.check_invariants(d)[:2]}")
        return пл

    РАВНЫЕ = (1.0, 1.0, 1.0)
    тесно = generate_day(seed=3, n_orders=30, n_engineers=2, network=net)
    тесно.orders = [_cp.copy(o) for o in тесно.orders]
    for o in тесно.orders:
        o.priority = 0
    было = _план(тесно, РАВНЫЕ)
    авария = None
    for u in было.unassigned:
        один = _cp.copy(тесно)
        один.orders = [u]
        if _план(один, РАВНЫЕ).assigned_count == 1:
            авария = u
            break
    if авария is None:
        bad("проба приоритета: на дне нет заявки, которую можно сделать аварией "
            "— проба выродилась, её день надо сменить")
    else:
        авария.priority = 2
        якорь_ = {v.order.id: eid for eid, r in было.routes.items() for v in r.visits}
        def _взята(пл):
            return авария.id in {v.order.id for r in пл.routes.values() for v in r.visits}
        равные = _план(тесно, РАВНЫЕ, anchor=якорь_, churn_penalty=40.0)
        боевые = _план(тесно, improved.Params().priority_weights,
                       anchor=якорь_, churn_penalty=40.0)
        if _взята(равные):
            bad("проба приоритета выродилась: авария встаёт и без приоритета, "
                "значит на этом дне ему нечего менять")
        elif not _взята(боевые):
            bad(f"авария {авария.id} не вытеснила ремонт из сложенного маршрута — "
                f"приоритет распределения не работает")
        else:
            ok(f"авария вытесняет ремонт из сложенного маршрута: назначено "
               f"{равные.assigned_count} → {боевые.assigned_count}, меняется "
               f"только что")

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

    # Сравниваем с планом без штрафа: рабочий вес теперь стоит значением
    # по умолчанию, и `plan_i` уже посчитан с ним. Сравнивать его с самим
    # собой смысла нет.
    rough = fast.solve(day, params=improved.Params(
        lns_seconds=0.0, lns_iterations=900, balance_weight=0.0), seed=1)
    b0, b1 = balance(day, rough), balance(day, plan_i)
    if b1["occupancy_gini"] > b0["occupancy_gini"] + 1e-9:
        bad(f"штраф за неравномерность не выравнивает загрузку: "
            f"Джини {b0['occupancy_gini']:.3f} → {b1['occupancy_gini']:.3f}")
    else:
        ok(f"загрузка выравнивается: Джини {b0['occupancy_gini']:.3f} → "
           f"{b1['occupancy_gini']:.3f}, занятость "
           f"{b1['occupancy_min'] * 100:.0f}–{b1['occupancy_max'] * 100:.0f}% "
           f"(назначено {plan_i.assigned_count} против {rough.assigned_count})")

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

    # Статусы «отправлено» и «в пути» — обратная связь организаторов
    # 20 сентября. Отправленный наряд держит исполнителя, как ручное
    # закрепление; к заявке «в пути» человек уже едет, и пересчёт её не
    # трогает вовсе, а сам он освобождается у неё после окончания работ.
    from .journal import Journal

    журнал = Journal(day="1")
    журнал.adopt(plan_i)
    длинные = [(eid, r) for eid, r in plan_i.routes.items() if len(r.visits) >= 2]
    (кто_отпр, м1), (кто_едет, м2) = длинные[0], длинные[1]
    отпр, едет = м1.visits[0].order.id, м2.visits[0].order.id
    выезд = м2.visits[0].arrive - м2.visits[0].travel
    журнал.add(day, {"kind": "dispatched", "order": отпр, "at": 540})
    журнал.add(day, {"kind": "en_route", "order": едет, "at": выезд})
    try:
        журнал.add(day, {"kind": "en_route", "order": м2.visits[1].order.id,
                         "at": выезд + 1})
        отказ = False
    except ValueError:
        отказ = True

    сейчас = выезд + 5
    сост = журнал.state(day, сейчас, plan_i.duration_factor)
    остаток = carve_remainder(day, сост)
    после = fast.solve(остаток, params=improved.Params(
        lns_seconds=0.0, lns_iterations=60, pinned=журнал.pinned()), seed=1)
    где = {v.order.id: eid for eid, r in после.routes.items() for v in r.visits}
    в_пуле = едет in где or едет in {o.id for o in после.unassigned}
    свободен = {e.id: e.shift_start for e in остаток.engineers}[кто_едет]
    ждали = max(м2.visits[0].finish, сейчас)
    держит = ((после.pinned or {}).get(отпр) == кто_отпр
              and где.get(отпр) in (кто_отпр, None))
    if not в_пуле and свободен == ждали and держит and отказ:
        ok(f"«в пути»: {едет} не перераспределяется, {кто_едет} свободен с "
           f"{свободен // 60:02d}:{свободен % 60:02d}; «отправлено» держит "
           f"{отпр} за {кто_отпр}")
    else:
        bad(f"статусы: «в пути» {едет} в пуле {в_пуле}, {кто_едет} свободен "
            f"с {свободен} вместо {ждали}; отправленный держится {держит}; "
            f"второй выезд отвергнут {отказ}")

    # Разыгранный пересчёт: кто выехал к визиту раньше момента пересчёта,
    # тот к нему и едет. Прежде такого инженера возвращали в точку выезда,
    # а визит отдавали в пул — статус «в пути» знал только журнал.
    from .core.domain import Day as _Day, Engineer as _Eng, Order as _Ord

    дальний = max(range(1, len(net.nodes)),
                  key=lambda b: net.travel_minutes(0, b, 9 * 60))
    в_дороге = net.travel_minutes(0, дальний, 9 * 60)
    день_д = _Day(date="в пути", network=net, orders=[_Ord(
        id="Д0", work_type="repair", district="—", lat=0.0, lon=0.0,
        node=дальний, window_start=9 * 60, window_end=15 * 60,
        sla_deadline=22 * 60, priority=0, est_minutes=30)], engineers=[_Eng(
        id="E00", name="—", skills={"repair"}, grade=2, home_node=0,
        home_lat=0.0, home_lon=0.0, shift_start=9 * 60, shift_end=18 * 60)])
    план_д = fast.solve(день_д, params=improved.Params(lns_seconds=0.0,
                                                       lns_iterations=0))
    # Десять минут после выезда: даже самая быстрая дорога — 0,7 от
    # оценки, — а оценка больше двадцати минут, так что он ещё в пути.
    сост_д = simulate_until(день_д, план_д, 9 * 60 + 10, _random.Random(1))
    доиграна = "Д0" in сост_д.done or "Д0" in сост_д.failed
    if в_дороге > 20 and "Д0" not in сост_д.pending_ids and доиграна:
        ok(f"разыгранный пересчёт: выехавший в 9:00 к заявке в {в_дороге:.0f} "
           f"мин пути в 9:10 едет к ней, а не отдаёт её в пул")
    else:
        bad(f"разыгранный пересчёт вернул едущего в точку выезда: заявка в "
            f"пуле {'Д0' in сост_д.pending_ids}, доиграна {доиграна}, "
            f"дорога {в_дороге:.0f} мин")

    # Оборудование при перепланировании — обратная связь 20 сентября.
    # Утром выдали под маршрут; установленное из машины ушло, и заявку с
    # роутером пересчёт отдаёт только тому, у кого роутер остался. Запас
    # здесь нулевой нарочно: с ним любая переданная заявка с прибором
    # нарушала бы ограничение, и сторож мог бы покраснеть.
    from .core.domain import equipment_sum as _нужно
    from .replan import morning_kit, stock_left

    выдано = morning_kit(day, plan_i, reserve=0)
    к_часу = simulate_until(day, plan_i, 13 * 60, _random.Random(1))
    осталось = stock_left(выдано, к_часу, day)
    ушло = sum(sum(v.values()) for v in выдано.values()) - sum(
        sum(v.values()) for v in осталось.values())
    установлено = sum(sum(day.order_by_id(o).equipment.values()) for o in к_часу.done)
    с_прибором = [e for e, ids in к_часу.pending.items()
                  if any(day.order_by_id(o).equipment for o in ids)]
    выбыл = с_прибором[0] if с_прибором else None
    без_ограничения = с_ограничением = None
    if выбыл:
        без_него = apply_dropout(carve_remainder(day, к_часу), выбыл, None)
        свободно = fast.solve(без_него, params=improved.Params(
            lns_seconds=0.0, lns_iterations=60), seed=1)
        # Тот же план, проверенный с запасом в машинах: сколько нарушений
        # дал бы пересчёт, не знающий об оборудовании.
        свободно.stock = осталось
        без_ограничения = sum(1 for p in свободно.check_invariants(без_него)
                              if "не хватает в машине" in p)
        try:
            fast.solve(без_него, params=improved.Params(
                lns_seconds=0.0, lns_iterations=60, stock=осталось), seed=1)
            с_ограничением = 0
        except InvalidPlan as exc:
            с_ограничением = sum(1 for p in exc.problems if "не хватает в машине" in p)
    # И инвариант обязан поймать перегруженную машину сам по себе.
    пустые = _copy.copy(plan_i)
    пустые.stock = {e.id: {} for e in day.engineers}
    поймал = any("не хватает в машине" in p for p in пустые.check_invariants(day))
    if (ушло == установлено > 0 and без_ограничения and с_ограничением == 0
            and поймал):
        ok(f"оборудование: к 13:00 установлено {установлено} приборов; без "
           f"запаса пересчёт после выбытия {выбыл} перегрузил бы "
           f"{без_ограничения} машин, с ограничением — ни одной")
    else:
        bad(f"оборудование: из машин ушло {ушло}, установлено {установлено}; "
            f"нарушений без ограничения {без_ограничения}, с ограничением "
            f"{с_ограничением}; инвариант поймал {поймал}")

    # --- 8. выгрузка и контракт ---
    step("8. Выгрузка для интерфейса")
    tmp = Path(tempfile.mkdtemp(prefix="vrptw_check_"))
    try:
        t = time.time()
        from .export import export_day
        sizes = export_day(day_id="1", out_dir=str(tmp), runs=200,
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

        # «Дешевле всех остальных из 1 подходящих» — сравнение не с кем; и
        # падеж: «из 21 подходящего», а не «подходящих».
        import re as _re
        объяснения = json.loads(next(tmp.rglob("explain*.json")).read_text(encoding="utf-8"))
        сводки = [o["summary"] for o in объяснения["orders"].values()]
        кривые = [s for s in сводки
                  if (m := _re.search(r"из (\d+) (подходящих|подходящего)$", s))
                  and (m.group(1) == "1" or (m.group(2) == "подходящего")
                       != (int(m.group(1)) % 10 == 1 and int(m.group(1)) % 100 != 11))]
        единственных = sum("единственный, кому" in s for s in сводки)
        if кривые or not единственных:
            bad(f"объяснения: кривые сводки {кривые[:2]}, «единственный» {единственных} "
                f"(в синтетическом дне первом такие заявки есть)")
        else:
            ok(f"объяснения: «единственный» у {единственных}, «из N подходящих» — "
               f"с N > 1 и в падеже")
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
