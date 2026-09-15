import { dayEnd, dayStart, hhmm } from '../data/derive.ts';
import { pct } from './scale.ts';

interface Props {
  /** Окно приёма: когда клиент готов принять инженера. */
  from: number;
  to: number;
  /** Плановое время визита, если заявка попала в маршрут. */
  arrive?: number;
  start?: number;
  finish?: number;
  risky?: boolean;
}


/* Окно приёма на шкале дня.

   Раньше время окна стояло подписью слева, а над самой полосой висела
   безымянная чёрточка приезда — по ней нельзя было понять, что за отметка и
   к чему она относится. Теперь числа стоят там, где нарисовано то, что они
   называют: окно подписано над своим отрезком, визит — под своей меткой. */
export function OrderWindow({ from, to, arrive, start, finish, risky }: Props) {
  const left = pct(from);
  const width = Math.max(2, pct(to) - left);
  const visit = start !== undefined && finish !== undefined;

  /* Подпись держится в границах шкалы: у окна с краю дня она иначе уезжает
     за панель. */
  const clamp = (value: number) => Math.min(88, Math.max(12, value));

  return (
    <div className="owin">
      <div className="owin__top">
        <span className="owin__label" style={{ left: `${clamp(left + width / 2)}%` }}>
          {hhmm(from)}–{hhmm(to)}
        </span>
      </div>

      <div className="owin__track">
        <span
          className={'owin__span' + (risky ? ' owin__span--risk' : '')}
          style={{ left: `${left}%`, width: `${width}%` }}
        />

        {visit && (
          <span
            className="owin__visit"
            style={{
              left: `${pct(start!)}%`,
              width: `${Math.max(1.5, pct(finish!) - pct(start!))}%`
            }}
            title={`Визит ${hhmm(start!)}–${hhmm(finish!)}`}
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
        <span>{hhmm(dayStart())}</span>
        <span>{hhmm(dayEnd())}</span>
      </div>
    </div>
  );
}
