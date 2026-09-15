import React from 'react';

const CSS = `
.pl-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:var(--control-h);height:var(--control-h);border-radius:var(--r-pill);border:1px solid transparent;background:transparent;color:var(--icon-primary);cursor:pointer;transition:var(--t-control)}
.pl-iconbtn:hover{background:var(--ink-100)}
.pl-iconbtn:active{transform:scale(var(--press-scale))}
.pl-iconbtn:focus-visible{outline:none;box-shadow:var(--ring-focus)}
.pl-iconbtn[disabled]{opacity:.38;cursor:not-allowed}
.pl-iconbtn--sm{width:var(--control-h-sm);height:var(--control-h-sm)}
.pl-iconbtn--lg{width:var(--control-h-lg);height:var(--control-h-lg)}
.pl-iconbtn--secondary{background:var(--white);border-color:var(--border-subtle)}
.pl-iconbtn--secondary:hover{background:var(--ink-100);border-color:var(--ink-300)}
.pl-iconbtn--primary{background:var(--ink-1000);color:var(--white)}
.pl-iconbtn--primary:hover{background:var(--ink-700)}
.pl-iconbtn--inverse{color:var(--white)}
.pl-iconbtn--inverse:hover{background:rgba(255,255,255,.12)}
.pl-iconbtn--square{border-radius:var(--r-sm)}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function IconButton({ children, label, variant = 'ghost', size = 'md', square = false, disabled = false, onClick, style, className = '' }) {
  styles();
  const cls = ['pl-iconbtn', 'pl-iconbtn--' + variant, size !== 'md' && 'pl-iconbtn--' + size, square && 'pl-iconbtn--square', className].filter(Boolean).join(' ');
  return (
    <button className={cls} aria-label={label} title={label} disabled={disabled} onClick={onClick} style={style}>
      {children}
    </button>
  );
}
