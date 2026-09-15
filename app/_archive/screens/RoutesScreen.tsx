import { useMemo, useState } from 'react';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import type { DayView, Segment } from '../data/derive.ts';
import {
  DAY_END,
  DAY_START,
  engineerTimeline,
  hhmm,
  visits as pluralVisits
} from '../data/derive.ts';
import type { Selection } from '../app/selection.ts';

interface Props {
  view: DayView;
  mode: string;
  cut: number;
  selection: Selection;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

type Sort = 'start' | 'visits' | 'name';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'start', label: 'По времени выезда' },
  { value: 'visits', label: 'По числу визитов' },
  { value: 'name', label: 'По алфавиту' }
];

const KIND_LABEL: Record<Segment['kind'], string> = {
  travel: 'Дорога',
  wait: 'Ждёт открытия окна',
  work: 'Работа',
  idle: 'Простой',
  lunch: 'Окно под обед'
};

const RISK_LABEL = { low: 'Запас есть', medium: 'Впритык', high: 'На грани' } as const;

export function RoutesScreen({ view, mode, cut, selection, onSelectOrder, onSelectEngineer }: Props) {
  const [sort, setSort] = useState<Sort>('start');
  const selectedOrder = selection.kind === 'order' ? selection.id : null;
  const selectedEngineer = selection.kind === 'engineer' ? selection.id : null;

  const routes = useMemo(() => {
    const list = view.loads.filter((load) => load.route && load.route.stops.length > 0);
    return [...list].sort((a, b) => {
      if (sort === 'visits') return b.visits - a.visits;
      if (sort === 'name') return a.engineer.name.localeCompare(b.engineer.name);
      return (a.route!.totals.start ?? 0) - (b.route!.totals.start ?? 0);
    });
  }, [view, sort]);

  const totals = useMemo(() => {
    const acc = { visits: 0, travel: 0, work: 0, idle: 0, overtime: 0 };
    for (const { route } of routes) {
      if (!route) continue;
      acc.visits += route.totals.visits;
      acc.travel += route.totals.travel_minutes;
      acc.work += route.totals.work_minutes;
      acc.idle += route.totals.idle_minutes;
      acc.overtime += route.totals.overtime_minutes;
    }
    return acc;
  }, [routes]);

  const pct = (m: number) => ((m - DAY_START) / (DAY_END - DAY_START)) * 100;

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Маршруты дня</h2>
        </div>

        <div className="filters">
          <SegmentedControl
            size="sm"
            items={SORTS}
            value={sort}
            onChange={(v: string) => setSort(v as Sort)}
          />
          <div className="filters__types">
            <span className="chip chip--static">Работа {totals.work} мин</span>
            <span className="chip chip--static">Дорога {totals.travel} мин</span>
            <span className="chip chip--static">Простой {totals.idle} мин</span>
            <span className="chip chip--static">Переработка {totals.overtime} мин</span>
          </div>
        </div>
      </section>

      {mode === 'list' && (
        <div className="rlist">
          {routes.map(({ engineer, route, visits, occupancy }) => (
            <section
              key={engineer.id}
              className={'rcard' + (selectedEngineer === engineer.id ? ' rcard--selected' : '')}
            >
              <button type="button" className="rcard__head" onClick={() => onSelectEngineer(engineer.id)}>
                <span className="rcard__who">
                  <span className="rcard__name">{engineer.name}</span>
                  <span className="rcard__meta">
                    {hhmm(route!.totals.start)}–{hhmm(route!.totals.end)} · {pluralVisits(visits)} ·
                    загрузка {Math.round(occupancy * 100)}%
                  </span>
                </span>
                <span className="rcard__nums">
                  <span className="rcard__num">
                    <b>{route!.totals.work_minutes}</b> работа, мин
                  </span>
                  <span className="rcard__num">
                    <b>{route!.totals.travel_minutes}</b> дорога, мин
                  </span>
                  <span className="rcard__num">
                    <b>{route!.totals.idle_minutes}</b> простой, мин
                  </span>
                </span>
              </button>

              <ol className="rstops">
                {route!.stops.map((stop, index) => {
                  const order = view.orderById.get(stop.order_id);
                  const placement = view.stopByOrder.get(stop.order_id);
                  const passed = cut >= stop.finish;
                  return (
                    <li key={stop.seq}>
                      <button
                        type="button"
                        className={
                          'rstop' +
                          (selectedOrder === stop.order_id ? ' rstop--selected' : '') +
                          (passed ? ' rstop--passed' : '')
                        }
                        onClick={() => onSelectOrder(stop.order_id)}
                      >
                        <span className="rstop__seq">{index + 1}</span>
                        <span className="rstop__main">
                          <span className="rstop__title">
                            {order ? `${order.work_title} · ${order.district}` : stop.order_id}
                          </span>
                          <span className="rstop__meta">
                            {hhmm(stop.start)}–{hhmm(stop.finish)} · дорога {stop.travel_minutes} мин
                            {stop.wait_minutes > 0 && ` · ждёт ${stop.wait_minutes} мин`}
                          </span>
                        </span>
                        <span className="rstop__side">
                          {placement?.slaBreached && <Badge tone="danger">Срок</Badge>}
                          {stop.risk !== 'low' && <Badge tone="danger">{RISK_LABEL[stop.risk]}</Badge>}
                          <span className="rstop__slack">{stop.slack_minutes} мин</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      {mode === 'gantt' && (
        <section className="panel">
          <div className="dash__subhead">День инженеров на общей шкале</div>
          <div className="gantt">
            <div className="gantt__scale" aria-hidden="true">
              {[8, 10, 12, 14, 16, 18, 20].map((h) => (
                <span key={h} className="gantt__tick" style={{ left: `${pct(h * 60)}%` }}>
                  {hhmm(h * 60)}
                </span>
              ))}
            </div>

            {routes.map(({ engineer, route, visits }) => {
              const segments = engineerTimeline(route, engineer, view.stopByOrder);
              return (
                <button
                  key={engineer.id}
                  type="button"
                  className={
                    'gantt__row' + (selectedEngineer === engineer.id ? ' gantt__row--selected' : '')
                  }
                  onClick={() => onSelectEngineer(engineer.id)}
                >
                  <span className="gantt__label">
                    <span className="gantt__title">{engineer.name}</span>
                    <span className="gantt__sub">{pluralVisits(visits)}</span>
                  </span>
                  <span className="gantt__track gantt__track--tall">
                    {segments.map((segment, i) => {
                      const width = pct(segment.to) - pct(segment.from);
                      if (width <= 0) return null;
                      return (
                        <span
                          key={i}
                          className={'tl__seg tl__seg--' + segment.kind}
                          style={{ left: `${pct(segment.from)}%`, width: `${width}%` }}
                          title={`${hhmm(segment.from)}–${hhmm(segment.to)} · ${KIND_LABEL[segment.kind]}`}
                        />
                      );
                    })}
                    <span className="gantt__now" style={{ left: `${pct(cut)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>

          <ul className="tl__legend">
            <li>
              <span className="tl__dot tl__dot--work" />
              работа
            </li>
            <li>
              <span className="tl__dot tl__dot--travel" />
              дорога
            </li>
            <li>
              <span className="tl__dot tl__dot--wait" />
              ждёт окна
            </li>
            <li>
              <span className="tl__dot tl__dot--lunch" />
              обед
            </li>
          </ul>

          <p className="tl__note">
            Пустое место в строке — простой: заявок на это время инженеру не досталось. Всего по
            смене {totals.idle} минут простоя, окно под обед показано отдельным сегментом.
          </p>
        </section>
      )}
    </div>
  );
}
