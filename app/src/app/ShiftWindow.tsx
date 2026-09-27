import { useEffect, useRef } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { pluralWord } from '../data/derive.ts';
import { runCode, whenLabel } from '../data/load.ts';
import type { RunId } from '../data/load.ts';
import { successOf, wasWatched, watchTime } from '../data/watch.ts';
import type { WatchEventKind, WatchShift } from '../data/watch.ts';
import { useModalFocus } from './modal.ts';

interface Props {
  /** Смена, которую разбирают. Пусто — окна нет. */
  shift: WatchShift | null;
  onClose: () => void;
  /** Разобрать расчёт: окно смены закрывается, на его место встаёт карточка
      расчёта. Два окна друг поверх друга диспетчер закрывал бы дважды. */
  onOpenRun: (id: RunId) => void;
  /** Смотреть этот день в мониторинге. Есть только у сегодняшней смены:
      живой вид показывает то, что происходит сейчас, и вчерашнего дня в нём
      нет. */
  onWatch?: () => void;
}

const percent = (share: number) => `${Math.round(share)}%`;

const fullDate = (iso: string) => {
  const [year, month, day] = iso.split('-');
  return day ? `${day}.${month}.${year}` : iso;
};

/* Значок рода события. Журнал смены читают глазами сверху вниз, и значок
   отвечает «что это было» раньше, чем строка: наблюдение, рабочий расчёт,
   происшествие, пересчёт, новый расчёт. */
const EVENT_ICON: Record<WatchEventKind, string> = {
  watch: 'navigation-arrow',
  duty: 'check-circle',
  incident: 'lightning',
  replan: 'shuffle',
  run: 'stack'
};

/* Разбор смены — окном поверх экрана.

   Главная отвечает на «как прошёл день» одним числом, а здесь лежит то, из
   чего оно сложилось: за какими участками смотрели, сколько времени раздел
   был открыт, чем день кончился по последнему взгляду и что за день
   произошло — по порядку, с временем каждой отметки.

   Окном, а не разделом: вопрос задают с Главной и возвращаются туда же.
   Отдельный экран для одного дня заставлял бы уходить и возвращаться, а
   сравнить две смены между собой всё равно можно только списком на
   Главной. */
export function ShiftWindow({ shift, onClose, onOpenRun, onWatch }: Props) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(shift !== null, card);

  useEffect(() => {
    if (!shift) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shift, onClose]);

  if (!shift) return null;

  const share = successOf(shift);
  const result = shift.result;
  /* Журнал показываем свежим сверху: вопрос к прошедшей смене — «чем
     кончилось», а не «с чего началось». */
  const events = [...shift.events].reverse();

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Разбор смены">
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card shiftwin" ref={card}>
        <div className="shiftwin__head">
          <div className="shiftwin__title">
            <h3>{whenLabel(shift.date)}</h3>
            <span className="shiftwin__date">{fullDate(shift.date)}</span>
            {wasWatched(shift) ? (
              <Badge tone="accent" dot>
                наблюдение {watchTime(shift.minutes)}
              </Badge>
            ) : (
              <Badge>в мониторинг не заходили</Badge>
            )}
          </div>
          <button type="button" className="shiftwin__close" onClick={onClose} title="Закрыть">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="shiftwin__body">
          <div className="dbstats">
            <div className="dbstat">
              <span className="dbstat__value">{share === null ? '—' : percent(share)}</span>
              <span className="dbstat__label">Заявок выполнено</span>
            </div>
            <div className="dbstat">
              <span className="dbstat__value">
                {result ? `${result.done} из ${result.orders}` : '—'}
              </span>
              <span className="dbstat__label">Закрыто за смену</span>
            </div>
            <div className="dbstat">
              <span className="dbstat__value">{result ? result.late : '—'}</span>
              <span className="dbstat__label">Опаздывали</span>
            </div>
            <div className="dbstat">
              <span className="dbstat__value">
                {result ? `${result.onShift} из ${result.engineers}` : '—'}
              </span>
              <span className="dbstat__label">Инженеров на смене</span>
            </div>
          </div>

          {/* Снимок сделан не на конец дня, а на последнюю минуту, когда
              живой вид был открыт: смена честно говорит, на какой момент
              сняты её числа. */}
          {result && (
            <p className="shiftwin__note">
              Числа сняты в {shift.seen}: инженерам назначено {percent(result.assigned)} заявок
              наблюдаемых дней, остальные остались без исполнителя. Наблюдение открыто в{' '}
              {shift.opened}.
            </p>
          )}

          <div className="shiftwin__part">
            <span className="shiftwin__part-title">Участки под наблюдением</span>
            {shift.places.length === 0 ? (
              <p className="shiftwin__empty">
                Живой вид в этот день не открывали — в журнале только то, что делали с расчётами.
              </p>
            ) : (
              <div className="shiftwin__chips">
                {shift.places.map((place) => (
                  <span key={place} className="homechip homechip--quiet">
                    {place}
                  </span>
                ))}
              </div>
            )}
          </div>

          {shift.runs.length > 0 && (
            <div className="shiftwin__part">
              <span className="shiftwin__part-title">Расчёты смены</span>
              <div className="shiftwin__chips">
                {shift.runs.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="homechip"
                    title={`Разобрать расчёт ${runCode(id) || id}`}
                    onClick={() => onOpenRun(id)}
                  >
                    <Icon name="stack" size={12} />
                    {runCode(id) || id}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="shiftwin__part">
            <span className="shiftwin__part-title">
              Что происходило
              {shift.events.length > 0 && (
                <span className="shiftwin__count">
                  {' '}
                  {shift.events.length}{' '}
                  {pluralWord(shift.events.length, 'событие', 'события', 'событий')}
                </span>
              )}
            </span>
            {events.length === 0 ? (
              <p className="shiftwin__empty">
                За эту смену ничего не отмечено: ни наблюдения, ни расчётов, ни событий.
              </p>
            ) : (
              <ol className="shiftlog">
                {events.map((event, index) => (
                  <li key={`${event.at}-${index}`} className="shiftlog__row">
                    <span className="shiftlog__at">{event.at}</span>
                    <span className={'shiftlog__icon shiftlog__icon--' + event.kind}>
                      <Icon name={EVENT_ICON[event.kind] ?? 'info'} size={12} />
                    </span>
                    <span className="shiftlog__text">{event.text}</span>
                    {event.run && (
                      <button
                        type="button"
                        className="homechip homechip--quiet"
                        title={`Разобрать расчёт ${runCode(event.run) || event.run}`}
                        onClick={() => onOpenRun(event.run as RunId)}
                      >
                        {runCode(event.run) || event.run}
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        {onWatch && (
          <button type="button" className="mapwin__go" onClick={onWatch}>
            <Icon name="arrow-right" size={14} />
            Смотреть этот день в мониторинге
          </button>
        )}
      </div>
    </div>
  );
}
