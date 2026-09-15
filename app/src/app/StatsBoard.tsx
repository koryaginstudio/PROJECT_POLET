import { Icon } from '../ds/components/core/Icon.jsx';
import type { Registry, Tally } from '../data/registry.ts';
import { hoursText, plural } from '../data/derive.ts';
import { skillIcon, skillName, workTypeIcon } from '../data/dictionary.ts';

interface Props {
  registry: Registry | null;
  /** Вкладка подшапки: разбивка по расчётам или разрезы по справочникам. */
  mode: string;
  /** Открытый прогон подсвечивается в разбивке: это точка отсчёта. */
  active: string;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

function Bars({
  title,
  rows,
  icon,
  label,
  unit
}: {
  title: string;
  rows: Tally[];
  icon: (key: string) => string;
  label: (key: string) => string;
  unit: (n: number) => string;
}) {
  const max = Math.max(...rows.map((row) => row.count), 1);
  return (
    <div className="statbars">
      <div className="statbars__title">{title}</div>
      {rows.map((row) => (
        <div key={row.key} className="statbar">
          <span className="statbar__label">
            <Icon name={icon(row.key)} size={13} />
            {label(row.key)}
          </span>
          <span className="statbar__track">
            <span className="statbar__fill" style={{ width: `${(row.count / max) * 100}%` }} />
          </span>
          <span className="statbar__value">{unit(row.count)}</span>
        </div>
      ))}
    </div>
  );
}

/* Статистика по всем расчётам сразу. Стоит вкладкой рядом со сводкой, потому
   что вопрос тот же — «как мы отработали», — только не про один прогон, а про
   все: сводка отвечает за открытый расчёт, статистика ставит его в ряд с
   остальными. */
export function StatsBoard({ registry, mode, active }: Props) {
  if (!registry) {
    return (
      <section className="panel">
        <p className="stub__body">Собираем статистику по всем расчётам…</p>
      </section>
    );
  }

  const { stats, routes, engineers, clients } = registry;
  /* Покрытие усредняем по прогонам, а не считаем от суммы заявок: сравниваем
     расчёты между собой, и каждый весит одинаково. */
  const coverage =
    stats.byRun.reduce((sum, row) => sum + row.coverage, 0) / (stats.byRun.length || 1);
  const occupancy =
    routes.reduce((sum, route) => sum + route.occupancy, 0) / (routes.length || 1);
  const travel = routes.reduce((sum, route) => sum + route.travelMinutes, 0);
  const best = [...stats.byRun].sort((a, b) => b.coverage - a.coverage)[0];
  const worst = [...stats.byRun].sort((a, b) => a.coverage - b.coverage)[0];
  const maxCoverage = Math.max(...stats.byRun.map((row) => row.coverage), 0.01);

  return (
    <>
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Статистика</h2>
          <span className="dbhead__badge">
            <Icon name="layers" size={13} />
            Все расчёты
          </span>
        </div>

        <p className="clients__lede">
          Сводка отвечает за открытый расчёт, статистика ставит его в ряд с остальными: те же
          заявки и инженеры, но результат по всем прогонам сразу.
          {best && worst && best.run.id !== worst.run.id && (
            <>
              {' '}Лучше всех разложил {best.run.code} — {percent(best.coverage)}, хуже всех{' '}
              {worst.run.code} — {percent(worst.coverage)}.
            </>
          )}
        </p>

        <div className="dbstats">
          <div className="dbstat">
            <span className="dbstat__value">{stats.byRun.length}</span>
            <span className="dbstat__label">Расчётов</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{percent(coverage)}</span>
            <span className="dbstat__label">Среднее покрытие</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{stats.orders}</span>
            <span className="dbstat__label">Заявок обработано</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{percent(occupancy)}</span>
            <span className="dbstat__label">Средняя занятость</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{hoursText(travel)}</span>
            <span className="dbstat__label">Всего в дороге</span>
          </div>
        </div>
      </section>

      {mode !== 'cuts' && (
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Покрытие по расчётам</h2>
          <span className="dash__section-note">
            {clients.length} точек обслуживания · {engineers.length} инженеров
          </span>
        </div>

        <div className="statruns">
          {stats.byRun.map((row) => (
            <div
              key={row.run.id}
              className={'statrun' + (row.run.id === active ? ' statrun--active' : '')}
            >
              <span className="statrun__code">
                {row.run.code}
                {row.run.id === active && <span className="statrun__mark">Открыт</span>}
              </span>
              <span className="statbar__track">
                <span
                  className="statbar__fill"
                  style={{ width: `${(row.coverage / maxCoverage) * 100}%` }}
                />
              </span>
              <span className="statrun__value">{percent(row.coverage)}</span>
              <span className="statrun__facts">
                разложено {row.assigned} из {row.orders} ({percent(row.assignedShare)}) ·{' '}
                {row.routes} маршрутов ·{' '}
                {row.engineersOnRoute} из {row.engineersTotal} инженеров · {hoursText(row.travelMinutes)}{' '}
                в дороге
              </span>
            </div>
          ))}
        </div>
      </section>
      )}

      {mode !== 'runs' && (
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Разрезы</h2>
        </div>
        <div className="statgrid">
          <Bars
            title="Заявки по видам работ"
            rows={stats.byWorkType}
            icon={workTypeIcon}
            label={(key) => registry.workTypeTitle[key] ?? key}
            unit={(n) => plural(n, 'заявка', 'заявки', 'заявок')}
          />
          <Bars
            title="Инженеры по навыкам"
            rows={stats.bySkill}
            icon={skillIcon}
            label={skillName}
            unit={(n) => plural(n, 'инженер', 'инженера', 'инженеров')}
          />
        </div>
      </section>
      )}
    </>
  );
}
