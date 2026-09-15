import { useState } from 'react';
import { wholePercents } from '../data/derive.ts';
import type { StatusSplit } from '../data/derive.ts';

interface Props {
  title: string;
  slices: StatusSplit[];
  centerValue: number;
  centerCaption: string;
  /** Отдаёт весь сектор целиком: подпись для заголовка списка и номера. */
  onPick?: (slice: { label: string; ids: string[] }) => void;
}

/* Кольцо рисуется дугами одной окружности: длина дуги — доля сектора.
   Между секторами оставляем зазор, но только если сектору есть что терять,
   иначе тонкие доли исчезнут совсем. */
const R = 46;
const C = 2 * Math.PI * R;
const GAP = 3;

const TONE_COLOR: Record<StatusSplit['tone'], string> = {
  ok: 'var(--success-500)',
  wait: 'var(--accent-500)',
  bad: 'var(--danger-500)'
};

export function Donut({ title, slices, centerValue, centerCaption, onPick }: Props) {
  /* Наведение живёт одним состоянием на диаграмму: и дуга, и строка легенды
     читают его, поэтому подсветка всегда идёт парой. */
  const [hovered, setHovered] = useState<string | null>(null);

  const sum = slices.reduce((acc, slice) => acc + slice.count, 0);
  const percents = wholePercents(slices.map((slice) => slice.count));
  const visible = slices.filter((slice) => slice.count > 0);

  let offset = 0;
  const arcs = visible.map((slice) => {
    const length = (slice.count / Math.max(sum, 1)) * C;
    const gap = visible.length > 1 ? Math.min(GAP, length * 0.4) : 0;
    const drawn = Math.max(length - gap, 0.6);
    const dimmed = hovered !== null && hovered !== slice.key;
    const arc = (
      <circle
        key={slice.key}
        className={'donut__arc' + (hovered === slice.key ? ' donut__arc--on' : '')}
        style={{ stroke: TONE_COLOR[slice.tone], opacity: dimmed ? 0.3 : 1 }}
        cx="60"
        cy="60"
        r={R}
        strokeDasharray={`${drawn} ${C - drawn}`}
        strokeDashoffset={-offset}
        onMouseEnter={() => setHovered(slice.key)}
        onMouseLeave={() => setHovered(null)}
        onClick={() => onPick && slice.ids.length > 0 && onPick(slice)}
      >
        <title>{`${slice.label}: ${slice.count}`}</title>
      </circle>
    );
    offset += length;
    return arc;
  });

  return (
    <div className="donut">
      <h3 className="donut__title">{title}</h3>

      <div className="donut__body">
        <svg
          className="donut__ring"
          viewBox="0 0 120 120"
          role="img"
          aria-label={
            visible.length > 0
              ? visible.map((slice) => `${slice.label}: ${slice.count}`).join(', ')
              : 'Нет данных'
          }
        >
          <circle className="donut__track" cx="60" cy="60" r={R} />
          <g transform="rotate(-90 60 60)">{arcs}</g>
          <text className="donut__center-value" x="60" y="58">
            {centerValue}
          </text>
          <text className="donut__center-caption" x="60" y="74">
            {centerCaption}
          </text>
        </svg>

        <ul className="donut__legend">
          {slices.map((slice, index) => {
            const clickable = Boolean(onPick) && slice.ids.length > 0;
            const inner = (
              <>
                <span className="donut__dot" style={{ background: TONE_COLOR[slice.tone] }} />
                <span className="donut__legend-label">{slice.label}</span>
                <span className="donut__legend-value">{slice.count}</span>
                <span className="donut__legend-pct">{percents[index]}%</span>
              </>
            );
            return (
              <li
                key={slice.key}
                className={
                  'donut__legend-row' +
                  (slice.count === 0 ? ' donut__legend-row--empty' : '') +
                  (hovered === slice.key ? ' donut__legend-row--on' : '')
                }
                onMouseEnter={() => setHovered(slice.key)}
                onMouseLeave={() => setHovered(null)}
              >
                {clickable ? (
                  <button type="button" className="donut__legend-btn" onClick={() => onPick!(slice)}>
                    {inner}
                  </button>
                ) : (
                  <span className="donut__legend-btn donut__legend-btn--static">{inner}</span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
