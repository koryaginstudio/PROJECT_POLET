import React from 'react';

const CSS = `
.pl-card{display:block;background:var(--surface-card);border:1px solid var(--border-hairline);border-radius:var(--r-card);padding:var(--card-pad);color:var(--text-primary);transition:var(--t-surface);text-decoration:none}
.pl-card--flat{border-color:transparent;background:var(--surface-tile)}
.pl-card--raised{border-color:transparent;box-shadow:var(--shadow-md)}
.pl-card--inverse{background:var(--surface-inverse);color:var(--text-inverse);border-color:transparent}
.pl-card--interactive{cursor:pointer}
.pl-card--interactive:hover{border-color:var(--ink-300);box-shadow:var(--shadow-md)}
.pl-card--interactive:active{transform:scale(0.996)}
.pl-card--interactive:focus-visible{outline:none;box-shadow:var(--ring-focus)}
.pl-card--selected{border-color:var(--ink-1000);box-shadow:var(--shadow-inset-hairline)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Card({ children, variant = 'outlined', interactive = false, selected = false, padding, radius, onClick, href, style, className = '' }) {
  styles();
  const cls = ['pl-card', variant !== 'outlined' && 'pl-card--' + variant, (interactive || onClick || href) && 'pl-card--interactive', selected && 'pl-card--selected', className].filter(Boolean).join(' ');
  const st = { ...(padding !== undefined ? { padding } : null), ...(radius !== undefined ? { borderRadius: radius } : null), ...style };
  if (href) return <a className={cls} href={href} style={st}>{children}</a>;
  return <div className={cls} onClick={onClick} style={st}>{children}</div>;
}
