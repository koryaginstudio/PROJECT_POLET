"""
География и дорожная сеть Москвы.

Радиально-кольцевая модель: 6 колец (Бульварное, Садовое, ТТК, среднее,
внешнее, МКАД) и 48 радиалов. Время в пути считается кратчайшим путём
по графу, отдельно для каждого часа суток — потому что в час пик
радиалы встают сильнее колец, и обгонять пробку через центр не выйдет.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

CENTER_LAT = 55.7558
CENTER_LON = 37.6173

# Радиусы колец в километрах от Кремля.
RING_RADII_KM = [0.0, 1.6, 2.6, 5.2, 9.0, 13.5, 18.5]
N_RADIALS = 48

# Базовая скорость км/ч. Чем дальше от центра, тем свободнее.
RING_SPEED_KMH = [0.0, 18.0, 20.0, 26.0, 34.0, 44.0, 62.0]   # движение по кольцу
RADIAL_SPEED_KMH = [16.0, 18.0, 22.0, 28.0, 36.0, 48.0]      # между кольцом i и i+1

# Множители часа пик. Индекс — час суток.
# Радиалы (въезд/выезд) страдают сильнее колец.
#
# Профиль наш и ручной: OSRM пробок не знает. Это допущение, и на защите
# его надо называть вслух — как и всё остальное, чего не было в выгрузке.
#
# Часы 21 и 22 дописаны 16 сентября. До этого таблица кончалась на 20:00,
# а `travel_minutes` зажимал час двадцаткой — то есть поздний вечер
# считался по множителю восьми часов вечера. У синтетики день кончается
# в 21:00 и выехать в 21:00 нельзя, поэтому её это не задевало вовсе.
# А вот у данных заказчика день идёт до 22:00, и последние два часа мы
# переоценивали дорогу на 10-20%: закладывали вечернюю загрузку там, где
# город уже пустой. Значения продолжают спад 19→20 (−0,25 по кольцу,
# −0,35 по радиалу) и упираются в дневной минимум 0,95 — свободнее в
# этой модели не бывает нигде.
RUSH_RING = {7: 1.35, 8: 1.60, 9: 1.45, 10: 1.15, 11: 1.00, 12: 0.95, 13: 0.95,
             14: 1.00, 15: 1.10, 16: 1.30, 17: 1.65, 18: 1.70, 19: 1.40, 20: 1.15,
             21: 1.05, 22: 0.95}
RUSH_RADIAL = {7: 1.55, 8: 1.95, 9: 1.70, 10: 1.20, 11: 1.00, 12: 0.95, 13: 0.95,
               14: 1.05, 15: 1.20, 16: 1.50, 17: 2.00, 18: 2.05, 19: 1.55, 20: 1.20,
               21: 1.08, 22: 0.95}

HOURS = list(range(7, 23))


def _rush(table: dict[int, float], hour: int) -> float:
    """Множитель пробок на этот час, с зажимом по краям таблицы.

    Границы берутся из самой таблицы, а не зашиты числами. Раньше здесь
    стояло `min(20, hour)`, и любой дописанный в таблицу час молча не
    применялся бы: таблица говорит одно, функция возвращает другое.
    На этом я и споткнулся, дописывая 21 и 22.
    """
    if not table:
        return 1.0
    return table[max(min(table), min(max(table), hour))]


@dataclass(frozen=True)
class Node:
    idx: int
    ring: int      # 0 = центр
    spoke: int     # 0..N_RADIALS-1, для центра 0
    lat: float
    lon: float


def _offset(lat: float, lon: float, dist_km: float, bearing_rad: float) -> tuple[float, float]:
    dlat = dist_km / 111.32
    dlon = dist_km / (111.32 * math.cos(math.radians(lat)))
    return lat + dlat * math.cos(bearing_rad), lon + dlon * math.sin(bearing_rad)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


class RoadNetwork:
    """Граф дорог + матрицы времени в пути по часам."""

    # Узлы этой сети — точки выдуманного графа, а не дома. Генератор по
    # этому флагу понимает, можно ли ставить заявке почтовый адрес.
    has_addresses = False

    def __init__(self) -> None:
        self.nodes: list[Node] = []
        self._build_nodes()
        self._edges = self._build_edges()
        self._matrices: dict[int, np.ndarray] = {}
        self._predecessors: dict[int, np.ndarray] = {}
        self._build_matrices()

    # ---------- построение ----------

    def _build_nodes(self) -> None:
        self.nodes.append(Node(0, 0, 0, CENTER_LAT, CENTER_LON))
        idx = 1
        for ring in range(1, len(RING_RADII_KM)):
            r = RING_RADII_KM[ring]
            for spoke in range(N_RADIALS):
                bearing = 2 * math.pi * spoke / N_RADIALS
                lat, lon = _offset(CENTER_LAT, CENTER_LON, r, bearing)
                self.nodes.append(Node(idx, ring, spoke, lat, lon))
                idx += 1

    def _node_at(self, ring: int, spoke: int) -> int:
        if ring == 0:
            return 0
        return 1 + (ring - 1) * N_RADIALS + (spoke % N_RADIALS)

    def _build_edges(self) -> list[tuple[int, int, float, bool]]:
        """(u, v, длина_км, это_радиал)"""
        edges: list[tuple[int, int, float, bool]] = []

        # Рёбра вдоль колец.
        for ring in range(1, len(RING_RADII_KM)):
            for spoke in range(N_RADIALS):
                u = self._node_at(ring, spoke)
                v = self._node_at(ring, spoke + 1)
                a, b = self.nodes[u], self.nodes[v]
                edges.append((u, v, haversine_km(a.lat, a.lon, b.lat, b.lon), False))

        # Радиалы: центр -> кольцо 1 -> ... -> МКАД.
        for spoke in range(N_RADIALS):
            for ring in range(len(RING_RADII_KM) - 1):
                u = self._node_at(ring, spoke)
                v = self._node_at(ring + 1, spoke)
                if u == v:
                    continue
                a, b = self.nodes[u], self.nodes[v]
                edges.append((u, v, haversine_km(a.lat, a.lon, b.lat, b.lon), True))

        return edges

    def _build_matrices(self) -> None:
        n = len(self.nodes)
        for hour in HOURS:
            rows, cols, vals = [], [], []
            for u, v, dist_km, is_radial in self._edges:
                if is_radial:
                    ring = min(self.nodes[u].ring, self.nodes[v].ring)
                    speed = RADIAL_SPEED_KMH[min(ring, len(RADIAL_SPEED_KMH) - 1)]
                    mult = _rush(RUSH_RADIAL, hour)
                else:
                    speed = RING_SPEED_KMH[self.nodes[u].ring]
                    mult = _rush(RUSH_RING, hour)
                minutes = dist_km / speed * 60.0 * mult
                # Дороги двусторонние.
                rows += [u, v]
                cols += [v, u]
                vals += [minutes, minutes]
            graph = coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()
            self._matrices[hour] = dijkstra(graph, directed=False).astype(np.float32)

    # ---------- запросы ----------

    def nearest_node(self, lat: float, lon: float) -> int:
        best, best_d = 0, float("inf")
        for node in self.nodes:
            d = (node.lat - lat) ** 2 + (node.lon - lon) ** 2
            if d < best_d:
                best, best_d = node.idx, d
        return best

    def path_nodes(self, from_node: int, to_node: int, depart_minute: int) -> list[int]:
        """
        Узлы кратчайшего пути — чтобы маршрут на карте шёл по улицам, а не
        прямой линией через кварталы. Матрица предшественников считается
        лениво: она нужна только при выгрузке для фронта.
        """
        if from_node == to_node:
            return [from_node]

        hour = max(7, min(20, depart_minute // 60))
        if hour not in self._predecessors:
            rows, cols, vals = [], [], []
            for u, v, dist_km, is_radial in self._edges:
                if is_radial:
                    ring = min(self.nodes[u].ring, self.nodes[v].ring)
                    speed = RADIAL_SPEED_KMH[min(ring, len(RADIAL_SPEED_KMH) - 1)]
                    mult = _rush(RUSH_RADIAL, hour)
                else:
                    speed = RING_SPEED_KMH[self.nodes[u].ring]
                    mult = _rush(RUSH_RING, hour)
                minutes = dist_km / speed * 60.0 * mult
                rows += [u, v]
                cols += [v, u]
                vals += [minutes, minutes]
            n = len(self.nodes)
            graph = coo_matrix((vals, (rows, cols)), shape=(n, n)).tocsr()
            _, pred = dijkstra(graph, directed=False, return_predecessors=True)
            self._predecessors[hour] = pred

        pred = self._predecessors[hour]
        path = [to_node]
        cur = to_node
        guard = 0
        while cur != from_node and guard < len(self.nodes):
            cur = int(pred[from_node, cur])
            if cur < 0:
                return [from_node, to_node]
            path.append(cur)
            guard += 1
        path.reverse()
        return path

    def path_latlon(self, from_node: int, to_node: int,
                    depart_minute: int) -> list[list[float]]:
        """
        Ломаная пути в координатах — то, что кладётся в полилинию карты.

        Один и тот же метод есть у настоящей сети (`core/osm.py`), только
        там он отдаёт линию по реальным улицам, а не по узлам выдуманного
        графа. Выгрузка вызывает его, не зная, какая сеть под ней.
        """
        return [[self.nodes[n].lat, self.nodes[n].lon]
                for n in self.path_nodes(from_node, to_node, depart_minute)]

    def travel_minutes(self, from_node: int, to_node: int,
                       depart_minute: int, transport: str = "car") -> float:
        """
        Время в пути в минутах. depart_minute — минуты от 00:00 суток.
        Плюс 3 минуты «последней мили»: припарковаться, найти подъезд.

        Настоящего километража у синтетической сети нет, поэтому для
        всех типов транспорта, кроме автомобиля, время получается
        множителем. На настоящей карте это считается честнее — см.
        `osm.OSMNetwork.travel_minutes`.
        """
        if from_node == to_node:
            return 3.0
        # Границы берутся у самих матриц: они построены один раз, и
        # спрашивать у них час, которого в них нет, нельзя. Раньше здесь
        # стояло зашитое `min(20, ...)`, и дописанные в таблицу часы
        # молча не применялись.
        hour = max(min(self._matrices),
                   min(max(self._matrices), depart_minute // 60))
        car = float(self._matrices[hour][from_node, to_node])
        if transport == "car":
            return car + 3.0
        from .domain import TRANSPORT
        spec = TRANSPORT[transport]
        return car * spec["mult"] + spec["wait"] + 3.0

    def road_km_between(self, from_node: int, to_node: int) -> float:
        """Пробег в километрах. Синтетическая сеть строилась по прямым
        расстояниям между узлами — отдаём их, помня, что это оценка."""
        if from_node == to_node:
            return 0.0
        a, b = self.nodes[from_node], self.nodes[to_node]
        return haversine_km(a.lat, a.lon, b.lat, b.lon) * 1.3


# --- Районы Москвы: имя, координаты центра, вес по населению ---

DISTRICTS: list[tuple[str, float, float, float]] = [
    ("Арбат", 55.7520, 37.5910, 0.6), ("Басманный", 55.7660, 37.6790, 1.7),
    ("Замоскворечье", 55.7350, 37.6300, 0.6), ("Красносельский", 55.7800, 37.6600, 0.9),
    ("Мещанский", 55.7800, 37.6300, 0.7), ("Пресненский", 55.7620, 37.5600, 1.3),
    ("Таганский", 55.7420, 37.6650, 1.3), ("Тверской", 55.7700, 37.6000, 0.8),
    ("Хамовники", 55.7300, 37.5800, 1.1), ("Якиманка", 55.7300, 37.6100, 0.3),
    ("Аэропорт", 55.8000, 37.5350, 1.0), ("Беговой", 55.7830, 37.5620, 0.6),
    ("Войковский", 55.8180, 37.4980, 0.8), ("Головинский", 55.8480, 37.4930, 1.0),
    ("Тимирязевский", 55.8250, 37.5680, 0.9), ("Хорошёвский", 55.7830, 37.5150, 0.8),
    ("Бибирево", 55.8880, 37.6000, 1.6), ("Отрадное", 55.8620, 37.6050, 1.8),
    ("Медведково", 55.8880, 37.6520, 1.4), ("Марьина Роща", 55.7950, 37.6180, 0.7),
    ("Богородское", 55.8150, 37.7080, 1.0), ("Гольяново", 55.8150, 37.8100, 1.6),
    ("Измайлово", 55.7900, 37.7650, 1.1), ("Перово", 55.7500, 37.7860, 1.4),
    ("Соколиная Гора", 55.7800, 37.7400, 0.8), ("Новогиреево", 55.7500, 37.8150, 1.0),
    ("Выхино", 55.7100, 37.8200, 1.9), ("Кузьминки", 55.7050, 37.7650, 1.3),
    ("Люблино", 55.6800, 37.7550, 1.7), ("Марьино", 55.6500, 37.7450, 2.5),
    ("Текстильщики", 55.7050, 37.7350, 0.9), ("Печатники", 55.6900, 37.7300, 0.8),
    ("Бирюлёво", 55.5900, 37.6600, 1.6), ("Царицыно", 55.6200, 37.6700, 1.3),
    ("Чертаново", 55.6200, 37.6050, 2.4), ("Нагатино", 55.6800, 37.6700, 1.1),
    ("Даниловский", 55.7100, 37.6300, 0.9), ("Ясенево", 55.6050, 37.5300, 1.7),
    ("Тёплый Стан", 55.6200, 37.5000, 1.3), ("Коньково", 55.6350, 37.5300, 1.2),
    ("Черёмушки", 55.6700, 37.5600, 0.9), ("Обручевский", 55.6600, 37.5300, 0.7),
    ("Раменки", 55.7000, 37.5000, 1.1), ("Кунцево", 55.7300, 37.4200, 1.0),
    ("Крылатское", 55.7550, 37.4100, 0.8), ("Строгино", 55.8050, 37.4050, 1.2),
    ("Митино", 55.8450, 37.3600, 1.8), ("Тушино", 55.8350, 37.4350, 1.6),
    ("Щукино", 55.8050, 37.4650, 0.9), ("Солнцево", 55.6450, 37.3900, 1.3),
]
