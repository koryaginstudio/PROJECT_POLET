import React from 'react';

const CSS = `
.pl-tabs{display:flex;gap:24px;border-bottom:1px solid var(--border-hairline)}
.pl-tabs__item{position:relative;display:inline-flex;align-items:center;gap:8px;padding:0 0 12px;border:0;background:transparent;color:var(--text-secondary);font-family:var(--font-sans);font-size:var(--fs-body-s);font-weight:var(--fw-medium);cursor:pointer;transition:var(--t-control)}
.pl-tabs__item:hover{color:var(--text-primary)}
.pl-tabs__item:focus-visible{outline:none;box-shadow:var(--ring-focus);border-radius:4px}
.pl-tabs__item--active{color:var(--text-primary);font-weight:var(--fw-semibold)}
.pl-tabs__item--active::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--ink-1000);border-radius:2px}
.pl-tabs__count{font-size:var(--fs-caption);font-variant-numeric:tabular-nums;color:var(--text-muted)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Tabs({ items = [], value, onChange, style, className = '' }) {
  styles();
  const norm = items.map((i) => (typeof i === 'string' ? { value: i, label: i } : i));
  const current = value !== undefined ? value : norm[0] && norm[0].value;
  return (
    <div className={'pl-tabs ' + className} style={style} role="tablist">
      {norm.map((i) => (
        <button key={i.value} type="button" role="tab" aria-selected={i.value === current} className={'pl-tabs__item' + (i.value === current ? ' pl-tabs__item--active' : '')} onClick={() => onChange && onChange(i.value)}>
          {i.label}
          {i.count !== undefined && <span className="pl-tabs__count">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}
