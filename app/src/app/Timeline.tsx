import { useState } from 'react';
import { clampDay, dayEnd, dayStart, hhmm } from '../data/derive.ts';

interface Props {
  cut: number;
  onCutChange: (cut: number) => void;
  /** Подпись для скринридера: шкал на экране две, и на слух они не должны
      сливаться в одну. */
  label: string;
}

/* Мелкая риска каждый час, подпись каждые два — шаг один на всю шкалу,
   поэтому подписи не наезжают и читаются как одна линейка.

   Считается при отрисовке, а не при загрузке модуля: границы смены — настройка
   сервиса, и гребёнка, посчитанная однажды, осталась бы от прежней смены. */
const ticks = (step: number): number[] => {
  const list: number[] = [];
  for (let m = Math.ceil(dayStart() / 60) * 60; m <= dayEnd(); m += step) list.push(m);
  return list;
};

/* Шкала смены. Она стоит в двух местах — на пульте расчёта и в этапах, — но
   это не копия: обе двигают один и тот же момент, поэтому вторая не хранит
   своего состояния и всегда показывает то же время. Мотать удобнее там, куда
   в этот момент смотришь, а не только наверху экрана.

   Шаг — минута, а не четверть часа: набранное руками «14:38» должно совпадать
   с положением бегунка, а не округляться до 14:45. */
export function Timeline({ cut, onCutChange, label }: Props) {
  const pct = (m: number) => ((m - dayStart()) / (dayEnd() - dayStart())) * 100;

  return (
    <div className="scrub__control">
      <input
        className="scrub__range"
        type="range"
        min={dayStart()}
        max={dayEnd()}
        step={1}
        value={cut}
        aria-label={label}
        aria-valuetext={hhmm(cut)}
        onChange={(e) => onCutChange(Number(e.target.value))}
      />
      <div className="scrub__scale" aria-hidden="true">
        {ticks(60).map((m) => (
          <span key={'m' + m} className="scrub__minor" style={{ left: `${pct(m)}%` }} />
        ))}
        {ticks(120).map((m) => (
          <span key={'M' + m} className="scrub__major" style={{ left: `${pct(m)}%` }}>
            <span className="scrub__major-label">{hhmm(m)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}


/* Час с минутами из того, что набрали руками. Разделитель принимаем любой
   и обходимся без него: «1430», «14:30» и «14.30» — это одно и то же. */
function parseClock(text: string): number | null {
  const match = /^\s*(\d{1,2})\s*[:.\-\s]?\s*(\d{1,2})?\s*$/.exec(text);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = match[2] === undefined ? 0 : Number(match[2]);
  if (minutes > 59) return null;
  return clampDay(hours * 60 + minutes);
}

/* Шаговик момента: те же четыре шага и поле, в которое время вписывают
   руками. Стоит рядом с каждой шкалой — и на пульте расчёта, и на ганте,
   чтобы не мотать день из другого конца экрана. */
export function Stepper({ cut, onCutChange }: { cut: number; onCutChange: (cut: number) => void }) {
  /* Пока в поле печатают, оно живёт своей строкой: иначе «1» из «14:30»
     мгновенно превратится в 01:00 и допечатать не получится. */
  const [typed, setTyped] = useState<string | null>(null);
  const shift = (delta: number) =>
    onCutChange(clampDay(cut + delta));

  const commit = () => {
    if (typed === null) return;
    const parsed = parseClock(typed);
    if (parsed !== null) onCutChange(parsed);
    setTyped(null);
  };

  return (
    <div className="stepper">
      <button type="button" className="stepper__btn" onClick={() => shift(-60)} title="На час назад">
        −1 ч
      </button>
      <button type="button" className="stepper__btn" onClick={() => shift(-15)} title="На 15 минут назад">
        −15
      </button>
      <input
        className="stepper__clock"
        value={typed ?? hhmm(cut)}
        onChange={(e) => setTyped(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            e.currentTarget.blur();
          }
          if (e.key === 'Escape') {
            setTyped(null);
            e.currentTarget.blur();
          }
        }}
        inputMode="numeric"
        maxLength={5}
        aria-label="Момент расчёта, часы и минуты"
        title="Впишите время вручную: 14:30"
      />
      <button type="button" className="stepper__btn" onClick={() => shift(15)} title="На 15 минут вперёд">
        +15
      </button>
      <button type="button" className="stepper__btn" onClick={() => shift(60)} title="На час вперёд">
        +1 ч
      </button>
    </div>
  );
}

/* Шкала вместе с шаговиком — один блок, потому что порознь они бесполезны:
   по шкале видно, где момент стоит, шаговиком его двигают. Раньше эта пара
   собиралась заново в каждом месте, и стоило убрать её из одного, как в
   соседнем оставалась шкала без единой кнопки. */
export function TimeScrub({
  cut,
  onCutChange,
  label
}: {
  cut: number;
  onCutChange: (cut: number | ((prev: number) => number)) => void;
  label: string;
}) {
  return (
    <div className="scrub">
      {/* Шаговик стоит по центру над шкалой и без подписи: время в нём и так
          написано, а слово слева только сдвигало кнопки от середины, к которой
          они относятся. */}
      <div className="scrub__row scrub__row--center">
        <Stepper cut={cut} onCutChange={(v) => onCutChange(v)} />
      </div>

      {/* Шкала занимает всю ширину: восемь подписей времени в остатке строки
          наезжали друг на друга и переставали читаться. */}
      <div className="scrub__row scrub__row--control">
        <Timeline cut={cut} onCutChange={onCutChange} label={label} />
      </div>
    </div>
  );
}
