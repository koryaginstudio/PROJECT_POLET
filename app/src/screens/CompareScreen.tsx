import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Lede } from '../app/Lede.tsx';
import { Button } from '../ds/components/core/Button.jsx';
import type { DaySummary, RunId } from '../data/load.ts';
import { runCode, runEntry, stampOf, whenLabel } from '../data/load.ts';
import { dec, plural } from '../data/derive.ts';
import type { Registry, RunStat } from '../data/registry.ts';
import { deleteCompare, engineAlive, listCompares, saveCompare, EngineError } from '../data/api.ts';
import type { SavedCompare, SavedCompareRun } from '../data/api.ts';
import { RunCard } from '../app/RunCard.tsx';
import { RunMenu } from '../app/RunMenu.tsx';
import { COMPARE_MAX, COMPARE_MIN } from '../app/compare.ts';
import { CompareStats } from '../app/CompareStats.tsx';
import { ExportMenu } from '../app/ExportMenu.tsx';
import type { ExportKind } from '../app/ExportMenu.tsx';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';

/* Порядок в списке готовых расчётов. Ровно те три, которыми набор и собирают:
   последние подряд, по номеру или по тому, где покрытие вышло выше. */
type RunSort = 'fresh' | 'code' | 'coverage';

const RUN_SORTS = [
  { value: 'fresh', label: 'Свежие' },
  { value: 'code', label: 'По номеру' },
  { value: 'coverage', label: 'По покрытию' }
];

/* Сколько расчётов показываем сразу. Столько же, сколько в диспетчерской:
   список один и тот же, и вести себя он обязан одинаково. */
const RUN_PAGE = 10;

function sortRuns(list: DaySummary[], sort: RunSort): DaySummary[] {
  const rows = [...list];
  if (sort === 'coverage') return rows.sort((a, b) => b.coverage - a.coverage);
  if (sort === 'code') return rows.sort((a, b) => a.code.localeCompare(b.code));
  /* «Свежие» — это порядок истории задом наперёд: она приходит от старых к
     новым, и последний посчитанный стоит в ней последним. */
  return rows.reverse();
}

interface Props {
  /** Расчёты, отобранные к сравнению. */
  picks: RunId[];
  /** Справочники: карточка здесь та же, что в базе, и цифры для неё берутся
      оттуда же. Пусто — ещё грузятся. */
  registry: Registry | null;
  /** История расчётов: из неё пустое место выбирает, что добавить. */
  runs: DaySummary[] | null;
  /** Расчёт, открытый в диспетчерской: метка на карточке та же, что в базе. */
  active: string | null;
  /** Отобрать или снять — одно и то же действие, как и в базе расчётов. */
  onToggle: (id: RunId) => void;
  onClear: () => void;
  /** Кладёт в набор готовый список расчётов: так открывается запись архива. */
  onRestore: (ids: RunId[]) => void;
  onGoRuns: () => void;
  onOpen: (id: RunId) => void;
  onOpenMap: (id: RunId) => void;
  onGo: (id: RunId) => void;
}

/* Сравнение расчётов.

   Набор собирают двумя путями: кнопкой в карточке базы расчётов и лентой
   наверху этого экрана. Лента — та же, что в подшапке диспетчерской, но
   работает иначе: там она переключает открытый расчёт, здесь набирает.
   Ради неё и стоит: уходить в базу ради одного номера, который помнишь
   наизусть, — лишняя дорога.

   Отобранное показывается теми же карточками, что и в базе. Раньше здесь
   стояли одни номера с крестиком, и экран требовал держать в голове, что
   за R029 и чем он отличался от R031: отбирали по карточкам, а получали
   список.

   «Сохранить сравнение» кладёт набор в архив движка — снимком, а не
   ссылками: расчёт могут переименовать или удалить, а сохранённое сравнение
   обязано остаться читаемым. Оно отвечает на вопрос «что мы видели, когда
   принимали решение», и это и есть причина возвращаться к нему через
   неделю. */
export function CompareScreen({
  picks,
  registry,
  runs,
  active,
  onToggle,
  onClear,
  onRestore,
  onGoRuns,
  onOpen,
  onOpenMap,
  onGo
}: Props) {
  /* Сохранённые сравнения лежат у движка. Без него экран работает как
     раньше — набор собирается и показывается, — но сохранять его некуда, и
     об этом сказано заранее, а не отказом по нажатию. */
  const [saved, setSaved] = useState<SavedCompare[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    /* Без движка архива нет — и это ответ, а не ожидание: пустой список,
       чтобы «Читаем архив…» не горело вечно. */
    if (!engineAlive()) {
      setSaved([]);
      return;
    }
    let cancelled = false;
    listCompares()
      .then((list) => !cancelled && setSaved(list))
      .catch(() => !cancelled && setSaved([]));
    return () => {
      cancelled = true;
    };
  }, []);

  const short = picks.length < COMPARE_MIN;
  /* Вход в раздел устроен как в диспетчерской: пустой набор сначала
     спрашивает, что открыть, — собрать новое или посмотреть сохранённое.
     Спрашивать при непустом наборе нельзя: расчёты отобрали в базе именно
     затем, чтобы их сравнить, и лишний вопрос на дороге к ответу — это
     решение за диспетчера, а не для него. */
  /* Сохранённые сравнения раскрыты сразу: за ними сюда и приходят чаще
     всего — посмотреть, к чему пришли в прошлый раз, — и прятать готовый
     ответ за лишним щелчком незачем. Пустой архив раскрывать нечего, и
     список тогда просто не показывается. */
  const [picking, setPicking] = useState(true);
  /* Набор собирают прямо здесь, списком готовых расчётов. Пока список открыт,
     экран остаётся входным: иначе первый же отмеченный расчёт закрывал бы
     список и заставлял открывать его заново ради второго — а меньше двух
     расчётов сравнение не берёт. */
  const [building, setBuilding] = useState(false);
  /* Код открытого из архива сравнения. Сам набор при открытии восстанавливается
     как обычный: архив хранит, какие расчёты сравнивали, а разбор строится из
     их планов — тогда открытая запись показывает то же, что живой набор, а не
     семь чисел в таблице. */
  const [openedCode, setOpenedCode] = useState<string | null>(null);
  /* Показан набор или экран ещё входной. Раньше это выводилось из числа
     отобранных расчётов, и выходило неверно: свёрнутый список означал «я
     передумал смотреть список», а экран понимал его как «показывай сравнение»
     и подменял собой ворота. Теперь переход делает только кнопка «Показать
     сравнение» — свернуть список и уйти к сравнению это два разных действия,
     и решает, какое из них произошло, диспетчер, а не мы за него.

     Набор, собранный в другом месте — лентой в подшапке или в базе расчётов, —
     показан сразу: там его отобрали именно затем, чтобы сравнить. */
  const [showing, setShowing] = useState(picks.length > 0);
  /* Сняли всё — показывать нечего, и экран возвращается к воротам сам. */
  useEffect(() => {
    if (picks.length === 0) setShowing(false);
  }, [picks.length]);
  const gate = !showing && !openedCode;

  /* Номер сравнения — из той же серии, что и у всего остального: C001 и дальше.
     Открытая запись носит свой, новый набор — первый свободный. Считаем по
     архиву, а не заводим счётчик: номер присваивает движок при сохранении, и
     два источника нумерации однажды разошлись бы.

     Без движка номера нет вовсе: обещать «C001», которого никто не
     присвоит, значит врать в заголовке. */
  const nextCode = (() => {
    if (!engineAlive()) return null;
    const used = (saved ?? [])
      .map((item) => Number(item.code.replace(/\D/g, '')))
      .filter((value) => Number.isFinite(value));
    return `C${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
  })();
  const code = openedCode ?? nextCode;

  /* Удалить запись из архива. Возвращает, чем кончилось: строка означает
     неудачу, и строка архива покажет её на месте, а не проглотит. Не
     удалилось — запись остаётся на экране: это честнее, чем убрать её из
     списка и сделать вид, что архив её больше не помнит. */
  async function dropSaved(id: string): Promise<string | null> {
    try {
      await deleteCompare(id);
      setSaved((prev) => (prev ?? []).filter((item) => item.id !== id));
      return null;
    } catch (error) {
      return error instanceof EngineError
        ? error.message
        : 'Удалить не вышло: программа расчёта не ответила. Повторите попытку.';
    }
  }

  /* Порядок карточек — тот же, что в базе: сверху свежие. Держать их в
     порядке отбора значило бы, что один и тот же набор выглядит по-разному
     в зависимости от того, с какого расчёта начали.

     Пока справочники не пришли, карточек нет — но места под них есть:
     пустой экран вместо ряда мест означал бы, что раздел ещё не построен,
     хотя он построен и ждёт данных. */
  const byId = new Map((registry?.stats.byRun ?? []).map((row) => [row.run.id, row]));
  const rows = picks
    .map((id) => byId.get(id))
    .filter((row): row is RunStat => Boolean(row))
    .sort((a, b) => b.run.created.localeCompare(a.run.created));

  /* Формат, который выбрали последним. Само наполнение файлов ещё не
     собрано, и делать вид, что оно есть, нельзя: экран отвечает тем, что
     знает, — формат принят, файла пока нет. */
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const exportAs = (kind: ExportKind) => setExporting(kind);

  async function save() {
    setBusy(true);
    setFailed(null);
    try {
      const record = await saveCompare(rows.map(snapshot));
      setSaved((prev) => [...(prev ?? []), record]);
    } catch (error) {
      setFailed(error instanceof EngineError ? error.message : 'Сравнение не сохранилось');
    } finally {
      setBusy(false);
    }
  }

  /* Сохранённое сравнение открывается своим снимком, а не набором ссылок:
     расчёт могли переименовать или удалить, а запись обязана остаться
     читаемой — в этом и смысл архива. */
  if (gate) {
    return (
      <CompareGate
        saved={saved}
        picking={picking}
        onPick={() => {
          setPicking((value) => !value);
          setBuilding(false);
        }}
        runs={runs}
        picks={picks}
        building={building}
        onBuild={() => {
          setBuilding((value) => !value);
          setPicking(false);
        }}
        onToggle={onToggle}
        onShow={() => {
          setBuilding(false);
          setShowing(true);
        }}
        onClearPicks={onClear}
        onGoRuns={onGoRuns}
        onOpen={(record) => {
          onRestore(record.runs.map((one) => one.id));
          setOpenedCode(record.code);
          setPicking(false);
          setBuilding(false);
          setShowing(true);
        }}
        onDrop={dropSaved}
      />
    );
  }

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          {/* В заголовке — номер сравнения, а не счётчик отобранного. Сколько
              расчётов в наборе, видно по карточкам под ним; а вот чем это
              сравнение будет называться в архиве — больше нигде не сказано. */}
          <h2 className="dash__section-title">
            {code ? `Сравнение ${code}` : 'Сравнение'}
            {openedCode && <span className="dbrun__date">из архива</span>}
            {!code && <span className="dbrun__date">без номера: программа расчёта не запущена</span>}
          </h2>
          {picks.length > 0 && (
            <button
              type="button"
              className="dash__section-link"
              onClick={() => {
                onClear();
                setOpenedCode(null);
              }}
            >
              Снять все
            </button>
          )}
        </div>

        {/* Говорим только тогда, когда есть что сказать: набора не хватает.
            Собранный набор виден сам — карточками и числом в заголовке. */}
        {short && (
          <p className="clients__lede">
            Расчёты отбирают лентой в подшапке или кнопкой «В сравнение» в{' '}
            <button type="button" className="dash__section-link" onClick={onGoRuns}>
              базе расчётов
            </button>
            . Нужно от {COMPARE_MIN} до {COMPARE_MAX}.
          </p>
        )}

        {picks.length > 0 && !registry && (
          <p className="clients__lede">Читаем планы отобранных расчётов…</p>
        )}

        {/* Четыре места в ряд — ровно столько, сколько сравнение берёт.
            Пустое место говорит «есть куда добавить» собой, а не числом в
            заголовке, и ряд не скачет при каждом снятии. */}
        <div className="compare__grid">
          {rows.map((row) => (
            <RunCard
              key={row.run.id}
              row={row}
              bounds={registry!.bounds}
              /* Списки инженеров и маршрутов сюда не передаём: в «Сравнении»
                 карточек до пяти в ряд, и два десятка чипов на каждой
                 вытеснили бы вниз то, ради чего сюда и приходят, — ряды
                 диаграмм. Кем занят расчёт, разбирают в его карточке в базе;
                 здесь сравнивают итоги. */
              isActive={row.run.id === active}
              picked
              headAction="drop"
              showCompare={false}
              onOpen={onOpen}
              onOpenMap={onOpenMap}
              onGo={onGo}
              onCompare={onToggle}
            />
          ))}

          {Array.from({ length: COMPARE_MAX - rows.length }, (_, index) => (
            <Slot
              key={`slot-${index}`}
              runs={runs}
              picks={picks}
              onPick={onToggle}
              /* Список выпадает от своего места: у левых мест — вправо, у
                 правых — влево, иначе он вылезал бы за край панели. */
              align={rows.length + index < COMPARE_MAX / 2 ? 'left' : 'right'}
            />
          ))}
        </div>

        {/* Расчёты, которых в справочниках не нашлось: запись правили или
            удаляли, пока набор лежал отобранным. Молчать об этом нельзя —
            иначе число в заголовке разойдётся с числом карточек. */}
        {registry && rows.length < picks.length && (
          <p className="clients__lede">
            {picks.length - rows.length} из отобранных расчётов больше нет в базе — их записи
            удалили. Снимите их кнопкой «Снять все» и отберите заново:{' '}
            {picks
              .filter((id) => !byId.has(id))
              .map((id) => runCode(id))
              .join(', ')}
            .
          </p>
        )}

        {failed && (
          <div className="solvefail">
            <Icon name="alert-triangle" size={16} />
            <span>
              <b>Сравнение не сохранилось.</b> {failed}
            </span>
          </div>
        )}

        <div className="compare__foot">
          <span className="compare__foot-note">
            {/* Строка объясняет только то, что мешает нажать. Когда набор
                собран и движок на месте, объяснять нечего: кнопка горит и
                говорит за себя. */}
            {!engineAlive()
              ? 'Сохранить сравнение некуда: архив сравнений ведёт программа расчёта, а она не запущена. Набор живёт до перезагрузки страницы.'
              : short
                ? `Для сравнения нужно хотя бы ${COMPARE_MIN} расчёта.`
                : null}
          </span>
          {/* Выгрузка стоит рядом с сохранением, но отвечает за другое:
              сохранение кладёт набор в архив программы, выгрузка выносит его
              наружу — в чужую таблицу или в чужой отчёт.

              Кнопка называется тем, что делает: сравнение уже показано
              ниже, а нажатие кладёт его снимок в архив. «Запустить» обещало
              счёт, которого здесь нет. */}
          <ExportMenu onPick={exportAs} disabled={short} />
          <span
            title={
              !engineAlive()
                ? 'Сохранение недоступно: архив сравнений ведёт программа расчёта, а она не запущена'
                : undefined
            }
          >
            <Button
              variant="accent"
              size="sm"
              onClick={save}
              disabled={short || busy || !engineAlive()}
              iconLeft={<Icon name="check" size={14} />}
            >
              {busy ? 'Сохраняю…' : 'Сохранить сравнение'}
            </Button>
          </span>
        </div>

        {/* Форматы выбраны, а наполнение файлов ещё не собрано. Говорим об
            этом прямо и тогда, когда спросили: тихая кнопка, которая ничего
            не делает, читается как поломка. */}
        {exporting && (
          <p className="compare__note">
            {exporting === 'xlsx'
              ? 'Выгрузка в книгу Excel готовится: формат выбран, наполнение соберём следующим шагом.'
              : 'Выгрузка в PDF готовится: формат выбран, наполнение соберём следующим шагом.'}
          </p>
        )}
      </section>

      {/* Разбор появляется сам, как только расчётов стало хотя бы два:
          отобрали — значит, хотят сравнить, и требовать ещё одного нажатия
          после этого незачем. */}
      {registry && (
        <CompareStats
          rows={rows}
          profiles={rows
            .map((row) => registry.profiles.find((one) => one.run.id === row.run.id))
            .filter((one): one is NonNullable<typeof one> => Boolean(one))}
        />
      )}

      <SavedList
        saved={saved}
        onOpen={(record) => {
          onRestore(record.runs.map((one) => one.id));
          setOpenedCode(record.code);
        }}
        onDrop={dropSaved}
      />
    </div>
  );
}

/** Снимок расчёта для архива: имена полей — как у движка. */
function snapshot(row: RunStat): SavedCompareRun {
  return {
    id: row.run.id,
    code: row.run.code,
    created: row.run.created,
    /* Номер дня у движка знает запись истории, а не справочник: в
       справочнике лежит то, что посчитано, а день — то, по чему считали. */
    day: runEntry(row.run.id)?.day,
    note: row.run.note,
    orders: row.orders,
    assigned: row.assigned,
    coverage: row.coverage,
    assigned_share: row.assignedShare,
    routes: row.routes,
    visits: row.visits,
    travel_minutes: row.travelMinutes,
    occupancy: row.occupancy,
    engineers_total: row.engineersTotal,
    engineers_on_route: row.engineersOnRoute
  };
}

/* Вход в раздел. Тот же вопрос, что встречает в диспетчерской: собрать новое
   или открыть готовое. Стоит он только на пустом месте — когда расчёты уже
   отобраны, ответ на него дан отбором.

   «Собрать» уводит в базу расчётов, а не заводит пустой набор здесь: набирают
   всё равно там, по карточкам с картой и цифрами, и делать вид, что набрать
   можно и тут, значило бы вести к той же базе длинной дорогой. */
function CompareGate({
  saved,
  picking,
  onPick,
  runs,
  picks,
  building,
  onBuild,
  onToggle,
  onShow,
  onClearPicks,
  onGoRuns,
  onOpen,
  onDrop
}: {
  saved: SavedCompare[] | null;
  picking: boolean;
  onPick: () => void;
  runs: DaySummary[] | null;
  picks: RunId[];
  building: boolean;
  onBuild: () => void;
  onToggle: (id: RunId) => void;
  onShow: () => void;
  onClearPicks: () => void;
  onGoRuns: () => void;
  onOpen: (record: SavedCompare) => void;
  onDrop: (id: string) => Promise<string | null>;
}) {
  const list = saved ?? [];
  /* Чем упорядочен список готовых расчётов. Порядки самые обычные — по дате,
     по номеру, по покрытию: набор собирают либо «последние подряд», либо
     «лучшие из посчитанных», и других вопросов к этому списку не задают. */
  const [sort, setSort] = useState<RunSort>('fresh');
  /* Список длинный — показываем первые и кнопку «раскрыть», как в
     диспетчерской: набор собирают из свежих, а за старым идут осознанно. */
  const [expanded, setExpanded] = useState(false);
  const ready = useMemo(() => sortRuns(runs ?? [], sort), [runs, sort]);
  const shown = expanded ? ready : ready.slice(0, RUN_PAGE);
  const hiddenRuns = ready.length - shown.length;
  const full = picks.length >= COMPARE_MAX;

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Сравнение расчётов</h2>
          <span className="dash__section-note">
            {saved === null
              ? 'Читаем архив…'
              : list.length > 0
                ? `${plural(list.length, 'сравнение', 'сравнения', 'сравнений')} в архиве`
                : 'в архиве пусто'}
          </span>
        </div>

        <Lede first="Соберите новый набор из базы расчётов или откройте тот, что сохранили раньше.">
          Сравнение отвечает на вопрос «чем эти планы отличались»: итоги рядом и ход дня по
          часам, наложенный друг на друга.
        </Lede>

        <div className="gate">
          <button
            type="button"
            className={'gate__card gate__card--accent' + (building ? ' gate__card--on' : '')}
            onClick={onBuild}
          >
            <span className="gate__icon">
              <Icon name="shuffle" size={22} />
            </span>
            <span className="gate__title">Собрать сравнение</span>
            <span className="gate__note">
              Отметить от {COMPARE_MIN} до {COMPARE_MAX} посчитанных расчётов — прямо здесь,
              списком.
            </span>
            <span className="gate__go">
              {building ? 'Свернуть список' : 'Выбрать расчёты'}
              <Icon name={building ? 'chevron-up' : 'chevron-down'} size={13} />
            </span>
          </button>

          <button
            type="button"
            className={'gate__card' + (picking ? ' gate__card--on' : '')}
            onClick={onPick}
            disabled={list.length === 0}
          >
            <span className="gate__icon">
              <Icon name="stack" size={22} />
            </span>
            <span className="gate__title">Открыть сохранённое</span>
            <span className="gate__note">
              {list.length === 0
                ? engineAlive()
                  ? 'Пока ничего не сохранено. Соберите набор и нажмите «Сохранить сравнение».'
                  : 'Архив сравнений ведёт программа расчёта, а она не запущена: сохранённых сравнений нет.'
                : 'Снимок набора, каким он был в день сохранения.'}
            </span>
            <span className="gate__go">
              {list.length === 0 ? 'Нечего открывать' : picking ? 'Свернуть список' : 'Выбрать'}
              <Icon name={picking ? 'chevron-up' : 'chevron-down'} size={13} />
            </span>
          </button>
        </div>

        {building && (
          <div className="gatepick">
            <div className="dash__section-head">
              <h3 className="dash__section-title">Посчитанные расчёты</h3>
              <span className="gatetools">
                <span className="dash__section-note">
                  {picks.length === 0
                    ? `Отметьте от ${COMPARE_MIN} до ${COMPARE_MAX}`
                    : `Отмечено ${picks.length} из ${COMPARE_MAX}`}
                </span>
                <SegmentedControl
                  size="sm"
                  items={RUN_SORTS}
                  value={sort}
                  onChange={(next) => setSort(next as RunSort)}
                />
              </span>
            </div>

            {runs === null ? (
              <p className="stub__body">Собираем расчёты…</p>
            ) : ready.length === 0 ? (
              <p className="runmenu__empty">Посчитанных расчётов пока нет.</p>
            ) : (
              <div className="gatelist">
                {shown.map((run) => {
                  const picked = picks.includes(run.id);
                  return (
                    <button
                      key={run.id}
                      type="button"
                      className={'gaterow' + (picked ? ' gaterow--active' : '')}
                      /* Шестой расчёт не берётся: сравнение читает до пяти, и
                         гасим мы именно то, что нельзя отметить, — снять уже
                         отмеченное можно всегда. */
                      disabled={full && !picked}
                      title={
                        full && !picked
                          ? `В сравнении уже ${COMPARE_MAX} расчёта — сначала снимите лишний`
                          : picked
                            ? 'Снять из сравнения'
                            : 'Добавить в сравнение'
                      }
                      onClick={() => onToggle(run.id)}
                    >
                      <span className="gaterow__code">{run.code}</span>
                      {/* Когда считали, а не какой день разложен: дата
                          выгрузки у всех одна и ничего не различает. */}
                      <span className="gaterow__when">{whenLabel(run.created)}</span>
                      <span className="gaterow__facts">
                        покрытие {dec(run.coverage)} % · разложено{' '}
                        {run.ordersAssigned} из {run.ordersTotal} · без инженера {run.unassigned}
                      </span>
                      {picked ? (
                        <Icon name="check" size={14} />
                      ) : (
                        <Icon name="plus" size={14} />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {hiddenRuns > 0 && (
              <button type="button" className="tblmore" onClick={() => setExpanded(true)}>
                Раскрыть ещё {hiddenRuns}
                <span className="tblmore__rest">всего {ready.length}</span>
              </button>
            )}

            {expanded && ready.length > RUN_PAGE && (
              <button type="button" className="tblmore" onClick={() => setExpanded(false)}>
                Свернуть до {RUN_PAGE}
              </button>
            )}

            <div className="gatepick__foot">
              <Button
                variant="accent"
                size="sm"
                disabled={picks.length < COMPARE_MIN}
                onClick={onShow}
              >
                {picks.length < COMPARE_MIN
                  ? `Нужно ещё ${COMPARE_MIN - picks.length}`
                  : `Показать сравнение · ${picks.length}`}
              </Button>
              {/* Карточки с картой и цифрами живут в базе расчётов: кому номера
                  мало, тот идёт туда, а не выбирает вслепую. */}
              <button type="button" className="dash__section-link" onClick={onGoRuns}>
                Открыть базу расчётов
              </button>
            </div>
          </div>
        )}

        {/* Список свернули, а отобранное никуда не делось — и дорога к нему
            обязана остаться на виду. Иначе набор есть, а показать его нечем:
            свёрнутый список уводил бы к сравнению сам, а это не то, о чём
            просили, нажимая «свернуть». */}
        {!building && picks.length > 0 && (
          <div className="gatepick__foot gatepick__foot--alone">
            <Button
              variant="accent"
              size="sm"
              disabled={picks.length < COMPARE_MIN}
              onClick={onShow}
            >
              {picks.length < COMPARE_MIN
                ? `Отобран ${picks.length} расчёт — нужно ещё ${COMPARE_MIN - picks.length}`
                : `Показать сравнение · ${picks.length}`}
            </Button>
            <button type="button" className="dash__section-link" onClick={onClearPicks}>
              Снять отобранное
            </button>
          </div>
        )}

        {picking && list.length > 0 && (
          <div className="saved">
            {[...list].reverse().map((item) => (
              <SavedRow key={item.id} item={item} onOpen={() => onOpen(item)} onDrop={onDrop} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* Открытое сохранённое сравнение. Читается из снимка и ничего не пересчитывает:
   запись отвечает на вопрос «что мы видели, когда принимали решение», и
   подставлять в неё сегодняшние числа значило бы отвечать на другой. */

/* Что уже сохранено. Список стоит под набором, а не отдельным разделом:
   сохранённое сравнение — тот же набор, только вчерашний, и ходить за ним
   в другое место незачем. */
function SavedList({
  saved,
  onOpen,
  onDrop
}: {
  saved: SavedCompare[] | null;
  onOpen: (record: SavedCompare) => void;
  onDrop: (id: string) => Promise<string | null>;
}) {
  if (!saved || saved.length === 0) return null;

  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Сохранённые сравнения · {saved.length}</h2>
      </div>

      <div className="saved">
        {[...saved].reverse().map((item) => (
          <SavedRow key={item.id} item={item} onOpen={() => onOpen(item)} onDrop={onDrop} />
        ))}
      </div>
    </section>
  );
}

/* Строка архива. Одна на оба места — на входе в раздел и под собранным
   набором: это одна и та же запись, и выглядеть она должна одинаково. Номер
   открывает запись, корзина удаляет; всё остальное в строке — содержание, а
   не действие.

   Удаление в два шага, как у записи расчёта: первый щелчок только
   спрашивает, и промах по корзине не стоит сравнения. Неудача пишется
   тут же, в строке. */
function SavedRow({
  item,
  onOpen,
  onDrop
}: {
  item: SavedCompare;
  onOpen: () => void;
  onDrop: (id: string) => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  const drop = async () => {
    setDropping(true);
    setFailed(null);
    const why = await onDrop(item.id);
    setDropping(false);
    setConfirming(false);
    if (why) setFailed(why);
  };

  return (
    <article className="saved__row">
      <button type="button" className="saved__code saved__code--open" onClick={onOpen}>
        {item.code}
      </button>
      <span className="saved__stamp">
        <Icon name="clock" size={12} />
        {stampOf(item.created)}
      </span>
      <span className="saved__runs">
        {item.runs.map((one) => (
          <span
            key={one.id}
            className="saved__run"
            title={`${one.code} · покрытие ${Math.round(one.coverage * 100)}%`}
          >
            {one.code}
            <b>{Math.round(one.coverage * 100)}%</b>
          </span>
        ))}
      </span>
      {item.note && <span className="saved__note">{item.note}</span>}
      {failed && <span className="runedit__wrong">{failed}</span>}
      {confirming ? (
        <>
          <span className="runedit__ask">Удалить {item.code}?</span>
          <button type="button" className="runedit__danger" onClick={drop} disabled={dropping}>
            <Icon name="trash" size={13} />
            {dropping ? 'Удаляю…' : 'Удалить'}
          </button>
          <button
            type="button"
            className="runedit__cancel"
            onClick={() => setConfirming(false)}
            disabled={dropping}
          >
            Нет
          </button>
        </>
      ) : (
        <button
          type="button"
          className="runcard__edit runcard__edit--drop"
          onClick={() => setConfirming(true)}
          title={`Удалить сравнение ${item.code}`}
          aria-label={`Удалить сравнение ${item.code}`}
        >
          <Icon name="trash" size={13} />
        </button>
      )}
    </article>
  );
}

/* Свободное место под расчёт.

   Щелчок по нему открывает тот же список расчётов, что и кнопка «Ещё» в
   ленте, — прямо здесь, а не уводит в базу расчётов. Уход в другой раздел
   ради одного номера — лишняя дорога: место спрашивает «какой?», и ответ
   должен даваться на том же экране.

   Список после выбора не закрывается: мест несколько, и набирают обычно
   подряд. */
function Slot({
  runs,
  picks,
  onPick,
  align
}: {
  runs: DaySummary[] | null;
  picks: RunId[];
  onPick: (id: RunId) => void;
  align: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  return (
    <div className="compare__slot-box" ref={box}>
      <button
        type="button"
        className={'compare__slot' + (open ? ' compare__slot--on' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Выбрать расчёт"
      >
        <span className="compare__plus" aria-hidden="true">
          <Icon name="plus" size={18} />
        </span>
        <span className="compare__slot-label">Добавить расчёт</span>
      </button>

      {open && runs && (
        <RunMenu
          runs={runs}
          marked={picks}
          onPick={onPick}
          onClose={() => setOpen(false)}
          boxRef={box}
          closeOnPick={false}
          full={picks.length >= COMPARE_MAX}
          markLabel="В сравнении"
          fullHint={`В сравнении уже ${COMPARE_MAX} расчёта — сначала снимите лишний`}
          align={align}
        />
      )}
    </div>
  );
}
