import { useEffect, useRef } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { useModalFocus } from './modal.ts';

interface Props {
  open: boolean;
  /** Закрыть и остаться в разделе: крестик, кнопка «Понятно, продолжить», вуаль, Esc. */
  onClose: () => void;
  /** Уйти из раздела туда, откуда пришли. */
  onBack: () => void;
}

/* «Мониторинг» читается как живая связь с людьми: часы, «В пути»,
   «Опаздывает на 9 мин». Связи нет — buildLiveRoster собирает положение
   инженеров из плана и текущей минуты. Строку наверху проглядывают, поэтому
   окно поверх затемнённого экрана, которое закрывают рукой. */
export function DemoDialog({ open, onClose, onBack }: Props) {
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
    <div className="modal" role="dialog" aria-modal="true" aria-label="Тестовый режим мониторинга">
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card demo__card" ref={card}>
        <div className="modal__head">
          <h3 className="engine__title">
            <Icon name="info" size={18} />
            Тестовый режим мониторинга
          </h3>
          {/* Крестик и «Понятно, продолжить» — одно и то же: закрыть и
              остаться. «Назад» рядом с ними уводит из раздела. */}
          <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="engine__lede">
          Живой связи с инженерами здесь нет: где человек сейчас, раздел берёт из плана расчёта
          и часов. В рабочей версии будет их настоящее положение в реальном времени.
        </p>

        <div className="demo__foot">
          <Button variant="secondary" size="sm" onClick={onBack}>
            Назад
          </Button>
          <Button variant="accent" size="sm" onClick={onClose}>
            Понятно, продолжить
          </Button>
        </div>
      </div>
    </div>
  );
}

/* Глубина истории на момент загрузки страницы. По ней «Назад» понимает, есть
   ли куда возвращаться внутри программы: первый заход подменяет запись в
   истории, а не добавляет новую (см. App), поэтому со свежей загрузки прямо
   на «Мониторинге» history.back() вывел бы из программы вовсе. */
const DEPTH_AT_LOAD = window.history.length;

/** Есть ли внутри программы куда возвращаться. */
export const canGoBack = () => window.history.length > DEPTH_AT_LOAD;

/* Показали ли окно в этой загрузке страницы. Не память браузера: раздел,
   который однажды перестанет предупреждать, обманет следующего зрителя. */
let shown = false;

/** Нужно ли показать окно при входе в «Мониторинг». */
export const demoPending = () => !shown;

/** Отметить, что окно показали и закрыли. */
export const markDemoShown = () => {
  shown = true;
};
