"""
Какая сеть под стендом.

Их две, и обе настоящие в своём смысле:

  `core/osm.py`  — Москва по OpenStreetMap: настоящие адреса, настоящие
                   дороги, время в пути от OSRM плюс наш почасовой
                   профиль пробок. Это то, что видит пользователь на
                   карте, и то, на чём сняты все числа;
  `core/geo.py`  — радиально-кольцевая модель на 289 узлов. Она осталась
                   запасным вариантом: ей не нужны ни файлы данных, ни
                   интернет, и она строится из ничего.

Выбор один на весь стенд и делается здесь, а не восемнадцатью вызовами
`RoadNetwork()` по модулям — иначе половина замеров однажды окажется
сделанной на одной сети, а половина на другой.
"""

from __future__ import annotations

import os

from .geo import RoadNetwork

# Переменная окружения для запасного пути: пригодится, если файлы данных
# по какой-то причине недоступны, а посчитать надо прямо сейчас.
FORCE_SYNTHETIC = "VRPTW_SYNTHETIC_MAP"


def default_network():
    """Настоящая карта, если данные на месте; синтетическая иначе."""
    if os.environ.get(FORCE_SYNTHETIC):
        return RoadNetwork()
    try:
        from .osm import ADDRESS_FILE, MATRIX_FILE, OSMNetwork
        if ADDRESS_FILE.exists() and MATRIX_FILE.exists():
            return OSMNetwork()
    except Exception as exc:      # noqa: BLE001
        print(f"  настоящая карта не загрузилась ({exc}), беру синтетическую")
    return RoadNetwork()


def describe(net) -> str:
    """Строка для шапки замера: на какой карте он сделан."""
    if getattr(net, "has_addresses", False):
        return f"настоящая карта: {len(net.nodes)} адресов Москвы, дороги OSM"
    return f"синтетическая сеть: {len(net.nodes)} узлов радиально-кольцевой модели"
