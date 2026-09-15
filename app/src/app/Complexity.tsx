interface Props {
  /** Оценка длительности работ, минуты. */
  minutes: number;
}

/* Сложность заявки.

   Была лесенкой из столбиков разной высоты — она читалась как уровень сигнала
   сотовой сети и к работе инженера отношения не имела. Теперь это три равные
   ячейки в общей рамке: сколько залито, такова сложность, а цвет говорит то
   же самое вторым способом — зелёный, жёлтый, красный. */
const LEVELS = [
  { max: 45, filled: 1, tone: 'easy', label: 'Простая' },
  { max: 75, filled: 2, tone: 'mid', label: 'Средняя' },
  { max: Infinity, filled: 3, tone: 'hard', label: 'Сложная' }
];

export function Complexity({ minutes }: Props) {
  const level = LEVELS.find((item) => minutes <= item.max)!;
  return (
    <span
      className={'cxm cxm--' + level.tone}
      title={`${level.label} работа · ${minutes} мин по оценке`}
    >
      <span className="cxm__cells">
        {[0, 1, 2].map((index) => (
          <span key={index} className={'cxm__cell' + (index < level.filled ? ' cxm__cell--on' : '')} />
        ))}
      </span>
      {level.label}
    </span>
  );
}
