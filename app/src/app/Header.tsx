import { IconButton } from '../ds/components/core/IconButton.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { ProfileMenu } from './ProfileMenu.tsx';
import { GlobalSearch } from './GlobalSearch.tsx';
import { Notifications } from './Notifications.tsx';
import { ServiceMenu } from './ServiceMenu.tsx';
import type { DayView } from '../data/derive.ts';
import type { Registry } from '../data/registry.ts';
import type { Hit } from '../data/find.ts';
/* Простой знак: пчела контуром, заливка белая. Это присланный файл, а не
   производный — см. assets/logo/SOURCE.md, строка «lockup-h». */
import logo from '../ds/assets/logo/lockup-h.svg';
/* Тот же логотип для тёмного фона: чёрный на тёмном не виден вовсе. Контуры
   взяты из «lockup-h-detail» без единой правки, цвет — тот, что задумал
   автор в «lockup-h-gradient-word»: знак и слово «PROJECT» сплошные, «##
   POLET» фирменным градиентом. См. assets/logo/SOURCE.md. */
import logoOnDark from '../ds/assets/logo/lockup-h-on-dark.svg';

interface Props {
  collapsed: boolean;
  onToggleNav: () => void;
  /** Открытый день. Пусто — расчёт ещё грузится или не загрузился; шапка
      тогда стоит без колокольчика: предупреждать не о чем. */
  view: DayView | null;
  /** Открыть заявку из колокольчика — карточкой, отовсюду. */
  onPickOrder: (orderId: string) => void;
  /** Справочники — по ним ищет строка в шапке. Поиск живёт над расчётом:
      искать надо во всём, что есть, а не в том дне, который сейчас открыт. */
  registry: Registry | null;
  /** Куда ведёт находка. Решает оболочка: у разных родов записей это разные
      карточки, а у расчёта — переход в сам расчёт. */
  onFind: (hit: Hit) => void;
  /** Знак ведёт на дашборд. Привычка старше интерфейса: логотип в левом
      верхнем углу — это дорога домой, и ждать её там будут в любом случае. */
  onHome: () => void;
  /** Полный список настроек сервиса — из карточки под шестерёнкой. */
  onOpenSettings: () => void;
}

export function Header({
  collapsed,
  onToggleNav,
  view,
  onPickOrder,
  registry,
  onFind,
  onHome,
  onOpenSettings
}: Props) {
  return (
    <header className="hdr">
      <div className="hdr__left">
        {/* На узком окне меню свёрнуто принудительно, и кнопка здесь
            развернуть его не может — прятать её честнее, чем оставлять
            нажимающейся впустую. */}
        <IconButton
          className="hdr__navtoggle"
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
          title="На главную"
          aria-label="PROJECT POLET — на главную"
        >
          {/* Оба варианта в разметке, нужный показывает тема: знать её
              в разметке нечем — она может быть и системной. */}
          <img className="hdr__logo hdr__logo--light" src={logo} alt="" />
          <img className="hdr__logo hdr__logo--dark" src={logoOnDark} alt="" />
        </button>
      </div>

      <GlobalSearch registry={registry} onOpen={onFind} />

      <div className="hdr__right">
        {/* Шестерёнка в шапке — настройки сервиса, а не движка: движок
            настраивают вдумчиво и в своём разделе, а здесь то, как программа
            показывает посчитанное. */}
        <ServiceMenu onOpenAll={onOpenSettings} />
        {view && <Notifications view={view} onPick={onPickOrder} />}
        <ProfileMenu />
      </div>
    </header>
  );
}
