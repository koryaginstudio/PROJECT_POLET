import { useEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { dayOf, daysAgo, localRun, whenLabel } from '../data/load.ts';
import { dec } from '../data/derive.ts';

/* Быстрые периоды в списке. «15 дней назад» — это не поиск по номеру, а
   поиск по времени, поэтому периоды стоят первыми, а строка поиска — рядом.

   Их три, и больше не нужно. Готовых кнопок было пять, и разница между
   «две недели» и «месяц» ничего не решала: к расчёту либо возвращаются
   сегодня, либо ищут его на этой неделе, либо помнят примерную дату — и
   тогда ни одна готовая кнопка не поможет, нужен отрезок. Промежуточные
   ступени только удлиняли строку.

   «За период» без обеих дат ничего не отсекает и показывает весь архив:
   отдельная кнопка «все» для этого не нужна, она была бы четвёртой
   ступенью той же шкалы. */
type Period = 'today' | 'week' | 'range';

const PERIODS: { value: Period; label: string; days: number | null }[] = [
  { value: 'today', label: 'Сегодня', days: 0 },
  { value: 'week', label: 'Неделя', days: 7 }
];

interface Props {
  runs: DaySummary[];
  /** Отмеченные расчёты: открытый в диспетчерской или весь отобранный набор. */
  marked: RunId[];
  onPick: (id: RunId) => void;
  onClose: () => void;
  /** Область, клик внутри которой не считается «мимо»: обычно это кнопка,
      которой список открыли, вместе с самим списком. Без неё щелчок по
      кнопке закрывал бы список и тут же открывал его заново. */
  boxRef: RefObject<HTMLElement | null>;
  /** Закрывать ли список после выбора. Там, где выбор один, — да: список
      сделал своё дело. Там, где набирают несколько, — нет, иначе его
      пришлось бы открывать заново после каждого расчёта. */
  closeOnPick?: boolean;
  /** Набор полон: неотмеченные гаснут. */
  full?: boolean;
  markLabel?: string;
  fullHint?: string;
  /** Прижать список к левому краю, а не к правому. */
  align?: 'left' | 'right';
}

/* Список всех расчётов движка с поиском и периодами.

   Живёт отдельно от ленты, потому что открывается из двух мест: кнопкой
   «Ещё» в ленте и пустым местом в «Сравнении». Это один и тот же список —
   «найди мне нужный расчёт», — и расходиться в двух местах он не должен. */
export function RunMenu({
  runs,
  marked,
  onPick,
  onClose,
  boxRef,
  closeOnPick = true,
  full = false,
  markLabel = 'Открыт',
  fullHint = 'Набор полон',
  align = 'right'
}: Props) {
  /* Открывается на «за период» без границ — то есть на всём архиве.
     Ставить по умолчанию неделю значило бы прятать часть записей от
     человека, который ещё не сказал, что ищет. */
  const [period, setPeriod] = useState<Period>('range');
  const [query, setQuery] = useState('');
  /* Произвольный отрезок. Пустая граница означает «без ограничения с этой
     стороны»: «с 1 марта и дальше» — такой же законный запрос, как отрезок
     между двумя датами, и требовать вторую дату незачем. */
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  /* Список закрывается щелчком мимо и по Esc: он перекрывает содержимое, и
     выхода из него должно быть два. */
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const box = boxRef.current;
      if (box && !box.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [boxRef, onClose]);

  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const limit = PERIODS.find((p) => p.value === period)?.days ?? null;
    return [...runs]
      .reverse()
      .filter((run) => {
        /* Отбирают по времени, когда расчёт завели: сюда приходят за своей
           работой — «что я считал вчера». День, который в расчёте разложен,
           у всех расчётов одной выгрузки один и тот же, и периоды по нему не
           делили бы ничего. */
        const made = dayOf(run.created);
        if (period === 'range') {
          /* Даты сравниваем строками: они в формате «год-месяц-день», и в
             нём лексикографический порядок совпадает с календарным. Разбор
             в Date ради этого только добавил бы часовые пояса. */
          if (from && made < from) return false;
          if (to && made > to) return false;
        } else if (limit !== null && daysAgo(run.created) > limit) {
          return false;
        }
        if (!needle) return true;
        /* Ищут и по тому, и по другому: номер наряда помнят днём выгрузки,
           а свой вчерашний расчёт — днём, когда его считали. */
        return (
          run.code.toLowerCase().includes(needle) ||
          made.includes(needle) ||
          run.date.includes(needle) ||
          whenLabel(run.created).includes(needle)
        );
      });
  }, [runs, period, query, from, to]);

  const isOn = (id: RunId) => marked.includes(id);

  return (
    <div
      className={'runmenu' + (align === 'left' ? ' runmenu--left' : '')}
      role="dialog"
      aria-label="Все расчёты"
    >
      <div className="runmenu__head">
        Все расчёты
        <span className="runmenu__count">
          {listed.length} из {runs.length}
        </span>
      </div>

      <div className="runmenu__filters">
        {/* Периоды делят ширину поровну, поиск идёт под ними своей строкой:
            в один ряд они влезают, но тогда в поиск помещается полтора
            слова. */}
        <div className="runmenu__periods">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              type="button"
              className={'chip' + (period === p.value ? ' chip--on' : '')}
              onClick={() => setPeriod(p.value)}
            >
              {p.label}
            </button>
          ))}
          {/* Произвольный отрезок — третьей кнопкой: он не выбирает период
              сам, а открывает поля, где его задают. */}
          <button
            type="button"
            className={'chip' + (period === 'range' ? ' chip--on' : '')}
            onClick={() => setPeriod('range')}
          >
            За период
          </button>
        </div>

        {period === 'range' && (
          <div className="runmenu__range">
            <label className="runmenu__date">
              <span>с</span>
              <input
                type="date"
                value={from}
                max={to || undefined}
                onChange={(e) => setFrom(e.currentTarget.value)}
              />
            </label>
            <label className="runmenu__date">
              <span>по</span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                onChange={(e) => setTo(e.currentTarget.value)}
              />
            </label>
            {from || to ? (
              <button
                type="button"
                className="createbar__reset"
                onClick={() => {
                  setFrom('');
                  setTo('');
                }}
              >
                Очистить
              </button>
            ) : (
              /* Без границ отрезок ничего не отсекает. Сказать это надо
                 прямо: иначе пустые поля читаются как «фильтр стоит, но
                 почему-то не работает». */
              <span className="runmenu__hint">пусто — показаны все</span>
            )}
          </div>
        )}
        <label className="dbsearch">
          <Icon name="search" size={14} />
          <input
            className="dbsearch__input"
            value={query}
            placeholder="Номер или дата"
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {query && (
            <button type="button" className="dbsearch__clear" onClick={() => setQuery('')}>
              <Icon name="x" size={12} />
            </button>
          )}
        </label>
      </div>

      <div className="runmenu__list">
        {listed.length === 0 && (
          <p className="runmenu__empty">
            В этот период расчётов нет. Снимите фильтр или поищите по номеру.
          </p>
        )}
        {listed.map((run) => (
          <button
            key={run.id}
            type="button"
            className={'runmenu__item' + (isOn(run.id) ? ' runmenu__item--on' : '')}
            disabled={full && !isOn(run.id)}
            title={full && !isOn(run.id) ? fullHint : undefined}
            onClick={() => {
              onPick(run.id);
              if (closeOnPick) onClose();
            }}
          >
            <span className="runmenu__code">{run.code}</span>
            {localRun(run.id) && (
              <span className="localmark" title="Расчёт посчитан в браузере, а не программой расчёта">
                браузер
              </span>
            )}
            <span className="runmenu__facts">
              <span className="runmenu__when">{whenLabel(run.created)}</span>
              покрытие {dec(run.coverage)} % · без инженера {run.unassigned}
            </span>
            {isOn(run.id) ? (
              <span className="runmenu__mark">{markLabel}</span>
            ) : (
              <Icon name="arrow-right" size={13} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
