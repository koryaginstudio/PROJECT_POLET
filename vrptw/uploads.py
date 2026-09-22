"""
Выгрузка дня, которую принёс диспетчер.

До 22 сентября движок считал только три зоны, лежащие в репозитории. ТЗ
просит другого: диспетчер загружает выгрузку своего дня и в несколько
нажатий получает расчёт. Этот модуль — путь от байтов файла до дня,
который дальше живёт в тех же ручках, что и зоны: план, пересчёт,
журнал, архив, «сколько людей».

Как это устроено
----------------

1. **Приём** (`принять`) — разбор файла и предпросмотр, без единого
   запроса в сеть: сколько заявок, за какой день, какой офис, какие
   строки отложены и почему, сколько адресов ещё надо искать и готова ли
   сеть дорог. Файл кладётся в каталог состояния (`state.py`) — туда же,
   где архив и журнал, — а не в репозиторий.
2. **Подготовка** (`подготовить`) — фоновая работа с ходом, который
   интерфейс опрашивает: найти новые адреса, построить сеть, посчитать
   план, прогноз, базовый вариант и «сколько людей». Запрос интерфейса
   ждёт минуту, а новый адрес ищется 1,4 с — на сотне новых адресов
   синхронный ответ не дожил бы до конца.
3. **День** (`день`) — сборка `Day` только из готового: кэш адресов и
   готовые сети. Сервер зовёт её так же, как `load_day` для зоны.

Имя дня — `выгрузка-<10 знаков хэша>` от байтов файла и числа
инженеров: тот же файл с той же бригадой — та же выгрузка, а не вторая
копия; другая бригада — другой день, у него свои планы и свой журнал.

Без интернета
-------------

Новые адреса взять неоткуда: геокодер и сервер маршрутов — в сети.
Предпросмотр говорит об этом до расчёта («12 адресов надо искать —
нужен интернет»), подготовка отказывает словами, а не висит. Адрес,
который не удалось спросить, в кэш «ненайденным» не пишется — появится
сеть, и он найдётся. Сеть дорог без интернета строится только из
готовой: если все точки выгрузки уже есть в посчитанной сети (выгрузка
зоны целиком или без части строк), подматрица берётся из неё точно.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

from .core import geocode
from .core.load import (DATA_DIR, ИНЖЕНЕРОВ_МАКС, ИНЖЕНЕРОВ_МИН,
                        разобрать_выгрузку, собрать_день)
from .core.osm import network_for_points, сеть_из_готовых
from .state import state_dir

ПРЕФИКС = "выгрузка-"
_ИМЯ = re.compile(r"^выгрузка-[0-9a-f]{10}$")
# Выгрузка дня — десятки килобайт. Пять мегабайт — это уже не она.
МАКС_БАЙТ = 5 * 1024 * 1024
ИНЖЕНЕРОВ_ПО_УМОЛЧАНИЮ = 14


class НетВыгрузки(LookupError):
    """Такой выгрузки нет — 404."""


class Занято(Exception):
    """Выгрузку сейчас нельзя удалить — 409."""


def каталог() -> Path:
    return state_dir() / ".vrptw-uploads"


def кэш_адресов() -> Path:
    """Свой кэш адресов: кэш репозитория выгрузки только читают."""
    return state_dir() / ".vrptw-geocode.json"


def кэш_сетей() -> Path:
    return state_dir() / ".vrptw-сети"


def каталоги_сетей() -> list[Path]:
    """Где искать готовую сеть: сперва сети зон в репозитории, потом свои."""
    return [DATA_DIR / "сети", кэш_сетей()]


def это_выгрузка(ident) -> bool:
    ident = str(ident)
    return bool(_ИМЯ.match(ident)) and (каталог() / ident / "запись.json").is_file()


# ---------- ход подготовки: в памяти процесса ----------

# Подготовка — поток; её ход живёт здесь. На диск пишется только исход
# («готова» или «ошибка»): после перезапуска движка прерванная подготовка
# честно числится непосчитанной, а не вечно «готовящейся».
_ХОД: dict[str, dict] = {}
_ЗАМОК = threading.Lock()


def _этап(ident: str, что: str, сделано: int | None = None,
          всего: int | None = None) -> None:
    with _ЗАМОК:
        ход = _ХОД.setdefault(ident, {"идёт": True})
        ход["stage"] = что
        ход["progress"] = (None if всего is None
                           else {"done": сделано or 0, "total": всего})


def _идёт(ident: str) -> bool:
    with _ЗАМОК:
        return bool(_ХОД.get(ident, {}).get("идёт"))


# ---------- файл и запись ----------

def _папка(ident: str) -> Path:
    if not _ИМЯ.match(str(ident)):
        raise НетВыгрузки(f"выгрузки {ident!r} нет")
    return каталог() / ident


def _прочесть(ident: str) -> dict:
    путь = _папка(ident) / "запись.json"
    if not путь.is_file():
        raise НетВыгрузки(f"выгрузки {ident!r} нет")
    return json.loads(путь.read_text(encoding="utf-8"))


def _записать(ident: str, запись: dict) -> None:
    папка = _папка(ident)
    папка.mkdir(parents=True, exist_ok=True)
    tmp = папка / "запись.json.tmp"
    tmp.write_text(json.dumps(запись, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, папка / "запись.json")


def _файл(ident: str) -> bytes:
    return (_папка(ident) / "выгрузка.csv").read_bytes()


def _адреса(разбор: dict) -> list[str]:
    return list(dict.fromkeys([r["address"] for r in разбор["rows"]] + [разбор["office"]]))


class _Точки(Exception):
    """Точки сети дня — выносятся из `собрать_день`, чтобы не повторять
    его правило (заявки, офис, выездные точки) и не разойтись с ним."""


def _точки_дня(разбор: dict, geo: dict, инженеров: int) -> list[dict] | None:
    def поймать(points):
        raise _Точки(points)
    try:
        собрать_день(разбор["rows"], разбор["office"], geo, n_engineers=инженеров,
                     date=разбор["date"], ident="предпросмотр", сеть=поймать, quiet=True)
    except _Точки as точки:
        return точки.args[0]
    except ValueError:
        return None
    return None


def _состав(разбор: dict, инженеров: int) -> dict:
    """Что известно о выгрузке без сети: адреса, сеть, отложенные строки."""
    адреса = _адреса(разбор)
    geo = geocode.known(адреса, кэш_адресов())
    искать = [a for a in адреса if a not in geo]
    не_найдены = {a for a in адреса if a in geo and not geo[a].get("lat")}
    неточно = [a for a in адреса if (geo.get(a) or {}).get("quality") == "street"]

    отложены = []
    for строка, r in zip(разбор["lines"], разбор["rows"]):
        if r["address"] in не_найдены:
            отложены.append({"line": строка, "id": r["id"],
                             "reason": f"адрес не найден геокодером: «{r['address']}»"})
    к_расчёту = sum(1 for r in разбор["rows"] if r["address"] not in не_найдены)

    if искать:
        сеть = "после поиска адресов"
    elif разбор["office"] in не_найдены:
        сеть = "нет офиса"
    else:
        точки = _точки_дня(разбор, geo, инженеров)
        if точки is None:
            сеть = "нет офиса"
        else:
            сеть = ("готова" if сеть_из_готовых(точки, каталоги_сетей(), проверить=True)
                    else "нужен интернет")
    return {
        "addresses": {
            "total": len(адреса),
            "known": len(адреса) - len(искать) - len(не_найдены),
            "to_search": len(искать),
            "not_found": len(не_найдены),
            "approximate": len(неточно),
            # Столько займёт поиск: публичный геокодер просит паузу 1,4 с.
            "search_seconds": round(len(искать) * geocode.PAUSE),
        },
        "network": сеть,
        "office_found": разбор["office"] not in не_найдены,
        "to_plan": к_расчёту,
        "skipped_by_address": отложены,
    }


def запись(ident: str) -> dict:
    """Выгрузка так, как её видит интерфейс: предпросмотр и состояние."""
    з = _прочесть(ident)
    разбор = разобрать_выгрузку(_файл(ident))
    состав = _состав(разбор, з["engineers"])
    with _ЗАМОК:
        ход = dict(_ХОД.get(ident) or {})
    status = з.get("status", "принята")
    if ход.get("идёт"):
        status = "готовится"
    предупреждения = list(разбор["warnings"])
    if состав["addresses"]["approximate"]:
        предупреждения.append(
            f"адресов, найденных только до улицы: {состав['addresses']['approximate']} — "
            "точка может стоять в сотнях метров от дома")
    return {
        "day": ident,
        "name": з["name"],
        "title": з["title"],
        "created": з["created"],
        "date": разбор["date"],
        "office": разбор["office"],
        "engineers": з["engineers"],
        "orders": len(разбор["rows"]),
        "to_plan": состав["to_plan"],
        "encoding": разбор["encoding"],
        "skipped": sorted(разбор["skipped"] + состав["skipped_by_address"],
                          key=lambda s: s["line"]),
        "warnings": предупреждения,
        "addresses": состав["addresses"],
        "office_found": состав["office_found"],
        "network": состав["network"],
        "status": status,
        "stage": ход.get("stage") if status == "готовится" else None,
        "progress": ход.get("progress") if status == "готовится" else None,
        "error": з.get("error") if status == "ошибка" else None,
        "prepared": з.get("prepared"),
    }


def список() -> list[dict]:
    """Все выгрузки, новые первыми. Сломанную запись пропускаем, а не
    роняем весь список: одна испорченная папка не должна прятать остальные."""
    if not каталог().is_dir():
        return []
    out = []
    for папка in каталог().iterdir():
        if not это_выгрузка(папка.name):
            continue
        try:
            out.append(запись(папка.name))
        except (ValueError, OSError, KeyError):
            continue
    return sorted(out, key=lambda з: з["created"], reverse=True)


def _заголовок(имя: str, дата: str) -> str:
    г, м, д = дата.split("-")
    основа = Path(имя or "выгрузка").stem.strip() or "выгрузка"
    return f"{основа} · {д}.{м}.{г}"


def принять(имя: str, data: bytes, инженеров=ИНЖЕНЕРОВ_ПО_УМОЛЧАНИЮ) -> dict:
    """Принять файл: разобрать, положить в каталог состояния, отдать
    предпросмотр. Сеть не трогается — это делает `подготовить`."""
    if len(data) > МАКС_БАЙТ:
        raise ValueError(f"файл больше {МАКС_БАЙТ // (1024 * 1024)} МБ — это не выгрузка дня")
    try:
        n = int(инженеров)
    except (TypeError, ValueError):
        raise ValueError(f"число инженеров {инженеров!r} — не число")
    if not ИНЖЕНЕРОВ_МИН <= n <= ИНЖЕНЕРОВ_МАКС:
        raise ValueError(f"инженеров {n}: можно от {ИНЖЕНЕРОВ_МИН} до {ИНЖЕНЕРОВ_МАКС}")
    разбор = разобрать_выгрузку(data)

    ident = ПРЕФИКС + hashlib.sha1(data + f"\0{n}".encode()).hexdigest()[:10]
    папка = _папка(ident)
    if not (папка / "запись.json").is_file():
        папка.mkdir(parents=True, exist_ok=True)
        (папка / "выгрузка.csv").write_bytes(data)
        _записать(ident, {
            "name": str(имя or "выгрузка.csv")[:200],
            "title": _заголовок(str(имя or ""), разбор["date"]),
            "created": datetime.now().isoformat(timespec="seconds"),
            "engineers": n,
            "status": "принята",
        })
    return запись(ident)


def день(ident: str, строить_сеть: bool = False):
    """`Day` выгрузки — только из готового: кэша адресов и готовых сетей.

    Не подготовленная выгрузка — отказ со словами, а не поход в сеть
    посреди запроса плана. `строить_сеть=True` — только для подготовки:
    она одна вправе ждать сервер маршрутов."""
    з = _прочесть(ident)
    разбор = разобрать_выгрузку(_файл(ident))
    адреса = _адреса(разбор)
    geo = geocode.known(адреса, кэш_адресов())
    нет = [a for a in адреса if a not in geo]
    if нет:
        raise ValueError(f"выгрузка «{з['title']}» не подготовлена: {len(нет)} адр. ещё "
                         "не искали — нажмите «Посчитать»")

    def сеть(points):
        готовая = сеть_из_готовых(points, каталоги_сетей(), куда=кэш_сетей())
        if готовая is not None:
            return готовая
        if not строить_сеть:
            raise ValueError(f"выгрузка «{з['title']}» не подготовлена: сеть дорог под её "
                             "адреса ещё не построена — нажмите «Посчитать»")
        try:
            return network_for_points(points, cache_dir=кэш_сетей(), quiet=True, tries=2)
        except RuntimeError as exc:
            raise ValueError(
                "сеть дорог не построена: сервер маршрутов не отвечает. Без интернета "
                "сеть под новые адреса взять неоткуда — подключите интернет и нажмите "
                f"«Посчитать» ещё раз ({exc})") from exc

    return собрать_день(разбор["rows"], разбор["office"], geo,
                        n_engineers=з["engineers"], date=разбор["date"],
                        ident=ident, сеть=сеть, quiet=True)


def подготовить(stand, ident: str) -> dict:
    """Запустить подготовку в фоне. Уже идёт — вернуть её ход, второй не
    заводить: два потока искали бы одни и те же адреса."""
    _прочесть(ident)
    with _ЗАМОК:
        if not _ХОД.get(ident, {}).get("идёт"):
            _ХОД[ident] = {"идёт": True, "stage": "начинаю", "progress": None}
            threading.Thread(target=_готовить, args=(stand, ident),
                             name=f"подготовка {ident}", daemon=True).start()
    return запись(ident)


def _готовить(stand, ident: str) -> None:
    try:
        разбор = разобрать_выгрузку(_файл(ident))
        адреса = _адреса(разбор)
        искать = [a for a in адреса if a not in geocode.known(адреса, кэш_адресов())]
        if искать:
            _этап(ident, "ищу адреса", 0, len(искать))
            отчёт: dict = {}
            geocode.geocode_all(искать, quiet=True, cache_file=кэш_адресов(),
                                progress=lambda i, n: _этап(ident, "ищу адреса", i, n),
                                отчёт=отчёт)
            if отчёт.get("нет_связи"):
                k = len(отчёт["нет_связи"])
                raise ValueError(
                    f"нет связи с геокодером: не удалось найти {k} адр. из {len(искать)}. "
                    "Без интернета координаты новых адресов взять неоткуда — подключите "
                    "интернет и нажмите «Посчитать» ещё раз")
        _этап(ident, "строю сеть дорог")
        день(ident, строить_сеть=True)
        _этап(ident, "раскладываю заявки по инженерам")
        stand.day_and_plan(ident)
        _этап(ident, "считаю прогноз дня и смены")
        stand.forms(ident)
        _этап(ident, "считаю базовый вариант и «сколько людей»")
        stand.baseline(ident)
        stand.staffing(ident)
        з = _прочесть(ident)
        з.update(status="готова", error=None,
                 prepared=datetime.now().isoformat(timespec="seconds"))
        _записать(ident, з)
    except Exception as exc:  # noqa: BLE001
        if not isinstance(exc, ValueError):
            traceback.print_exc()
        try:
            з = _прочесть(ident)
            з.update(status="ошибка", error=str(exc))
            _записать(ident, з)
        except (OSError, НетВыгрузки):
            pass
    finally:
        with _ЗАМОК:
            _ХОД.setdefault(ident, {})["идёт"] = False


def удалить(ident: str, архив: list[dict]) -> dict:
    """Убрать выгрузку. Нельзя, пока по ней есть расчёты в архиве: историю
    счёта не затирают (`do_DELETE`), а без выгрузки они не откроются."""
    _прочесть(ident)
    if _идёт(ident):
        raise Занято("выгрузка сейчас готовится — удалить её можно, когда подготовка закончится")
    расчёты = [r.get("code") or r.get("id") for r in архив if r.get("day") == ident]
    if расчёты:
        raise Занято(f"по выгрузке есть расчёты в архиве ({', '.join(map(str, расчёты[:5]))}) — "
                     "без неё они не откроются, поэтому её не удалить")
    shutil.rmtree(_папка(ident))
    with _ЗАМОК:
        _ХОД.pop(ident, None)
    return {"deleted": ident}


def сид(ident: str) -> int:
    """Зерно дня выгрузки: своё у каждой, вне диапазонов синтетики и зон."""
    return 9100 + int(ident[len(ПРЕФИКС):][:6], 16) % 800
