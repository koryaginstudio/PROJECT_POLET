#!/bin/zsh
# Проверка с нуля: то, что увидит проверяющий, склонировав репозиторий.
#
# Клон во временный каталог (только закоммиченное!) → зависимости → движок
# без интернета → сколько до первого ответа и до конца прогрева → ключевые
# ручки → открывается ли интерфейс с того же адреса → README. Прогнать
# перед каждой отправкой; код выхода 0 — всё на месте.
#
#   zsh проверка-с-нуля.sh           как есть, с готовыми планами
#   zsh проверка-с-нуля.sh холодно   без готовых планов — худший случай
#
# Имена переменных латиницей: zsh не берёт кириллицу в идентификаторах.
set -u
REPO="$(cd "$(dirname "$0")" && pwd)"
BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
WORK="$(mktemp -d -t vrptw-check-from-zero)"
PORT=8765
MODE="${1:-}"
FAIL=0
PID=""
bad() { echo "  ✗ $*"; FAIL=1; }
ok() { echo "  ✓ $*"; }
cleanup() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

echo "Проверка с нуля: ветка $BRANCH, коммит $(git -C "$REPO" rev-parse --short HEAD)"
if [ -n "$(git -C "$REPO" status --porcelain -- vrptw web README.md requirements.txt)" ]; then
  echo "  ! есть незакоммиченные правки — клон их не увидит"
fi
git clone -q -b "$BRANCH" "$REPO" "$WORK/repo" || { echo "  ✗ клон не удался"; exit 1; }
cd "$WORK/repo" || exit 1
if [ "$MODE" = "холодно" ]; then
  rm -rf vrptw/data/готовые
  echo "  (готовые планы убраны — худший случай)"
fi

echo "\n── зависимости"
if python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
  ok "Python $(python3 -V 2>&1 | cut -d' ' -f2)"
else
  bad "нужен Python 3.10 или новее"
fi
if python3 -c 'import numpy, scipy' 2>/dev/null; then
  ok "numpy и scipy на месте"
else
  bad "нет numpy или scipy: pip install -r requirements.txt"
fi

echo "\n── движок без интернета"
T0=$(date +%s)
VRPTW_OFFLINE=1 python3 -u -m vrptw.server "$PORT" восток,юго-восток,югоцентр \
  > "$WORK/engine.log" 2>&1 &
PID=$!
for i in {1..120}; do
  curl -s -m 2 "localhost:$PORT/api/health" > /dev/null && break
  sleep 1
done
T1=$(date +%s)
if ! curl -s -m 2 "localhost:$PORT/api/health" > /dev/null; then
  bad "движок не ответил за 120 с — хвост журнала:"
  tail -15 "$WORK/engine.log" | sed 's/^/      /'
  exit 1
fi
if [ $((T1 - T0)) -le 15 ]; then
  ok "первый ответ через $((T1 - T0)) с — страница открывается сразу"
else
  bad "первый ответ только через $((T1 - T0)) с — порт открывается после прогрева"
fi
WARM="True"
for i in {1..300}; do
  WARM=$(curl -s -m 5 "localhost:$PORT/api/health" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin).get("warming") is None)' 2>/dev/null)
  [ "$WARM" = "True" ] && break
  sleep 2
done
T2=$(date +%s)
if [ "$WARM" = "True" ]; then
  ok "прогрев трёх участков закончен через $((T2 - T0)) с"
else
  bad "прогрев не закончился за 10 минут"
fi
grep -E "готовых планов|не собрался" "$WORK/engine.log" | sed 's/^ */      /'

echo "\n── ключевые ручки (участок «восток»)"
EAST=$(python3 -c 'import urllib.parse; print(urllib.parse.quote("восток"))')
probe() {
  # probe <что> <путь> <предел, с>: 200, JSON и не дольше предела
  local label="$1" url="localhost:$PORT$2" limit="$3"
  local started=$(python3 -c 'import time; print(time.time())')
  local code=$(curl -s -m 120 -o "$WORK/answer.json" -w "%{http_code}" "$url")
  local took=$(python3 -c "import time; print(round(time.time() - $started, 1))")
  if [ "$code" = "200" ] && python3 -c "import json; json.load(open('$WORK/answer.json'))" 2>/dev/null; then
    if python3 -c "import sys; sys.exit($took > $limit)"; then
      ok "$label — $took с"
    else
      bad "$label — $took с, дольше $limit с"
    fi
  else
    bad "$label — код $code"
  fi
}
probe "список дней"                 "/api/days"                                       2
probe "план участка"                "/api/plan?day=$EAST"                             3
probe "почему так (объяснение)"     "/api/explain?day=$EAST"                          3
probe "сводка симуляции"            "/api/simulation?day=$EAST"                       3
probe "график выхода"               "/api/shifts?day=$EAST"                           3
probe "базовый вариант ТЗ"          "/api/baseline?day=$EAST"                         3
probe "сколько ещё людей"           "/api/staffing?day=$EAST"                         3
probe "пересчёт: две аварии"        "/api/replan?day=$EAST&at=820&urgent=2"           6
probe "пересчёт: инженер выбыл"     "/api/replan?day=$EAST&at=720&disabled=auto"      6
probe "пересчёт: абонент отказался" "/api/replan?day=$EAST&at=720&cancelled=auto"     6

echo "\n── интерфейс с того же адреса"
CTYPE=$(curl -s -m 10 -o "$WORK/index.html" -w "%{content_type}" "localhost:$PORT/")
if [[ "$CTYPE" == text/html* ]] && grep -q 'id="root"' "$WORK/index.html"; then
  ASSET=$(grep -oE '/assets/[^"]+\.js' "$WORK/index.html" | head -1)
  if [ -n "$ASSET" ] && [ "$(curl -s -m 10 -o /dev/null -w "%{http_code}" "localhost:$PORT$ASSET")" = "200" ]; then
    ok "интерфейс открывается: http://localhost:$PORT/"
  else
    bad "страница есть, но её скрипт не отдаётся ($ASSET)"
  fi
else
  bad "интерфейса нет: по адресу отдаётся $CTYPE — сборки вёрстки нет в web/"
fi

echo "\n── README"
if grep -q "python3 -m vrptw.server" README.md && grep -q "requirements.txt" README.md; then
  ok "README говорит, как поставить и запустить"
else
  bad "README не говорит, как запустить"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "✓ С нуля всё работает."
else
  echo "✗ С нуля работает не всё — см. ✗ выше."
fi
exit "$FAIL"
