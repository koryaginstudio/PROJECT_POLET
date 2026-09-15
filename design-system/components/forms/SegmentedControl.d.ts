import * as React from 'react';

/** 2–4 exclusive views (день / неделя / месяц). Grey track, white active pill. */
export interface SegmentedItem { value: string; label: React.ReactNode; icon?: React.ReactNode }
export interface SegmentedControlProps {
  items?: Array<string | SegmentedItem>;
  /** Controlled value; defaults to the first item. */
  value?: string;
  /** @default "md" */
  size?: 'sm' | 'md';
  /** Fill the container width. @default false */
  block?: boolean;
  onChange?: (value: string) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function SegmentedControl(props: SegmentedControlProps): JSX.Element;
