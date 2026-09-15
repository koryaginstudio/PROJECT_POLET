import * as React from 'react';

/** Icon-only control for toolbars, cards and map overlays. Always give it a label. */
export interface IconButtonProps {
  /** The glyph – an <Icon />. */
  children?: React.ReactNode;
  /** Accessible name, also the tooltip. */
  label: string;
  /** @default "ghost" */
  variant?: 'ghost' | 'secondary' | 'primary' | 'inverse';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Rounded square (12px) instead of a circle. @default false */
  square?: boolean;
  disabled?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  className?: string;
}
export declare function IconButton(props: IconButtonProps): JSX.Element;
