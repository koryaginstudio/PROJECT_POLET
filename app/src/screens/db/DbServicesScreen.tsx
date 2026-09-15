import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { Registry, ServiceRecord } from '../../data/registry.ts';
import { plural } from '../../data/derive.ts';
import {
  equipmentName,
  orderClassName,
  skillIcon,
  skillName,
  transportName
} from '../../data/dictionary.ts';
import { DbHead } from './DbHead.tsx';

interface Props {
  registry: Registry;
  mode: string;
}

/* База услуг: что именно делают на объекте.

   Услуга — это вид работ, и с навыком она не совпадает. Навыков по ТЗ ровно
   три, они отвечают на «кто может взять заявку». Услуг восемнадцать, и они
   отвечают на «что он там будет делать»: «Конвергенция абонента», «Нет
   линка», «Замена приставки». Один навык покрывает несколько услуг, и
   путать их нельзя — отсюда и отдельный справочник.

   Три числа про каждую услугу — не украшение, а то, чем услуга влияет на
   план: сколько занимает работа, что везти с собой и нужна ли машина.
   Длительности в выгрузке нет, и в карточке про это сказано. */

type Sort = 'orders' | 'minutes' | 'name';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'orders', label: 'По числу заявок' },
  { value: 'minutes', label: 'По длительности' },
  { value: 'name', label: 'По алфавиту' }
];

const minutesLabel = (row: ServiceRecord) =>
  row.minutes === row.minutesTo ? `${row.minutes} мин` : `${row.minutes}–${row.minutesTo} мин`;

export function DbServicesScreen({ registry, mode }: Props) {
  const [sort, setSort] = useState<Sort>('orders');
  const [skill, setSkill] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const all = registry.services;

  const skills = useMemo(() => {
    const set = new Set<string>();
    for (const row of all) set.add(row.skill);
    return [...set].sort((a, b) => skillName(a).localeCompare(skillName(b)));
  }, [all]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = all.filter((row) => {
      if (skill && row.skill !== skill) return false;
      if (!needle) return true;
      return (
        row.title.toLowerCase().includes(needle) ||
        skillName(row.skill).toLowerCase().includes(needle)
      );
    });
    return [...picked].sort((a, b) => {
      if (sort === 'name') return a.title.localeCompare(b.title);
      if (sort === 'minutes') return b.minutesTo - a.minutesTo || b.orders - a.orders;
      return b.orders - a.orders || a.title.localeCompare(b.title);
    });
  }, [all, query, skill, sort]);

  const totals = useMemo(() => {
    const orders = all.reduce((sum, row) => sum + row.orders, 0);
    const needCar = all.filter((row) => row.requiredTransport).length;
    const withGear = all.filter((row) => row.equipment.length > 0).length;
    return { orders, needCar, withGear };
  }, [all]);

  /* Группировка по навыку: она и есть ответ на вопрос, как услуги ложатся на
     три навыка ТЗ. Ради этого вида справочник и заводился. */
  const groups = useMemo(() => {
    const map = new Map<string, ServiceRecord[]>();
    for (const row of rows) {
      const list = map.get(row.skill) ?? [];
      list.push(row);
      map.set(row.skill, list);
    }
    return [...map.entries()].sort((a, b) => skillName(a[0]).localeCompare(skillName(b[0])));
  }, [rows]);

  return (
    <div className="dash enter">
      <DbHead
        title="База услуг"
        lede={
          'Услуга — это вид работ: что делают на объекте. С навыком она не совпадает: навыков ' +
          'по ТЗ три, и каждый покрывает несколько услуг. Навык отвечает на «кто может взять», ' +
          'услуга — на «что он там будет делать», сколько это займёт и что везти с собой.'
        }
        stats={[
          { value: String(all.length), label: 'услуг в справочнике' },
          { value: String(totals.orders), label: 'заявок по ним' },
          { value: String(totals.needCar), label: 'требуют автомобиль' },
          { value: String(totals.withGear), label: 'требуют оборудование' }
        ]}
      />

      <section className="panel">
        <div className="dbbar">
          <SegmentedControl
            size="sm"
            value={sort}
            onChange={(value: string) => setSort(value as Sort)}
            items={SORTS}
          />

          <div className="dbbar__chips">
            <button
              type="button"
              className={'chip chip--sm' + (skill === null ? ' chip--on' : '')}
              onClick={() => setSkill(null)}
            >
              Все навыки
            </button>
            {skills.map((key) => (
              <button
                key={key}
                type="button"
                className={'chip chip--sm' + (skill === key ? ' chip--on' : '')}
                onClick={() => setSkill(skill === key ? null : key)}
              >
                <Icon name={skillIcon(key)} size={12} />
                {skillName(key)}
              </button>
            ))}
          </div>

          <input
            className="dbbar__search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Название услуги или навык"
            aria-label="Поиск по услугам"
          />
        </div>
      </section>

      {mode === 'skills' ? (
        groups.map(([key, list]) => (
          <section className="panel" key={key}>
            <div className="dash__section-head">
              <h2 className="dash__section-title">
                <Icon name={skillIcon(key)} size={15} /> {skillName(key)}
              </h2>
              <span className="dash__section-note">
                {plural(list.length, 'услуга', 'услуги', 'услуг')} ·{' '}
                {list.reduce((sum, row) => sum + row.orders, 0)} заявок
              </span>
            </div>
            <div className="srvgrid">
              {list.map((row) => (
                <ServiceCard key={row.key} row={row} />
              ))}
            </div>
          </section>
        ))
      ) : (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Услуга</th>
                  <th>Навык</th>
                  <th>Класс заявки</th>
                  <th>Длительность</th>
                  <th>Оборудование</th>
                  <th>Транспорт</th>
                  <th>Заявок</th>
                  <th>Срочных</th>
                  <th>Нужен доступ</th>
                  <th>Разложено</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className="tbl__row">
                    <td>
                      <span className="tbl__strong">{row.title}</span>
                    </td>
                    <td>
                      <span className="tbl__inline">
                        <Icon name={skillIcon(row.skill)} size={13} />
                        {skillName(row.skill)}
                      </span>
                    </td>
                    <td>
                      {row.orderClass ? (
                        orderClassName(row.orderClass)
                      ) : (
                        <span className="tbl__muted">—</span>
                      )}
                    </td>
                    <td className="tbl__num">{minutesLabel(row)}</td>
                    <td>
                      {row.equipment.length > 0 ? (
                        <span className="tbl__tags">
                          {row.equipment.map((item) => (
                            <span key={item} className="tbl__inline">
                              {equipmentName(item)}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="tbl__muted">не требуется</span>
                      )}
                    </td>
                    <td>
                      {row.requiredTransport ? (
                        transportName(row.requiredTransport)
                      ) : (
                        <span className="tbl__muted">без ограничения</span>
                      )}
                    </td>
                    <td className="tbl__num">{row.orders}</td>
                    <td className="tbl__num">
                      {row.urgent > 0 ? row.urgent : <span className="tbl__muted">—</span>}
                    </td>
                    <td className="tbl__num">{row.access}</td>
                    <td className="tbl__num">
                      {row.planned > 0 ? (
                        `${row.assigned} из ${row.planned}`
                      ) : (
                        <span className="tbl__muted">не считалась</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function ServiceCard({ row }: { row: ServiceRecord }) {
  return (
    <article className="srvcard">
      <span className="srvcard__title">{row.title}</span>
      <span className="srvcard__value">
        {minutesLabel(row)}
        <span className="srvcard__unit">работы</span>
      </span>

      <dl className="engfacts">
        <div className="engfacts__row">
          <dt>Заявок</dt>
          <dd>
            {row.orders}
            {row.urgent > 0 ? ` · срочных ${row.urgent}` : ''}
          </dd>
        </div>
        <div className="engfacts__row">
          <dt>Транспорт</dt>
          <dd>
            {row.requiredTransport ? transportName(row.requiredTransport) : 'без ограничения'}
          </dd>
        </div>
        <div className="engfacts__row">
          <dt>Везти</dt>
          <dd>
            {row.equipment.length > 0
              ? row.equipment.map(equipmentName).join(', ')
              : 'ничего'}
          </dd>
        </div>
        <div className="engfacts__row">
          <dt>Доступ</dt>
          <dd>{row.access > 0 ? `нужен в ${row.access}` : 'не нужен'}</dd>
        </div>
      </dl>
    </article>
  );
}
