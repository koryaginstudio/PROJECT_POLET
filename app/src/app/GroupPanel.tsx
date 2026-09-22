import { useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView, StatusSplit } from '../data/derive.ts';
import { buildCrewBoard, buildOrdersBoard, dec, hhmm, hoursText, orders as pluralOrders, placeOf, plural, visits } from '../data/derive.ts';
import { Donut } from './Donut.tsx';
import { photosFor } from '../data/photos.ts';
import type { Selection } from './selection.ts';

interface Props {
  day: Day;
  /** Имя группы — панель соберёт её содержимое сама. */
  groupId?: string;
  /** Либо готовая форма: список, снятый в момент щелчка. */
  shape?: Shape;
  view: DayView;
  cut: number;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
}

interface Section {
  key: string;
  label: string;
  orderIds?: string[];
  engineerIds?: string[];
}

export interface Shape {
  eyebrow: string;
  title: string;
  /** Кольцо над числами: из чего сложилась метрика. */
  chart?: { title: string; slices: StatusSplit[]; centerValue: number; centerCaption: string };
  sections: Section[];
  /** Один плоский список вместо разбивки. */
  flat?: boolean;
  /** Страница-таблица: не список объектов, а числа по строкам. */
  facts?: { key: string; label: string; value: string }[];
}

/* Карточка числа с пульта расчёта.

   Раньше щелчок по «Покрытию» открывал список проблемных заявок, по «Общему
   простою» — список инженеров с маршрутом: показывали соседнее, а не само
   число. Здесь каждое число объясняет себя: из чего сложилось, что стоит за
   ним и куда идти дальше. Кольцо не кликается — это разбор величины, а не
   список.

   Ничего нового не считаем: все доли берутся из тех же маршрутов и той же
   симуляции, что и число на пульте. */
function metricShape(groupId: string, view: DayView, day: Day): Shape | null {
  const sum = (pick: (totals: { travel_minutes: number; work_minutes: number; idle_minutes: number }) => number) =>
    view.loads.reduce((acc, load) => acc + (load.route ? pick(load.route.totals) : 0), 0);

  switch (groupId) {
    case 'metric:coverage': {
      const total = day.plan.meta.orders_total;
      const done = Math.round(day.simulation.done.p50);
      const assigned = day.plan.meta.orders_assigned;
      return {
        eyebrow: 'Число расчёта',
        title: 'Покрытие',
        chart: {
          title: 'Что будет с заявками',
          centerValue: total,
          centerCaption: 'Всего',
          slices: [
            { key: 'done', label: 'Доедут', count: done, ids: [], tone: 'ok' },
            {
              key: 'lost',
              label: 'Сорвутся в пути',
              count: Math.max(0, assigned - done),
              ids: [],
              tone: 'bad'
            },
            {
              key: 'free',
              label: 'Без инженера',
              count: total - assigned,
              ids: [],
              tone: 'wait'
            }
          ]
        },
        facts: [
          { key: 'p50', label: 'Половина расчётов лучше, чем', value: pluralOrders(done) },
          { key: 'p10', label: 'Худшие расчёты', value: pluralOrders(Math.round(day.simulation.done.p10)) },
          { key: 'p90', label: 'Лучшие расчёты', value: pluralOrders(Math.round(day.simulation.done.p90)) },
          { key: 'exec', label: 'Доезжает от разложенного', value: `${dec(day.simulation.execution_rate)} %` }
        ],
        sections: [
          { key: 'free', label: 'Не получили инженера', orderIds: view.unassigned.map((o) => o.id) }
        ]
      };
    }

    case 'metric:idle': {
      const idle = sum((t) => t.idle_minutes);
      const work = sum((t) => t.work_minutes);
      const travel = sum((t) => t.travel_minutes);
      const withRoute = view.loads.filter((load) => load.route).length;
      return {
        eyebrow: 'Число расчёта',
        title: 'Общий простой',
        chart: {
          title: 'Из чего сложилась смена',
          centerValue: Math.round((work + travel + idle) / 60),
          centerCaption: 'Часов',
          slices: [
            { key: 'work', label: 'Работа', count: Math.round(work / 60), ids: [], tone: 'ok' },
            { key: 'travel', label: 'Дорога', count: Math.round(travel / 60), ids: [], tone: 'wait' },
            { key: 'idle', label: 'Ожидание', count: Math.round(idle / 60), ids: [], tone: 'bad' }
          ]
        },
        facts: [
          { key: 'all', label: 'Всего ожидания', value: hoursText(idle) },
          {
            key: 'avg',
            label: 'В среднем на инженера',
            value: withRoute ? `${dec(idle / 60 / withRoute)} ч` : '—'
          },
          {
            key: 'share',
            label: 'Доля от смены',
            value: `${Math.round((idle / Math.max(1, work + travel + idle)) * 100)} %`
          }
        ],
        sections: [
          {
            key: 'free',
            label: 'Совсем без визитов за день',
            engineerIds: view.loads.filter((load) => load.idle).map((load) => load.engineer.id)
          }
        ]
      };
    }

    /* Две обязательные метрики ТЗ. Разбор — против базового варианта ТЗ:
       без него число задействованных людей и километры ни с чем не
       сравнить, а сравнение ТЗ требует прямо. */
    case 'metric:engineers': {
      const plan = day.plan;
      const base = plan.meta.baseline ?? null;
      const withRoute = view.loads.filter((load) => load.route && load.route.stops.length > 0);
      return {
        eyebrow: 'Метрика ТЗ',
        title: 'Исполнителей задействовано',
        facts: [
          { key: 'used', label: 'В этом плане', value: String(withRoute.length) },
          { key: 'base', label: 'Базовый вариант ТЗ', value: base ? String(base.engineers_used) : '—' },
          { key: 'staff', label: 'В штате', value: String(plan.meta.engineers_total) },
          {
            key: 'assigned',
            label: 'Разложено заявок',
            value: base
              ? `${plan.meta.orders_assigned} · базовый ${base.orders_assigned}`
              : String(plan.meta.orders_assigned)
          }
        ],
        sections: [
          { key: 'used', label: 'С маршрутом', engineerIds: withRoute.map((load) => load.engineer.id) },
          {
            key: 'free',
            label: 'Без визитов за день',
            engineerIds: view.loads.filter((load) => load.idle).map((load) => load.engineer.id)
          }
        ]
      };
    }

    case 'metric:km': {
      const plan = day.plan;
      const base = plan.meta.baseline ?? null;
      const withKm = view.loads
        .filter((load) => load.route && load.route.totals.distance_km != null)
        .sort((a, b) => (b.route!.totals.distance_km ?? 0) - (a.route!.totals.distance_km ?? 0));
      const total = plan.meta.distance_km_total ?? null;
      const perVisit = total !== null && plan.meta.orders_assigned > 0 ? total / plan.meta.orders_assigned : null;
      const basePerVisit =
        base && base.distance_km_total != null && base.orders_assigned > 0
          ? base.distance_km_total / base.orders_assigned
          : null;
      return {
        eyebrow: 'Метрика ТЗ',
        title: 'Пробег',
        facts: [
          { key: 'total', label: 'Всего по плану', value: total === null ? '—' : `${dec(total, 0)} км` },
          { key: 'visit', label: 'На назначенный визит', value: perVisit === null ? '—' : `${dec(perVisit, 2)} км` },
          {
            key: 'engineer',
            label: 'На исполнителя',
            value: total === null || withKm.length === 0 ? '—' : `${dec(total / withKm.length, 1)} км`
          },
          {
            key: 'base',
            label: 'Базовый вариант ТЗ',
            value:
              base && base.distance_km_total != null
                ? `${dec(base.distance_km_total, 0)} км · ${basePerVisit === null ? '—' : dec(basePerVisit, 2)} на визит`
                : '—'
          }
        ],
        sections: [
          {
            key: 'routes',
            label: 'Маршруты, от длинного к короткому',
            engineerIds: withKm.map((load) => load.engineer.id)
          }
        ]
      };
    }

    case 'metric:spread':
    case 'metric:gini': {
      const balance = day.plan.meta.balance;
      const busy = view.loads.filter((load) => load.route);
      const mean = balance.occupancy_mean;
      const above = busy.filter((load) => load.occupancy > mean + 0.1);
      const below = busy.filter((load) => load.occupancy < mean - 0.1);
      const even = busy.filter((load) => Math.abs(load.occupancy - mean) <= 0.1);
      const gini = groupId === 'metric:gini';
      return {
        eyebrow: 'Число расчёта',
        title: gini ? 'Неравномерность' : 'Разрыв загрузки',
        chart: {
          title: 'Как разошлась загрузка',
          centerValue: busy.length,
          centerCaption: 'С маршрутом',
          slices: [
            { key: 'above', label: 'Выше среднего', count: above.length, ids: above.map((l) => l.engineer.id), tone: 'bad' },
            { key: 'even', label: 'Около среднего', count: even.length, ids: even.map((l) => l.engineer.id), tone: 'ok' },
            { key: 'below', label: 'Ниже среднего', count: below.length, ids: below.map((l) => l.engineer.id), tone: 'wait' }
          ]
        },
        facts: [
          { key: 'min', label: 'Самый свободный', value: `${Math.round(balance.occupancy_min * 100)} %` },
          { key: 'max', label: 'Самый загруженный', value: `${Math.round(balance.occupancy_max * 100)} %` },
          { key: 'mean', label: 'В среднем', value: `${Math.round(mean * 100)} %` },
          { key: 'gini', label: 'Неравномерность', value: dec(balance.gini, 2) },
          {
            key: 'idle',
            label: 'Совсем без работы',
            value: plural(balance.idle_engineers, 'инженер', 'инженера', 'инженеров')
          }
        ],
        sections: [
          {
            key: 'crew',
            label: 'Инженеры по загрузке',
            engineerIds: [...busy]
              .sort((a, b) => b.occupancy - a.occupancy)
              .map((load) => load.engineer.id)
          }
        ]
      };
    }

    default:
      return null;
  }
}

function shapeOf(groupId: string, view: DayView, cut: number, day: Day): Shape | null {
  const orders = buildOrdersBoard(view, cut);
  const crew = buildCrewBoard(view);

  /* Карточки чисел с пульта. Каждая объясняет своё число и показывает, из чего
     оно сложилось, — а не отправляет в чужой список, где этого числа нет. */
  const metric = metricShape(groupId, view, day);
  if (metric) return metric;

  switch (groupId) {
    case 'problems':
      return {
        eyebrow: 'Заявки',
        title: 'Проблемные',
        sections: orders.problemBuckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          orderIds: bucket.orderIds
        }))
      };
    case 'unassigned': {
      /* Делим по сроку, а не по тому, открылось ли окно к текущей минуте.
         Панель не связана с ползунком времени, поэтому деление «окно уже
         идёт / ещё впереди» здесь было бессмысленным: первая корзина всегда
         оказывалась пустой. Крайний срок — свойство самой заявки, оно не
         зависит от того, который сейчас час. */
      const deferrable = new Set(view.deferrable.map((order) => order.id));
      const all = view.unassigned.map((order) => order.id);
      const today = all.filter((id) => !deferrable.has(id));
      const later = all.filter((id) => deferrable.has(id));
      return {
        eyebrow: 'Заявки',
        title: 'Без инженера',
        sections: [
          { key: 'today', label: 'Срок истекает сегодня', orderIds: today },
          { key: 'later', label: 'Можно перенести на завтра', orderIds: later }
        ]
      };
    }
    case 'all':
      return {
        eyebrow: 'Заявки',
        title: 'Все заявки смены',
        flat: true,
        sections: [{ key: 'all', label: 'Вся смена', orderIds: [...view.orderById.keys()] }]
      };
    case 'crew-all':
      return {
        eyebrow: 'Инженеры',
        title: 'Все инженеры',
        flat: true,
        sections: [{ key: 'all', label: 'Бригада', engineerIds: view.loads.map((l) => l.engineer.id) }]
      };
    case 'inwork':
      return {
        eyebrow: 'Заявки',
        title: 'С инженером',
        flat: true,
        sections: [{ key: 'inwork', label: 'С исполнителем', orderIds: [...view.stopByOrder.keys()] }]
      };
    case 'crew-problems':
      return {
        eyebrow: 'Инженеры',
        title: 'Проблемные',
        sections: crew.problemBuckets.map((bucket) => ({
          key: bucket.key,
          label: bucket.label,
          engineerIds: bucket.engineerIds
        }))
      };
    case 'crew-free':
      return {
        eyebrow: 'Инженеры',
        title: 'Свободны',
        flat: true,
        sections: [{ key: 'free', label: 'Ни одного визита за день', engineerIds: crew.freeIds }]
      };
    case 'tight':
      return {
        eyebrow: 'Заявки',
        title: 'Стоят впритык',
        flat: true,
        sections: [
          {
            key: 'tight',
            label: 'Без запаса',
            orderIds: [...view.stopByOrder.entries()]
              .filter(([, placement]) => placement.stop.risk !== 'low')
              .map(([id]) => id)
          }
        ]
      };
    case 'fragile':
      return {
        eyebrow: 'Симуляция',
        title: 'Прозвонить на завтра',
        flat: true,
        sections: [
          {
            key: 'fragile',
            label: 'Держатся на честном слове',
            orderIds: view.fragile.map((f) => f.order.id)
          }
        ]
      };
    case 'reasons':
      return {
        eyebrow: 'Симуляция',
        title: 'Причины срывов',
        sections: [],
        facts: view.reasons.map((reason) => ({
          key: reason.key,
          label: reason.label,
          value: `${dec(reason.value)} заявки`
        }))
      };
    case 'crew-onshift':
      return {
        eyebrow: 'Инженеры',
        title: 'С маршрутом',
        flat: true,
        sections: [
          { key: 'onshift', label: 'С маршрутом', engineerIds: view.loads.filter((l) => !l.idle).map((l) => l.engineer.id) }
        ]
      };
    default:
      if (groupId.startsWith('type:')) {
        const key = groupId.slice(5);
        const type = orders.byType.find((t) => t.key === key);
        if (!type) return null;
        return {
          eyebrow: 'Вид работ',
          title: type.title,
          flat: true,
          sections: [{ key, label: type.title, orderIds: type.orderIds }]
        };
      }
      if (groupId.startsWith('skill:')) {
        const key = groupId.slice(6);
        const skill = crew.bySkill.find((s) => s.key === key);
        if (!skill) return null;
        return {
          eyebrow: 'Навык',
          title: skill.label,
          flat: true,
          sections: [{ key, label: skill.label, engineerIds: skill.engineerIds }]
        };
      }
      return null;
  }
}

export function GroupPanel({ day, groupId, shape: ready, view, cut, onSelect, onClose }: Props) {
  const shape = ready ?? (groupId ? shapeOf(groupId, view, cut, day) : null);
  /* Снимки раздаются на весь штат смены разом: раздача считается из всего
     списка табельных, и по одному человеку её не получить. */
  const photos = photosFor(view.loads.map((load) => load.engineer));
  const photoOf = (id: string) => photos.get(id);
  /* Разделы свёрнуты по умолчанию: панель открывается коротким оглавлением, а
     не простынёй из сотни строк — сначала видно, что внутри и сколько чего, и
     только потом раскрывают нужное. Храним раскрытые, а не свёрнутые.

     Ключ страницы в состоянии — чтобы при переходе к другой группе раскрытые
     разделы прошлой не оставались открытыми. */
  const [opened, setOpened] = useState<{ page: string; keys: Set<string> }>({
    page: '',
    keys: new Set()
  });
  const page = groupId ?? shape?.title ?? '';
  const isOpened = (key: string) => opened.page === page && opened.keys.has(key);

  if (!shape) return null;

  return (
    <div className="detail enter">
      <div className="detail__top">
        <div>
          <div className="detail__eyebrow">{shape.eyebrow}</div>
          <h2 className="detail__title">{shape.title}</h2>
        </div>
        <button type="button" className="detail__close" onClick={onClose} aria-label="Закрыть и вернуться к меню">
          <Icon name="x" size={16} />
        </button>
      </div>

      {shape.chart && (
        <div className="gchart">
          <Donut
            title={shape.chart.title}
            slices={shape.chart.slices}
            centerValue={shape.chart.centerValue}
            centerCaption={shape.chart.centerCaption}
          />
        </div>
      )}

      {shape.facts && (
        <div className="facts">
          {shape.facts.map((fact) => (
            <div className="facts__row" key={fact.key}>
              <span className="facts__key">{fact.label}</span>
              <span className="facts__val">{fact.value}</span>
            </div>
          ))}
        </div>
      )}

      {shape.sections.map((section) => {
        const total = (section.orderIds?.length ?? 0) + (section.engineerIds?.length ?? 0);
        const isOpen = shape.flat || isOpened(section.key);

        return (
          <section key={section.key} className="gpanel">
            {!shape.flat && (
              <button
                type="button"
                className="rmenu__item"
                aria-expanded={isOpen}
                onClick={() =>
                  setOpened((prev) => {
                    const keys = new Set(prev.page === page ? prev.keys : []);
                    if (keys.has(section.key)) keys.delete(section.key);
                    else keys.add(section.key);
                    return { page, keys };
                  })
                }
              >
                <span className="rmenu__label">{section.label}</span>
                <span className="rmenu__count">{total}</span>
                {/* Стрелка вместо крестика: она поворачивается и тем самым
                    показывает, что раздел свернётся, а не закроется совсем. */}
                <span className={'rmenu__chev' + (isOpen ? ' rmenu__chev--open' : '')}>
                  <Icon name="chevron-down" size={14} />
                </span>
              </button>
            )}

            {isOpen && total === 0 && (
              <p className="rmenu__empty">Здесь пусто — и это хорошая новость.</p>
            )}

            {isOpen && total > 0 && (
              <div className="rowlist">
                {section.orderIds?.map((id) => {
                  const order = view.orderById.get(id);
                  if (!order) return null;
                  const fragile = view.fragile.find((f) => f.order.id === id);
                  return (
                    <button
                      type="button"
                      key={id}
                      className="row"
                      onClick={() => onSelect({ kind: 'order', id })}
                    >
                      <span className="row__main">
                        <span className="row__title">
                          <span className="row__code">{order.id}</span>
                          {order.work_title} · {placeOf(order)}
                        </span>
                        <span className="row__meta">
                          <span>
                            окно {hhmm(order.window_start)}–{hhmm(order.window_end)}
                          </span>
                        </span>
                      </span>
                      <span className="row__side">
                        {fragile ? (
                          <Badge tone="danger">Срывов {dec(fragile.failureRate)}%</Badge>
                        ) : (
                          hhmm(order.window_start)
                        )}
                      </span>
                    </button>
                  );
                })}

                {section.engineerIds?.map((id) => {
                  const load = view.loads.find((l) => l.engineer.id === id);
                  if (!load) return null;
                  return (
                    <button
                      type="button"
                      key={id}
                      className="row"
                      onClick={() => onSelect({ kind: 'engineer', id })}
                    >
                      {/* Лицо перед именем: в справочнике инженеров ищут
                          человека, а человека узнают по лицу быстрее, чем
                          прочитывают фамилию. Снимок раздаёт стенд — тот же,
                          что в базе инженеров, чтобы один человек не оказался
                          с двумя лицами в двух разделах. */}
                      <img className="row__face" src={photoOf(id)} alt="" loading="lazy" />
                      <span className="row__main">
                        <span className="row__title">{load.engineer.name}</span>
                        <span className="row__meta">
                          <span>{visits(load.visits)}</span>
                          <span className="row__dot" />
                          <span>{load.engineer.skills.join(', ')}</span>
                        </span>
                      </span>
                      <span className="row__side">{Math.round(load.occupancy * 100)}%</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
