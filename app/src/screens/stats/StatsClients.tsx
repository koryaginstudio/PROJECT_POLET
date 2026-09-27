import { useMemo } from 'react';
import { hoursText, plural } from '../../data/derive.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { topWithRest, useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { BarChart } from '../../app/BarChart.tsx';
import { countBy, percent, StatRank, StatsHead, tallyToDistribution } from './parts.tsx';
import { clientTally } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Статистика по клиентам.

   Клиент здесь — точка обслуживания: один дом, одна строка, сколько бы заявок
   оттуда ни приходило. Разрез отвечает на «куда мы ездим»: сколько адресов в
   работе, какие дают поток, где нас ждут повторно и где остаётся хвост.

   Повторные выезды стоят отдельным числом, потому что стоят отдельных денег:
   один адрес в трёх расчётах срока — это либо большой объект, либо работа,
   которую не закрыли с первого раза. Отрасль меряет это «долей закрытых с
   первого визита»; у нас выполнение приходит из выгрузки не всегда, поэтому
   считаем то, что знаем точно: сколько адресов встретились больше чем в одном
   расчёте.

   Хвост по адресам — второй перечень. Число нераспределённых по городу
   отвечает на «сколько», а адрес — на «куда ехать некому»: восемь заявок с
   одного дома без инженера значат, что там нужен человек с навыком, которого
   в смене нет. */

export function StatsClients({ registry, scope, period, onPeriod, countOf }: DimProps) {
  const tally = useMemo(() => clientTally(registry, scope), [registry, scope]);

  const widgets = useMemo<WidgetDef[]>(() => {
    const orders = tally.reduce((sum, row) => sum + row.orders, 0);
    const assigned = tally.reduce((sum, row) => sum + row.assigned, 0);
    const urgent = tally.reduce((sum, row) => sum + row.urgent, 0);
    const access = tally.reduce((sum, row) => sum + row.access, 0);
    const minutes = tally.reduce((sum, row) => sum + row.minutes, 0);
    const repeat = tally.filter((row) => row.runs > 1).length;
    const many = tally.filter((row) => row.orders > 1).length;
    const districts = countBy(tally, (row) => row.district);
    const byOrders = [...tally].sort((a, b) => b.orders - a.orders);

    return [
      {
        key: 'clients',
        title: 'Адресов в работе',
        note: 'К скольким точкам обслуживания ездили за срок',
        shape: 'number',
        data: {
          value: String(tally.length),
          caption: `из ${registry.clients.length} в базе`,
          whole: true,
          parts: [
            { key: 'one', label: 'Одна заявка', value: tally.length - many, tone: 'ok' },
            { key: 'many', label: 'Несколько заявок', value: many, tone: 'warn' }
          ],
          legend: 'адресов'
        }
      },
      {
        key: 'orders',
        title: 'Заявок по адресам',
        note: 'Сколько работы принесли эти адреса и как она разложилась',
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
        key: 'repeat',
        title: 'Повторные выезды',
        note: 'Адреса, куда ехали больше чем в одном расчёте срока',
        shape: 'number',
        data: {
          value: String(repeat),
          caption: `${percent(tally.length === 0 ? 0 : repeat / tally.length)} адресов срока`,
          tone: repeat > 0 ? 'warn' : 'ok',
          whole: true,
          parts: [
            { key: 'once', label: 'Один расчёт', value: tally.length - repeat, tone: 'ok' },
            { key: 'again', label: 'Два и больше', value: repeat, tone: 'warn' }
          ],
          legend: 'адресов'
        }
      },
      {
        key: 'top',
        title: 'Где больше всего работы',
        note: 'Адреса, дающие основной поток заявок',
        shape: 'bars',
        data: {
          value: byOrders[0] ? byOrders[0].code : '—',
          caption: byOrders[0] ? `${byOrders[0].orders} заявок — больше всех` : 'заявок нет',
          whole: true,
          parts: topWithRest(
            byOrders.map((row) => ({ key: row.key, label: `${row.code} · ${row.address}`, value: row.orders })),
            6
          ),
          legend: 'заявок'
        }
      },
      {
        key: 'districts',
        title: 'Адреса по районам',
        note: 'Как точки обслуживания разложены по городу',
        shape: 'bars',
        data: {
          value: String(districts.length),
          caption: 'районов задействовано',
          whole: true,
          parts: topWithRest(
            districts.map((row) => ({ key: row.key, label: row.key, value: row.count })),
            6
          ),
          legend: 'адресов'
        }
      },
      {
        key: 'urgent',
        title: 'Срочные заявки',
        note: 'Какая доля потока с этих адресов приходит авариями',
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
              .map((row) => ({ key: row.key, label: `${row.code} · ${row.address}`, value: row.urgent })),
            6
          ),
          legend: 'срочных заявок'
        }
      },
      {
        key: 'access',
        title: 'Нужен доступ',
        note: 'Адреса, куда без сопровождения не попасть',
        shape: 'number',
        data: {
          value: String(access),
          caption: `${percent(orders === 0 ? 0 : access / orders)} заявок срока`,
          whole: true,
          parts: topWithRest(
            [...tally]
              .filter((row) => row.access > 0)
              .sort((a, b) => b.access - a.access)
              .map((row) => ({ key: row.key, label: `${row.code} · ${row.address}`, value: row.access })),
            6
          ),
          legend: 'заявок с доступом'
        }
      },
      {
        key: 'minutes',
        title: 'Работы по адресам',
        note: 'Сколько часов стоит за этими точками обслуживания',
        shape: 'number',
        data: {
          value: hoursText(minutes),
          caption: 'работы на объектах',
          facts: [
            tally.length > 0 ? `${Math.round(minutes / tally.length)} мин на адрес в среднем` : ''
          ].filter(Boolean),
          whole: false,
          parts: topWithRest(
            [...tally]
              .sort((a, b) => b.minutes - a.minutes)
              .map((row) => ({
                key: row.key,
                label: `${row.code} · ${row.address}`,
                value: row.minutes,
                text: hoursText(row.minutes)
              })),
            6
          ),
          legend: 'минут работы'
        }
      }
    ];
  }, [registry.clients.length, tally]);

  const board = useWidgetBoard({
    storeKey: 'stats-clients',
    catalogue: widgets,
    fallback: ['clients', 'orders', 'repeat', 'top', 'urgent', 'access'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Клиенты',
    fixed: true
  });

  const byDistrict = useMemo(
    () => tallyToDistribution(countBy(tally, (row) => row.district), (key) => key),
    [tally]
  );

  /* Порядок — по величине хвоста, а не по числу заявок: адрес с двадцатью
     заявками, из которых не разложилась одна, стоит ниже дома с тремя, где
     не разложилось три. */
  const loose = useMemo(
    () =>
      tally
        .filter((row) => row.orders > row.assigned)
        .sort((a, b) => b.orders - b.assigned - (a.orders - a.assigned)),
    [tally]
  );
  const repeat = useMemo(() => tally.filter((row) => row.runs > 1).sort((a, b) => b.runs - a.runs), [tally]);

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead title="Куда мы ездим" note="Точки обслуживания срока: поток и то, как он лёг по городу" />
        <div className="statsgrid">
          <StatRank
            title="Больше всех заявок"
            note="заявок за срок"
            rows={[...tally]
              .sort((a, b) => b.orders - a.orders)
              .map((row) => ({
                key: row.key,
                label: `${row.code} · ${row.address}`,
                note: `${row.company} · ${row.district} · ${plural(
                  row.workTypes.size,
                  'вид работ',
                  'вида работ',
                  'видов работ'
                )}`,
                value: row.orders,
                text: String(row.orders)
              }))}
          />
          <BarChart
            title="Адреса по районам"
            distribution={byDistrict}
            unit={(n) => plural(n, 'адрес', 'адреса', 'адресов')}
          />
        </div>
      </section>

      <section className="panel">
        <StatsHead
          title="Куда ехать некому и куда ездим снова"
          note="Хвост по адресам и повторные выезды за срок"
        />
        <div className="statsgrid">
          <StatRank
            title="Хвост по адресам"
            note="заявок без инженера"
            rows={loose.map((row) => ({
              key: row.key,
              label: `${row.code} · ${row.address}`,
              note: `${row.orders - row.assigned} из ${row.orders} без инженера · ${row.district}`,
              value: row.orders - row.assigned,
              text: String(row.orders - row.assigned),
              bad: true
            }))}
            empty="Хвоста нет: на каждый адрес срока нашёлся инженер."
          />
          <StatRank
            title="Повторные выезды"
            note="расчётов с этим адресом"
            rows={repeat.map((row) => ({
              key: row.key,
              label: `${row.code} · ${row.address}`,
              note: `${plural(row.orders, 'заявка', 'заявки', 'заявок')} · ${hoursText(row.minutes)} работы`,
              value: row.runs,
              text: String(row.runs)
            }))}
            empty="Повторных выездов за срок нет: к каждому адресу ездили один раз."
          />
        </div>
      </section>
    </>
  );
}
