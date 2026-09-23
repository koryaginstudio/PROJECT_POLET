import React from 'react';

const CSS = `
.pl-badge{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:var(--r-pill);background:var(--ink-100);color:var(--ink-700);font-family:var(--font-sans);font-size:var(--fs-caption);font-weight:var(--fw-semibold);letter-spacing:-0.002em;white-space:nowrap;border:1px solid transparent}
.pl-badge--lg{height:28px;padding:0 12px;font-size:var(--fs-body-s)}
.pl-badge--accent{background:var(--accent-100);color:var(--accent-700)}
.pl-badge--success{background:var(--success-100);color:var(--success-600)}
.pl-badge--danger{background:var(--danger-100);color:var(--danger-600)}
.pl-badge--inverse{background:var(--ink-1000);color:var(--white)}
.pl-badge--outline{background:transparent;border-color:var(--border-subtle);color:var(--ink-700)}
.pl-badge--gradient{background:var(--grad-brand);color:var(--text-on-brand)}
.pl-badge__dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:0 0 auto}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Badge({ children, tone = 'neutral', size = 'md', dot = false, style, className = '' }) {
  styles();
  const cls = ['pl-badge', tone !== 'neutral' && 'pl-badge--' + tone, size === 'lg' && 'pl-badge--lg', className].filter(Boolean).join(' ');
  return (
    <span className={cls} style={style}>
      {dot && <span className="pl-badge__dot" />}
      {children}
    </span>
  );
}
