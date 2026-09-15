import { useEffect } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Checkbox } from '../ds/components/forms/Checkbox.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { hhmm } from '../data/derive.ts';

interface Props {
  /** Момент, с которого движок будет пересобирать остаток дня. */
  cut: number;
  open: boolean;
  onClose: () => void;
}

/* Пульт пересчёта живёт окном поверх всего экрана, а не подсказкой у кнопки:
   запускать его можно и из «Расчёта», и из левого меню, из любого раздела.
   Сервер пересчитывает день именно от момента — GET /api/replan?day=…&at=…,
   см. SERVER.md. Параметры выложены, запуск выключен до появления ответа. */
export function EngineDialog({ cut, open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Новый расчёт">
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card engine__card">
        <div className="modal__head">
          <h3 className="engine__title">Новый расчёт: инженер — заявка</h3>
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
          Запустить расчёт
        </Button>

        <p className="engine__note">
          Подключается к <code>GET /api/replan</code> из SERVER.md — сервер отдаёт тот же{' '}
          <code>plan</code> на остаток дня плюс блок <code>meta.replan</code>. Пока не подключено.
        </p>
      </div>
    </div>
  );
}
