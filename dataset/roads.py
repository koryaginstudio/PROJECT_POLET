"""
Дороги для карты: настоящая ломаная между точками набора.

Расчёт в интерфейсе строит план сам, а линию на карте рисовал прямой — по
одной причине: дорожной сети у него нет. Прямая между двумя адресами режет
кварталы, идёт через дома и реку, и на защите это первое, что видно. Здесь
она заменяется ломаной по улицам.

Ломаные берутся у OSRM — того же маршрутизатора, которым пользуется движок,
— и складываются файлом. Интернет нужен ровно один раз, при сборке: дальше
интерфейс читает готовое и в сеть не ходит вовсе. Так же устроен геокодер в
`build.py` и геометрия у движка.

Считаются все пары точек зоны, а не только те, что попали в сегодняшний
план. План зависит от переменных, которые диспетчер меняет на экране, и
любая пара может понадобиться: набор, посчитанный «под текущий план»,
перестал бы работать от первого же сдвига ползунка.

    python3 dataset/roads.py            собрать всё, чего нет в кэше
    python3 dataset/roads.py check      что лежит в кэше и на что похоже

Пары ненаправленные: путь туда и обратно различают односторонние улицы, но
на карте города эта разница — половина квартала, а запросов и объёма вдвое
больше. Расстояние берётся по той же причине одно на пару.
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
CACHE = ROOT / "roadcache.json"

ZONES = ["east", "southeast", "center"]

OSRM = "https://router.project-osrm.org"

# Допуск упрощения ломаной, метры.
#
# Было двадцать — под масштаб города, где линия в три пикселя и метры на ней
# неразличимы. Но карту приближают: на обзоре в восемьсот метров один пиксель
# стоит полметра, и двадцать метров допуска — это сорок пикселей мимо дороги.
# Дуга при таком допуске вырождается в две прямых, а длинный перегон — в
# хорду через кварталы. Пять метров — это десять пикселей на самом близком
# обзоре и меньше пикселя на городском: линия ложится на свою дорогу везде.
SIMPLIFY_METERS = 5.0

# Надбавка за длину снята.
#
# Она казалась разумной: на перегоне в Каширу двадцать метров допуска дают
# ломаную в тысячу точек. Но на юго-востоке перегоны доходят до ста
# километров, и надбавка в два метра на километр давала допуск до двухсот
# сорока метров — пять километров МКАД ложились одной прямой. Платить за
# дальние перегоны прямыми через город нельзя: карту смотрят и вблизи.
SIMPLIFY_PER_KM = 0.0

# Потоков к публичному серверу OSRM и пауза перед каждым запросом. Восемь
# потоков без паузы сервер сносит примерно на двухтысячном запросе: он
# перестаёт отвечать вовсе, обрывая соединение на рукопожатии. Три потока с
# короткой паузой он держит ровно, а набор при этом собирается за четверть
# часа — один раз, дальше всё берётся из кэша.
THREADS = 3
PAUSE = 0.2
TIMEOUT = 20
# Попытки с растущей паузой: сервер общий, и короткий отказ на нём — дело
# обычное. Сдаваться на первом же значило бы оставить перегон без линии.
TRIES = 5
BACKOFF = [2, 5, 10, 20]

M_PER_DEG_LAT = 111_320.0


def load_cache() -> dict:
    if not CACHE.exists():
        return {}
    try:
        return json.loads(CACHE.read_text(encoding="utf-8"))
    except Exception:
        # Кэш побился — собираем заново, это дольше, но честнее, чем гадать,
        # какая половина файла уцелела.
        return {}


def save_cache(cache: dict) -> None:
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")


def key_of(a: tuple[float, float], b: tuple[float, float]) -> str:
    """Ключ пары. Ненаправленный: меньшая точка всегда первой."""
    one, two = sorted([a, b])
    return f"{one[0]:.5f},{one[1]:.5f}|{two[0]:.5f},{two[1]:.5f}"


def haversine_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 6371.0
    rad = math.radians
    dlat = rad(b[0] - a[0])
    dlon = rad(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(rad(a[0])) * math.cos(rad(b[0])) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def simplify(line: list[list[float]], tol_m: float) -> list[list[float]]:
    """Упрощение по Дугласу–Пекеру: точка выбрасывается, если отстоит от
    хорды меньше чем на допуск. Форму поворотов это сохраняет, а объём режет
    на порядок."""
    if len(line) < 3:
        return line

    ky = M_PER_DEG_LAT
    kx = ky * math.cos(math.radians(line[0][0]))

    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]

    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        ay, ax = line[start][0] * ky, line[start][1] * kx
        by, bx = line[end][0] * ky, line[end][1] * kx
        dy, dx = by - ay, bx - ax
        span = math.hypot(dx, dy)

        worst, at = -1.0, start
        for i in range(start + 1, end):
            py, px = line[i][0] * ky, line[i][1] * kx
            if span == 0:
                gap = math.hypot(px - ax, py - ay)
            else:
                gap = abs(dx * (ay - py) - (ax - px) * dy) / span
            if gap > worst:
                worst, at = gap, i

        if worst > tol_m:
            keep[at] = True
            stack.append((start, at))
            stack.append((at, end))

    return [line[i] for i in range(len(line)) if keep[i]]


def fetch(a: tuple[float, float], b: tuple[float, float]) -> dict | None:
    """Ломаная, длина и время у OSRM. `None` — не ответил.

    Сеть дёргается через `curl`, как и у движка. Это не вкусовщина: на
    `urllib` публичный OSRM рвёт TLS-рукопожатие ещё до запроса —
    «sslv3 alert handshake failure», — а `curl` тот же адрес открывает.
    """
    url = (
        f"{OSRM}/route/v1/driving/{a[1]:.6f},{a[0]:.6f};{b[1]:.6f},{b[0]:.6f}"
        "?overview=full&geometries=geojson"
    )
    for attempt in range(TRIES):
        try:
            time.sleep(PAUSE)
            done = subprocess.run(
                ["curl", "-sS", "--max-time", str(TIMEOUT), url],
                capture_output=True,
                text=True,
            )
            data = json.loads(done.stdout)
            route = data["routes"][0]
            coords = route["geometry"]["coordinates"]
            line = [[round(lat, 5), round(lon, 5)] for lon, lat in coords]
            km = route["distance"] / 1000
            tol = max(SIMPLIFY_METERS, km * SIMPLIFY_PER_KM)
            return {
                "line": simplify(line, tol),
                "km": round(km, 2),
                # Время OSRM — без пробок, и планировщик его не берёт: у него
                # своя скорость, уже сведённая с городом. Лежит справкой.
                "free_minutes": round(route["duration"] / 60, 1),
            }
        except Exception:
            if attempt + 1 < TRIES:
                time.sleep(BACKOFF[min(attempt, len(BACKOFF) - 1)])
    return None


def points_of(zone: str) -> list[tuple[float, float]]:
    """Все точки зоны: дома заявок и места выезда бригад.

    Координаты берутся как есть, без округления: интерфейс ищет перегон по
    точному совпадению с координатой заявки, и округлённая здесь точка ему
    просто не нашлась бы. На ключ кэша это не влияет — он и так считается с
    пятью знаками, то есть с точностью до метра.
    """
    orders = json.loads((OUT / zone / "orders.json").read_text(encoding="utf-8"))["orders"]
    engineers = json.loads((OUT / zone / "engineers.json").read_text(encoding="utf-8"))["engineers"]
    seen: dict[tuple[float, float], None] = {}
    for one in orders:
        seen.setdefault((one["lat"], one["lon"]), None)
    for one in engineers:
        seen.setdefault((one["home_lat"], one["home_lon"]), None)
    return list(seen)


def build(zone: str, cache: dict) -> dict:
    points = points_of(zone)
    pairs = [(i, j) for i in range(len(points)) for j in range(i + 1, len(points))]
    need = [(i, j) for i, j in pairs if key_of(points[i], points[j]) not in cache]
    print(f"  {zone}: точек {len(points)}, пар {len(pairs)}, спросить {len(need)}")

    if need:
        done = 0
        started = time.time()

        def work(pair):
            i, j = pair
            return pair, fetch(points[i], points[j])

        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            for (i, j), got in pool.map(work, need):
                done += 1
                if got is not None:
                    cache[key_of(points[i], points[j])] = got
                if done % 100 == 0:
                    speed = done / max(0.1, time.time() - started)
                    left = (len(need) - done) / max(0.1, speed)
                    print(f"    {done} из {len(need)}, осталось около {left / 60:.0f} мин")
                    save_cache(cache)
        save_cache(cache)

    legs = {}
    straight = 0
    for i, j in pairs:
        got = cache.get(key_of(points[i], points[j]))
        if got is None:
            # Ни кэша, ни ответа — оставляем пару без линии. Интерфейс
            # нарисует прямую: карта не сломается, перегон выйдет грубым.
            straight += 1
            continue
        legs[f"{i}-{j}"] = got
    return {"points": [list(p) for p in points], "legs": legs, "straight": straight}


def write(zone: str, built: dict, date: str) -> int:
    body = {
        "schema": "1.2",
        "kind": "roads",
        "meta": {
            "date": date,
            "zone": zone,
            "source": "OSRM, граф OpenStreetMap",
            "simplify_meters": SIMPLIFY_METERS,
            "note": "ломаные ненаправленные: ключ «i-j», i меньше j",
        },
        "points": built["points"],
        "legs": built["legs"],
    }
    path = OUT / zone / "roads.json"
    path.write_text(json.dumps(body, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return path.stat().st_size


def check() -> None:
    cache = load_cache()
    print(f"В кэше пар: {len(cache)}")
    for zone in ZONES:
        path = OUT / zone / "roads.json"
        if not path.exists():
            print(f"  {zone}: файла нет")
            continue
        body = json.loads(path.read_text(encoding="utf-8"))
        legs = body["legs"]
        points = body["points"]
        pairs = len(points) * (len(points) - 1) // 2
        vertices = [len(one["line"]) for one in legs.values()]
        detour = [
            one["km"] / max(0.05, haversine_km(tuple(points[int(k.split("-")[0])]), tuple(points[int(k.split("-")[1])])))
            for k, one in legs.items()
        ]
        detour.sort()
        print(
            f"  {zone}: {len(legs)} из {pairs} пар, {path.stat().st_size / 1024:.0f} КБ, "
            f"точек в ломаной {min(vertices)}–{max(vertices)} (медиана {sorted(vertices)[len(vertices) // 2]}), "
            f"дорога длиннее прямой в {detour[len(detour) // 2]:.2f} раза"
        )


def main() -> None:
    if len(sys.argv) > 1 and sys.argv[1] == "check":
        check()
        return

    print("Дороги для карты: ломаные по улицам от OSRM")
    cache = load_cache()
    print(f"в кэше пар: {len(cache)}")
    date = json.loads((OUT / "summary.json").read_text(encoding="utf-8"))["date"]

    for zone in ZONES:
        built = build(zone, cache)
        size = write(zone, built, date)
        print(
            f"  {zone}: записано {len(built['legs'])} ломаных, {size / 1024:.0f} КБ"
            + (f", без линии осталось {built['straight']}" if built["straight"] else "")
        )

    save_cache(cache)
    print(f"\nГотово. Кэш: {CACHE} ({CACHE.stat().st_size / 1024 / 1024:.1f} МБ)")


if __name__ == "__main__":
    main()
