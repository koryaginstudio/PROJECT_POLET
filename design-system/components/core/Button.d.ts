import * as React from 'react';

/**
 * Pill action button. Ink primary, hairline secondary, gradient only for the single
 * strongest CTA on a surface.
 * @startingPoint section="Core" subtitle="Pill buttons: ink, hairline, gradient" viewport="700x220"
 */
export interface ButtonProps {
  children?: React.ReactNode;
  /** @default "primary" */
  variant?: 'primary' | 'secondary' | 'ghost' | 'accent' | 'inverse';
  /** @default "md" */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to container width. @default false */
  block?: boolean;
  /** @default false */
  disabled?: boolean;
  /** Usually an <Icon />. */
  iconLeft?: React.ReactNode;
  iconRight?: React.ReactNode;
  /** Renders an <a> instead of a <button>. */
  href?: string;
  onClick?: (e: React.MouseEvent) => void;
  /** @default "button" */
  type?: 'button' | 'submit' | 'reset';
  style?: React.CSSProperties;
  className?: string;
}
export declare function Button(props: ButtonProps): JSX.Element;
