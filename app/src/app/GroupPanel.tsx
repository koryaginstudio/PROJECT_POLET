import { useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView, StatusSplit } from '../data/derive.ts';
import {
  buildCrewBoard,
  buildOrdersBoard,
  dec,
  engineersUsed,
  hhmm,
  hoursText,
  orders as pluralOrders,
  placeOf,
  plural,
  replanAt,
  visits
} from '../data/derive.ts';
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
  /* Пересчёт — план остатка дня: у него разбор говорит, про какой отрезок
     числа, и не сравнивает их с базовым вариантом, считанным на день
     целиком (см. `buildDayView`). */
  const restFrom = replanAt(day.plan);
  const rest = restFrom === null ? null : `Остаток дня с ${hhmm(restFrom)}`;

  switch (groupId) {
    /* Покрытие — твёрдый счёт: у скольких заявок есть инженер. Здесь нет
       ни одного числа из симуляции, поэтому кольцо делится надвое и сходится
       с подписью под плиткой. Прогноз стоит отдельной строкой и назван
       прогнозом, чтобы его не прочитали как факт. */
    case 'metric:assigned': {
      const total = day.plan.meta.orders_total;
      const assigned = day.plan.meta.orders_assigned;
      return {
        eyebrow: rest ?? 'Число расчёта',
        title: rest === null ? 'Покрытие' : 'Покрытие в остатке дня',
        chart: {
          title: rest === null ? 'У скольких заявок есть инженер' : 'Как разложен остаток дня',
          centerValue: total,
          centerCaption: 'Заявок',
          slices: [
            { key: 'assigned', label: 'С инженером', count: assigned, ids: [], tone: 'ok' },
            { key: 'free', label: 'Без инженера', count: total - assigned, ids: [], tone: 'wait' }
          ]
        },
        facts: [
          { key: 'assigned', label: 'С инженером', value: pluralOrders(assigned) },
          { key: 'free', label: 'Без инженера', value: pluralOrders(total - assigned) },
          {
            key: 'forecast',
            label:
              rest === null
                ? 'Прогноз выполнения — сколько из назначенных доедет'
                : 'Прогноз выполнения плана дня, до пересчёта',
            value: `${dec(day.simulation.coverage)} %`
          }
        ],
        sections: [
          { key: 'free', label: 'Не получили инженера', orderIds: view.unassigned.map((o) => o.id) }
        ]
      };
    }
    case 'metric:coverage': {
      const total = day.plan.meta.orders_total;
      const done = Math.round(day.simulation.done.p50);
      const assigned = day.plan.meta.orders_assigned;
      return {
        eyebrow: 'Прогноз по симуляции',
        title: 'Прогноз выполнения',
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
        eyebrow: rest ?? 'Число расчёта',
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
            label: rest === null ? 'Без заявок' : 'Без заявок в остатке дня',
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
      const base = rest === null ? plan.meta.baseline ?? null : null;
      const withRoute = view.loads.filter((load) => load.route && load.route.stops.length > 0);
      /* У пересчёта «без заявок в остатке дня» — не значит «свободен»: тот,
         кто сейчас едет к заявке или работает на ней, в маршрутах пересчёта
         не стоит вовсе — эта заявка его, и пересчёт её не трогает
         (`meta.replan.underway`, `{заявка: инженер}`). Такие люди заняты, и
         в одном списке со свободными диспетчер принял бы их за резерв. */
      const underway =
        rest === null
          ? new Set<string>()
          : new Set(
              Object.values(
                (plan.meta as { replan?: { underway?: Record<string, string> } }).replan?.underway ?? {}
              )
            );
      const without = view.loads.filter((load) => !(load.route && load.route.stops.length > 0));
      const busy = without.filter((load) => underway.has(load.engineer.id));
      const free = without.filter((load) => !underway.has(load.engineer.id));
      const freeLabel = rest === null ? 'Без заявок' : 'Без новых заявок в остатке дня';
      /* Кольцо — как у соседних чисел: из кого сложилась цифра. Делим штат
         смены на тех, кто получил хоть одну заявку, и тех, кто нет. У плана
         дня вторые — резерв на случай ЧП; у пересчёта среди них могут быть и
         те, кто уже отработал утро, поэтому подпись осторожнее. */
      return {
        eyebrow: rest ?? 'Число расчёта',
        title: 'Исполнителей задействовано',
        chart: {
          title: 'Как занят штат смены',
          centerValue: view.loads.length,
          centerCaption: 'В штате',
          slices: [
            {
              key: 'used',
              label: 'Получили заявки',
              count: withRoute.length,
              ids: withRoute.map((load) => load.engineer.id),
              tone: 'ok'
            },
            /* Занятые текущей заявкой — тоже на работе, отсюда тот же тон. */
            ...(busy.length > 0
              ? [
                  {
                    key: 'busy',
                    label: 'Заняты текущей заявкой',
                    count: busy.length,
                    ids: busy.map((load) => load.engineer.id),
                    tone: 'ok' as const
                  }
                ]
              : []),
            {
              key: 'free',
              label: freeLabel,
              count: free.length,
              ids: free.map((load) => load.engineer.id),
              tone: 'wait'
            }
          ]
        },
        facts: [
          { key: 'used', label: 'Задействовано в этом плане', value: String(engineersUsed(plan)) },
          /* Строка базового не пропадает у пересчёта молча: сравнения с ним
             требует ТЗ, и диспетчер должен видеть, почему его здесь нет. */
          rest === null
            ? {
                key: 'base',
                label: 'Базовый вариант (без планировщика)',
                value: base ? String(base.engineers_used) : '—'
              }
            : { key: 'base', label: 'Базовый вариант (без планировщика)', value: 'для пересчёта не сравнивается' },
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
          { key: 'used', label: 'Получили заявки', engineerIds: withRoute.map((load) => load.engineer.id) },
          ...(busy.length > 0
            ? [{ key: 'busy', label: 'Заняты текущей заявкой', engineerIds: busy.map((load) => load.engineer.id) }]
            : []),
          {
            key: 'free',
            label: freeLabel,
            engineerIds: free.map((load) => load.engineer.id)
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
        sections: [{ key: 'free', label: 'Ни одной заявки за день', engineerIds: crew.freeIds }]
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
        eyebrow: 'Прогноз дня',
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
        eyebrow: 'Прогноз дня',
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
                        {/* Короткая причина прямо в строке: «почему без
                            инженера» — первый вопрос к этому списку, и
                            открывать ради него каждую заявку незачем. */}
                        {!view.stopByOrder.has(id) && order.unassigned_reason?.text && (
                          <span className="row__why">
                            {order.unassigned_reason.text.charAt(0).toUpperCase() +
                              order.unassigned_reason.text.slice(1)}
                          </span>
                        )}
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
