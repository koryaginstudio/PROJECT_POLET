import { useMemo, useState } from 'react';
import type { DayView } from '../data/derive.ts';
import { engineerTimeline, hhmm, placeOf } from '../data/derive.ts';
/* Своя `hours` в этом файле уже есть — берём шкалу под другим именем. */
import { hours as dayHours } from './scale.ts';

interface Props {
  view: DayView;
  /** Наведённый час уходит на гант: там он подсвечивается полосой, и строка
      панели и место на ленте читаются как одно и то же. */
  onHoverHour: (from: number | null) => void;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

/* Занятость — это работа, дорога и ожидание окна: инженер, который стоит
   под дверью и ждёт открытия, свободным не является. Обед и простой —
   наоборот, свободное время, но обед предлагать под заявку нельзя. */
const BUSY = new Set(['work', 'travel', 'wait']);

/* Правая панель раздела «Гант»: час за часом.

   Гант отвечает на «кто чем занят», и ровно поэтому главное на нём остаётся
   несказанным: свободные руки и невзятые окна лежат в разных концах экрана —
   инженеры сверху, заявки без инженера внизу, — и совпадение по времени
   приходится ловить глазами через полстраницы. Здесь оно посчитано.

   Строка — час дня: сколько инженеров занято, сколько свободно и сколько
   окон в этот час открыто и никем не взято. Часы, где свободные руки сошлись
   с невзятыми окнами, отмечены: это и есть места, где смену ещё можно
   поправить. */
export function HourPanel({ view, onHoverHour, onSelectOrder, onSelectEngineer }: Props) {
  const [open, setOpen] = useState<number | null>(null);
  const [hot, setHot] = useState<number | null>(null);

  const hours = useMemo(() => {
    /* Ленту каждого инженера строим один раз на все часы: двенадцать лент
       против четырнадцати часов — иначе одно и то же считается по кругу. */
    const bands = view.loads.map((load) => ({
      load,
      segments: engineerTimeline(load.route, load.engineer, view.stopByOrder)
    }));

    return dayHours().slice(0, -1).map((from) => {
      const to = from + 60;
      const overlaps = (a: number, b: number) => a < to && b > from;

      const onShift = bands.filter((band) =>
        overlaps(band.load.engineer.shift_start, band.load.engineer.shift_end)
      );
      const busy = onShift.filter((band) =>
        band.segments.some((segment) => BUSY.has(segment.kind) && overlaps(segment.from, segment.to))
      );
      const idle = onShift.filter((band) => !busy.includes(band));
      const windows = view.unassigned.filter((order) =>
        overlaps(order.window_start, order.window_end)
      );

      return {
        from,
        onShift: onShift.length,
        busy: busy.length,
        idle: idle.map((band) => band.load),
        windows
      };
    });
  }, [view]);

  const peak = Math.max(1, ...hours.map((hour) => hour.onShift));

  return (
    <div className="rpanel">
      <div className="rpanel__head">
        <h2 className="detail__title">Часы смены</h2>
        <p className="rpanel__note">
          Сколько рук занято в каждый час и сколько окон в этот же час стоят без инженера.
          Отмечены часы, где свободные руки сошлись с невзятыми окнами.
        </p>
      </div>

      {/* Колонки подписаны один раз сверху, а не значком в каждой из
          четырнадцати строк: подпись нужна, чтобы понять числа, и одного
          раза для этого довольно. */}
      <div className="hourcols">
        <span className="hourcols__time" />
        <span className="hourcols__bar" />
        <span className="hourcols__label">свободны</span>
        <span className="hourcols__label">окна</span>
      </div>

      <div className="hourlist" onMouseLeave={() => { setHot(null); onHoverHour(null); }}>
        {hours.map((hour) => {
          const chance = hour.idle.length > 0 && hour.windows.length > 0;
          const shown = open === hour.from;
          return (
            <div className="hourlist__group" key={hour.from}>
              <button
                type="button"
                className={
                  'hourrow' +
                  (chance ? ' hourrow--chance' : '') +
                  (shown ? ' hourrow--open' : '')
                }
                onClick={() => setOpen(shown ? null : hour.from)}
                onMouseEnter={() => {
                  setHot(hour.from);
                  onHoverHour(hour.from);
                }}
                onFocus={() => {
                  setHot(hour.from);
                  onHoverHour(hour.from);
                }}
                onBlur={() => {
                  setHot(null);
                  onHoverHour(null);
                }}
                aria-expanded={shown}
                disabled={hour.idle.length === 0 && hour.windows.length === 0}
              >
                <span className="hourrow__time">{hhmm(hour.from)}</span>

                {/* Полоска занятости: заполненная часть — занятые руки,
                    остаток — свободные. Мерка одна на все часы, поэтому часы
                    сравнимы между собой. */}
                <span className="hourrow__bar" aria-hidden="true">
                  <span
                    className="hourrow__busy"
                    style={{ width: `${(hour.busy / peak) * 100}%` }}
                  />
                  <span
                    className="hourrow__idle"
                    style={{ width: `${((hour.onShift - hour.busy) / peak) * 100}%` }}
                  />
                </span>

                <span className="hourrow__facts">
                  <span className="hourrow__free">{hour.onShift - hour.busy}</span>
                  <span className={'hourrow__gap' + (hour.windows.length > 0 ? ' hourrow__gap--on' : '')}>
                    {hour.windows.length}
                  </span>
                </span>
              </button>

              {/* Подсказка разворачивает строку словами: числа в ней короткие,
                  а сказать надо, из чего они сложились. Раскрытый список —
                  это уже про «кого именно», и он открывается щелчком. */}
              {hot === hour.from && !shown && (
                <div className="hourtip">
                  <span className="hourtip__head">
                    {hhmm(hour.from)}–{hhmm(hour.from + 60)}
                  </span>
                  <span className="hourtip__line">
                    На смене {hour.onShift} · заняты {hour.busy} · свободны{' '}
                    {hour.onShift - hour.busy}
                  </span>
                  <span className="hourtip__line">
                    {hour.windows.length > 0
                      ? `Окон без инженера: ${hour.windows.length}`
                      : 'Невзятых окон в этот час нет'}
                  </span>
                  {chance && (
                    <span className="hourtip__note">
                      Свободные руки и невзятые окна сошлись — здесь смену ещё можно поправить.
                    </span>
                  )}
                  {hour.idle.length === 0 && hour.windows.length === 0 && (
                    <span className="hourtip__note">Раскрывать нечего: час занят целиком.</span>
                  )}
                </div>
              )}

              {shown && (
                <div className="hourlist__body">
                  <p className="hourlist__line">
                    Занято {hour.busy} из {hour.onShift} на смене.
                  </p>

                  {hour.idle.length > 0 && (
                    <>
                      <p className="hourlist__sub">Свободны</p>
                      <div className="hourlist__chips">
                        {hour.idle.map((load) => (
                          <button
                            key={load.engineer.id}
                            type="button"
                            className="hourchip"
                            onClick={() => onSelectEngineer(load.engineer.id)}
                          >
                            {load.engineer.name}
                          </button>
                        ))}
                      </div>
                    </>
                  )}

                  {hour.windows.length > 0 && (
                    <>
                      <p className="hourlist__sub">Окна без инженера</p>
                      {hour.windows.map((order) => (
                        <button
                          key={order.id}
                          type="button"
                          className="stagerow"
                          onClick={() => onSelectOrder(order.id)}
                        >
                          <span className="stagerow__time">
                            {hhmm(order.window_start)}–{hhmm(order.window_end)}
                          </span>
                          <span className="stagerow__body">
                            <span className="stagerow__what">
                              {order.id} · {order.work_title}
                            </span>
                            <span className="stagerow__who" title={placeOf(order)}>
                              {placeOf(order)}
                            </span>
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
