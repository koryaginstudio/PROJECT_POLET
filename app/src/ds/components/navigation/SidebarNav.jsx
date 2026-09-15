import React from 'react';

const CSS = `
.pl-side{display:flex;flex-direction:column;gap:4px;width:var(--sidebar-w);padding:12px;background:var(--white);min-width:0}
.pl-side__group{font-size:var(--fs-overline);letter-spacing:var(--ls-overline);text-transform:uppercase;font-weight:var(--fw-bold);color:var(--text-muted);padding:16px 12px 6px}
.pl-side__item{display:flex;align-items:center;gap:10px;height:40px;padding:0 12px;border-radius:var(--r-control);color:var(--text-secondary);font-size:var(--fs-body-s);font-weight:var(--fw-medium);cursor:pointer;transition:var(--t-control);border:0;background:transparent;width:100%;text-align:left;font-family:var(--font-sans);text-decoration:none}
.pl-side__item:hover{background:var(--ink-100);color:var(--text-primary)}
.pl-side__item:focus-visible{outline:none;box-shadow:var(--ring-focus)}
.pl-side__item--active{background:var(--ink-1000);color:var(--white);font-weight:var(--fw-semibold)}
.pl-side__item--active:hover{background:var(--ink-800);color:var(--white)}
.pl-side__label{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pl-side__count{font-size:var(--fs-caption);font-weight:var(--fw-semibold);font-variant-numeric:tabular-nums;color:var(--text-muted)}
.pl-side__item--active .pl-side__count{color:var(--ink-400)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function SidebarNav({ items = [], value, onChange, footer, style, className = '' }) {
  styles();
  return (
    <nav className={'pl-side ' + className} style={style}>
      {items.map((it, i) => {
        if (it.group) return <div className="pl-side__group" key={'g' + i}>{it.group}</div>;
        const active = it.value === value;
        return (
          <button key={it.value} type="button" className={'pl-side__item' + (active ? ' pl-side__item--active' : '')} onClick={() => onChange && onChange(it.value)}>
            {it.icon}
            <span className="pl-side__label">{it.label}</span>
            {it.count !== undefined && <span className="pl-side__count">{it.count}</span>}
          </button>
        );
      })}
      {footer && <div style={{ marginTop: 'auto' }}>{footer}</div>}
    </nav>
  );
}
