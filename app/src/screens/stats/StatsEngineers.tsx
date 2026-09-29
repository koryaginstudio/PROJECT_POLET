import { useMemo } from 'react';
import { dec, hoursText, plural } from '../../data/derive.ts';
import { skillName } from '../../data/dictionary.ts';
import { service } from '../../data/service.ts';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { topWithRest, useWidgetBoard, WidgetPeriod } from '../../app/DbWidgets.tsx';
import { BarChart } from '../../app/BarChart.tsx';
import { percent, StatRank, StatsHead, tallyToDistribution } from './parts.tsx';
import { crewOf, crewTally } from './scope.ts';
import type { DimProps } from './dims.ts';

/* Статистика по инженерам.

   Разрез отвечает на «как занят штат». Средняя загрузка отвечает на этот
   вопрос наполовину: смена под завязку и смена вполпустого дают ту же
   среднюю, что две ровные. Поэтому рядом со средней стоит раскладка по
   ступеням — сколько людей выше порога, сколько в норме, сколько недогружены,
   — и перечни с обоих концов: кто идёт на пределе и кто простаивает.

   Порог загрузки берётся из настроек сервиса, а не пишется здесь числом: это
   та же граница, по которой пульт красит цифру, и второе её значение
   означало бы, что один и тот же инженер «перегружен» на одном экране и «в
   норме» на соседнем.

   Загрузка считается по сменам с маршрутом. День, в котором инженера не
   поставили ни на один маршрут, — это не нулевая загрузка, а отсутствие
   работы, и в среднее он тянул бы вниз тех, кто работал. Сколько таких
   дней, сказано отдельно — «простои». */

export function StatsEngineers({ registry, scope, period, onPeriod, countOf }: DimProps) {
  const tally = useMemo(() => crewTally(registry, scope), [registry, scope]);
  /* Штат — людьми: тем же счётом, каким его называет база инженеров. */
  const staff = useMemo(() => crewOf(registry).length, [registry]);
  const bar = service().thresholds.occupancy / 100;

  const widgets = useMemo<WidgetDef[]>(() => {
    const working = tally.filter((row) => row.routed > 0);
    const visits = tally.reduce((sum, row) => sum + row.visits, 0);
    const travel = tally.reduce((sum, row) => sum + row.travelMinutes, 0);
    const work = tally.reduce((sum, row) => sum + row.workMinutes, 0);
    const overtime = tally.reduce((sum, row) => sum + row.overtimeMinutes, 0);
    const idle = tally.reduce((sum, row) => sum + row.idle, 0);
    const occupancy =
      working.length === 0 ? 0 : working.reduce((sum, row) => sum + row.occupancy, 0) / working.length;
    const km = tally.reduce((sum, row) => sum + (row.distanceKm ?? 0), 0);

    /* Ступени загрузки: выше порога — смена стоит на пределе, и первая же
       пробка съедает запас; ниже двух третей порога — день недобран. */
    const tiers = [
      { key: 'tight', label: `Выше ${service().thresholds.occupancy} %`, tone: 'bad' as const },
      { key: 'even', label: 'В норме', tone: 'ok' as const },
      { key: 'loose', label: 'Недогружены', tone: 'warn' as const }
    ];
    const low = bar * 0.8;
    const counts = {
      tight: working.filter((row) => row.occupancy > bar).length,
      even: working.filter((row) => row.occupancy <= bar && row.occupancy >= low).length,
      loose: working.filter((row) => row.occupancy < low).length
    };

    return [
      {
        key: 'crew',
        title: 'Инженеров в расчётах',
        note: 'Сколько людей расчёты срока поставили в план и скольким дали маршрут',
        shape: 'number',
        data: {
          value: String(tally.length),
          caption: `из ${staff} в базе`,
          whole: true,
          parts: [
            { key: 'routed', label: 'С маршрутом', value: working.length, tone: 'ok' },
            { key: 'idle', label: 'Ни одного маршрута', value: tally.length - working.length, tone: 'bad' }
          ],
          legend: 'инженеров'
        }
      },
      {
        key: 'occupancy',
        title: 'Средняя загрузка',
        note: 'Насколько плотно занята смена у тех, кто вышел на маршрут',
        shape: 'number',
        data: {
          value: percent(occupancy),
          caption: 'по сменам с маршрутом',
          tone: occupancy > bar ? 'bad' : occupancy >= bar * 0.8 ? 'ok' : 'warn',
          whole: true,
          parts: tiers.map((tier) => ({
            key: tier.key,
            label: tier.label,
            value: counts[tier.key as keyof typeof counts],
            tone: tier.tone
          })),
          legend: 'инженеров'
        }
      },
      {
        key: 'tiers',
        title: 'Загрузка по ступеням',
        note: 'Сколько людей на пределе, сколько в норме, сколько недобрали',
        shape: 'donut',
        data: {
          value: String(counts.tight),
          caption: `выше порога ${service().thresholds.occupancy} %`,
          tone: counts.tight > 0 ? 'bad' : 'ok',
          whole: true,
          parts: tiers.map((tier) => ({
            key: tier.key,
            label: tier.label,
            value: counts[tier.key as keyof typeof counts],
            tone: tier.tone
          })),
          legend: 'инженеров'
        }
      },
      {
        key: 'idle',
        title: 'Простои',
        note: 'Сколько раз расчёт оставил инженера без маршрута',
        shape: 'number',
        data: {
          value: String(idle),
          caption: 'смен без маршрута',
          tone: idle > 0 ? 'warn' : 'ok',
          whole: true,
          parts: topWithRest(
            tally
              .filter((row) => row.idle > 0)
              .sort((a, b) => b.idle - a.idle)
              .map((row) => ({ key: row.record.id, label: row.record.name, value: row.idle })),
            6
          ),
          legend: 'смен без маршрута'
        }
      },
      {
        key: 'overtime',
        title: 'Переработки',
        note: 'Сколько времени маршруты выходят за границу смены',
        shape: 'number',
        data: {
          value: hoursText(overtime),
          caption: 'за границей смены',
          tone: overtime > 0 ? 'bad' : 'ok',
          whole: true,
          parts: topWithRest(
            tally
              .filter((row) => row.overtimeMinutes > 0)
              .sort((a, b) => b.overtimeMinutes - a.overtimeMinutes)
              .map((row) => ({
                key: row.record.id,
                label: row.record.name,
                value: row.overtimeMinutes,
                text: hoursText(row.overtimeMinutes)
              })),
            6
          ),
          legend: 'минут переработки'
        }
      },
      {
        key: 'visits',
        title: 'Визитов на инженера',
        note: 'Сколько объектов проходит один человек за смену',
        shape: 'number',
        data: {
          value: tally.length === 0 ? '—' : dec(visits / Math.max(1, tally.length)),
          caption: 'визитов за смену в среднем',
          facts: [`${visits} визитов всего`],
          whole: false,
          parts: topWithRest(
            [...tally]
              .sort((a, b) => b.visits - a.visits)
              .map((row) => ({ key: row.record.id, label: row.record.name, value: row.visits })),
            6
          ),
          legend: 'визитов'
        }
      },
      {
        key: 'wheel',
        title: 'Дорога и работа',
        note: 'Как смена делится между переездами и работой у клиента',
        shape: 'donut',
        data: {
          value: percent(work + travel === 0 ? 0 : travel / (work + travel)),
          caption: 'смены уходит на дорогу',
          tone: work + travel === 0 ? 'neutral' : travel / (work + travel) <= 0.2 ? 'ok' : 'warn',
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
            }
          ],
          legend: 'часов смены'
        }
      },
      {
        key: 'km',
        title: 'Километраж',
        note: 'Сколько наезжают за срок, если длину дал движок',
        shape: 'number',
        data: {
          value: km === 0 ? '—' : `${Math.round(km)} км`,
          caption: 'по маршрутам срока',
          whole: false,
          parts: topWithRest(
            [...tally]
              .filter((row) => row.distanceKm !== null)
              .sort((a, b) => (b.distanceKm ?? 0) - (a.distanceKm ?? 0))
              .map((row) => ({
                key: row.record.id,
                label: row.record.name,
                value: Math.round(row.distanceKm ?? 0)
              })),
            6
          ),
          legend: 'километров'
        }
      }
    ];
  }, [bar, staff, tally]);

  const board = useWidgetBoard({
    storeKey: 'stats-engineers',
    catalogue: widgets,
    fallback: ['crew', 'occupancy', 'tiers', 'idle', 'overtime', 'wheel'],
    filter: <WidgetPeriod value={period} onChange={onPeriod} countOf={countOf} />,
    title: 'Инженеры',
    fixed: true
  });

  /* Навыки штата считаем по инженерам среза, а не по всей базе: за неделю в
     план попадают не все, и перечень навыков «вообще» ответил бы на другой
     вопрос. Навыки пересекаются — один человек стоит в трёх строках, — и
     полосы про это говорят сами: сплошное — только этот навык, штриховка —
     совмещения. */
  const bySkill = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of tally) {
      for (const skill of row.record.skills) map.set(skill, (map.get(skill) ?? 0) + 1);
    }
    return tallyToDistribution(
      [...map.entries()].map(([key, count]) => ({ key, count })),
      skillName
    );
  }, [tally]);

  const tight = useMemo(
    () => tally.filter((row) => row.routed > 0).sort((a, b) => b.occupancy - a.occupancy),
    [tally]
  );
  const spare = useMemo(
    () => tally.filter((row) => row.routed > 0).sort((a, b) => a.occupancy - b.occupancy),
    [tally]
  );
  const idle = useMemo(() => tally.filter((row) => row.idle > 0).sort((a, b) => b.idle - a.idle), [tally]);

  return (
    <>
      {board.node}

      <section className="panel">
        <StatsHead
          title="Кто как занят"
          note={`Порог загрузки — ${service().thresholds.occupancy} %, он же стоит в настройках сервиса`}
        />
        <div className="statsgrid">
          <StatRank
            title="Идут на пределе"
            note="загрузка смены"
            rows={tight.map((row) => ({
              key: row.record.id,
              label: row.record.name,
              note: `${plural(row.visits, 'визит', 'визита', 'визитов')} · ${hoursText(row.travelMinutes)} в дороге${
                row.overtimeMinutes > 0 ? ` · ${hoursText(row.overtimeMinutes)} переработки` : ''
              }`,
              value: row.occupancy,
              text: percent(row.occupancy),
              bad: row.occupancy > bar
            }))}
          />
          <StatRank
            title="Есть запас"
            note="загрузка смены"
            rows={spare.map((row) => ({
              key: row.record.id,
              label: row.record.name,
              note: `${plural(row.visits, 'визит', 'визита', 'визитов')} · ${plural(
                row.shifts.length,
                'смена',
                'смены',
                'смен'
              )} в расчётах`,
              value: row.occupancy,
              text: percent(row.occupancy)
            }))}
          />
        </div>
      </section>

      <section className="panel">
        <StatsHead title="Простои и навыки" note="Кого расчёты не берут и чем штат умеет закрывать поток" />
        <div className="statsgrid">
          <StatRank
            title="Чаще всех без маршрута"
            note="смен без работы"
            rows={idle.map((row) => ({
              key: row.record.id,
              label: row.record.name,
              note: `${row.record.skills.map(skillName).join(', ') || 'навыки не указаны'}`,
              value: row.idle,
              text: `${row.idle} из ${row.shifts.length}`,
              bad: true
            }))}
            empty="Простоев нет: каждый инженер получил маршрут в каждом расчёте срока."
          />
          <BarChart
            title="Инженеры по навыкам"
            distribution={bySkill}
            unit={(n) => plural(n, 'инженер', 'инженера', 'инженеров')}
          />
        </div>
      </section>
    </>
  );
}
