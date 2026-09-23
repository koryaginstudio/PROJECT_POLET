import { useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Registry, RunStat } from '../data/registry.ts';
import type { Distribution, StatusSplit } from '../data/derive.ts';
import { dec, hoursText, occupancyMean, plural } from '../data/derive.ts';
import { skillName } from '../data/dictionary.ts';
import { whenLabel } from '../data/load.ts';
import { BarChart } from '../app/BarChart.tsx';
import { SortMenu } from '../app/SortMenu.tsx';
import type { SortRule } from '../app/SortMenu.tsx';
import { DbMore, usePaging } from './db/DbBar.tsx';
import { Donut } from '../app/Donut.tsx';

interface Props {
  registry: Registry;
  /** Открытый расчёт — он подсвечен в ряду: это точка отсчёта. */
  active: string | null;
  onOpenRun: (id: string) => void;
}

/* Статистика по всем расчётам сразу.

   Диспетчерская отвечает за один открытый расчёт, база расчётов — за список
   карточек. Здесь третий взгляд: все расчёты в одном ряду, чтобы увидеть,
   куда идут покрытие и загрузка от расчёта к расчёту, и какие работы
   вообще составляют день. Ничего своего не считается: числа берутся из тех
   же справочников, что и в базах, — покрытие и загрузка здесь те же, что в
   карточке расчёта.

   Сверху — итоги по всем расчётам, ниже — ряд расчётов по двум главным
   показателям и разрезы по видам работ и навыкам. */

const percent = (share: number) => `${dec(share * 100)} %`;

/* Сколько расчётов показываем сразу. Столько же, сколько в базе расчётов:
   один и тот же список не должен обрываться в двух местах по-разному. */
const PAGE = 24;

/* По чему упорядочен ряд. Те же правила и те же слова, что в базе расчётов:
   один и тот же список, упорядоченный в двух местах по-разному, читался бы
   как два разных. */
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

/* Итоги по видам работ и навыкам приходят готовыми счётчиками, а полосы
   рисуются из распределения. Собираем распределение из счётчиков: каждая
   категория — сама по себе, совмещений здесь нет, и полоса целиком
   сплошная. */
function tallyToDistribution(
  rows: { key: string; count: number }[],
  labelOf: (key: string) => string
): Distribution {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const ordered = [...rows].sort((a, b) => b.count - a.count);
  return {
    total,
    slices: ordered.map((row) => ({
      key: row.key,
      label: labelOf(row.key),
      count: row.count,
      ids: [],
      categoryKeys: [row.key]
    })),
    categories: ordered.map((row) => ({ key: row.key, label: labelOf(row.key), count: row.count, ids: [] })),
    overlapping: 0,
    categorySum: total
  };
}

export function StatsScreen({ registry, active, onOpenRun }: Props) {
  const { stats } = registry;
  const runs = stats.byRun;

  /* Покрытие и загрузку усредняем по расчётам, а не от суммы заявок:
     сравниваем расчёты между собой, и каждый весит одинаково. */
  const totals = useMemo(() => {
    const count = runs.length || 1;
    const coverage = runs.reduce((sum, row) => sum + row.coverage, 0) / count;
    /* Загрузка — общей функцией слоя данных: одна арифметика на все экраны. */
    const occupancy = occupancyMean(runs);
    const visits = runs.reduce((sum, row) => sum + row.visits, 0);
    const work = runs.reduce((sum, row) => sum + row.workMinutes, 0);
    const travel = runs.reduce((sum, row) => sum + row.travelMinutes, 0);
    const loose = runs.reduce((sum, row) => sum + (row.orders - row.assigned), 0);
    return { coverage, occupancy, visits, work, travel, loose };
  }, [runs]);

  const best = useMemo(
    () => (runs.length > 1 ? [...runs].sort((a, b) => b.coverage - a.coverage)[0] : null),
    [runs]
  );
  const worst = useMemo(
    () => (runs.length > 1 ? [...runs].sort((a, b) => a.coverage - b.coverage)[0] : null),
    [runs]
  );

  /* Ряд расчётов. По умолчанию свежие сверху: к последнему расчёту
     возвращаются чаще, чем к первому в архиве, — а ход от старого к свежему
     показывают линии на плитках, а не этот список. */
  const ordered = useMemo(
    () => [...runs].sort((a, b) => a.run.created.localeCompare(b.run.created)),
    [runs]
  );

  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('date');
  const [desc, setDesc] = useState(true);
  const paging = usePaging(PAGE);

  /* Повторный щелчок по выбранному правилу переворачивает порядок; щелчок по
     другому — переключает правило и берёт его сторону по умолчанию. То же
     самое и теми же словами, что и в базах. */
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
    const picked = ordered.filter(
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
          return ordered.indexOf(row);
      }
    };
    const side = desc ? -1 : 1;
    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : a.run.code.localeCompare(b.run.code));
    });
  }, [ordered, query, sort, desc]);

  const shown = listed.slice(0, paging.limit);

  const byWorkType = useMemo(
    () => tallyToDistribution(stats.byWorkType, (key) => registry.workTypeTitle[key] ?? key),
    [stats.byWorkType, registry.workTypeTitle]
  );
  const bySkill = useMemo(() => tallyToDistribution(stats.bySkill, skillName), [stats.bySkill]);

  /* Кольцо про заявки по всем расчётам: сколько разложено, сколько остались
     без инженера. Один вопрос, два ответа — и они складываются в целое. */
  const split: StatusSplit[] = useMemo(
    () => [
      { key: 'assigned', label: 'Разложены по инженерам', count: stats.assigned, ids: [], tone: 'ok' },
      { key: 'loose', label: 'Без инженера', count: Math.max(0, stats.orders - stats.assigned), ids: [], tone: 'bad' }
    ],
    [stats.assigned, stats.orders]
  );

  if (runs.length === 0) {
    return (
      <div className="dash enter">
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Статистика</h2>
          </div>
          <div className="emptynote">
            <p className="emptynote__title">Считать пока нечего</p>
            <span>Статистика собирается по посчитанным расчётам — заведите первый в диспетчерской.</span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Статистика</h2>
          <span className="dash__section-note">
            {plural(runs.length, 'расчёт', 'расчёта', 'расчётов')} в истории
            {best && worst && best.run.id !== worst.run.id && (
              <>
                {' · '}
                лучший прогноз {best.run.code} — {percent(best.coverage)}, слабейший{' '}
                {worst.run.code} — {percent(worst.coverage)}
              </>
            )}
          </span>
        </div>

        <div className="dbstats">
          <div className="dbstat">
            <span className="dbstat__value">{runs.length}</span>
            <span className="dbstat__label">Расчётов</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{percent(totals.coverage)}</span>
            <span className="dbstat__label">Средний прогноз выполнения</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{percent(totals.occupancy)}</span>
            <span className="dbstat__label">Средняя загрузка</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{totals.visits}</span>
            <span className="dbstat__label">Заявок запланировано</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{hoursText(totals.work)}</span>
            <span className="dbstat__label">Работы на объектах</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{hoursText(totals.travel)}</span>
            <span className="dbstat__label">В дороге</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Расчёты рядом</h2>
          <span className="dash__section-note">
            {listed.length === ordered.length
              ? `${plural(ordered.length, 'расчёт', 'расчёта', 'расчётов')}, свежие сверху`
              : `${listed.length} из ${ordered.length} по отбору`}
          </span>
        </div>

        {/* Поиск и порядок — над рядом. Расчётов в истории со временем станут
            сотни, и «все подряд одним столбцом» перестаёт быть списком: нужный
            находят по номеру или по дате, а не прокруткой до нужного места. */}
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
              <RunRow
                key={row.run.id}
                row={row}
                isActive={row.run.id === active}
                onOpen={onOpenRun}
              />
            ))}
            <DbMore hidden={listed.length - shown.length} page={PAGE} onMore={paging.more} />
          </>
        )}
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Из чего складывается день</h2>
        </div>
        <div className="statsgrid">
          <Donut
            title="Заявки по всем расчётам"
            slices={split}
            centerValue={stats.orders}
            centerCaption="заявок"
          />
          <BarChart
            title="Заявки по видам работ"
            distribution={byWorkType}
            unit={(n) => plural(n, 'заявка', 'заявки', 'заявок')}
          />
          <BarChart
            title="Инженеры по навыкам"
            distribution={bySkill}
            unit={(n) => plural(n, 'инженер', 'инженера', 'инженеров')}
          />
        </div>
      </section>
    </div>
  );
}

/* Строка расчёта: две полосы на общей стометровой шкале, чтобы 74 % и 86 %
   читались как разные длины, а не как два числа. Номер открывает расчёт. */
function RunRow({ row, isActive, onOpen }: { row: RunStat; isActive: boolean; onOpen: (id: string) => void }) {
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
        {row.engineersOnRoute} из {row.engineersTotal} инженеров на маршрутах · {hoursText(row.travelMinutes)} в
        дороге
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
