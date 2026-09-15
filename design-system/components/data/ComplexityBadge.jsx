import React from 'react';

const LABELS = ['простая', 'несложная', 'средняя', 'сложная', 'критичная'];
const CSS = `
.pl-cx{display:inline-flex;align-items:center;gap:8px;font-size:var(--fs-caption);font-weight:var(--fw-semibold);color:var(--text-secondary);white-space:nowrap}
.pl-cx__bars{display:flex;align-items:flex-end;gap:2px;height:14px}
.pl-cx__bar{width:4px;border-radius:2px;background:var(--ink-200)}
.pl-cx__bar--on{background:var(--ink-1000)}
.pl-cx__bar--warn{background:var(--accent-500)}
.pl-cx__bar--risk{background:var(--danger-500)}
.pl-cx--inverse{color:var(--ink-400)}
.pl-cx--inverse .pl-cx__bar{background:var(--ink-700)}
.pl-cx--inverse .pl-cx__bar--on{background:var(--white)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function ComplexityBadge({ level = 3, showLabel = true, label, tone = 'default', style, className = '' }) {
  styles();
  const fill = level >= 5 ? 'risk' : level === 4 ? 'warn' : 'on';
  return (
    <span className={['pl-cx', tone === 'inverse' && 'pl-cx--inverse', className].filter(Boolean).join(' ')} style={style} title={'Сложность ' + level + ' из 5'}>
      <span className="pl-cx__bars">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={'pl-cx__bar' + (i <= level ? ' pl-cx__bar--' + fill : '')} style={{ height: 5 + i * 2 }} />
        ))}
      </span>
      {showLabel && <span>{label || LABELS[level - 1]}</span>}
    </span>
  );
}
