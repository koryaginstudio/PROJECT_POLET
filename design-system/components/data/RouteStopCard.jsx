import React from 'react';

const CSS = `
.pl-stop{display:flex;gap:16px;padding:16px;background:var(--white);border:1px solid var(--border-hairline);border-radius:var(--r-card);transition:var(--t-surface);cursor:pointer;text-align:left;width:100%;font-family:var(--font-sans)}
.pl-stop:hover{border-color:var(--ink-300);box-shadow:var(--shadow-md)}
.pl-stop:active{transform:scale(0.997)}
.pl-stop--selected{border-color:var(--ink-1000);box-shadow:var(--shadow-inset-hairline)}
.pl-stop__idx{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:var(--r-pill);background:var(--ink-100);color:var(--text-primary);font-size:var(--fs-body-s);font-weight:var(--fw-bold);font-variant-numeric:tabular-nums}
.pl-stop--done .pl-stop__idx{background:var(--success-100);color:var(--success-600)}
.pl-stop--active .pl-stop__idx{background:var(--grad-brand);color:var(--ink-1000)}
.pl-stop--risk .pl-stop__idx{background:var(--danger-100);color:var(--danger-600)}
.pl-stop__body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:6px}
.pl-stop__title{font-size:var(--fs-body-s);font-weight:var(--fw-semibold);color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-stop__meta{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:var(--fs-caption);color:var(--text-secondary);font-variant-numeric:tabular-nums}
.pl-stop__dot{width:3px;height:3px;border-radius:50%;background:var(--ink-300)}
.pl-stop__side{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;font-size:var(--fs-caption);color:var(--text-secondary);font-variant-numeric:tabular-nums}
.pl-stop__eta{font-size:var(--fs-body-s);font-weight:var(--fw-bold);color:var(--text-primary)}
.pl-stop--risk .pl-stop__eta{color:var(--danger-600)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function RouteStopCard({ index, title, address, window: win, eta, duration, status = 'planned', selected = false, badge, onClick, style, className = '' }) {
  styles();
  const cls = ['pl-stop', 'pl-stop--' + status, selected && 'pl-stop--selected', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick} style={style}>
      <span className="pl-stop__idx">{status === 'done' ? '✓' : index}</span>
      <span className="pl-stop__body">
        <span className="pl-stop__title">{title}</span>
        <span className="pl-stop__meta">
          {address && <span>{address}</span>}
          {address && win && <span className="pl-stop__dot" />}
          {win && <span>окно {win}</span>}
          {badge}
        </span>
      </span>
      <span className="pl-stop__side">
        {eta && <span className="pl-stop__eta">{eta}</span>}
        {duration && <span>{duration}</span>}
      </span>
    </button>
  );
}
