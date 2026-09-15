import { useEffect, useMemo } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineerRecord, Registry } from '../data/registry.ts';
import { dec, hhmm, hoursText } from '../data/derive.ts';
import { skillIcon, skillName, teamName, transportIcon, transportName } from '../data/dictionary.ts';
import { transportWhy } from '../data/rationale.ts';
import { faceOf } from '../data/photos.ts';
import { PersonName } from './PersonName.tsx';
import { WhyMark } from './WhyMark.tsx';

interface Props {
  /** Чей профиль открыт. Пусто — профиля нет. */
  crew: EngineerRecord | null;
  registry: Registry;
  onClose: () => void;
  onEdit: () => void;
}

/* Профиль инженера: всё, что мы о нём знаем, на одном экране.

   Карточка в списке отвечает на «кто это и сколько отработал» — её читают
   бегло, десятками. Профиль отвечает на «расскажи про него»: постоянные
   данные, выработка, каждая смена по расчётам, каждый маршрут и каждая
   заявка, которую он вёз.

   Разделён по тому, что откуда берётся, и это не оформление. Сверху — то,
   что принадлежит человеку и не меняется от расчёта к расчёту: навыки,
   транспорт, участки. Ниже — то, что посчитано: смены, маршруты, заявки.
   Первое правят в карточке, второе не правят вовсе. */
export function CrewProfile({ crew, registry, onClose, onEdit }: Props) {
  useEffect(() => {
    if (!crew) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [crew, onClose]);

  const routes = useMemo(
    () => (crew ? registry.routes.filter((route) => route.engineerId === crew.id) : []),
    [crew, registry]
  );

  const orders = useMemo(
    () => (crew ? registry.orders.filter((order) => order.engineerId === crew.id) : []),
    [crew, registry]
  );

  /* Что он делал чаще всего: виды работ по числу заявок. Отвечает на вопрос,
     на котором список навыков останавливается, — навык говорит «умеет», а
     это говорит «делает». */
  const byWork = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of orders) map.set(order.workTitle, (map.get(order.workTitle) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [orders]);

  if (!crew) return null;

  const worked = crew.workMinutes + crew.travelMinutes;
  const shifts = [...crew.byRun].reverse();

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Профиль: ${crew.name}`}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card crewpro">
        <div className="crewpro__top">
          <img className="crewpro__face" src={faceOf(crew)} alt="" />
          <div className="crewpro__who">
            <span className="crewpro__eyebrow">
              Инженер · id: {crew.id}
              {crew.team ? ` · бригада ${teamName(crew.team)}` : ''}
            </span>
            <h2 className="crewpro__name">
              <PersonName name={crew.name} />
            </h2>
            {crew.phone && <span className="crewpro__phone">{crew.phone}</span>}
          </div>
          <div className="crewpro__actions">
            <Button variant="secondary" size="sm" onClick={onEdit} iconLeft={<Icon name="pencil" size={13} />}>
              Править
            </Button>
            <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        {/* Выработка. Первым — отработанные часы: это то, чем меряют человека,
            а не маршрут. */}
        <div className="crewpro__stats">
          <Stat value={dec(worked / 60)} unit="ч" label="отработано всего" />
          <Stat value={String(crew.visits)} label="визитов" />
          <Stat value={`${crew.routes} из ${crew.runs}`} label="смен с маршрутом" />
          <Stat value={`${dec(crew.occupancyMean * 100)} %`} label="средняя занятость" />
          <Stat value={hoursText(crew.travelMinutes)} label="в дороге" />
          <Stat
            value={crew.overtimeMinutes > 0 ? hoursText(crew.overtimeMinutes) : '—'}
            label="сверх смены"
            bad={crew.overtimeMinutes > 0}
          />
        </div>

        <div className="crewpro__cols">
          <section className="crewpro__block">
            <h3 className="crewpro__title">Навыки</h3>
            <div className="skillrow">
              {crew.skills.map((key) => (
                <span key={key} className="skillchip">
                  <Icon name={skillIcon(key)} size={13} />
                  {skillName(key)}
                </span>
              ))}
            </div>
            <p className="crewpro__note">
              Навык — это допуск: заявку он получит только по тому, чем владеет. Навыки
              вычитаны из нарядов, которые он вёл.
            </p>
          </section>

          <section className="crewpro__block">
            <h3 className="crewpro__title">
              Транспорт
              <WhyMark text={transportWhy(crew.transport)} />
            </h3>
            {crew.transport ? (
              <span className="crewpro__big">
                <Icon name={transportIcon(crew.transport)} size={16} />
                {transportName(crew.transport)}
              </span>
            ) : (
              <span className="crewpro__muted">не указан</span>
            )}
          </section>
        </div>

        <section className="crewpro__block">
          <h3 className="crewpro__title">
            Участки приписки
            <span className="crewpro__count">{crew.posts.length}</span>
          </h3>
          <div className="crewpro__posts">
            {crew.posts.map((post) => (
              <div className="crewpro__post" key={post.zone}>
                <span className="crewpro__post-zone">{post.zone}</span>
                <span className="crewpro__post-line">
                  Смена {hhmm(post.shiftStart)}–{hhmm(post.shiftEnd)}
                </span>
                {post.homeAddress && (
                  <span className="crewpro__post-line crewpro__muted">
                    Выезд: {post.homeAddress}
                  </span>
                )}
              </div>
            ))}
          </div>
        </section>

        {byWork.length > 0 && (
          <section className="crewpro__block">
            <h3 className="crewpro__title">Что делал чаще всего</h3>
            <div className="crewpro__works">
              {byWork.slice(0, 8).map(([title, count]) => (
                <span className="crewpro__work" key={title}>
                  <span className="crewpro__work-title">{title}</span>
                  <span className="crewpro__work-count">{count}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        <section className="crewpro__block">
          <h3 className="crewpro__title">
            Смены по расчётам
            <span className="crewpro__count">{shifts.length}</span>
          </h3>
          {shifts.length === 0 ? (
            <p className="crewpro__muted">Ни в одном расчёте он ещё не участвовал.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Расчёт</th>
                    <th>Визитов</th>
                    <th>В работе</th>
                    <th>В дороге</th>
                    <th>Занятость</th>
                    <th>Сверх смены</th>
                  </tr>
                </thead>
                <tbody>
                  {shifts.map((shift) => (
                    <tr className="tbl__row" key={shift.runId}>
                      <td>
                        <span className="tbl__strong">{shift.code}</span>
                      </td>
                      <td className="tbl__num">
                        {shift.routed ? shift.visits : <span className="tbl__muted">без маршрута</span>}
                      </td>
                      <td className="tbl__num">{hoursText(shift.workMinutes)}</td>
                      <td className="tbl__num">{hoursText(shift.travelMinutes)}</td>
                      <td className="tbl__num">{dec(shift.occupancy * 100)} %</td>
                      <td className="tbl__num">
                        {shift.overtimeMinutes > 0 ? (
                          <span className="tbl__warn">{hoursText(shift.overtimeMinutes)}</span>
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="crewpro__block">
          <h3 className="crewpro__title">
            Маршруты
            <span className="crewpro__count">{routes.length}</span>
          </h3>
          {routes.length === 0 ? (
            <p className="crewpro__muted">Маршрутов пока нет.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Маршрут</th>
                    <th>Расчёт</th>
                    <th>Визитов</th>
                    <th>Начало</th>
                    <th>Конец</th>
                    <th>Районы</th>
                    <th>Под угрозой</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => (
                    <tr className="tbl__row" key={route.key}>
                      <td>
                        <span className="tbl__strong">{route.code}</span>
                      </td>
                      <td>{route.run.code}</td>
                      <td className="tbl__num">{route.visits}</td>
                      <td className="tbl__num">{hhmm(route.start)}</td>
                      <td className="tbl__num">{hhmm(route.end)}</td>
                      <td>{route.districts.join(', ')}</td>
                      <td className="tbl__num">
                        {route.risky > 0 ? (
                          <span className="tbl__warn">{route.risky}</span>
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="crewpro__block">
          <h3 className="crewpro__title">
            Заявки
            <span className="crewpro__count">{orders.length}</span>
          </h3>
          {orders.length === 0 ? (
            <p className="crewpro__muted">Заявок за ним пока не числится.</p>
          ) : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Заявка</th>
                    <th>Что делаем</th>
                    <th>Адрес</th>
                    <th>Окно приёма</th>
                    <th>Работа</th>
                    <th>Расчёт</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr className="tbl__row" key={order.key}>
                      <td>
                        <span className="tbl__strong">{order.id}</span>
                      </td>
                      <td>{order.workTitle}</td>
                      <td>{order.address}</td>
                      <td className="tbl__num">
                        {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                      </td>
                      <td className="tbl__num">{order.estMinutes} мин</td>
                      <td>{order.run.code}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({
  value,
  unit,
  label,
  bad = false
}: {
  value: string;
  unit?: string;
  label: string;
  bad?: boolean;
}) {
  return (
    <div className={'crewpro__stat' + (bad ? ' crewpro__stat--bad' : '')}>
      <span className="crewpro__stat-value">
        {value}
        {unit && <span className="crewpro__stat-unit">{unit}</span>}
      </span>
      <span className="crewpro__stat-label">{label}</span>
    </div>
  );
}
