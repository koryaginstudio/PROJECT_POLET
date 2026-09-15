import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { Registry, RouteRecord } from '../../data/registry.ts';
import { hhmm, hoursText, visits as pluralVisits } from '../../data/derive.ts';
import { DbHead } from './DbHead.tsx';

interface Props {
  registry: Registry;
  mode: string;
}

type Sort = 'code' | 'run' | 'visits' | 'occupancy' | 'travel';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'code', label: 'По номеру' },
  { value: 'run', label: 'По расчёту' },
  { value: 'visits', label: 'По визитам' },
  { value: 'occupancy', label: 'По занятости' },
  { value: 'travel', label: 'По дороге' }
];


/* База маршрутов: каждый маршрут каждого прогона отдельной строкой. Раздел
   отвечает на вопрос «как мы вообще ездим», поэтому строка всегда подписана
   номером расчёта — без него маршруты разных прогонов слиплись бы в один. */
export function DbRoutesScreen({ registry, mode }: Props) {
  const [sort, setSort] = useState<Sort>('code');
  const [run, setRun] = useState<string | null>(null);

  const rows = useMemo(() => {
    const list = registry.routes.filter((route) => !run || route.run.id === run);
    return [...list].sort((a, b) => {
      if (sort === 'visits') return b.visits - a.visits;
      if (sort === 'occupancy') return b.occupancy - a.occupancy;
      if (sort === 'travel') return b.travelMinutes - a.travelMinutes;
      if (sort === 'run')
        return a.run.code.localeCompare(b.run.code) || a.number - b.number;
      return a.number - b.number;
    });
  }, [registry, sort, run]);

  const totals = useMemo(() => {
    const all = registry.routes;
    const occupancy = all.reduce((sum, r) => sum + r.occupancy, 0) / (all.length || 1);
    return {
      routes: all.length,
      visits: all.reduce((sum, r) => sum + r.visits, 0),
      travel: all.reduce((sum, r) => sum + r.travelMinutes, 0),
      overtime: all.reduce((sum, r) => sum + r.overtimeMinutes, 0),
      occupancy
    };
  }, [registry]);

  /* Разбивка по расчётам нужна и вкладке «По расчётам», и фильтру над таблицей:
     считаем один раз. */
  const byRun = useMemo(
    () =>
      registry.runs.map((ref) => {
        const list = registry.routes.filter((route) => route.run.id === ref.id);
        return {
          ref,
          routes: list,
          visits: list.reduce((sum, r) => sum + r.visits, 0),
          travel: list.reduce((sum, r) => sum + r.travelMinutes, 0),
          risky: list.reduce((sum, r) => sum + r.risky, 0),
          occupancy: list.reduce((sum, r) => sum + r.occupancy, 0) / (list.length || 1)
        };
      }),
    [registry]
  );

  /* В разбивке по расчётам номер расчёта уже стоит в заголовке секции, и
     колонка с ним повторяла бы его в каждой строке. Собственный номер
     маршрута остаётся везде: он и есть то, чем маршрут называют. */
  const table = (list: RouteRecord[], withRun = true) => (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Маршрут</th>
            {withRun && <th>Расчёт</th>}
            <th>Инженер</th>
            <th>Визитов</th>
            <th>Окно маршрута</th>
            <th>В дороге</th>
            <th>В работе</th>
            <th>Простой</th>
            <th>Занятость</th>
            <th>Переработка</th>
            <th>Риск</th>
            <th>Районы</th>
          </tr>
        </thead>
        <tbody>
          {list.map((route) => (
            <tr key={route.key} className="tbl__row">
              <td>
                <span className="tbl__strong">{route.code}</span>
              </td>
              {withRun && (
                <td>
                  <span className="tbl__strong">{route.run.code}</span>
                  <span className="tbl__sub">{route.run.date}</span>
                </td>
              )}
              <td>
                <span className="tbl__strong">{route.engineerName}</span>
                <span className="tbl__sub">{route.engineerId}</span>
              </td>
              <td className="tbl__num">{route.visits}</td>
              <td className="tbl__num">
                {hhmm(route.start)}–{hhmm(route.end)}
              </td>
              <td className="tbl__num">{hoursText(route.travelMinutes)}</td>
              <td className="tbl__num">{hoursText(route.workMinutes)}</td>
              <td className="tbl__num">{hoursText(route.idleMinutes)}</td>
              <td>
                <span className={'pill pill--' + (route.occupancy < 0.6 ? 'idle' : 'success')}>
                  {Math.round(route.occupancy * 100)}%
                </span>
              </td>
              <td className={route.overtimeMinutes > 0 ? 'tbl__num tbl__warn' : 'tbl__num'}>
                {route.overtimeMinutes > 0 ? `${route.overtimeMinutes} мин` : '—'}
              </td>
              <td className="tbl__num">
                {route.risky > 0 ? (
                  <span className="pill pill--danger">{route.risky}</span>
                ) : (
                  <span className="tbl__muted">—</span>
                )}
              </td>
              <td>
                <span className="tbl__sub">{route.districts.join(', ')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="dash enter">
      <DbHead
        title="База маршрутов"
        lede={
          <>
            Все маршруты, которые движок построил за всё время: строка — это один инженер в одном
            расчёте. Раздел не привязан к открытому прогону и нужен, чтобы сравнивать, как мы ездим
            от расчёта к расчёту.
          </>
        }
        stats={[
          { label: 'Маршрутов', value: totals.routes },
          { label: 'Визитов', value: totals.visits },
          { label: 'В дороге', value: hoursText(totals.travel) },
          { label: 'Средняя занятость', value: `${Math.round(totals.occupancy * 100)}%` },
          { label: 'Переработка', value: `${totals.overtime} мин` }
        ]}
      />

      {mode === 'runs' ? (
        <>
          {byRun.map((entry) => (
            <section key={entry.ref.id} className="panel">
              <div className="dash__section-head">
                <h2 className="dash__section-title">
                  Расчёт {entry.ref.code}
                  <span className="dbrun__date">{entry.ref.date}</span>
                </h2>
                <span className="dbrun__facts">
                  {entry.routes.length} маршрутов · {pluralVisits(entry.visits)} ·{' '}
                  {hoursText(entry.travel)} в дороге · занятость{' '}
                  {Math.round(entry.occupancy * 100)}%
                  {entry.risky > 0 ? ` · ${entry.risky} рискованных остановок` : ''}
                </span>
              </div>
              {table(entry.routes, false)}
            </section>
          ))}
        </>
      ) : (
        <>
          <section className="panel">
            <div className="filters">
              <SegmentedControl
                size="sm"
                items={SORTS}
                value={sort}
                onChange={(v: string) => setSort(v as Sort)}
              />
              <span className="filters__types">
                {registry.runs.map((ref) => (
                  <button
                    key={ref.id}
                    type="button"
                    className={'chip' + (run === ref.id ? ' chip--on' : '')}
                    onClick={() => setRun(run === ref.id ? null : ref.id)}
                  >
                    {ref.code}
                    {run === ref.id && <Icon name="x" size={12} />}
                  </button>
                ))}
              </span>
              <span className="filters__note">{rows.length} маршрутов в выборке</span>
            </div>
          </section>

          <section className="panel">{table(rows)}</section>
        </>
      )}
    </div>
  );
}
