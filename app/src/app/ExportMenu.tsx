import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';

/* Выгрузка в файл: одна кнопка и выбор формата под ней.

   Форматов два, и выбор между ними — это выбор, что с файлом будут делать
   дальше. Книга Excel — чтобы считать своё: строки открываются, сортируются,
   складываются. PDF — чтобы показать: он не правится, одинаково выглядит у
   всех и годится в отчёт.

   Меню, а не две кнопки рядом: выгружают редко, а две кнопки в ряд заняли бы
   постоянное место и всё время предлагали выбрать формат, о котором в этот
   момент никто не думает. */

export type ExportKind = 'xlsx' | 'pdf';

const FORMATS: { key: ExportKind; label: string; note: string; icon: string }[] = [
  { key: 'xlsx', label: 'Книга Excel', note: 'строками — считать и сортировать', icon: 'list' },
  { key: 'pdf', label: 'PDF', note: 'страницей — показать и приложить', icon: 'clipboard-text' }
];

interface Props {
  onPick: (kind: ExportKind) => void;
  /** Нечего выгружать — кнопка гаснет, а не отвечает отказом по нажатию. */
  disabled?: boolean;
}

export function ExportMenu({ onPick, disabled = false }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  return (
    <div className="xport" ref={box}>
      <button
        type="button"
        className={'xport__btn' + (open ? ' xport__btn--on' : '')}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Выгрузить сравнение в файл"
      >
        <Icon name="arrow-up-right" size={14} />
        Экспорт
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
      </button>

      {open && (
        <div className="xport__card" role="menu" aria-label="Формат выгрузки">
          {FORMATS.map((item) => (
            <button
              key={item.key}
              type="button"
              className="xport__row"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(item.key);
              }}
            >
              <span className="xport__icon">
                <Icon name={item.icon} size={15} />
              </span>
              <span className="xport__text">
                <span className="xport__name">{item.label}</span>
                <span className="xport__note">{item.note}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
