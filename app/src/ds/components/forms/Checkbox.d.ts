import * as React from 'react';

/** Checkbox with optional description line. Ink fill when checked – never accent. */
export interface CheckboxProps {
  label?: React.ReactNode;
  /** Secondary line under the label. */
  description?: React.ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Checkbox(props: CheckboxProps): JSX.Element;
