import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';

interface Props {
  /** Границы отрезка в виде «год-месяц-день». Пустая строка — без границы. */
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  onClose: () => void;
}

const MONTHS = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь'
];

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/** «2026-09-15» → «15.09.2026». Пусто — прочерк. */
export const dayLabel = (iso: string) => {
  const [year, month, day] = iso.split('-');
  return day ? `${day}.${month}.${year}` : '—';
};

/** Короткая подпись отрезка для кнопки: без года, пока он один и тот же. */
export const rangeLabel = (from: string, to: string) => {
  if (!from && !to) return '';
  const short = (iso: string) => {
    const [, month, day] = iso.split('-');
    return day ? `${day}.${month}` : '';
  };
  if (from && to) return `${short(from)} — ${short(to)}`;
  return from ? `с ${short(from)}` : `по ${short(to)}`;
};

const iso = (year: number, month: number, day: number) =>
  `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

/* Отрезок дат — своим окошком, а не парой полей ввода.

   Поля `input type="date"` браузер рисует сам: своим шрифтом, своей рамкой и
   своим календарём, который ни размерами, ни цветами не похож ни на что
   остальное в программе. Два таких поля в ряд читались как чужая деталь,
   занесённая в интерфейс со стороны.

   Здесь календарь свой и говорит на языке сервиса. Отрезок набирают двумя
   щелчками: первый ставит начало, второй — конец; щелчок по уже набранному
   отрезку начинает его заново. Одна граница — тоже законный отбор: «с
   первого марта и дальше» спрашивают не реже, чем отрезок между датами. */
export function DateRange({ from, to, onChange, onClose }: Props) {
  const box = useRef<HTMLDivElement>(null);

  /* Какой месяц показан. Открываемся на месяце начала отрезка, а нет его —
     на нынешнем: искать сегодняшний день, листая календарь, незачем. */
  const [shown, setShown] = useState(() => {
    const base = from || to;
    const now = new Date();
    if (!base) return { year: now.getFullYear(), month: now.getMonth() };
    const [year, month] = base.split('-').map(Number);
    return { year, month: month - 1 };
  });

  /* Закрывается щелчком мимо и по Esc — как и всё, что открыто поверх. */
  useEffect(() => {
    const away = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) onClose();
    };
    const esc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);

  /* Клетки месяца: неделя начинается с понедельника, пустые места до первого
     числа и после последнего остаются пустыми. */
  const cells = useMemo(() => {
    const first = new Date(shown.year, shown.month, 1);
    /* В JS неделя начинается с воскресенья, у нас — с понедельника. */
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(shown.year, shown.month + 1, 0).getDate();
    const list: (number | null)[] = [];
    for (let at = 0; at < lead; at += 1) list.push(null);
    for (let day = 1; day <= days; day += 1) list.push(day);
    while (list.length % 7 !== 0) list.push(null);
    return list;
  }, [shown]);

  const today = useMemo(() => {
    const now = new Date();
    return iso(now.getFullYear(), now.getMonth(), now.getDate());
  }, []);

  const pick = (day: number) => {
    const value = iso(shown.year, shown.month, day);
    /* Первый щелчок ставит начало, второй — конец. Щелчок раньше начала
       переносит начало: человек передумал, а не ошибся. */
    if (!from || (from && to)) {
      onChange(value, '');
      return;
    }
    if (value < from) onChange(value, '');
    else onChange(from, value);
  };

  const step = (by: number) => {
    setShown((was) => {
      const at = new Date(was.year, was.month + by, 1);
      return { year: at.getFullYear(), month: at.getMonth() };
    });
  };

  return (
    <div className="dates" ref={box} role="dialog" aria-label="Период">
      <div className="dates__head">
        <button
          type="button"
          className="dates__step"
          onClick={() => step(-1)}
          aria-label="Прошлый месяц"
          title="Прошлый месяц"
        >
          <Icon name="chevron-left" size={14} />
        </button>
        <span className="dates__month">
          {MONTHS[shown.month]} {shown.year}
        </span>
        <button
          type="button"
          className="dates__step"
          onClick={() => step(1)}
          aria-label="Следующий месяц"
          title="Следующий месяц"
        >
          <Icon name="chevron-right" size={14} />
        </button>
      </div>

      <div className="dates__week" aria-hidden="true">
        {WEEKDAYS.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>

      <div className="dates__grid">
        {cells.map((day, at) => {
          if (day === null) return <span key={`gap-${at}`} className="dates__gap" />;
          const value = iso(shown.year, shown.month, day);
          const isFrom = value === from;
          const isTo = value === to;
          const inside = Boolean(from && to && value > from && value < to);
          return (
            <button
              key={value}
              type="button"
              className={
                'dates__day' +
                (isFrom || isTo ? ' dates__day--edge' : '') +
                (inside ? ' dates__day--in' : '') +
                (value === today ? ' dates__day--today' : '')
              }
              onClick={() => pick(day)}
              aria-pressed={isFrom || isTo || inside}
            >
              {day}
            </button>
          );
        })}
      </div>

      <div className="dates__foot">
        <span className="dates__picked">
          {from || to ? (
            <>
              {dayLabel(from)} — {dayLabel(to)}
            </>
          ) : (
            'Границы не заданы: показаны все'
          )}
        </span>
        {(from || to) && (
          <button type="button" className="dates__clear" onClick={() => onChange('', '')}>
            Очистить
          </button>
        )}
      </div>
    </div>
  );
}
