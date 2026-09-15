import * as React from 'react';

/**
 * The client's time window drawn against the working day, with the planned arrival marker.
 * The product's signature data graphic.
 * @startingPoint section="Data" subtitle="Time window against the working day" viewport="700x180"
 */
export interface TimeWindowBarProps {
  /** Working day start, "HH:MM". @default "08:00" */
  dayStart?: string;
  /** @default "20:00" */
  dayEnd?: string;
  /** Client window start. @default "09:00" */
  windowStart?: string;
  /** @default "13:00" */
  windowEnd?: string;
  /** Planned arrival – draws the tick marker. */
  eta?: string;
  /** accent = normal, risk = arrival outside the window, done = closed, inverse = on ink tiles. @default "accent" */
  tone?: 'accent' | 'default' | 'risk' | 'done' | 'inverse';
  /** Show the day-start/day-end scale. @default true */
  showScale?: boolean;
  /** Overrides the "09:00–13:00" caption. */
  label?: React.ReactNode;
  style?: React.CSSProperties;
  className?: string;
}
export declare function TimeWindowBar(props: TimeWindowBarProps): JSX.Element;
