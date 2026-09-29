"""Сборка набора данных из выгрузки «Билайн Бизнес».

Что на входе. Шесть файлов в `source/`: три зоны (Восток, Юго-Восток, Центр),
каждая в двух видах — «интегральное распределение» с настоящими номерами
заявок, статусами и бригадами и «синтетические данные», те же строки без них.
Считаем по интегральному: в нём есть бригады, без которых инженеров взять
неоткуда.

Чего на входе нет. Выгрузка — это наряды учётной системы, а не набор для
планировщика. В ней нет координат, нет длительности работ, нет требуемого
навыка, нет транспорта и нет самих инженеров — бригада в ней лишь подпись в
строке наряда. ТЗ такой случай предусматривает прямо: если готовый набор не
предоставлен, команда собирает его сама по тем же правилам и описывает принятые
допущения. Все допущения этого файла перечислены в `README.md` рядом.

Что на выходе. По каждой зоне — две формы контракта 1.2, `orders.json` и
`engineers.json`, плюс та же выгрузка заявок плоским CSV для загрузки прямо в
интерфейс. Общий `dictionaries.json` — подписи ко всем кодам, которые
встретились. Зона — это готовый день по мерке ТЗ: десять-пятнадцать инженеров и
меньше сотни заявок.

Запуск: python3 dataset/build.py
Первый прогон ходит в геокодер и занимает несколько минут; дальше работает с
`geocache.json` и в сеть не выходит вовсе.
"""

from __future__ import annotations

import csv
import json
import re
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SOURCE = ROOT / "source"
OUT = ROOT / "out"
GEOCACHE = ROOT / "geocache.json"

SCHEMA = "1.2"
DATE = "2026-08-17"

# Рабочий день сервиса. Выгрузка ставит окна приёма с 10:00 до 22:00, а у
# аварий на сети окно круглосуточное — «00:01–23:59», что означает не ночную
# смену, а отсутствие договорённости с абонентом: чинить можно когда угодно.
# Для планировщика «когда угодно» — это когда угодно в рабочий день, иначе он
# честно предложит выехать в половине первого ночи.
DAY_OPEN = 7 * 60
DAY_CLOSE = 22 * 60
SHIFT_MIN = 9 * 60
# Окно шире этого в расчёт смены не идёт: круглосуточная авария сказала бы про
# график бригады только то, что график ей не писан.
WINDOW_SPAN_LIMIT = 6 * 60

# ─── зоны ────────────────────────────────────────────────────────────────────
#
# Адрес офиса записан в самой выгрузке последней строкой — оттуда инженеры и
# выезжают. Это единственное место, где выгрузка говорит хоть что-то о том, где
# люди начинают день, и выдумывать взамен ничего не пришлось.

ZONES = {
    "east": {
        "title": "Восток",
        "office": "Москва, улица Юных Ленинцев, 83с4",
    },
    "southeast": {
        "title": "Юго-Восток",
        "office": "Москва, Бирюлёвская улица, 1с1",
    },
    "center": {
        "title": "Центр",
        "office": "Москва, Симферопольский проезд, 7",
    },
}

# ─── справочник навыков ──────────────────────────────────────────────────────
#
# Три навыка ТЗ ложатся на колонку «Тип заявки BK» один в один, и это главная
# удача этой сборки: классификация не выдумана нами, а взята из учётной системы
# заказчика. Подключение и дозаказ — один навык, как и написано в ТЗ.

ORDER_CLASS = {
    "Подключение": ("connection", "connect"),
    "Дозаказ": ("addon", "connect"),
    "Локальная заявка": ("incident", "local"),
    "Глобальная проблема": ("outage", "emergency"),
}

# ─── типы работ ──────────────────────────────────────────────────────────────
#
# Длительности выгрузка не содержит вовсе: у наряда есть окно приёма в два часа,
# но сколько из них занимает работа — не записано. Числа ниже — допущение,
# и оно построено на одном правиле: сколько времени работа занимает у человека
# на объекте. Замена коробки — полчаса, протяжка кабеля в стояке — час с
# четвертью, авария на сети — полтора часа.
#
# `car` в третьей колонке — требование по транспорту. Выгрузка его тоже не
# содержит, и ставится оно не наугад: везти катушку кабеля, стремянку и
# сварочный аппарат пешком нельзя. На остальных работах ограничения нет — ТЗ
# прямо говорит, что тип транспорта указывается только при его наличии.

WORK_TYPES = {
    # тип работ из выгрузки: (минут, оборудование, требуемый транспорт)
    "Авария": (90, [], "car"),
    "Работа с кабелем": (75, ["cable"], "car"),
    "Заявка на подключение": (90, ["router"], "car"),
    "Заказ подключения/Дозаказ оборудования": (75, ["router"], "car"),
    "Конвергенция абонента": (60, ["router"], None),
    "Дозаказ оборудования": (45, ["router"], None),
    "Нет линка": (60, [], None),
    "Разрывы": (60, [], None),
    "Низкая скорость": (45, [], None),
    "Рост ошибок на порту": (45, [], None),
    "Переключение на Гбит/с": (45, ["router"], None),
    "IP-адрес 169...": (30, [], None),
    "Мониторинг": (30, [], None),
    "Информация": (30, [], None),
    "Роутер. Замена техническим специалистом": (30, ["router"], None),
    "TVE/ENT. Замена приставки техником": (30, ["stb"], None),
    "ТВ. Замена приставки техником": (30, ["stb"], None),
    "TVE/ENT. Другие ошибки": (45, ["stb"], None),
}

DEFAULT_WORK = (60, [], None)

# Статусы наряда — колонка «Статус BK». Семь значений, готовый жизненный цикл.
STATUS = {
    "Не отправлена": "draft",
    "Отправлена": "sent",
    "В пути": "en_route",
    "В работе": "in_progress",
    "Выполнена": "done",
    "Отменена": "cancelled",
    "Просрочена": "overdue",
}

# ─── подписи для пятой формы контракта ───────────────────────────────────────

SKILL_NAMES = {
    "local": "Локальные работы",
    "connect": "Работы на подключение и дозаказы",
    "emergency": "Аварийные работы",
}
TRANSPORT_NAMES = {
    "car": "Автомобиль",
    "walk": "Пешеход",
    "bike": "Велосипед",
    "transit": "Общественный транспорт",
}
ORDER_CLASS_NAMES = {
    "connection": "Подключение",
    "addon": "Дозаказ",
    "incident": "Локальная заявка",
    "outage": "Глобальная проблема",
}
STATUS_NAMES = {code: title for title, code in STATUS.items()}
EQUIPMENT_NAMES = {
    "router": "Роутер",
    "stb": "ТВ-приставка",
    "ont": "Оптический терминал",
    "cable": "Кабель",
    "splitter": "Сплиттер",
}

# ─── адрес ───────────────────────────────────────────────────────────────────
#
# Адрес в выгрузке записан сокращениями учётной системы и в обратном порядке:
# «ул.Михайлова, д. 14, кв. 13». Геокодеру нужно «Москва, улица Михайлова, 14»,
# и номер квартиры ему только мешает — дом он и так найдёт, а квартира к тому же
# единственное в строке, что относится к живому человеку, и в набор она не
# попадает.

STREET_KINDS = {
    "ул": "улица",
    "пр-кт": "проспект",
    "просп": "проспект",
    "б-р": "бульвар",
    "бул": "бульвар",
    "пер": "переулок",
    "наб": "набережная",
    "ш": "шоссе",
    "проезд": "проезд",
    "пл": "площадь",
    "туп": "тупик",
    "аллея": "аллея",
    "кв-л": "квартал",
}


def normalize_address(raw: str) -> str:
    """Адрес из выгрузки в вид, который понимает геокодер."""
    text = raw.strip()
    text = re.sub(r"\bкв\.\s*\d+\w*", "", text)  # квартира геокодеру не нужна
    text = re.sub(r"\bг\.?\s*Город\s+Москва", "Москва", text)
    text = re.sub(r"\bГород\s+Москва", "Москва", text)
    text = re.sub(r"^\s*г\.\s*", "", text)
    text = re.sub(r"\bобл\.[^,]+,\s*", "", text)
    text = re.sub(r"\bМО\b,?\s*", "", text)
    text = re.sub(r"\bг\.\s*", "", text)
    text = re.sub(r"\bпгт\.[^,]+,\s*", "", text)

    # Номер дома снимаем раньше всех сокращений: «д.» неотличимо от сокращения
    # вида улицы, и общее правило ниже превратило бы его в слово.
    text = re.sub(r"\bд\.\s*", "", text)  # «д. 14» → «14»
    text = re.sub(r"\bдом\s+", "", text)
    text = re.sub(r"\s*стр\.\s*(\d+)", r"с\1", text)  # «28 стр. 1» → «28с1»
    text = re.sub(r"\s*корп\.\s*(\d+)", r"к\1", text)

    # «ул.Михайлова» → «улица Михайлова», «пр-кт.Рязанский» → «проспект Рязанский»
    def kind(match: re.Match[str]) -> str:
        return STREET_KINDS.get(match.group(1).lower(), match.group(1)) + " "

    text = re.sub(r"\b([А-Яа-я\-]+)\.\s*(?=[А-ЯЁ0-9])", kind, text)
    # «Центральная ул.» — в адресах области сокращение стоит после названия
    text = re.sub(r"\bул\.?(?=\s|$)", "улица", text)
    text = re.sub(r"\bпр-зд\.?(?=\s|$)", "проезд", text)
    text = re.sub(r"\bпр-кт\.?(?=\s|$)", "проспект", text)

    text = re.sub(r"\s*к\s*(\d+)", r"к\1", text)  # «14 к 2» → «14к2»

    # В адресах области город и улица слиты без запятой: «Кашира Центральная
    # улица 21». Геокодер разберёт и так, но с запятой отвечает увереннее.
    for town in (*TOWN_ANCHORS, "Москва"):
        text = re.sub(rf"^{town}\s+(?=[А-ЯЁ])", f"{town}, ", text)

    text = re.sub(r"\s{2,}", " ", text)
    text = re.sub(r"\s*,\s*", ", ", text).strip(" ,")
    return text


# ─── порядок слов в названии улицы ───────────────────────────────────────────
#
# Учётная система пишет вид улицы первым всегда: «б-р.Ореховый», «проезд.3-й
# Павелецкий». По-русски так говорят не про всякую улицу: «улица Михайлова» —
# да, а «бульвар Ореховый» — нет, бульвар Ореховый. Разница в том, чем названа
# улица: фамилией в родительном падеже или прилагательным. Геокодер эту разницу
# чувствует и на неправильном порядке дом не находит.
#
# Поэтому вторая попытка: если название — прилагательное или начинается с
# порядкового номера, вид улицы переставляется на своё место. Первая попытка
# остаётся как есть — переставлять «улицу Михайлова» было бы ошибкой.

KIND_WORDS = set(STREET_KINDS.values())
ADJECTIVE = re.compile(r"(ый|ий|ой|ая|яя|ое|ее)$", re.IGNORECASE)
ORDINAL = re.compile(r"^\d+-[а-я]", re.IGNORECASE)


def swapped_street(address: str) -> str | None:
    """Тот же адрес с видом улицы на русском месте. `None` — переставлять нечего."""
    parts = [part.strip() for part in address.split(",")]
    for index, part in enumerate(parts):
        tokens = part.split()
        if len(tokens) < 2 or tokens[0].lower() not in KIND_WORDS:
            continue
        kind, name = tokens[0], tokens[1:]

        if ORDINAL.match(name[0]):
            # «1-я Дубровская улица», но «11-я улица Текстильщиков»: во втором
            # случае улица названа не признаком, а людьми, и номер относится к
            # улице, а не к ним.
            rest = name[1:]
            if rest and ADJECTIVE.search(rest[-1]):
                fixed = [*name, kind]
            else:
                fixed = [name[0], kind, *rest]
        elif ORDINAL.match(name[-1]):
            fixed = [name[-1], *name[:-1], kind]  # «проезд Советский 1-й»
        elif ADJECTIVE.search(name[-1]):
            fixed = [*name, kind]
        else:
            return None

        parts[index] = " ".join(fixed)
        return ", ".join(parts)
    return None


# Якоря на случай, когда геокодер дом не нашёл: центры городов области, куда
# выгрузка выходит за пределы Москвы. Внутри Москвы якорем служит любой другой
# уже найденный дом того же района — район там мельче, чем эта таблица.
TOWN_ANCHORS = {
    "Домодедово": (55.4413, 37.7664),
    "Кашира": (54.8356, 38.1664),
    "Ступино": (54.8897, 38.0779),
}
MOSCOW_ANCHOR = (55.7522, 37.6156)

# Рамки поиска для геокодера: «лево,верх,право,низ» в градусах. Москва в
# пределах кольцевой с запасом — Новая Москва сюда намеренно не входит, она
# начинается там же, где начинаются одноимённые улицы. Область — вся зона
# обслуживания вместе с Каширой и Ступином.
MOSCOW_BOX = "37.30,55.93,37.95,55.54"
REGION_BOX = "36.80,56.10,39.00,54.60"


class Geocoder:
    """Геокодер с кэшем на диске.

    Кэш здесь не ускорение, а условие воспроизводимости: сборка набора не должна
    зависеть от того, отвечает ли сегодня чужой сервис и не сменил ли он мнение
    о доме. Один раз найденное лежит рядом с исходниками и переживает всё.
    """

    def __init__(self) -> None:
        self.cache: dict[str, list[float] | None] = {}
        if GEOCACHE.exists():
            self.cache = json.loads(GEOCACHE.read_text(encoding="utf-8"))
        self.asked = 0

    def save(self) -> None:
        GEOCACHE.write_text(
            json.dumps(self.cache, ensure_ascii=False, indent=1), encoding="utf-8"
        )

    def ask(self, address: str) -> list[float] | None:
        # Рамка поиска. Без неё «улица Талалихина, 16» в Таганском находится в
        # Щербинке: улица с таким названием есть и там, а геокодер выбирает по
        # своему рейтингу, не по нашему району. Одноимённых улиц в городе и
        # области десятки, и каждая такая находка — визит за двадцать пять
        # километров, которого никто не заметит, пока не сложится пробег.
        box = MOSCOW_BOX if address.startswith("Москва") else REGION_BOX
        query = urllib.parse.quote(address)
        url = (
            f"https://nominatim.openstreetmap.org/search?q={query}"
            f"&format=json&limit=1&bounded=1&viewbox={box}"
        )
        request = urllib.request.Request(
            url, headers={"User-Agent": "polet-hackathon-dataset/1.0"}
        )
        found = None
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                data = json.load(response)
            if data:
                found = [round(float(data[0]["lat"]), 6), round(float(data[0]["lon"]), 6)]
        except Exception as error:  # сеть, лимит, мусор в ответе — всё едино
            print(f"    геокодер не ответил на «{address}»: {error}")

        self.asked += 1
        # Правило вежливости к бесплатному сервису: не чаще запроса в секунду.
        time.sleep(1.1)
        return found

    def find(self, address: str) -> tuple[float, float] | None:
        if address in self.cache:
            found = self.cache[address]
            return (found[0], found[1]) if found else None

        found = self.ask(address)
        if found is None:
            # Вторая попытка — с видом улицы на русском месте. Кэш при этом
            # остаётся на первом написании: спрашивают адрес из выгрузки, а
            # каким запросом он нашёлся, знать никому не нужно.
            other = swapped_street(address)
            if other:
                found = self.ask(other)

        self.cache[address] = found
        if self.asked % 20 == 0:
            self.save()
        return (found[0], found[1]) if found else None


# ─── разбор выгрузки ─────────────────────────────────────────────────────────


@dataclass
class Row:
    """Строка наряда, уже разобранная, но ещё не ставшая заявкой."""

    order_class: str
    skill: str
    status: str | None
    work_type: str
    window_start: int
    window_end: int
    district: str
    address: str
    team: str | None
    tech: str | None
    gigabit: bool | None
    needs_access: bool


def minutes_of(stamp: str) -> int:
    """«17.08.2026 20:00» → 1200 минут от полуночи."""
    match = re.search(r"(\d{1,2}):(\d{2})", stamp)
    if not match:
        raise ValueError(f"не разобралось время: {stamp!r}")
    return int(match.group(1)) * 60 + int(match.group(2))


def read_rows(path: Path) -> list[Row]:
    rows: list[Row] = []
    with path.open(encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for record in reader:
            klass = (record.get("Тип заявки BK") or "").strip()
            if klass not in ORDER_CLASS:
                continue  # пустые хвосты файла и строка с адресом офиса

            order_class, skill = ORDER_CLASS[klass]
            district = (record.get("Район") or "").strip()
            tech = (record.get("Подключение") or "").strip() or None

            # «GPON Даниловский» — это не район, а технология, приписанная к
            # району. Разводим обратно: району место в адресе, технологии — в
            # своём поле.
            if district.startswith("GPON "):
                district = district[5:].strip()
                tech = "GPON"

            address = (record.get("Адрес") or "").strip()
            gigabit_cell = (record.get("Гигабитное подключение") or "").strip()

            rows.append(
                Row(
                    order_class=order_class,
                    skill=skill,
                    # Статус наряда и бригада — это исход дня: кто поехал и
                    # чем кончилось. В синтетической выгрузке их нет, и брать
                    # их неоткуда — планировщик исхода знать не может. Поля
                    # остаются на месте пустыми: контракт от этого не меняется,
                    # а заполнить их сможет тот, кто разбирает уже прошедший
                    # день, а не планирует будущий.
                    status=STATUS.get((record.get("Статус BK") or "").strip()),
                    work_type=(record.get("Тип заявки HD") or "").strip(),
                    window_start=max(minutes_of(record["Начало"]), DAY_OPEN),
                    window_end=min(minutes_of(record["Окончание"]), DAY_CLOSE),
                    district=district,
                    address=address,
                    team=(record.get("Бригада") or "").strip() or None,
                    tech=tech,
                    gigabit=(gigabit_cell == "Да") if gigabit_cell else None,
                    # Доступ в квартиру нужен там, где в адресе есть квартира;
                    # авария на сети стоит во дворе, и абонент ей не нужен.
                    needs_access="кв." in address,
                )
            )
    return rows


# ─── синтез недостающего ─────────────────────────────────────────────────────
#
# Всё, что ниже, выгрузка не содержит. Каждое значение считается из самой
# строки наряда, а не разыгрывается: один и тот же наряд обязан давать один и
# тот же результат при каждой сборке, иначе набор нельзя ни сравнить, ни
# обсудить.

CONTACT_NAMES = [
    "Анна", "Дмитрий", "Елена", "Сергей", "Ольга", "Михаил", "Татьяна",
    "Алексей", "Наталья", "Игорь", "Марина", "Владимир", "Светлана", "Павел",
]


def fold(text: str) -> int:
    """Свёртка строки в число. Нужна ровно затем, чтобы синтезированное держалось
    за строку наряда и не менялось от прогона к прогону."""
    value = 0
    for char in text:
        value = (value * 31 + ord(char)) % 1_000_000_007
    return value


ENGINEER_FIRST_NAMES = [
    "Андрей", "Сергей", "Дмитрий", "Алексей", "Максим", "Евгений", "Николай",
    "Роман", "Виктор", "Олег", "Юрий", "Артём", "Григорий", "Константин",
]

def contact_of(order_id: str, address: str) -> dict[str, str]:
    seed = fold(order_id + address)
    name = CONTACT_NAMES[seed % len(CONTACT_NAMES)]
    tail = seed // len(CONTACT_NAMES)
    phone = f"+7 9{tail % 100:02d} {tail // 100 % 1000:03d}-{tail // 100000 % 100:02d}-{tail // 10000000 % 100:02d}"
    return {"name": name, "phone": phone}


def deadline_of(order_class: str, window_end: int) -> int:
    """Крайний срок по наряду.

    Поле информационное — солвер его не читает, — но по нему интерфейс делит
    невзятые заявки на «горит сегодня» и «можно на завтра», а без этого деления
    список из двух десятков строк ничего диспетчеру не говорит.

    Авария ждать не может: её срок — конец окна. Подключение переносится на
    завтра тяжело, но переносится. Локальная заявка — легче всего.
    """
    if order_class == "outage":
        return window_end
    if order_class in ("connection", "addon"):
        return window_end + 120
    return 24 * 60 + 13 * 60  # 13:00 следующего дня


def unify_skills(zones: list[dict]) -> list[str]:
    """Сводит навыки инженера, работавшего в нескольких зонах, в один набор.

    Навык — свойство человека, а не участка: тот, кто умеет чинить аварию на
    Востоке, умеет её чинить и на Юго-Востоке. Вычитывается он, однако, из
    нарядов, а наряды у каждой зоны свои: на Востоке одной и той же бригаде достались
    подключения и авария, на Юго-Востоке одни подключения, — и один человек
    выходил в базу дважды, с разными навыками. Расчёт из-за этого отказывал ему
    в аварийной заявке там, где отказывать не за что.

    Раньше навыки выводились из нарядов, и один человек выходил в базу
    дважды с разными наборами. Теперь штат объявлен заранее, но сведение
    осталось: участков у человека по-прежнему может быть несколько, а навык
    у него один.

    Смену и опыт это не трогает: они у зоны свои по существу. Смена — график
    конкретного дня на конкретном участке, опыт — выработка за этот день.

    Возвращает табельные номера тех, кому набор пришлось расширить.
    """
    by_id: dict[str, set[str]] = {}
    for zone in zones:
        for engineer in zone["engineers"]:
            by_id.setdefault(engineer["id"], set()).update(engineer["skills"])

    widened = []
    for zone in zones:
        for engineer in zone["engineers"]:
            united = sorted(by_id[engineer["id"]])
            if united != engineer["skills"]:
                engineer["skills"] = united
                widened.append(engineer["id"])
    return widened


# ─── сборка зоны ─────────────────────────────────────────────────────────────


def build_zone(key: str, geo: Geocoder, first_order: int) -> dict:
    """Собирает зону. Нумерация сквозная по всей базе, а не своя в каждой зоне.

    Заказчик потребовал этого прямо: «01» в одном расчёте и «01» в другом —
    разные объекты и одинаково называться не могут. Зоны здесь — это разные
    дни, и заявка R0001 Востока с заявкой R0001 Юго-Востока не имеют между
    собой ничего общего. Для инженеров это не придирка к оформлению, а
    единственный способ не слепить трёх человек в одного: справочник сводит
    людей по табельному номеру, и три разных E00 схлопывались в одну карточку
    с суммой чужих часов.
    """
    zone = ZONES[key]
    rows = read_rows(SOURCE / f"{key}-synthetic.csv")
    print(f"  {zone['title']}: нарядов {len(rows)}")

    office = geo.find(zone["office"])

    # Геокодируем дома. Один дом — один запрос, сколько бы нарядов оттуда ни
    # пришло: в выгрузке есть адреса, по которым в один день едут дважды.
    points: dict[str, tuple[float, float] | None] = {}
    anchors: dict[str, tuple[float, float]] = {}
    for row in rows:
        clean = normalize_address(row.address)
        if clean not in points:
            points[clean] = geo.find(clean)
        found = points[clean]
        if found and row.district not in anchors:
            anchors[row.district] = found

    orders = []
    lost = 0
    for index, row in enumerate(rows, start=first_order):
        order_id = f"R{index:04d}"
        clean = normalize_address(row.address)
        point = points[clean]
        if point is None:
            # Дом не нашёлся — ставим на якорь: другой дом того же района, а
            # если район не дался целиком, центр города. Набор от одного
            # промаха не разваливается, а молча выброшенная заявка — это
            # пропавшая работа, о которой никто не узнает.
            lost += 1
            town = next((t for t in TOWN_ANCHORS if t in row.address), None)
            point = anchors.get(row.district) or (
                TOWN_ANCHORS[town] if town else MOSCOW_ANCHOR
            )

        minutes, equipment, transport = WORK_TYPES.get(row.work_type, DEFAULT_WORK)
        urgent = row.order_class == "outage" or row.work_type == "Авария"

        orders.append(
            {
                "id": order_id,
                "work_type": row.work_type,
                "work_title": row.work_type,
                "skill": row.skill,
                "district": row.district,
                "address": clean,
                "lat": point[0],
                "lon": point[1],
                "window_start": row.window_start,
                "window_end": row.window_end,
                "sla_deadline": deadline_of(row.order_class, row.window_end),
                "priority": 2 if urgent else 0,
                "est_minutes": minutes,
                "needs_access": row.needs_access,
                "assigned_to": None,
                "order_class": row.order_class,
                "priority_class": "urgent" if urgent else "normal",
                "status": row.status,
                "required_transport": transport,
                "required_equipment": equipment or None,
                "tech": row.tech,
                "gigabit": row.gigabit,
                "contact": contact_of(order_id, clean),
                "locked_to": None,
                "assigned_by": None,
                "unassigned_reason": None,
            }
        )

    # Штат сюда не выводится. Раньше он собирался из колонки «Бригада»
    # контрольного файла — то есть из исхода дня: кто на самом деле поехал,
    # что делал и когда. Планировщик этого знать не может, а постановщик
    # прямо запретил брать контрольные данные в работу. Поэтому штат —
    # заявленное допущение: четырнадцать человек на участок, ровно тот, с
    # которым считает движок, и лежит он готовым в `dataset/out`.
    #
    # Скрипт его не трогает: перезаписать здесь значило бы вернуть прежнюю
    # раздачу с другого конца.
    engineers = keep_engineers(key)
    print(
        f"    домов {len(points)}, не нашлось {lost}, "
        f"инженеров {len(engineers)}, заявок {len(orders)}"
    )
    return {"key": key, "title": zone["title"], "orders": orders, "engineers": engineers}


def keep_engineers(key: str) -> list[dict]:
    """Штат участка — тот, что уже объявлен в `dataset/out/<участок>`.

    Файла нет — пустой список и предупреждение: собрать штат нам больше не
    из чего, а придумывать его на ходу нельзя. Заявки при этом соберутся:
    они из синтетической выгрузки и от штата не зависят.
    """
    path = OUT / key / "engineers.json"
    if not path.exists():
        print(f"    штат участка «{key}» не найден — engineers.json останется пустым")
        return []
    saved = json.loads(path.read_text(encoding="utf-8"))
    return saved.get("engineers", [])


# ─── запись ──────────────────────────────────────────────────────────────────


def write_zone(built: dict) -> None:
    folder = OUT / built["key"]
    folder.mkdir(parents=True, exist_ok=True)
    meta = {
        "date": DATE,
        "zone": built["title"],
        "time_format": "minutes_from_midnight",
        "distance_units": "km",
        "source": "выгрузка «Билайн Бизнес» за 17.08.2026",
    }
    (folder / "orders.json").write_text(
        json.dumps(
            {"schema": SCHEMA, "kind": "orders", "meta": meta, "orders": built["orders"]},
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    (folder / "engineers.json").write_text(
        json.dumps(
            {
                "schema": SCHEMA,
                "kind": "engineers",
                "meta": meta,
                "engineers": built["engineers"],
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )

    # Тот же набор плоским CSV: его понимает загрузка заявок в интерфейсе, и
    # это самый короткий путь показать настоящие данные на экране.
    hhmm = lambda m: f"{m // 60:02d}:{m % 60:02d}"  # noqa: E731
    with (folder / "orders.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.writer(handle, delimiter=";")
        writer.writerow(["Адрес", "Что делаем", "Окно с", "Окно до", "Работы, мин", "Авария"])
        for order in built["orders"]:
            writer.writerow(
                [
                    order["address"],
                    order["work_title"],
                    hhmm(order["window_start"]),
                    hhmm(order["window_end"]),
                    order["est_minutes"],
                    "да" if order["priority_class"] == "urgent" else "нет",
                ]
            )


def write_dictionaries(zones: list[dict]) -> None:
    work_types = {}
    for zone in zones:
        for order in zone["orders"]:
            work_types[order["work_type"]] = order["work_title"]
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "dictionaries.json").write_text(
        json.dumps(
            {
                "schema": SCHEMA,
                "kind": "dictionaries",
                "skills": SKILL_NAMES,
                "transports": TRANSPORT_NAMES,
                "order_classes": ORDER_CLASS_NAMES,
                "statuses": STATUS_NAMES,
                "work_types": work_types,
                "equipment": EQUIPMENT_NAMES,
                "techs": {"FMC": "FMC", "FTTB": "FTTB", "GPON": "GPON"},
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )


def write_summary(zones: list[dict]) -> None:
    """Сводка по набору: её читают глазами, когда спорят, что в данных есть."""
    summary = {"schema": SCHEMA, "date": DATE, "zones": []}
    for zone in zones:
        orders = zone["orders"]
        skills: dict[str, int] = {}
        classes: dict[str, int] = {}
        for order in orders:
            skills[order["skill"]] = skills.get(order["skill"], 0) + 1
            classes[order["order_class"]] = classes.get(order["order_class"], 0) + 1
        summary["zones"].append(
            {
                "key": zone["key"],
                "title": zone["title"],
                "orders": len(orders),
                "engineers": len(zone["engineers"]),
                "by_skill": skills,
                "by_class": classes,
                "with_transport_requirement": sum(
                    1 for o in orders if o["required_transport"]
                ),
                "urgent": sum(1 for o in orders if o["priority_class"] == "urgent"),
                "window_span": [
                    min(o["window_start"] for o in orders),
                    max(o["window_end"] for o in orders),
                ],
                "engineer_transport": sorted(
                    {e["transport"] for e in zone["engineers"]}
                ),
                "skill_combos": sorted(
                    {"+".join(e["skills"]) for e in zone["engineers"]}
                ),
            }
        )
    (OUT / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    return summary


def main() -> None:
    print("Сборка набора из выгрузки «Билайн Бизнес»")
    geo = Geocoder()
    # Нумерация сквозная по всей базе: следующая зона продолжает с того
    # номера, на котором кончилась предыдущая.
    zones = []
    next_order = 1
    for key in ZONES:
        zone = build_zone(key, geo, next_order)
        zones.append(zone)
        next_order += len(zone["orders"])
    geo.save()

    # Навык принадлежит человеку, а не зоне: у того, кто работал в двух,
    # наборы сводятся в один — иначе он в одной зоне умеет больше, чем в другой.
    widened = unify_skills(zones)
    if widened:
        print(
            f"\n  навыки сведены по человеку: {', '.join(sorted(set(widened)))} "
            f"(записей поправлено {len(widened)})"
        )

    for zone in zones:
        write_zone(zone)
    write_dictionaries(zones)
    summary = write_summary(zones)

    print("\nГотово:")
    for zone in summary["zones"]:
        print(
            f"  {zone['title']}: {zone['orders']} заявок, {zone['engineers']} инженеров, "
            f"{zone['urgent']} срочных, {zone['with_transport_requirement']} с требованием к транспорту"
        )
    print(f"\nВсё лежит в {OUT}")


if __name__ == "__main__":
    main()
