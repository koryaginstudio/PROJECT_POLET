import { FilterDrop, PickRow } from './FilterDrop.tsx';

/* Порядок списка — одной кнопкой вместо ряда правил.

   Правил пять, и в ряду переключателей они занимали всю ширину полосы, хотя
   действует из них всегда одно. Теперь на полосе стоит то, что и вправду
   действует: правило и сторона — «По сроку · сначала ближний срок», — а
   выбор раскрывается по нажатию.

   Заодно сторона перестала быть тайной. Порядок по-прежнему переворачивается
   повторным нажатием на выбранное правило, но теперь обе стороны названы
   словами, и слова у каждого правила свои: «Сначала ближайший срок» диспетчер
   понимает сразу, а «по возрастанию» ему пришлось бы переводить на заявки. */

export interface SortRule {
  value: string;
  /** Название правила: по чему упорядочено. */
  label: string;
  /** На какой вопрос отвечает этот порядок. */
  note: string;
  /** Как называются стороны — прямая и обратная. */
  up: string;
  down: string;
}

interface Props {
  rules: SortRule[];
  value: string;
  desc: boolean;
  onPick: (value: string) => void;
  onOrder: (desc: boolean) => void;
}

export function SortMenu({ rules, value, desc, onPick, onOrder }: Props) {
  const current = rules.find((rule) => rule.value === value) ?? rules[0];
  const side = desc ? current.down : current.up;

  return (
    <FilterDrop
      label={current.label}
      count={side}
      aria="Порядок списка"
      title={`Список упорядочен: ${current.label.toLowerCase()}, ${side.toLowerCase()}`}
    >
      {/* Список не закрывается по выбору: правило и сторону чаще всего
          переставляют парой, и закрытое меню пришлось бы открывать снова.

          Нажатие на уже выбранное правило переворачивает сторону — так же,
          как повторный щелчок по колонке в таблице. Раньше здесь оно не
          делало ничего, а в базах с рядом переключателей переворачивало, и
          один и тот же жест в двух базах вёл себя по-разному. Теперь одно
          поведение везде, а сторона названа строкой ниже — видно, что
          именно перевернулось. Нажатие на уже выбранную сторону по-прежнему
          ничего не делает: счётчик показанного начинался бы заново, и
          длинный список молча схлопнулся бы к первой странице. */}
      {() => (
        <>
          <div className="fdrop__head">
            <span className="fdrop__title">Чем упорядочить список</span>
          </div>

          <div role="radiogroup" aria-label="Чем упорядочить список">
            {rules.map((rule) => (
              <PickRow
                key={rule.value}
                name={rule.label}
                note={rule.note}
                on={rule.value === value}
                onPick={() => (rule.value === value ? onOrder(!desc) : onPick(rule.value))}
              />
            ))}
          </div>

          <div className="fdrop__part" role="radiogroup" aria-label={`Порядок: ${current.label.toLowerCase()}`}>
            <span className="fdrop__part-label">Порядок</span>
            <PickRow name={current.up} on={!desc} onPick={() => desc && onOrder(false)} />
            <PickRow name={current.down} on={desc} onPick={() => !desc && onOrder(true)} />
          </div>
        </>
      )}
    </FilterDrop>
  );
}
