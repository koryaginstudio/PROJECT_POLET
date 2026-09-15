import { useMemo, useState } from 'react';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { deadline, hhmm, stageOfOrder } from '../data/derive.ts';
import { priorityName, workTypeIcon } from '../data/dictionary.ts';
import type { Selection } from '../app/selection.ts';

interface Props {
  view: DayView;
  mode: string;
  cut: number;
  selection: Selection;
  onSelectOrder: (id: string) => void;
}

type Sort = 'count' | 'unassigned' | 'name';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'count', label: 'По числу заявок' },
  { value: 'unassigned', label: 'По непокрытым' },
  { value: 'name', label: 'По алфавиту' }
];

/* Справочника клиентов в контракте нет: заказчик описан точкой обслуживания —
   район, координаты, окно приёма и нужен ли доступ в подъезд. Раздел собран
   из этого и ничего к нему не придумывает. */
export function ClientsScreen({ view, mode, cut, selection, onSelectOrder }: Props) {
  const [sort, setSort] = useState<Sort>('count');
  const [district, setDistrict] = useState<string | null>(null);
  const selected = selection.kind === 'order' ? selection.id : null;

  const districts = useMemo(() => {
    const map = new Map<
      string,
      { key: string; orders: string[]; unassigned: number; access: number; firstWindow: number }
    >();
    for (const order of view.orderById.values()) {
      const entry = map.get(order.district) ?? {
        key: order.district,
        orders: [],
        unassigned: 0,
        access: 0,
        firstWindow: Infinity
      };
      entry.orders.push(order.id);
      if (!view.stopByOrder.has(order.id)) entry.unassigned += 1;
      if (order.needs_access) entry.access += 1;
      entry.firstWindow = Math.min(entry.firstWindow, order.window_start);
      map.set(order.district, entry);
    }
    const list = [...map.values()];
    return list.sort((a, b) => {
      if (sort === 'unassigned') return b.unassigned - a.unassigned || b.orders.length - a.orders.length;
      if (sort === 'name') return a.key.localeCompare(b.key);
      return b.orders.length - a.orders.length || a.key.localeCompare(b.key);
    });
  }, [view, sort]);

  const rows = useMemo(
    () =>
      [...view.orderById.values()]
        .filter((order) => !district || order.district === district)
        .sort(
          (a, b) =>
            a.district.localeCompare(b.district) || a.window_start - b.window_start
        ),
    [view, district]
  );

  const totals = useMemo(() => {
    const all = [...view.orderById.values()];
    return {
      access: all.filter((o) => o.needs_access).length,
      urgent: all.filter((o) => o.priority >= 2).length
    };
  }, [view]);

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Клиенты и адреса</h2>
        </div>

        <p className="clients__lede">
          Справочника клиентов в контракте нет: заказчик описан точкой обслуживания — район,
          координаты, окно приёма и нужен ли доступ в подъезд. Раздел собран из этого.
          {' '}Доступ нужен {totals.access} заявкам из {view.orderById.size}, высокий приоритет — у {totals.urgent}.
        </p>

        <div className="filters">
          <SegmentedControl
            size="sm"
            items={SORTS}
            value={sort}
            onChange={(v: string) => setSort(v as Sort)}
          />
          {district && (
            <button type="button" className="chip chip--on" onClick={() => setDistrict(null)}>
              {district}
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      </section>

      {mode === 'board' && (
        <div className="cboard">
          {districts.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={'ccard' + (district === entry.key ? ' ccard--selected' : '')}
              onClick={() => setDistrict(district === entry.key ? null : entry.key)}
            >
              <span className="ccard__top">
                <span className="ccard__name">{entry.key}</span>
                <span className="ccard__count">{entry.orders.length}</span>
              </span>
              <span className="ccard__rows">
                <span className="ccard__row">
                  <span>Без инженера</span>
                  <b className={entry.unassigned > 0 ? 'ccard__bad' : undefined}>{entry.unassigned}</b>
                </span>
                <span className="ccard__row">
                  <span>Нужен доступ</span>
                  <b>{entry.access}</b>
                </span>
                <span className="ccard__row">
                  <span>Первое окно</span>
                  <b>{hhmm(entry.firstWindow)}</b>
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {mode === 'table' && (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Адрес</th>
                  <th>Что делаем</th>
                  <th>Окно приёма</th>
                  <th>Крайний срок</th>
                  <th>Доступ</th>
                  <th>Приоритет</th>
                  <th>Инженер</th>
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
                        <span className="tbl__strong">{order.district}</span>
                        <span className="tbl__sub">
                          {order.lat.toFixed(4)}, {order.lon.toFixed(4)}
                        </span>
                      </td>
                      <td>
                        <span className="tbl__inline">
                          <Icon name={workTypeIcon(order.work_type)} size={13} />
                          {order.work_title}
                        </span>
                        <span className="tbl__sub">
                          {order.id} · {order.est_minutes} мин
                        </span>
                      </td>
                      <td className="tbl__num">
                        {hhmm(order.window_start)}–{hhmm(order.window_end)}
                      </td>
                      <td className="tbl__num">{deadline(order.sla_deadline)}</td>
                      <td>
                        {order.needs_access ? (
                          <span className="pill pill--accent">Нужен</span>
                        ) : (
                          <span className="tbl__muted">Не нужен</span>
                        )}
                      </td>
                      <td>{priorityName(order.priority)}</td>
                      <td>
                        {placement ? (
                          view.engineerById.get(placement.engineerId)?.name ?? placement.engineerId
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
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
    </div>
  );
}
