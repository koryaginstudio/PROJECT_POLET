import { useMemo } from 'react';
import { hoursText, occupancyMean, plural } from '../../data/derive.ts';
import { skillName } from '../../data/dictionary.ts';
import { whenLabel } from '../../data/load.ts';
import { service } from '../../data/service.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { percent, StatGauge, StatRank, StatsHead } from './parts.tsx';
import { clientTally, crewTally, runSeries, serviceTally } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Сводка раздела.

   Отвечает на «как дела в целом» и ничего не разбирает: разбор живёт в шести
   разрезах рядом. Здесь три вещи, и все три — про решение, а не про
   любопытство.

   Первое — доска сквозных чисел: сколько расчётов, заявок, людей, адресов.
   Второе — три показателя против нормы. Это главное, чего числу не хватает:
   «загрузка 82 %» читают как успех, пока не знают, что выше порога смена
   стоит на пределе и первая же пробка съедает запас. Границы взяты из
   настроек сервиса — тех же, по которым пульт красит цифры.
   Третье — «на что посмотреть»: четыре перечня того, что за срок не сошлось.
   Сводка не обязана быть красивой; она обязана за полминуты сказать, куда
   идти дальше. */

export function StatsDigest({ registry, scope, period, onPeriod, countOf, onOpenRun }: DimProps) {
  const runs = scope.runs;
  const orders = scope.orders;
  const thresholds = service().thresholds;

  const totals = useMemo(() => {
    const assigned = orders.filter((row) => row.engineerId).length;
    const work = runs.reduce((sum, row) => sum + row.workMinutes, 0);
    const travel = runs.reduce((sum, row) => sum + row.travelMinutes, 0);
    const coverage = runs.length === 0 ? 0 : runs.reduce((sum, row) => sum + row.coverage, 0) / runs.length;
    return {
      assigned,
      loose: orders.length - assigned,
      work,
      travel,
      coverage,
      occupancy: occupancyMean(runs),
      wheelShare: work + travel === 0 ? 0 : travel / (work + travel),
      routes: scope.routes.length,
      visits: runs.reduce((sum, row) => sum + row.visits, 0)
    };
  }, [orders, runs, scope.routes.length]);

  const crew = useMemo(() => crewTally(registry, scope), [registry, scope]);
  const clients = useMemo(() => clientTally(registry, scope), [registry, scope]);
  const services = useMemo(() => serviceTally(registry, scope), [registry, scope]);

  const widgets = useMemo<WidgetDef[]>(
    () => [
      {
        key: 'runs',
        title: 'Расчётов',
        note: 'Сколько расчётов сделано за срок',
        shape: 'number',
        data: {
          value: String(runs.length),
          caption: 'за выбранный срок',
          series: runSeries(scope, () => 1),
          legend: 'расчётов'
        }
      },
      {
        key: 'orders',
        title: 'Заявок',
        note: 'Сколько разных заявок прошло через расчёты срока и что с ними стало',
        shape: 'number',
        data: {
          value: String(orders.length),
          caption: 'заявок за срок',
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: totals.assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: totals.loose, tone: 'bad' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'coverage',
        title: 'Прогноз выполнения',
        note: 'Насколько полно расчёты раскладывают день',
        shape: 'line',
        data: {
          value: percent(totals.coverage),
          caption: 'в среднем по расчётам',
          tone:
            totals.coverage * 100 >= thresholds.coverageWatch
              ? 'ok'
              : totals.coverage * 100 >= thresholds.coverageBad
                ? 'warn'
                : 'bad',
          series: runSeries(scope, (row) => row.coverage * 100),
          legend: '% прогноза'
        }
      },
      {
        key: 'occupancy',
        title: 'Загрузка инженеров',
        note: 'Насколько плотно занята смена',
        shape: 'line',
        data: {
          value: percent(totals.occupancy),
          caption: 'в среднем по расчётам',
          tone: totals.occupancy * 100 > thresholds.occupancy ? 'bad' : 'ok',
          series: runSeries(scope, (row) => row.occupancy * 100),
          legend: '% загрузки'
        }
      },
      {
        key: 'crew',
        title: 'Инженеров в работе',
        note: 'Сколько людей расчёты поставили в план и скольким дали маршрут',
        shape: 'number',
        data: {
          value: String(crew.length),
          caption: `из ${registry.engineers.length} в базе`,
          whole: true,
          parts: [
            {
              key: 'routed',
              label: 'С маршрутом',
              value: crew.filter((row) => row.routed > 0).length,
              tone: 'ok'
            },
            {
              key: 'idle',
              label: 'Без маршрута',
              value: crew.filter((row) => row.routed === 0).length,
              tone: 'bad'
            }
          ],
          legend: 'инженеров'
        }
      },
      {
        key: 'clients',
        title: 'Адресов в работе',
        note: 'К скольким точкам обслуживания ездили за срок',
        shape: 'number',
        data: {
          value: String(clients.length),
          caption: `из ${registry.clients.length} в базе`,
          facts: [`${clients.filter((row) => row.runs > 1).length} с повторным выездом`],
          legend: 'адресов'
        }
      },
      {
        key: 'services',
        title: 'Услуг в потоке',
        note: 'Сколько видов работ встретилось в заявках срока',
        shape: 'number',
        data: {
          value: String(services.length),
          caption: `из ${registry.services.length} в каталоге`,
          legend: 'услуг'
        }
      },
      {
        key: 'routes',
        title: 'Маршрутов',
        note: 'Сколько дней инженеров сложили расчёты',
        shape: 'number',
        data: {
          value: String(totals.routes),
          caption: 'построено за срок',
          series: runSeries(scope, (row) => row.routes),
          legend: 'маршрутов'
        }
      },
      {
        key: 'wheel',
        title: 'Дорога и работа',
        note: 'Как время делится между переездами и работой у клиента',
        shape: 'donut',
        data: {
          value: percent(totals.wheelShare),
          caption: 'времени уходит на дорогу',
          tone: totals.wheelShare <= 0.2 ? 'ok' : totals.wheelShare <= 0.3 ? 'warn' : 'bad',
          whole: true,
          /* Доли в часах, а не в минутах: в середине кольца стоит их сумма, и
             двадцать шесть тысяч минут там читались бы как ошибка счёта. */
          parts: [
            {
              key: 'work',
              label: 'На объектах',
              value: Math.round(totals.work / 60),
              tone: 'ok',
              text: hoursText(totals.work)
            },
            {
              key: 'travel',
              label: 'В дороге',
              value: Math.round(totals.travel / 60),
              tone: 'warn',
              text: hoursText(totals.travel)
            }
          ],
          legend: 'часов'
        }
      },
      {
        key: 'visits',
        title: 'Визитов запланировано',
        note: 'Сколько посещений стоит в маршрутах',
        shape: 'number',
        data: {
          value: String(totals.visits),
          caption: 'стоит в маршрутах',
          series: runSeries(scope, (row) => row.visits),
          legend: 'визитов'
        }
      }
    ],
    [
      clients,
      crew,
      orders.length,
      registry.clients.length,
      registry.engineers.length,
      registry.services.length,
      runs.length,
      scope,
      services.length,
      thresholds.coverageBad,
      thresholds.coverageWatch,
      thresholds.occupancy,
      totals
    ]
  );

  const board = useWidgetBoard({
    storeKey: 'stats-digest',
    catalogue: widgets,
    fallback: ['runs', 'orders', 'coverage', 'occupancy', 'crew', 'wheel'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Сводка',
    fixed: true
  });

  /* Что за срок не сошлось. Четыре перечня, и каждый — начало дороги: расчёт
     открывают, услугу ищут в базе услуг, адрес — в базе клиентов. Числа здесь
     не итоговые, а поводом: «восемь заявок с одного дома без инженера» само
     называет, чего не хватает в смене. */
  const weakRuns = useMemo(
    () => runs.filter((row) => row.orders > row.assigned).sort((a, b) => a.coverage - b.coverage),
    [runs]
  );
  const weakServices = useMemo(
    () =>
      services
        .filter((row) => row.orders >= 3 && row.assigned < row.orders)
        .sort((a, b) => a.assigned / a.orders - b.assigned / b.orders),
    [services]
  );
  const looseClients = useMemo(
    () =>
      clients
        .filter((row) => row.orders > row.assigned)
        .sort((a, b) => b.orders - b.assigned - (a.orders - a.assigned)),
    [clients]
  );
  const idleCrew = useMemo(
    () => crew.filter((row) => row.idle > 0).sort((a, b) => b.idle - a.idle),
    [crew]
  );

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead
          title="Показатели против нормы"
          note="Границы — те же, что в настройках сервиса: по ним интерфейс называет число проблемой"
        />
        <div className="sgauges">
          <StatGauge
            label="Прогноз выполнения"
            value={totals.coverage}
            text={percent(totals.coverage)}
            scale={1}
            bands={[
              { to: thresholds.coverageBad / 100, tone: 'bad' },
              { to: thresholds.coverageWatch / 100, tone: 'warn' },
              { to: 1, tone: 'ok' }
            ]}
            note={`Норма — от ${thresholds.coverageWatch} %. Ниже ${thresholds.coverageBad} % расчёт оставляет хвост, который придётся разводить руками.`}
          />
          <StatGauge
            label="Загрузка инженеров"
            value={totals.occupancy}
            text={percent(totals.occupancy)}
            scale={1}
            bands={[
              { to: (thresholds.occupancy * 0.8) / 100, tone: 'warn' },
              { to: thresholds.occupancy / 100, tone: 'ok' },
              { to: 1, tone: 'bad' }
            ]}
            note={`Норма — до ${thresholds.occupancy} %. Выше смена идёт без запаса: первая пробка или задержка на объекте уводит маршрут за границу дня.`}
          />
          <StatGauge
            label="Доля дороги"
            value={totals.wheelShare}
            text={percent(totals.wheelShare)}
            scale={1}
            bands={[
              { to: 0.2, tone: 'ok' },
              { to: 0.3, tone: 'warn' },
              { to: 1, tone: 'bad' }
            ]}
            note={`${hoursText(totals.travel)} в дороге против ${hoursText(
              totals.work
            )} на объектах. За рулём держат не больше пятой части смены: эта минута оплачена и ничего не сделала.`}
          />
        </div>
      </section>

      <section className="panel">
        <StatsHead
          title="На что посмотреть"
          note="Что за срок не сошлось — по расчётам, услугам, адресам и людям"
        />
        <div className="statsgrid">
          <StatRank
            title="Расчёты с хвостом"
            note="прогноз выполнения"
            limit={5}
            rows={weakRuns.map((row) => ({
              key: row.run.id,
              label: row.run.code,
              note: `${row.orders - row.assigned} без инженера · ${whenLabel(row.run.created)}`,
              value: row.coverage,
              text: percent(row.coverage),
              bad: true,
              onOpen: () => onOpenRun(row.run.id)
            }))}
            empty="Все расчёты срока разложили день целиком."
          />
          <StatRank
            title="Услуги без инженера"
            note="разложено от заявок услуги"
            limit={5}
            rows={weakServices.map((row) => ({
              key: row.key,
              label: row.title,
              note: `${row.orders - row.assigned} из ${row.orders} без инженера · ${skillName(row.skill)}`,
              value: row.assigned / row.orders,
              text: percent(row.assigned / row.orders),
              bad: true
            }))}
            empty="Все услуги срока раскладываются полностью."
          />
          <StatRank
            title="Адреса с хвостом"
            note="заявок без инженера"
            limit={5}
            rows={looseClients.map((row) => ({
              key: row.key,
              label: `${row.code} · ${row.address}`,
              note: `${row.company} · ${row.district}`,
              value: row.orders - row.assigned,
              text: String(row.orders - row.assigned),
              bad: true
            }))}
            empty="На каждый адрес срока нашёлся инженер."
          />
          <StatRank
            title="Инженеры без маршрута"
            note="смен без работы"
            limit={5}
            rows={idleCrew.map((row) => ({
              key: row.record.id,
              label: row.record.name,
              note: `${plural(row.shifts.length, 'смена', 'смены', 'смен')} в расчётах · ${
                row.record.skills.map(skillName).join(', ') || 'навыки не указаны'
              }`,
              value: row.idle,
              text: `${row.idle} из ${row.shifts.length}`,
              bad: true
            }))}
            empty="Каждый инженер получил маршрут в каждом расчёте срока."
          />
        </div>
      </section>
    </>
  );
}
