import { useEffect, useRef } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Checkbox } from '../ds/components/forms/Checkbox.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { hhmm } from '../data/derive.ts';
import { useModalFocus } from './modal.ts';

interface Props {
  /** Момент, с которого движок будет пересобирать остаток дня. */
  cut: number;
  open: boolean;
  onClose: () => void;
}

/* Пересчёт остатка дня от момента — окном поверх экрана, а не подсказкой у
   кнопки: запускать его можно из любого раздела.

   Делает это движок, и пока он не подключён к пересчёту от момента, окно
   только показывает, что здесь будет: переключатели погашены, запуск
   выключен. Само оно больше не всплывает после каждого расчёта — раньше
   всплывало и читалось как «что-то недоделано», хотя расчёт уже готов. */
export function EngineDialog({ cut, open, onClose }: Props) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(open, card);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Пересчёт остатка дня">
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card engine__card" ref={card}>
        <div className="modal__head">
          <h3 className="engine__title">Пересчёт остатка дня</h3>
          <span className="modal__esc">
            <kbd>Esc</kbd> — закрыть
          </span>
          <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="engine__lede">
          Движок заново разложит нераспределённые заявки по инженерам и переставит остаток дня от
          выбранного момента. Уже закрытые визиты не трогаются.
        </p>

        <div className="engine__from">
          <Icon name="clock" size={16} />
          <span>
            Считать от <strong>{hhmm(cut)}</strong> до конца смены
          </span>
        </div>

        <div className="engine__options">
          <Checkbox label="Закрепить начатые визиты" defaultChecked disabled />
          <Checkbox label="Аварии в первую очередь" defaultChecked disabled />
          <Checkbox label="Разрешить перенос на завтра" disabled />
        </div>

        <Button variant="primary" size="sm" block disabled iconLeft={<Icon name="lightning" size={14} />}>
          Запустить пересчёт
        </Button>

        <p className="engine__note">
          Пересчёт от момента делает движок, и к этому окну он пока не подключён. Как только
          подключат, переключатели заработают, а кнопка запустит счёт.
        </p>
      </div>
    </div>
  );
}
