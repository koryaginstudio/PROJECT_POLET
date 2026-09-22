import { useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';

/* Полоса управления выборкой — одна на все шесть баз.

   Устроена по правилу «сначала результат, потом отбор». Наверху то, что
   действует прямо сейчас: поле поиска, чипы активных отборов со снятием и
   порядок. Под ними — итог выборки: сколько записей подошло и что они в
   сумме дают. Всё остальное — плашки отбора, перечни видов работ и навыков,
   плотность ряда, расчёты — лежит под кнопкой «Отбор» и раскрывается по
   нажатию.

   Раньше всё это стояло раскрытым всегда. На ноутбуке в 768 пикселей ростом
   до первой записи уходило 667 пикселей управления, а итог выборки был
   напечатан под списком — за тридцатью экранами прокрутки, где его никто
   не видел. Диспетчер приходит в базу за записями, и первое, что он должен
   увидеть, — записи и число их. */

export interface DbChip {
  key: string;
  /** Что стоит: «Нужен доступ», «Вид работ: Авария». Подпись перед
      двоеточием набирается тише — это имя отбора, а не его значение. */
  label: ReactNode;
  title?: string;
  onRemove: () => void;
}

interface Props {
  query: string;
  onQuery: (value: string) => void;
  placeholder: string;
  /** Что распознали в набранном — подсказка рядом с полем. */
  hit?: ReactNode;
  /** Активные отборы. Пусто — полоса состоит из кнопки и порядка. */
  chips: DbChip[];
  /** Снять все отборы разом. Показывается, когда снимать есть что. */
  onReset?: () => void;
  /** Порядок списка — справа на полосе. */
  sort?: ReactNode;
  /** Итог выборки строкой. */
  summary?: ReactNode;
  /** Всё, что под кнопкой «Отбор». */
  children?: ReactNode;
}

export function DbBar({
  query,
  onQuery,
  placeholder,
  hit,
  chips,
  onReset,
  sort,
  summary,
  children
}: Props) {
  /* Раскрыт ли отбор. Закрыт по умолчанию и не запоминается: чипы наверху
     и так говорят, что стоит, а раскрывают перечень тогда, когда хотят
     что-то поставить. */
  const [open, setOpen] = useState(false);

  return (
    <div className="dbbar">
      <div className="dbbar__search">
        <label className="dbsearch">
          <Icon name="search" size={14} />
          <input
            className="dbsearch__input"
            value={query}
            placeholder={placeholder}
            onChange={(event) => onQuery(event.currentTarget.value)}
          />
          {query && (
            <button
              type="button"
              className="dbsearch__clear"
              onClick={() => onQuery('')}
              aria-label="Очистить поиск"
              title="Очистить поиск"
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </label>
        {hit}
      </div>

      <div className="dbbar__row">
        {children && (
          <button
            type="button"
            className={
              'fdrop__btn' +
              (open ? ' fdrop__btn--on' : '') +
              (chips.length > 0 ? ' fdrop__btn--picked' : '')
            }
            onClick={() => setOpen((was) => !was)}
            aria-expanded={open}
            title={open ? 'Свернуть отбор' : 'Раскрыть отбор: чем сузить список и как его показать'}
          >
            <Icon name="sliders-horizontal" size={12} />
            Отбор
            {chips.length > 0 && <span className="fdrop__count">{chips.length}</span>}
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
          </button>
        )}

        <span className="dbbar__chips">
          {chips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className="chip chip--on dbbar__chip"
              onClick={chip.onRemove}
              title={chip.title ?? 'Снять этот отбор'}
            >
              {chip.label}
              <Icon name="x" size={12} />
            </button>
          ))}
          {chips.length > 1 && onReset && (
            <button type="button" className="filters__reset" onClick={onReset} title="Снять все отборы">
              <Icon name="x" size={12} />
              Снять всё
            </button>
          )}
        </span>

        {sort && (
          <span className="dbbar__sort" role="group" aria-label="Сортировка">
            <span className="filters__label">Сортировка</span>
            {sort}
          </span>
        )}
      </div>

      {summary && <p className="dbbar__summary">{summary}</p>}

      {open && children && <div className="dbbar__fold">{children}</div>}
    </div>
  );
}

/** Подпись перед значением чипа: «Вид работ: Авария». */
export function ChipKey({ children }: { children: ReactNode }) {
  return <span className="dbbar__chip-key">{children}: </span>;
}

/* ─── пустая выборка ──────────────────────────────────────────────────────

   Совет «снимите отбор или очистите поиск» годится только тому, кто их
   ставил. Тому, кто открыл базу и увидел пустоту, он ничего не объясняет:
   снимать нечего, а причина в другом — в базе пока нет записей. */

interface EmptyProps {
  /** «Под этот отбор не подошёл ни один адрес.» — с родом и числом записи. */
  miss: string;
  /** Что сказать, когда ничего не ставили: откуда в базе берутся записи. */
  blank: string;
  query: boolean;
  filtered: boolean;
  onReset?: () => void;
}

export function DbEmpty({ miss, blank, query, filtered, onReset }: EmptyProps) {
  const hint =
    query && filtered
      ? 'Снимите отбор или очистите поиск.'
      : query
        ? 'Очистите поиск или наберите иначе.'
        : filtered
          ? 'Снимите отбор.'
          : null;

  return (
    <section className="panel">
      <div className="dbempty">
        <p className="clients__lede">{hint ? `${miss} ${hint}` : blank}</p>
        {hint && onReset && (
          <button type="button" className="fdrop__btn" onClick={onReset}>
            <Icon name="x" size={12} />
            {query && filtered ? 'Снять отбор и очистить поиск' : query ? 'Очистить поиск' : 'Снять отбор'}
          </button>
        )}
      </div>
    </section>
  );
}

/* ─── постраничность ──────────────────────────────────────────────────────

   Разметка отдаётся порциями: две сотни карточек по полэкрана ростом
   браузер рисует целиком и потом на них же спотыкается при прокрутке.
   Итоги при этом считаются по всей выборке — режется только отрисовка. */

export function usePaging(page: number) {
  const [limit, setLimit] = useState(page);
  return {
    limit,
    more: () => setLimit((n) => n + page),
    /* Сменили отбор или порядок — счётчик показанного начинается заново:
       иначе после сужения выборки кнопка обещала бы строки, которых уже
       нет, а после переворота порядка длинный список пришлось бы
       перечитывать с конца. */
    reset: () => setLimit(page)
  };
}

export function DbMore({ hidden, page, onMore }: { hidden: number; page: number; onMore: () => void }) {
  if (hidden <= 0) return null;
  return (
    <button type="button" className="tblmore" onClick={onMore}>
      Показать ещё {Math.min(page, hidden)}
      <span className="tblmore__rest">осталось {hidden}</span>
    </button>
  );
}
