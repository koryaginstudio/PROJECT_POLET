import { hhmm } from '../data/derive.ts';
import { dayEnd, dayStart } from '../data/service.ts';

interface Props {
  /** Окно приёма: когда клиент готов принять инженера. */
  from: number;
  to: number;
  /** Плановое время визита, если заявка попала в маршрут. */
  arrive?: number;
  start?: number;
  finish?: number;
  risky?: boolean;
  /** Граница суток плана (`meta.hard_end`), если карточка знает свой план.
      Без неё шкала тянется по самому окну и визиту. */
  hardEnd?: number;
}

/* Шаг делений, часы. Каждый час давал на узкой карточке пятнадцать рисок в
   строку — гребёнку, в которой не читается ни одна: они стояли чаще, чем
   подписи под ними, и глазу не за что было зацепиться. Через три часа
   деления совпадают с подписями один в один, и шкала наконец говорит то, для
   чего её рисуют: вот утро, вот полдень, вот вечер. */
const STEP = 3;

/* Окно приёма на шкале дня.

   Раньше время окна стояло подписью слева, а над самой полосой висела
   безымянная чёрточка приезда — по ней нельзя было понять, что за отметка и
   к чему она относится. Теперь числа стоят там, где нарисовано то, что они
   называют: окно подписано над своим отрезком, визит — под своей меткой.

   Отрезки на полосе отвечают на наведение: подрастают и говорят, что именно
   происходит в этот промежуток. Полоса из двух цветных кусков без этого
   молчалива — видно, что «что-то с десяти до двенадцати», но окно это или
   визит, и чем одно отличается от другого, приходилось выяснять по подписям
   вокруг. */
export function OrderWindow({ from, to, arrive, start, finish, risky, hardEnd }: Props) {
  /* Конец шкалы — свой, а не общая ось: карточка заявки живёт и в базах, где
     день не открыт и горизонт плана не выставлен. Шкала доходит до границы
     суток плана и до конца самого окна и визита, округлённых до часа, — у
     выгрузки заказчика окно 21:00–22:00 иначе сплющивалось в черту у правого
     края шкалы 07:00–21:00. Не дальше полуночи: шкала — одни сутки. */
  const end = Math.min(
    24 * 60,
    Math.ceil(Math.max(dayEnd(), hardEnd ?? 0, to, finish ?? 0) / 60) * 60
  );
  const pct = (m: number) =>
    ((Math.min(end, Math.max(dayStart(), m)) - dayStart()) / (end - dayStart())) * 100;

  const left = pct(from);
  const width = Math.max(2, pct(to) - left);
  const visit = start !== undefined && finish !== undefined;

  /* Деления: от первого круглого часа, кратного шагу, и дальше через шаг. */
  const marks: number[] = [];
  const firstMark = Math.ceil(dayStart() / 60 / STEP) * STEP * 60;
  for (let mark = firstMark; mark <= end; mark += STEP * 60) marks.push(mark);

  /* Подпись держится в границах шкалы: у окна с краю дня она иначе уезжает
     за панель. */
  const clamp = (value: number) => Math.min(88, Math.max(12, value));

  /* Крайние подписи прижимаются к краю, а не центруются по своей риске:
     семь утра стоит в нуле шкалы, и половина «07:00» уходила за левый край
     карточки. */
  const anchor = (value: number) => {
    if (value <= 2) return { transform: 'none', left: '0%' };
    if (value >= 98) return { transform: 'none', right: '0%' };
    return { left: `${value}%` };
  };

  return (
    <div className="owin">
      <div className="owin__top">
        <span className="owin__label" style={{ left: `${clamp(left + width / 2)}%` }}>
          {hhmm(from)}–{hhmm(to)}
        </span>
      </div>

      <div className="owin__track">
        {/* Часовая сетка лежит под окном, а не поверх: она разметка дня, а не
            часть заявки. */}
        {marks.map((mark) => (
          <span
            key={mark}
            className="owin__grid"
            style={{ left: `${pct(mark)}%` }}
            aria-hidden="true"
          />
        ))}

        <span
          className={'owin__span' + (risky ? ' owin__span--risk' : '')}
          style={{ left: `${left}%`, width: `${width}%` }}
          title={
            `Окно приёма ${hhmm(from)}–${hhmm(to)}: в это время клиент готов принять инженера` +
            (risky ? '. Запаса до крайнего срока нет — перенести некуда' : '')
          }
        />

        {visit && (
          <span
            className="owin__visit"
            style={{
              left: `${pct(start!)}%`,
              width: `${Math.max(1.5, pct(finish!) - pct(start!))}%`
            }}
            title={
              `Визит ${hhmm(start!)}–${hhmm(finish!)}: столько инженер работает на объекте` +
              (arrive !== undefined && arrive < start!
                ? `. Подъезжает к ${hhmm(arrive)} и ждёт открытия окна`
                : '')
            }
          />
        )}
      </div>

      {visit && (
        <div className="owin__bottom">
          <span className="owin__visit-label" style={{ left: `${clamp(pct(start!))}%` }}>
            Визит {hhmm(start!)}–{hhmm(finish!)}
            {arrive !== undefined && arrive < start! && ` · приезд ${hhmm(arrive)}`}
          </span>
        </div>
      )}

      <div className="owin__scale">
        {marks.map((mark) => (
          <span key={mark} className="owin__tick" style={anchor(pct(mark))}>
            <span className="owin__tick-mark" aria-hidden="true" />
            <span className="owin__tick-label">{hhmm(mark)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
