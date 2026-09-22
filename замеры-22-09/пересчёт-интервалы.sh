#!/bin/zsh
# Таблица пересчёта с интервалами по t: две аварии, выбытие, прокол.
#
# Круг 21 сентября печатал «две аварии» без интервала вовсе, а выбытие и
# прокол — по 1,96 при шести днях: половина интервала занижена в
# 2,571 / 1,96 ≈ 1,31 раза. Теперь интервал один на все замеры —
# `vrptw/stats.py`, парно по дням, по t.
#
# Бюджет пересчёта — в СЕКУНДАХ (1,5 с): только на питании, с открытой
# крышкой, под caffeinate, без параллельной нагрузки. Питание и крышка
# проверяются до старта; журнал сна — в конце.
#
# Имена переменных латиницей: zsh не берёт кириллицу в идентификаторах.
cd "$(dirname "$0")/.."
SRC="замеры-16-09"
OUT="замеры-22-09"
export PYTHONPATH=.

if ! pmset -g batt | head -1 | grep -q "AC Power"; then
  echo "не на питании — секундный замер не запускаю"; exit 1
fi
if ioreg -r -k AppleClamshellState -d 4 | grep -q '"AppleClamshellState" = Yes'; then
  echo "крышка закрыта — секундный замер не запускаю"; exit 1
fi

START=$(date '+%F %T')
echo "пересчёт с интервалами начат: $START"
echo "питание: $(pmset -g batt | head -1)"
echo "отпечаток кода: $(python3 -c 'from vrptw.server import отпечаток_кода; print(отпечаток_кода())')"
echo "коммит: $(git rev-parse --short HEAD)"

run() {
  local name="$1"; shift
  echo "═══ $name   [$(date '+%T')]"
  if python3 -u "$@" > "$OUT/$name.txt" 2>&1; then
    echo "    готово $name [$(date '+%T')]"
  else
    echo "    УПАЛО $name [$(date '+%T')] — хвост:"
    tail -6 "$OUT/$name.txt" | sed 's/^/      /'
  fi
}

run "пересчёт-на-зонах" "$SRC/пересчёт-на-зонах.py" replan
run "выбытие-на-зонах"  "$SRC/пересчёт-на-зонах.py" dropout
run "прокол-на-зонах"   "$SRC/на-зонах.py" прокол

echo "───── журнал сна за время прогона ─────"
SLEPT=$(pmset -g log | awk -v s="$START" '$1" "$2 >= s' | grep -cE " Sleep  ")
echo "записей Sleep с $START: $SLEPT"
if [ "$SLEPT" -gt 0 ]; then echo "МАШИНА СПАЛА — результаты не замер"; else echo "машина не спала — замеры действительны"; fi
echo "закончено: $(date '+%F %T')"
