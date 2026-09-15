import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry } from '../../data/registry.ts';
import { deadline, hhmm, plural } from '../../data/derive.ts';
import { priorityName, workTypeIcon } from '../../data/dictionary.ts';
import { DbHead } from './DbHead.tsx';

interface Props {
  registry: Registry;
  mode: string;
}

type Sort = 'run' | 'district' | 'window' | 'duration';

/* Сколько строк отдаём в разметку за раз. В архиве из двух десятков расчётов
   заявок под две тысячи: браузер такую таблицу рисует целиком и потом на ней
   же спотыкается при прокрутке. Показываем порцию, остальное — по кнопке. */
const PAGE = 200;

const SORTS: { value: Sort; label: string }[] = [
  { value: 'run', label: 'По расчёту' },
  { value: 'district', label: 'По району' },
  { value: 'window', label: 'По окну приёма' },
  { value: 'duration', label: 'По длительности' }
];

/* База заявок. Собрана по всем прогонам сразу: строка — это заявка в одном
   расчёте. Номера в прогонах повторяются, но стоят за ними разные точки, окна
   и инженеры, поэтому строка всегда подписана номером расчёта — без него
   заявки разных прогонов слиплись бы в одну. */
export function DbOrdersScreen({ registry, mode }: Props) {
  const [sort, setSort] = useState<Sort>('run');
  const [run, setRun] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const types = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of registry.orders) {
      map.set(order.workType, (map.get(order.workType) ?? 0) + 1);
    }
    return [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }, [registry]);

  /* Сменили фильтр — счётчик показанного начинается заново: иначе после
     сужения выборки кнопка обещала бы строки, которых уже нет. */
  useEffect(() => setLimit(PAGE), [run, type, query, sort]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = registry.orders.filter(
      (order) =>
        (!run || order.run.id === run) &&
        (!type || order.workType === type) &&
        (!needle ||
          order.id.toLowerCase().includes(needle) ||
          order.address.toLowerCase().includes(needle) ||
          order.district.toLowerCase().includes(needle))
    );
    return [...list].sort((a, b) => {
      if (sort === 'district') {
        return (
          a.district.localeCompare(b.district, 'ru') ||
          a.address.localeCompare(b.address, 'ru') ||
          a.id.localeCompare(b.id)
        );
      }
      if (sort === 'window') return a.windowStart - b.windowStart || a.id.localeCompare(b.id);
      if (sort === 'duration') return b.estMinutes - a.estMinutes;
      return a.run.code.localeCompare(b.run.code) || a.id.localeCompare(b.id);
    });
  }, [registry, sort, run, type, query]);

  const totals = useMemo(() => {
    const all = registry.orders;
    const assigned = all.filter((order) => order.engineerId).length;
    const minutes = all.reduce((sum, order) => sum + order.estMinutes, 0);
    return {
      total: all.length,
      assigned,
      unassigned: all.length - assigned,
      access: all.filter((order) => order.needsAccess).length,
      urgent: all.filter((order) => order.priority >= 2).length,
      avg: all.length ? Math.round(minutes / all.length) : 0
    };
  }, [registry]);

  /* Разбивка по видам работ считается по той же выборке, что и таблица: иначе
     фильтр менял бы список, но не картину над ним. */
  const breakdown = useMemo(() => {
    const map = new Map<string, { key: string; total: number; assigned: number; minutes: number }>();
    for (const order of rows) {
      const entry = map.get(order.workType) ?? {
        key: order.workType,
        total: 0,
        assigned: 0,
        minutes: 0
      };
      entry.total += 1;
      if (order.engineerId) entry.assigned += 1;
      entry.minutes += order.estMinutes;
      map.set(order.workType, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [rows]);

  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;

  const status = (order: OrderRecord) =>
    order.engineerId ? (
      <span className="pill pill--success">В маршруте</span>
    ) : (
      <span className="pill pill--danger">Без инженера</span>
    );

  return (
    <div className="dash enter">
      <DbHead
        title="База заявок"
        lede={
          <>
            Все заявки, которые проходили через движок: строка — это заявка в одном расчёте. Номера
            в прогонах повторяются, но стоят за ними разные точки, окна и инженеры, поэтому расчёт
            указан у каждой строки. Раздел не привязан к открытому прогону.
          </>
        }
        stats={[
          { label: 'Записей', value: totals.total },
          { label: 'В маршруте', value: totals.assigned },
          { label: 'Без инженера', value: totals.unassigned },
          { label: 'Нужен доступ', value: totals.access },
          { label: 'Средняя работа', value: `${totals.avg} мин` }
        ]}
      />

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
          <span className="filters__types">
            {types.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className={'chip' + (type === entry.key ? ' chip--on' : '')}
                onClick={() => setType(type === entry.key ? null : entry.key)}
              >
                <Icon name={workTypeIcon(entry.key)} size={12} />
                {registry.workTypeTitle[entry.key] ?? entry.key}
                <span className="chip__count">{entry.count}</span>
              </button>
            ))}
          </span>
          <label className="dbsearch">
            <Icon name="search" size={14} />
            <input
              className="dbsearch__input"
              value={query}
              placeholder="Номер, адрес или район"
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {query && (
              <button type="button" className="dbsearch__clear" onClick={() => setQuery('')}>
                <Icon name="x" size={12} />
              </button>
            )}
          </label>
          <span className="filters__note">
            {plural(rows.length, 'заявка', 'заявки', 'заявок')} в выборке
          </span>
        </div>
      </section>

      {mode === 'types' ? (
        <div className="cboard">
          {breakdown.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={'ccard' + (type === entry.key ? ' ccard--selected' : '')}
              onClick={() => setType(type === entry.key ? null : entry.key)}
            >
              <span className="ccard__top">
                <span className="ccard__name">
                  <Icon name={workTypeIcon(entry.key)} size={13} />{' '}
                  {registry.workTypeTitle[entry.key] ?? entry.key}
                </span>
                <span className="ccard__count">{entry.total}</span>
              </span>
              <span className="ccard__rows">
                <span className="ccard__row">
                  <span>В маршруте</span>
                  <b>{entry.assigned}</b>
                </span>
                <span className="ccard__row">
                  <span>Без инженера</span>
                  <b className={entry.total - entry.assigned > 0 ? 'ccard__bad' : undefined}>
                    {entry.total - entry.assigned}
                  </b>
                </span>
                <span className="ccard__row">
                  <span>Средняя работа</span>
                  <b>{Math.round(entry.minutes / entry.total)} мин</b>
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Расчёт</th>
                  <th>Заявка</th>
                  <th>Что делаем</th>
                  <th>Адрес</th>
                  <th>Окно приёма</th>
                  <th>Крайний срок</th>
                  <th>Работа</th>
                  <th>Доступ</th>
                  <th>Приоритет</th>
                  <th>Инженер</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((order) => (
                  <tr key={order.key} className="tbl__row">
                    <td>
                      <span className="tbl__strong">{order.run.code}</span>
                      <span className="tbl__sub">{order.run.date}</span>
                    </td>
                    <td>
                      <span className="tbl__strong">{order.id}</span>
                      {order.seq !== null && (
                        <span className="tbl__sub">Визит № {order.seq}</span>
                      )}
                    </td>
                    <td>
                      <span className="tbl__inline">
                        <Icon name={workTypeIcon(order.workType)} size={13} />
                        {order.workTitle}
                      </span>
                      <span className="tbl__sub">{order.workType}</span>
                    </td>
                    <td>
                      <span className="tbl__strong">{order.address}</span>
                      <span className="tbl__sub">{order.district}</span>
                    </td>
                    <td className="tbl__num">
                      {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                    </td>
                    <td className="tbl__num">{deadline(order.slaDeadline)}</td>
                    <td className="tbl__num">{order.estMinutes} мин</td>
                    <td>
                      {order.needsAccess ? (
                        <span className="pill pill--accent">Нужен</span>
                      ) : (
                        <span className="tbl__muted">Не нужен</span>
                      )}
                    </td>
                    <td>{priorityName(order.priority)}</td>
                    <td>
                      {order.engineerName ? (
                        <>
                          <span className="tbl__strong">{order.engineerName}</span>
                          <span className="tbl__sub">{order.engineerId}</span>
                        </>
                      ) : (
                        <span className="tbl__muted">—</span>
                      )}
                    </td>
                    <td>{status(order)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hidden > 0 && (
            <button type="button" className="tblmore" onClick={() => setLimit((n) => n + PAGE)}>
              Показать ещё {Math.min(PAGE, hidden)}
              <span className="tblmore__rest">осталось {hidden}</span>
            </button>
          )}
        </section>
      )}
    </div>
  );
}
