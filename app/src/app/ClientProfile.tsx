import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import type { ClientRecord, OrderRecord, Registry } from '../data/registry.ts';
import { dec, hhmm, plural } from '../data/derive.ts';
import { workTypeIcon } from '../data/dictionary.ts';

interface Props {
  /** Какой адрес открыт. Пусто — карточки нет. */
  client: ClientRecord | null;
  registry: Registry;
  onClose: () => void;
  /** Открыть заявку этого адреса целиком. */
  onOpenOrder: (order: OrderRecord) => void;
  /** Уйти в расчёт, в котором адрес встречался. */
  onOpenRun: (runId: string) => void;
}

/* Карточка клиента: что мы для него делали и чего не сделали.

   До сих пор её не было вовсе. В базе клиентов сто девяносто пять адресов,
   и ни один из них не открывался: карточка была картинкой, строка списка —
   не кнопкой. Вопрос «что мы делали по этому адресу» — тот, с которым в
   базу клиентов и приходят, — из неё не решался никак; обходной путь шёл
   через базу заявок и требовал знать номер наряда, то есть ровно то, чего
   у звонящего обычно нет.

   Устроена как профиль заявки и профиль инженера, теми же классами: три
   базы отвечают на один вопрос «расскажи про эту запись», и одно и то же
   место в карточке обязано значить одно и то же. Сверху — кто это и где,
   ряд главных чисел, ниже — вкладки истории.

   Вкладок три, и они отвечают на три разных вопроса. «Заявки» — что здесь
   заказывали и чем это кончилось. «Инженеры» — кто сюда ездил: у постоянного
   адреса это первое, что спрашивают, когда собираются послать нового
   человека. «Расчёты» — как адрес выглядел в каждом дне: покрытие по этому
   дому в разных планах расходится, и видеть это надо рядом, а не порознь. */
type Tab = 'orders' | 'crew' | 'runs';

export function ClientProfile({ client, registry, onClose, onOpenOrder, onOpenRun }: Props) {
  const [tab, setTab] = useState<Tab>('orders');

  useEffect(() => {
    if (client) setTab('orders');
  }, [client?.key]);

  useEffect(() => {
    if (!client) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [client, onClose]);

  /* Заявки этого адреса. Сверяем по ключу точки, а не по строке адреса:
     ключ и есть то, чем реестр отличает один дом от другого, а строка
     адреса у заявки — это уже показанная строка, собранная для экрана. */
  const orders = useMemo(() => {
    if (!client) return [];
    return registry.orders
      .filter((order) => order.clientKey === client.key)
      .sort((a, b) => a.run.code.localeCompare(b.run.code, 'ru') || a.windowStart - b.windowStart);
  }, [client?.key, registry]);

  /* Кто сюда ездил: человек и сколько раз. Инженер без маршрута в счёт не
     идёт — он к этому адресу не подъезжал. */
  const crew = useMemo(() => {
    const map = new Map<string, { key: string; id: string; name: string; visits: number; runs: Set<string> }>();
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
        runs: new Set<string>()
      };
      cell.visits += 1;
      cell.runs.add(order.run.code);
      map.set(who, cell);
    }
    return [...map.values()].sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name, 'ru'));
  }, [orders]);

  /* Тот же адрес по расчётам: сколько заявок и сколько из них разложено. */
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

  if (!client) return null;

  const rate = client.orders === 0 ? 0 : client.assigned / client.orders;
  const missed = client.orders - client.assigned;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={client.company}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card crewpro">
        <div className="crewpro__hero ordpro__hero">
          <div className="crewpro__hero-body">
            <div className="crewpro__top">
              <div className="crewpro__who">
                <div className="crewpro__idrow">
                  <span className="crewpro__id">{client.code}</span>
                  <span className="crewpro__role">
                    Точка обслуживания · {client.district}
                  </span>
                  {missed > 0 && (
                    <span className="pill pill--danger">
                      {plural(missed, 'заявка', 'заявки', 'заявок')} без инженера
                    </span>
                  )}
                </div>
                <h2 className="crewpro__name ordpro__name">
                  <Icon name="user" size={20} />
                  {client.company}
                </h2>
              </div>
              <div className="crewpro__actions">
                <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
                  <Icon name="x" size={16} />
                </button>
              </div>
            </div>

            <span className="crewpro__transport">
              <span className="crewpro__transport-label">Адрес</span>
              <Icon name="map-pin" size={15} />
              {client.address}
              <span className="crewpro__muted">· {client.district}</span>
            </span>

            <div className="crewpro__stats">
              <Stat value={String(client.orders)} label="заявок всего" />
              <Stat value={String(client.assigned)} label="обслужено" />
              <Stat
                value={`${Math.round(rate * 100)}%`}
                label="назначено"
                bad={rate < 0.8}
              />
              <Stat
                value={client.urgent > 0 ? String(client.urgent) : '—'}
                label="срочных"
                bad={client.urgent > 0}
              />
              <Stat
                value={client.access > 0 ? String(client.access) : '—'}
                label="нужен доступ"
              />
              <Stat value={String(client.avgMinutes)} unit="мин" label="средняя работа" />
            </div>
          </div>
        </div>

        <section className="crewpro__block">
          <h3 className="crewpro__title">Что здесь делают</h3>
          <div className="skillrow">
            {client.workTypes.map((type) => (
              <span key={type} className="skillchip">
                <Icon name={workTypeIcon(type)} size={13} />
                {registry.workTypeTitle[type] ?? type}
              </span>
            ))}
          </div>
        </section>

        <section className="crewpro__block">
          <div className="crewpro__tabsrow">
            <h3 className="crewpro__title">История адреса</h3>
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
                    <th>Что делаем</th>
                    <th>Расчёт</th>
                    <th>Окно приёма</th>
                    <th>Визит</th>
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
                        <span className="tbl__inline">
                          <Icon name={workTypeIcon(order.workType)} size={13} />
                          {order.workTitle}
                        </span>
                      </td>
                      <td>{order.run.code}</td>
                      <td className="tbl__num">
                        {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                      </td>
                      <td className="tbl__num">
                        {order.visitStart == null ? '—' : hhmm(order.visitStart)}
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
                    <th>В расчётах</th>
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
                      <td>{[...one.runs].join(' · ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {crew.length === 0 && (
                <p className="crewpro__empty">
                  По этому адресу никто не выезжал: все заявки остались без инженера.
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
                    <th>Назначено</th>
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

        <p className="crewpro__foot">
          Адрес встречался в {plural(client.runs, 'расчёте', 'расчётах', 'расчётах')} из{' '}
          {registry.runs.length}. Раннее окно приёма — {hhmm(client.firstWindow)}, в среднем на
          работу уходит {dec(client.avgMinutes / 60)} ч.
        </p>
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
