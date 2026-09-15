import React from 'react';

const CSS = `
.pl-stat{display:flex;flex-direction:column;gap:10px;padding:var(--tile-pad);border-radius:var(--r-tile);background:var(--surface-tile);color:var(--text-primary);min-width:0}
.pl-stat--white{background:var(--white);box-shadow:var(--shadow-inset-hairline)}
.pl-stat--inverse{background:var(--surface-inverse);color:var(--text-inverse)}
.pl-stat--gradient{background:var(--grad-brand-diag);color:var(--ink-1000)}
.pl-stat__head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.pl-stat__label{font-size:var(--fs-body-s);font-weight:var(--fw-medium);color:var(--text-secondary)}
.pl-stat--inverse .pl-stat__label{color:var(--ink-400)}
.pl-stat--gradient .pl-stat__label{color:var(--accent-700)}
.pl-stat__value{display:flex;align-items:baseline;gap:6px;font-family:var(--font-display);font-weight:var(--fw-extrabold);font-size:var(--fs-display-m);line-height:1;letter-spacing:var(--ls-display-m);font-variant-numeric:tabular-nums}
.pl-stat__unit{font-size:var(--fs-h4);font-weight:var(--fw-semibold);letter-spacing:0;color:var(--text-secondary)}
.pl-stat--inverse .pl-stat__unit{color:var(--ink-400)}
.pl-stat__foot{display:flex;align-items:center;gap:8px;font-size:var(--fs-caption);color:var(--text-secondary)}
.pl-stat--inverse .pl-stat__foot{color:var(--ink-400)}
.pl-stat__delta{font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums}
.pl-stat__delta--up{color:var(--success-600)}
.pl-stat__delta--down{color:var(--danger-600)}
.pl-stat--inverse .pl-stat__delta--up{color:#4FD08A}
.pl-stat--inverse .pl-stat__delta--down{color:#FF8B84}
.pl-stat__compact{padding:var(--card-pad);border-radius:var(--r-card)}
.pl-stat__compact .pl-stat__value{font-size:var(--fs-h1);letter-spacing:var(--ls-h1)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function StatTile({ label, value, unit, delta, deltaDirection = 'up', caption, icon, tone = 'tile', compact = false, style, className = '' }) {
  styles();
  const cls = ['pl-stat', tone !== 'tile' && 'pl-stat--' + tone, compact && 'pl-stat__compact', className].filter(Boolean).join(' ');
  return (
    <div className={cls} style={style}>
      <div className="pl-stat__head">
        <span className="pl-stat__label">{label}</span>
        {icon}
      </div>
      <div className="pl-stat__value">
        {value}
        {unit && <span className="pl-stat__unit">{unit}</span>}
      </div>
      {(delta || caption) && (
        <div className="pl-stat__foot">
          {delta && <span className={'pl-stat__delta pl-stat__delta--' + deltaDirection}>{deltaDirection === 'up' ? '↑' : '↓'} {delta}</span>}
          {caption}
        </div>
      )}
    </div>
  );
}
