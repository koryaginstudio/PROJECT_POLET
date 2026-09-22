"""
Настоящая Москва: адреса из OpenStreetMap и дороги из OSRM.

Зачем это вместо радиально-кольцевой модели из `geo.py`. Синтетическая
сеть давала правдоподобное время в пути — сверка показала, что
Митино → Марьино у неё 56 минут днём против 48 у настоящего
маршрутизатора без пробок, — но две вещи она дать не могла:

  · **адрес.** Точка ставилась как «центр района плюс случайный сдвиг» и
    могла оказаться в пруду или посреди парка;
  · **линию на карте.** Маршрут рисовался по узлам выдуманного графа и на
    настоящей карте резал кварталы.

Здесь и то и другое настоящее. Устройство:

  адреса     — дома с `addr:street` и `addr:housenumber` из OSM, по восемь
               на каждый из пятидесяти районов; лежат файлом в репозитории;
  время      — матрица «без пробок» от OSRM между всеми адресами пула,
               посчитана один раз и лежит файлом;
  пробки     — почасовой профиль остаётся наш. OSRM пробок не знает, а наш
               профиль уже сверен с реальностью, см. `calibrate`;
  геометрия  — настоящая ломаная по улицам, тянется по мере надобности и
               складывается в кэш рядом с рабочей папкой.

Никаких новых зависимостей: сеть дёргается через `curl`, счёт — numpy.
В момент показа интернет не нужен вовсе, всё берётся из кэша.

    python3 -m vrptw.core.osm fetch          собрать пул адресов и матрицу
    python3 -m vrptw.core.osm points дома.json   сеть под чужие координаты
    python3 -m vrptw.core.osm warm 1,2,7    геометрия для показательных дней
    python3 -m vrptw.core.osm zones         геометрия всех пар для зон заказчика
    python3 -m vrptw.core.osm check         сверка времени в пути со старой моделью
"""

from __future__ import annotations

import json
import math
import os
import random
import subprocess
import time
from pathlib import Path

import numpy as np

from .domain import TRANSPORT
from .geo import (CENTER_LAT, CENTER_LON, DISTRICTS, HOURS, RUSH_RADIAL,
                  RUSH_RING, _rush, haversine_km)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
ADDRESS_FILE = DATA_DIR / "moscow_addresses.json"
MATRIX_FILE = DATA_DIR / "moscow_matrix.npz"
# Геометрия маршрутов лежит в репозитории: на защите интернета может не
# быть, а линия на карте — это первое, что видно.
GEOMETRY_FILE = DATA_DIR / "moscow_geometry.json"

# Допуск упрощения ломаной, метров. OSRM отдаёт шестьсот точек на поездку
# через город — это верно до сантиметра и бессмысленно на экране. Своё
# упрощение вместо `overview=simplified` потому, что у того допуск зашит
# и на близком зуме он срезает углы.
SIMPLIFY_METERS = 20.0

NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
# Маршрутизатор. По умолчанию публичный демо-сервер OSRM — его хватает,
# чтобы посчитать матрицу на несколько сотен точек. Настоящих адресов
# будет больше, и тогда сюда подставляется свой OSRM: матрица растёт как
# квадрат числа точек, а публичный сервер такое долбить нельзя ни по
# скорости, ни по совести.
#
#   docker run -p 5000:5000 osrm/osrm-backend osrm-routed /data/moscow.osrm
#   VRPTW_OSRM=http://localhost:5000 python3 -m vrptw.core.osm points адреса.json
OSRM = os.environ.get("VRPTW_OSRM", "https://router.project-osrm.org").rstrip("/")

# Ломаная для карты — украшение, а не расчёт, и ждать её нельзя: план
# уже посчитан, диспетчер смотрит на экран. Поэтому за недостающим
# перегоном ходим один раз и коротко, а после первого отказа считаем, что
# сети нет, и пять минут рисуем прямые без попыток. Прежде каждый
# недостающий перегон без сети стоил пятнадцать секунд — два захода с
# паузами, — и холодный план зоны на шестьдесят перегонов считался
# четверть часа.
#
# `VRPTW_OFFLINE=1` — не ходить в сеть вовсе. Для защиты: там всё нужное
# лежит в репозитории, а зал с плохим Wi-Fi хуже зала без Wi-Fi.
GEOMETRY_TIMEOUT = 5
OFFLINE_PAUSE = 300
_offline_until = 0.0

PER_DISTRICT = 12         # адресов на район; 50 районов → 600 точек
# Разброс точек вокруг центра района, градусы. Взят такой же, каким
# прежний генератор разбрасывал заявки: район — это не двор, и дома в нём
# должны стоять по всей его площади, иначе на карте выходит полсотни
# кучек, а в замере — нереально короткая дорога между соседними визитами.
SPREAD_LAT = 0.012
SPREAD_LON = 0.020

# Сколько точек пробуем на один найденный адрес. Обратное геокодирование
# отвечает улицей почти всегда, а номером дома — примерно в половине
# случаев: точка попадает на проезжую часть или в сквер. Берём только те,
# где дом есть, поэтому пробовать приходится с запасом.
ATTEMPTS_PER_ADDRESS = 4
TABLE_CHUNK = 50          # OSRM отдаёт не больше 100 координат за запрос

# Приведение времени OSRM «без пробок» к дневной норме. OSRM считает по
# профилю дорог, а не по факту: даже в свободный час Москва едет медленнее.
# Коэффициент подобран так, чтобы дневное время совпало с прежней моделью,
# которая уже была сверена с реальностью (Митино → Марьино: 48 минут у
# OSRM без пробок, 56 у нас днём). Почасовой профиль пробок сверх этого —
# прежний, из `geo.py`.
FREE_FLOW_TO_MIDDAY = 1.17

# Минуты «последней мили»: припарковаться, найти подъезд.
LAST_MILE = 3.0


def _curl(url: str, post: str | None = None, timeout: int = 180,
          tries: int = 4) -> dict:
    """
    Запрос через curl — чтобы не тащить в зависимости ни requests, ни
    certifi. Публичные сервисы режут частоту и иногда просто молчат,
    поэтому повторяем с нарастающей паузой.
    """
    if os.environ.get("VRPTW_OFFLINE"):
        raise RuntimeError(f"{url.split('/')[2]}: работа без сети (VRPTW_OFFLINE)")
    cmd = ["curl", "-s", "--max-time", str(timeout)]
    cmd += (["-X", "POST", url, "--data-urlencode", f"data={post}"]
            if post is not None else [url])
    last = ""
    for attempt in range(tries):
        out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8").stdout
        if out:
            try:
                return json.loads(out)
            except json.JSONDecodeError:
                last = out[:120]
        else:
            last = "пустой ответ"
        # После последней попытки ждать нечего: пауза перед отказом только
        # удлиняла отказ. Без сети она стоила пятнадцать секунд на каждый
        # перегон карты.
        if attempt + 1 < tries:
            pause = 5 * (attempt + 1)
            print(f"    {url.split('/')[2]} не ответил ({last}); жду {pause} с")
            time.sleep(pause)
    raise RuntimeError(f"{url.split('/')[2]} не отвечает после {tries} попыток: {last}")


# ---------- сбор данных (нужен интернет, делается один раз) ----------

PARTIAL_FILE = DATA_DIR / "moscow_addresses.partial.json"


def _reverse(lat: float, lon: float) -> dict | None:
    """Обратное геокодирование: что за дом стоит в этой точке."""
    url = (f"{NOMINATIM}?format=jsonv2&lat={lat:.6f}&lon={lon:.6f}"
           f"&zoom=18&addressdetails=1")
    cmd = ["curl", "-s", "--max-time", "25", "-H",
           "User-Agent: vrptw-hackathon-stand/1.0 (одноразовая сборка кэша)", url]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8").stdout
    if not out:
        return None
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return None
    a = data.get("address", {})
    street = a.get("road") or a.get("pedestrian")
    house = a.get("house_number")
    if not street or not house:
        return None
    return {"street": street, "house": house,
            "lat": round(float(data["lat"]), 6),
            "lon": round(float(data["lon"]), 6)}


def fetch_addresses() -> list[dict]:
    """
    Настоящие адреса домов по всем районам Москвы.

    Через обратное геокодирование, а не через Overpass: тот отдаёт всё
    сразу и потому дорог, публичные зеркала режут частоту по адресу
    клиента, и на пятидесяти районах сбор растягивался на часы. Здесь
    вместо выгрузки всех домов района берётся точка и спрашивается, что в
    ней стоит. Медленнее на запрос, зато предсказуемо.

    Точки разбрасываются по площади района, а не жмутся к его центру —
    от этого зависит, как день выглядит на карте и насколько правдоподобна
    дорога между соседними визитами.

    Собирается один раз, результат лежит файлом в репозитории. Прогресс
    пишется после каждого района: сбор идёт двадцать минут, и терять его
    из-за одного отказа незачем. Частота — один запрос в секунду, как
    просит Nominatim.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    done: dict[str, list[dict]] = {}
    if PARTIAL_FILE.exists():
        try:
            saved = json.loads(PARTIAL_FILE.read_text(encoding="utf-8"))
            if isinstance(saved, dict) and all(isinstance(v, list)
                                               for v in saved.values()):
                done = saved
                print(f"  продолжаю: готово районов {len(done)}")
        except Exception:
            done = {}

    rng = random.Random(20260908)
    for i, (name, lat, lon, _w) in enumerate(DISTRICTS, 1):
        if len(done.get(name, [])) >= PER_DISTRICT:
            print(f"  [{i:>2}/{len(DISTRICTS)}] {name}: уже собран")
            continue
        picked = done.get(name, [])
        seen = {(r["street"], r["house"]) for r in picked}
        tries = 0
        limit = PER_DISTRICT * ATTEMPTS_PER_ADDRESS
        while len(picked) < PER_DISTRICT and tries < limit:
            tries += 1
            rec = _reverse(lat + rng.gauss(0, SPREAD_LAT),
                           lon + rng.gauss(0, SPREAD_LON))
            time.sleep(1.1)      # Nominatim просит не чаще раза в секунду
            if rec is None or (rec["street"], rec["house"]) in seen:
                continue
            seen.add((rec["street"], rec["house"]))
            rec["district"] = name
            picked.append(rec)
        done[name] = picked
        PARTIAL_FILE.write_text(json.dumps(done, ensure_ascii=False), encoding="utf-8")
        print(f"  [{i:>2}/{len(DISTRICTS)}] {name}: {len(picked)} адресов "
              f"за {tries} попыток")

    out = [rec for name, _la, _lo, _w in DISTRICTS for rec in done.get(name, [])]
    thin = [f"{n}({len(done.get(n, []))})" for n, *_ in DISTRICTS
            if len(done.get(n, [])) < PER_DISTRICT]
    if thin:
        print(f"  неполные районы: {', '.join(thin)}")
    ADDRESS_FILE.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  → {len(out)} адресов в {ADDRESS_FILE.name}")
    return out


def fetch_matrix(addresses: list[dict], tries: int = 4) -> tuple[np.ndarray, np.ndarray]:
    """Время без пробок и расстояние по дорогам между всеми адресами."""
    n = len(addresses)
    coords_all = [(a["lon"], a["lat"]) for a in addresses]
    dur = np.zeros((n, n), dtype=np.float32)
    dist = np.zeros((n, n), dtype=np.float32)

    blocks = [list(range(s, min(s + TABLE_CHUNK, n)))
              for s in range(0, n, TABLE_CHUNK)]
    total = len(blocks) ** 2
    done = 0
    for bi in blocks:
        for bj in blocks:
            idx = bi + [j for j in bj if j not in bi]
            coords = ";".join(f"{coords_all[k][0]:.6f},{coords_all[k][1]:.6f}"
                              for k in idx)
            src = ";".join(str(idx.index(k)) for k in bi)
            dst = ";".join(str(idx.index(k)) for k in bj)
            url = (f"{OSRM}/table/v1/driving/{coords}"
                   f"?sources={src}&destinations={dst}"
                   f"&annotations=duration,distance")
            data = _curl(url, tries=tries)
            if data.get("code") != "Ok":
                raise RuntimeError(f"OSRM: {data.get('code')} {data.get('message','')}")
            for a, gi in enumerate(bi):
                for b, gj in enumerate(bj):
                    d = data["durations"][a][b]
                    m = data["distances"][a][b]
                    dur[gi, gj] = 0.0 if d is None else d / 60.0
                    dist[gi, gj] = 0.0 if m is None else m / 1000.0
            done += 1
            print(f"  матрица: блок {done}/{total}")
            time.sleep(0.4)
    return dur, dist


def build() -> None:
    """Собрать пул адресов и матрицу. Нужен интернет, делается один раз."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    if ADDRESS_FILE.exists():
        addresses = json.loads(ADDRESS_FILE.read_text(encoding="utf-8"))
        print(f"адреса уже собраны: {len(addresses)}")
    else:
        print("Собираю адреса из OpenStreetMap:")
        addresses = fetch_addresses()
        ADDRESS_FILE.write_text(json.dumps(addresses, ensure_ascii=False, indent=1),
                                encoding="utf-8")
        print(f"  → {len(addresses)} адресов в {ADDRESS_FILE.name}")

    print("Считаю матрицу времени по настоящим дорогам:")
    dur, dist = fetch_matrix(addresses)
    np.savez_compressed(MATRIX_FILE, duration=dur, distance=dist)
    print(f"  → матрица {dur.shape} в {MATRIX_FILE.name} "
          f"({MATRIX_FILE.stat().st_size / 1024:.0f} КБ)")


# ---------- сеть (интернет не нужен, всё из файлов) ----------

class Address:
    """Узел сети — настоящий дом с адресом."""

    __slots__ = ("idx", "lat", "lon", "street", "house", "district")

    def __init__(self, idx: int, rec: dict):
        self.idx = idx
        self.lat = rec["lat"]
        self.lon = rec["lon"]
        self.street = rec["street"]
        self.house = rec["house"]
        self.district = rec["district"]

    @property
    def text(self) -> str:
        return f"{self.street}, {self.house}"


class OSMNetwork:
    """
    Дорожная сеть по настоящим данным, с тем же интерфейсом, что у
    `RoadNetwork`: `nodes`, `nearest_node`, `travel_minutes`, `path_latlon`
    и почасовые `_matrices`. Солвер, симулятор и контракт от подмены не
    меняются — это тот же шов, через который придут данные 15 сентября.

    Время в пути собирается из двух частей. Настоящая — матрица OSRM
    «без пробок» между всеми адресами пула. Наша — почасовой профиль
    пробок из `geo.py`, потому что бесплатный маршрутизатор пробок не
    знает, а профиль уже сверен с реальностью.

    Профиль применяется не одинаково ко всем поездкам. В прежней модели
    радиалы вставали сильнее колец, и это была её главная мысль; здесь
    от пары точек остаётся только то, насколько поездка меняет расстояние
    до центра. Едем «внутрь» или «наружу» — считаем поездку радиальной,
    идём по дуге на том же удалении — кольцевой, между ними линейно.
    """

    # Узлы этой сети — настоящие дома, поэтому у заявки может быть адрес.
    has_addresses = True

    def __init__(self, address_file: Path | None = None,
                 matrix_file: Path | None = None, *,
                 addresses: list[dict] | None = None,
                 duration: np.ndarray | None = None,
                 distance: np.ndarray | None = None,
                 geometry_file: Path | None = None):
        """
        Из файлов — обычный путь. Из готовых массивов — когда сеть строится
        под произвольный набор точек (`for_points`), и класть её на диск
        отдельным файлом незачем.

        `geometry_file` — свой кэш ломаных. Ключ в нём — пара номеров
        узлов, а номера у каждой сети свои: узел 49 московского пула и
        узел 49 югоцентра — разные дома. Прежде все сети читали один
        московский кэш, и 47 его перегонов попадали в номера югоцентра:
        перегон E05 к заявке 35265 рисовался чужой ломаной, начинавшейся
        в 13,7 км от точки выезда.
        """
        if addresses is None:
            addresses = json.loads((address_file or ADDRESS_FILE).read_text(encoding="utf-8"))
            blob = np.load(matrix_file or MATRIX_FILE)
            duration, distance = blob["duration"], blob["distance"]
        self.nodes: list[Address] = [Address(i, a) for i, a in enumerate(addresses)]

        free_flow = np.asarray(duration, dtype=np.float32)
        self.road_km = np.asarray(distance, dtype=np.float32)
        n = len(self.nodes)
        if free_flow.shape != (n, n):
            raise RuntimeError(f"матрица {free_flow.shape} не сходится "
                               f"с {n} адресами")

        self._lat = np.array([a.lat for a in self.nodes], dtype=np.float64)
        self._lon = np.array([a.lon for a in self.nodes], dtype=np.float64)
        self._matrices = self._build_hourly(free_flow)
        self._geometry_file = geometry_file or GEOMETRY_FILE
        self._geometry = _load_geometry(self._geometry_file)

        self._by_district: dict[str, list[Address]] = {}
        for a in self.nodes:
            self._by_district.setdefault(a.district, []).append(a)

    # ---------- построение ----------

    def _radial_share(self) -> np.ndarray:
        """
        Насколько поездка радиальная: 0 — вдоль кольца, 1 — прямо к центру.

        Считается как доля прямого расстояния, которая ушла на изменение
        удаления от Кремля. Поездка через весь город на том же радиусе
        даст ноль, поездка из Митина в центр — почти единицу.
        """
        r = self._center_distance()
        dr = np.abs(r[:, None] - r[None, :])
        straight = self._straight_km()
        with np.errstate(divide="ignore", invalid="ignore"):
            share = np.where(straight > 0.05, dr / np.maximum(straight, 1e-9), 0.0)
        return np.clip(share, 0.0, 1.0)

    def _center_distance(self) -> np.ndarray:
        return np.array([haversine_km(CENTER_LAT, CENTER_LON, a.lat, a.lon)
                         for a in self.nodes])

    def _straight_km(self) -> np.ndarray:
        """Матрица расстояний по прямой. Векторно: 400×400 в питоне долго."""
        lat = np.radians(self._lat)
        lon = np.radians(self._lon)
        dlat = lat[:, None] - lat[None, :]
        dlon = lon[:, None] - lon[None, :]
        a = (np.sin(dlat / 2) ** 2
             + np.cos(lat)[:, None] * np.cos(lat)[None, :] * np.sin(dlon / 2) ** 2)
        return 2 * 6371.0 * np.arcsin(np.sqrt(np.clip(a, 0.0, 1.0)))

    def _build_hourly(self, free_flow: np.ndarray) -> dict[int, np.ndarray]:
        share = self._radial_share()
        base = free_flow * FREE_FLOW_TO_MIDDAY
        out: dict[int, np.ndarray] = {}
        for hour in HOURS:
            mult = (share * _rush(RUSH_RADIAL, hour)
                    + (1.0 - share) * _rush(RUSH_RING, hour))
            out[hour] = (base * mult).astype(np.float32)
        return out

    # ---------- запросы ----------

    def pick_address(self, district: str, rng) -> tuple[int, float, float, str]:
        """
        Случайный дом в районе — узел, координаты и почтовый адрес.

        Если в пуле этого района не оказалось (OSM не везде размечен),
        берём ближайший к его центру дом: заявка всё равно должна где-то
        стоять, и лучше рядом, чем нигде.
        """
        homes = self._by_district.get(district)
        if not homes:
            centre = next((d for d in DISTRICTS if d[0] == district), None)
            idx = self.nearest_node(centre[1], centre[2]) if centre else 0
            homes = [self.nodes[idx]]
        a = rng.choice(homes)
        return a.idx, a.lat, a.lon, a.text

    def nearest_node(self, lat: float, lon: float) -> int:
        d = (self._lat - lat) ** 2 + ((self._lon - lon) * 0.57) ** 2
        return int(np.argmin(d))

    def travel_minutes(self, from_node: int, to_node: int,
                       depart_minute: int, transport: str = "car") -> float:
        """
        Время в пути с учётом типа транспорта исполнителя.

        Умолчание `car` считается ровно так же, как считалось всегда —
        иначе все снятые числа пришлось бы объявить недействительными.

        Пешком и на велосипеде время берётся из настоящего километража
        (OSRM отдаёт расстояние рядом с временем), а не из умножения
        автомобильного времени: в пробке пешеход быстрее машины, и
        множителем это не выразить. Общественный транспорт — множитель к
        автомобильному времени плюс ожидание рейса: маршрутной сети у
        нас нет, и делать вид, что есть, не будем.
        """
        if from_node == to_node:
            return LAST_MILE
        # Границы берутся у самих матриц, а не у модульного HOURS: матрицы
        # построены один раз, а HOURS может оказаться другим — и тогда
        # запрос падал бы KeyError на часе, которого в сети нет.
        hour = max(min(self._matrices),
                   min(max(self._matrices), depart_minute // 60))
        car = float(self._matrices[hour][from_node, to_node])
        if transport == "car":
            return car + LAST_MILE

        spec = TRANSPORT[transport]
        kmh = spec["kmh"]
        if kmh is not None and getattr(self, "road_km", None) is not None:
            moving = float(self.road_km[from_node, to_node]) / kmh * 60.0
        else:
            moving = car * spec["mult"]
        return moving + spec["wait"] + LAST_MILE

    def road_km_between(self, from_node: int, to_node: int) -> float:
        """Пробег в километрах — вторая обязательная метрика ТЗ."""
        if from_node == to_node:
            return 0.0
        km = getattr(self, "road_km", None)
        if km is None:
            return 0.0
        return float(km[from_node, to_node])

    def path_latlon(self, from_node: int, to_node: int,
                    depart_minute: int) -> list[list[float]]:
        """
        Настоящая ломаная по улицам, для карты.

        Пробок OSRM не знает, поэтому линия от часа выезда не зависит и
        кэшируется по паре адресов. Если пары в кэше нет и интернета тоже
        нет — отдаём прямую из двух точек: карта не сломается, просто
        перегон будет нарисован грубо.

        Прямая в кэш не кладётся. Раньше клалась — и после одного запуска
        без сети оставалась в файле навсегда, хотя сеть потом появлялась.
        """
        if from_node == to_node:
            a = self.nodes[from_node]
            return [[a.lat, a.lon]]
        key = f"{from_node}-{to_node}"
        line = self._geometry.get(key)
        if line is None:
            line = self._fetch_geometry(from_node, to_node)
            if line is None:
                a, b = self.nodes[from_node], self.nodes[to_node]
                return [[a.lat, a.lon], [b.lat, b.lon]]
            self._geometry[key] = line
        return [list(p) for p in line]

    def _fetch_geometry(self, i: int, j: int) -> list[list[float]] | None:
        """Ломаная от OSRM или `None`, если сети нет. См. `GEOMETRY_TIMEOUT`."""
        global _offline_until
        if os.environ.get("VRPTW_OFFLINE") or time.time() < _offline_until:
            return None
        a, b = self.nodes[i], self.nodes[j]
        url = (f"{OSRM}/route/v1/driving/{a.lon:.6f},{a.lat:.6f};"
               f"{b.lon:.6f},{b.lat:.6f}?overview=full&geometries=geojson")
        try:
            data = _curl(url, timeout=GEOMETRY_TIMEOUT, tries=1)
            coords = data["routes"][0]["geometry"]["coordinates"]
        except Exception:
            _offline_until = time.time() + OFFLINE_PAUSE
            print(f"  {OSRM.split('//')[-1]} недоступен: {OFFLINE_PAUSE // 60} мин "
                  f"рисую недостающие перегоны прямыми")
            return None
        line = [[round(lat, 6), round(lon, 6)] for lon, lat in coords]
        return _simplify(line)

    def save_geometry(self) -> int:
        """Кэш ломаных — в свой файл сети, целиком и атомарно."""
        path = self._geometry_file
        path.parent.mkdir(parents=True, exist_ok=True)
        # Копия — одним вызовом на C, под GIL: пока json обходит словарь,
        # другой поток сервера может дописать в него перегон.
        snapshot = dict(self._geometry)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
        return len(snapshot)

    def has_geometry(self, from_node: int, to_node: int) -> bool:
        return from_node == to_node or f"{from_node}-{to_node}" in self._geometry

    # Совместимость с прежним интерфейсом: узлы пути как индексы.
    def path_nodes(self, from_node: int, to_node: int,
                   depart_minute: int) -> list[int]:
        return [from_node] if from_node == to_node else [from_node, to_node]


def normalize_points(points) -> list[dict]:
    """
    Привести произвольный набор точек к узлам сети.

    На вход годится что угодно, где есть широта и долгота: пары чисел,
    словари, объекты с `lat`/`lon`. Пятнадцатого сентября адреса придут
    своим форматом, и разбирать его будет загрузчик — сети нужны только
    координаты.

    Совпадающие точки схлопываются в один узел: несколько заявок в одном
    доме — обычное дело, а матрица растёт как квадрат числа узлов, и
    считать одно и то же дважды незачем.
    """
    seen: dict[tuple, dict] = {}
    for item in points:
        if isinstance(item, dict):
            lat, lon = float(item["lat"]), float(item["lon"])
            street = item.get("street")
            house = item.get("house")
            district = item.get("district")
        elif hasattr(item, "lat") and hasattr(item, "lon"):
            lat, lon = float(item.lat), float(item.lon)
            street = getattr(item, "street", None)
            house = getattr(item, "house", None)
            district = getattr(item, "district", None)
        else:
            lat, lon = float(item[0]), float(item[1])
            street = house = district = None

        key = (round(lat, 6), round(lon, 6))
        if key in seen:
            continue
        if district is None:
            district = min(DISTRICTS, key=lambda d: (d[1] - lat) ** 2
                           + ((d[2] - lon) * 0.57) ** 2)[0]
        seen[key] = {"district": district, "street": street, "house": house,
                     "lat": key[0], "lon": key[1]}
    return list(seen.values())


def points_fingerprint(addresses: list[dict]) -> str:
    """Отпечаток набора точек — по нему кэшируется матрица."""
    import hashlib

    blob = json.dumps(sorted((a["lat"], a["lon"]) for a in addresses)).encode()
    return hashlib.sha1(blob).hexdigest()[:12]


def _load_geometry(path: Path = GEOMETRY_FILE) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def _simplify(line: list[list[float]], tol_m: float = SIMPLIFY_METERS) -> list[list[float]]:
    """
    Упрощение ломаной по Дугласу–Пекеру.

    Точка выбрасывается, если она отстоит от хорды меньше чем на допуск.
    Форму поворотов это сохраняет, а объём режет на порядок: шестьсот
    точек на поездку через город превращаются в несколько десятков.
    """
    if len(line) < 3:
        return line
    # Метры на градус — локально, этого достаточно для допуска в 20 м.
    ky = 111_320.0
    kx = ky * math.cos(math.radians(line[0][0]))

    keep = [False] * len(line)
    keep[0] = keep[-1] = True
    stack = [(0, len(line) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        ax, ay = line[i][1] * kx, line[i][0] * ky
        bx, by = line[j][1] * kx, line[j][0] * ky
        dx, dy = bx - ax, by - ay
        norm = math.hypot(dx, dy) or 1e-9
        worst, at = 0.0, -1
        for k in range(i + 1, j):
            px, py = line[k][1] * kx, line[k][0] * ky
            d = abs(dy * px - dx * py + bx * ay - by * ax) / norm
            if d > worst:
                worst, at = d, k
        if worst > tol_m:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [pt for pt, k in zip(line, keep) if k]


def warm(seeds: list[int]) -> None:
    """
    Набрать в кэш геометрию перегонов для показательных дней.

    На защите интернета может не быть, а линия на карте — первое, что
    видно. Поэтому все перегоны, которые попадут на экран, тянутся
    заранее и складываются в файл рядом с адресами и матрицей.

    Прогреваются три плана на каждый день: обычный, по подобранному
    графику смен и пересчёт на аварию — то, что нажимают на демо.
    """
    import random as _random

    from ..replan import carve_remainder, simulate_until, urgent_orders
    from ..shiftopt import apply as apply_shifts
    from ..shiftopt import optimize
    from ..solvers import fast, improved
    from .generate import generate_day

    net = OSMNetwork()
    params = improved.Params(lns_seconds=0.0, lns_iterations=900)
    before = len(net._geometry)

    def collect(day, plan) -> list[tuple[int, int]]:
        legs = []
        for route in plan.routes.values():
            node = route.engineer.home_node
            for v in route.visits:
                legs.append((node, v.order.node))
                node = v.order.node
        return legs

    legs: set[tuple[int, int]] = set()
    for seed in seeds:
        day = generate_day(seed=seed, network=net)
        plan = fast.solve(day, params=params, seed=seed)
        legs |= set(collect(day, plan))

        tuned = apply_shifts(day, optimize(day, restarts=12, seed=seed).starts)
        legs |= set(collect(tuned, fast.solve(tuned, params=params, seed=seed)))

        at = 13 * 60 + 40
        state = simulate_until(day, plan, at, _random.Random(seed * 1000))
        rest = carve_remainder(day, state, extra=urgent_orders(day, at, 2, seed))
        legs |= set(collect(rest, fast.solve(rest, params=params, seed=seed)))
        print(f"  день {seed}: перегонов набралось {len(legs)}")

    todo = [(a, b) for a, b in sorted(legs) if not net.has_geometry(a, b)]
    print(f"нужно дотянуть {len(todo)} из {len(legs)}")
    for i, (a, b) in enumerate(todo, 1):
        net.path_latlon(a, b, 12 * 60)
        if i % 25 == 0:
            print(f"  {i}/{len(todo)}")
            net.save_geometry()
        time.sleep(0.15)
    n = net.save_geometry()
    print(f"в кэше {n} перегонов (было {before}), "
          f"{GEOMETRY_FILE.stat().st_size / 1024:.0f} КБ")


def _euler_circuit(n: int) -> list[int]:
    """
    Обход полного орграфа на `n` узлах, проходящий каждую дугу ровно раз.

    У полного орграфа входящая степень каждого узла равна исходящей, так
    что эйлеров цикл есть всегда; строится алгоритмом Хирхольцера. Нужен
    затем, чтобы соседние точки маршрута перебрали все упорядоченные
    пары: один запрос к OSRM на сотню точек даёт девяносто девять
    перегонов вместо одного.
    """
    left = {i: [j for j in range(n) if j != i] for i in range(n)}
    stack, out = [0], []
    while stack:
        v = stack[-1]
        if left[v]:
            stack.append(left[v].pop())
        else:
            out.append(stack.pop())
    return out[::-1]


def prefetch_all_pairs(net: "OSMNetwork", chunk: int = 100,
                       pause: float = 1.0) -> dict:
    """
    Ломаные для всех упорядоченных пар узлов сети — чтобы на защите
    ни один перегон не пришлось тянуть из сети.

    Какие пары понадобятся, заранее не сказать: пересчёт сажает
    инженера в точку последнего визита и шлёт к любой заявке, а авария
    приходит на любой адрес зоны. Поэтому берём все. У зоны на сотню
    адресов это десять тысяч перегонов — поштучно это десять тысяч
    запросов к публичному серверу, а цепочкой по эйлерову циклу — сотня.

    Ломаная перегона собирается из шагов (`steps`), а не режется из общей
    линии по точкам остановок: общая линия может пройти через точку
    остановки раньше, чем в неё заедет, и разрез встанет не туда.

    `continue_straight=false` обязателен. По умолчанию машина в
    промежуточной точке не разворачивается и объезжает квартал, и
    перегон из цепочки расходился с поштучным на 40–95 м. С ним
    совпадает точка в точку: сверено на двенадцати перегонах.
    """
    n = len(net.nodes)
    circuit = _euler_circuit(n)
    pieces = [circuit[k:k + chunk] for k in range(0, len(circuit) - 1, chunk - 1)]
    fetched = skipped = 0
    for p, seq in enumerate(pieces, 1):
        legs = list(zip(seq, seq[1:]))
        if all(f"{a}-{b}" in net._geometry for a, b in legs):
            skipped += len(legs)
            continue
        coords = ";".join(f"{net.nodes[i].lon:.6f},{net.nodes[i].lat:.6f}" for i in seq)
        url = (f"{OSRM}/route/v1/driving/{coords}"
               f"?overview=false&steps=true&geometries=geojson&continue_straight=false")
        data = _curl(url, timeout=120, tries=4)
        got = data["routes"][0]["legs"]
        if len(got) != len(legs):
            raise RuntimeError(f"OSRM вернул {len(got)} перегонов вместо {len(legs)}")
        for (a, b), leg in zip(legs, got):
            pts: list[list[float]] = []
            for step in leg["steps"]:
                for lon, lat in step["geometry"]["coordinates"]:
                    pt = [round(lat, 6), round(lon, 6)]
                    if not pts or pts[-1] != pt:
                        pts.append(pt)
            if len(pts) == 1:
                pts.append(list(pts[0]))
            net._geometry[f"{a}-{b}"] = _simplify(pts)
            fetched += 1
        if p % 10 == 0 or p == len(pieces):
            net.save_geometry()
            print(f"    {p}/{len(pieces)} запросов, перегонов {fetched}")
        time.sleep(pause)
    net.save_geometry()
    return {"nodes": n, "pairs": n * (n - 1), "fetched": fetched,
            "skipped": skipped, "requests": len(pieces)}


def warm_zones() -> None:
    """Ломаные всех пар для каждой зоны заказчика. Нужен интернет, один раз."""
    from .load import REGIONS, load_day

    for zone in REGIONS:
        day = load_day(zone, quiet=True)
        net = day.network
        t = time.time()
        st = prefetch_all_pairs(net)
        size = net._geometry_file.stat().st_size / 1024 / 1024
        print(f"{zone}: {st['nodes']} узлов, {st['pairs']} пар, "
              f"дотянуто {st['fetched']} за {st['requests']} запросов, "
              f"{time.time() - t:.0f} с, файл {net._geometry_file.name} {size:.1f} МБ")


def network_for_points(points, refresh: bool = False,
                       cache_dir: Path | None = None, quiet: bool = False,
                       tries: int = 4):
    """
    Сеть под произвольный набор точек.

    Нынешний пул из шестисот адресов — это синтетика. С настоящими данными
    точки придут свои, их будут тысячи, и приклеивать реальный дом к
    ближайшему из наших шестисот означало бы ошибаться на километр в
    каждом маршруте. Поэтому сеть должна уметь строиться под то, что
    прислали.

    Матрица считается один раз и кладётся рядом с данными под отпечатком
    набора точек: второй запуск на тех же адресах интернета не требует.

    Стоит помнить, во что это обходится. Матрица растёт как квадрат числа
    узлов, а публичный OSRM отдаёт не больше сотни координат за запрос:
    на 600 точках это 144 запроса и минут десять, на 2000 — уже полторы
    тысячи запросов. Начиная примерно с тысячи точек нужен свой OSRM,
    иначе это и долго, и невежливо. Адрес берётся из `VRPTW_OSRM`.
    """
    addresses = normalize_points(points)
    if not addresses:
        raise ValueError("пустой набор точек")

    root = cache_dir or DATA_DIR
    root.mkdir(parents=True, exist_ok=True)
    fp = points_fingerprint(addresses)
    pts_file = root / f"points-{fp}.json"
    mat_file = root / f"matrix-{fp}.npz"
    # Ломаные — под тем же отпечатком: номера узлов у каждой сети свои.
    geo_file = root / f"geometry-{fp}.json"

    if not refresh and pts_file.exists() and mat_file.exists():
        saved = json.loads(pts_file.read_text(encoding="utf-8"))
        blob = np.load(mat_file)
        if not quiet:
            print(f"  сеть на {len(saved)} узлов взята из кэша ({fp})")
        return OSMNetwork(addresses=saved, duration=blob["duration"],
                          distance=blob["distance"], geometry_file=geo_file)

    n = len(addresses)
    blocks = -(-n // TABLE_CHUNK)
    if not quiet:
        print(f"  строю сеть на {n} узлов: {blocks ** 2} запросов к "
              f"{OSRM.split('//')[-1].split('/')[0]}")
        if blocks ** 2 > 400:
            print("  это надолго. Для такого числа точек стоит поднять свой "
                  "OSRM и указать его в VRPTW_OSRM")
    dur, dist = fetch_matrix(addresses, tries=tries)

    pts_file.write_text(json.dumps(addresses, ensure_ascii=False), encoding="utf-8")
    np.savez_compressed(mat_file, duration=dur, distance=dist)
    if not quiet:
        print(f"  готово, кэш {fp} — {mat_file.stat().st_size / 1024:.0f} КБ")
    return OSMNetwork(addresses=addresses, duration=dur, distance=dist,
                      geometry_file=geo_file)


def сеть_из_готовых(points, каталоги: list[Path], куда: Path | None = None,
                    quiet: bool = True, проверить: bool = False):
    """
    Сеть под набор точек без единого запроса — из того, что уже посчитано.

    Сперва ищется точное совпадение отпечатка: выгрузка `восток.csv`,
    загруженная кнопкой, даёт тот же набор точек, что зона «восток», и
    берёт её сеть из репозитория как есть. Потом — готовая сеть, в которой
    есть все нужные точки: диспетчер убрал из выгрузки десяток строк, и
    строить матрицу заново незачем, её подматрица точна до метра. Вместе с
    ней переносятся и ломаные для карты — под новыми номерами узлов.

    Подсеть кладётся в `куда` под своим отпечатком, чтобы в следующий раз
    найтись точным совпадением. `проверить=True` — только ответить, есть
    ли такая сеть (True/False), ничего не записывая. Нет — None.
    """
    addresses = normalize_points(points)
    if not addresses:
        raise ValueError("пустой набор точек")
    fp = points_fingerprint(addresses)
    for root in каталоги:
        if (root / f"points-{fp}.json").exists() and (root / f"matrix-{fp}.npz").exists():
            if проверить:
                return True
            return network_for_points(points, cache_dir=root, quiet=quiet)

    ключи = [(a["lat"], a["lon"]) for a in addresses]
    for root in каталоги:
        for pts in sorted(root.glob("points-*.json")):
            чужой = pts.stem[len("points-"):]
            mat = root / f"matrix-{чужой}.npz"
            if not mat.exists():
                continue
            try:
                saved = json.loads(pts.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            где = {(round(float(a["lat"]), 6), round(float(a["lon"]), 6)): i
                   for i, a in enumerate(saved)}
            if not all(к in где for к in ключи):
                continue
            if проверить:
                return True
            idx = [где[к] for к in ключи]
            blob = np.load(mat)
            dur = blob["duration"][np.ix_(idx, idx)]
            dist = blob["distance"][np.ix_(idx, idx)]
            старые = _load_geometry(root / f"geometry-{чужой}.json")
            ломаные = {}
            for a, i in enumerate(idx):
                for b, j in enumerate(idx):
                    линия = старые.get(f"{i}-{j}")
                    if линия is not None:
                        ломаные[f"{a}-{b}"] = линия
            цель = куда or root
            цель.mkdir(parents=True, exist_ok=True)
            (цель / f"points-{fp}.json").write_text(
                json.dumps(addresses, ensure_ascii=False), encoding="utf-8")
            np.savez_compressed(цель / f"matrix-{fp}.npz", duration=dur, distance=dist)
            (цель / f"geometry-{fp}.json").write_text(
                json.dumps(ломаные, ensure_ascii=False), encoding="utf-8")
            if not quiet:
                print(f"  сеть на {len(addresses)} узлов вырезана из готовой ({чужой})")
            return OSMNetwork(addresses=addresses, duration=dur, distance=dist,
                              geometry_file=цель / f"geometry-{fp}.json")
    return False if проверить else None


def calibrate() -> None:
    """Сверка с прежней моделью: те же поездки, два способа посчитать."""
    from .geo import RoadNetwork

    old = RoadNetwork()
    new = OSMNetwork()
    byname: dict[str, list] = {}
    for a in new.nodes:
        byname.setdefault(a.district, []).append(a)

    pairs = [("Митино", "Марьино"), ("Строгино", "Выхино"),
             ("Ясенево", "Медведково"), ("Тверской", "Марьино"),
             ("Арбат", "Басманный"), ("Хамовники", "Таганский")]
    print(f"{'маршрут':<26}{'км':>7}{'13:00':>16}{'18:00':>16}")
    print(f"{'':<26}{'':>7}{'было / стало':>16}{'было / стало':>16}")
    print("─" * 66)
    for x, y in pairs:
        if x not in byname or y not in byname:
            continue
        a, b = byname[x][0], byname[y][0]
        ia, ib = old.nearest_node(a.lat, a.lon), old.nearest_node(b.lat, b.lon)
        o13, o18 = old.travel_minutes(ia, ib, 780), old.travel_minutes(ia, ib, 1080)
        n13 = new.travel_minutes(a.idx, b.idx, 780)
        n18 = new.travel_minutes(a.idx, b.idx, 1080)
        km = new.road_km[a.idx, b.idx]
        print(f"{x + ' → ' + y:<26}{km:>6.1f}"
              f"{o13:>10.0f} /{n13:>4.0f}{o18:>11.0f} /{n18:>4.0f}")


if __name__ == "__main__":
    import sys
    what = sys.argv[1] if len(sys.argv) > 1 else "fetch"
    if what == "points":
        # Сеть под чужой набор точек: json со списком объектов, где есть
        # lat и lon. То, что понадобится 15 сентября первым делом.
        if len(sys.argv) < 3:
            print("укажите файл: python3 -m vrptw.core.osm points адреса.json")
            raise SystemExit(1)
        raw = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
        items = raw if isinstance(raw, list) else raw.get("points", [])
        net = network_for_points(items, refresh="--refresh" in sys.argv)
        print(f"  узлов {len(net.nodes)}, "
              f"самая долгая поездка в пик "
              f"{net._matrices[18].max():.0f} мин")
    elif what == "fetch":
        build()
    elif what == "warm":
        seeds = ([int(x) for x in sys.argv[2].split(",")]
                 if len(sys.argv) > 2 else [1, 2, 7])
        warm(seeds)
    elif what == "zones":
        warm_zones()
    elif what == "check":
        calibrate()
    else:
        print(f"не знаю режима {what!r}: есть fetch, points, warm, zones и check")
