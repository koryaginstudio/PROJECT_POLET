import React from 'react';

/* The brand files in assets/logo/ are the client's uploads, byte-for-byte. This component
   only ever picks one and sets its height – it never recolours, re-spaces, filters or
   otherwise touches the artwork. See assets/logo/SOURCE.md.
   `base` resolves relative to the HTML document doing the rendering; the default works for
   any page two levels below the project root (components/*, ui_kits/*). */
const RATIO = {
  'lockup-h': 1304.46 / 429.52,
  'lockup-h-detail': 1301 / 425.74,
  'lockup-h-gradient-word': 1301 / 425.74,
  'lockup-h-gradient-mark': 1301 / 425.74,
  'lockup-v': 879 / 932.68,
  'lockup-v-detail': 879 / 885.9,
  'lockup-v-gradient-word': 879 / 932.68,
  'lockup-v-gradient-word-detail': 879 / 885.9,
  'lockup-v-gradient-mark': 879 / 885.9,
  'wordmark-gradient': 879 / 288.07,
  mark: 368.29 / 429.52
};

/* Gradient-mark artwork is a dark-background asset. Anywhere else is a brand violation. */
const DARK_ONLY = ['lockup-h-gradient-mark', 'lockup-v-gradient-mark'];

export function Logo({ variant = 'lockup-h', height = 28, base = '../../assets/logo', onDark = false, title = 'PROJECT POLET', style }) {
  const ratio = RATIO[variant];
  if (!ratio) {
    if (typeof console !== 'undefined') console.warn('[Logo] unknown variant "' + variant + '". Available: ' + Object.keys(RATIO).join(', '));
    return null;
  }
  if (typeof console !== 'undefined') {
    if (DARK_ONLY.indexOf(variant) > -1 && !onDark) console.warn('[Logo] "' + variant + '" is a dark-background asset. Pass onDark, or use a black variant.');
    if (DARK_ONLY.indexOf(variant) === -1 && onDark) console.warn('[Logo] on a dark surface use lockup-h-gradient-mark or lockup-v-gradient-mark.');
  }
  return (
    <img
      src={base + '/' + variant + '.svg'}
      alt={title}
      style={{ height, width: height * ratio, display: 'block', ...style }}
    />
  );
}
