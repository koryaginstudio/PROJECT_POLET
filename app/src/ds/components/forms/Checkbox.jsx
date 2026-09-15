import React from 'react';

const CSS = `
.pl-check{display:inline-flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:var(--fs-body-s);color:var(--text-primary);line-height:20px}
.pl-check--disabled{opacity:.45;cursor:not-allowed}
.pl-check__box{position:relative;flex:0 0 auto;width:20px;height:20px;border:1.5px solid var(--ink-300);border-radius:6px;background:var(--white);transition:var(--t-control);display:flex;align-items:center;justify-content:center;color:var(--white)}
.pl-check:hover .pl-check__box{border-color:var(--ink-500)}
.pl-check__input{position:absolute;opacity:0;width:0;height:0}
.pl-check__input:focus-visible + .pl-check__box{box-shadow:var(--ring-focus);border-color:var(--ink-1000)}
.pl-check__input:checked + .pl-check__box{background:var(--ink-1000);border-color:var(--ink-1000)}
.pl-check__mark{opacity:0;transition:opacity var(--dur-fast) var(--ease-out)}
.pl-check__input:checked + .pl-check__box .pl-check__mark{opacity:1}
.pl-check__desc{display:block;color:var(--text-secondary);font-size:var(--fs-caption);margin-top:2px}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Checkbox({ label, description, checked, defaultChecked, disabled = false, onChange, name, style, className = '' }) {
  styles();
  return (
    <label className={['pl-check', disabled && 'pl-check--disabled', className].filter(Boolean).join(' ')} style={style}>
      <input className="pl-check__input" type="checkbox" checked={checked} defaultChecked={defaultChecked} disabled={disabled} onChange={onChange} name={name} />
      <span className="pl-check__box">
        <svg className="pl-check__mark" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
      </span>
      <span>{label}{description && <span className="pl-check__desc">{description}</span>}</span>
    </label>
  );
}
