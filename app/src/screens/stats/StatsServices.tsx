import { useMemo } from 'react';
import { hoursText, plural } from '../../data/derive.ts';
import { skillName } from '../../data/dictionary.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { topWithRest, useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { BarChart } from '../../app/BarChart.tsx';
import { countBy, percent, StatRank, StatsHead, tallyToDistribution } from './parts.tsx';
import { serviceTally } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Статистика по услугам.

   Услуга — это не заявка, а вид работы: «подключение», «замена роутера»,
   «авария на линии». Разрез отвечает на «на что уходит хозяйство»: какие
   работы дают поток, какие съедают часы, какие требуют доступа и — что важнее
   всего — какие хуже всех раскладываются.

   Последнее нельзя прочитать ни в базе услуг, ни в базе заявок. Услуга с
   тремя заявками, ни одна из которых не легла в маршрут, в общем числе
   хвоста незаметна; а это и есть та работа, под которую в штате некому
   выйти. Поэтому доля разложенных считается по каждой услуге отдельно, а
   перечень ставит наверх не самые крупные, а самые безнадёжные. */

export function StatsServices({ registry, scope, period, onPeriod, countOf }: DimProps) {
  const tally = useMemo(() => serviceTally(registry, scope), [registry, scope]);

  const widgets = useMemo<WidgetDef[]>(() => {
    const orders = tally.reduce((sum, row) => sum + row.orders, 0);
    const assigned = tally.reduce((sum, row) => sum + row.assigned, 0);
    const minutes = tally.reduce((sum, row) => sum + row.minutes, 0);
    const urgent = tally.reduce((sum, row) => sum + row.urgent, 0);
    const access = tally.reduce((sum, row) => sum + row.access, 0);
    const skills = countBy(tally, (row) => row.skill);
    /* Услуги, до которых в срок никто не доехал: в каталоге они есть, в
       потоке — нет. Число отвечает на «чем мы вообще не занимались», и это
       не то же самое, что «не разложилось». */
    const idle = registry.services.length - tally.length;

    const byOrders = [...tally].sort((a, b) => b.orders - a.orders);

    return [
      {
        key: 'services',
        title: 'Услуг в работе',
        note: 'Сколько видов работ встретилось в заявках срока',
        shape: 'number',
        data: {
          value: String(tally.length),
          caption: `из ${registry.services.length} в каталоге`,
          whole: true,
          parts: [
            { key: 'live', label: 'Были в заявках', value: tally.length, tone: 'ok' },
            { key: 'idle', label: 'Не встретились', value: Math.max(0, idle), tone: 'neutral' }
          ],
          legend: 'услуг'
        }
      },
      {
        key: 'orders',
        title: 'Заявок по услугам',
        note: 'Сколько работы принесли эти услуги и как она разложилась',
        shape: 'number',
        data: {
          value: String(orders),
          caption: 'заявок за срок',
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: orders - assigned, tone: 'bad' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'hours',
        title: 'Часы по услугам',
        note: 'Сколько времени у клиентов стоит за этими работами',
        shape: 'bars',
        data: {
          value: hoursText(minutes),
          caption: 'работы на объектах',
          whole: true,
          parts: topWithRest(
            byOrders
              .map((row) => ({ key: row.key, label: row.title, value: row.minutes }))
              .sort((a, b) => b.value - a.value),
            6
          ),
          legend: 'минут работы'
        }
      },
      {
        key: 'top',
        title: 'Что заказывают чаще',
        note: 'Какие услуги дают основной поток заявок',
        shape: 'donut',
        data: {
          value: byOrders[0]?.title ?? '—',
          caption: byOrders[0] ? `${byOrders[0].orders} заявок — больше всех` : 'заявок нет',
          whole: true,
          parts: topWithRest(
            byOrders.map((row) => ({ key: row.key, label: row.title, value: row.orders })),
            6
          ),
          legend: 'заявок'
        }
      },
      {
        key: 'urgent',
        title: 'Срочность услуг',
        note: 'Какая доля этих работ приходит авариями',
        shape: 'number',
        data: {
          value: percent(orders === 0 ? 0 : urgent / orders),
          caption: `${urgent} срочных заявок`,
          tone: 'warn',
          whole: true,
          parts: topWithRest(
            [...tally]
              .filter((row) => row.urgent > 0)
              .sort((a, b) => b.urgent - a.urgent)
              .map((row) => ({ key: row.key, label: row.title, value: row.urgent })),
            6
          ),
          legend: 'срочных заявок'
        }
      },
      {
        key: 'access',
        title: 'Требуют доступа',
        note: 'Работы, к которым без сопровождения не подойти',
        shape: 'number',
        data: {
          value: percent(orders === 0 ? 0 : access / orders),
          caption: `${access} заявок с доступом`,
          whole: true,
          parts: topWithRest(
            [...tally]
              .filter((row) => row.access > 0)
              .sort((a, b) => b.access - a.access)
              .map((row) => ({ key: row.key, label: row.title, value: row.access })),
            6
          ),
          legend: 'заявок с доступом'
        }
      },
      {
        key: 'skills',
        title: 'Навыки под услуги',
        note: 'Сколько разных навыков нужно, чтобы закрыть этот поток',
        shape: 'bars',
        data: {
          value: String(skills.length),
          caption: 'навыков задействовано',
          whole: true,
          parts: skills.map((row) => ({ key: row.key, label: skillName(row.key), value: row.count })),
          legend: 'услуг'
        }
      },
      {
        key: 'length',
        title: 'Сколько длится работа',
        note: 'Средняя длительность заявки по этой услуге',
        shape: 'bars',
        data: {
          value: orders === 0 ? '—' : `${Math.round(minutes / orders)} мин`,
          caption: 'в среднем на заявку',
          whole: false,
          parts: [...tally]
            .map((row) => ({
              key: row.key,
              label: row.title,
              value: row.orders === 0 ? 0 : Math.round(row.minutes / row.orders)
            }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 8),
          legend: 'минут на заявку'
        }
      }
    ];
  }, [registry.services.length, tally]);

  const board = useWidgetBoard({
    storeKey: 'stats-services',
    catalogue: widgets,
    fallback: ['services', 'orders', 'hours', 'top', 'urgent', 'access'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Услуги',
    fixed: true
  });

  const bySkill = useMemo(
    () => tallyToDistribution(countBy(tally, (row) => row.skill), skillName),
    [tally]
  );

  /* Кто хуже всех раскладывается. Услуги с одной-двумя заявками сюда не
     берём: «ноль из одной» — это 0 %, и такая строка вытеснила бы наверх
     случай вместо закономерности. */
  const weak = useMemo(
    () =>
      tally
        .filter((row) => row.orders >= 3 && row.assigned < row.orders)
        .sort((a, b) => a.assigned / a.orders - b.assigned / b.orders),
    [tally]
  );

  const heavy = useMemo(() => [...tally].sort((a, b) => b.minutes - a.minutes), [tally]);

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead
          title="На что уходит хозяйство"
          note="Услуги срока: чем чаще заказывают и что дольше делают"
        />
        <div className="statsgrid">
          <StatRank
            title="Больше всех заявок"
            note="заявок за срок"
            rows={[...tally]
              .sort((a, b) => b.orders - a.orders)
              .map((row) => ({
                key: row.key,
                label: row.title,
                note: `${skillName(row.skill)} · на ${plural(row.clients, 'адрес', 'адреса', 'адресов')}`,
                value: row.orders,
                text: String(row.orders)
              }))}
          />
          <StatRank
            title="Больше всех часов"
            note="работы на объектах"
            rows={heavy.map((row) => ({
              key: row.key,
              label: row.title,
              note:
                row.orders === 0
                  ? undefined
                  : `${Math.round(row.minutes / row.orders)} мин на заявку в среднем`,
              value: row.minutes,
              text: hoursText(row.minutes)
            }))}
          />
        </div>
      </section>

      <section className="panel">
        <StatsHead
          title="Что не находит инженера"
          note="Услуги, под которые в штате чаще всего некому выйти"
        />
        <div className="statsgrid">
          <StatRank
            title="Хуже всех раскладываются"
            note="разложено от всех заявок услуги"
            rows={weak.map((row) => ({
              key: row.key,
              label: row.title,
              note: `${row.orders - row.assigned} из ${row.orders} без инженера · ${skillName(row.skill)}`,
              value: row.assigned / row.orders,
              text: percent(row.assigned / row.orders),
              bad: true
            }))}
            empty="Все услуги срока раскладываются полностью."
          />
          <BarChart
            title="Услуги по нужному навыку"
            distribution={bySkill}
            unit={(n) => plural(n, 'услуга', 'услуги', 'услуг')}
          />
        </div>
      </section>
    </>
  );
}
