import React from 'react';

const CSS = `
.pl-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.pl-field__label{font-size:var(--fs-body-s);font-weight:var(--fw-medium);color:var(--text-primary)}
.pl-field__hint{font-size:var(--fs-caption);color:var(--text-secondary)}
.pl-select{position:relative;display:flex;align-items:center;height:var(--control-h);background:var(--white);border:1px solid var(--border-subtle);border-radius:var(--r-control);transition:var(--t-control)}
.pl-select:hover{border-color:var(--ink-300)}
.pl-select:focus-within{border-color:var(--ink-1000);box-shadow:var(--ring-focus)}
.pl-select--sm{height:var(--control-h-sm)}
.pl-select--disabled{background:var(--ink-100);opacity:.7}
.pl-select__el{appearance:none;width:100%;height:100%;padding:0 36px 0 14px;border:0;background:transparent;outline:none;font-family:var(--font-sans);font-size:var(--fs-body-s);color:var(--text-primary);cursor:pointer}
.pl-select--sm .pl-select__el{padding:0 30px 0 10px;font-size:var(--fs-caption)}
.pl-select__chev{position:absolute;right:12px;pointer-events:none;color:var(--icon-secondary);display:flex}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Select({ label, hint, options = [], value, defaultValue, size = 'md', disabled = false, onChange, name, id, style, className = '' }) {
  styles();
  const cls = ['pl-select', size !== 'md' && 'pl-select--' + size, disabled && 'pl-select--disabled'].filter(Boolean).join(' ');
  return (
    <div className={'pl-field ' + className} style={style}>
      {label && <label className="pl-field__label" htmlFor={id}>{label}</label>}
      <div className={cls}>
        <select className="pl-select__el" id={id} name={name} value={value} defaultValue={defaultValue} disabled={disabled} onChange={onChange}>
          {options.map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return <option key={opt.value} value={opt.value}>{opt.label}</option>;
          })}
        </select>
        <span className="pl-select__chev">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </div>
      {hint && <div className="pl-field__hint">{hint}</div>}
    </div>
  );
}
