import * as React from 'react';

/** Small status pill for job state, counts and labels. */
export interface BadgeProps {
  children?: React.ReactNode;
  /** @default "neutral" */
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'inverse' | 'outline' | 'gradient';
  /** @default "md" */
  size?: 'md' | 'lg';
  /** Leading status dot. @default false */
  dot?: boolean;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Badge(props: BadgeProps): JSX.Element;
