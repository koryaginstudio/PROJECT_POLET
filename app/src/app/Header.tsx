import { IconButton } from '../ds/components/core/IconButton.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { ProfileMenu } from './ProfileMenu.tsx';
import { GlobalSearch } from './GlobalSearch.tsx';
import { Notifications } from './Notifications.tsx';
import { ServiceMenu } from './ServiceMenu.tsx';
import type { DayView } from '../data/derive.ts';
import type { Selection } from './selection.ts';
/* Простой знак: пчела контуром, заливка белая. Это присланный файл, а не
   производный — см. assets/logo/SOURCE.md, строка «lockup-h». */
import logo from '../ds/assets/logo/lockup-h.svg';

interface Props {
  collapsed: boolean;
  onToggleNav: () => void;
  view: DayView;
  onSelect: (selection: Selection) => void;
  /** Знак ведёт на дашборд. Привычка старше интерфейса: логотип в левом
      верхнем углу — это дорога домой, и ждать её там будут в любом случае. */
  onHome: () => void;
  /** Полный список настроек сервиса — из карточки под шестерёнкой. */
  onOpenSettings: () => void;
}

export function Header({ collapsed, onToggleNav, view, onSelect, onHome, onOpenSettings }: Props) {
  return (
    <header className="hdr">
      <div className="hdr__left">
        <IconButton
          label={collapsed ? 'Развернуть меню' : 'Свернуть меню до иконок'}
          variant="ghost"
          square
          onClick={onToggleNav}
        >
          <Icon name="list" size={20} />
        </IconButton>
        <button
          type="button"
          className="hdr__home"
          onClick={onHome}
          title="На дашборд"
          aria-label="PROJECT POLET — на дашборд"
        >
          <img className="hdr__logo" src={logo} alt="" />
        </button>
      </div>

      <GlobalSearch view={view} onSelect={onSelect} />

      <div className="hdr__right">
        {/* Шестерёнка в шапке — настройки сервиса, а не движка: движок
            настраивают вдумчиво и в своём разделе, а здесь то, как программа
            показывает посчитанное. */}
        <ServiceMenu onOpenAll={onOpenSettings} />
        <Notifications view={view} onSelect={onSelect} />
        <ProfileMenu />
      </div>
    </header>
  );
}
