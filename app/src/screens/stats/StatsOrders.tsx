import { useMemo } from 'react';
import { hoursText, plural } from '../../data/derive.ts';
import type { StatusSplit } from '../../data/derive.ts';
import { isUrgent, reasonName, skillName, workTypeName } from '../../data/dictionary.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { topWithRest, useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { BarChart } from '../../app/BarChart.tsx';
import { Donut } from '../../app/Donut.tsx';
import { countBy, percent, StatRank, StatsHead, tallyToDistribution } from './parts.tsx';
import { groupSeries } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Статистика по заявкам.

   Разрез отвечает на «что за работа к нам приходит и что с ней стало»: сколько
   заявок, из чего они состоят, сколько срочных, сколько требуют доступа — и
   главное, сколько осталось без инженера и почему.

   Считается по заявкам-номерам, а не по строкам «заявка в расчёте»: участок,
   пересчитанный трижды, — это одна авария, а не три. Ровно то же правило
   держит база заявок, и число в её шапке обязано сходиться с числом здесь.

   Причины, по которым заявка не разложилась, — то, чего нет ни на одной
   диаграмме: движок называет их словами, и перечень этих слов отвечает на
   «что менять», а не «сколько потеряли». */

export function StatsOrders({ registry, scope, period, onPeriod, countOf }: DimProps) {
  const rows = scope.orders;

  const widgets = useMemo<WidgetDef[]>(() => {
    const assigned = rows.filter((row) => row.engineerId).length;
    const loose = rows.length - assigned;
    const urgent = rows.filter((row) => isUrgent(row.priorityClass, row.priority)).length;
    const access = rows.filter((row) => row.needsAccess).length;
    const minutes = rows.reduce((sum, row) => sum + row.estMinutes, 0);
    const routed = rows.filter((row) => row.routeCode).length;

    /* Ряд по расчётам считаем по строкам «заявка в расчёте»: линия отвечает
       на «как менялось от расчёта к расчёту», и у каждого расчёта своя
       нагрузка. Уникальные номера такой ряд построить не дают — заявка в нём
       лежит один раз, в самом свежем расчёте. */
    const series = (pick: (group: typeof scope.orderRows) => number) =>
      groupSeries(scope, scope.orderRows, (row) => row.run.id, pick);

    const types = countBy(rows, (row) => row.workType);
    const districts = countBy(rows, (row) => row.district);

    return [
      {
        key: 'orders',
        title: 'Заявок в хозяйстве',
        note: 'Сколько заявок прошло через расчёты срока и что с ними стало',
        shape: 'number',
        data: {
          value: String(rows.length),
          caption: 'заявок за срок',
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          series: series((group) => group.length),
          legend: 'заявок'
        }
      },
      {
        key: 'assigned',
        title: 'Разложено по инженерам',
        note: 'Скольким заявкам расчёт нашёл исполнителя',
        shape: 'donut',
        data: {
          value: percent(rows.length === 0 ? 0 : assigned / rows.length),
          caption: `${assigned} из ${rows.length}`,
          tone: 'ok',
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'loose',
        title: 'Осталось без инженера',
        note: 'Хвост: заявки, которым инженера не нашлось ни в одном расчёте',
        shape: 'line',
        data: {
          value: String(loose),
          caption: 'ждут исполнителя',
          tone: loose > 0 ? 'bad' : 'ok',
          series: series((group) => group.filter((row) => !row.engineerId).length),
          legend: 'заявок без инженера'
        }
      },
      {
        key: 'urgent',
        title: 'Срочные',
        note: 'Аварии и заявки с высоким уровнем — и как с ними справились',
        shape: 'number',
        data: {
          value: String(urgent),
          caption: `${percent(rows.length === 0 ? 0 : urgent / rows.length)} от всех заявок`,
          tone: 'warn',
          whole: true,
          parts: [
            {
              key: 'done',
              label: 'Срочные с инженером',
              value: rows.filter((row) => isUrgent(row.priorityClass, row.priority) && row.engineerId).length,
              tone: 'ok'
            },
            {
              key: 'left',
              label: 'Срочные без инженера',
              value: rows.filter((row) => isUrgent(row.priorityClass, row.priority) && !row.engineerId).length,
              tone: 'bad'
            }
          ],
          series: series((group) => group.filter((row) => isUrgent(row.priorityClass, row.priority)).length),
          legend: 'срочных'
        }
      },
      {
        key: 'access',
        title: 'Нужен доступ',
        note: 'Заявки, куда без сопровождения не попасть',
        shape: 'number',
        data: {
          value: String(access),
          caption: `${percent(rows.length === 0 ? 0 : access / rows.length)} от всех заявок`,
          series: series((group) => group.filter((row) => row.needsAccess).length),
          legend: 'заявок с доступом'
        }
      },
      {
        key: 'work-ahead',
        title: 'Работы впереди',
        note: 'Сколько часов стоит в заявках по нормативам услуг',
        shape: 'number',
        data: {
          value: hoursText(minutes),
          caption: 'работы у клиентов',
          facts: [rows.length > 0 ? `${Math.round(minutes / rows.length)} мин на заявку в среднем` : ''].filter(
            Boolean
          ),
          series: series((group) => Math.round(group.reduce((sum, row) => sum + row.estMinutes, 0) / 60)),
          legend: 'часов работы'
        }
      },
      {
        key: 'types',
        title: 'Виды работ',
        note: 'Из каких работ складывается поток заявок',
        shape: 'donut',
        data: {
          value: String(types.length),
          caption: 'видов работ в потоке',
          whole: true,
          parts: topWithRest(
            types.map((row) => ({
              key: row.key,
              label: workTypeName(row.key, registry.workTypeTitle[row.key]),
              value: row.count
            })),
            6
          ),
          legend: 'заявок'
        }
      },
      {
        key: 'districts',
        title: 'Районы',
        note: 'Где эти заявки стоят на карте города',
        shape: 'bars',
        data: {
          value: String(districts.length),
          caption: 'районов задействовано',
          whole: true,
          parts: topWithRest(
            districts.map((row) => ({ key: row.key, label: row.key, value: row.count })),
            6
          ),
          legend: 'заявок'
        }
      },
      {
        key: 'routed',
        title: 'Попали в маршрут',
        note: 'У скольких заявок есть место и время в чьём-то маршруте',
        shape: 'number',
        data: {
          value: String(routed),
          caption: `${percent(rows.length === 0 ? 0 : routed / rows.length)} от всех заявок`,
          whole: true,
          parts: [
            { key: 'routed', label: 'В маршруте', value: routed, tone: 'ok' },
            { key: 'out', label: 'Вне маршрутов', value: rows.length - routed, tone: 'bad' }
          ],
          legend: 'заявок'
        }
      }
    ];
  }, [registry.workTypeTitle, rows, scope]);

  const board = useWidgetBoard({
    storeKey: 'stats-orders',
    catalogue: widgets,
    fallback: ['orders', 'assigned', 'loose', 'urgent', 'access', 'work-ahead'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Заявки',
    fixed: true
  });

  const assigned = rows.filter((row) => row.engineerId).length;

  const split: StatusSplit[] = [
    { key: 'assigned', label: 'Разложены по инженерам', count: assigned, ids: [], tone: 'ok' },
    { key: 'loose', label: 'Без инженера', count: rows.length - assigned, ids: [], tone: 'bad' }
  ];

  const byWorkType = useMemo(
    () =>
      tallyToDistribution(countBy(rows, (row) => row.workType), (key) =>
        workTypeName(key, registry.workTypeTitle[key])
      ),
    [rows, registry.workTypeTitle]
  );
  const bySkill = useMemo(
    () => tallyToDistribution(countBy(rows, (row) => row.skill), skillName),
    [rows]
  );

  /* Почему заявка осталась без инженера — словами движка. Одинаковые причины
     складываем в одну строку: «нет навыка» двадцать раз подряд не перечень, а
     одна причина весом двадцать. */
  const reasons = useMemo(() => {
    const loose = rows.filter((row) => !row.engineerId);
    const named = countBy(loose, (row) => row.unassignedWhy);
    const silent = loose.length - named.reduce((sum, row) => sum + row.count, 0);
    return silent > 0 ? [...named, { key: '', count: silent }] : named;
  }, [rows]);

  /* Где остаётся хвост. Район важнее номера: одна заявка без инженера — случай,
     а восемь из одного района — повод посмотреть, кто там работает. */
  const looseByDistrict = useMemo(
    () => countBy(rows.filter((row) => !row.engineerId), (row) => row.district),
    [rows]
  );

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead title="Из чего складывается поток" note="По заявкам срока, каждая считана один раз" />
        <div className="statsgrid">
          <Donut
            title="Что стало с заявками"
            slices={split}
            centerValue={rows.length}
            centerCaption="заявок"
          />
          <BarChart
            title="Заявки по видам работ"
            distribution={byWorkType}
            unit={(n) => plural(n, 'заявка', 'заявки', 'заявок')}
          />
          <BarChart
            title="Заявки по нужному навыку"
            distribution={bySkill}
            unit={(n) => plural(n, 'заявка', 'заявки', 'заявок')}
          />
        </div>
      </section>

      <section className="panel">
        <StatsHead
          title="Где остаётся хвост"
          note="Причины, которые назвал движок, и районы, где хвост копится"
        />
        <div className="statsgrid">
          <StatRank
            title="Почему не разложилось"
            note="заявок по причине"
            rows={reasons.map((row) => ({
              key: row.key || 'silent',
              label: row.key ? reasonName(row.key) : 'Причина не названа',
              value: row.count,
              text: String(row.count),
              bad: true
            }))}
            empty="Хвоста нет: все заявки срока получили инженера."
          />
          <StatRank
            title="Районы с хвостом"
            note="заявок без инженера"
            rows={looseByDistrict.map((row) => ({
              key: row.key,
              label: row.key,
              value: row.count,
              text: String(row.count),
              bad: true
            }))}
            empty="Хвоста нет ни в одном районе."
          />
        </div>
      </section>
    </>
  );
}
