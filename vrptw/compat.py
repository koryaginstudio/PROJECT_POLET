"""
Совместимость с Windows: блокировка файла и вывод в консоль.

Решение смотрят на машинах проверяющих, и Windows среди них вероятна. Там
у движка было две беды, обе воспроизводятся на Mac:

* `fcntl` на Windows нет — `import vrptw.server` падал на первой строке
  блокировки архива (воспроизводит `sys.modules['fcntl'] = None`);
* кодировка по умолчанию — cp1251: всё, что читалось `read_text()` без
  кодировки, ломалось на кириллице готовых планов и сетей
  (воспроизводит `LC_ALL=ru_RU.CP1251`). Это лечится явной
  `encoding="utf-8"` у каждого чтения и записи, сторож — в selfcheck;
  а вывод в консоль, где кодировка не своя, — здесь.
"""

from __future__ import annotations

import sys

try:
    import fcntl
except ImportError:                     # Windows
    fcntl = None
try:
    import msvcrt
except ImportError:                     # всё, кроме Windows
    msvcrt = None


def запереть(f) -> None:
    """Исключительная блокировка открытого файла; ждёт, пока освободится.

    На Windows — `msvcrt.locking` на первый байт: `LK_LOCK` пробует десять
    раз по секунде и сдаётся ошибкой, поэтому ждём по кругу. Ни того ни
    другого нет — без блокировки: архив пишут редко, и лучше писать без
    замка, чем не запуститься вовсе."""
    if fcntl is not None:
        fcntl.flock(f, fcntl.LOCK_EX)
    elif msvcrt is not None:
        f.seek(0)
        while True:
            try:
                msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                return
            except OSError:
                continue


def отпереть(f) -> None:
    if fcntl is not None:
        fcntl.flock(f, fcntl.LOCK_UN)
    elif msvcrt is not None:
        f.seek(0)
        msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)


def консоль() -> None:
    """Вывод не падает на знаках, которых нет в кодировке консоли.

    В окно консоли Windows Python пишет сам, в обход кодовой страницы; но
    вывод, перенаправленный в файл, идёт в cp1251 — а в ней нет «✓» и
    «═», которыми говорят проверки, и `check > log.txt` падал бы
    посреди прогона. Незнакомый знак становится «?», прогон доходит до
    конца."""
    for поток in (sys.stdout, sys.stderr):
        try:
            if (поток.encoding or "").lower().replace("-", "") != "utf8":
                поток.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
