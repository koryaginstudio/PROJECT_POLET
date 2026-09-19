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
  /** Числа справа. Больше шести сюда не ставим: седьмое уже не читается
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
}

/* Плотности у списка нет: он сам и есть плотный вид, а переключатель в
   полосе отбора называется «Карточек в строке» и к строке во всю ширину
   отношения не имеет.

   Подписи чисел стоят шапкой над списком, а не под каждым числом в каждой
   строке. Раньше стояли в строках: пять подписей на строку и двести строк —
   тысяча повторений одного и того же слова, и каждое приходилось втискивать
   в ширину колонки, из-за чего «Средняя работа» и «Нужен доступ» читались
   как «Средняя …» и «Нужен дост…». Одна шапка называет колонку один раз,
   может перенести слово на вторую строку и освобождает в каждой строке
   место, которого не хватало адресу. Шапка держится при прокрутке: без неё
   на второй сотне строк колонка цифр снова становится безымянной. */
export function DbList({ rows }: Props) {
  /* Колонки берём у первой строки: набор чисел в списке один на всю базу,
     и строка с другим набором означала бы, что это два разных списка. */
  const columns = rows[0]?.cells ?? [];

  return (
    <section className="panel">
      {columns.length > 0 && (
        <div className="dblist__head" aria-hidden="true">
          <span className="dblist__head-gap" />
          <span className="dblist__cells">
            {columns.map((cell) => (
              <span
                key={cell.label}
                className={'dblist__cell' + (cell.wide ? ' dblist__cell--wide' : '')}
              >
                {cell.label}
              </span>
            ))}
          </span>
        </div>
      )}

      <ul className="dblist">
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
                      {/* Подпись повторяется в разметке для голосового
                          чтения: шапка от него скрыта, и без неё строка
                          прочлась бы набором чисел без имён. Глазами её не
                          видно — её место занимает шапка. */}
                      <span className="dblist__label">{cell.label}</span>
                      <span className="dblist__value">{cell.value}</span>
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
