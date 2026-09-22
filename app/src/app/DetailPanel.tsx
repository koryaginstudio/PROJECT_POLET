import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { OrderWindow } from './OrderWindow.tsx';
import { Complexity } from './Complexity.tsx';
import type { Day } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import { dayStart, dec, deadline, hhmm, homeOf, hoursText, isDeferrable, placeOf } from '../data/derive.ts';
import { equipmentList, skillIcon, skillName, transportIcon, transportName } from '../data/dictionary.ts';
import { DispatcherBlock } from './DispatcherBlock.tsx';
import type { DispatcherActions } from './DispatcherBlock.tsx';
import { EngineerTimeline } from './EngineerTimeline.tsx';
import { GroupPanel } from './GroupPanel.tsx';
import type { Selection } from './selection.ts';
import { OVERVIEW } from './selection.ts';
import { buildCatalogue, trailToPage } from './catalogue.ts';
import type { CatalogNode } from './catalogue.ts';
import { faceOf } from '../data/photos.ts';
import { homeWhy, shiftWhy, transportWhy } from '../data/rationale.ts';
import { WhyMark } from './WhyMark.tsx';
import { PersonName } from './PersonName.tsx';

interface Props {
  day: Day;
  view: DayView;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  /** Распоряжения диспетчера по заявке. Есть только у расчёта движка:
      у расчёта, посчитанного в браузере, журнала нет. */
  dispatcher?: DispatcherActions;
}

/* Панель считает всё от начала смены и дальше не двигается: она отвечает на
   вопрос «что это за объект», а не «что с ним сейчас». Когда её содержимое
   ехало вместе с ползунком, открытый список менялся под руками. За текущим
   состоянием смотрят в мониторинге. */
const panelCut = () => dayStart();

type BadgeTone = 'neutral' | 'accent' | 'success' | 'danger' | 'inverse' | 'outline' | 'gradient';

const VERDICT_LABEL: Record<string, string> = {
  chosen: 'Назначен',
  feasible: 'Мог бы взять',
  no_room: 'Маршрут занят',
  shift_mismatch: 'Не совпадает смена',
  no_vehicle: 'Не тот транспорт',
  no_skill: 'Нет навыка'
};

const VERDICT_TONE: Record<string, BadgeTone> = {
  chosen: 'success',
  feasible: 'neutral',
  no_room: 'outline',
  shift_mismatch: 'outline',
  no_vehicle: 'outline',
  no_skill: 'outline'
};

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="facts__row">
      <span className="facts__key">{k}</span>
      <span className="facts__val">{v}</span>
    </div>
  );
}

function CloseCard({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="detail__close" onClick={onClose} aria-label="Закрыть и вернуться к меню">
      <Icon name="x" size={16} />
    </button>
  );
}

/* Открытое поверх справочника: страница группы или карточка объекта. */
function SelectedCard({ day, view, selection, onSelect, dispatcher }: Props) {
  const close = () => onSelect(OVERVIEW);

  if (selection.kind === 'overview') return null;

  if (selection.kind === 'group') {
    return <GroupPanel day={day} groupId={selection.id} view={view} cut={panelCut()} onSelect={onSelect} onClose={close} />;
  }

  /* Готовый список: номера уже отобраны там, где щёлкнули, и панель их только
     показывает. Пересчитывать нечего — поэтому ползунок времени её не двигает. */
  if (selection.kind === 'list') {
    return (
      <GroupPanel
        day={day}
        shape={{
          eyebrow: selection.eyebrow,
          title: selection.title,
          flat: true,
          sections: [
            selection.of === 'orders'
              ? { key: 'list', label: selection.title, orderIds: selection.ids }
              : { key: 'list', label: selection.title, engineerIds: selection.ids }
          ]
        }}
        view={view}
        cut={panelCut()}
        onSelect={onSelect}
        onClose={close}
      />
    );
  }

  if (selection.kind === 'engineer') {
    const load = view.loads.find((l) => l.engineer.id === selection.id);
    if (!load) return null;
    const { engineer, route } = load;
    const totals = route?.totals;

    return (
      <div className="detail enter">
        <div className="detail__top">
          {/* Лицо рядом с именем — то же, что в списке справочника и в базе
              инженеров: человек в приложении один, и лицо у него одно. */}
          <div className="detail__who">
            <img
              className="detail__face"
              src={faceOf(engineer)}
              alt=""
              loading="lazy"
            />
            <div>
              <div className="detail__eyebrow">Инженер · {engineer.id}</div>
              <h2 className="detail__title">
                <PersonName name={engineer.name} />
              </h2>
            </div>
          </div>
          <CloseCard onClose={close} />
        </div>

        {/* Смена — первое, что о человеке нужно знать: во сколько он вышел и до
            скольки его можно ставить в маршрут. Раньше это стояло серой
            строчкой в подписи и терялось. */}
        <div className="shiftline">
          <span className="shiftline__icon">
            <Icon name="clock" size={16} />
          </span>
          <span className="shiftline__body">
            <span className="shiftline__value">
              {hhmm(engineer.shift_start)}–{hhmm(engineer.shift_end)}
            </span>
            <span className="shiftline__note">
              Смена · {hoursText(engineer.shift_end - engineer.shift_start)}
              <WhyMark text={shiftWhy} />
            </span>
          </span>
        </div>

        {/* Откуда человек выезжает: первый перегон считается от его дома, и
            когда маршрут начинается на другом конце города, объяснение стоит
            именно здесь. */}
        {engineer.home_address && (
          <div className="shiftline">
            <span className="shiftline__icon">
              <Icon name="house" size={16} />
            </span>
            <span className="shiftline__body">
              <span className="shiftline__value shiftline__value--text">{homeOf(engineer)}</span>
              <span className="shiftline__note">
                Отсюда начинается день
                <WhyMark text={homeWhy} />
              </span>
            </span>
          </div>
        )}

        {/* Транспорт стоит рядом со сменой и адресом, а не среди цифр
            маршрута: ТЗ называет его обязательным полем инженера наравне с
            навыками, и на нём же строится третья группа ограничений —
            заявка с требованием к транспорту достанется не всякому. */}
        {engineer.transport && (
          <div className="shiftline">
            <span className="shiftline__icon">
              <Icon name={transportIcon(engineer.transport)} size={16} />
            </span>
            <span className="shiftline__body">
              <span className="shiftline__value shiftline__value--text">
                {transportName(engineer.transport)}
              </span>
              <span className="shiftline__note">
                Транспорт · заявки с другим требованием сюда не попадут
                <WhyMark text={transportWhy(engineer.transport)} />
              </span>
            </span>
          </div>
        )}

        {engineer.phone && (
          <div className="shiftline">
            <span className="shiftline__icon">
              <Icon name="phone" size={16} />
            </span>
            <span className="shiftline__body">
              <span className="shiftline__value shiftline__value--text">{engineer.phone}</span>
              <span className="shiftline__note">
                {[engineer.team, engineer.zone].filter(Boolean).join(' · ') || 'Связь с бригадой'}
              </span>
            </span>
          </div>
        )}

        <section>
          <div className="detail__head">
            <h3 className="detail__subtitle">Навыки</h3>
          </div>
          <div className="skillrow">
            {engineer.skills.map((skill) => (
              <span key={skill} className="skillchip">
                <Icon name={skillIcon(skill)} size={13} />
                {skillName(skill)}
              </span>
            ))}
          </div>
        </section>

        {/* Раньше здесь стояли этапы смены — «в пути», «в работе», «выполнено».
            Они описывают состояние на конкретную минуту, а панель со временем
            не связана, поэтому всё всегда лежало в «запланированы». Вместо них
            то, что у маршрута есть само по себе, независимо от часа. */}
        <section>
          <div className="detail__head">
            <h3 className="detail__subtitle">Маршрут в цифрах</h3>
          </div>
          {route && totals ? (
            <div className="minifunnel">
              <div className="ministage ministage--total">
                <span className="ministage__value">{totals.visits}</span>
                <span className="ministage__label">Визитов за день</span>
              </div>
              <div className="ministage">
                <span className="ministage__value">{Math.round(load.occupancy * 100)}%</span>
                <span className="ministage__label">Загрузка смены</span>
              </div>
              <div className="ministage">
                <span className="ministage__value">{hhmm(totals.start)}</span>
                <span className="ministage__label">Первый визит</span>
              </div>
              <div className="ministage">
                <span className="ministage__value">{hhmm(totals.end)}</span>
                <span className="ministage__label">Последний визит</span>
              </div>
              <div className="ministage">
                <span className="ministage__value">{hoursText(totals.work_minutes)}</span>
                <span className="ministage__label">Работа</span>
              </div>
              <div className="ministage">
                <span className="ministage__value">{hoursText(totals.travel_minutes)}</span>
                <span className="ministage__label">Дорога</span>
              </div>
              <div className="ministage">
                <span className="ministage__value">{hoursText(totals.idle_minutes)}</span>
                <span className="ministage__label">Ожидание окон</span>
              </div>
              <div className={'ministage' + (totals.overtime_minutes > 0 ? ' ministage--overdue' : '')}>
                <span className="ministage__value">{totals.overtime_minutes}</span>
                <span className="ministage__label">Переработка, мин</span>
              </div>
              {/* Вторая обязательная метрика ТЗ — пробег по маршруту каждого
                  исполнителя. Прежде на экране не было ни одного километра. */}
              {totals.distance_km != null && (
                <div className="ministage">
                  <span className="ministage__value">{dec(totals.distance_km, 1)}</span>
                  <span className="ministage__label">Пробег, км</span>
                </div>
              )}
            </div>
          ) : (
            <p className="rmenu__empty">Маршрута на этот день нет — инженер не выезжал.</p>
          )}
          {/* Что выдать утром: под маршрут. Движок кладёт сверх этого по штуке
              каждого прибора запаса — из него и берётся заявка, переданная
              днём от другого исполнителя. */}
          {totals?.equipment && Object.keys(totals.equipment).length > 0 && (
            <p className="detail__why">
              Выдать утром:{' '}
              {equipmentList(
                Object.entries(totals.equipment).flatMap(([kind, count]) =>
                  Array<string>(count).fill(kind)
                )
              )}
              {' '}и по штуке каждого прибора про запас.
            </p>
          )}
        </section>

        <section>
          <div className="detail__head">
            <h3 className="detail__subtitle">День инженера</h3>
          </div>
          <EngineerTimeline
            engineer={engineer}
            route={route}
            view={view}
            onPickOrder={(id) => onSelect({ kind: 'order', id })}
          />
        </section>

        {route && (
          <section>
            <div className="detail__head">
              <h3 className="detail__subtitle">Маршрут</h3>
            </div>
            <div className="rowlist">
              {route.stops.map((stop) => {
                const order = view.orderById.get(stop.order_id);
                if (!order) return null;
                return (
                  <button
                    type="button"
                    className="row"
                    key={stop.order_id}
                    onClick={() => onSelect({ kind: 'order', id: stop.order_id })}
                  >
                    <span className="row__main">
                      <span className="row__title">
                        {stop.seq + 1}. {order.id} · {order.work_title}
                      </span>
                      <span className="row__meta">
                        {/* Адрес идёт первой строкой мелким: маршрут читают
                            сверху вниз как список домов, а не номеров. */}
                        <span className="row__where">{placeOf(order)}</span>
                      </span>
                      <span className="row__meta">
                        <span>
                          {hhmm(stop.start)}–{hhmm(stop.finish)}
                        </span>
                        <span className="row__dot" />
                        <span>Дорога {stop.travel_minutes} мин</span>
                      </span>
                    </span>
                    <span className="row__side">
                      <Badge tone={stop.risk === 'high' ? 'danger' : stop.risk === 'medium' ? 'accent' : 'neutral'}>
                        запас {stop.slack_minutes} мин
                      </Badge>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    );
  }

  const order = view.orderById.get(selection.id);
  if (!order) return null;
  /* Объяснение — утреннего плана. На плане пересчёта исполнитель мог
     смениться, и тогда оно рассказывало бы про другого человека: показываем
     его только там, где исполнитель тот же. */
  const morning = day.explain.orders[order.id];
  const explain =
    morning && morning.assigned_to === (order.assigned_to ?? null) ? morning : undefined;
  const placement = view.stopByOrder.get(order.id);
  /* По границе суток этого дня, а не по настройке оси времени: у выгрузки
     заказчика день кончается в 22:00, и заявка со сроком 22:00 — сегодняшняя,
     а не «можно на завтра». Правило одно с воронкой и колокольчиком. */
  const deferrable = isDeferrable(order, view.hardEnd);

  return (
    <div className="detail enter">
      <div className="detail__top">
        <div>
          <div className="detail__eyebrow">Заявка · {order.id}</div>
          <h2 className="detail__title">{order.work_title}</h2>
          <p className="detail__lede">
            {placeOf(order)} · {order.est_minutes} мин по оценке
          </p>
        </div>
        <CloseCard onClose={close} />
      </div>

      <OrderWindow
        from={order.window_start}
        to={order.window_end}
        arrive={placement?.stop.arrive}
        start={placement?.stop.start}
        finish={placement?.stop.finish}
        risky={placement?.stop.risk === 'high' || placement?.slaBreached}
        hardEnd={view.hardEnd}
      />

      <div className="marks">
        <Complexity minutes={order.est_minutes} />
        {order.priority === 2 && <Badge tone="danger">Авария</Badge>}
        {order.priority === 1 && <Badge tone="accent">Повторный визит</Badge>}
        {deferrable && <Badge tone="outline">Переносима на завтра</Badge>}
        {order.locked_to && <Badge tone="accent">Закреплена диспетчером</Badge>}
        {placement?.slaBreached && <Badge tone="danger">План нарушает срок</Badge>}
      </div>

      {/* Доступ вынесен из общего ряда: это единственная отметка, из-за которой
          инженер может приехать и не попасть внутрь, — её нельзя ставить вровень
          с остальными значками. */}
      {order.needs_access && (
        <div className="accessnote">
          <span className="accessnote__icon">
            <Icon name="house" size={15} />
          </span>
          <span className="accessnote__body">
            <span className="accessnote__title">Нужен доступ в помещение</span>
            <span className="accessnote__note">
              Без встречающего инженер внутрь не попадёт — предупредите клиента заранее.
            </span>
          </span>
        </div>
      )}

      <div className="facts">
        {order.address && <Row k="Адрес" v={order.address} />}
        <Row k="Район" v={order.district} />
        <Row k="Навык" v={skillName(order.skill)} />
        <Row k="Длительность" v={`${order.est_minutes} мин`} />
        {order.required_equipment && order.required_equipment.length > 0 && (
          <Row k="Оборудование" v={equipmentList(order.required_equipment)} />
        )}
        <Row k="Крайний срок" v={deadline(order.sla_deadline)} />
        <Row
          k="Исполнитель"
          v={
            order.assigned_to ? (
              <button
                type="button"
                className="facts__link"
                onClick={() => onSelect({ kind: 'engineer', id: order.assigned_to! })}
              >
                {view.engineerById.get(order.assigned_to)?.name ?? order.assigned_to}
              </button>
            ) : (
              'Не назначен'
            )
          }
        />
      </div>

      {dispatcher && (
        <DispatcherBlock key={order.id} order={order} view={view} dispatcher={dispatcher} />
      )}

      {/* Почему заявка без исполнителя — ТЗ 2.5. Причину движок отдаёт в
          `unassigned_detail`, переходник кладёт её в заявку; прежде до экрана
          она не доходила, и на плане пересчёта не было вовсе ничего. */}
      {!order.assigned_to && order.unassigned_reason && (
        <section>
          <div className="detail__head">
            <h3 className="detail__subtitle">Почему без исполнителя</h3>
          </div>
          <p className="detail__why">
            {order.unassigned_reason.text.charAt(0).toUpperCase() +
              order.unassigned_reason.text.slice(1)}
          </p>
        </section>
      )}

      {explain && (
        <section>
          <div className="detail__head">
            <h3 className="detail__subtitle">Кандидаты</h3>
          </div>
          {/* Объяснение движка стоит здесь, а не в шапке: оно про то, почему
              выбран этот исполнитель, и читается вместе со списком, из которого
              его выбирали. */}
          {(order.assigned_to || !order.unassigned_reason) && (
            <p className="detail__why">
              {explain.summary.charAt(0).toUpperCase() + explain.summary.slice(1)}
            </p>
          )}
          <div className="rowlist">
            {explain.candidates.map((c) => (
              <button
                type="button"
                className="row"
                key={c.engineer_id}
                onClick={() => onSelect({ kind: 'engineer', id: c.engineer_id })}
              >
                <span className="row__main">
                  <span className="row__title">{view.engineerById.get(c.engineer_id)?.name ?? c.engineer_id}</span>
                  <span className="row__meta">
                    {c.note.charAt(0).toUpperCase() + c.note.slice(1)}
                  </span>
                </span>
                <span className="row__side">
                  <Badge tone={VERDICT_TONE[c.verdict] ?? 'outline'}>
                    {VERDICT_LABEL[c.verdict] ?? c.verdict}
                  </Badge>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}


/* Путь до открытого: у страницы он берётся из дерева, у карточки —
   собирается из того, чем она является. */
function crumbs(view: DayView, selection: Selection, trail: CatalogNode[]): string {
  if (trail.length > 0) return ['Справочник', ...trail.map((node) => node.label)].join(' / ');
  if (selection.kind === 'order') {
    const order = view.orderById.get(selection.id);
    return `Справочник / Заявки / ${selection.id}${order ? ' · ' + order.work_title : ''}`;
  }
  if (selection.kind === 'engineer') {
    const engineer = view.engineerById.get(selection.id);
    return `Справочник / Инженеры / ${engineer ? engineer.name : selection.id}`;
  }
  return 'Справочник';
}

/* Ветка дерева. Папка раскрывается на месте, лист открывает страницу —
   ту же самую, что открывают квадраты дашборда и плитки расчёта: ключ
   страницы во всём приложении один. */
function Branch({
  nodes,
  depth,
  open,
  page,
  onToggle,
  onSelect
}: {
  nodes: CatalogNode[];
  depth: number;
  open: Set<string>;
  page: string | null;
  onToggle: (key: string) => void;
  onSelect: (selection: Selection) => void;
}) {
  return (
    <div className={'tree__level' + (depth > 0 ? ' tree__level--nested' : '')}>
      {nodes.map((node) => {
        if (node.children) {
          const isOpen = open.has(node.key);
          return (
            <div key={node.key}>
              <button
                type="button"
                className="tree__row tree__row--folder"
                aria-expanded={isOpen}
                onClick={() => onToggle(node.key)}
              >
                <span className="tree__chev">
                  <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} />
                </span>
                <span className="tree__icon">
                  <Icon name={node.icon ?? 'stack'} size={15} />
                </span>
                <span className="tree__label">{node.label}</span>
                <span className="tree__note">{node.note}</span>
              </button>
              {isOpen && (
                <Branch
                  nodes={node.children}
                  depth={depth + 1}
                  open={open}
                  page={page}
                  onToggle={onToggle}
                  onSelect={onSelect}
                />
              )}
            </div>
          );
        }

        const active = page !== null && node.page === page && !node.alias;
        return (
          <button
            type="button"
            key={node.key}
            className={'tree__row tree__row--leaf' + (active ? ' tree__row--active' : '')}
            aria-current={active ? 'true' : undefined}
            onClick={() => node.page && onSelect({ kind: 'group', id: node.page })}
          >
            <span className="tree__chev" />
            {node.flag && <span className={'tree__dot tree__dot--' + node.flag} />}
            <span className="tree__label">{node.label}</span>
            <span className="tree__note">{node.note}</span>
          </button>
        );
      })}
    </div>
  );
}

/* Правая панель — справочник дня: всё посчитанное разложено по папкам, как в
   проводнике. Открытое встаёт сверху, дерево остаётся под ним и не
   схлопывается: проводник тоже не закрывает папки, когда открываешь файл. */
export function DetailPanel({ day, view, selection, onSelect, dispatcher }: Props) {
  /* Справочник считается на начало смены и дальше не двигается. Правая панель
     отвечает на вопрос «что это за объект», а не «что с ним сейчас»: когда её
     содержимое ехало вместе с ползунком, открытый список менялся под руками —
     диспетчер листал одно, а через секунду читал другое. */
  const catalogue = useMemo(() => buildCatalogue(view, panelCut()), [view]);
  const page = selection.kind === 'group' ? selection.id : null;
  const trail = page ? trailToPage(catalogue, page) : [];
  /* Все папки свёрнуты: панель начинается со списка разделов, а не с чужого
     раскрытого блока. Раскрывается то, что открыли сами — или то, куда увёл
     щелчок по числу на дашборде. */
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  /* Открыли страницу со стороны — из этапов или с плитки расчёта — и папки,
     в которых она лежит, раскрываются сами: иначе в дереве не видно, где ты. */
  const branchKeys = trail.slice(0, -1).map((node) => node.key).join('|');
  useEffect(() => {
    if (branchKeys === '') return;
    setOpen((prev) => new Set([...prev, ...branchKeys.split('|')]));
  }, [branchKeys]);

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="rpanel">
      <div className="rpanel__head">
        <h2 className="detail__title">Справочник</h2>
        <p className="detail__lede">Результаты расчёта по заданным параметрам.</p>
      </div>

      {/* Открытое ложится поверх справочника отдельным слоем и закрывается
          крестиком: дерево под ним никуда не уезжает и не листается вместе
          с карточкой. */}
      {selection.kind !== 'overview' && (
        <div className="rpanel__open">
          <div className="rpanel__bar">
            <span className="rpanel__trail">{crumbs(view, selection, trail)}</span>
            <button
              type="button"
              className="rpanel__x"
              onClick={() => onSelect(OVERVIEW)}
              aria-label="Закрыть и вернуться к справочнику"
            >
              <Icon name="x" size={16} />
            </button>
          </div>
          <SelectedCard
            day={day}
            view={view}
            selection={selection}
            onSelect={onSelect}
            dispatcher={dispatcher}
          />
        </div>
      )}

      <Branch
        nodes={catalogue}
        depth={0}
        open={open}
        page={page}
        onToggle={toggle}
        onSelect={onSelect}
      />
    </div>
  );
}
