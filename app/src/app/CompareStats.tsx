import type { RunStat, RunProfile } from '../data/registry.ts';
import { dec, hoursText } from '../data/derive.ts';
import { CompareHours, runColor } from './CompareHours.tsx';

/* Сравнительная статистика отобранного набора.

   Появляется сама, как только расчётов стало хотя бы два: отобрали — значит,
   хотят сравнить, и требовать после этого ещё одного нажатия незачем.

   Две части, и они отвечают на разные вопросы. Таблица — на «что вышло»:
   итоги в столбик, лучший и худший помечены. График — на «чем отличались»:
   ход дня по часам, наложенный друг на друга. Первое можно прочитать и в
   карточках, второго до сих пор не было нигде. */

interface Row {
  key: string;
  label: string;
  /** Чем больше, тем лучше. У нераспределённых и дороги — наоборот. */
  better: 'more' | 'less';
  value: (row: RunStat) => number;
  text: (row: RunStat) => string;
}

const ROWS: Row[] = [
  {
    key: 'coverage',
    label: 'Покрытие',
    better: 'more',
    value: (row) => row.coverage,
    text: (row) => `${dec(row.coverage * 100)} %`
  },
  {
    key: 'assigned',
    label: 'Разложено заявок',
    better: 'more',
    value: (row) => row.assigned,
    text: (row) => `${row.assigned} из ${row.orders}`
  },
  {
    key: 'loose',
    label: 'Без инженера',
    better: 'less',
    value: (row) => row.orders - row.assigned,
    text: (row) => String(row.orders - row.assigned)
  },
  {
    key: 'visits',
    label: 'Визитов',
    better: 'more',
    value: (row) => row.visits,
    text: (row) => String(row.visits)
  },
  {
    key: 'crew',
    label: 'Инженеров с маршрутом',
    better: 'more',
    value: (row) => row.engineersOnRoute,
    text: (row) => `${row.engineersOnRoute} из ${row.engineersTotal}`
  },
  {
    key: 'travel',
    label: 'В дороге',
    better: 'less',
    value: (row) => row.travelMinutes,
    text: (row) => hoursText(row.travelMinutes)
  },
  {
    key: 'occupancy',
    /* «Загрузка», как и на пульте, в карточках и в базах: один показатель
       под одним именем. Точность та же, что у разброса в конце строки, —
       иначе «74 %» в столбце и «3,5 п.» справа не сходились бы. */
    label: 'Средняя загрузка',
    better: 'more',
    value: (row) => row.occupancy,
    text: (row) => `${dec(row.occupancy * 100)} %`
  }
];

export function CompareStats({
  rows,
  profiles
}: {
  rows: RunStat[];
  profiles: RunProfile[];
}) {
  if (rows.length < 2) return null;

  return (
    <>
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Сравнение</h2>
        </div>
        <CompareHours profiles={profiles} />
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Итоги рядом</h2>
        </div>

        <div className="tbl-wrap">
          <table className="tbl cstat">
            <thead>
              <tr>
                <th>Показатель</th>
                {rows.map((row, index) => (
                  <th key={row.run.id}>
                    <span className="cstat__head">
                      <i className="chours__dotmark" style={{ background: runColor(index) }} />
                      {row.run.code}
                    </span>
                  </th>
                ))}
                <th>Разброс</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((line) => {
                const values = rows.map((row) => line.value(row));
                const best = line.better === 'more' ? Math.max(...values) : Math.min(...values);
                const worst = line.better === 'more' ? Math.min(...values) : Math.max(...values);
                /* Разброс считаем в тех же единицах, в каких строка показана:
                   «от 63,7 до 90,7 %» понятнее, чем «27 пунктов разницы». */
                const spread = Math.max(...values) - Math.min(...values);
                return (
                  <tr key={line.key} className="tbl__row">
                    <td>{line.label}</td>
                    {rows.map((row, index) => {
                      const value = values[index];
                      /* Когда все значения равны, помечать нечего: лучший и
                         худший — это разница, а не место в списке. */
                      const same = best === worst;
                      return (
                        <td
                          key={row.run.id}
                          className={
                            'tbl__num' +
                            (!same && value === best ? ' cstat__best' : '') +
                            (!same && value === worst ? ' cstat__worst' : '')
                          }
                        >
                          {line.text(row)}
                        </td>
                      );
                    })}
                    <td className="tbl__num tbl__muted">
                      {spread === 0
                        ? 'одинаково'
                        : line.key === 'travel'
                          ? hoursText(spread)
                          : line.key === 'coverage' || line.key === 'occupancy'
                            ? `${dec(spread * 100)} п.`
                            : String(Math.round(spread * 10) / 10)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
