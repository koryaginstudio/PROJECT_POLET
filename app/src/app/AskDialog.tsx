import { useEffect, useRef } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { useModalFocus } from './modal.ts';

/* Вопрос перед необратимым — окном сервиса, а не окном браузера.

   Спрашивать приходится в четырёх местах: уход с открытого мониторинга,
   уход от несохранённого пересчёта, переход в прошедший мониторинг и
   отказ вести мониторинг, расчёты которого стёрты. Прежде все четыре
   звали `window.confirm`, и на экране, собранном по своей сетке и в своих
   цветах, вырастало серое окно операционной системы с чужими кнопками:
   в нём нельзя ни назвать действие своим словом, ни отличить «Уйти» от
   «Остаться» ничем, кроме порядка.

   Здесь то же самое, но карточкой сервиса: заголовок, объяснение и две
   кнопки, у которых написано, что они делают. Esc и щелчок по вуали
   отвечают «нет» — самый безопасный ответ, и он же ответ по умолчанию для
   того, кто закрыл окно не читая.

   Отказ ничего не делает: место, откуда вопрос задан, остаётся как было. */

export interface Ask {
  /** О чём вопрос — одной строкой. */
  title: string;
  /** Что случится, если согласиться. */
  body: string;
  /** Слово на кнопке согласия: «Уйти», «Открыть», «Потерять пересчёт». */
  okLabel: string;
  /** Слово на кнопке отказа. По умолчанию — «Остаться». */
  noLabel?: string;
  /** Согласие необратимо: знак у заголовка становится тревожным. Кнопке
      цвета не меняем — в дизайн-системе тревожного варианта нет, а красить
      её мимо системы значило бы завести свой собственный. */
  danger?: boolean;
  /** Что сделать при согласии. Пусто — вопрос без выбора: одна кнопка,
      которой окно просто закрывают (так говорит о себе отказ движка). */
  onOk?: () => void;
}

export function AskDialog({ ask, onClose }: { ask: Ask | null; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(Boolean(ask), card);

  useEffect(() => {
    if (!ask) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ask, onClose]);

  if (!ask) return null;

  const agree = () => {
    /* Сначала закрываем, потом делаем: согласие уводит с экрана, и окно,
       закрытое после перехода, успевало моргнуть поверх нового. */
    onClose();
    ask.onOk?.();
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={ask.title}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card askbox" ref={card}>
        <div className="askbox__head">
          <span className={'askbox__sign' + (ask.danger ? ' askbox__sign--danger' : '')}>
            <Icon name={ask.danger ? 'alert-triangle' : 'info'} size={18} />
          </span>
          <h2 className="askbox__title">{ask.title}</h2>
        </div>

        <p className="askbox__body">{ask.body}</p>

        <div className="askbox__btns">
          {ask.onOk ? (
            <>
              <Button variant="primary" size="sm" onClick={agree}>
                {ask.okLabel}
              </Button>
              <Button variant="secondary" size="sm" onClick={onClose}>
                {ask.noLabel ?? 'Остаться'}
              </Button>
            </>
          ) : (
            <Button variant="primary" size="sm" onClick={onClose}>
              {ask.okLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
