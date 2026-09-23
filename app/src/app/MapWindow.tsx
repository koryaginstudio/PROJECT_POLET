import { useEffect, useRef } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import { SelectedCard } from './DetailPanel.tsx';
import type { Selection } from './selection.ts';
import { useModalFocus } from './modal.ts';

interface Props {
  day: Day;
  view: DayView;
  /** Что раскрыто окном: число расчёта, заявка, инженер или готовый список.
      Пусто — окна нет. */
  open: Selection | null;
  onClose: () => void;
  /** Переход вглубь: из числа в заявку, из заявки в инженера. Остаётся в
      окне — карта под ним не меняется и никуда не уезжает. */
  onSelect: (selection: Selection) => void;
  /** Уйти в сводку целиком. Единственная дорога отсюда наружу, и она
      названа словом. */
  onOpenSummary: () => void;
}

/* Окно поверх карты.

   В обзоре карта — это весь экран, и разбирать на ней приходится всё: число
   расчёта, выбранную заявку, инженера. Прежде каждый такой вопрос уводил в
   соседнюю вкладку: карта пропадала, место, на которое смотрели, терялось, и
   возвращаться приходилось руками.

   Окно отвечает на месте. Внутри — та же карточка, что и в сводке: её
   собирает `SelectedCard`, и второй, отдельной для карты, здесь нет. Одно и
   то же обязано объясняться одинаково, где бы его ни раскрыли.

   Переходы вглубь остаются в окне: из разбора числа — в заявку, из заявки —
   в её инженера. Наружу ведёт одна названная дорога: «Разобрать расчёт в
   сводке». */
export function MapWindow({ day, view, open, onClose, onSelect, onOpenSummary }: Props) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(open !== null, card);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Разбор">
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card mapwin" ref={card}>
        <SelectedCard day={day} view={view} selection={open} onSelect={onSelect} />

        <button type="button" className="mapwin__go" onClick={onOpenSummary}>
          <Icon name="arrow-right" size={14} />
          Разобрать расчёт в сводке
        </button>
      </div>
    </div>
  );
}
