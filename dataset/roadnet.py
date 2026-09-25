"""Дорожная сеть области — для границ участков на карте.

Границу между районами читают как улицу, а не как линию наименьших
расстояний: «до Каширского шоссе наш участок, дальше соседний». Чтобы межа
легла по асфальту, интерфейсу нужна сама сеть — её и собирает этот скрипт.

Берём крупные дороги (автомагистрали, шоссе, главные и второстепенные) по
прямоугольнику, в который умещаются все заявки и выезды выгрузки, с запасом
в десяток километров. Область режется на плитки: одним запросом Overpass
такой кусок не отдаёт — отвечает «слишком долго».

Результат — `app/public/data/roads-net.json`: список ломаных, каждая парами
«широта, долгота», округлёнными до пяти знаков (около метра). Файл лежит в
выгрузке рядом с остальными данными: стенд офлайновый и ходить за дорогами
во время работы не должен.

Запуск: python3 dataset/roadnet.py
"""

import json, time, urllib.parse, urllib.request, sys

SOUTH, WEST, NORTH, EAST = 54.684, 37.421, 55.899, 38.397
ROWS, COLS = 4, 3
URL = "https://overpass-api.de/api/interpreter"
QUERY = '[out:json][timeout:120];way[highway~"^(motorway|trunk|primary|secondary)$"]({s},{w},{n},{e});out geom;'

import os

OUT = "app/public/data/roads-net.json"
PART = "/private/tmp/claude-501/-Users-anton-Desktop--------PROJECT-POLET/687c7ac9-de8f-4150-a089-71e87ae59093/scratchpad/roads-part.json"

# Докачка: плитки складываются по одной, и прерванный сбор можно продолжить
# с того места, где он встал, — Overpass отвечает медленно и не всегда.
ways = []
seen = set()
if os.path.exists(PART):
    saved = json.load(open(PART))
    ways = saved["ways"]
    seen = set(saved["seen"])
    done_tiles = set(tuple(t) for t in saved["tiles"])
else:
    done_tiles = set()
for r in range(ROWS):
    for c in range(COLS):
        s = SOUTH + (NORTH - SOUTH) * r / ROWS
        n = SOUTH + (NORTH - SOUTH) * (r + 1) / ROWS
        w = WEST + (EAST - WEST) * c / COLS
        e = WEST + (EAST - WEST) * (c + 1) / COLS
        if (r, c) in done_tiles:
            continue
        q = QUERY.format(s=s, w=w, n=n, e=e)
        for attempt in range(3):
            try:
                req = urllib.request.Request(
                    URL,
                    data=urllib.parse.urlencode({"data": q}).encode(),
                    headers={"User-Agent": "polet-dataset/1.0"},
                )
                with urllib.request.urlopen(req, timeout=180) as resp:
                    data = json.loads(resp.read().decode())
                break
            except Exception as err:
                print(f"плитка {r}:{c} попытка {attempt+1}: {err}", flush=True)
                time.sleep(8)
        else:
            continue
        for el in data.get("elements", []):
            if el.get("type") != "way" or el["id"] in seen:
                continue
            seen.add(el["id"])
            line = [[round(p["lat"], 5), round(p["lon"], 5)] for p in el.get("geometry", [])]
            if len(line) >= 2:
                ways.append(line)
        done_tiles.add((r, c))
        json.dump(
            {"ways": ways, "seen": list(seen), "tiles": [list(t) for t in done_tiles]},
            open(PART, "w"),
            separators=(",", ":"),
        )
        print(f"плитка {r}:{c} — всего дорог {len(ways)}", flush=True)
        time.sleep(3)

json.dump(ways, open(OUT, "w"), separators=(",", ":"))
print(f"дорог: {len(ways)}; точек: {sum(len(w) for w in ways)}")
