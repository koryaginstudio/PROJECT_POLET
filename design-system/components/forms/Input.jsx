import React from 'react';

const CSS = `
.pl-field{display:flex;flex-direction:column;gap:6px;min-width:0}
.pl-field__label{font-size:var(--fs-body-s);font-weight:var(--fw-medium);color:var(--text-primary)}
.pl-field__req{color:var(--accent-700)}
.pl-field__hint{font-size:var(--fs-caption);color:var(--text-secondary)}
.pl-field__hint--error{color:var(--danger-600)}
.pl-input{display:flex;align-items:center;gap:8px;height:var(--control-h);padding:0 14px;background:var(--white);border:1px solid var(--border-subtle);border-radius:var(--r-control);transition:var(--t-control);color:var(--text-primary)}
.pl-input:hover{border-color:var(--ink-300)}
.pl-input:focus-within{border-color:var(--ink-1000);box-shadow:var(--ring-focus)}
.pl-input--error{border-color:var(--danger-500)}
.pl-input--error:focus-within{box-shadow:0 0 0 3px rgba(227,59,50,.25)}
.pl-input--disabled{background:var(--ink-100);border-color:var(--border-hairline);opacity:.7}
.pl-input--lg{height:var(--control-h-lg);padding:0 16px}
.pl-input--sm{height:var(--control-h-sm);padding:0 10px}
.pl-input__el{flex:1 1 auto;min-width:0;border:0;background:transparent;outline:none;font-family:var(--font-sans);font-size:var(--fs-body-s);color:var(--text-primary)}
.pl-input__el::placeholder{color:var(--text-muted)}
.pl-input__el:disabled{cursor:not-allowed}
.pl-input__aff{display:inline-flex;align-items:center;color:var(--icon-secondary);font-size:var(--fs-body-s)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Input({ label, hint, error, value, defaultValue, placeholder, type = 'text', size = 'md', prefix, suffix, disabled = false, required = false, onChange, name, id, style, className = '' }) {
  styles();
  const boxCls = ['pl-input', error && 'pl-input--error', disabled && 'pl-input--disabled', size !== 'md' && 'pl-input--' + size].filter(Boolean).join(' ');
  return (
    <div className={'pl-field ' + className} style={style}>
      {label && <label className="pl-field__label" htmlFor={id}>{label}{required && <span className="pl-field__req"> *</span>}</label>}
      <div className={boxCls}>
        {prefix && <span className="pl-input__aff">{prefix}</span>}
        <input className="pl-input__el" id={id} name={name} type={type} value={value} defaultValue={defaultValue} placeholder={placeholder} disabled={disabled} onChange={onChange} />
        {suffix && <span className="pl-input__aff">{suffix}</span>}
      </div>
      {(error || hint) && <div className={'pl-field__hint' + (error ? ' pl-field__hint--error' : '')}>{error || hint}</div>}
    </div>
  );
}
