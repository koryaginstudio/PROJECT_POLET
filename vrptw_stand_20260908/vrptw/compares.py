"""
Сохранённые сравнения: набор расчётов, который диспетчер сложил рядом.

Сравнение — не расчёт. Движок его не считает: он складывает рядом
результаты, которые уже посчитаны и лежат в архиве. Поэтому здесь нет ни
солвера, ни форм — только запись о том, что и когда сравнивали.

Почему это всё-таки живёт на сервере, а не в браузере. Расчёт заводят на
одной машине, а показывают на другой; набор, собранный вечером, должен
открыться утром и у соседа. Правки карточек — номер, заметка — остались в
браузере сознательно: это подпись человека к чужой записи. Сравнение же
самостоятельная вещь, к которой возвращаются, и терять её при чистке
браузера нельзя.

Главное решение здесь — **снимок вместо ссылок**. В записи лежат не одни
номера расчётов, а их цифры на момент, когда сравнение сохранили. Расчёт
могут переименовать или удалить из истории, и сравнение, собранное из
одних ссылок, в этот день превратилось бы в список битых номеров. Снимок
отвечает на вопрос «что мы видели, когда принимали решение», а он и есть
причина возвращаться к сравнению спустя неделю.

Цифры для снимка приходят от интерфейса: он их и показывал. Пересчитывать
их здесь значило бы завести второй источник правды о том же покрытии.

Раскладка на диске:

    .vrptw-compares/
    ├── index.json              список сравнений, новые в конце
    └── <id>.json               запись целиком

Записи мелкие — четыре расчёта с десятком чисел, — поэтому лежат по файлу
на сравнение и целиком попадают в индекс. Делить их на формы, как расчёты,
нечего.
"""

from __future__ import annotations

import json
import threading
from datetime import datetime
from pathlib import Path

COMPARES_DIR = Path(".vrptw-compares")
INDEX = COMPARES_DIR / "index.json"

# Сколько расчётов принимает сравнение. Те же границы, что держит
# интерфейс: меньше двух сравнивать не с чем, больше четырёх не читается
# в ряд. Сервер их проверяет сам — интерфейс не единственный, кто может
# постучаться, а запись с шестью расчётами потом некому будет показать.
MIN_RUNS = 2
MAX_RUNS = 4

# Что храним про каждый расчёт в снимке. Список закрытый: запись обязана
# остаться читаемой через полгода, а для этого надо знать, что в ней
# лежит. Лишнее поле, пришедшее с клиента, отбрасывается молча — это не
# ошибка запроса, а разница версий интерфейса.
RUN_FIELDS = (
    "id", "code", "created", "day", "source", "note",
    "orders", "assigned", "coverage", "assigned_share",
    "routes", "visits", "travel_minutes", "occupancy",
    "engineers_total", "engineers_on_route",
)


class BadCompare(ValueError):
    """Запрос не складывается в сравнение: мало расчётов, много, дубли."""


def _clean_run(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise BadCompare("расчёт в сравнении описывается объектом")
    run_id = str(raw.get("id") or "").strip()
    if not run_id:
        raise BadCompare("у расчёта в сравнении нет id")
    out = {key: raw[key] for key in RUN_FIELDS if key in raw}
    out["id"] = run_id
    return out


class Compares:
    """Архив сохранённых сравнений на диске."""

    def __init__(self):
        self._lock = threading.Lock()
        COMPARES_DIR.mkdir(exist_ok=True)

    # ---------- индекс ----------

    def _read_index(self) -> list[dict]:
        if not INDEX.exists():
            return []
        try:
            return json.loads(INDEX.read_text())
        except json.JSONDecodeError:
            # Индекс могли оборвать на записи. Терять из-за этого весь
            # архив нельзя: файлы сравнений на месте, список по ним
            # собирается заново.
            return self._rebuild_index()

    def _rebuild_index(self) -> list[dict]:
        found = []
        for path in sorted(COMPARES_DIR.glob("*.json")):
            if path.name == "index.json":
                continue
            try:
                found.append(json.loads(path.read_text()))
            except json.JSONDecodeError:
                continue
        found.sort(key=lambda r: r.get("created", ""))
        INDEX.write_text(json.dumps(found, ensure_ascii=False, indent=1))
        return found

    def list(self) -> list[dict]:
        with self._lock:
            return self._read_index()

    def get(self, compare_id: str) -> dict | None:
        for record in self.list():
            if record["id"] == compare_id:
                return record
        return None

    def _path(self, compare_id: str) -> Path | None:
        """Файл сравнения, если он наш.

        `compare_id` приходит из адреса, то есть от кого угодно: путь
        проверяется, а не склеивается — «..» в номере не должно выводить
        за пределы архива.
        """
        if (not compare_id or "/" in compare_id or "\\" in compare_id
                or compare_id.startswith(".")):
            return None
        path = (COMPARES_DIR / f"{compare_id}.json").resolve()
        if COMPARES_DIR.resolve() not in path.parents:
            return None
        return path

    # ---------- сохранить сравнение ----------

    def create(self, runs: list, note: str = "") -> dict:
        """Кладёт набор в архив и возвращает запись о нём."""
        if not isinstance(runs, list):
            raise BadCompare("расчёты сравнения приходят списком")
        cleaned = [_clean_run(raw) for raw in runs]
        if not MIN_RUNS <= len(cleaned) <= MAX_RUNS:
            raise BadCompare(
                f"в сравнении должно быть от {MIN_RUNS} до {MAX_RUNS} "
                f"расчётов, пришло {len(cleaned)}")
        ids = [run["id"] for run in cleaned]
        if len(set(ids)) != len(ids):
            raise BadCompare("один и тот же расчёт в сравнении дважды")

        now = datetime.now()
        with self._lock:
            index = self._read_index()
            number = len(index) + 1
            record = {
                "id": f"cmp-{now:%Y%m%d-%H%M%S}-{number:03d}",
                "code": f"C{number:03d}",
                "date": f"{now:%Y-%m-%d}",
                "created": f"{now:%Y-%m-%dT%H:%M}",
                "note": (note or "")[:200],
                "runs": cleaned,
            }
            path = COMPARES_DIR / f"{record['id']}.json"
            path.write_text(json.dumps(record, ensure_ascii=False, indent=1))

            index.append(record)
            INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))

        return record

    # ---------- заметка и удаление ----------

    def annotate(self, compare_id: str, note: str) -> dict | None:
        """Подпись человека к сравнению. Движок её не читает."""
        path = self._path(compare_id)
        if path is None or not path.is_file():
            return None
        with self._lock:
            index = self._read_index()
            record = next((r for r in index if r["id"] == compare_id), None)
            if record is None:
                return None
            record["note"] = (note or "")[:200]
            path.write_text(json.dumps(record, ensure_ascii=False, indent=1))
            INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))
        return record

    def delete(self, compare_id: str) -> bool:
        """Убирает сравнение из архива. Расчёты при этом не трогаются:
        сравнение — это про набор, а не про то, что в нём лежит."""
        path = self._path(compare_id)
        if path is None or not path.is_file():
            return False
        with self._lock:
            index = [r for r in self._read_index() if r["id"] != compare_id]
            path.unlink()
            INDEX.write_text(json.dumps(index, ensure_ascii=False, indent=1))
        return True
