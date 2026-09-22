import { useMemo, useState } from 'react';
import type { DayView } from '../data/derive.ts';
import { hhmm, placeOf } from '../data/derive.ts';
import { Timeline } from './Timeline.tsx';

interface Props {
  view: DayView;
  cut: number;
  /** Момент двигают и отсюда: шкала в панели та же, что над доской. */
  onCutChange: (cut: number) => void;
  selected: string | null;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

/* Правая панель раздела «Канбан»: кто сколько закрыл к этому моменту.

   Доска отвечает на «что происходит с заявками» — карточки едут по этапам
   вместе с ползунком. Про людей она молчит: чтобы понять, сколько закрыл
   один инженер, приходится вылавливать его имя из колонки «Выполнено».
   Здесь то же самое посчитано по людям.

   Мерка одна на всех — доля закрытого от того, что инженеру отдали: у одного
   в маршруте четыре визита, у другого семь, и три закрытых визита значат у
   них разное. Списки закрыты по умолчанию: панель отвечает числом, а
   поимённо — если спросят. */
export function CrewPanel({ view, cut, onCutChange, selected, onSelectOrder, onSelectEngineer }: Props) {
  const [open, setOpen] = useState<string[]>([]);

  const crew = useMemo(() => {
    const rows = view.loads
      .filter((load) => load.route && load.route.stops.length > 0)
      .map((load) => {
        const stops = load.route!.stops;
        /* Закрыт — тот визит, который к этому моменту уже кончился. Не
           «начат» и не «в плане»: закрытие видно по времени окончания. */
        const done = stops.filter((stop) => cut >= stop.finish);
        const now = stops.find((stop) => cut >= stop.start && cut < stop.finish);
        return {
          load,
          stops,
          done,
          now,
          share: done.length / stops.length
        };
      });

    /* Впереди те, кто закрыл больше: панель отвечает на «сколько закрыл», и
       читать её надо сверху. При равенстве — по доле, потом по фамилии. */
    return rows.sort(
      (a, b) =>
        b.done.length - a.done.length ||
        b.share - a.share ||
        a.load.engineer.name.localeCompare(b.load.engineer.name)
    );
  }, [view, cut]);

  const closed = crew.reduce((sum, row) => sum + row.done.length, 0);
  const planned = crew.reduce((sum, row) => sum + row.stops.length, 0);

  const toggle = (id: string) =>
    setOpen((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));

  return (
    <div className="rpanel">
      <div className="rpanel__head">
        <h2 className="detail__title">К {hhmm(cut)} по плану</h2>
        {/* «Успел закрыть» здесь было неправдой: день ещё не прожит, и
            фактического исполнения у нас нет. Это план — сколько инженер
            должен успеть к этому моменту, если поедет так, как рассчитал
            движок. Разница принципиальная: одно описывает прошлое, другое
            обещание, и путать их на экране диспетчера нельзя. */}
        <p className="rpanel__note">
          Сколько заявок инженер должен успеть закрыть к этому моменту — по расчёту. Момент двигают ползунком: он же над доской, он же здесь.
        </p>
      </div>

      {/* Шкала продублирована в панель: доску крутят, глядя в список справа,
          и тянуться за ползунком через весь экран незачем. Момент общий —
          обе шкалы двигают одно и то же значение. */}
      <div className="crewscrub">
        <Timeline cut={cut} onCutChange={onCutChange} label="Момент, на который показан план" />
      </div>

      {/* Число выровнено по всей подписи, а не по её первой строке: подпись
          занимает две строки, и крупная цифра, прибитая к верхней, читалась
          как оторванная от второй половины фразы. */}
      <div className="crewtotal">
        <span className="crewtotal__value">{closed}</span>
        <span className="crewtotal__label">
          из {planned} заявок смены · {crew.length} инженеров на маршруте
        </span>
      </div>

      <div className="stagelist">
        {crew.map((row) => {
          const id = row.load.engineer.id;
          const shown = open.includes(id);
          return (
            <div className="stagelist__group" key={id}>
              <button
                type="button"
                className={'crewrow' + (shown ? ' crewrow--open' : '')}
                onClick={() => toggle(id)}
                aria-expanded={shown}
              >
                <span className="crewrow__name">{row.load.engineer.name}</span>

                {/* Полоса — доля закрытого от отданного: у разных маршрутов
                    разная длина, и одни только «три визита» несравнимы. */}
                <span className="crewrow__bar" aria-hidden="true">
                  <span className="crewrow__fill" style={{ width: `${row.share * 100}%` }} />
                </span>

                <span className="crewrow__count">
                  <b>{row.done.length}</b>/{row.stops.length}
                </span>
              </button>

              {shown && (
                <div className="stagelist__body">
                  {row.now && (
                    <p className="crewrow__now">
                      По плану сейчас: {view.orderById.get(row.now.order_id)?.work_title ?? row.now.order_id}
                      {' '}до {hhmm(row.now.finish)}
                    </p>
                  )}

                  {row.done.length === 0 ? (
                    <p className="hourlist__line">К этому моменту по плану ни одной заявки.</p>
                  ) : (
                    row.done.map((stop) => {
                      const order = view.orderById.get(stop.order_id);
                      const placement = view.stopByOrder.get(stop.order_id);
                      return (
                        <button
                          key={stop.order_id}
                          type="button"
                          className={
                            'stagerow' + (selected === stop.order_id ? ' stagerow--selected' : '')
                          }
                          onClick={() => onSelectOrder(stop.order_id)}
                        >
                          <span className="stagerow__time">{hhmm(stop.finish)}</span>
                          <span className="stagerow__body">
                            <span className="stagerow__what">
                              {stop.order_id} · {order ? order.work_title : '—'}
                            </span>
                            <span className="stagerow__who">
                              {order ? placeOf(order) : ''}
                              {placement?.slaBreached ? ' · срок нарушен' : ''}
                            </span>
                          </span>
                        </button>
                      );
                    })
                  )}

                  <button
                    type="button"
                    className="hourchip"
                    onClick={() => onSelectEngineer(id)}
                  >
                    Карточка инженера
                  </button>
                </div>
              )}
            </div>
          );
        })}

        {crew.length === 0 && (
          <p className="hourlist__line">В этом расчёте маршрут не достался никому.</p>
        )}
      </div>
    </div>
  );
}
