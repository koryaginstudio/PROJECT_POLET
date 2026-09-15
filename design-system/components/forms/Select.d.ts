import * as React from 'react';

/** Native select in brand chrome. Use for 4+ mutually exclusive options; below that use SegmentedControl. */
export interface SelectOption { value: string; label: string }
export interface SelectProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  /** Strings or {value,label} objects. */
  options?: Array<string | SelectOption>;
  value?: string;
  defaultValue?: string;
  /** @default "md" */
  size?: 'sm' | 'md';
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  name?: string;
  id?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Select(props: SelectProps): JSX.Element;
