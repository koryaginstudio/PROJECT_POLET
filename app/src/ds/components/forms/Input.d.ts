import * as React from 'react';

/** Single-line text field in brand chrome. Label above, hint or error below,
    optional prefix/suffix inside the box. */
export interface InputProps {
  label?: React.ReactNode;
  /** Secondary line under the field. Replaced by `error` when that is set. */
  hint?: React.ReactNode;
  /** Error text. Also turns the box red. */
  error?: React.ReactNode;
  value?: string | number;
  defaultValue?: string | number;
  placeholder?: string;
  /** @default "text" */
  type?: string;
  /** @default "md" */
  size?: 'sm' | 'md';
  /** Static content inside the box, before the field. */
  prefix?: React.ReactNode;
  /** Static content inside the box, after the field. */
  suffix?: React.ReactNode;
  disabled?: boolean;
  /** Marks the label with an asterisk. Does not enforce anything. */
  required?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name?: string;
  id?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Input(props: InputProps): JSX.Element;
