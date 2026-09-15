import React from 'react';

const CSS = `
.pl-switch{display:inline-flex;align-items:center;gap:12px;cursor:pointer;font-size:var(--fs-body-s);color:var(--text-primary)}
.pl-switch--disabled{opacity:.45;cursor:not-allowed}
.pl-switch__input{position:absolute;opacity:0;width:0;height:0}
.pl-switch__track{position:relative;flex:0 0 auto;width:40px;height:24px;border-radius:var(--r-pill);background:var(--ink-200);transition:var(--t-control)}
.pl-switch__knob{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:var(--white);box-shadow:var(--shadow-sm);transition:transform var(--dur) var(--ease-standard)}
.pl-switch:hover .pl-switch__track{background:var(--ink-300)}
.pl-switch__input:checked + .pl-switch__track{background:var(--ink-1000)}
.pl-switch__input:checked + .pl-switch__track .pl-switch__knob{transform:translateX(16px)}
.pl-switch__input:focus-visible + .pl-switch__track{box-shadow:var(--ring-focus)}
.pl-switch--sm .pl-switch__track{width:32px;height:20px}
.pl-switch--sm .pl-switch__knob{width:14px;height:14px}
.pl-switch--sm .pl-switch__input:checked + .pl-switch__track .pl-switch__knob{transform:translateX(12px)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Switch({ label, checked, defaultChecked, disabled = false, size = 'md', onChange, name, style, className = '' }) {
  styles();
  return (
    <label className={['pl-switch', size === 'sm' && 'pl-switch--sm', disabled && 'pl-switch--disabled', className].filter(Boolean).join(' ')} style={style}>
      <input className="pl-switch__input" type="checkbox" checked={checked} defaultChecked={defaultChecked} disabled={disabled} onChange={onChange} name={name} />
      <span className="pl-switch__track"><span className="pl-switch__knob" /></span>
      {label && <span>{label}</span>}
    </label>
  );
}
