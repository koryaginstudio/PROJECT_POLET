import React from 'react';

const CSS = `
.pl-seg{display:inline-flex;padding:3px;gap:2px;background:var(--ink-100);border-radius:var(--r-pill)}
.pl-seg--block{display:flex;width:100%}
.pl-seg__item{flex:1 1 auto;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 16px;border:0;border-radius:var(--r-pill);background:transparent;color:var(--text-secondary);font-family:var(--font-sans);font-size:var(--fs-body-s);font-weight:var(--fw-medium);cursor:pointer;white-space:nowrap;transition:var(--t-control)}
.pl-seg__item:hover{color:var(--text-primary)}
.pl-seg__item:focus-visible{outline:none;box-shadow:var(--ring-focus)}
.pl-seg__item--active{background:var(--white);color:var(--text-primary);font-weight:var(--fw-semibold);box-shadow:var(--shadow-sm)}
.pl-seg--sm .pl-seg__item{height:26px;padding:0 12px;font-size:var(--fs-caption)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function SegmentedControl({ items = [], value, size = 'md', block = false, onChange, style, className = '' }) {
  styles();
  const norm = items.map((i) => (typeof i === 'string' ? { value: i, label: i } : i));
  const current = value !== undefined ? value : norm[0] && norm[0].value;
  return (
    <div className={['pl-seg', size === 'sm' && 'pl-seg--sm', block && 'pl-seg--block', className].filter(Boolean).join(' ')} style={style} role="tablist">
      {norm.map((i) => (
        <button
          key={i.value}
          type="button"
          role="tab"
          aria-selected={i.value === current}
          className={'pl-seg__item' + (i.value === current ? ' pl-seg__item--active' : '')}
          onClick={() => onChange && onChange(i.value)}
        >
          {i.icon}
          {i.label}
        </button>
      ))}
    </div>
  );
}
