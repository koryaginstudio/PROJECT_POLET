import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Switch } from '../ds/components/forms/Switch.jsx';
import { setService, useService } from '../data/service.ts';
import type { HoursFormat, StartAt, ThemeMode } from '../data/service.ts';

interface Props {
  /** Ведёт к полному списку настроек сервиса. */
  onOpenAll: () => void;
}

/* Настройки сервиса под шестерёнкой в шапке.

   Здесь только то, что переключают на ходу: с чего открывать программу, как
   показывать часы, свёрнуто ли меню. Всё, что настраивают вдумчиво — границы
   смены и пороги тревоги, — живёт на своём экране, и карточка честно ведёт
   туда ссылкой, а не пытается уместить это в выпадашку.

   Разделение с настройками движка проходит по тому, меняет настройка расчёт
   или нет. Движок отвечает «как раскладывать», и его переменные меняют план.
   Здесь план не меняется ни на визит — меняется то, что мы называем нормой и
   как показываем посчитанное. */

const START: { key: StartAt; label: string; note: string }[] = [
  { key: 'home', label: 'Главная', note: 'общая сводка дня' },
  { key: 'dispatch', label: 'Диспетчерская', note: 'сразу к выбору расчёта' },
  { key: 'last', label: 'Последний расчёт', note: 'открыть то, что считали последним' }
];

const HOURS: { key: HoursFormat; label: string }[] = [
  { key: 'decimal', label: '4,9 ч' },
  { key: 'words', label: '4 ч 54 мин' }
];

const THEMES: { key: ThemeMode; label: string; icon: string }[] = [
  { key: 'light', label: 'Светлая', icon: 'eye' },
  { key: 'dark', label: 'Тёмная', icon: 'layers' },
  { key: 'system', label: 'Как в системе', icon: 'gear' }
];

export function ServiceMenu({ onOpenAll }: Props) {
  const settings = useService();
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
    <div className="svc" ref={box}>
      <button
        type="button"
        className={'svc__btn' + (open ? ' svc__btn--on' : '')}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Настройки сервиса"
        title="Настройки сервиса"
      >
        <Icon name="gear" size={20} />
      </button>

      {open && (
        <div className="svc__card" role="dialog" aria-label="Настройки сервиса">
          <div className="svc__head">
            <span className="svc__title">Настройки сервиса</span>
            <span className="svc__note">Как показывать. Расчёт от этого не меняется</span>
          </div>

          <div className="svc__block">
            <span className="svc__label">С чего открывать</span>
            <div className="svc__rows">
              {START.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={'svc__row' + (settings.startAt === item.key ? ' svc__row--on' : '')}
                  onClick={() => setService({ startAt: item.key })}
                  aria-pressed={settings.startAt === item.key}
                >
                  <span className="svc__row-text">
                    <span className="svc__row-name">{item.label}</span>
                    <span className="svc__row-note">{item.note}</span>
                  </span>
                  {settings.startAt === item.key && <Icon name="check" size={13} />}
                </button>
              ))}
            </div>
          </div>

          <div className="svc__block">
            <span className="svc__label">Часы</span>
            <div className="svc__pills">
              {HOURS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={'svc__pill' + (settings.hours === item.key ? ' svc__pill--on' : '')}
                  onClick={() => setService({ hours: item.key })}
                  aria-pressed={settings.hours === item.key}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Тема пока только объявлена. Палитра в системе одна — светлая, и
              переключатель её не перекрасит; врать об этом кнопкой, которая
              делает вид, что работает, нельзя, поэтому под ней стоит прямая
              оговорка. Выбор при этом сохраняется: когда тёмная палитра
              появится, настройка уже будет там, где её ищут. */}
          <div className="svc__block">
            <span className="svc__label">Тема</span>
            <div className="svc__pills">
              {THEMES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className={'svc__pill' + (settings.theme === item.key ? ' svc__pill--on' : '')}
                  onClick={() => setService({ theme: item.key })}
                  aria-pressed={settings.theme === item.key}
                >
                  <Icon name={item.icon} size={12} />
                  {item.label}
                </button>
              ))}
            </div>
            <span className="svc__soon">
              <Icon name="info" size={12} />
              Тёмная палитра ещё не собрана — выбор запоминается, но интерфейс пока светлый
            </span>
          </div>

          <div className="svc__block svc__block--switch">
            <Switch
              size="sm"
              label="Меню свёрнуто при запуске"
              checked={settings.navCollapsed}
              onChange={() => setService({ navCollapsed: !settings.navCollapsed })}
            />
          </div>

          <button
            type="button"
            className="svc__all"
            onClick={() => {
              setOpen(false);
              onOpenAll();
            }}
          >
            <Icon name="sliders-horizontal" size={14} />
            Все настройки сервиса
            <Icon name="arrow-right" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
