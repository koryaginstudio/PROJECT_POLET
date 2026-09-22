"""
Прямое геокодирование: почтовый адрес заказчика → координата.

В `osm.py` геокодер обратный — он спрашивает «какой дом стоит в этой
точке» и нужен был, чтобы собрать пул синтетических адресов. Настоящие
данные приходят наоборот: текстом вида
«Город Москва, ул.Грайвороновская, д. 10 к 2», а координат в них нет
вообще. Без координат не построить сеть, то есть не посчитать ни время в
пути, ни пробег — обе обязательные метрики ТЗ.

Результат кладётся в постоянный кэш рядом с остальными данными. Это не
оптимизация, а требование к демонстрации: на защите интернета может не
быть, а день должен грузиться.

Что делать, когда дом не нашёлся, решает не этот модуль: он честно
проставляет `quality` и отдаёт решение выше. Тихо подставить центр
района было бы худшим из вариантов — ошибка в километр размазалась бы по
всем маршрутам и по обеим метрикам сразу.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
CACHE_FILE = DATA_DIR / "geocode.json"

NOMINATIM = "https://nominatim.openstreetmap.org/search"
PHOTON = "https://photon.komoot.io/api/"
USER_AGENT = "vrptw-hackathon-stand/1.1 (разовая сборка кэша адресов)"

# Nominatim просит не чаще одного запроса в секунду. Просьбу соблюдаем:
# адресов две сотни, это три с половиной минуты один раз за проект.
PAUSE = 1.4

# Типы улиц в выгрузке заказчика идут сокращением вплотную к названию:
# «ул.Грайвороновская», «пр-кт.Волгоградский». Nominatim такое понимает
# плохо, а «Грайвороновская улица» — хорошо.
STREET_KINDS = {
    "ул": "улица",
    "пр-кт": "проспект",
    "б-р": "бульвар",
    "проезд": "проезд",
    "пер": "переулок",
    "наб": "набережная",
    "ш": "шоссе",
    "туп": "тупик",
    "аллея": "аллея",
    "пл": "площадь",
    "пр-зд": "проезд",
    "пр-д": "проезд",
}

# Города, которые встречаются в выгрузке приклеенными к названию улицы:
# «МО, г. Кашира Кржижановского ул.». Список маленький и закрытый —
# зона обслуживания у заказчика своя, и угадывать тут нечего.
CITIES = {"Москва", "Кашира", "Ступино", "Домодедово", "Видное", "Подольск"}

# Населённый пункт тоже приходит в нескольких видах, включая «г.Город
# Москва» и голое «МО».
CITY_FIXES = {
    "город москва": "Москва",
    "г.город москва": "Москва",
    "г. москва": "Москва",
    "г.москва": "Москва",
    "москва": "Москва",
    "мо": "Московская область",
    "обл.московская область": "Московская область",
}


def _clean_house(text: str) -> str:
    """«д. 128 к 5» → «128к5», «д. 17 стр. 1» → «17с1»."""
    t = re.sub(r"^\s*д\.?\s*", "", text.strip(), flags=re.I)
    t = re.sub(r"\s*к\.?\s*(\d)", r"к\1", t, flags=re.I)
    t = re.sub(r"\s*стр\.?\s*(\d)", r"с\1", t, flags=re.I)
    t = re.sub(r"\s*корп\.?\s*(\d)", r"к\1", t, flags=re.I)
    return t.strip()


def parse_address(raw: str) -> dict:
    """
    Разобрать строку заказчика на город, улицу и дом.

    Форматов в выгрузке не один, а пять, и все встречаются вперемешку:

        Город Москва, ул.Грайвороновская, д. 10 к 2   тип вплотную, спереди
        г. Москва, ул Бирюлёвская, д 1с1              тип спереди, без точки
        МО, г. Кашира Кржижановского ул. д. 5/1       тип сзади, без запятых
        Москва Бирюлевская ул. д. 44                  то же, без области
        г.Город Москва, пр-кт.Ленинский, д. 70/11     город продублирован

    Поэтому разбираем не по позициям, а по признакам: сначала вырезаем
    дом, потом ищем тип улицы где угодно, остаток считаем городом.
    """
    text = raw.strip()

    # --- дом ---
    house = ""
    m = re.search(r"(?:^|[,\s])д\.?\s*([0-9][^,]*)$", text, flags=re.I)
    if m:
        house = _clean_house("д. " + m.group(1))
        text = text[:m.start()].strip(" ,")

    parts = [p.strip() for p in text.split(",") if p.strip()]

    # --- улица: тип может стоять где угодно внутри куска ---
    #
    # «ул.Грайвороновская», «ул Бирюлёвская», «Бирюлевская ул.»,
    # «г.Москва проезд Симферопольский» — во всех четырёх тип улицы это
    # один и тот же токен, просто в разном месте. Ищем его, а не позицию.
    kinds = "|".join(sorted(STREET_KINDS, key=len, reverse=True))
    kind_re = rf"(?<![А-Яа-яё])({kinds})\.?(?![А-Яа-яё])"

    street = ""
    city_inline = ""
    street_at = -1

    for i, part in enumerate(parts):
        m = re.search(kind_re, part, flags=re.I)
        if not m:
            continue
        kind = STREET_KINDS[m.group(1).lower()]
        before = part[:m.start()].strip(" .,")
        after = part[m.end():].strip(" .,")

        # Город мог прилипнуть слева от типа улицы.
        cm = re.match(r"^г\.?\s*([А-ЯЁ][а-яё\-]+)\b\s*", before)
        if cm:
            city_inline, before = cm.group(1), before[cm.end():].strip()
        else:
            cm = re.match(r"^([А-ЯЁ][а-яё\-]+)\s+(?=\S)", before)
            if cm and cm.group(1) in CITIES:
                city_inline, before = cm.group(1), before[cm.end():].strip()

        name = after or before
        if not name:
            continue
        street, street_at = f"{name} {kind}", i
        break

    # --- город: приклеенный побеждает, иначе первый кусок не-улица ---
    city = city_inline
    if not city:
        for i, part in enumerate(parts):
            if i == street_at:
                continue
            city = part.strip()
            break

    city = CITY_FIXES.get(city.lower().strip(), city.strip())
    city = re.sub(r"^г\.?\s*", "", city).strip()
    city = CITY_FIXES.get(city.lower(), city)

    return {"city": city, "street": street.strip(), "house": house}


def query_text(raw: str) -> str:
    """Строка, которую отдаём Nominatim."""
    a = parse_address(raw)
    bits = [b for b in (a["street"], a["house"], a["city"]) if b]
    return ", ".join(bits) if len(bits) >= 2 else raw


class ОтказСервиса(RuntimeError):
    """Nominatim ответил не результатом, а отказом (429, 5xx, пустотой).

    Отдельный тип нужен ровно за тем, чтобы отказ нельзя было перепутать
    с «дома нет в OSM». Первый раз я это перепутал: сервис начал отдавать
    429 на середине списка, а в кэш легли 68 адресов с пометкой «не
    найдено» — то есть молчаливо неверные данные, на которых потом
    строился бы каждый маршрут.
    """


def _search(query: str, limit: int = 1) -> list[dict]:
    """
    Один запрос. Пустой список — честное «не нашлось».
    Отказ сервиса — исключение, а не пустой список.
    """
    url = (f"{NOMINATIM}?format=jsonv2&limit={limit}&accept-language=ru"
           f"&countrycodes=ru&q=" + _urlencode(query))
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "--max-time", "25",
           "-H", f"User-Agent: {USER_AGENT}", url]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8").stdout
    if not out:
        raise ОтказСервиса("пустой ответ")

    body, _, code = out.rpartition("\n")
    code = code.strip()
    if code != "200":
        raise ОтказСервиса(f"HTTP {code or '—'}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        raise ОтказСервиса("ответ не JSON")
    return data if isinstance(data, list) else []


def _search_photon(query: str) -> list[dict]:
    """
    Запасной геокодер — Photon, те же данные OSM, другой сервер.

    Нужен не для красоты: публичный Nominatim блокирует по частоте, а
    без координат день не собрать вообще. Photon к частоте терпимее,
    но номер дома находит хуже — поэтому он второй, а не первый, и
    качество его ответа помечается честно.

    Язык «ru» он не поддерживает (только default/de/en/fr), а на
    `lang=ru` отвечает четырёхсотым — на это я уже наступил.
    """
    url = f"{PHOTON}?limit=1&lang=default&q=" + _urlencode(query)
    cmd = ["curl", "-s", "-w", "\n%{http_code}", "--max-time", "25",
           "-H", f"User-Agent: {USER_AGENT}", url]
    out = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8").stdout
    if not out:
        raise ОтказСервиса("photon: пустой ответ")
    body, _, code = out.rpartition("\n")
    if code.strip() != "200":
        raise ОтказСервиса(f"photon: HTTP {code.strip() or '—'}")
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        raise ОтказСервиса("photon: ответ не JSON")

    out_hits = []
    for f in (data.get("features") or [])[:1]:
        lon, lat = f["geometry"]["coordinates"]
        pr = f.get("properties", {})
        out_hits.append({
            "lat": lat, "lon": lon,
            "display_name": ", ".join(
                x for x in (pr.get("name"), pr.get("housenumber"),
                            pr.get("street"), pr.get("city")) if x),
            # Photon честно говорит, дом это или улица.
            "_house": bool(pr.get("housenumber")) or pr.get("type") == "house",
            "_provider": "photon",
        })
    return out_hits


def _search_uporno(query: str, tries: int = 5) -> list[dict]:
    """Тот же запрос, но переживающий ограничение частоты.

    Пауза растёт: 5, 10, 20, 40 секунд. Если и после этого отказ —
    поднимаем наверх, чтобы прогон остановился с внятной причиной, а не
    дописал в кэш выдумку."""
    for попытка in range(tries):
        try:
            return _search(query)
        except ОтказСервиса as e:
            if попытка == tries - 1:
                raise
            пауза = 5 * (2 ** попытка)
            print(f"    сервис отказал ({e}); жду {пауза} с")
            time.sleep(пауза)
    return []


def _urlencode(s: str) -> str:
    from urllib.parse import quote

    return quote(s, safe="")


def load_cache(path: Path | None = None) -> dict:
    path = path or CACHE_FILE
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_cache(cache: dict, path: Path | None = None) -> None:
    path = path or CACHE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, ensure_ascii=False, indent=1,
                               sort_keys=True), encoding="utf-8")


def known(addresses, cache_file: Path | None = None) -> dict:
    """Что уже известно, без единого запроса: кэш репозитория и свой.

    Для предпросмотра выгрузки и для сборки её дня: ни то ни другое не
    должно ждать сети. Нет строки в ответе — адрес ещё не искали."""
    cache = load_cache()
    if cache_file is not None:
        cache = {**cache, **load_cache(cache_file)}
    return {a: cache[a] for a in addresses if a in cache}


def _без_сети() -> bool:
    return bool(os.environ.get("VRPTW_OFFLINE"))


def geocode_all(addresses, refresh: bool = False, quiet: bool = False,
                cache_file: Path | None = None, progress=None,
                отчёт: dict | None = None) -> dict:
    """
    Геокодировать набор адресов, дополняя постоянный кэш.

    Отдаёт словарь «исходная строка → запись». В записи всегда есть
    `quality`:

      `house`  — найден дом, координата точная;
      `street` — дом не нашёлся, взята улица: ошибка в сотни метров;
      `none`   — не нашлось ничего, координаты нет.

    Качество идёт дальше вместе с координатой, чтобы загрузчик мог
    решить, что делать, а проверка дня — сказать об этом вслух.

    `cache_file` — свой кэш: выгрузки, которые приносит диспетчер, ищут
    адреса туда, а кэш репозитория только читают. Иначе первая же чужая
    выгрузка меняла бы файл данных демонстрации.

    **Нет связи — не «не найдено».** Прежде, когда молчали все три
    запроса, в кэш ложилось `none`, и адрес, который просто не удалось
    спросить без интернета, навсегда числился ненайденным: интернет
    появлялся, а заявка так и оставалась без координаты. Теперь такой
    адрес в кэш не пишется и попадает в `отчёт["нет_связи"]`; а если сеть
    молчит на трёх адресах подряд, остальные даже не спрашиваются — это
    был бы час ожидания отступов на выгрузке в сотню строк.

    `progress(сделано, всего)` зовётся после каждого адреса.
    """
    cache = load_cache()
    своё = load_cache(cache_file) if cache_file is not None else cache
    if cache_file is not None:
        cache = {**cache, **своё}
    todo = [a for a in dict.fromkeys(addresses)
            if refresh or a not in cache]
    нет_связи: list[str] = []

    if todo and not quiet:
        print(f"  геокодирую {len(todo)} адресов "
              f"(≈{len(todo) * PAUSE / 60:.1f} мин, кэш {len(cache)})")

    def записать() -> None:
        save_cache(своё, cache_file)

    отказы = 0
    молчит_подряд = 0
    for i, raw in enumerate(todo, 1):
        if _без_сети() or молчит_подряд >= 3:
            нет_связи.append(raw)
            if progress:
                progress(i, len(todo))
            continue
        запрос = query_text(raw)
        hits, quality, provider = [], "none", ""
        # Ответил ли хоть один сервис — пусть и пустотой. Если нет, это
        # не «адреса нет», а «спросить не получилось».
        ответил = False

        # 1. Nominatim — точнее всех по номеру дома. Но если он уже
        # дважды подряд отказал, значит нас заблокировали по частоте:
        # дальше дёргать его бессмысленно, это только отступы по 15 с
        # на каждый адрес. Молча переходим на запасной.
        if отказы < 2:
            try:
                hits = _search_uporno(запрос, tries=2)
                ответил = True
                if hits:
                    quality, provider = "house", "nominatim"
                отказы = 0
            except ОтказСервиса as e:
                отказы += 1
                if отказы == 2 and not quiet:
                    print(f"    Nominatim блокирует ({e}) — дальше Photon")
                hits = []

        # 2. Photon — когда первый отказал или ничего не нашёл.
        if not hits:
            try:
                time.sleep(0.3)
                hits = _search_photon(запрос)
                ответил = True
                if hits:
                    quality = "house" if hits[0].get("_house") else "street"
                    provider = "photon"
            except ОтказСервиса:
                hits = []

        # 3. Совсем ничего — пробуем хотя бы улицу.
        if not hits:
            a = parse_address(raw)
            if a["street"] and a["city"]:
                try:
                    time.sleep(0.3)
                    hits = _search_photon(f"{a['street']}, {a['city']}")
                    ответил = True
                    if hits:
                        quality, provider = "street", "photon"
                except ОтказСервиса:
                    hits = []

        if hits:
            запись = {
                "lat": round(float(hits[0]["lat"]), 6),
                "lon": round(float(hits[0]["lon"]), 6),
                "quality": quality,
                "provider": provider,
                "matched": str(hits[0].get("display_name", ""))[:120],
            }
        elif ответил:
            запись = {"lat": None, "lon": None, "quality": "none",
                      "provider": "", "matched": ""}
        else:
            запись = None
            нет_связи.append(raw)
        молчит_подряд = 0 if ответил else молчит_подряд + 1
        if запись is not None:
            cache[raw] = своё[raw] = запись

        if i % 20 == 0:
            записать()                 # прогон может прерваться — не терять
        if progress:
            progress(i, len(todo))
        if not quiet and (i % 25 == 0 or i == len(todo)):
            print(f"    {i}/{len(todo)}")
        if i < len(todo) and молчит_подряд < 3 and not _без_сети():
            time.sleep(PAUSE)

    if todo and len(нет_связи) < len(todo):
        записать()
    if отчёт is not None:
        отчёт["нет_связи"] = нет_связи
    return {a: cache[a] for a in addresses if a in cache}


def report(found: dict) -> str:
    """Короткая сводка по качеству — её печатает и загрузчик, и CLI."""
    kinds = {"house": 0, "street": 0, "none": 0}
    for rec in found.values():
        kinds[rec.get("quality", "none")] += 1
    return (f"дом {kinds['house']}, улица {kinds['street']}, "
            f"не найдено {kinds['none']} из {len(found)}")


def main(argv: list[str]) -> int:
    from .load import read_orders_csv          # локально: только для CLI

    if not argv:
        print("использование: python3 -m vrptw.core.geocode файл.csv [ещё.csv]")
        return 2

    texts: list[str] = []
    for path in argv:
        rows, office = read_orders_csv(Path(path))
        texts += [r["address"] for r in rows if r["address"]]
        if office:
            texts.append(office)

    found = geocode_all(texts)
    print(f"\n  {report(found)}")

    bad = [a for a, r in found.items() if r["quality"] != "house"]
    if bad:
        print("\n  не нашлись домом:")
        for a in bad[:20]:
            print(f"    [{found[a]['quality']}] {a}")
        if len(bad) > 20:
            print(f"    ... ещё {len(bad) - 20}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
