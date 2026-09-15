import { useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView, Segment } from '../data/derive.ts';
import { engineerTimeline, hhmm, placeOf, visits } from '../data/derive.ts';
import { hours, isLabelled, pct, timeAt } from './scale.ts';

interface Props {
  view: DayView;
  /** Час, на который навели в правой панели: на ленте он подсвечен полосой,
      чтобы «свободные руки в 16:00» и сам гант читались как одно место. */
  hotHour: number | null;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

/** Доля внутри смены инженера: куски ленты считаются от её начала. */
const inShift = (m: number, engineer: { shift_start: number; shift_end: number }) => {
  const span = Math.max(1, engineer.shift_end - engineer.shift_start);
  return ((Math.min(engineer.shift_end, Math.max(engineer.shift_start, m)) - engineer.shift_start) / span) * 100;
};

/* Цвет — главный индикатор на этой линии, поэтому он один на всю систему:
   зелёный делает, красный горит, жёлтый ждёт, тёмно-серый едет, серый обед. */
const LEGEND = [
  { kind: 'work', label: 'Работает' },
  { kind: 'travel', label: 'Едет' },
  { kind: 'lunch', label: 'Обед' },
  { kind: 'problem', label: 'Заявка под угрозой' },
  { kind: 'wait', label: 'Ждёт открытия окна' },
  { kind: 'free', label: 'Окно без инженера' }
];

const KIND_LABEL: Record<Segment['kind'], string> = {
  travel: 'Едет',
  wait: 'Ждёт открытия окна',
  work: 'Работает',
  idle: 'Простой',
  lunch: 'Окно под обед'
};

interface Tip {
  x: number;
  y: number;
  lines: string[];
}

/* Наведённый отрезок: какого он рода и который именно.

   Выделение сделано тем же приёмом, что у круговых диаграмм на сводке:
   активное чуть подрастает, всё остальное гаснет, а в легенде подсвечивается
   его строка. Одного только увеличения не хватает — полосы идут вплотную, и
   выросший отрезок теряется среди соседей; одного затухания тоже, потому что
   непонятно, что именно выбрано. Работает пара.

   Ключ нужен, чтобы гасить соседей: род у отрезков повторяется, а погаснуть
   должны все, кроме одного конкретного. */
interface Hot {
  key: string;
  tone: string;
}

/* По чему упорядочены строки. У каждого правила своя сторона по умолчанию:
   фамилию читают с «А», а занятость и длину смены — с самого большого. */
const SORTS = [
  { key: 'start', label: 'Начало смены', desc: false },
  { key: 'name', label: 'Фамилия', desc: false },
  { key: 'load', label: 'Занятость', desc: true },
  { key: 'length', label: 'Длина смены', desc: true }
] as const;

type SortKey = (typeof SORTS)[number]['key'];

/* У заявок без инженера свои две мерки: когда окно открывается и сколько
   оно длится. Узкое окно поздним вечером — самый тяжёлый случай. */
const WAIT_SORTS = [
  { key: 'time', label: 'Время окна', desc: false },
  { key: 'length', label: 'Длительность', desc: true }
] as const;

type WaitSortKey = (typeof WAIT_SORTS)[number]['key'];

/* Гант смены: слева инженеры, справа день от начала до конца. Одна шкала на
   всех, поэтому видно не только «кто чем занят», но и то, ради чего этот
   экран и нужен, — где чужие окна стоят рядом с чужим простоем.

   Снизу той же шкалой лежат заявки без инженера: их окна нарисованы там же,
   где чужая работа, и сразу видно, в какой час их некому было взять. */

/* Шкала часов под сортировкой блока. Стоит в каждом блоке своя, потому что
   строки разнесены заголовками: одна линейка наверху заставляла бы вести
   взгляд через полстраницы, чтобы понять, к какому времени относится кусок. */
function HourScale() {
  return (
    <div className="shiftplan__row shiftplan__hours">
      <span className="shiftplan__side" />
      <div className="shiftplan__cell shiftplan__hours-cell">
        {hours().map((h) => {
          const at = pct(h);
          const edge = at <= 0.5 ? 'start' : at >= 99.5 ? 'end' : null;
          /* Отметка стоит у каждого часа, подпись — у каждого второго:
             между 15:00 и 17:00 половину дороги теперь видно, а не
             приходится делить отрезок на глаз. */
          return (
            <span
              key={h}
              className={
                'shiftplan__hour' +
                (isLabelled(h) ? '' : ' shiftplan__hour--minor') +
                (edge ? ' shiftplan__hour--' + edge : '')
              }
              style={edge === 'end' ? undefined : { left: `${at}%` }}
            >
              {isLabelled(h) ? hhmm(h) : null}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function GanttBoard({ view, hotHour, onSelectOrder, onSelectEngineer }: Props) {
  const box = useRef<HTMLDivElement>(null);
  /* Поле времени: по нему считается, какому часу отвечает точка под
     курсором. Меряем настоящий элемент, а не пересчитываем ширину колонки
     подписей из переменных, — иначе линейка и лента разъезжаются. */
  const axis = useRef<HTMLDivElement>(null);
  const [probe, setProbe] = useState<{ at: number; y: number } | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const [hot, setHot] = useState<Hot | null>(null);
  const [sort, setSort] = useState<SortKey>('start');
  const [desc, setDesc] = useState(false);
  const [waitSort, setWaitSort] = useState<WaitSortKey>('time');
  const [waitDesc, setWaitDesc] = useState(false);

  const show = (event: { currentTarget: EventTarget | null }, lines: string[], warm?: Hot) => {
    if (warm) setHot(warm);
    const host = box.current?.getBoundingClientRect();
    const target = event.currentTarget as HTMLElement | null;
    if (!host || !target) return;
    const rect = target.getBoundingClientRect();
    setTip({
      x: Math.min(Math.max(rect.left + rect.width / 2 - host.left, 96), host.width - 96),
      y: rect.top - host.top,
      lines
    });
  };
  const hide = () => {
    setTip(null);
    setHot(null);
  };

  /* Курсор ведёт по гантy отвес с часами: «что происходит в 16:30» — это
     вопрос к вертикали, а не к подписи через две клетки от неё. Отвес идёт
     через все строки сразу, поэтому час читается у каждого инженера. */
  const trackProbe = (event: { clientX: number; clientY: number }) => {
    const field = axis.current?.getBoundingClientRect();
    const host = box.current?.getBoundingClientRect();
    if (!field || !host || field.width <= 0) return;
    const ratio = (event.clientX - field.left) / field.width;
    if (ratio < 0 || ratio > 1) {
      setProbe(null);
      return;
    }
    /* Часы стоят под курсором: подсказка отрезка раскрывается вверх, и над
       курсором они прятались бы под ней. У нижнего края прижимаем к дну. */
    const y = event.clientY - host.top;
    setProbe({ at: timeAt(ratio), y: Math.min(y + 14, Math.max(0, host.height - 22)) });
  };

  /* Порядок строк задаёт диспетчер: по началу смены видно лесенку выходов,
     по занятости — кто перегружен, по длине смены — у кого день короче. */
  const rank = (load: (typeof view.loads)[number]) => {
    switch (sort) {
      case 'name':
        return 0;
      case 'load':
        return load.occupancy;
      case 'length':
        return load.engineer.shift_end - load.engineer.shift_start;
      default:
        return load.engineer.shift_start;
    }
  };
  const crew = [...view.loads].sort((a, b) => {
    const diff = sort === 'name' ? 0 : rank(a) - rank(b);
    const byName = a.engineer.name.localeCompare(b.engineer.name);
    return (desc ? -1 : 1) * (diff !== 0 ? diff : byName);
  });

  /* Повторный щелчок по тому же правилу переворачивает порядок — привычка
     из таблиц, здесь она работает так же. */
  const pickSort = (key: SortKey) => {
    if (key === sort) {
      setDesc((v) => !v);
      return;
    }
    setSort(key);
    setDesc(SORTS.find((item) => item.key === key)?.desc ?? false);
  };
  const waiting = [...view.unassigned].sort((a, b) => {
    const diff =
      waitSort === 'length'
        ? a.window_end - a.window_start - (b.window_end - b.window_start)
        : a.window_start - b.window_start;
    return (waitDesc ? -1 : 1) * (diff !== 0 ? diff : a.id.localeCompare(b.id));
  });

  const pickWaitSort = (key: WaitSortKey) => {
    if (key === waitSort) {
      setWaitDesc((v) => !v);
      return;
    }
    setWaitSort(key);
    setWaitDesc(WAIT_SORTS.find((item) => item.key === key)?.desc ?? false);
  };

  return (
    <section className="panel shiftplan">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Гант смены</h2>
      </div>

      {/* Легенда подсвечивает род наведённого отрезка — так же, как строка
          легенды у круговых диаграмм. Числа сюда не добавляем: сколько
          минут, написано в подсказке у курсора, а легенда отвечает на
          другой вопрос — что это за цвет. */}
      <div className="shiftplan__legend">
        {LEGEND.map((item) => (
          <span
            className={'shiftplan__key' + (hot?.tone === item.kind ? ' shiftplan__key--on' : '')}
            key={item.kind}
          >
            <span className={'shiftplan__chip shiftplan__chip--' + item.kind} />
            {item.label}
          </span>
        ))}
      </div>

      <div
        className="shiftplan__grid"
        ref={box}
        onMouseMove={trackProbe}
        onMouseLeave={() => setProbe(null)}
      >
        <div className="shiftplan__group">
          <h3 className="shiftplan__group-title">
            Инженеры <span className="shiftplan__group-count">{crew.length}</span>
          </h3>
          <div className="shiftplan__sort">
            <span className="shiftplan__sort-label">Сортировка</span>
            {SORTS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={'shiftplan__sort-btn' + (sort === item.key ? ' shiftplan__sort-btn--on' : '')}
                onClick={() => pickSort(item.key)}
                aria-pressed={sort === item.key}
              >
                {item.label}
                {sort === item.key && (
                  <Icon name={desc ? 'chevron-down' : 'chevron-up'} size={11} />
                )}
              </button>
            ))}
          </div>
        </div>

        <HourScale />

        {crew.map((load) => {
          const { engineer, route } = load;
          const segments = engineerTimeline(route, engineer, view.stopByOrder);
          return (
            <div className="shiftplan__row" key={engineer.id}>
              <button
                type="button"
                className="shiftplan__side shiftplan__side--btn"
                onClick={() => onSelectEngineer(engineer.id)}
              >
                <span className="shiftplan__name">{engineer.name}</span>
                <span className="shiftplan__meta">
                  {load.route ? `${visits(load.visits)} · ${Math.round(load.occupancy * 100)}%` : 'Без маршрута'}
                </span>
              </button>

              <div className="shiftplan__cell shiftplan__track">
                {/* Лента живёт внутри смены и скруглена по краям: куски
                    режутся её же формой, поэтому линия начинается и кончается
                    закруглением, а не срезом. */}
                <span
                  className="shiftplan__line"
                  style={{
                    left: `${pct(engineer.shift_start)}%`,
                    width: `${pct(engineer.shift_end) - pct(engineer.shift_start)}%`
                  }}
                >
                {segments.map((segment, index) => {
                  const width = pct(segment.to) - pct(segment.from);
                  if (width <= 0 || segment.kind === 'idle') return null;

                  /* Дорога и ожидание сами по себе безымянны: смысл им даёт
                     заявка, к которой инженер едет, — берём ближайшую впереди. */
                  const targetId =
                    segment.orderId ??
                    segments.slice(index).find((next) => next.kind === 'work')?.orderId;
                  const order = targetId ? view.orderById.get(targetId) : undefined;
                  const placement = targetId ? view.stopByOrder.get(targetId) : undefined;
                  const trouble =
                    segment.kind === 'work' && placement
                      ? placement.slaBreached
                        ? 'Крайний срок нарушен'
                        : placement.stop.risk !== 'low'
                          ? `запас всего ${placement.stop.slack_minutes} мин`
                          : null
                      : null;

                  const lines = [
                    KIND_LABEL[segment.kind],
                    order ? `${order.id} · ${order.work_title} · ${placeOf(order)}` : engineer.name,
                    `${hhmm(segment.from)}–${hhmm(segment.to)} · ${segment.to - segment.from} мин`
                  ];
                  if (trouble) lines.push(trouble);

                  const tone = segment.kind === 'work' && trouble ? 'problem' : segment.kind;
                  const style = {
                    left: `${inShift(segment.from, engineer)}%`,
                    width: `${inShift(segment.to, engineer) - inShift(segment.from, engineer)}%`
                  };
                  const key = `${engineer.id}:${index}`;
                  const warm: Hot = { key, tone };
                  const className =
                    'shiftplan__seg shiftplan__seg--' +
                    tone +
                    (hot ? (hot.key === key ? ' shiftplan__seg--on' : ' shiftplan__seg--dim') : '');

                  if (segment.kind === 'work' && segment.orderId) {
                    return (
                      <button
                        key={index}
                        type="button"
                        className={className}
                        style={style}
                        onClick={() => onSelectOrder(segment.orderId!)}
                        onMouseEnter={(e) => show(e, lines, warm)}
                        onMouseLeave={hide}
                      />
                    );
                  }
                  return (
                    <span
                      key={index}
                      className={className}
                      style={style}
                      onMouseEnter={(e) => show(e, lines, warm)}
                      onMouseLeave={hide}
                    />
                  );
                })}
                </span>
              </div>
            </div>
          );
        })}

        {waiting.length > 0 && (
          <div className="shiftplan__group">
            <h3 className="shiftplan__group-title">
              Заявки без инженера{' '}
              <span className="shiftplan__group-count">{waiting.length}</span>
            </h3>
            <div className="shiftplan__sort">
              <span className="shiftplan__sort-label">Сортировка</span>
              {WAIT_SORTS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={
                    'shiftplan__sort-btn' + (waitSort === item.key ? ' shiftplan__sort-btn--on' : '')
                  }
                  onClick={() => pickWaitSort(item.key)}
                  aria-pressed={waitSort === item.key}
                >
                  {item.label}
                  {waitSort === item.key && (
                    <Icon name={waitDesc ? 'chevron-down' : 'chevron-up'} size={11} />
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {waiting.length > 0 && <HourScale />}

        {waiting.map((order) => (
          <div className="shiftplan__row" key={order.id}>
              <button
                type="button"
                className="shiftplan__side shiftplan__side--btn"
                onClick={() => onSelectOrder(order.id)}
              >
                <span className="shiftplan__name">
                  {order.id} · {order.work_title}
                </span>
                <span className="shiftplan__meta">{placeOf(order)}</span>
              </button>

              <div className="shiftplan__cell shiftplan__track">
                {/* Невзятые окна гаснут вместе со всеми остальными: они на том
                    же полотне, и выделение должно работать на весь гант, а не
                    только на маршруты. */}
                <button
                  type="button"
                  className={
                    'shiftplan__seg shiftplan__seg--free' +
                    (hot
                      ? hot.key === `free:${order.id}`
                        ? ' shiftplan__seg--on'
                        : ' shiftplan__seg--dim'
                      : '')
                  }
                  style={{
                    left: `${pct(order.window_start)}%`,
                    width: `${Math.max(pct(order.window_end) - pct(order.window_start), 0.6)}%`
                  }}
                  onClick={() => onSelectOrder(order.id)}
                  onMouseEnter={(e) =>
                    show(
                      e,
                      [
                        `${order.id} · ${order.work_title}`,
                        `${placeOf(order)} · окно ${hhmm(order.window_start)}–${hhmm(order.window_end)}`,
                        'Инженер не назначен'
                      ],
                      { key: `free:${order.id}`, tone: 'free' }
                    )
                  }
                  onMouseLeave={hide}
                />
              </div>
            </div>
          ))}

        {tip && (
          <div className="shiftplan__tip" style={{ left: tip.x, top: tip.y }}>
            {tip.lines.map((line, index) => (
              <span key={index} className={index === 0 ? 'shiftplan__tip-head' : 'shiftplan__tip-line'}>
                {line}
              </span>
            ))}
          </div>
        )}

        {/* Часовая сетка — один слой на все строки: рисовать её в каждой
            дорожке значило бы четырнадцать элементов на строку. Заголовки
            групп стоят выше по слоям и белым фоном обрывают и линии, и отвес,
            чтобы те не шли через сортировку.

            В разметке слои стоят последними: первым ребёнком сетки должен
            остаться заголовок группы — по нему снимается его верхний отступ. */}
        <div className="shiftplan__axis" ref={axis} aria-hidden="true">
          {hotHour !== null && (
            <span
              className="shiftplan__hourband"
              style={{ left: `${pct(hotHour)}%`, width: `${pct(hotHour + 60) - pct(hotHour)}%` }}
            />
          )}
          {hours().map((h) => (
            <span
              key={h}
              className={'shiftplan__gridline' + (isLabelled(h) ? ' shiftplan__gridline--hour' : '')}
              style={{ left: `${pct(h)}%` }}
            />
          ))}
        </div>

        {probe && (
          <div className="shiftplan__axis shiftplan__axis--probe" aria-hidden="true">
            <span className="shiftplan__probe" style={{ left: `${pct(probe.at)}%` }}>
              <b className="shiftplan__probe-time" style={{ top: probe.y }}>
                {hhmm(probe.at)}
              </b>
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
