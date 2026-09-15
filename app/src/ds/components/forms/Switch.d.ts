import * as React from 'react';

/** Toggle switch. Ink track when on – never accent. */
export interface SwitchProps {
  label?: React.ReactNode;
  checked?: boolean;
  defaultChecked?: boolean;
  disabled?: boolean;
  /** 'md' by default; 'sm' for dense bars and legends. */
  size?: 'md' | 'sm';
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  name?: string;
  style?: React.CSSProperties;
  className?: string;
}
export declare function Switch(props: SwitchProps): JSX.Element;
