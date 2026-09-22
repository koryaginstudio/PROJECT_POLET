"""
Семь ручек, которые видит пользователь.

Всё остальное в движке наружу не выставляется никогда — не потому, что
жалко, а потому, что бюджет поиска, размер выбивания, шум пересборки и
пороги солвера подобраны замером, и любая их правка обесценивает все
измеренные числа. Диспетчеру они не нужны, а сломать ими можно всё.

А эти семь — нужны, и каждая отвечает на понятный вопрос:

  churn_penalty     сколько мы готовы заплатить за то, чтобы при пересчёте
                    не дёргать людей, которым уже сказали ехать. Живой
                    контрол на экране инцидента: у одного диспетчера
                    бригада терпимая, у другого нет;
  duration_factor   насколько закладываться, что работа затянется. Больше
                    единицы — планируем с запасом;
  buffer_base       запас до закрытия окна для первого визита в маршруте
  buffer_step       и прирост запаса на каждый следующий. Чем острее у
                    клиента нехватка рук, тем он выгоднее — см. README;
  balance_weight    насколько ровно раскладывать день между людьми;
  risk_high         пороги подсветки «впритык» на экране. Это чистая
  risk_medium       вёрстка: на план они не влияют вовсе.

Значения по умолчанию — те, что подобраны замерами. Пределы стоят не для
красоты: за ними планировщик начинает вести себя глупо, и лучше отбить
запрос понятной ошибкой, чем полдня объяснять, почему покрытие упало.

Настройки лежат файлом и переживают перезапуск. Их отпечаток входит в
ключ кэша: иначе сервер, посчитавший день на старых настройках, отдавал
бы его и после правки — это уже случалось.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from .export import RISK_HIGH, RISK_MEDIUM
from .solvers.improved import BALANCE_WEIGHT, BUFFER_STEP

from .state import settings_file

# Имя -> (нижний предел, верхний предел, что это такое).
LIMITS: dict[str, tuple[float, float, str]] = {
    "churn_penalty": (0.0, 1000.0,
                      "штраф за смену исполнителя при пересчёте"),
    "duration_factor": (0.5, 2.0,
                        "во сколько раз планировать работу дольше оценки"),
    "buffer_base": (0.0, 240.0,
                    "запас до закрытия окна для первого визита, минут"),
    "buffer_step": (0.0, 120.0,
                    "прирост запаса на каждый следующий визит, минут"),
    "balance_weight": (0.0, 100.0,
                       "штраф за неравномерность загрузки"),
    "risk_high": (0.0, 240.0,
                  "запас меньше этого — визит подсвечен красным, минут"),
    "risk_medium": (0.0, 240.0,
                    "запас меньше этого — жёлтым, минут"),
}


@dataclass
class Settings:
    """Семь значений, и ничего больше."""

    churn_penalty: float = 40.0
    duration_factor: float = 1.0
    buffer_base: float = 0.0
    buffer_step: float = BUFFER_STEP
    balance_weight: float = BALANCE_WEIGHT
    risk_high: float = float(RISK_HIGH)
    risk_medium: float = float(RISK_MEDIUM)

    # ---------- хранение ----------

    @classmethod
    def load(cls) -> "Settings":
        if not settings_file().exists():
            return cls()
        try:
            raw = json.loads(settings_file().read_text(encoding="utf-8"))
        except Exception:      # noqa: BLE001 — битый файл не повод падать
            return cls()
        known = {f.name for f in fields(cls)}
        return cls(**{k: float(v) for k, v in raw.items() if k in known})

    def save(self) -> None:
        settings_file().write_text(json.dumps(asdict(self), ensure_ascii=False, indent=1),
                                   encoding="utf-8")

    # ---------- правка ----------

    def apply(self, changes: dict) -> list[str]:
        """
        Применить присланное. Возвращает список изменённых имён.

        Неизвестное имя — ошибка, а не молчаливое игнорирование: иначе
        опечатка в ключе выглядит как «настройка не работает».
        """
        known = {f.name for f in fields(self)}
        unknown = [k for k in changes if k not in known]
        if unknown:
            raise ValueError(f"нет таких настроек: {', '.join(sorted(unknown))}; "
                             f"есть {', '.join(sorted(known))}")

        pending: dict[str, float] = {}
        for name, value in changes.items():
            try:
                v = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{name}: {value!r} — не число") from None
            lo, hi, what = LIMITS[name]
            if not lo <= v <= hi:
                raise ValueError(f"{name} = {v:g} вне пределов {lo:g}…{hi:g} ({what})")
            pending[name] = v

        after = {**asdict(self), **pending}
        if after["risk_high"] > after["risk_medium"]:
            raise ValueError(
                f"risk_high ({after['risk_high']:g}) должен быть не больше "
                f"risk_medium ({after['risk_medium']:g}): красным подсвечивают "
                f"то, что впритык сильнее жёлтого")

        changed = [n for n, v in pending.items() if getattr(self, n) != v]
        for name, v in pending.items():
            setattr(self, name, v)
        return sorted(changed)

    # ---------- применение ----------

    def params(self, **extra):
        """`Params` с этими настройками. Всё остальное — как подобрано."""
        from .solvers import improved

        return improved.Params(
            duration_factor=self.duration_factor,
            buffer_base=int(self.buffer_base),
            buffer_step=self.buffer_step,
            balance_weight=self.balance_weight,
            **extra)

    def fingerprint(self) -> str:
        """Короткий отпечаток для ключа кэша."""
        blob = json.dumps(asdict(self), sort_keys=True).encode("utf-8")
        return hashlib.sha1(blob).hexdigest()[:8]

    def describe(self) -> dict:
        """Для экрана настроек: значение, пределы, что это такое."""
        out = {}
        for f in fields(self):
            lo, hi, what = LIMITS[f.name]
            out[f.name] = {"value": getattr(self, f.name),
                           "default": f.default, "min": lo, "max": hi,
                           "about": what}
        return out
