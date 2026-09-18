import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';

/* Кнопка со списком под ней — общая часть отборов в полосе базы.

   Полоса отбора растёт вместе с данными, а места под неё больше не
   становится. Поэтому длинные перечни живут под кнопками: на полосе стоит
   короткая подпись со счётчиком, перечень раскрывается по нажатию и остаётся
   раскрытым, пока не промахнулись мимо или не нажали клавишу, — отметок
   ставят по нескольку, и закрытый после первой список пришлось бы открывать
   снова.

   Кнопка тихая, по образцу набора виджетов: это настройка того, как смотрят
   на список, а не действие раздела.

   Там, где за кнопкой стоит целая группа, кнопка двусоставная: нажатие на
   саму кнопку отмечает или снимает всю группу разом, а список открывается
   стрелочкой справа. Так частый ход — «покажи все аварийные» — стоит одного
   нажатия и не требует раскрывать перечень, а редкий — «только замену
   приставки» — остаётся за стрелочкой.

   Сам компонент не знает, что внутри: содержимое рисует тот, кто его позвал,
   — отметки квадратами у видов работ, кружками у сортировки. Общее здесь
   другое: облик кнопки, поведение раскрытого списка и то, как он вправляется
   в экран. */

/* Насколько близко к краю окна списку позволено подойти. */
const EDGE = 12;

interface Toggle {
  /** Отмечено всё, что за кнопкой стоит. */
  on: boolean;
  /** Отмечено кое-что: квадрат с чертой вместо галочки. */
  some: boolean;
  /** Подсказка по наведению на саму кнопку. */
  title: string;
  onPick: () => void;
}

interface Props {
  /** Подпись на кнопке. Одной строкой: перенос разваливает ряд. */
  label: string;
  /** Правая половина кнопки: сколько записей за ней, «46 из 107» либо сторона
      порядка у сортировки. */
  count?: string;
  /** В списке что-то отмечено — кнопка помечена чёрной рамкой. */
  picked?: boolean;
  /** Подсказка по наведению: полное название и что будет по нажатию. */
  title?: string;
  /** Чем список подписан для чтения с экрана. */
  aria: string;
  /** Отметка всей группы по нажатию на саму кнопку. Нет — кнопка только
      раскрывает список: у порядка «всей группы» не бывает. */
  toggle?: Toggle;
  /** Содержимое списка. Считается только раскрытым: перечень видов работ
      собирается заново на каждую отметку, и закрытому он ни к чему. */
  children: () => ReactNode;
}

export function FilterDrop({ label, count, picked = false, title, aria, toggle, children }: Props) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  /* Раскрытое закрывается тремя способами, и все три обязательны. Промах
     мимо — для мыши. Клавиша — для того, кто передумал, не сходя с места; по
     ней курсор возвращается на кнопку, иначе закрытый список унёс бы его с
     собой. Уход курсора наружу — для клавиатуры: нажатие клавишей события
     мыши не даёт, и без этого на полосе раскрывались бы два списка разом. */
  useEffect(() => {
    if (!open) return;
    const outside = (target: EventTarget | null) => !box.current?.contains(target as Node);
    const away = (event: MouseEvent) => {
      if (outside(event.target)) setOpen(false);
    };
    const left = (event: FocusEvent) => {
      if (outside(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('focusin', left);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('focusin', left);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  const shell =
    'fdrop__btn' + (open ? ' fdrop__btn--on' : '') + (picked ? ' fdrop__btn--picked' : '');
  const arrow = <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />;

  return (
    <div className="fdrop" ref={box}>
      {toggle ? (
        <div className={shell + ' fdrop__btn--split'}>
          <button
            type="button"
            className="fdrop__take"
            role="checkbox"
            aria-checked={toggle.on ? true : toggle.some ? 'mixed' : false}
            onClick={toggle.onPick}
            title={toggle.title}
          >
            <span
              className={
                'fdrop__box' +
                (toggle.on ? ' fdrop__box--on' : toggle.some ? ' fdrop__box--some' : '')
              }
            >
              {toggle.on ? (
                <Icon name="check" size={11} />
              ) : toggle.some ? (
                <Icon name="minus" size={11} />
              ) : null}
            </span>
            {label}
            {count && <span className="fdrop__count">{count}</span>}
          </button>

          <button
            type="button"
            ref={trigger}
            className="fdrop__more"
            onClick={() => setOpen((was) => !was)}
            aria-expanded={open}
            aria-label={`Выбрать по одному: ${aria}`}
            title={title}
          >
            {arrow}
          </button>
        </div>
      ) : (
        <button
          type="button"
          ref={trigger}
          className={shell}
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          title={title}
        >
          {label}
          {count && <span className="fdrop__count">{count}</span>}
          {arrow}
        </button>
      )}

      {open && <Card label={aria}>{children()}</Card>}
    </div>
  );
}

/* Список, вправленный в экран. Кнопки стоят рядом и кочуют по полосе вслед за
   соседями, поэтому правый край списка, раскрытого от левого края кнопки,
   легко уезжает за пределы окна. Положение задаёт вёрстка, а поправку список
   считает сам: после раскрытия он меряет себя и сдвигается ровно настолько,
   чтобы влезть. Сдвиг едет отдельной переменной, а не готовым `transform`, —
   так же, как в наборе виджетов, и по той же причине: переписать `transform`
   целиком значит сломать привязку.

   Список — не диалог: курсор в него не переносится, и выхода он не
   стережёт. Для чтения с экрана это просто именованная часть полосы. */
function Card({ children, label }: { children: ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  /* Текущий сдвиг нужен самому замеру: рамка возвращается уже сдвинутой, и без
     этого поправка накладывалась бы сама на себя при каждом пересчёте. */
  const applied = useRef(0);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const fit = () => {
      const rect = node.getBoundingClientRect();
      const left = rect.left - applied.current;
      const right = rect.right - applied.current;
      let dx = 0;
      if (right > window.innerWidth - EDGE) dx = window.innerWidth - EDGE - right;
      if (left + dx < EDGE) dx = EDGE - left;
      applied.current = dx;
      setShift(dx);
    };
    fit();
    /* Мерить приходится и после того, как полоса переложится: отметка меняет
       ширину кнопки, а ряд кнопок переносится, и якорь уезжает под уже
       раскрытым списком. */
    const watch = new ResizeObserver(fit);
    if (node.parentElement) watch.observe(node.parentElement);
    window.addEventListener('resize', fit);
    return () => {
      watch.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);

  return (
    <div
      className="fdrop__card"
      role="group"
      aria-label={label}
      ref={box}
      style={{ '--drop-shift': `${shift}px` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

interface RowProps {
  name: string;
  /** Вторая строка мелким: чем это правило или вид работ отличается от
      соседнего. Не у всех — там, где название говорит само за себя. */
  note?: string;
  /** Сколько заявок за строкой. */
  count?: number;
  on: boolean;
  onPick: () => void;
}

/* Строка с квадратом — там, где отметок может быть несколько. */
export function CheckRow({
  name,
  note,
  count,
  on,
  some = false,
  head = false,
  onPick
}: RowProps & {
  /** Отмечено не всё, что за строкой стоит: квадрат с чертой вместо галочки.
      Только у строки, которая отмечает целую группу. */
  some?: boolean;
  /** Строка группы — крупнее и плотнее остальных. */
  head?: boolean;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      className={'fdrop__row' + (head ? ' fdrop__row--head' : '') + (on ? ' fdrop__row--on' : '')}
      onClick={onPick}
      aria-checked={on ? true : some ? 'mixed' : false}
    >
      <span className={'fdrop__box' + (on ? ' fdrop__box--on' : some ? ' fdrop__box--some' : '')}>
        {on ? <Icon name="check" size={11} /> : some ? <Icon name="minus" size={11} /> : null}
      </span>
      <span className="fdrop__text">
        <span className="fdrop__name">{name}</span>
        {note && <span className="fdrop__note">{note}</span>}
      </span>
      {count !== undefined && <span className="fdrop__num">{count}</span>}
    </button>
  );
}

/* Строка с кружком — там, где выбирают одно из нескольких. Квадрат обещал бы
   несколько отметок сразу, а список умеет упорядочить только по одному
   правилу. */
export function PickRow({ name, note, count, on, onPick }: RowProps) {
  return (
    <button
      type="button"
      role="radio"
      className={'fdrop__row' + (on ? ' fdrop__row--on' : '')}
      onClick={onPick}
      aria-checked={on}
    >
      <span className={'fdrop__dot' + (on ? ' fdrop__dot--on' : '')} />
      <span className="fdrop__text">
        <span className="fdrop__name">{name}</span>
        {note && <span className="fdrop__note">{note}</span>}
      </span>
      {count !== undefined && <span className="fdrop__num">{count}</span>}
    </button>
  );
}
