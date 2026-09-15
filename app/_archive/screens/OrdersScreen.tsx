import { useMemo, useState } from 'react';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Day, Order } from '../data/contract.ts';
import type { DayView, StageKey } from '../data/derive.ts';
import {
  DAY_END,
  DAY_START,
  buildFunnel,
  deadline,
  hhmm,
  stageOfOrder
} from '../data/derive.ts';
import { workTypeIcon } from '../data/dictionary.ts';
import type { Selection } from '../app/selection.ts';

interface Props {
  day: Day;
  view: DayView;
  mode: string;
  cut: number;
  selection: Selection;
  onSelectOrder: (id: string) => void;
}

type Filter = 'all' | 'assigned' | 'unassigned' | 'problem';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'assigned', label: 'С инженером' },
  { value: 'unassigned', label: 'Без инженера' },
  { value: 'problem', label: 'Проблемные' }
];

/* Порядок колонок доски — тот же, что на этапах смены: диспетчер уже читал
   его наверху, второй раскладки для тех же состояний быть не должно. */
const BOARD_ORDER: StageKey[] = ['unassigned', 'planned', 'enroute', 'working', 'done', 'overdue'];

const RISK_LABEL = { low: 'Запас есть', medium: 'Впритык', high: 'На грани' } as const;

export function OrdersScreen({ day, view, mode, cut, selection, onSelectOrder }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [type, setType] = useState<string | null>(null);

  const fragile = useMemo(() => new Set(view.fragile.map((f) => f.order.id)), [view]);
  const selected = selection.kind === 'order' ? selection.id : null;

  const problems = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, placement] of view.stopByOrder) {
      if (placement.slaBreached || placement.stop.risk !== 'low' || fragile.has(id)) ids.add(id);
    }
    return ids;
  }, [view, fragile]);

  const rows = useMemo(() => {
    const all = [...view.orderById.values()];
    return all
      .filter((order) => {
        if (type && order.work_type !== type) return false;
        switch (filter) {
          case 'assigned':
            return view.stopByOrder.has(order.id);
          case 'unassigned':
            return !view.stopByOrder.has(order.id);
          case 'problem':
            return problems.has(order.id);
          default:
            return true;
        }
      })
      .sort((a, b) => a.window_start - b.window_start || a.id.localeCompare(b.id));
  }, [view, filter, type, problems]);

  const funnel = useMemo(
    () =>
      buildFunnel(
        day.plan.meta.orders_total,
        view.stopByOrder,
        view.unassigned,
        view.deferrable,
        [...fragile],
        cut,
        (placement) => view.orderById.get(placement.stop.order_id)?.sla_deadline ?? null
      ),
    [day, view, cut, fragile]
  );

  const engineerName = (id: string) => view.engineerById.get(id)?.name ?? id;
  const master = (order: Order) => {
    const placement = view.stopByOrder.get(order.id);
    return placement ? engineerName(placement.engineerId) : null;
  };

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Заявки смены</h2>
        </div>

        <div className="filters">
          <SegmentedControl
            size="sm"
            items={FILTERS}
            value={filter}
            onChange={(v: string) => setFilter(v as Filter)}
          />
          <div className="filters__types">
            <button
              type="button"
              className={'chip' + (type === null ? ' chip--on' : '')}
              onClick={() => setType(null)}
            >
              Все виды
            </button>
            {view.workTypes.map((t) => (
              <button
                key={t.key}
                type="button"
                className={'chip' + (type === t.key ? ' chip--on' : '')}
                onClick={() => setType(type === t.key ? null : t.key)}
              >
                <Icon name={workTypeIcon(t.key)} size={13} />
                {t.title}
                <span className="chip__count">{t.count}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {mode === 'board' && (
        <div className="oboard">
          {BOARD_ORDER.map((key) => {
            const stage = funnel.stages.find((s) => s.key === key)!;
            const ids = stage.orderIds.filter((id) => rows.some((o) => o.id === id));
            return (
              <section key={key} className="ocol">
                <header className={'ocol__head ocol__head--' + stage.tone}>
                  <span className="ocol__title">{stage.label}</span>
                  <span className="ocol__count">{ids.length}</span>
                </header>
                <div className="ocol__body">
                  {ids.length === 0 && <p className="ocol__empty">Пусто</p>}
                  {ids.map((id) => {
                    const order = view.orderById.get(id)!;
                    const placement = view.stopByOrder.get(id);
                    return (
                      <button
                        key={id}
                        type="button"
                        className={'ocard' + (selected === id ? ' ocard--selected' : '')}
                        onClick={() => onSelectOrder(id)}
                      >
                        <span className="ocard__title">{order.work_title}</span>
                        <span className="ocard__meta">
                          {order.district} · {hhmm(order.window_start)}–{hhmm(order.window_end)}
                        </span>
                        <span className="ocard__foot">
                          <span className="ocard__who">{master(order) ?? 'Инженер не назначен'}</span>
                          {placement && placement.stop.risk !== 'low' && (
                            <Badge tone="danger">{RISK_LABEL[placement.stop.risk]}</Badge>
                          )}
                          {fragile.has(id) && <Badge tone="outline">Хрупкая</Badge>}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {mode === 'table' && (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Заявка</th>
                  <th>Район</th>
                  <th>Окно</th>
                  <th>Крайний срок</th>
                  <th>Инженер</th>
                  <th>Визит</th>
                  <th>Запас</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => {
                  const placement = view.stopByOrder.get(order.id);
                  const stage = stageOfOrder(view, order.id, cut);
                  return (
                    <tr
                      key={order.id}
                      className={'tbl__row' + (selected === order.id ? ' tbl__row--selected' : '')}
                      onClick={() => onSelectOrder(order.id)}
                    >
                      <td>
                        <span className="tbl__strong">{order.work_title}</span>
                        <span className="tbl__sub">{order.id}</span>
                      </td>
                      <td>{order.district}</td>
                      <td className="tbl__num">
                        {hhmm(order.window_start)}–{hhmm(order.window_end)}
                      </td>
                      <td className="tbl__num">{deadline(order.sla_deadline)}</td>
                      <td>{master(order) ?? <span className="tbl__muted">—</span>}</td>
                      <td className="tbl__num">
                        {placement ? `${hhmm(placement.stop.start)}–${hhmm(placement.stop.finish)}` : '—'}
                      </td>
                      <td className="tbl__num">
                        {placement ? `${placement.stop.slack_minutes} мин` : '—'}
                      </td>
                      <td>
                        <span className={'pill pill--' + stage.tone}>{stage.label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {mode === 'gantt' && (
        <section className="panel">
          <div className="dash__subhead">Окно абонента и визит инженера</div>
          <div className="gantt">
            <div className="gantt__scale" aria-hidden="true">
              {[8, 10, 12, 14, 16, 18, 20].map((h) => (
                <span
                  key={h}
                  className="gantt__tick"
                  style={{ left: `${((h * 60 - DAY_START) / (DAY_END - DAY_START)) * 100}%` }}
                >
                  {hhmm(h * 60)}
                </span>
              ))}
            </div>

            {rows.map((order) => {
              const placement = view.stopByOrder.get(order.id);
              const pct = (m: number) => ((m - DAY_START) / (DAY_END - DAY_START)) * 100;
              return (
                <button
                  key={order.id}
                  type="button"
                  className={'gantt__row' + (selected === order.id ? ' gantt__row--selected' : '')}
                  onClick={() => onSelectOrder(order.id)}
                >
                  <span className="gantt__label">
                    <span className="gantt__title">{order.work_title}</span>
                    <span className="gantt__sub">{order.district}</span>
                  </span>
                  <span className="gantt__track">
                    <span
                      className="gantt__window"
                      style={{
                        left: `${pct(order.window_start)}%`,
                        width: `${pct(order.window_end) - pct(order.window_start)}%`
                      }}
                      title={`окно ${hhmm(order.window_start)}–${hhmm(order.window_end)}`}
                    />
                    {placement && (
                      <span
                        className={
                          'gantt__visit' + (placement.slaBreached ? ' gantt__visit--breach' : '')
                        }
                        style={{
                          left: `${pct(placement.stop.start)}%`,
                          width: `${Math.max(pct(placement.stop.finish) - pct(placement.stop.start), 0.6)}%`
                        }}
                        title={`визит ${hhmm(placement.stop.start)}–${hhmm(placement.stop.finish)}`}
                      />
                    )}
                    <span className="gantt__sla" style={{ left: `${pct(order.sla_deadline)}%` }} />
                    <span className="gantt__now" style={{ left: `${pct(cut)}%` }} />
                  </span>
                </button>
              );
            })}
          </div>

          <ul className="tl__legend">
            <li>
              <span className="tl__dot" style={{ background: 'var(--ink-200)' }} />
              окно абонента
            </li>
            <li>
              <span className="tl__dot" style={{ background: 'var(--accent-500)' }} />
              визит
            </li>
            <li>
              <span className="tl__dot" style={{ background: 'var(--danger-500)' }} />
              крайний срок
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
