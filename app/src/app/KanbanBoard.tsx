import { useMemo } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView, StageKey } from '../data/derive.ts';
import { hhmm, placeOf, STAGE_META, stageOfOrder } from '../data/derive.ts';
import { workTypeIcon } from '../data/dictionary.ts';
import { TimeScrub } from './Timeline.tsx';

interface Props {
  view: DayView;
  cut: number;
  onCutChange: (cut: number | ((prev: number) => number)) => void;
  selected: string | null;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

/* Порядок колонок — ход смены слева направо, а по краям то, что требует
   решения: слева заявки, которые движок никому не отдал, справа те, по
   которым план выходит за крайний срок. Середина читается как конвейер. */
const COLUMNS: StageKey[] = ['unassigned', 'planned', 'enroute', 'working', 'done', 'overdue'];

/* «Сорвалось» — факт из журнала дня, и колонка для него появляется, только
   когда журнал есть: у расчёта без журнала она всегда была бы пустой.
   Стоит правее прогноза срыва: сначала то, что может сорваться, потом то,
   что уже сорвалось. */
const WITH_JOURNAL: StageKey[] = [...COLUMNS, 'failed'];

/* Канбан смены. Та же воронка, что в сводке, но не числами, а карточками:
   сводка отвечает «сколько», канбан — «какие именно». Колонка — этап на
   текущем срезе, поэтому доска едет вместе с ползунком времени: сдвинул
   момент — заявки переехали по колонкам сами. */
export function KanbanBoard({
  view,
  cut,
  onCutChange,
  selected,
  onSelectOrder,
  onSelectEngineer
}: Props) {
  const columns = useMemo(() => {
    const keys = Object.keys(view.reported).length > 0 ? WITH_JOURNAL : COLUMNS;
    const buckets = new Map<StageKey, { ids: string[] }>();
    for (const key of keys) buckets.set(key, { ids: [] });

    for (const order of view.orderById.values()) {
      const stage = stageOfOrder(view, order.id, cut);
      buckets.get(stage.key)?.ids.push(order.id);
    }

    /* Внутри колонки — по времени визита: доска должна читаться сверху вниз
       как очередь, а не как случайный список. */
    for (const bucket of buckets.values()) {
      bucket.ids.sort((a, b) => {
        const left = view.stopByOrder.get(a)?.stop.start ?? view.orderById.get(a)?.window_start ?? 0;
        const right = view.stopByOrder.get(b)?.stop.start ?? view.orderById.get(b)?.window_start ?? 0;
        return left - right;
      });
    }

    return keys.map((key) => ({ key, ...STAGE_META[key], ids: buckets.get(key)!.ids }));
  }, [view, cut]);

  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Смена по этапам</h2>
        <span className="dash__section-note">
          Этапы на {hhmm(cut)} — карточки переезжают вместе с моментом
        </span>
      </div>

      {/* Шкала стоит над доской: без неё доска показывает только начало дня,
          и все карточки честно стоят в одной колонке. */}
      <TimeScrub cut={cut} onCutChange={onCutChange} label="Момент на доске" />

      <div className="kanban">
        {columns.map((column) => (
          <div key={column.key} className="kancol">
            <div className={'kancol__head kancol__head--' + column.tone}>
              {/* Пояснение висит на самой подписи: слово «прогноз» в названии
                  колонки поднимает вопрос, и ответ должен быть там же, а не
                  в другом разделе. */}
              <span className="kancol__label" title={column.hint ?? column.label}>
                {column.label}
              </span>
              <span className="kancol__count">{column.ids.length}</span>
            </div>

            <div className="kancol__body">
              {column.ids.length === 0 && <p className="kancol__empty">Пусто</p>}

              {column.ids.map((id) => {
                const order = view.orderById.get(id)!;
                const placement = view.stopByOrder.get(id);
                const engineer = placement
                  ? view.engineerById.get(placement.engineerId)
                  : undefined;
                return (
                  <div
                    key={id}
                    className={'kancard' + (selected === id ? ' kancard--selected' : '')}
                  >
                    <button
                      type="button"
                      className="kancard__main"
                      onClick={() => onSelectOrder(id)}
                    >
                      {/* Номер идёт первым и крупнее: карточку ищут по номеру
                          и называют по номеру, а вид работ — это её описание.
                          Раньше было наоборот, и глаз цеплялся за «Подключение»
                          на десятке одинаковых карточек подряд. */}
                      <span className="kancard__top">
                        <span className="kancard__id">{id}</span>
                        <span className="kancard__work">
                          <Icon name={workTypeIcon(order.work_type)} size={12} />
                          {order.work_title}
                        </span>
                      </span>
                      <span className="kancard__where" title={placeOf(order)}>
                        {placeOf(order)}
                      </span>
                      <span className="kancard__when">
                        {placement
                          ? `${hhmm(placement.stop.start)}–${hhmm(placement.stop.finish)}`
                          : `окно ${hhmm(order.window_start)}–${hhmm(order.window_end)}`}
                        {order.needs_access && <span className="kancard__flag">Доступ</span>}
                      </span>
                    </button>

                    {engineer && (
                      <button
                        type="button"
                        className="kancard__who"
                        onClick={() => onSelectEngineer(engineer.id)}
                        title="Открыть инженера"
                      >
                        <Icon name="user" size={11} />
                        {engineer.name}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
