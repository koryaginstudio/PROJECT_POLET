import React from 'react';

const CSS = `
.pl-btn{--pl-bg:var(--ink-1000);--pl-fg:var(--white);--pl-bd:transparent;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:var(--control-h);padding:0 20px;border-radius:var(--r-pill);border:1px solid var(--pl-bd);background:var(--pl-bg);color:var(--pl-fg);font-family:var(--font-sans);font-size:var(--fs-body-s);font-weight:var(--fw-semibold);letter-spacing:-0.005em;cursor:pointer;white-space:nowrap;transition:var(--t-control);text-decoration:none}
.pl-btn:hover{background:var(--pl-bg-h,var(--pl-bg));color:var(--pl-fg-h,var(--pl-fg));border-color:var(--pl-bd-h,var(--pl-bd))}
.pl-btn:active{transform:scale(var(--press-scale))}
.pl-btn:focus-visible{outline:none;box-shadow:var(--ring-focus)}
.pl-btn[disabled]{cursor:not-allowed;opacity:.38;transform:none}
.pl-btn--sm{height:var(--control-h-sm);padding:0 14px;font-size:var(--fs-caption)}
.pl-btn--lg{height:var(--control-h-lg);padding:0 26px;font-size:var(--fs-body)}
.pl-btn--block{width:100%}
.pl-btn--primary{--pl-bg:var(--ink-1000);--pl-fg:var(--white);--pl-bg-h:var(--ink-700)}
.pl-btn--secondary{--pl-bg:var(--white);--pl-fg:var(--ink-1000);--pl-bd:var(--border-subtle);--pl-bg-h:var(--ink-100);--pl-bd-h:var(--ink-300)}
.pl-btn--ghost{--pl-bg:transparent;--pl-fg:var(--ink-1000);--pl-bg-h:var(--ink-100)}
.pl-btn--accent{--pl-fg:var(--ink-1000);background:var(--grad-brand)}
.pl-btn--accent:hover{filter:saturate(1.08) brightness(.97)}
.pl-btn--inverse{--pl-bg:var(--white);--pl-fg:var(--ink-1000);--pl-bg-h:var(--ink-150)}
.pl-btn--inverse:focus-visible{box-shadow:var(--ring-focus-inverse)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function Button({ children, variant = 'primary', size = 'md', block = false, disabled = false, iconLeft, iconRight, href, onClick, type = 'button', style, className = '' }) {
  styles();
  const cls = ['pl-btn', 'pl-btn--' + variant, size !== 'md' && 'pl-btn--' + size, block && 'pl-btn--block', className].filter(Boolean).join(' ');
  const inner = (
    <>
      {iconLeft}
      {children}
      {iconRight}
    </>
  );
  if (href && !disabled) return <a className={cls} href={href} style={style} onClick={onClick}>{inner}</a>;
  return <button className={cls} type={type} disabled={disabled} onClick={onClick} style={style}>{inner}</button>;
}
