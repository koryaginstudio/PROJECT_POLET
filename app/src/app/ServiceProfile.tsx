import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry, ServiceRecord } from '../data/registry.ts';
import { dec, hhmm, plural } from '../data/derive.ts';
import { equipmentName, skillIcon, skillName, workTypeIcon } from '../data/dictionary.ts';

interface Props {
  /** Какая услуга открыта. Пусто — карточки нет. */
  service: ServiceRecord | null;
  registry: Registry;
  onClose: () => void;
  onOpenOrder: (order: OrderRecord) => void;
  onOpenRun: (runId: string) => void;
}

/* Карточка услуги: сколько её заказывают, кто её умеет и где она встаёт.

   Восемнадцать услуг покрываются тремя навыками, и путать одно с другим —
   самая частая ошибка разговора о справочнике. Карточка отвечает на этот
   вопрос прямо: навык стоит рядом с названием, а вкладка «Инженеры»
   показывает не тех, у кого навык записан в кадрах, а тех, кто эту работу
   действительно выполнял.

   Собрана теми же классами, что карточки заявки, клиента и инженера: четыре
   базы отвечают на один вопрос, и одно и то же место обязано значить одно и
   то же. */
type Tab = 'orders' | 'crew' | 'runs';

export function ServiceProfile({ service, registry, onClose, onOpenOrder, onOpenRun }: Props) {
  const [tab, setTab] = useState<Tab>('orders');

  useEffect(() => {
    if (service) setTab('orders');
  }, [service?.key]);

  useEffect(() => {
    if (!service) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [service, onClose]);

  /* Заявки этой услуги. Ключ услуги — код вида работ, он же стоит у заявки:
     связь прямая, без сверки названий. */
  const orders = useMemo(() => {
    if (!service) return [];
    return registry.orders
      .filter((order) => order.workType === service.key)
      .sort((a, b) => a.run.code.localeCompare(b.run.code, 'ru') || a.windowStart - b.windowStart);
  }, [service?.key, registry]);

  /* Кто эту работу выполнял — по факту плана, а не по записи в кадрах. */
  const crew = useMemo(() => {
    const map = new Map<string, { key: string; id: string; name: string; visits: number; minutes: number }>();
    for (const order of orders) {
      if (!order.engineerId || !order.engineerName) continue;
      /* Ключом справочника, а не номером плана: у движка E00 есть на каждом
         участке, и это разные люди. */
      const who = order.engineerKey ?? order.engineerId;
      const cell = map.get(who) ?? {
        key: who,
        id: order.engineerId,
        name: order.engineerName,
        visits: 0,
        minutes: 0
      };
      cell.visits += 1;
      cell.minutes += order.estMinutes;
      map.set(who, cell);
    }
    return [...map.values()].sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name, 'ru'));
  }, [orders]);

  const byRun = useMemo(() => {
    const map = new Map<string, { code: string; id: string; date: string; total: number; done: number }>();
    for (const order of orders) {
      const cell = map.get(order.run.id) ?? {
        code: order.run.code,
        id: order.run.id,
        date: order.run.date,
        total: 0,
        done: 0
      };
      cell.total += 1;
      if (order.engineerId) cell.done += 1;
      map.set(order.run.id, cell);
    }
    return [...map.values()].sort((a, b) => a.code.localeCompare(b.code, 'ru'));
  }, [orders]);

  if (!service) return null;

  const rate = service.orders === 0 ? 0 : service.assigned / service.orders;
  const missed = service.orders - service.assigned;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={service.title}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card crewpro">
        <div className="crewpro__hero ordpro__hero">
          <div className="crewpro__hero-body">
            <div className="crewpro__top">
              <div className="crewpro__who">
                <div className="crewpro__idrow">
                  <span className="crewpro__id">{service.key}</span>
                  <span className="crewpro__role">Вид работ · {skillName(service.skill)}</span>
                  {missed > 0 && (
                    <span className="pill pill--danger">
                      {plural(missed, 'заявка', 'заявки', 'заявок')} без инженера
                    </span>
                  )}
                </div>
                <h2 className="crewpro__name ordpro__name">
                  <Icon name={workTypeIcon(service.key)} size={20} />
                  {service.title}
                </h2>
              </div>
              <div className="crewpro__actions">
                <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
                  <Icon name="x" size={16} />
                </button>
              </div>
            </div>

            <span className="crewpro__transport">
              <span className="crewpro__transport-label">Навык</span>
              <Icon name={skillIcon(service.skill)} size={15} />
              {skillName(service.skill)}
              <span className="crewpro__muted">
                · умеют {registry.engineers.filter((one) => one.skills.includes(service.skill)).length}{' '}
                из {registry.engineers.length}
              </span>
            </span>

            <div className="crewpro__stats">
              <Stat value={String(service.orders)} label="заявок всего" />
              <Stat value={String(service.assigned)} label="разложено" />
              <Stat value={`${Math.round(rate * 100)}%`} label="покрытие" bad={rate < 0.8} />
              <Stat
                value={
                  service.minutes === service.minutesTo
                    ? String(service.minutes)
                    : `${service.minutes}–${service.minutesTo}`
                }
                unit="мин"
                label="работа на объекте"
              />
              <Stat
                value={service.urgent > 0 ? String(service.urgent) : '—'}
                label="срочных"
                bad={service.urgent > 0}
              />
              <Stat
                value={service.access > 0 ? String(service.access) : '—'}
                label="нужен доступ"
              />
            </div>
          </div>
        </div>

        {(service.equipment.length > 0 || service.requiredTransport) && (
          <section className="crewpro__block">
            <h3 className="crewpro__title">Что нужно везти</h3>
            <div className="skillrow">
              {service.equipment.map((item) => (
                <span key={item} className="skillchip">
                  <Icon name="stack" size={13} />
                  {equipmentName(item)}
                </span>
              ))}
              {service.requiredTransport && (
                <span className="skillchip">
                  <Icon name="car" size={13} />
                  Транспорт: {service.requiredTransport}
                </span>
              )}
            </div>
          </section>
        )}

        <section className="crewpro__block">
          <div className="crewpro__tabsrow">
            <h3 className="crewpro__title">Где эта работа встречалась</h3>
            <SegmentedControl
              size="sm"
              value={tab}
              onChange={(value: string) => setTab(value as Tab)}
              items={[
                { value: 'orders', label: `Заявки · ${orders.length}` },
                { value: 'crew', label: `Инженеры · ${crew.length}` },
                { value: 'runs', label: `Расчёты · ${byRun.length}` }
              ]}
            />
          </div>

          {tab === 'orders' && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Заявка</th>
                    <th>Адрес</th>
                    <th>Клиент</th>
                    <th>Расчёт</th>
                    <th>Окно приёма</th>
                    <th>Инженер</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((order) => (
                    <tr
                      key={order.key}
                      className="tbl__row"
                      tabIndex={0}
                      role="button"
                      onClick={() => onOpenOrder(order)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onOpenOrder(order);
                        }
                      }}
                    >
                      <td>
                        <span className="tbl__strong">{order.id}</span>
                      </td>
                      <td>
                        <span>{order.address}</span>
                        <span className="tbl__sub">{order.district}</span>
                      </td>
                      <td>{order.company}</td>
                      <td>{order.run.code}</td>
                      <td className="tbl__num">
                        {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                      </td>
                      <td>{order.engineerName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'crew' && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Инженер</th>
                    <th>Табельный</th>
                    <th>Визитов</th>
                    <th>Часов работы</th>
                  </tr>
                </thead>
                <tbody>
                  {crew.map((one) => (
                    <tr key={one.key}>
                      <td>
                        <span className="tbl__strong">{one.name}</span>
                      </td>
                      <td>{one.id}</td>
                      <td className="tbl__num">{one.visits}</td>
                      <td className="tbl__num">{dec(one.minutes / 60)} ч</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {crew.length === 0 && (
                <p className="crewpro__empty">
                  Эту работу пока никто не выполнял: все заявки остались без инженера.
                </p>
              )}
            </div>
          )}

          {tab === 'runs' && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Расчёт</th>
                    <th>Дата</th>
                    <th>Заявок</th>
                    <th>Разложено</th>
                    <th>Покрытие</th>
                  </tr>
                </thead>
                <tbody>
                  {byRun.map((one) => (
                    <tr
                      key={one.id}
                      className="tbl__row"
                      tabIndex={0}
                      role="button"
                      onClick={() => onOpenRun(one.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onOpenRun(one.id);
                        }
                      }}
                    >
                      <td>
                        <span className="tbl__strong">{one.code}</span>
                      </td>
                      <td>{one.date}</td>
                      <td className="tbl__num">{one.total}</td>
                      <td className="tbl__num">{one.done}</td>
                      <td>
                        <span
                          className={
                            'pill pill--' + (one.done === one.total ? 'success' : 'danger')
                          }
                        >
                          {one.total === 0 ? '—' : `${Math.round((one.done / one.total) * 100)}%`}
                        </span>
                      </td>
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
