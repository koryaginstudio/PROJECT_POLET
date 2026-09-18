import * as React from 'react';

/** Single-colour pictogram from the Phosphor Bold set bundled in `Icon.jsx`. */
export interface IconProps {
  /** Glyph name, e.g. `route`, `map-pin`, `clock`. Unknown names render nothing and warn. */
  name: string;
  /** Box size in px. 16 inline with 14px text, 20 default, 24 in tile headers. @default 20 */
  size?: number;
  /** Fill colour. Inherits text colour by default. @default "currentColor" */
  color?: string;
  /** Accessible name. Omit for decorative icons – they get `aria-hidden`. */
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}
export declare function Icon(props: IconProps): JSX.Element | null;
/** Path data of a glyph, for markup built outside React (map tooltips). */
export declare function iconPath(name: string): string | null;
