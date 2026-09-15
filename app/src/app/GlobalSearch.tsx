import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm, placeOf } from '../data/derive.ts';
import type { Selection } from './selection.ts';

interface Hit {
  kind: 'order' | 'engineer';
  id: string;
  title: string;
  meta: string;
}

interface Props {
  view: DayView;
  onSelect: (selection: Selection) => void;
}

/* Поиск по смене: номер заявки, адрес, вид работ, район, фамилия инженера.
   Найденное открывается в правой панели — там же, где всё остальное. */
export function GlobalSearch({ view, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  const hits = useMemo<Hit[]>(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const found: Hit[] = [];

    for (const load of view.loads) {
      const e = load.engineer;
      if (e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)) {
        found.push({
          kind: 'engineer',
          id: e.id,
          title: e.name,
          meta: `${e.id} · смена ${hhmm(e.shift_start)}–${hhmm(e.shift_end)} · ${load.visits} визитов`
        });
      }
    }

    for (const order of view.orderById.values()) {
      /* Адрес в стоге сена наравне с номером: «Тверская» ищут чаще, чем R0042. */
      const haystack =
        `${order.id} ${order.work_title} ${order.address ?? ''} ${order.district} ${order.skill}`.toLowerCase();
      if (haystack.includes(q)) {
        found.push({
          kind: 'order',
          id: order.id,
          title: `${order.work_title} · ${placeOf(order)}`,
          meta: `${order.id} · ${order.district} · окно ${hhmm(order.window_start)}–${hhmm(order.window_end)}`
        });
      }
      if (found.length > 40) break;
    }

    return found.slice(0, 8);
  }, [query, view]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const pick = (hit: Hit) => {
    onSelect(hit.kind === 'order' ? { kind: 'order', id: hit.id } : { kind: 'engineer', id: hit.id });
    setOpen(false);
    setQuery('');
  };

  return (
    <div className="search" ref={wrap}>
      <span className="search__icon">
        <Icon name="search" size={16} />
      </span>
      <input
        className="search__input"
        type="search"
        value={query}
        placeholder="Заявка, адрес, вид работ или фамилия инженера"
        aria-label="Поиск по смене"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && hits[0]) pick(hits[0]);
        }}
      />

      {open && query.trim().length >= 2 && (
        <div className="search__drop" role="listbox">
          {hits.length === 0 ? (
            <p className="search__empty">Ничего не нашлось. Попробуйте номер заявки, адрес или фамилию.</p>
          ) : (
            hits.map((hit) => (
              <button
                key={hit.kind + hit.id}
                type="button"
                role="option"
                aria-selected="false"
                className="search__hit"
                onClick={() => pick(hit)}
              >
                <Icon name={hit.kind === 'order' ? 'clipboard-list' : 'user'} size={16} />
                <span className="search__hit-body">
                  <span className="search__hit-title">{hit.title}</span>
                  <span className="search__hit-meta">{hit.meta}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
