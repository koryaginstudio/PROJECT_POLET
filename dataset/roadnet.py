"""Дорожная сеть области — для границ участков на карте.

Границу между районами читают как улицу, а не как линию наименьших
расстояний: «до Каширского шоссе наш участок, дальше соседний». Чтобы межа
легла по асфальту, интерфейсу нужна сама сеть — её и собирает этот скрипт.

Берём крупные дороги (автомагистрали, шоссе, главные и второстепенные) по
прямоугольнику, в который умещаются все заявки и выезды выгрузки, с запасом
в десяток километров.

Область режется не поровну, а по ответу: канал до Overpass в некоторых сетях
обрывает выдачу на двадцати килобайтах, и обрыв приходит не ошибкой, а
оборванным JSON. Поэтому плитку, чей ответ не разобрался, делим на четыре и
просим заново — пока каждая не станет отвечать целиком.

Результат — `app/public/data/roads-net.json`: список ломаных, каждая парами
«широта, долгота», округлёнными до пяти знаков (около метра). Файл лежит в
выгрузке рядом с остальными данными: стенд офлайновый и ходить за дорогами
во время работы не должен. Нет файла — границы идут по дорогам перегонов из
`roads.json`, их тоже хватает в городе.

Запуск: python3 dataset/roadnet.py
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SOUTH, WEST, NORTH, EAST = 54.684, 37.421, 55.899, 38.397
URL = "https://overpass-api.de/api/interpreter"
QUERY = (
    '[out:json][timeout:25];'
    'way[highway~"^(motorway|trunk|primary|secondary)$"]({s:.4f},{w:.4f},{n:.4f},{e:.4f});'
    'out geom;'
)
OUT = "app/public/data/roads-net.json"
PART = "/tmp/polet-roads-part.json"
DEPTH = 6
# Сколько работать за один запуск. Канал рвётся, сессии живут недолго, и
# лучше выйти самому, сохранив черновик, чем быть убитым на середине: при
# следующем запуске сбор продолжится с того же места.
BUDGET = float(os.environ.get("ROADNET_BUDGET", "240"))
STARTED = time.time()


class OutOfTime(Exception):
    pass

ways = []
seen = set()
done = set()

if os.path.exists(PART):
    saved = json.load(open(PART))
    ways = saved["ways"]
    seen = set(saved["seen"])
    done = set(tuple(box) for box in saved["done"])


def save():
    json.dump(
        {"ways": ways, "seen": list(seen), "done": [list(box) for box in done]},
        open(PART, "w"),
        separators=(",", ":"),
    )


def ask(box):
    """Один запрос. `None` — ответ оборван и плитку надо дробить."""
    s, w, n, e = box
    data = urllib.parse.urlencode({"data": QUERY.format(s=s, w=w, n=n, e=e)}).encode()
    req = urllib.request.Request(URL, data=data, headers={"User-Agent": "polet-dataset/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        body = resp.read().decode()
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return None


def take(box, depth=0):
    if box in done:
        return
    if time.time() - STARTED > BUDGET:
        raise OutOfTime
    answer = None
    for attempt in range(2):
        try:
            answer = ask(box)
            break
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as err:
            print(f"{box} попытка {attempt + 1}: {err}", flush=True)
            # 429 — нас просят сбавить темп; ждём дольше обычного.
            time.sleep(15 if getattr(err, "code", 0) == 429 else 4)
    if answer is None:
        if depth >= DEPTH:
            print(f"{box} — бросаем: дробить дальше некуда", flush=True)
            return
        s, w, n, e = box
        my, mx = (s + n) / 2, (w + e) / 2
        for part in ((s, w, my, mx), (s, mx, my, e), (my, w, n, mx), (my, mx, n, e)):
            take(part, depth + 1)
        return

    added = 0
    for el in answer.get("elements", []):
        if el.get("type") != "way" or el["id"] in seen:
            continue
        seen.add(el["id"])
        line = [[round(p["lat"], 5), round(p["lon"], 5)] for p in el.get("geometry", [])]
        if len(line) >= 2:
            ways.append(line)
            added += 1
    done.add(box)
    save()
    print(f"{box} — дорог +{added}, всего {len(ways)}", flush=True)
    time.sleep(1.5)


# Начинаем сразу с мелких плиток: целую область Overpass не отдаёт вовсе —
# отвечает «слишком долго», и время уходит на заведомо неподъёмные запросы.
ROWS, COLS = 24, 18
start = [
    (
        SOUTH + (NORTH - SOUTH) * r / ROWS,
        WEST + (EAST - WEST) * c / COLS,
        SOUTH + (NORTH - SOUTH) * (r + 1) / ROWS,
        WEST + (EAST - WEST) * (c + 1) / COLS,
    )
    for r in range(ROWS)
    for c in range(COLS)
]
try:
    for box in start:
        take(box)
    print("вся область собрана", flush=True)
except OutOfTime:
    print("время вышло — черновик сохранён, запустите ещё раз", flush=True)
finally:
    json.dump(ways, open(OUT, "w"), separators=(",", ":"))
    print(f"дорог: {len(ways)}; точек: {sum(len(w) for w in ways)}", flush=True)
