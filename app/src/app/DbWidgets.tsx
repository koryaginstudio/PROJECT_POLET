import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';

/* Виджеты баз данных.

   Шапка базы раньше показывала пять чисел, одинаковых для всех, кто сюда
   заходит. Но приходят в базу с разными вопросами: одному важно, как менялось
   покрытие от расчёта к расчёту, другому — где остаётся больше всего
   нераспределённого, третьему — сколько в среднем уходит на дорогу. Пять
   чисел, выбранных за него, на половину этих вопросов не отвечают, а добавить
   недостающее было нечем.

   Теперь эти пять чисел и есть виджеты — просто те, что стоят по умолчанию.
   Любой снимается крестиком, на освободившееся место встаёт плюс, и через него
   набирается своё. Выбор держится в браузере: это настройка рабочего места, а
   не свойство данных.

   Виджет отдаёт не картинку, а величину: итог, доли этого итога и ряд по
   расчётам. Форма — число, кольцо, столбцы, линия — выбирается на самой
   плитке и ничего в подсчёте не меняет; одно и то же и считается, и значит
   одно и то же, просто показано по-разному. Поэтому и форм предлагается
   ровно столько, сколько величина выдерживает: кольцо без долей — это круг
   без смысла, а линия без ряда — точка.

   Механизм общий для всех баз: база отдаёт свой список величин, доска отвечает
   за выбор, форму, память и раскладку.

   Плитка квадратная и одного размера с соседями. Диаграммы разной формы в
   прямоугольниках разной высоты читаются как разной важности; квадрат этот
   спор снимает. Шесть в ряд: столько встаёт на месте прежней строки чисел, не
   мельча их. */

/** Десять плиток — предел. Дальше доска перестаёт быть выборкой и снова
    становится витриной, от которой уходили: когда наверху висит всё подряд,
    выбирать из этого приходится глазами, а это ровно та работа, которую
    доска и должна была снять. */
const PER_ROW = 6;
const LIMIT = 10;

/** Сторона плитки. Образец в меню — она же, только уменьшенная, поэтому число
    нужно и вёрстке, и масштабу. */
const TILE = 204;

/** Зазор между плитками в сетке, пиксели. Полосу вставки рисует сетка, и
    ей надо знать, посередине чего эту полосу ставить. Значение то же, что
    у `gap` в вёрстке доски. */
const GAP = 8;

export type WidgetTone = 'neutral' | 'ok' | 'warn' | 'bad';

export type WidgetShape = 'number' | 'donut' | 'bars' | 'line';

export interface WidgetPart {
  key: string;
  label: string;
  value: number;
  tone?: WidgetTone;
  /** Как показать величину, если это не просто счёт: «67 %», «12,4 ч». */
  text?: string;
}

export interface WidgetPoint {
  label: string;
  value: number;
}

export interface WidgetData {
  /** Итог одним числом. Он же стоит в середине кольца. */
  value: string;
  unit?: string;
  caption: string;
  tone?: WidgetTone;
  /** Подстрочник числовой формы: то, что не влезло в итог. */
  facts?: string[];
  /** Доли: из них строятся кольцо и столбцы по категориям. */
  parts?: WidgetPart[];
  /** Складываются ли доли в целое. Кольцо предлагается только когда да: круг
      обещает, что сумма секторов — это всё, и доли, которые пересекаются или
      взяты верхушкой списка, он этим обещанием превращает в неправду.
      Полосам это безразлично — каждая меряется сама по себе. */
  whole?: boolean;
  /** Ряд по расчётам: из него строятся линия и столбцы по времени. */
  series?: WidgetPoint[];
  /** Подпись под диаграммой — чем меряют доли. */
  legend?: string;
}

export interface WidgetDef {
  key: string;
  /** Название на плитке и в меню. */
  title: string;
  /** На какой вопрос величина отвечает — строка в меню. */
  note: string;
  /** Форма по умолчанию. Не задана — берётся первая из доступных. */
  shape?: WidgetShape;
  data: WidgetData;
}

/* Цвета те же, что у колец и полос диспетчерской: карта, пульт и база — один
   интерфейс, и зелёное в одном месте не должно значить другое в соседнем. */
const TONE_VAR: Record<WidgetTone, string> = {
  neutral: 'var(--ink-1000)',
  ok: 'var(--success-500)',
  warn: 'var(--accent-500)',
  bad: 'var(--danger-500)'
};

/* Доли, у которых нет «хорошо» и «плохо» — виды работ, навыки, номера
   расчётов, — красятся рядом `--series-*`: тем же, которым диспетчерская
   красит полосы по видам работ. Тревожный красный здесь соврал бы. */
const partColor = (part: WidgetPart, index: number) =>
  part.tone ? TONE_VAR[part.tone] : `var(--series-${(index % 8) + 1})`;

const share = (value: number, sum: number) => (sum > 0 ? Math.round((value / sum) * 100) : 0);

/* Выпадающий список, вправленный в экран.

   Плюс кочует по ряду вслед за последней плиткой, и в последней колонке
   список, раскрытый от его середины, уезжает за правый край: половина
   образцов оказывается за экраном. Привязать его к одному краю нельзя — тогда
   он уедет за левый, стоит плитке встать первой.

   Поэтому положение задаёт вёрстка, а поправку считает сам список: после
   раскрытия он меряет себя и сдвигается ровно настолько, чтобы влезть.
   Сдвиг едет отдельной переменной, а не готовым `transform`: у списка от
   плюса в `transform` уже стоит центровка, и перезаписать её значит сломать
   привязку. */
const DROP_EDGE = 12;

function Drop({ children, label }: { children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  /* Текущий сдвиг нужен самому замеру: рамка возвращается уже сдвинутой, и без
     этого поправка накладывалась бы сама на себя при каждом пересчёте. */
  const applied = useRef(0);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const fit = () => {
      const rect = node.getBoundingClientRect();
      const left = rect.left - applied.current;
      const right = rect.right - applied.current;
      let dx = 0;
      if (right > window.innerWidth - DROP_EDGE) dx = window.innerWidth - DROP_EDGE - right;
      if (left + dx < DROP_EDGE) dx = DROP_EDGE - left;
      applied.current = dx;
      setShift(dx);
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  return (
    <div
      className="wmenu__drop"
      role="dialog"
      aria-label={label}
      ref={box}
      style={{ '--drop-shift': `${shift}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

/* ─── какие формы выдерживает величина ────────────────────────────────── */

const SHAPE_LABEL: Record<WidgetShape, string> = {
  number: 'Числовой',
  donut: 'Круговая диаграмма',
  bars: 'Столбчатый график',
  line: 'Линейный график'
};

function shapesOf(data: WidgetData): WidgetShape[] {
  const list: WidgetShape[] = ['number'];
  const parts = data.parts?.length ?? 0;
  const series = data.series?.length ?? 0;
  if (parts > 1 && data.whole) list.push('donut');
  if (parts > 0 || series > 1) list.push('bars');
  if (series > 1) list.push('line');
  return list;
}

const shapeOf = (def: WidgetDef, picked?: WidgetShape): WidgetShape => {
  const able = shapesOf(def.data);
  if (picked && able.includes(picked)) return picked;
  if (def.shape && able.includes(def.shape)) return def.shape;
  return able[able.length - 1];
};

/* Значки форм рисуем здесь, а не берём из системы: в наборе есть столбцы, но
   нет ни кольца, ни «просто числа», а три значка из разных рук в одном
   переключателе читаются как три разные вещи. */
function ShapeMark({ shape }: { shape: WidgetShape }) {
  return (
    <svg className="wshape__mark" viewBox="0 0 14 14" aria-hidden="true">
      {shape === 'number' && (
        <>
          <rect x="1" y="2.5" width="9" height="4" rx="1.2" />
          <rect x="1" y="8.5" width="12" height="1.6" rx="0.8" opacity="0.45" />
        </>
      )}
      {shape === 'donut' && (
        <path
          d="M7 1.4a5.6 5.6 0 1 1-5.6 5.6A5.6 5.6 0 0 1 7 1.4Zm0 2.8a2.8 2.8 0 1 0 2.8 2.8A2.8 2.8 0 0 0 7 4.2Z"
          fillRule="evenodd"
        />
      )}
      {shape === 'bars' && (
        <>
          <rect x="1.3" y="7" width="2.8" height="5.6" rx="1" />
          <rect x="5.6" y="3.4" width="2.8" height="9.2" rx="1" />
          <rect x="9.9" y="5.6" width="2.8" height="7" rx="1" />
        </>
      )}
      {shape === 'line' && (
        <path
          d="M1.4 9.8 4.6 6.3l2.5 2.1 4.4-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

/* ─── отбор по времени ────────────────────────────────────────────────

   У доски свой отбор, отдельный от отбора списка под ней. Список отвечает на
   «какие расчёты показать», доска — на «за какой срок считать»; смешивать их
   в один переключатель нельзя: поиск по номеру не должен менять диаграммы, а
   смена срока — прятать строки.

   Сроки заданы от сегодняшнего дня, а не от края истории: диспетчер смотрит
   на архив из своего «сейчас», и «неделя» для него всегда последняя. */

export type PeriodKey = 'today' | 'yesterday' | 'week' | 'month' | 'quarter' | 'all';

export const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: 'today', label: 'Сегодня' },
  { key: 'yesterday', label: 'Вчера' },
  { key: 'week', label: 'Неделя' },
  { key: 'month', label: 'Месяц' },
  { key: 'quarter', label: 'Квартал' },
  { key: 'all', label: 'Всё время' }
];

const DAY = 24 * 60 * 60 * 1000;

/** Попадает ли отметка времени в срок. `created` — ISO из реестра. */
export function withinPeriod(created: string, period: PeriodKey, now = new Date()): boolean {
  if (period === 'all') return true;
  const at = new Date(created);
  if (Number.isNaN(at.getTime())) return false;

  /* Считаем по суткам, а не по ровным интервалам от текущей минуты: «вчера» —
     это вчерашний день целиком, а не «от 26 часов назад до 2 часов назад». */
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const stamp = at.getTime();

  switch (period) {
    case 'today':
      return stamp >= midnight;
    case 'yesterday':
      return stamp >= midnight - DAY && stamp < midnight;
    case 'week':
      return stamp >= midnight - 6 * DAY;
    case 'month':
      return stamp >= midnight - 29 * DAY;
    default:
      return stamp >= midnight - 89 * DAY;
  }
}

/** Переключатель срока. Состояние держит база: от него зависит не только
    доска, но и то, что она считает. */
export function WidgetPeriod({
  value,
  onChange,
  countOf
}: {
  value: PeriodKey;
  onChange: (value: PeriodKey) => void;
  /** Сколько расчётов попадает в срок — пустые сроки видно до нажатия. */
  countOf?: (period: PeriodKey) => number;
}) {
  return (
    <div className="wperiod" role="group" aria-label="За какой срок считать">
      {PERIODS.map((period) => {
        const count = countOf?.(period.key);
        return (
          <button
            key={period.key}
            type="button"
            className={'wperiod__item' + (value === period.key ? ' wperiod__item--on' : '')}
            onClick={() => onChange(period.key)}
            aria-pressed={value === period.key}
            disabled={count === 0}
            title={
              count === undefined
                ? undefined
                : count === 0
                  ? 'За этот срок расчётов нет'
                  : `Расчётов за срок: ${count}`
            }
          >
            {period.label}
          </button>
        );
      })}
    </div>
  );
}

/* ─── память выбора ─────────────────────────────────────────────────────
   Ключ свой у каждой базы: наборы у них разные, и общий ключ означал бы, что
   виджеты расчётов пытаются открыться в базе клиентов. */

const storeName = (key: string) => `polet.widgets.${key}`;

interface Saved {
  picks: string[];
  shapes: Record<string, WidgetShape>;
}

function readSaved(key: string, fallback: string[], known: Set<string>): Saved {
  const empty: Saved = { picks: fallback, shapes: {} };
  if (typeof localStorage === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(storeName(key));
    if (!raw) return empty;
    const saved = JSON.parse(raw);
    /* Сначала набор хранился голым списком имён. Такие записи читаем как есть:
       перенастраивать доску заново из-за того, что у нас появились формы, —
       наша забота, а не диспетчера. */
    const picks: unknown = Array.isArray(saved) ? saved : saved?.picks;
    if (!Array.isArray(picks)) return empty;
    /* Список величин базы со временем меняется. Сохранённое имя, которого
       больше нет, молча выбрасываем: пустая плитка объясняла бы диспетчеру
       нашу историю правок, а не его данные. */
    const kept = picks
      .filter((item): item is string => typeof item === 'string' && known.has(item))
      .slice(0, LIMIT);
    const shapes: Record<string, WidgetShape> = {};
    const raws = Array.isArray(saved) ? {} : (saved?.shapes ?? {});
    for (const [name, shape] of Object.entries(raws)) {
      if (known.has(name) && typeof shape === 'string' && shape in SHAPE_LABEL) {
        shapes[name] = shape as WidgetShape;
      }
    }
    return { picks: kept, shapes };
  } catch {
    return empty;
  }
}

function writeSaved(key: string, saved: Saved): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storeName(key), JSON.stringify(saved));
  } catch {
    /* Приватный режим и переполненное хранилище — не повод ронять экран:
       доска просто не переживёт перезагрузку. */
  }
}

/* ─── формы ───────────────────────────────────────────────────────────── */

function NumberView({ data }: { data: WidgetData }) {
  return (
    <div className="wnum">
      <span className="wnum__value" style={{ color: TONE_VAR[data.tone ?? 'neutral'] }}>
        {data.value}
        {data.unit && <span className="wnum__unit">{data.unit}</span>}
      </span>
      <span className="wnum__caption">{data.caption}</span>
      {data.facts && data.facts.length > 0 && (
        <ul className="wnum__facts">
          {data.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* Кольцо повторяет кольцо диспетчерской: та же рамка 120, тот же радиус, та
   же толщина дуги и то же поведение — наведение утолщает свою долю и гасит
   соседние, а легенда подсвечивается с ней в паре. Разница одна: здесь легенда
   стоит под кольцом, а не сбоку, — в квадрате со стороной в два пальца двум
   колонкам рядом места нет.

   Размер кольца задан числом, а не флексом. Флекс растил его по свободной
   высоте, и стоило плитке перестать резать по краям — при раскрытом списке
   форм, — как кольцо вылезало наружу, а число в середине наезжало на дугу. */
const R = 46;
const C = 2 * Math.PI * R;

/** Сколько строк помещается под кольцом. Если долей больше, последняя строка
    уходит под «и ещё N»: молча обрезанный состав врёт про целое. */
const LEGEND_ROWS = 3;

function DonutView({ data }: { data: WidgetData }) {
  /* Наведение и выбор — одно состояние на кольцо и легенду: наводя на дугу,
     диспетчер должен видеть, где это в списке, и наоборот. Выбор нужен там,
     где наведения нет вовсе, — на планшете дуга иначе остаётся картинкой. */
  const [hot, setHot] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const live = pinned ?? hot;

  const parts = data.parts ?? [];
  const sum = parts.reduce((acc, part) => acc + part.value, 0);
  const shown = parts.filter((part) => part.value > 0);
  const picked = parts.find((part) => part.key === live);
  let offset = 0;

  /* В середине стоит сумма долей, а не итог виджета: у «Средней занятости»
     итог — проценты, а кольцо сложено из маршрутов, и 65 в центре круга из
     391 маршрута читалось бы как ошибка счёта. */
  const rows = parts.length > LEGEND_ROWS ? LEGEND_ROWS - 1 : LEGEND_ROWS;

  const tap = (key: string) => setPinned((was) => (was === key ? null : key));

  return (
    <div className="wdonut">
      <svg
        className="wdonut__ring"
        viewBox="0 0 120 120"
        role="img"
        aria-label={
          shown.length > 0
            ? shown.map((part) => `${part.label}: ${part.text ?? part.value}`).join(', ')
            : 'Нет данных'
        }
      >
        <circle className="wdonut__rail" cx="60" cy="60" r={R} />
        <g transform="rotate(-90 60 60)">
          {shown.map((part) => {
            const index = parts.indexOf(part);
            const length = (part.value / Math.max(sum, 1)) * C;
            /* Зазор между долями не должен съедать саму долю: у тонкого
               сектора отрезаем от него же, а не фиксированные три пункта. */
            const gap = shown.length > 1 ? Math.min(3, length * 0.4) : 0;
            const drawn = Math.max(length - gap, 0.6);
            const arc = (
              <circle
                key={part.key}
                className={'wdonut__arc' + (live === part.key ? ' wdonut__arc--on' : '')}
                style={{
                  stroke: partColor(part, index),
                  opacity: live && live !== part.key ? 0.3 : 1
                }}
                cx="60"
                cy="60"
                r={R}
                strokeDasharray={`${drawn} ${C - drawn}`}
                strokeDashoffset={-offset}
                onMouseEnter={() => setHot(part.key)}
                onMouseLeave={() => setHot(null)}
                onClick={() => tap(part.key)}
              >
                <title>{`${part.label}: ${part.text ?? part.value}`}</title>
              </circle>
            );
            offset += length;
            return arc;
          })}
        </g>
        {/* В середине — итог, а при выбранной доле её величина: кольцо тогда
            отвечает не «сколько всего», а «сколько вот этих». */}
        <text className="wdonut__value" x="60" y="59">
          {picked ? (picked.text ?? picked.value) : sum}
        </text>
        <text className="wdonut__caption" x="60" y="74">
          {picked ? `${share(picked.value, sum)} %` : (data.legend ?? data.caption)}
        </text>
      </svg>

      <ul className="wlegend">
        {parts.slice(0, rows).map((part, index) => (
          <li
            key={part.key}
            className={'wlegend__item' + (live === part.key ? ' wlegend__item--on' : '')}
            onMouseEnter={() => setHot(part.key)}
            onMouseLeave={() => setHot(null)}
          >
            <button type="button" className="wlegend__btn" onClick={() => tap(part.key)}>
              <span className="wlegend__dot" style={{ background: partColor(part, index) }} />
              <span className="wlegend__label">{part.label}</span>
              <span className="wlegend__value">{part.text ?? part.value}</span>
            </button>
          </li>
        ))}
        {parts.length > rows && <li className="wlegend__rest">и ещё {parts.length - rows}</li>}
      </ul>
    </div>
  );
}

/* Столбцы по категориям — строками, как полосы диспетчерской: подпись, дорожка,
   число. Разница в том, что подпись стоит над дорожкой, а не слева: в шестой
   доле ширины экрана строка «имя — полоса — число» оставляет полосе десяток
   пикселей, и сравнивать становится нечего. Поведение то же — строка
   подсвечивается целиком и нажимается. */
function BarsView({ data }: { data: WidgetData }) {
  const [hot, setHot] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const live = pinned ?? hot;

  const parts = (data.parts ?? []).slice(0, 4);
  const top = Math.max(1, ...parts.map((part) => part.value));
  const sum = (data.parts ?? []).reduce((acc, part) => acc + part.value, 0);

  return (
    <div className="wbars">
      <ul className="wbars__list">
        {parts.map((part, index) => (
          <li
            key={part.key}
            className={'wbar' + (live === part.key ? ' wbar--on' : '')}
            onMouseEnter={() => setHot(part.key)}
            onMouseLeave={() => setHot(null)}
          >
            <button
              type="button"
              className="wbar__btn"
              onClick={() => setPinned((was) => (was === part.key ? null : part.key))}
              title={`${part.label}: ${part.text ?? part.value}${
                sum > 0 ? ` · ${share(part.value, sum)} % от показанных` : ''
              }`}
            >
              <span className="wbar__top">
                <span className="wbar__label">{part.label}</span>
                <span className="wbar__value">{part.text ?? part.value}</span>
              </span>
              <span className="wbar__track">
                <i
                  className="wbar__fill"
                  style={{
                    width: `${Math.max(2, (part.value / top) * 100)}%`,
                    background: partColor(part, index),
                    opacity: live && live !== part.key ? 0.35 : 1
                  }}
                />
              </span>
            </button>
          </li>
        ))}
      </ul>
      {data.legend && <span className="wbars__caption">{data.legend}</span>}
    </div>
  );
}

/* Столбцы по времени — вертикальные: ряд из трёх десятков расчётов строками
   не показать, а колонками он читается тем же движением глаза, что и линия. */
function ColumnsView({ data }: { data: WidgetData }) {
  /* Столбец по времени отвечает на «какой это расчёт и сколько в нём»: без
     наведения ряд остаётся картинкой общей формы, а числа за ним не достать. */
  const [hot, setHot] = useState<number | null>(null);
  const points = data.series ?? [];
  const top = Math.max(1, ...points.map((point) => point.value));
  const color = TONE_VAR[data.tone ?? 'neutral'];
  const live = hot !== null ? points[hot] : null;

  return (
    <div className="wtrend">
      <span className="wtrend__value" style={{ color }}>
        {live ? live.value : data.value}
        {data.unit && <span className="wnum__unit">{data.unit}</span>}
      </span>
      <span className="wtrend__caption">{live ? live.label : data.caption}</span>
      <span className="wcols" role="img" aria-label={data.caption}>
        {points.map((point, index) => (
          <button
            key={`${point.label}-${index}`}
            type="button"
            className={'wcols__bar' + (hot === index ? ' wcols__bar--on' : '')}
            style={{ height: `${Math.max(3, (point.value / top) * 100)}%`, background: color }}
            title={`${point.label}: ${point.value}`}
            onMouseEnter={() => setHot(index)}
            onMouseLeave={() => setHot(null)}
            onFocus={() => setHot(index)}
            onBlur={() => setHot(null)}
            aria-label={`${point.label}: ${point.value}`}
          />
        ))}
      </span>
      <span className="wtrend__ends">
        <b>{points[0]?.label ?? ''}</b>
        <b>{points[points.length - 1]?.label ?? ''}</b>
      </span>
    </div>
  );
}

/* Линия по расчётам. Подписей у оси нет намеренно: в квадрате со стороной в
   два пальца три десятка номеров превращаются в серую кашу. Что это за точка,
   говорит подсказка, а сама линия отвечает на «росло или падало». */
function LineView({ data }: { data: WidgetData }) {
  const [hot, setHot] = useState<number | null>(null);
  const points = data.series ?? [];
  const values = points.map((point) => point.value);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1);
  const span = max - min || 1;
  const W = 100;
  const H = 40;
  const at = (index: number) => ({
    x: points.length > 1 ? (index / (points.length - 1)) * W : W / 2,
    y: H - ((points[index].value - min) / span) * H
  });
  const line = points
    .map((_, index) => {
      const { x, y } = at(index);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  const stroke = TONE_VAR[data.tone ?? 'neutral'];
  const last = points.length > 0 ? at(points.length - 1) : null;

  return (
    <div className="wtrend">
      <span className="wtrend__value" style={{ color: stroke }}>
        {hot !== null ? points[hot].value : data.value}
        {data.unit && <span className="wnum__unit">{data.unit}</span>}
      </span>
      <span className="wtrend__caption">{hot !== null ? points[hot].label : data.caption}</span>
      <svg
        className="wtrend__plot"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={data.caption}
      >
        <path className="wtrend__area" d={area} style={{ fill: stroke }} />
        <path className="wtrend__line" d={line} style={{ stroke }} />
        {last && (
          <circle className="wtrend__dot" cx={last.x} cy={last.y} r={2.4} style={{ fill: stroke }} />
        )}
        {/* Невидимые столбцы поверх линии: попасть курсором в точку графика
            нельзя, а знать, что это за расчёт, надо. Ловят они, показывает
            подсказка. */}
        {points.map((point, index) => (
          <rect
            key={`${point.label}-${index}`}
            className="wtrend__grip"
            x={points.length > 1 ? (index / points.length) * W : 0}
            y={0}
            width={W / Math.max(points.length, 1)}
            height={H}
            onMouseEnter={() => setHot(index)}
            onMouseLeave={() => setHot(null)}
          >
            <title>{`${point.label}: ${point.value}`}</title>
          </rect>
        ))}
      </svg>
      {/* Подписи крайних точек: без них линия говорит про форму, но молчит о
          том, между какими расчётами она эту форму приняла. */}
      <span className="wtrend__ends">
        <b>{points[0]?.label ?? ''}</b>
        <b>{points[points.length - 1]?.label ?? ''}</b>
      </span>
    </div>
  );
}

function View({ data, shape }: { data: WidgetData; shape: WidgetShape }) {
  if (shape === 'donut') return <DonutView data={data} />;
  if (shape === 'line') return <LineView data={data} />;
  if (shape === 'bars') {
    return data.parts && data.parts.length > 0 ? <BarsView data={data} /> : <ColumnsView data={data} />;
  }
  return <NumberView data={data} />;
}

/* ─── доска ───────────────────────────────────────────────────────────── */

interface Options {
  /** Чей это набор: под этим именем выбор и лежит в браузере. */
  storeKey: string;
  /** Что база умеет показать. Порядок задаёт порядок в меню. */
  catalogue: WidgetDef[];
  /** С чего начинается доска — до того, как выбор сделали руками. */
  fallback: string[];
  /** Отбор срока — его рисует база: от него зависит и то, что она посчитала. */
  filter?: ReactNode;
}

/** Доска отдаётся одним куском: отбор, кнопка набора и сетка — части одного
    блока, и разнести их по разным местам экрана значит разорвать связь между
    «за какой срок» и «что показано». */
export interface Board {
  node: ReactNode;
}

/* Что сейчас раскрыто. Меню набора одно на доску, но всплывать оно должно у
   того, на что нажали: от кнопки в заголовке или от плюса в сетке. Выбор формы
   живёт на своей плитке и опознаётся её именем. */
type Open = { kind: 'none' } | { kind: 'picker' } | { kind: 'plus' } | { kind: 'shape'; key: string };

export function useWidgetBoard({ storeKey, catalogue, fallback, filter }: Options): Board {
  const known = new Set(catalogue.map((item) => item.key));
  const [saved, setSaved] = useState<Saved>(() => readSaved(storeKey, fallback, known));
  const [open, setOpen] = useState<Open>({ kind: 'none' });
  /* Что тащат и над чем держат. Порядок важен диспетчеру, а не данным: слева
     ставят то, на что смотрят первым, и никакой сортировкой за него это не
     угадать. */
  const [dragged, setDragged] = useState<string | null>(null);
  /* Куда встанет плитка: у какой соседки и с какой стороны. Раньше здесь
     лежал один ключ — «над какой держат», — и подсвечивалась сама соседка.
     Читалось это как замена: будто плитки поменяются местами. На деле
     перетаскивание вставляет между, и показывать надо зазор, а не плитку. */
  const [over, setOver] = useState<{ key: string; side: 'before' | 'after' } | null>(null);
  /* Полоса в зазоре. Её рисует сетка, а не плитка: плитка режет по своим
     краям, и полоса, нарисованная на ней, обрезалась бы ровно там, где
     должна быть видна — снаружи. */
  const [gap, setGap] = useState<{ x: number; y: number; h: number } | null>(null);
  /* Плитка под нажатой кнопкой мыши — она приподнимается ещё до того, как
     её потащили: так видно, что она в руке. */
  const [lifted, setLifted] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /* Сколько плиток помещается в строку. Считаем по самой сетке, а не по
     ширине окна: колонки задаёт вёрстка, и второе место, где это знание
     повторено, рано или поздно разойдётся с первым. */
  const [cols, setCols] = useState(PER_ROW);

  useEffect(() => {
    const node = gridRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const template = getComputedStyle(node).gridTemplateColumns;
      const count = template.split(' ').filter(Boolean).length;
      if (count > 0) setCols(count);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(node);
    return () => watch.disconnect();
  }, []);

  /* Раскрытое закрывается и промахом мимо него, и клавишей: выпадающий список
     без обоих выходов ловит диспетчера, как только он передумал. */
  useEffect(() => {
    if (open.kind === 'none') return;
    const away = (event: MouseEvent) => {
      const node = event.target as HTMLElement;
      if (!node.closest('.wmenu') && !node.closest('.wshape')) setOpen({ kind: 'none' });
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen({ kind: 'none' });
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const save = (next: Saved) => {
    setSaved(next);
    writeSaved(storeKey, next);
  };

  const toggle = (key: string) => {
    if (saved.picks.includes(key)) {
      save({ ...saved, picks: saved.picks.filter((item) => item !== key) });
    } else if (saved.picks.length < LIMIT) {
      save({ ...saved, picks: [...saved.picks, key] });
    }
  };

  const setShape = (key: string, shape: WidgetShape) => {
    save({ ...saved, shapes: { ...saved.shapes, [key]: shape } });
    setOpen({ kind: 'none' });
  };

  /* Перетаскивание вынимает плитку и вставляет её в зазор — перед соседкой
     или после неё, смотря с какой стороны держат. Остальные сдвигаются.
     Так же ведут себя вкладки в браузере — привычка уже есть, и объяснять
     её не надо. */
  const move = (from: string, to: string, side: 'before' | 'after') => {
    if (from === to) return;
    const next = saved.picks.filter((item) => item !== from);
    const at = next.indexOf(to);
    if (at < 0) return;
    next.splice(side === 'after' ? at + 1 : at, 0, from);
    save({ ...saved, picks: next });
  };

  /* Всё, что рисует перетаскивание, снимается разом: незачем помнить
     отдельно, что уже отпустили, а что ещё нет. */
  const restDrag = () => {
    setDragged(null);
    setOver(null);
    setGap(null);
    setLifted(null);
  };

  const shown = saved.picks
    .map((key) => catalogue.find((item) => item.key === key))
    .filter((item): item is WidgetDef => Boolean(item));
  const full = saved.picks.length >= LIMIT;

  /* Разрезы выбирают по виду, а не по названию: «Покрытие по расчётам» и
     «Визиты по расчётам» отличаются одним словом, а картинкой — сразу. Поэтому
     список идёт сеткой образцов, и образец — та же плитка, просто издали: своя
     мелкая вёрстка рано или поздно разошлась бы с настоящей, и меню начало бы
     обещать не то. */
  const menu = (
    <Drop label="Выбор виджетов">
      <div className="wmenu__lede">
        Отметьте, что показать над базой. Порядок плиток — порядок отметок, вид каждой
        меняется на ней самой.
      </div>
      <ul className="wmenu__list">
        {catalogue.map((item) => {
          const on = saved.picks.includes(item.key);
          const blocked = !on && full;
          return (
            <li key={item.key}>
              <button
                type="button"
                className={'wmenu__item' + (on ? ' wmenu__item--on' : '')}
                onClick={() => toggle(item.key)}
                disabled={blocked}
                aria-pressed={on}
                title={
                  blocked
                    ? `Сначала уберите одну из плиток: больше ${LIMIT} не показываем`
                    : item.note
                }
              >
                <span className="wmenu__prev" aria-hidden="true">
                  <span className="wmenu__prev-in">
                    <span className="wtile wtile--ghost">
                      <span className="wtile__head">
                        <span className="wtile__title">{item.title}</span>
                      </span>
                      <span className="wtile__body">
                        <View data={item.data} shape={shapeOf(item, saved.shapes[item.key])} />
                      </span>
                    </span>
                  </span>
                  <span className="wmenu__box">{on && <Icon name="check" size={11} />}</span>
                </span>
                <span className="wmenu__text">
                  <span className="wmenu__name">{item.title}</span>
                  <span className="wmenu__hint">{item.note}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {full && (
        <div className="wmenu__full">
          Десять плиток — предел. Уберите лишнюю, чтобы добавить другую.
        </div>
      )}
    </Drop>
  );

  const picker = (
    <div className="wmenu">
      <button
        type="button"
        className={'wmenu__btn' + (open.kind === 'picker' ? ' wmenu__btn--on' : '')}
        onClick={() => setOpen((was) => (was.kind === 'picker' ? { kind: 'none' } : { kind: 'picker' }))}
        aria-expanded={open.kind === 'picker'}
        title={`Выбрать, что показывать над базой. Сейчас ${saved.picks.length} из ${LIMIT}`}
      >
        <Icon name="layers" size={13} />
        Добавить
      </button>
      {open.kind === 'picker' && menu}
    </div>
  );

  /* Плюс стоит на свободном месте в строке — и только там. Когда строка
     заполнена, он переезжал бы на новую один-одинёшенек: плитка под
     плитками, к доске не относящаяся, и ряд из-за неё читался бы как
     недособранный. Добавить в этом случае есть чем — кнопкой «Добавить»
     над доской, она на месте всегда. */
  const rowFull = shown.length > 0 && shown.length % cols === 0;
  const showAdd = !full && !rowFull;

  const grid = (
    <div className="wgrid" ref={gridRef}>
      {shown.map((item) => {
        const able = shapesOf(item.data);
        const shape = shapeOf(item, saved.shapes[item.key]);
        const picking = open.kind === 'shape' && open.key === item.key;
        return (
          <figure
            key={item.key}
            className={
              'wtile' +
              (picking ? ' wtile--picking' : '') +
              (dragged === item.key ? ' wtile--dragged' : '') +
              (lifted === item.key ? ' wtile--lifted' : '')
            }
            draggable
            /* Подъём начинается по нажатию, а не по началу перетаскивания:
               между «нажал» и «повёл» проходит заметный кусок времени, и
               плитка должна успеть оказаться в руке до того, как поедет.
               Нажатие на кнопки внутри плитки к ней не относится — там
               меняют вид и убирают плитку, а не берут её. */
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('button')) return;
              setLifted(item.key);
            }}
            onPointerUp={() => setLifted(null)}
            onPointerLeave={() => setLifted((was) => (was === item.key ? null : was))}
            onDragStart={(event) => {
              setDragged(item.key);
              event.dataTransfer.effectAllowed = 'move';
              /* Без полезной нагрузки Safari считает перетаскивание пустым и
                 отменяет его ещё до первого движения. */
              event.dataTransfer.setData('text/plain', item.key);
            }}
            onDragEnd={restDrag}
            onDragOver={(event) => {
              if (!dragged || dragged === item.key) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';

              /* С какой стороны держат — с той и встанет. Делим плитку
                 пополам: левая половина значит «перед ней», правая —
                 «после». Полосу считаем сразу, пока обе рамки под рукой. */
              const box = event.currentTarget.getBoundingClientRect();
              const frame = gridRef.current?.getBoundingClientRect();
              const side = event.clientX < box.left + box.width / 2 ? 'before' : 'after';
              setOver({ key: item.key, side });
              if (!frame) return;
              const edge = side === 'before' ? box.left - GAP / 2 : box.right + GAP / 2;
              setGap({ x: edge - frame.left, y: box.top - frame.top, h: box.height });
            }}
            onDragLeave={() =>
              setOver((was) => {
                if (was?.key !== item.key) return was;
                setGap(null);
                return null;
              })
            }
            onDrop={(event) => {
              event.preventDefault();
              if (dragged && over) move(dragged, over.key, over.side);
              restDrag();
            }}
          >
            <figcaption className="wtile__head">
              <span className="wtile__title">{item.title}</span>

              <span className="wtile__tools">
                {/* Форма меняется на самой плитке. Считает виджет одно и то же
                    при любой из них — меняется только то, каким движением глаза
                    это читают: число отвечает «сколько», кольцо — «из чего»,
                    столбцы — «что больше», линия — «куда идёт». Формы, которых
                    величина не выдерживает, в список не попадают вовсе. */}
                {able.length > 1 && (
                  <span className="wshape">
                    <button
                      type="button"
                      className={'wshape__btn' + (picking ? ' wshape__btn--on' : '')}
                      onClick={() =>
                        setOpen((was) =>
                          was.kind === 'shape' && was.key === item.key
                            ? { kind: 'none' }
                            : { kind: 'shape', key: item.key }
                        )
                      }
                      aria-expanded={picking}
                      aria-label={`Вид плитки «${item.title}»: ${SHAPE_LABEL[shape]}`}
                      title={`Вид: ${SHAPE_LABEL[shape]}`}
                    >
                      <ShapeMark shape={shape} />
                      <Icon name={picking ? 'chevron-up' : 'chevron-down'} size={9} />
                    </button>

                    {picking && (
                      <ul className="wshape__drop" role="menu">
                        {able.map((option) => (
                          <li key={option}>
                            <button
                              type="button"
                              className={
                                'wshape__item' + (option === shape ? ' wshape__item--on' : '')
                              }
                              onClick={() => setShape(item.key, option)}
                              role="menuitemradio"
                              aria-checked={option === shape}
                            >
                              <ShapeMark shape={option} />
                              <span className="wshape__name">{SHAPE_LABEL[option]}</span>
                              {option === shape && <Icon name="check" size={11} />}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </span>
                )}

                <button
                  type="button"
                  className="wtile__drop"
                  onClick={() => toggle(item.key)}
                  title={`Убрать «${item.title}»`}
                  aria-label={`Убрать виджет «${item.title}»`}
                >
                  <Icon name="x" size={11} />
                </button>
              </span>
            </figcaption>

            <div className="wtile__body">
              <View data={item.data} shape={shape} />
            </div>
          </figure>
        );
      })}

      {/* Пустое место в ряду — приглашение, а не дыра. Снял плитку — остальные
          сдвинулись влево, а на освободившийся квадрат встал плюс: добавить
          следующую можно там же, где только что убрал предыдущую. */}
      {showAdd && (
        <div className="wmenu wtile wtile--add">
          <button
            type="button"
            className="wadd"
            onClick={() => setOpen((was) => (was.kind === 'plus' ? { kind: 'none' } : { kind: 'plus' }))}
            aria-expanded={open.kind === 'plus'}
            title="Добавить виджет"
          >
            <span className="wadd__mark">
              <Icon name="plus" size={16} />
            </span>
            <span className="wadd__label">Добавить</span>
          </button>
          {open.kind === 'plus' && menu}
        </div>
      )}

      {/* Зазор, в который встанет плитка. Полоса живёт на сетке: плитка
          режет по своим краям, и нарисованная на ней полоса обрезалась бы
          ровно там, где должна быть видна. */}
      {gap && (
        <span
          className="wgap"
          aria-hidden="true"
          style={{ left: gap.x, top: gap.y, height: gap.h }}
        />
      )}
    </div>
  );

  return {
    node: (
      <div className="wboard">
        {/* Строка управления доской: слева срок, справа набор. Оба про доску,
            а не про список под ней, поэтому и стоят вместе с ней. */}
        <div className="wboard__bar">
          {filter ?? <span />}
          {picker}
        </div>
        {grid}
      </div>
    )
  };
}

export { TILE as WIDGET_TILE };
