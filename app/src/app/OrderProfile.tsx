import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry } from '../data/registry.ts';
import { dec, deadline, hhmm } from '../data/derive.ts';
import {
  equipmentList,
  isUrgent,
  orderClassName,
  requiredTransportName,
  skillIcon,
  skillName,
  statusName,
  techName,
  workTypeIcon
} from '../data/dictionary.ts';
import { durationWhy, requiredTransportWhy } from '../data/rationale.ts';
import { OrderWindow } from './OrderWindow.tsx';
import { NoteField } from './NoteField.tsx';
import { WhyMark } from './WhyMark.tsx';
import { useModalFocus } from './modal.ts';

interface Props {
  /** Какая заявка открыта. Пусто — карточки нет. */
  order: OrderRecord | null;
  registry: Registry;
  onClose: () => void;
  /** Уйти в расчёт, которому заявка принадлежит. */
  onOpenRun: (runId: string) => void;
  /** Показать её на карте своего расчёта: карта откроется на этой точке. */
  onOpenMap: (runId: string, orderId: string) => void;
}

/* Карточка заявки целиком: всё, что мы о ней знаем, на одном экране.

   Устроена как профиль инженера, и это не сходство ради сходства: строка в
   списке отвечает на «что это и когда», карточка — на «расскажи про неё».
   Сверху то, что принадлежит самой заявке и не меняется от расчёта к
   расчёту: что делаем, где, когда и для кого. Ниже — то, что посчитано:
   в каких расчётах она встречалась, с чем ехала в одном маршруте и что ещё
   заведено по этому адресу. */
type Tab = 'runs' | 'route' | 'address';

export function OrderProfile({ order, registry, onClose, onOpenRun, onOpenMap }: Props) {
  const [tab, setTab] = useState<Tab>('runs');
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(order !== null, card);

  useEffect(() => {
    if (order) setTab('runs');
  }, [order?.key]);

  useEffect(() => {
    if (!order) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [order, onClose]);

  /* Тот же номер в других расчётах: заявка, которую в одном расчёте никто не
     взял, в другом могла лечь в маршрут. */
  const inRuns = useMemo(
    () => (order ? registry.orders.filter((one) => one.id === order.id) : []),
    [order, registry]
  );

  /* С чем она ехала в одном маршруте: остальные визиты того же инженера в
     том же расчёте, по порядку объезда. */
  const neighbours = useMemo(() => {
    if (!order || !order.engineerId) return [];
    return registry.orders
      .filter(
        (one) =>
          one.run.id === order.run.id &&
          one.engineerId === order.engineerId &&
          one.key !== order.key
      )
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }, [order, registry]);

  /* Что ещё заведено по этому адресу — во всех расчётах. Сверяем по ключу
     точки обслуживания, а не по строке адреса: ключ один и тот же у всех
     заявок клиента, а строка адреса у заявки без дома — это район, и
     сравнение строк сводило бы вместе полгорода. */
  const atAddress = useMemo(() => {
    if (!order) return [];
    return registry.orders.filter((one) => one.clientKey === order.clientKey && one.key !== order.key);
  }, [order, registry]);

  if (!order) return null;

  const urgent = isUrgent(order.priorityClass, order.priority);
  const slack = order.slaDeadline - order.windowEnd;
  const width = order.windowEnd - order.windowStart;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Заявка ${order.id}`}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card crewpro" ref={card}>
        {/* Шапка у инженера двухколоночная: слева портрет, справа имя и
            цифры. У заявки лица нет и не будет — стоявший на его месте
            квадрат со значком вида работ ничего не добавлял: тот же значок
            стоит рядом с названием работы, а класс и состояние — это текст,
            и читать их удобнее строкой, а не подписью под картинкой.
            Поэтому колонка одна, во всю ширину, и в ней только текст. */}
        <div className="crewpro__hero ordpro__hero">
          <div className="crewpro__hero-body">
            <div className="crewpro__top">
              <div className="crewpro__who">
                <div className="crewpro__idrow">
                  <span className="crewpro__id">{order.id}</span>
                  <span className="crewpro__role">
                    {order.orderClass ? orderClassName(order.orderClass) : 'Заявка'} · расчёт{' '}
                    {order.run.code} от {order.run.date}
                  </span>
                  {order.status && <span className="pill">{statusName(order.status)}</span>}
                </div>
                <h2 className="crewpro__name ordpro__name">
                  <Icon name={workTypeIcon(order.workType)} size={20} />
                  {order.workTitle}
                  {/* «Срочная» стоит в заголовке и горит красным: это первое,
                      что нужно знать о заявке, и в ряду серых цифр ниже —
                      где она была раньше — это терялось. */}
                  {urgent && (
                    <span className="ordpro__urgent">
                      <Icon name="warning" size={13} />
                      Срочная
                    </span>
                  )}
                </h2>
                {order.contactName && (
                  <span className="crewpro__phone">
                    {order.contactName}
                    {order.contactPhone ? ` · ${order.contactPhone}` : ''}
                  </span>
                )}
              </div>
              <div className="crewpro__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenMap(order.run.id, order.id)}
                  iconLeft={<Icon name="map-pin" size={13} />}
                >
                  На карте
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenRun(order.run.id)}
                  iconLeft={<Icon name="arrow-right" size={13} />}
                >
                  В расчёт
                </Button>
                <span className="modal__esc">
                  <kbd>Esc</kbd> — закрыть
                </span>
                <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
                  <Icon name="x" size={16} />
                </button>
              </div>
            </div>

            {/* Адрес — на месте транспорта у инженера: часть ответа на «куда
                ехать», и читается он вместе с названием работы, а не в общем
                списке полей ниже. */}
            <span className="crewpro__transport">
              <span className="crewpro__transport-label">Адрес</span>
              <Icon name="map-pin" size={15} />
              {order.address}
              <span className="crewpro__muted">· {order.district}</span>
            </span>

            <div className="crewpro__stats">
              <Stat value={String(order.estMinutes)} unit="мин" label="работа на объекте" />
              <Stat value={dec(width / 60)} unit="ч" label="окно приёма" />
              <Stat
                value={dec(Math.max(0, slack) / 60)}
                unit="ч"
                label="запас до срока"
                bad={slack <= 0}
              />
              {/* Приоритет отсюда ушёл в заголовок: срочность — не рядовая
                  величина в ряду шести, а первое, что нужно знать. Обычной
                  заявке он и вовсе ничего не сообщал: «приоритет —
                  обычный» занимало шестую часть ряда, чтобы сказать «ничего
                  особенного». */}
              <Stat
                value={order.visitStart == null ? '—' : hhmm(order.visitStart)}
                label="когда приедет"
                bad={order.visitStart == null}
              />
              <Stat value={order.engineerId ?? '—'} label="инженер" bad={!order.engineerId} />
              <Stat
                value={order.seq === null ? '—' : `№ ${order.seq + 1}`}
                label="визит в маршруте"
              />
            </div>
          </div>
        </div>

        {/* Постоянные данные — одной панелью: что делаем, когда и где, для
            кого. Разными секциями с чертой между ними это читалось бы как
            три разные темы, а вопрос один — «что за заявка». */}
        <section className="crewpro__block">
          <h3 className="crewpro__title">Данные заявки</h3>

          <div className="crewpro__grid">
            <div className="crewpro__cell">
              <span className="crewpro__label">Что делаем</span>
              <div className="skillrow">
                <span className="skillchip">
                  <Icon name={workTypeIcon(order.workType)} size={13} />
                  {order.workTitle}
                </span>
                <span className="skillchip">
                  <Icon name={skillIcon(order.skill)} size={13} />
                  {skillName(order.skill)}
                </span>
                {order.tech && <span className="skillchip">{techName(order.tech)}</span>}
                {order.gigabit && <span className="skillchip">Гигабит</span>}
              </div>
            </div>

            <div className="crewpro__cell crewpro__cell--wide">
              <span className="crewpro__label">Когда принимают</span>
              {/* Окно на шкале дня: два часа посреди дня и окно с девяти до
                  девяти это разные заявки, а в строке «12:00–14:00» разницы
                  не видно, пока не прочитаешь обе. */}
              {/* Окно и визит на одной шкале: «когда готовы принять» и «когда
                  приедут» — два разных времени, и вопрос у диспетчера всегда
                  про их соотношение. Раньше визит сюда не передавался вовсе,
                  и полоса показывала одно окно. */}
              <div className="ordwin">
                <OrderWindow
                  from={order.windowStart}
                  to={order.windowEnd}
                  start={order.visitStart ?? undefined}
                  finish={order.visitEnd ?? undefined}
                  risky={slack <= 0}
                />
              </div>
              <dl className="engmetrics">
                <div className="engmetrics__row">
                  <dt>Окно приёма</dt>
                  <span className="engmetrics__leader" aria-hidden="true" />
                  <dd>
                    {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                  </dd>
                </div>
                <div className="engmetrics__row">
                  <dt>Когда приедет</dt>
                  <span className="engmetrics__leader" aria-hidden="true" />
                  <dd>
                    {order.visitStart == null || order.visitEnd == null ? (
                      <span className="crewpro__muted">не назначена</span>
                    ) : (
                      `${hhmm(order.visitStart)}–${hhmm(order.visitEnd)}`
                    )}
                  </dd>
                </div>
                <div className={'engmetrics__row' + (slack <= 0 ? ' engmetrics__row--bad' : '')}>
                  <dt>Крайний срок</dt>
                  <span className="engmetrics__leader" aria-hidden="true" />
                  <dd>{deadline(order.slaDeadline)}</dd>
                </div>
                <div className="engmetrics__row">
                  <dt>
                    Длительность
                    <WhyMark text={durationWhy} />
                  </dt>
                  <span className="engmetrics__leader" aria-hidden="true" />
                  <dd>{order.estMinutes} мин</dd>
                </div>
              </dl>
            </div>

            <div className="crewpro__cell crewpro__cell--wide">
              <span className="crewpro__label">Заметка</span>
              {/* То, чего нет ни в выгрузке, ни в расчёте: «домофон не
                  работает», «просили перезвонить за час». */}
              <NoteField kind="order" id={order.id} placeholder="Добавить заметку о заявке" />
            </div>

            <div className="crewpro__cell">
              <span className="crewpro__label">Что нужно на объекте</span>
              <dl className="engfacts">
                <div className="engfacts__row">
                  <dt>Доступ</dt>
                  <dd className="engfacts__tight">
                    {order.needsAccess ? 'нужен доступ в помещение' : 'не нужен'}
                  </dd>
                </div>
                {order.requiredEquipment.length > 0 && (
                  <div className="engfacts__row">
                    <dt>Везти</dt>
                    <dd>{equipmentList(order.requiredEquipment)}</dd>
                  </div>
                )}
                {order.requiredTransport && (
                  <div className="engfacts__row">
                    <dt>
                      Транспорт
                      <WhyMark
                        text={requiredTransportWhy(order.requiredTransport, order.workType)}
                      />
                    </dt>
                    <dd className="engfacts__tight">
                      {requiredTransportName(order.requiredTransport)}
                    </dd>
                  </div>
                )}
                <div className="engfacts__row">
                  <dt>Координаты</dt>
                  <dd className="engfacts__tight">
                    {order.lat.toFixed(5)}, {order.lon.toFixed(5)}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="crewpro__cell">
              <span className="crewpro__label">Кому</span>
              <dl className="engfacts">
                {/* Заказчик и контактное лицо — разные вещи, и раньше под
                    «Клиентом» стояло второе. Договор у компании, а у двери
                    встречает человек: диспетчер, который ищет «чья это
                    заявка», спрашивает о первом. */}
                <div className="engfacts__row">
                  <dt>Клиент</dt>
                  <dd>{order.company}</dd>
                </div>
                {order.contactName && (
                  <div className="engfacts__row">
                    <dt>Контакт</dt>
                    <dd>{order.contactName}</dd>
                  </div>
                )}
                {order.contactPhone && (
                  <div className="engfacts__row">
                    <dt>Телефон</dt>
                    <dd className="engfacts__tight">{order.contactPhone}</dd>
                  </div>
                )}
                <div className="engfacts__row">
                  <dt>Адрес</dt>
                  <dd className="engfacts__stack">
                    <span>{order.address}</span>
                    <span className="engfacts__sub">{order.district}</span>
                  </dd>
                </div>
              </dl>
            </div>

            <div className="crewpro__cell">
              <span className="crewpro__label">Кто едет</span>
              <dl className="engfacts">
                <div className="engfacts__row">
                  <dt>Инженер</dt>
                  <dd className="engfacts__stack">
                    <span>{order.engineerName ?? 'не назначен'}</span>
                    {order.engineerId && <span className="engfacts__sub">{order.engineerId}</span>}
                  </dd>
                </div>
                <div className="engfacts__row">
                  <dt>Визит</dt>
                  <dd className="engfacts__tight">
                    {order.seq === null ? 'в маршрут не попала' : `№ ${order.seq + 1} в маршруте`}
                  </dd>
                </div>
                {order.seq === null && order.unassignedWhy && (
                  <div className="engfacts__row">
                    <dt>Почему</dt>
                    <dd className="engfacts__tight">
                      {order.unassignedWhy.charAt(0).toUpperCase() + order.unassignedWhy.slice(1)}
                    </dd>
                  </div>
                )}
                {order.status && (
                  <div className="engfacts__row">
                    <dt>Состояние</dt>
                    <dd>{statusName(order.status)}</dd>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </section>

        {/* История — вкладками, как у инженера. Три разреза одной заявки:
            где её считали, с чем она ехала и что ещё есть по этому адресу.
            Подряд они складывались бы в простыню, а спрашивают их по
            одному. */}
        <section className="crewpro__block">
          <div className="crewpro__tabs">
            <SegmentedControl
              size="sm"
              value={tab}
              onChange={(value: string) => setTab(value as Tab)}
              items={[
                { value: 'runs', label: `В расчётах · ${inRuns.length}` },
                { value: 'route', label: `Рядом в маршруте · ${neighbours.length}` },
                { value: 'address', label: `По адресу · ${atAddress.length}` }
              ]}
            />
          </div>

          {tab === 'runs' && (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Расчёт</th>
                    <th>Окно приёма</th>
                    <th>Работа</th>
                    <th>Инженер</th>
                    <th>Визит</th>
                  </tr>
                </thead>
                <tbody>
                  {inRuns.map((one) => (
                    <tr className={'tbl__row' + (one.key === order.key ? ' tbl__row--this' : '')} key={one.key}>
                      <td>
                        <span className="tbl__strong">{one.run.code}</span>
                        <span className="tbl__sub">{one.run.date}</span>
                      </td>
                      <td className="tbl__num">
                        {hhmm(one.windowStart)}–{hhmm(one.windowEnd)}
                      </td>
                      <td className="tbl__num">{one.estMinutes} мин</td>
                      <td>{one.engineerName ?? <span className="tbl__muted">—</span>}</td>
                      <td className="tbl__num">
                        {one.seq === null ? <span className="tbl__muted">—</span> : `№ ${one.seq + 1}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'route' &&
            (neighbours.length === 0 ? (
              <p className="crewpro__muted">
                {order.engineerId
                  ? 'В этом расчёте инженер вёз её одну.'
                  : 'Заявка не попала в маршрут — соседей у неё нет.'}
              </p>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Визит</th>
                      <th>Заявка</th>
                      <th>Что делаем</th>
                      <th>Адрес</th>
                      <th>Окно приёма</th>
                      <th>Работа</th>
                    </tr>
                  </thead>
                  <tbody>
                    {neighbours.map((one) => (
                      <tr className="tbl__row" key={one.key}>
                        <td className="tbl__num">{one.seq === null ? '—' : `№ ${one.seq + 1}`}</td>
                        <td>
                          <span className="tbl__strong">{one.id}</span>
                        </td>
                        <td>{one.workTitle}</td>
                        <td>{one.address}</td>
                        <td className="tbl__num">
                          {hhmm(one.windowStart)}–{hhmm(one.windowEnd)}
                        </td>
                        <td className="tbl__num">{one.estMinutes} мин</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {tab === 'address' &&
            (atAddress.length === 0 ? (
              <p className="crewpro__muted">Больше по этому адресу ничего не заведено.</p>
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Заявка</th>
                      <th>Расчёт</th>
                      <th>Что делаем</th>
                      <th>Окно приёма</th>
                      <th>Работа</th>
                      <th>Инженер</th>
                    </tr>
                  </thead>
                  <tbody>
                    {atAddress.map((one) => (
                      <tr className="tbl__row" key={one.key}>
                        <td>
                          <span className="tbl__strong">{one.id}</span>
                        </td>
                        <td>{one.run.code}</td>
                        <td>{one.workTitle}</td>
                        <td className="tbl__num">
                          {hhmm(one.windowStart)}–{hhmm(one.windowEnd)}
                        </td>
                        <td className="tbl__num">{one.estMinutes} мин</td>
                        <td>{one.engineerName ?? <span className="tbl__muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
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
