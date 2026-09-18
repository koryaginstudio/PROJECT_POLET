import type { ReactNode } from 'react';

/* Строка списка — третий вид, общий для всех баз.

   Карточки и таблица отвечают на разные вопросы и оба отвечают плохо на
   третий. Карточка показывает одну запись целиком и тратит на это четверть
   строки: десяток записей — это уже прокрутка. Таблица кладёт всё, что о
   записи известно, в полтора десятка колонок и уезжает вбок; чтобы прочесть
   одну строку до конца, её приходится возить горизонтально.

   Список стоит между ними. Одна запись — одна строка во всю ширину: слева
   лицо или знак, по которому запись узнают, посередине название и то, чем
   она подписана, справа четыре-пять чисел, ради которых в базу и заходят.
   Ничего не уезжает вбок, и полсотни записей читаются одним движением
   колеса — то, чего не умеет ни карточка, ни таблица. */

export interface DbListCell {
  /** Подпись под числом. Она же ключ: в одной строке дважды не встречается. */
  label: string;
  value: ReactNode;
  /** Ширина под содержимое, а не под число: имя инженера, «10:00–13:00». */
  wide?: boolean;
  /** Числу тут же дают цену: тревожное красным, пустое серым. */
  tone?: 'warn' | 'muted';
}

export interface DbListRow {
  key: string;
  /** Знак записи слева: фотография, иконка вида работ, кружок с номером.
      Им запись узнают до того, как прочтут название, — ради этого список и
      отличается от таблицы. */
  lead?: ReactNode;
  /** Номер записи: он стоит перед названием и набран моноширинно, потому что
      им запись называют вслух и по нему её ищут. */
  code?: ReactNode;
  title: ReactNode;
  /** Вторая строка: чем запись подписана — адрес, расчёт, бригада. */
  sub?: ReactNode;
  /** Числа справа. Больше пяти сюда не ставим: шестое уже не читается
      взглядом, и за ним идут в таблицу. */
  cells?: DbListCell[];
  /** Щелчок по строке. Без него строка не кнопка и на наведение не отвечает:
      обещать открытие там, где открывать нечего, нельзя. */
  onOpen?: () => void;
  /** Кнопка в конце строки. Стоит за пределами самой строки-кнопки: кнопка
      внутри кнопки не работает ни мышью, ни с клавиатуры. */
  action?: ReactNode;
}

interface Props {
  rows: DbListRow[];
  /** Плотнее: строка ужимается до одной линии, вторая строка и знак уходят.
      Тот же выбор «разглядеть или охватить», что и плотность у карточек. */
  dense?: boolean;
}

export function DbList({ rows, dense = false }: Props) {
  return (
    <section className="panel">
      <ul className={'dblist' + (dense ? ' dblist--dense' : '')}>
        {rows.map((row) => {
          const body = (
            <>
              {row.lead && <span className="dblist__lead">{row.lead}</span>}

              <span className="dblist__main">
                <span className="dblist__title">
                  {row.code && <span className="dblist__code">{row.code}</span>}
                  <span className="dblist__name">{row.title}</span>
                </span>
                {row.sub && <span className="dblist__sub">{row.sub}</span>}
              </span>

              {row.cells && row.cells.length > 0 && (
                <span className="dblist__cells">
                  {row.cells.map((cell) => (
                    <span
                      key={cell.label}
                      className={
                        'dblist__cell' +
                        (cell.wide ? ' dblist__cell--wide' : '') +
                        (cell.tone ? ' dblist__cell--' + cell.tone : '')
                      }
                    >
                      <span className="dblist__value">{cell.value}</span>
                      <span className="dblist__label">{cell.label}</span>
                    </span>
                  ))}
                </span>
              )}
            </>
          );

          return (
            <li key={row.key} className="dblist__item">
              {row.onOpen ? (
                <button type="button" className="dblist__row dblist__row--open" onClick={row.onOpen}>
                  {body}
                </button>
              ) : (
                <span className="dblist__row">{body}</span>
              )}
              {row.action && <span className="dblist__action">{row.action}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
