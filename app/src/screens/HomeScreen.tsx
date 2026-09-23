import { useMemo } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import { buildLiveRoster, cutMinutes, dec, hhmm, replanAt } from '../data/derive.ts';
import type { RunId, DaySummary } from '../data/load.ts';
import { runCode } from '../data/load.ts';
import type { SectionId } from '../app/nav.ts';

interface Props {
  day: Day;
  /** План, который сейчас на экране: с несохранённым пересчётом — его план
      остатка дня, а не тот, что в архиве. `view` собран из него же, и числа
      на плитках обязаны браться из одного плана с ним. */
  plan: Day['plan'];
  view: DayView;
  runs: DaySummary[] | null;
  activeRun: RunId;
  onGoSection: (id: SectionId) => void;
  onOpenRun: (id: RunId) => void;
  /** Завести первый расчёт — когда истории ещё нет. */
  onCreate: () => void;
}

const percent = (share: number) => `${Math.round(share)}%`;

/* Точка входа в сервис. Остальные разделы отвечают на свой узкий вопрос —
   этот отвечает сразу на три самых частых: какой план сейчас открыт, что
   происходит по нему прямо сейчас, и что считали до этого. Своих данных
   почти не заводит — читает то же, что и остальные экраны, только собирает
   в одном месте. */
export function HomeScreen({ day, plan, view, runs, activeRun, onGoSection, onOpenRun, onCreate }: Props) {
  const roster = useMemo(() => buildLiveRoster(view, cutMinutes()), [view]);
  const liveCounts = useMemo(() => {
    const working = roster.filter((r) => r.status === 'working').length;
    const enroute = roster.filter((r) => r.status === 'enroute').length;
    const overdue = roster.filter((r) => r.status === 'overdue').length;
    return { working, enroute, overdue };
  }, [roster]);

  const restFrom = replanAt(plan);
  const assignedShare =
    plan.meta.orders_total > 0 ? (plan.meta.orders_assigned / plan.meta.orders_total) * 100 : 0;
  const recent = useMemo(() => (runs ?? []).slice(-3).reverse(), [runs]);

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Открытый расчёт</h2>
          <Badge tone="accent" dot>
            {runCode(activeRun)}
          </Badge>
        </div>

        {/* Пересчёт — план остатка дня. Прогноз у него от плана дня: своего
            нет, и «покрытие» из него рядом с заявками остатка читалось бы
            итогом дня, которого на экране нет. Поэтому у пересчёта первая
            плитка — его собственная доля разложенного, с моментом, от
            которого он считан; остальные — из того же плана. */}
        <div className="dbstats">
          <div className="dbstat">
            {restFrom !== null ? (
              <>
                <span className="dbstat__value">{percent(assignedShare)}</span>
                <span className="dbstat__label">Назначено в остатке дня с {hhmm(restFrom)}</span>
              </>
            ) : (
              <>
                <span className="dbstat__value">{percent(day.simulation.coverage)}</span>
                {/* Прогноза могло и не быть: тогда это доля назначенных, а не
                    доля тех, кто доедет, и называть её надо по-другому. */}
                <span className="dbstat__label">
                  {day.simulation.meta.runs > 0 ? 'Прогноз выполнения' : 'Назначено, %'}
                </span>
              </>
            )}
          </div>
          <div className="dbstat">
            <span className="dbstat__value">
              {plan.meta.orders_assigned} из {plan.meta.orders_total}
            </span>
            <span className="dbstat__label">Заявок назначено</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{view.unassigned.length}</span>
            <span className="dbstat__label">Без инженера</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{plan.meta.engineers_total}</span>
            <span className="dbstat__label">Инженеров в штате</span>
          </div>
        </div>

        <div className="home__actions">
          <button type="button" className="runcard__go" onClick={() => onGoSection('dispatch')}>
            <Icon name="gauge" size={13} />
            Открыть диспетчерскую
          </button>
          <button type="button" className="runcard__act" onClick={() => onGoSection('monitor')}>
            <Icon name="navigation-arrow" size={13} />
            Открыть мониторинг
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Прямо сейчас</h2>
          <button type="button" className="dash__section-link" onClick={() => onGoSection('monitor')}>
            Весь мониторинг
            <Icon name="arrow-right" size={12} />
          </button>
        </div>
        <div className="homelive">
          <span className="homelive__item">
            <b className="homelive__value">{liveCounts.working}</b>
            <span>На объекте</span>
          </span>
          <span className="homelive__item">
            <b className="homelive__value">{liveCounts.enroute}</b>
            <span>В пути</span>
          </span>
          <span className="homelive__item homelive__item--danger">
            <b className="homelive__value">{liveCounts.overdue}</b>
            <span>Опаздывают</span>
          </span>
        </div>
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Последние расчёты</h2>
          <button type="button" className="dash__section-link" onClick={() => onGoSection('db-runs')}>
            Все расчёты
            <Icon name="arrow-right" size={12} />
          </button>
        </div>
        {!runs ? (
          <p className="stub__body">Собираем расчёты…</p>
        ) : recent.length === 0 ? (
          /* Пустая история — словами и кнопкой, а не пустым местом: пустой
             ряд плиток читается как «не загрузилось». */
          <div className="emptynote">
            <p className="emptynote__title">Расчётов пока нет</p>
            <span>Первый расчёт заводится в диспетчерской: выберите зону и запустите счёт.</span>
            <button type="button" className="runcard__go" onClick={onCreate}>
              <Icon name="shuffle" size={13} />
              Создать расчёт
            </button>
          </div>
        ) : (
          <div className="homeruns">
            {recent.map((run) => {
              const isActive = run.id === activeRun;
              return (
                <button
                  key={run.id}
                  type="button"
                  className={'homerun' + (isActive ? ' homerun--active' : '')}
                  onClick={() => onOpenRun(run.id)}
                >
                  <span className="homerun__top">
                    <span className="homerun__code">{runCode(run.id)}</span>
                    {isActive && (
                      <Badge tone="accent" dot>
                        открыт
                      </Badge>
                    )}
                  </span>
                  <span className="homerun__value">
                    {dec(run.coverage)}
                    <span className="runcard__unit">%</span>
                  </span>
                  <span className="homerun__label">Прогноз</span>
                  <span className="homerun__fact">
                    {run.ordersAssigned} из {run.ordersTotal} · без инженера {run.unassigned}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Базы данных</h2>
        </div>
        <div className="tiles">
          <button type="button" className="ctile" onClick={() => onGoSection('db-orders')}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="clipboard-list" size={15} />
              </span>
              <span className="ctile__label">Заявки</span>
            </span>
          </button>
          <button type="button" className="ctile" onClick={() => onGoSection('db-engineers')}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="users" size={15} />
              </span>
              <span className="ctile__label">Инженеры</span>
            </span>
          </button>
          <button type="button" className="ctile" onClick={() => onGoSection('db-clients')}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="user" size={15} />
              </span>
              <span className="ctile__label">Клиенты</span>
            </span>
          </button>
          <button type="button" className="ctile" onClick={() => onGoSection('db-routes')}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="path" size={15} />
              </span>
              <span className="ctile__label">Маршруты</span>
            </span>
          </button>
        </div>
      </section>
    </div>
  );
}
