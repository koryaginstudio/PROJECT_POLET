import { useMemo } from 'react';
import { dec, hoursText, occupancyMean, plural } from '../../data/derive.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { topWithRest, useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { BarChart } from '../../app/BarChart.tsx';
import { countBy, percent, StatRank, StatsHead, tallyToDistribution } from './parts.tsx';
import { groupSeries } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Статистика по маршрутам.

   Маршрут — это результат расчёта: день одного инженера, сложенный в порядок
   объездов. Разрез отвечает на «из чего этот день состоит»: сколько визитов
   встаёт в маршрут, сколько времени уходит на дорогу, сколько на работу, а
   сколько — в ожидание.

   Простой стоит рядом с дорогой и работой нарочно. Час в дороге — плата за
   расстояние, час ожидания — плата за окно приёма: инженер приехал раньше,
   чем клиент готов открыть дверь. Это разные болезни с разным лечением, и
   складывать их в одно «не работал» значит терять причину.

   Доля дороги — тот показатель, по которому раскладку меряют в отрасли: выше
   пятой части смены за рулём считают перебором, потому что каждая такая
   минута оплачена и ничего не сделала. */

export function StatsRoutes({ scope, period, onPeriod, countOf, onOpenRun }: DimProps) {
  const routes = scope.routes;

  const widgets = useMemo<WidgetDef[]>(() => {
    const visits = routes.reduce((sum, row) => sum + row.visits, 0);
    const travel = routes.reduce((sum, row) => sum + row.travelMinutes, 0);
    const work = routes.reduce((sum, row) => sum + row.workMinutes, 0);
    const idle = routes.reduce((sum, row) => sum + row.idleMinutes, 0);
    const overtime = routes.reduce((sum, row) => sum + row.overtimeMinutes, 0);
    const risky = routes.reduce((sum, row) => sum + row.risky, 0);
    const known = routes.filter((row) => row.distanceKm !== null);
    const km = known.reduce((sum, row) => sum + (row.distanceKm ?? 0), 0);
    const day = travel + work + idle;

    const series = (pick: (group: typeof routes) => number) =>
      groupSeries(scope, routes, (row) => row.run.id, pick);

    /* Ступени по числу визитов: маршрут из двух точек и маршрут из десяти —
       разная работа, и средняя между ними не описывает ни ту, ни другую. */
    const tiers = [
      { key: 'thin', label: 'До 3 визитов', has: (n: number) => n <= 3, tone: 'warn' as const },
      { key: 'even', label: '4–7 визитов', has: (n: number) => n >= 4 && n <= 7, tone: 'ok' as const },
      { key: 'thick', label: '8 и больше', has: (n: number) => n >= 8, tone: 'neutral' as const }
    ];

    return [
      {
        key: 'routes',
        title: 'Маршрутов',
        note: 'Сколько дней инженеров сложили расчёты срока',
        shape: 'number',
        data: {
          value: String(routes.length),
          caption: 'маршрутов за срок',
          facts: [
            scope.runs.length > 0 ? `${dec(routes.length / scope.runs.length)} на расчёт` : ''
          ].filter(Boolean),
          series: series((group) => group.length),
          legend: 'маршрутов'
        }
      },
      {
        key: 'visits',
        title: 'Визитов в маршруте',
        note: 'Сколько объектов проходит один маршрут и как это разложено',
        shape: 'donut',
        data: {
          value: routes.length === 0 ? '—' : dec(visits / routes.length),
          caption: 'визитов на маршрут',
          whole: true,
          parts: tiers.map((tier) => ({
            key: tier.key,
            label: tier.label,
            value: routes.filter((row) => tier.has(row.visits)).length,
            tone: tier.tone
          })),
          legend: 'маршрутов'
        }
      },
      {
        key: 'day',
        title: 'Из чего состоит день',
        note: 'Работа у клиента, дорога и ожидание окна — тремя долями',
        shape: 'donut',
        data: {
          value: hoursText(day),
          caption: 'смены в маршрутах',
          whole: true,
          parts: [
            {
              key: 'work',
              label: 'На объектах',
              value: Math.round(work / 60),
              tone: 'ok',
              text: hoursText(work)
            },
            {
              key: 'travel',
              label: 'В дороге',
              value: Math.round(travel / 60),
              tone: 'warn',
              text: hoursText(travel)
            },
            {
              key: 'idle',
              label: 'Ожидание окна',
              value: Math.round(idle / 60),
              tone: 'bad',
              text: hoursText(idle)
            }
          ],
          legend: 'часов смены'
        }
      },
      {
        key: 'travel-share',
        title: 'Доля дороги',
        note: 'Сколько маршрута уходит на переезды, а не на работу',
        shape: 'line',
        data: {
          value: percent(travel + work === 0 ? 0 : travel / (travel + work)),
          caption: 'от времени за рулём и на объектах',
          tone:
            travel + work === 0
              ? 'neutral'
              : travel / (travel + work) <= 0.2
                ? 'ok'
                : travel / (travel + work) <= 0.3
                  ? 'warn'
                  : 'bad',
          series: series((group) => {
            const t = group.reduce((sum, row) => sum + row.travelMinutes, 0);
            const w = group.reduce((sum, row) => sum + row.workMinutes, 0);
            return t + w === 0 ? 0 : Math.round((t / (t + w)) * 100);
          }),
          legend: '% дороги'
        }
      },
      {
        key: 'occupancy',
        title: 'Загрузка маршрутов',
        note: 'Насколько плотно набит день по маршрутам срока',
        shape: 'line',
        data: {
          value: percent(occupancyMean(routes)),
          caption: 'в среднем по маршрутам',
          series: series((group) => Math.round(occupancyMean(group) * 100)),
          legend: '% загрузки'
        }
      },
      {
        key: 'idle',
        title: 'Ожидание окна',
        note: 'Сколько инженеры стоят у закрытой двери до начала окна',
        shape: 'number',
        data: {
          value: hoursText(idle),
          caption: 'в ожидании приёма',
          tone: day === 0 ? 'neutral' : idle / day > 0.12 ? 'bad' : 'ok',
          series: series((group) => Math.round(group.reduce((sum, row) => sum + row.idleMinutes, 0) / 60)),
          legend: 'часов ожидания'
        }
      },
      {
        key: 'overtime',
        title: 'Переработка маршрутов',
        note: 'Сколько маршруты выходят за границу смены',
        shape: 'number',
        data: {
          value: hoursText(overtime),
          caption: 'за границей смены',
          tone: overtime > 0 ? 'bad' : 'ok',
          whole: true,
          parts: [
            {
              key: 'in',
              label: 'В границах смены',
              value: routes.filter((row) => row.overtimeMinutes === 0).length,
              tone: 'ok'
            },
            {
              key: 'out',
              label: 'С переработкой',
              value: routes.filter((row) => row.overtimeMinutes > 0).length,
              tone: 'bad'
            }
          ],
          legend: 'маршрутов'
        }
      },
      {
        key: 'risky',
        title: 'Визиты у края окна',
        note: 'Сколько посещений стоят вплотную к концу окна приёма',
        shape: 'number',
        data: {
          value: String(risky),
          caption: `${percent(visits === 0 ? 0 : risky / visits)} всех визитов`,
          tone: risky > 0 ? 'warn' : 'ok',
          series: series((group) => group.reduce((sum, row) => sum + row.risky, 0)),
          legend: 'визитов у края'
        }
      },
      {
        key: 'km',
        title: 'Километраж',
        note: 'Сколько наезжают маршруты, если длину дал движок',
        shape: 'number',
        data: {
          value: known.length === 0 ? '—' : `${Math.round(km)} км`,
          caption: known.length === 0 ? 'движок не дал длину' : `по ${known.length} маршрутам`,
          facts: known.length > 0 ? [`${dec(km / known.length)} км на маршрут`] : [],
          series: series((group) =>
            Math.round(group.reduce((sum, row) => sum + (row.distanceKm ?? 0), 0))
          ),
          legend: 'километров'
        }
      },
      {
        key: 'districts',
        title: 'Районы в маршрутах',
        note: 'По скольким районам ездит один маршрут',
        shape: 'bars',
        data: {
          value:
            routes.length === 0
              ? '—'
              : dec(routes.reduce((sum, row) => sum + row.districts.length, 0) / routes.length),
          caption: 'районов на маршрут',
          whole: true,
          parts: topWithRest(
            countBy(
              routes.flatMap((row) => row.districts.map((district) => ({ district }))),
              (row) => row.district
            ).map((row) => ({ key: row.key, label: row.key, value: row.count })),
            6
          ),
          legend: 'маршрутов'
        }
      }
    ];
  }, [routes, scope]);

  const board = useWidgetBoard({
    storeKey: 'stats-routes',
    catalogue: widgets,
    fallback: ['routes', 'visits', 'day', 'travel-share', 'occupancy', 'overtime'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Маршруты',
    fixed: true
  });

  const byDistrict = useMemo(
    () =>
      tallyToDistribution(
        countBy(
          routes.flatMap((row) => row.districts.map((district) => ({ district }))),
          (row) => row.district
        ),
        (key) => key
      ),
    [routes]
  );

  const wheeled = useMemo(() => [...routes].sort((a, b) => b.travelMinutes - a.travelMinutes), [routes]);
  const waiting = useMemo(
    () => routes.filter((row) => row.idleMinutes > 0).sort((a, b) => b.idleMinutes - a.idleMinutes),
    [routes]
  );

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead
          title="Что съедает смену"
          note="Маршруты, где на дорогу и на ожидание уходит больше всего"
        />
        <div className="statsgrid">
          <StatRank
            title="Дольше всех в дороге"
            note="часы за рулём"
            rows={wheeled.map((row) => ({
              key: row.key,
              label: `${row.code} · ${row.engineerName}`,
              note: `${row.run.code} · ${plural(row.visits, 'визит', 'визита', 'визитов')} · ${hoursText(
                row.workMinutes
              )} на объектах`,
              value: row.travelMinutes,
              text: hoursText(row.travelMinutes),
              bad: row.workMinutes > 0 && row.travelMinutes > row.workMinutes,
              onOpen: () => onOpenRun(row.run.id)
            }))}
          />
          <StatRank
            title="Больше всех ждут окна"
            note="часы ожидания"
            rows={waiting.map((row) => ({
              key: row.key,
              label: `${row.code} · ${row.engineerName}`,
              note: `${row.run.code} · ${plural(row.visits, 'визит', 'визита', 'визитов')}`,
              value: row.idleMinutes,
              text: hoursText(row.idleMinutes),
              bad: true,
              onOpen: () => onOpenRun(row.run.id)
            }))}
            empty="Ожидания нет: маршруты приезжают внутрь окна приёма."
          />
        </div>
      </section>

      <section className="panel">
        <StatsHead title="Куда ложатся маршруты" note="Районы, по которым расходятся дни инженеров" />
        <div className="statsgrid">
          <BarChart
            title="Маршруты по районам"
            distribution={byDistrict}
            unit={(n) => plural(n, 'маршрут', 'маршрута', 'маршрутов')}
          />
          <StatRank
            title="Самые полные маршруты"
            note="визитов в маршруте"
            rows={[...routes]
              .sort((a, b) => b.visits - a.visits)
              .map((row) => ({
                key: row.key,
                label: `${row.code} · ${row.engineerName}`,
                note: `${row.run.code} · загрузка ${percent(row.occupancy)} · ${row.districts.length} р-н`,
                value: row.visits,
                text: String(row.visits),
                onOpen: () => onOpenRun(row.run.id)
              }))}
          />
        </div>
      </section>
    </>
  );
}
