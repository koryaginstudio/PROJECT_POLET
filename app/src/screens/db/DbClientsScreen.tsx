import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { ClientRecord, Registry } from '../../data/registry.ts';
import { hhmm, plural } from '../../data/derive.ts';
import { workTypeIcon } from '../../data/dictionary.ts';
import { DbHead } from './DbHead.tsx';

interface Props {
  registry: Registry;
  mode: string;
}

type Sort = 'orders' | 'coverage' | 'name';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'orders', label: 'По числу заявок' },
  { value: 'coverage', label: 'По покрытию' },
  { value: 'name', label: 'По алфавиту' }
];

const coverage = (client: ClientRecord) =>
  client.orders === 0 ? 0 : client.assigned / client.orders;

/* База клиентов. Собрана по всем расчётам сразу и ни к одному не привязана:
   здесь смотрят, кто у нас вообще есть и как их обслуживали, а не что движок
   решил сегодня. */
export function DbClientsScreen({ registry, mode }: Props) {
  const [sort, setSort] = useState<Sort>('orders');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    /* Ищут и по улице, и по району: «Ленинский» — это и проспект, и округ,
       и заранее не известно, что из двух держал в голове диспетчер. */
    const list = registry.clients.filter(
      (client) =>
        !needle ||
        client.address.toLowerCase().includes(needle) ||
        client.district.toLowerCase().includes(needle)
    );
    return [...list].sort((a, b) => {
      if (sort === 'coverage') return coverage(a) - coverage(b) || b.orders - a.orders;
      if (sort === 'name') return a.address.localeCompare(b.address, 'ru');
      return b.orders - a.orders || a.address.localeCompare(b.address, 'ru');
    });
  }, [registry, sort, query]);

  const totals = useMemo(() => {
    const all = registry.clients;
    const orders = all.reduce((sum, c) => sum + c.orders, 0);
    const assigned = all.reduce((sum, c) => sum + c.assigned, 0);
    return {
      points: all.length,
      orders,
      assigned,
      access: all.reduce((sum, c) => sum + c.access, 0),
      urgent: all.reduce((sum, c) => sum + c.urgent, 0)
    };
  }, [registry]);

  return (
    <div className="dash enter">
      <DbHead
        title="База клиентов"
        lede={
          <>
            Справочника клиентов в контракте нет: заказчик описан точкой обслуживания — адрес
            дома, район, окно приёма и нужен ли доступ в подъезд. Одна строка — один дом, сколько
            бы заявок оттуда ни приходило. База собрана по всем расчётам сразу и к отдельному
            прогону не привязана.
          </>
        }
        stats={[
          { label: 'Адресов обслуживания', value: totals.points },
          { label: 'Заявок за всё время', value: totals.orders },
          { label: 'Из них обслужено', value: totals.assigned },
          { label: 'Нужен доступ', value: totals.access },
          { label: 'Высокий приоритет', value: totals.urgent }
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
          <label className="dbsearch">
            <Icon name="search" size={14} />
            <input
              className="dbsearch__input"
              value={query}
              placeholder="Найти адрес или район"
              onChange={(e) => setQuery(e.currentTarget.value)}
            />
            {query && (
              <button type="button" className="dbsearch__clear" onClick={() => setQuery('')}>
                <Icon name="x" size={12} />
              </button>
            )}
          </label>
          <span className="filters__note">
            {plural(rows.length, 'адрес', 'адреса', 'адресов')} в выборке
          </span>
        </div>
      </section>

      {mode === 'cards' ? (
        <div className="cboard">
          {rows.map((client) => (
            <div key={client.key} className="ccard ccard--static">
              <span className="ccard__top">
                <span className="ccard__name" title={client.address}>
                  {client.address}
                  <span className="ccard__where">{client.district}</span>
                </span>
                <span className="ccard__count">{client.orders}</span>
              </span>
              <span className="ccard__rows">
                <span className="ccard__row">
                  <span>Обслужено</span>
                  <b className={coverage(client) < 0.8 ? 'ccard__bad' : undefined}>
                    {Math.round(coverage(client) * 100)}%
                  </b>
                </span>
                <span className="ccard__row">
                  <span>В расчётах</span>
                  <b>
                    {client.runs} из {registry.runs.length}
                  </b>
                </span>
                <span className="ccard__row">
                  <span>Нужен доступ</span>
                  <b>{client.access}</b>
                </span>
                <span className="ccard__row">
                  <span>Средняя работа</span>
                  <b>{client.avgMinutes} мин</b>
                </span>
              </span>
              <span className="ccard__tags">
                {client.workTypes.map((type) => (
                  <span key={type} className="chip chip--static">
                    <Icon name={workTypeIcon(type)} size={12} />
                    {registry.workTypeTitle[type] ?? type}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Адрес обслуживания</th>
                  <th>Заявок</th>
                  <th>Обслужено</th>
                  <th>Покрытие</th>
                  <th>Виды работ</th>
                  <th>Доступ</th>
                  <th>Срочных</th>
                  <th>Средняя работа</th>
                  <th>Раннее окно</th>
                  <th>В расчётах</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((client) => {
                  const rate = coverage(client);
                  return (
                    <tr key={client.key} className="tbl__row">
                      <td>
                        <span className="tbl__strong">{client.address}</span>
                        <span className="tbl__sub">
                          {client.district} ·{' '}
                          {plural(client.workTypes.length, 'вид работ', 'вида работ', 'видов работ')}
                        </span>
                      </td>
                      <td className="tbl__num">{client.orders}</td>
                      <td className="tbl__num">{client.assigned}</td>
                      <td>
                        <span className={'pill pill--' + (rate < 0.8 ? 'danger' : 'success')}>
                          {Math.round(rate * 100)}%
                        </span>
                      </td>
                      <td>
                        <span className="tbl__tags">
                          {client.workTypes.map((type) => (
                            <span key={type} className="tbl__inline">
                              <Icon name={workTypeIcon(type)} size={13} />
                              {registry.workTypeTitle[type] ?? type}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="tbl__num">{client.access}</td>
                      <td className="tbl__num">{client.urgent}</td>
                      <td className="tbl__num">{client.avgMinutes} мин</td>
                      <td className="tbl__num">{hhmm(client.firstWindow)}</td>
                      <td className="tbl__num">
                        {client.runs} / {registry.runs.length}
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
