import React from 'react';

const CSS = `
.pl-tw{display:flex;flex-direction:column;gap:6px;min-width:0}
.pl-tw__track{position:relative;height:10px;border-radius:var(--r-pill);background:var(--ink-150);overflow:visible}
.pl-tw__win{position:absolute;top:0;bottom:0;border-radius:var(--r-pill);background:var(--ink-1000)}
.pl-tw__win--accent{background:var(--grad-brand)}
.pl-tw__win--risk{background:var(--danger-500)}
.pl-tw__win--done{background:var(--success-500)}
.pl-tw__eta{position:absolute;top:-4px;width:2px;height:18px;border-radius:1px;background:var(--ink-1000);box-shadow:0 0 0 2px var(--white)}
.pl-tw__scale{display:flex;justify-content:space-between;font-size:var(--fs-caption);color:var(--text-muted);font-variant-numeric:tabular-nums}
.pl-tw__legend{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:var(--fs-caption);color:var(--text-secondary);font-variant-numeric:tabular-nums}
.pl-tw__win-label{font-weight:var(--fw-semibold);color:var(--text-primary)}
.pl-tw--inverse .pl-tw__track{background:var(--ink-800)}
.pl-tw--inverse .pl-tw__win{background:var(--white)}
.pl-tw--inverse .pl-tw__scale,.pl-tw--inverse .pl-tw__legend{color:var(--ink-400)}
.pl-tw--inverse .pl-tw__win-label{color:var(--white)}
.pl-tw--inverse .pl-tw__eta{background:var(--white);box-shadow:0 0 0 2px var(--ink-1000)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}
const min = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
};

export function TimeWindowBar({ dayStart = '08:00', dayEnd = '20:00', windowStart = '09:00', windowEnd = '13:00', eta, tone = 'accent', showScale = true, label, style, className = '' }) {
  styles();
  const span = Math.max(1, min(dayEnd) - min(dayStart));
  const pct = (t) => Math.min(100, Math.max(0, ((min(t) - min(dayStart)) / span) * 100));
  const left = pct(windowStart);
  const right = pct(windowEnd);
  return (
    <div className={['pl-tw', tone === 'inverse' && 'pl-tw--inverse', className].filter(Boolean).join(' ')} style={style}>
      {(label || eta) && (
        <div className="pl-tw__legend">
          <span className="pl-tw__win-label">{label || windowStart + '–' + windowEnd}</span>
          {eta && <span>прибытие {eta}</span>}
        </div>
      )}
      <div className="pl-tw__track">
        <div className={'pl-tw__win' + (tone !== 'default' && tone !== 'inverse' ? ' pl-tw__win--' + tone : '')} style={{ left: left + '%', width: Math.max(2, right - left) + '%' }} />
        {eta && <div className="pl-tw__eta" style={{ left: 'calc(' + pct(eta) + '% - 1px)' }} title={'Прибытие ' + eta} />}
      </div>
      {showScale && (
        <div className="pl-tw__scale">
          <span>{dayStart}</span>
          <span>{dayEnd}</span>
        </div>
      )}
    </div>
  );
}
