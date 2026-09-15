import { Icon } from '../ds/components/core/Icon.jsx';
import { NAV, NAV_FOOTER } from './nav.ts';
import type { SectionId } from './nav.ts';

interface Props {
  active: SectionId;
  collapsed: boolean;
  onSelect: (id: SectionId) => void;
  counts: Record<string, number>;
  alertKeys?: string[];
  /** Заводит новый расчёт: ведёт к той же форме, что и «Создать расчёт» в
      диспетчерской. Кнопка достаётся из любого раздела — это единственное
      действие в меню, всё остальное в нём переходы. */
  onCreateRun: () => void;
}

export function Sidebar({ active, collapsed, onSelect, counts, alertKeys = [], onCreateRun }: Props) {
  return (
    <nav className={'nav' + (collapsed ? ' nav--collapsed' : '')} aria-label="Разделы системы">
      {/* Свиток — только список разделов. Прокручиваться должно то, чего
          много, а не всё подряд: две кнопки внизу нужны из любого места, и
          уезжать наверх вместе со списком им незачем. */}
      <div className="nav__list">
      {NAV.map((group) => (
        <div key={group.title}>
          {/* Группа без названия идёт без заголовка: пустая строчка сверху
              читалась как сбой, а не как «здесь нечего подписывать». */}
          {group.title !== '' && (
            <div className="nav__group">{collapsed ? <span className="nav__rule" /> : group.title}</div>
          )}
          {group.items.map((item) => {
            const isActive = item.id === active;
            const count = item.count ? counts[item.count] : undefined;
            const alert = item.count ? alertKeys.includes(item.count) : false;
            return (
              <button
                key={item.id}
                type="button"
                className={
                  'nav__item' +
                  (isActive ? ' nav__item--active' : '') +
                  (item.divider ? ' nav__item--parted' : '')
                }
                aria-current={isActive ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
                title={collapsed ? item.label : undefined}
              >
                <Icon name={item.icon} size={18} />
                <span className="nav__label">{item.label}</span>
                {count !== undefined && !(item.hideZero && count === 0) && (
                  <span className={'nav__count' + (alert ? ' nav__count--alert' : '')}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
      ))}
      </div>

      {/* Настройки и «Создать расчёт» прижаты к низу колонки и не уезжают со
          списком. Настройки — редкое и осознанное действие, но искать их
          прокруткой всё равно не должно приходиться; новый расчёт заводят из
          любого раздела, и это единственное действие в меню. */}
      <div className="nav__foot">
        <button
          type="button"
          className={
            'nav__item' + (NAV_FOOTER.id === active ? ' nav__item--active' : '')
          }
          aria-current={NAV_FOOTER.id === active ? 'page' : undefined}
          onClick={() => onSelect(NAV_FOOTER.id)}
          title={collapsed ? NAV_FOOTER.label : undefined}
        >
          <Icon name={NAV_FOOTER.icon} size={18} />
          <span className="nav__label">{NAV_FOOTER.label}</span>
        </button>

        {/* Действие стоит под разделами: список читается сверху вниз, а кнопка
            не спорит с ним за первое место, но достаётся из любого раздела. */}
        <button
          type="button"
          className="nav__rebuild"
          onClick={onCreateRun}
          title={collapsed ? 'Создать расчёт' : undefined}
        >
          <Icon name="plus" size={16} />
          {!collapsed && <span>Создать расчёт</span>}
        </button>
      </div>
    </nav>
  );
}
