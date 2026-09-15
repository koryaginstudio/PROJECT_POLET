import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm, placeOf, visits } from '../data/derive.ts';
import { routeColor } from './MapBoard.tsx';
import { routeLabel, routeNumber } from '../data/routeIds.ts';

interface Props {
  view: DayView;
  /** Расчёт, чей план открыт: вместе с инженером он и опознаёт маршрут, а
      значит, даёт его собственный номер. */
  runId: string;
  /** Маршрут, подсвеченный на карте прямо сейчас. */
  live: string | null;
  /** Закреплённый щелчком: остаётся подсвеченным, когда мышь ушла. */
  pinned: string | null;
  onLive: (engineerId: string | null) => void;
  /** Щелчок: подсветить и приблизить карту к этому маршруту. */
  onFocus: (engineerId: string) => void;
  /** Выбранная заявка — её же подсвечивает карта. */
  selectedOrder: string | null;
  /** Щелчок по заявке: открыть её и показать на карте. */
  onSelectOrder: (id: string) => void;
}

/* Правая панель раздела «Карта»: два списка вместо справочника.

   Карта отвечает на «где». Панель — на «во сколько и что», и раньше только
   со стороны инженера: развернул маршрут, прочитал его день. Но диспетчеру
   столь же часто нужен обратный вход — от заявки. Позвонил абонент, назвал
   номер или улицу; вопрос не «что у Волкова», а «кто едет на Ельнинскую и
   когда».

   Поэтому списка два, и они отвечают на встречные вопросы. Маршруты — от
   человека к его дню. Заявки — от заявки к тому, кто её везёт. Открыт
   всегда один: оба разом занимают вдвое больше места и заставляют выбирать
   глазами то, что уже выбрано переключателем.

   Щелчок в любом из них показывает выбранное на карте. Разница в том, что
   выделяется: маршрут подсвечивает путь целиком и приближает к нему, заявка
   открывает свою карточку и подсвечивает маршрут, в который попала, — то
   есть отвечает ровно на «в каком она маршруте». */

type Tab = 'routes' | 'orders';

/* Чем отбирают заявки. Не фильтры «по всем полям», а три вопроса, которые
   диспетчер задаёт на карте: что под угрозой, что никто не взял, что
   вообще есть. */
type Sieve = 'all' | 'risk' | 'loose';

const SIEVES: { value: Sieve; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'risk', label: 'Под угрозой' },
  { value: 'loose', label: 'Без инженера' }
];

export function RoutePanel({
  view,
  runId,
  live,
  pinned,
  onLive,
  onFocus,
  selectedOrder,
  onSelectOrder
}: Props) {
  const rows = useRef<Map<string, HTMLButtonElement>>(new Map());
  const orderRows = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [tab, setTab] = useState<Tab>('routes');
  const [sieve, setSieve] = useState<Sieve>('all');
  const [query, setQuery] = useState('');

  /* Маршрут выбирают и на карте тоже — тогда панель сама показывает его.

     Переключить вкладку недостаточно было бы объяснить «для удобства»:
     без этого щелчок по пути на карте уходил в никуда, если открыты были
     заявки. Выбор сделан, подсветка на карте появилась, а список рядом
     показывает что-то другое — и человек решает, что не сработало.

     Прокрутка ко строке нужна отдельно: маршрут может быть десятым из
     двенадцати, и переключённая вкладка открылась бы на первом. */
  useEffect(() => {
    if (!pinned) return;
    setTab('routes');
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    /* Через кадр: вкладка только что сменилась, и строки в разметке ещё нет,
       а значит и подводить не к чему. */
    const id = requestAnimationFrame(() =>
      rows.current.get(pinned)?.scrollIntoView({
        block: 'nearest',
        behavior: calm ? 'auto' : 'smooth'
      })
    );
    return () => cancelAnimationFrame(id);
  }, [pinned]);

  /* То же для заявки: щёлкнули по точке на карте — строка подъезжает сама.
     И вкладка переключается на заявки, иначе список молча листался бы
     под закрытой вкладкой. */
  useEffect(() => {
    if (!selectedOrder) return;
    setTab('orders');
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    orderRows.current.get(selectedOrder)?.scrollIntoView({
      block: 'nearest',
      behavior: calm ? 'auto' : 'smooth'
    });
  }, [selectedOrder]);

  const routes = view.loads.filter((load) => load.route && load.route.stops.length > 0);
  const idle = view.loads.filter((load) => !load.route || load.route.stops.length === 0);

  const colorOf = (engineerId: string) =>
    routeColor(view.loads.findIndex((item) => item.engineer.id === engineerId));

  /* Заявки с тем, что про них известно из плана: кто везёт, во сколько и
     насколько впритык. Порядок — по времени визита, а невзятые в конце:
     у них времени нет, и ставить их между визитами значило бы придумать
     им место в дне, которого им как раз и не нашлось. */
  const orders = useMemo(() => {
    const list = [...view.orderById.values()].map((order) => {
      const placement = view.stopByOrder.get(order.id);
      const engineer = placement ? view.engineerById.get(placement.engineerId) : undefined;
      const risky = placement
        ? placement.slaBreached || placement.stop.risk !== 'low'
        : false;
      return { order, placement, engineer, risky };
    });

    const needle = query.trim().toLowerCase();
    return list
      .filter((item) => {
        if (sieve === 'risk' && !item.risky) return false;
        if (sieve === 'loose' && item.placement) return false;
        if (!needle) return true;
        return (
          item.order.id.toLowerCase().includes(needle) ||
          item.order.work_title.toLowerCase().includes(needle) ||
          placeOf(item.order).toLowerCase().includes(needle) ||
          (item.engineer?.name ?? '').toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        if (!a.placement && !b.placement) return a.order.id.localeCompare(b.order.id);
        if (!a.placement) return 1;
        if (!b.placement) return -1;
        return a.placement.stop.start - b.placement.stop.start;
      });
  }, [view, sieve, query]);

  const riskCount = useMemo(
    () =>
      [...view.stopByOrder.values()].filter((p) => p.slaBreached || p.stop.risk !== 'low').length,
    [view]
  );

  return (
    <div className="rpanel">
      <div className="rpanel__head">
        {/* Заголовок остаётся заголовком панели, а переключатель под ним
            выбирает угол зрения. Сначала я заменил заголовок вкладками — и
            панель потеряла имя: у соседних оно есть, и без него она читалась
            как оторванный от чего-то список. Вопросов два, имя одно. */}
        <h2 className="detail__title">Что на карте</h2>
        <div className="rtabs" role="tablist" aria-label="Что показывать">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'routes'}
            className={'rtabs__item' + (tab === 'routes' ? ' rtabs__item--on' : '')}
            onClick={() => setTab('routes')}
          >
            Маршруты
            <span className="rtabs__count">{routes.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'orders'}
            className={'rtabs__item' + (tab === 'orders' ? ' rtabs__item--on' : '')}
            onClick={() => setTab('orders')}
          >
            Заявки
            <span className="rtabs__count">{view.orderById.size}</span>
          </button>
        </div>
        <p className="rpanel__note">
          {tab === 'routes'
            ? 'День инженера по порядку визитов. Наведение подсвечивает путь на карте, щелчок приближает к нему.'
            : 'Обратный вход: от заявки к тому, кто её везёт. Щелчок открывает карточку и подсвечивает её маршрут.'}
        </p>
      </div>

      {tab === 'routes' ? (
        <div className="rlist">
          {routes.map((load) => {
            const color = colorOf(load.engineer.id);
            const locked = pinned !== null && pinned !== load.engineer.id;
            const open = pinned === load.engineer.id;
            const stops = load.route!.stops;
            return (
              <button
                key={load.engineer.id}
                type="button"
                ref={(node) => {
                  if (node) rows.current.set(load.engineer.id, node);
                  else rows.current.delete(load.engineer.id);
                }}
                className={
                  'rlist__row' +
                  (live === load.engineer.id ? ' rlist__row--on' : '') +
                  (pinned === load.engineer.id ? ' rlist__row--pinned' : '')
                }
                disabled={locked}
                onMouseEnter={() => !locked && onLive(load.engineer.id)}
                onMouseLeave={() => onLive(null)}
                onFocus={() => !locked && onLive(load.engineer.id)}
                onBlur={() => onLive(null)}
                onClick={() => onFocus(load.engineer.id)}
              >
                <span className="rlist__mark" style={{ background: color }} />

                <span className="rlist__body">
                  <span className="rlist__top">
                    <span className="rlist__name">{load.engineer.name}</span>
                    <span className="rlist__load">{Math.round(load.occupancy * 100)}%</span>
                  </span>
                  {/* Номер маршрута первым: маршрут называют им, а не фамилией
                      инженера — фамилия отвечает «кто едет», номер отвечает
                      «какой это маршрут» и не повторяется во всей базе. */}
                  <span className="rlist__meta">
                    {routeLabel(routeNumber(runId, load.engineer.id))} · {visits(load.visits)} ·{' '}
                    {hhmm(stops[0].arrive)}–{hhmm(stops[stops.length - 1].finish)}
                  </span>

                  {/* Сам маршрут по порядку: номер, время визита и заявка.
                      Раскрывается только у выбранного — двенадцать развёрнутых
                      списков разом читать невозможно. */}
                  {open && (
                    <span className="rstops">
                      {stops.map((stop, index) => {
                        const order = view.orderById.get(stop.order_id);
                        const placement = view.stopByOrder.get(stop.order_id);
                        const risky = placement
                          ? placement.slaBreached || placement.stop.risk !== 'low'
                          : false;
                        return (
                          <span className="rstops__row" key={stop.order_id}>
                            <span className={'rstops__no' + (risky ? ' rstops__no--risk' : '')}>
                              {index + 1}
                            </span>
                            <span className="rstops__time">{hhmm(stop.start)}</span>
                            <span className="rstops__what">
                              {order ? `${order.id} · ${order.work_title}` : stop.order_id}
                              {order && <span className="rstops__where"> · {placeOf(order)}</span>}
                            </span>
                          </span>
                        );
                      })}
                    </span>
                  )}
                </span>
              </button>
            );
          })}

          {idle.length > 0 && (
            <p className="rlist__empty">
              Без маршрута: {idle.map((load) => load.engineer.name).join(', ')}
            </p>
          )}
        </div>
      ) : (
        <>
          {/* Отбор и поиск. Восемьдесят заявок глазами не просматривают:
              либо ищут конкретную по номеру или улице, либо смотрят одну из
              двух групп, из-за которых на карту и заходят. */}
          <div className="rsieve">
            <div className="rsieve__row">
              {SIEVES.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={'chip' + (sieve === item.value ? ' chip--on' : '')}
                  onClick={() => setSieve(item.value)}
                >
                  {item.label}
                  {item.value === 'risk' && riskCount > 0 && (
                    <span className="rsieve__num">{riskCount}</span>
                  )}
                  {item.value === 'loose' && view.unassigned.length > 0 && (
                    <span className="rsieve__num">{view.unassigned.length}</span>
                  )}
                </button>
              ))}
            </div>
            <label className="dbsearch">
              <Icon name="search" size={14} />
              <input
                className="dbsearch__input"
                value={query}
                placeholder="Номер, адрес или фамилия"
                onChange={(e) => setQuery(e.currentTarget.value)}
              />
              {query && (
                <button type="button" className="dbsearch__clear" onClick={() => setQuery('')}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </label>
          </div>

          <div className="rlist">
            {orders.length === 0 && (
              <p className="rlist__empty">
                Под этот отбор не попала ни одна заявка. Снимите фильтр или поищите по номеру.
              </p>
            )}

            {orders.map(({ order, placement, engineer, risky }) => (
              <button
                key={order.id}
                type="button"
                ref={(node) => {
                  if (node) orderRows.current.set(order.id, node);
                  else orderRows.current.delete(order.id);
                }}
                className={
                  'rlist__row rlist__row--order' +
                  (selectedOrder === order.id ? ' rlist__row--pinned' : '') +
                  (placement && live === placement.engineerId ? ' rlist__row--on' : '')
                }
                /* Наведение подсвечивает маршрут, в котором заявка едет:
                   это и есть ответ на «в каком она маршруте», и он приходит
                   раньше щелчка. */
                onMouseEnter={() => placement && onLive(placement.engineerId)}
                onMouseLeave={() => onLive(null)}
                onClick={() => onSelectOrder(order.id)}
              >
                {/* Цветная метка — того маршрута, в который заявка попала.
                    У невзятой метки нет: ей нечего обозначать, и серая
                    полоска врала бы про маршрут, которого не существует. */}
                <span
                  className={'rlist__mark' + (placement ? '' : ' rlist__mark--none')}
                  style={placement ? { background: colorOf(placement.engineerId) } : undefined}
                />

                <span className="rlist__body">
                  <span className="rlist__top">
                    <span className="rlist__name">
                      {order.id}
                      <span className="rlist__work"> · {order.work_title}</span>
                    </span>
                    {placement ? (
                      <span className={'rlist__load' + (risky ? ' rlist__load--risk' : '')}>
                        {hhmm(placement.stop.start)}
                      </span>
                    ) : (
                      <span className="rlist__load rlist__load--risk">нет</span>
                    )}
                  </span>
                  <span className="rlist__meta">{placeOf(order)}</span>
                  <span className="rlist__meta">
                    {placement ? (
                      <>
                        {engineer?.name ?? placement.engineerId} · визит №{placement.stop.seq + 1}
                        {risky
                          ? placement.slaBreached
                            ? ' · срок нарушен'
                            : ` · запас ${placement.stop.slack_minutes} мин`
                          : ''}
                      </>
                    ) : (
                      <>Никто не взял · окно {hhmm(order.window_start)}–{hhmm(order.window_end)}</>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
