import React from 'react';

const CSS = `
.pl-top{display:flex;align-items:center;gap:24px;height:var(--topbar-h);padding:0 var(--gutter);background:var(--white);border-bottom:1px solid var(--border-hairline)}
.pl-top--floating{border:0;border-radius:var(--r-pill);box-shadow:var(--shadow-md);height:64px;padding:0 12px 0 24px}
.pl-top__brand{display:flex;align-items:center;flex:0 0 auto}
.pl-top__nav{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0}
.pl-top__link{display:inline-flex;align-items:center;height:36px;padding:0 14px;border-radius:var(--r-pill);color:var(--text-secondary);font-size:var(--fs-body-s);font-weight:var(--fw-medium);text-decoration:none;border:0;background:transparent;cursor:pointer;font-family:var(--font-sans);transition:var(--t-control);white-space:nowrap}
.pl-top__link:hover{background:var(--ink-100);color:var(--text-primary)}
.pl-top__link--active{color:var(--text-primary);font-weight:var(--fw-semibold);background:var(--ink-100)}
.pl-top__actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function TopBar({ brand, links = [], value, onChange, actions, floating = false, style, className = '' }) {
  styles();
  return (
    <header className={['pl-top', floating && 'pl-top--floating', className].filter(Boolean).join(' ')} style={style}>
      {brand && <div className="pl-top__brand">{brand}</div>}
      <nav className="pl-top__nav">
        {links.map((l) => (
          <button key={l.value} type="button" className={'pl-top__link' + (l.value === value ? ' pl-top__link--active' : '')} onClick={() => onChange && onChange(l.value)}>
            {l.label}
          </button>
        ))}
      </nav>
      {actions && <div className="pl-top__actions">{actions}</div>}
    </header>
  );
}
