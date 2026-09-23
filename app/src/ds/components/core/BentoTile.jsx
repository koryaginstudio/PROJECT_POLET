import React from 'react';

const CSS = `
.pl-tile{position:relative;display:flex;flex-direction:column;gap:12px;background:var(--surface-tile);border-radius:var(--r-tile);padding:var(--tile-pad);color:var(--text-primary);overflow:hidden;transition:var(--t-surface);text-decoration:none;min-width:0}
.pl-tile--white{background:var(--white);box-shadow:var(--shadow-inset-hairline)}
.pl-tile--inverse{background:var(--surface-inverse);color:var(--text-inverse)}
.pl-tile--gradient{background:var(--grad-brand-diag);color:var(--text-on-brand)}
.pl-tile--interactive{cursor:pointer}
.pl-tile--interactive:hover{background:var(--surface-tile-hover)}
.pl-tile--inverse.pl-tile--interactive:hover{background:var(--ink-800)}
.pl-tile--gradient.pl-tile--interactive:hover{filter:saturate(1.08) brightness(.98)}
.pl-tile--white.pl-tile--interactive:hover{box-shadow:var(--shadow-inset-hairline),var(--shadow-md)}
.pl-tile--interactive:active{transform:scale(0.995)}
.pl-tile__eyebrow{font-size:var(--fs-overline);letter-spacing:var(--ls-overline);text-transform:uppercase;font-weight:var(--fw-bold);color:var(--text-secondary)}
.pl-tile--inverse .pl-tile__eyebrow{color:var(--ink-400)}
.pl-tile--gradient .pl-tile__eyebrow{color:var(--accent-700)}
.pl-tile__title{font-family:var(--font-display);font-weight:var(--fw-extrabold);font-size:var(--fs-h3);line-height:var(--lh-h3);letter-spacing:var(--ls-h3);text-wrap:balance}
.pl-tile__body{font-size:var(--fs-body-s);line-height:var(--lh-body-s);color:var(--text-secondary)}
.pl-tile--inverse .pl-tile__body{color:var(--ink-300)}
.pl-tile__foot{margin-top:auto;padding-top:8px}
`;
let injected = false;
function styles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

export function BentoTile({ children, tone = 'tile', eyebrow, title, body, footer, colSpan, rowSpan, interactive = false, href, onClick, style, className = '' }) {
  styles();
  const cls = ['pl-tile', tone !== 'tile' && 'pl-tile--' + tone, (interactive || href || onClick) && 'pl-tile--interactive', className].filter(Boolean).join(' ');
  const st = { ...(colSpan ? { gridColumn: 'span ' + colSpan } : null), ...(rowSpan ? { gridRow: 'span ' + rowSpan } : null), ...style };
  const inner = (
    <>
      {eyebrow && <div className="pl-tile__eyebrow">{eyebrow}</div>}
      {title && <div className="pl-tile__title">{title}</div>}
      {body && <div className="pl-tile__body">{body}</div>}
      {children}
      {footer && <div className="pl-tile__foot">{footer}</div>}
    </>
  );
  if (href) return <a className={cls} href={href} style={st}>{inner}</a>;
  return <div className={cls} onClick={onClick} style={st}>{inner}</div>;
}
