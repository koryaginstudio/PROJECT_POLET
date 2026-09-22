import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { dec, deadline, placeOf } from '../data/derive.ts';
import type { Selection } from './selection.ts';

interface Props {
  view: DayView;
  onSelect: (selection: Selection) => void;
}

/* Что требует диспетчера прямо сейчас: заявки без инженера с сегодняшним сроком
   и визиты, которые чаще всего срывались в итерациях. */
export function Notifications({ view, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const urgent = view.unassigned.filter((o) => o.sla_deadline <= view.hardEnd);
  const fragile = view.fragile.slice(0, 5);
  const total = urgent.length + fragile.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const pick = (id: string) => {
    onSelect({ kind: 'order', id });
    setOpen(false);
  };

  return (
    <div className="notify" ref={wrap}>
      <button
        type="button"
        className={'notify__button' + (open ? ' notify__button--open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Требуют внимания: ${total}`}
        title={`Требуют внимания: ${total}`}
      >
        <Icon name="bell" size={20} />
        {total > 0 && <span className="notify__badge">{total}</span>}
      </button>

      {open && (
        <div className="notify__card" role="dialog" aria-label="Требуют внимания">
          <h3 className="notify__title">Требуют внимания</h3>

          <div className="notify__group">
            <span className="notify__group-title">Срок истекает сегодня, инженера нет — {urgent.length}</span>
            {urgent.length === 0 ? (
              <p className="notify__empty">Все срочные заявки разобраны.</p>
            ) : (
              urgent.slice(0, 5).map((o) => (
                <button type="button" key={o.id} className="notify__row" onClick={() => pick(o.id)}>
                  <span className="notify__row-title">
                    {o.work_title} · {placeOf(o)}
                  </span>
                  <span className="notify__row-meta">
                    {o.id} · до {deadline(o.sla_deadline)}
                  </span>
                </button>
              ))
            )}
          </div>

          <div className="notify__group">
            <span className="notify__group-title">Держатся на честном слове — {fragile.length}</span>
            {/* Пустая группа говорит словами, а не пустотой: иначе заголовок
                без строк читается как «список не загрузился». */}
            {fragile.length === 0 ? (
              <p className="notify__empty">По прогнозу дня ни одна заявка не срывается.</p>
            ) : (
              fragile.map(({ order, failureRate }) => (
                <button type="button" key={order.id} className="notify__row" onClick={() => pick(order.id)}>
                  <span className="notify__row-title">
                    {order.id} · {order.work_title} · {placeOf(order)}
                  </span>
                  <span className="notify__row-meta">
                    {order.id} · срывается в {dec(failureRate)}% вариантов прогноза дня
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
