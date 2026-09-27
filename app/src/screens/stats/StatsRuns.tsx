import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import type { RunStat } from '../../data/registry.ts';
import { dec, hoursText, occupancyMean, plural } from '../../data/derive.ts';
import { whenLabel } from '../../data/load.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { DbMore, usePaging } from '../db/DbBar.tsx';
import { percent, StatRank, StatsHead } from './parts.tsx';
import { runSeries } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Статистика по расчётам.

   Вопрос разреза — «как считается день»: сколько расчётов сделали, насколько
   полно они раскладывают заявки, насколько плотно грузят людей и куда это
   идёт от расчёта к расчёту. База расчётов на соседнем экране отвечает на
   другое — «какие расчёты у нас есть»; здесь их не листают, а меряют.

   Ряд расчётов внизу — то место, где разрез снова становится списком: он
   кладёт покрытие и загрузку каждого расчёта на общую стометровую шкалу, и
   74 % против 86 % читаются как разные длины, а не как два числа. */

/* Сколько расчётов показываем сразу. Столько же, сколько в базе расчётов:
   один и тот же список не должен обрываться в двух местах по-разному. */
const PAGE = 24;

type Sort = 'date' | 'coverage' | 'occupancy';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'date',
    label: 'По дате',
    note: 'Когда расчёт завели',
    desc: true,
    up: 'Сначала давние',
    down: 'Сначала свежие'
  },
  {
    value: 'coverage',
    label: 'По прогнозу',
    note: 'Насколько полно разложился день',
    desc: true,
    up: 'Сначала слабые',
    down: 'Сначала полные'
  },
  {
    value: 'occupancy',
    label: 'По загрузке',
    note: 'Насколько плотно заняты инженеры',
    desc: true,
    up: 'Сначала свободные',
    down: 'Сначала плотные'
  }
];

export function StatsRuns({ scope, period, onPeriod, countOf, onOpenRun, active }: DimProps) {
  const runs = scope.runs;

  const widgets = useMemo<WidgetDef[]>(() => {
    const orders = runs.reduce((sum, row) => sum + row.orders, 0);
    const assigned = runs.reduce((sum, row) => sum + row.assigned, 0);
    const loose = orders - assigned;
    const work = runs.reduce((sum, row) => sum + row.workMinutes, 0);
    const travel = runs.reduce((sum, row) => sum + row.travelMinutes, 0);
    const clean = runs.filter((row) => row.orders === row.assigned).length;
    /* Покрытие и загрузку усредняем по расчётам, а не от суммы заявок: здесь
       сравнивают расчёты между собой, и каждый весит одинаково. */
    const coverage = runs.length === 0 ? 0 : runs.reduce((sum, row) => sum + row.coverage, 0) / runs.length;
    const occupancy = occupancyMean(runs);
    const onRoute = runs.reduce((sum, row) => sum + row.engineersOnRoute, 0);
    const crew = runs.reduce((sum, row) => sum + row.engineersTotal, 0);
    const routes = runs.reduce((sum, row) => sum + row.routes, 0);
    const wheel = work + travel;

    return [
      {
        key: 'runs-count',
        title: 'Расчётов',
        note: 'Сколько расчётов сделано и скольким хватило инженеров',
        shape: 'number',
        data: {
          value: String(runs.length),
          caption: 'за выбранный срок',
          facts: [`${clean} разложили день целиком`, `${runs.length - clean} с хвостом`],
          whole: true,
          parts: [
            { key: 'clean', label: 'Без хвоста', value: clean, tone: 'ok' },
            { key: 'loose', label: 'С хвостом', value: runs.length - clean, tone: 'bad' }
          ],
          legend: 'расчётов'
        }
      },
      {
        key: 'coverage',
        title: 'Прогноз выполнения',
        note: 'Насколько полно расчёты раскладывают день и куда это идёт',
        shape: 'line',
        data: {
          value: percent(coverage),
          caption: 'в среднем по расчётам',
          tone: coverage >= 0.92 ? 'ok' : coverage >= 0.8 ? 'warn' : 'bad',
          series: runSeries(scope, (row) => row.coverage * 100),
          legend: '% прогноза'
        }
      },
      {
        key: 'occupancy',
        title: 'Загрузка инженеров',
        note: 'Насколько плотно занят день и как это менялось',
        shape: 'line',
        data: {
          value: percent(occupancy),
          caption: 'в среднем по расчётам',
          series: runSeries(scope, (row) => row.occupancy * 100),
          legend: '% загрузки'
        }
      },
      {
        key: 'orders',
        title: 'Заявок в расчётах',
        /* Считаются строки «заявка в расчёте», а не заявки по номерам:
           пересчитанный трижды участок нагрузил расчёты трижды. Разрез
           «Заявки» считает то же хозяйство по номерам, и числа там меньше —
           это не расхождение, а два разных вопроса. */
        note: 'Сколько раз заявки проходили через расчёты — повторный счёт участка считается снова',
        shape: 'number',
        data: {
          value: String(orders),
          caption: 'прошло через расчёты',
          facts: [runs.length > 0 ? `${Math.round(orders / runs.length)} на расчёт` : ''].filter(Boolean),
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          series: runSeries(scope, (row) => row.orders),
          legend: 'заявок'
        }
      },
      {
        key: 'loose',
        title: 'Осталось без инженера',
        note: 'Хвост расчётов: заявки, которым инженера не нашлось',
        shape: 'line',
        data: {
          value: String(loose),
          caption: 'не разложено',
          tone: loose > 0 ? 'bad' : 'ok',
          series: runSeries(scope, (row) => row.orders - row.assigned),
          legend: 'заявок без инженера'
        }
      },
      {
        key: 'travel-share',
        /* Доля дороги — показатель, которым в отрасли меряют качество
           раскладки: работа на объекте приносит пользу, дорога только
           тратит смену. Держат её ниже пятой части дня. */
        title: 'Доля дороги',
        note: 'Сколько смены уходит на переезды, а не на работу у клиента',
        shape: 'line',
        data: {
          value: percent(wheel === 0 ? 0 : travel / wheel),
          caption: 'от времени за рулём и на объектах',
          tone: wheel === 0 ? 'neutral' : travel / wheel <= 0.2 ? 'ok' : travel / wheel <= 0.3 ? 'warn' : 'bad',
          facts: [`${hoursText(travel)} в дороге`, `${hoursText(work)} на объектах`],
          whole: true,
          /* Доли в часах: в середине кольца стоит их сумма, и минуты там
             читались бы как ошибка счёта. */
          parts: [
            {
              key: 'work',
              label: 'На объектах',
              value: Math.round(work / 60),
              tone: 'ok',
              text: hoursText(work)
            },
            {
              key: 'travel',
              label: 'В дороге',
              value: Math.round(travel / 60),
              tone: 'warn',
              text: hoursText(travel)
            }
          ],
          series: runSeries(scope, (row) =>
            row.workMinutes + row.travelMinutes === 0
              ? 0
              : (row.travelMinutes / (row.workMinutes + row.travelMinutes)) * 100
          ),
          legend: '% дороги'
        }
      },
      {
        key: 'routes',
        title: 'Маршрутов построено',
        note: 'Сколько маршрутов дали расчёты и сколько выходит на один',
        shape: 'number',
        data: {
          value: String(routes),
          caption: 'построено',
          facts: [runs.length > 0 ? `${dec(routes / runs.length)} на расчёт` : ''].filter(Boolean),
          series: runSeries(scope, (row) => row.routes),
          legend: 'маршрутов'
        }
      },
      {
        key: 'crew',
        title: 'Инженеры с маршрутом',
        note: 'Сколько людей расчёты поставили на маршрут, а сколько оставили без',
        shape: 'donut',
        data: {
          value: String(onRoute),
          caption: `из ${crew} смен в расчётах`,
          whole: true,
          parts: [
            { key: 'routed', label: 'С маршрутом', value: onRoute, tone: 'ok' },
            { key: 'idle', label: 'Без маршрута', value: Math.max(0, crew - onRoute), tone: 'bad' }
          ],
          series: runSeries(scope, (row) => row.engineersOnRoute),
          legend: 'смен с маршрутом'
        }
      },
      {
        key: 'work-hours',
        title: 'Работы на объектах',
        note: 'Сколько часов расчёты отдали работе у клиента',
        shape: 'number',
        data: {
          value: hoursText(work),
          caption: 'у клиентов по плану',
          series: runSeries(scope, (row) => Math.round(row.workMinutes / 60)),
          legend: 'часов работы'
        }
      },
      {
        key: 'visits',
        title: 'Визитов запланировано',
        note: 'Сколько посещений стоит в маршрутах расчётов',
        shape: 'number',
        data: {
          value: String(runs.reduce((sum, row) => sum + row.visits, 0)),
          caption: 'стоит в маршрутах',
          series: runSeries(scope, (row) => row.visits),
          legend: 'визитов'
        }
      }
    ];
  }, [runs, scope]);

  const board = useWidgetBoard({
    storeKey: 'stats-runs',
    catalogue: widgets,
    fallback: ['runs-count', 'coverage', 'occupancy', 'orders', 'loose', 'travel-share'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Расчёты',
    fixed: true
  });

  /* Поиск и порядок ряда. Расчётов в истории со временем станут сотни, и «все
     подряд одним столбцом» перестаёт быть списком: нужный находят по номеру
     или по дате, а не прокруткой до нужного места. */
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('date');
  const [desc, setDesc] = useState(true);
  const paging = usePaging(PAGE);

  const pickSort = (value: Sort) => {
    paging.reset();
    if (value === sort) {
      setDesc((was) => !was);
      return;
    }
    setSort(value);
    setDesc(SORTS.find((rule) => rule.value === value)?.desc ?? true);
  };

  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = runs.filter(
      (row) =>
        !needle ||
        row.run.code.toLowerCase().includes(needle) ||
        row.run.created.toLowerCase().includes(needle) ||
        whenLabel(row.run.created).toLowerCase().includes(needle)
    );
    const rank = (row: RunStat) => {
      switch (sort) {
        case 'coverage':
          return row.coverage;
        case 'occupancy':
          return row.occupancy;
        default:
          return runs.indexOf(row);
      }
    };
    const side = desc ? -1 : 1;
    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : a.run.code.localeCompare(b.run.code));
    });
  }, [runs, query, sort, desc]);

  const shown = listed.slice(0, paging.limit);

  const weak = useMemo(
    () =>
      [...runs]
        .sort((a, b) => a.coverage - b.coverage)
        .filter((row) => row.orders > row.assigned)
        .slice(0, 8),
    [runs]
  );
  const heavy = useMemo(() => [...runs].sort((a, b) => b.travelMinutes - a.travelMinutes), [runs]);

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead
          title="Расчёты рядом"
          note={
            listed.length === runs.length
              ? `${plural(runs.length, 'расчёт', 'расчёта', 'расчётов')}, свежие сверху`
              : `${listed.length} из ${runs.length} по отбору`
          }
        />

        <div className="statsbar">
          <label className="dbsearch">
            <Icon name="search" size={14} />
            <input
              className="dbsearch__input"
              value={query}
              placeholder="Номер расчёта или дата"
              onChange={(event) => {
                setQuery(event.currentTarget.value);
                paging.reset();
              }}
            />
            {query && (
              <button
                type="button"
                className="dbsearch__clear"
                onClick={() => {
                  setQuery('');
                  paging.reset();
                }}
              >
                <Icon name="x" size={12} />
              </button>
            )}
          </label>
          <SortMenu
            rules={SORTS}
            value={sort}
            desc={desc}
            onPick={(value: string) => pickSort(value as Sort)}
            onOrder={(value: boolean) => {
              setDesc(value);
              paging.reset();
            }}
          />
        </div>

        {listed.length === 0 ? (
          <p className="runmenu__empty">
            Под этот отбор не подошёл ни один расчёт. Снимите поиск или поищите по другому номеру.
          </p>
        ) : (
          <>
            <div className="statsrun statsrun--head" aria-hidden="true">
              <span>Расчёт</span>
              <span>Прогноз выполнения</span>
              <span />
              <span>Загрузка</span>
              <span />
            </div>
            {shown.map((row) => (
              <RunRow key={row.run.id} row={row} isActive={row.run.id === active} onOpen={onOpenRun} />
            ))}
            <DbMore hidden={listed.length - shown.length} page={PAGE} onMore={paging.more} />
          </>
        )}
      </section>

      <section className="panel">
        <StatsHead
          title="Что стоит пересчитать"
          note="Расчёты с хвостом и те, что дороже всех обходятся по дороге"
        />
        <div className="statsgrid">
          <StatRank
            title="Слабее всех разложились"
            note="прогноз выполнения"
            rows={weak.map((row) => ({
              key: row.run.id,
              label: row.run.code,
              note: `${row.orders - row.assigned} без инженера · ${whenLabel(row.run.created)}`,
              value: row.coverage,
              text: percent(row.coverage),
              bad: true,
              onOpen: () => onOpenRun(row.run.id)
            }))}
            empty="Хвоста нет: все расчёты срока разложили день целиком."
          />
          <StatRank
            title="Больше всех в дороге"
            note="часы за рулём"
            rows={heavy.map((row) => ({
              key: row.run.id,
              label: row.run.code,
              note: `${plural(row.visits, 'визит', 'визита', 'визитов')} · ${hoursText(row.workMinutes)} на объектах`,
              value: row.travelMinutes,
              text: hoursText(row.travelMinutes),
              onOpen: () => onOpenRun(row.run.id)
            }))}
          />
        </div>
      </section>
    </>
  );
}

/* Строка расчёта: две полосы на общей стометровой шкале. Номер открывает
   расчёт. */
function RunRow({
  row,
  isActive,
  onOpen
}: {
  row: RunStat;
  isActive: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={'statsrun' + (isActive ? ' statsrun--active' : '')}>
      <button
        type="button"
        className="dash__section-link statsrun__code"
        onClick={() => onOpen(row.run.id)}
        title={`Открыть расчёт ${row.run.code}`}
      >
        {row.run.code}
        <span className="statsrun__mark">{isActive ? 'открыт' : whenLabel(row.run.created)}</span>
      </button>
      <span className="statsrun__track">
        <span className="statsrun__fill" style={{ width: `${Math.min(100, row.coverage * 100)}%` }} />
      </span>
      <span className="statsrun__value">{percent(row.coverage)}</span>
      <span className="statsrun__track">
        <span
          className="statsrun__fill statsrun__fill--load"
          style={{ width: `${Math.min(100, row.occupancy * 100)}%` }}
        />
      </span>
      <span className="statsrun__value">{percent(row.occupancy)}</span>
      <span className="statsrun__facts">
        разложено {row.assigned} из {row.orders} · {plural(row.visits, 'заявка', 'заявки', 'заявок')} ·{' '}
        {row.engineersOnRoute} из {row.engineersTotal} инженеров на маршрутах ·{' '}
        {hoursText(row.travelMinutes)} в дороге
        {isActive && (
          <>
            {' '}
            <Icon name="check-circle" size={11} /> открыт сейчас
          </>
        )}
      </span>
    </div>
  );
}
