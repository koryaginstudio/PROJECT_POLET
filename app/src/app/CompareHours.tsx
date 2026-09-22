import { useMemo, useState } from 'react';
import type { HourSlice, RunProfile } from '../data/registry.ts';
import { dayEnd, dayStart, dec, hhmm } from '../data/derive.ts';

/* Ход дня, наложенный друг на друга.

   Итоги отвечают на «что вышло»: покрытие 66 против 67 — и дальше тупик, из
   двух чисел не видно, чем планы отличались. Отличаются они ходом: в одном к
   десяти утра на маршрутах двенадцать инженеров, в другом семь; один упирается
   в потолок к обеду, второй ровно досиживает смену. Это видно только тогда,
   когда кривые лежат в одних осях.

   Наложение, а не столбцы рядом: сравнивают форму, а не отдельные часы. Два
   ряда столбиков через весь день глаз читает как две картинки, две линии в
   одних осях — как одну.

   Величин по часу семь, и раньше они лежали в одних осях по очереди —
   переключателем. Переключатель прятал разговор: занятость падает к обеду,
   а из-за чего — из-за дороги или ожидания — видно уже на другой вкладке, и
   к тому времени первая картинка из головы ушла. Поэтому величины разведены
   по своим осям и стоят рядом: каждая со своим потолком (у людей и
   человеко-часов масштабы разные), но с общей шкалой часов. Глаз ведёт
   вертикаль через всю сетку и читает провал сразу во всех величинах.

   Час под курсором общий на всю сетку: наведение на любую диаграмму ставит
   отметку во всех — иначе связывать провалы пришлось бы на глаз. */

export type HourMetric = keyof Pick<
  HourSlice,
  'busy' | 'working' | 'travelling' | 'done' | 'workMinutes' | 'travelMinutes' | 'waitMinutes'
>;

const METRICS: {
  key: HourMetric;
  label: string;
  note: string;
  /** Человеко-минуты показываем часами: «310 мин работы в час» не читается. */
  asHours?: boolean;
  unit: string;
}[] = [
  {
    key: 'busy',
    label: 'Инженеров занято',
    note: 'Едут или работают',
    unit: 'чел.'
  },
  {
    key: 'working',
    label: 'Инженеров на объекте',
    note: 'Из занятых — те, кто на заявке',
    unit: 'чел.'
  },
  {
    key: 'travelling',
    label: 'Инженеров в пути',
    note: 'Едут между заявками',
    unit: 'чел.'
  },
  {
    key: 'done',
    label: 'Заявок закрыто',
    note: 'Закончилось в этот час',
    unit: 'шт.'
  },
  {
    key: 'workMinutes',
    label: 'Часов работы',
    note: 'Человеко-часы по всем инженерам',
    asHours: true,
    unit: 'ч'
  },
  {
    key: 'travelMinutes',
    label: 'Часов в пути',
    note: 'Во что обходятся переезды',
    asHours: true,
    unit: 'ч'
  },
  {
    key: 'waitMinutes',
    label: 'Часов ожидания',
    note: 'Приехали раньше, чем открылось окно',
    asHours: true,
    unit: 'ч'
  }
];

/* Размер одной диаграммы в сетке. Он вдвое меньше прежнего одиночного: семь
   штук в ряд по три помещаются только так, а формы кривой хватает и здесь —
   точные числа всё равно читают в строке значений, а не по оси. */
const W = 420;
const H = 180;
/* Поля по краям держат подписи часов: крайние стоят по центру своей точки, и
   с узкими полями «07:00» и «20:00» срезало пополам. */
const PAD = { top: 12, right: 24, bottom: 22, left: 38 };

/* Цвет расчёта. Взят не из общего ряда `--series-*`: там соседние оттенки
   различаются мягко, что годится для долей одной диаграммы и не годится для
   четырёх кривых в одних осях — оранжевая и золотая на графике сливаются.
   Здесь нужны четыре заведомо разных тона, больше четырёх в сравнение всё
   равно не берут. */
const RUN_COLORS = [
  'var(--accent-500)',
  'var(--ink-900)',
  'var(--success-600)',
  'var(--danger-500)'
];

export const runColor = (index: number) => RUN_COLORS[index % RUN_COLORS.length];

export function CompareHours({ profiles }: { profiles: RunProfile[] }) {
  /* Час под курсором живёт здесь, а не в отдельной диаграмме: сравнение тем и
     держится, что в одном часу видно и каждый расчёт, и каждую величину. */
  const [hot, setHot] = useState<number | null>(null);

  /* Ось берём по границам смены, а не по всем суткам: разрез посчитан на
     сутки целиком именно затем, чтобы пережить смену настройки, а показывать
     пустые ночные часы незачем. */
  const from = Math.floor(dayStart() / 60);
  const to = Math.ceil(dayEnd() / 60);
  const hours = useMemo(
    () => Array.from({ length: Math.max(1, to - from) }, (_, index) => from + index),
    [from, to]
  );

  return (
    <div className="chours">
      <div className="chours__head">
        {/* Место под час держим всегда: иначе шапка дёргается, стоит увести
            курсор с сетки. */}
        <span className="chours__hour">
          {hot === null ? '' : `${hhmm(hours[hot] * 60)}–${hhmm((hours[hot] + 1) * 60)}`}
        </span>
        {/* Соответствие «цвет — расчёт» стоит один раз на всю сетку: семь
            повторов одной легенды заняли бы больше места, чем сами кривые. */}
        <div className="chours__runs">
          {profiles.map((profile, index) => (
            <span key={profile.run.id} className="chours__key">
              <i className="chours__dotmark" style={{ background: runColor(index) }} />
              <b>{profile.run.code}</b>
            </span>
          ))}
        </div>
      </div>

      <div className="chours__grid-wrap">
        {METRICS.map((shape) => (
          <HourChart
            key={shape.key}
            shape={shape}
            profiles={profiles}
            hours={hours}
            hot={hot}
            onHot={setHot}
          />
        ))}
      </div>
    </div>
  );
}

function HourChart({
  shape,
  profiles,
  hours,
  hot,
  onHot
}: {
  shape: (typeof METRICS)[number];
  profiles: RunProfile[];
  hours: number[];
  hot: number | null;
  onHot: (hour: number | null) => void;
}) {
  const scale = shape.asHours ? 1 / 60 : 1;

  const series = useMemo(
    () =>
      profiles.map((profile) => ({
        run: profile.run,
        values: hours.map((hour) => (profile.hours[hour]?.[shape.key] ?? 0) * scale)
      })),
    [profiles, hours, shape.key, scale]
  );

  const top = Math.max(1, ...series.flatMap((one) => one.values));
  /* Потолок округляем вверх до круглого: ось, упирающаяся в самое большое
     значение, делает его границей возможного, хотя оно просто самое большое.
     Потолок у каждой диаграммы свой: свести людей и человеко-часы к одной
     шкале значит расплющить в ноль ту величину, что помельче. */
  const ceiling = niceTop(top);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (index: number) =>
    PAD.left + (hours.length > 1 ? (index / (hours.length - 1)) * plotW : plotW / 2);
  const y = (value: number) => PAD.top + plotH - (value / ceiling) * plotH;

  /* Линий сетки на маленькой диаграмме три, а не пять: на 180 точках высоты
     пять подписей по оси сливаются в столбик цифр. */
  const grid = [0, 0.5, 1].map((part) => ({
    at: PAD.top + plotH - part * plotH,
    value: ceiling * part
  }));

  const label = (value: number) =>
    shape.asHours ? dec(value) : String(Math.round(value * 10) / 10);

  /* Подписи часов ставим через одну: на узкой оси четырнадцать «07:00» подряд
     сливаются в серую полосу. Крайние часы подписаны всегда — ими читается
     охват смены, — а сосед, подошедший к последнему вплотную, снимается:
     иначе «19:00» и «20:00» налезают друг на друга. */
  const ticks = useMemo(() => {
    const last = hours.length - 1;
    const step = hours.length > 8 ? Math.ceil(hours.length / 6) : 1;
    const picked = hours
      .map((_, index) => index)
      .filter((index) => index % step === 0 && last - index >= step / 2);
    return new Set([...picked, last]);
  }, [hours.length]);

  /* Пока час не выбран, в строке стоит итог смены. Для человеко-часов это
     сумма, а для людей — пик: сложить «занятых» по всем часам значит посчитать
     одного и того же инженера четырнадцать раз и получить число, которого в
     смене не было. */
  const summary = (values: number[]) =>
    shape.asHours
      ? `${label(values.reduce((sum, value) => sum + value, 0))} ${shape.unit}`
      : `до ${label(Math.max(0, ...values))} ${shape.unit}`;

  return (
    <figure className="chours__cell">
      <figcaption className="chours__cell-head">
        <span className="chours__cell-title">{shape.label}</span>
        <span className="chours__cell-note">{shape.note}</span>
      </figcaption>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chours__svg"
        role="img"
        aria-label={`${shape.label} по часам: ${series.map((one) => one.run.code).join(', ')}`}
        onMouseLeave={() => onHot(null)}
      >
        {grid.map((line) => (
          <g key={line.at}>
            <line
              className="chours__grid"
              x1={PAD.left}
              x2={W - PAD.right}
              y1={line.at}
              y2={line.at}
            />
            <text className="chours__ytick" x={PAD.left - 6} y={line.at + 4}>
              {label(line.value)}
            </text>
          </g>
        ))}

        {hot !== null && (
          <line
            className="chours__cross"
            x1={x(hot)}
            x2={x(hot)}
            y1={PAD.top}
            y2={PAD.top + plotH}
          />
        )}

        {series.map((one, index) => (
          <g key={one.run.id}>
            <path
              className="chours__line"
              style={{ stroke: runColor(index) }}
              d={one.values
                .map((value, at) => `${at === 0 ? 'M' : 'L'}${x(at)} ${y(value)}`)
                .join(' ')}
            />
            {hot !== null && (
              <circle
                className="chours__dot"
                cx={x(hot)}
                cy={y(one.values[hot])}
                r={3.5}
                style={{ fill: runColor(index) }}
              />
            )}
          </g>
        ))}

        {hours.map((hour, index) =>
          ticks.has(index) ? (
            <text key={hour} className="chours__xtick" x={x(index)} y={H - 7}>
              {hhmm(hour * 60)}
            </text>
          ) : null
        )}

        {/* Ловушки во всю высоту: попадать курсором в кривую не нужно,
            достаточно встать над часом. */}
        {hours.map((hour, index) => (
          <rect
            key={`grip-${hour}`}
            className="chours__grip"
            x={x(index) - plotW / Math.max(1, (hours.length - 1) * 2)}
            y={PAD.top}
            width={plotW / Math.max(1, hours.length - 1)}
            height={plotH}
            onMouseEnter={() => onHot(index)}
          />
        ))}
      </svg>

      {/* Значения часа — строкой под графиком, а не всплывающей подсказкой:
          подсказка закрывает собой те самые кривые, ради которых её открыли,
          и прыгает за курсором вместе с числами. Коды расчётов здесь не
          повторяются — цвета названы один раз в шапке сетки. */}
      <div className="chours__read">
        {series.map((one, index) => (
          <span key={one.run.id} className="chours__key" title={one.run.code}>
            <i className="chours__dotmark" style={{ background: runColor(index) }} />
            <span className="chours__value">
              {hot === null
                ? summary(one.values)
                : `${label(one.values[hot])} ${shape.unit}`}
            </span>
          </span>
        ))}
      </div>
    </figure>
  );
}

/** Круглый потолок оси: 7 → 8, 23 → 25, 140 → 150. */
function niceTop(value: number): number {
  if (value <= 10) return Math.ceil(value);
  const power = 10 ** Math.floor(Math.log10(value));
  const step = power / 2;
  return Math.ceil(value / step) * step;
}
