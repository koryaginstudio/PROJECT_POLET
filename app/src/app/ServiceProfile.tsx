import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry, ServiceRecord } from '../data/registry.ts';
import { distinctEngineers, serviceCrew } from '../data/registry.ts';
import { dec, hhmm, plural } from '../data/derive.ts';
import {
  equipmentName,
  requiredTransportName,
  skillIcon,
  skillName,
  transportIcon,
  transportName,
  workTypeIcon
} from '../data/dictionary.ts';

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

  /* Кто может её взять — по справочнику: навык и транспорт. Это не то же
     самое, что «кто выполнял» ниже: там факт прошедших расчётов, здесь —
     кого вообще можно послать. Оператор приходит с этим вопросом первым. */
  const able = useMemo(
    () => (service ? serviceCrew(service, registry.engineers) : null),
    [service?.key, registry]
  );
  /* Знаменатель — люди, а не записи справочника: см. distinctEngineers. */
  const staff = useMemo(() => distinctEngineers(registry.engineers).length, [registry]);

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

  /* Покрытие — доля разложенного из того, что попадало в расчёты.

     Считалось от числа заявок в данных, а разложенное считается по
     расчётам: одна и та же открытая заявка попадает в каждый прогон и в
     `assigned` учтена столько раз, сколько прогонов её видели. Семь заявок
     в шести расчётах давали «171% покрытия» — доля, которой не бывает.

     Когда услуга в расчёты не попадала, доли нет вовсе: ноль читался бы
     как «ничего не разложили». */
  const rate = service.planned === 0 ? null : service.assigned / service.planned;
  /* Без инженера — из того же, из чего считается покрытие: сколько раз
     заявка услуги попадала в расчёт и осталась неразложенной. Считалось
     «заявки в данных минус разложенное по расчётам» — у услуги, попавшей в
     шесть прогонов, разность уходила в минус, и метка не показывалась
     никогда; а у услуги, не попавшей ни в один, она, наоборот, обещала
     «семь заявок без инженера» там, где их никто и не раскладывал. */
  const missed = service.planned - service.assigned;

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
              {/* Счёт с транспортом, а не по одному навыку: у «Работы с
                  кабелем» навык есть у двадцати восьми, а машина из них у
                  тринадцати — пятнадцать человек поехать не смогут. */}
              <span className="crewpro__muted">
                · могут взять {able?.able.length ?? 0} из {staff}
              </span>
            </span>

            <div className="crewpro__stats">
              <Stat value={String(service.orders)} label="заявок в данных" />
              {/* «Разложено» — из того, что попадало в расчёты, и сказано
                  парой: рядом с «заявок в данных» одно число читалось как
                  часть от него, а это разные основания. */}
              <Stat
                value={service.planned > 0 ? `${service.assigned} из ${service.planned}` : '—'}
                label="разложено в расчётах"
              />
              <Stat
                value={rate === null ? '—' : `${Math.round(rate * 100)}%`}
                label="покрытие"
                bad={rate !== null && rate < 0.8}
              />
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

        {/* Первым блоком записи — кого посылать. Имена, а не число: услугу
            оператор знает и так, а вот кто её умеет, держать в голове на
            сорок два человека нельзя. */}
        {able && (
          <section className="crewpro__block">
            <h3 className="crewpro__title">
              Кто может взять · {able.able.length} из {staff}
              {/* По какому условию отобраны. Стоит здесь, а не отдельной
                  строкой ниже: это не свойство услуги «между прочим», а то
                  самое, по чему список разошёлся надвое. Когда никого не
                  отсекло, сказать об этом всё равно надо — иначе требование
                  из записи пропадает вовсе. */}
              {service.requiredTransport && (
                <span className="crewpro__muted">
                  {' '}· нужен {requiredTransportName(service.requiredTransport).toLowerCase()}
                </span>
              )}
            </h3>
            {able.able.length === 0 ? (
              <p className="crewpro__empty">
                Взять эту работу некому: подходящих по навыку и транспорту в справочнике нет.
              </p>
            ) : (
              <div className="skillrow">
                {able.able.map((one) => (
                  <span key={one.id} className="skillchip" title={one.code}>
                    <Icon name="user" size={13} />
                    {one.name}
                  </span>
                ))}
              </div>
            )}

            {/* Кому не хватает малого — отдельно и свёрнуто. Эти работу
                знают, и в горячий час о них спрашивают вторым вопросом:
                «а этих почему нельзя?». Наверху им не место — список
                «кого послать» должен состоять из тех, кого можно послать
                прямо сейчас, без оговорок. */}
            {able.blocked.length > 0 && (
              <details className="fold crewpro__blocked">
                <summary className="fold__summary">
                  <Icon name="chevron-right" size={13} />
                  Не могут взять · {able.blocked.length}
                </summary>
                <div className="fold__body">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Инженер</th>
                        <th>Табельный</th>
                        <th>Транспорт</th>
                        <th>Чего не хватает</th>
                      </tr>
                    </thead>
                    <tbody>
                      {able.blocked.map((one) => (
                        <tr key={one.id}>
                          <td>
                            <span className="tbl__strong">{one.name}</span>
                          </td>
                          <td>{one.code}</td>
                          {/* Что есть — отдельной клеткой, а не внутри фразы:
                              «Пешеход» и «Общественный транспорт» — названия
                              из словаря, и во фразу «у него ...» они не
                              встают. */}
                          <td>
                            {one.transport ? (
                              <span className="tbl__inline">
                                <Icon name={transportIcon(one.transport)} size={13} />
                                {transportName(one.transport)}
                              </span>
                            ) : (
                              <span className="tbl__muted">не указан</span>
                            )}
                          </td>
                          <td>
                            {/* Навык у них есть — иначе их бы тут не было;
                                не хватает только транспорта. */}
                            <span className="tbl__warn">
                              нужен {requiredTransportName(service.requiredTransport).toLowerCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </section>
        )}

        {/* Только оборудование. Транспорт отсюда убран: «везти автомобиль»
            звучит глупо, да и сказано о нём выше — он и есть то условие, по
            которому люди разошлись на «могут» и «не могут». */}
        {service.equipment.length > 0 && (
          <section className="crewpro__block">
            <h3 className="crewpro__title">Что нужно везти</h3>
            <div className="skillrow">
              {service.equipment.map((item) => (
                <span key={item} className="skillchip">
                  <Icon name="stack" size={13} />
                  {equipmentName(item)}
                </span>
              ))}
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
                    <th>Заявок</th>
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
