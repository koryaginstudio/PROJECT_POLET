import * as React from 'react';

/**
 * Single metric in a bento block. Big tabular number, quiet label.
 * @startingPoint section="Data" subtitle="Metric tiles for dashboards" viewport="700x220"
 */
export interface StatTileProps {
  label?: React.ReactNode;
  value?: React.ReactNode;
  /** Unit suffix rendered smaller, e.g. "мин", "%". */
  unit?: React.ReactNode;
  /** Change indicator text, e.g. "12%". */
  delta?: React.ReactNode;
  /** @default "up" */
  deltaDirection?: 'up' | 'down';
  /** Text after the delta, e.g. "к прошлой неделе". */
  caption?: React.ReactNode;
  /** Small <Icon /> top-right. */
  icon?: React.ReactNode;
  /** @default "tile" */
  tone?: 'tile' | 'white' | 'inverse' | 'gradient';
  /** Card-sized instead of tile-sized. @default false */
  compact?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function StatTile(props: StatTileProps): JSX.Element;
