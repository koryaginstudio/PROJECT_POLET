import * as React from 'react';

/** Job complexity 1–5 as a five-bar meter. Ink up to 3, accent at 4, red at 5. */
export interface ComplexityBadgeProps {
  /** 1–5. @default 3 */
  level?: 1 | 2 | 3 | 4 | 5;
  /** @default true */
  showLabel?: boolean;
  /** Override the Russian default label (простая…критичная). */
  label?: React.ReactNode;
  /** Use on ink tiles. @default "default" */
  tone?: 'default' | 'inverse';
  style?: React.CSSProperties;
  className?: string;
}
export declare function ComplexityBadge(props: ComplexityBadgeProps): JSX.Element;
