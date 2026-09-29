import { useEffect, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { StatTile } from '../ds/components/data/StatTile.jsx';
import { hhmm, pluralWord } from '../data/derive.ts';
import type { IncidentKind, Staffing } from '../data/api.ts';
import { engineSilent, loadStaffing, resetJournal } from '../data/api.ts';
import { humanAfter } from '../data/errors.ts';
import { replanBlocked } from '../app/replanBlocked.ts';
import { ManualEvent } from '../app/ManualEvent.tsx';
import type { ManualProps } from '../app/ManualEvent.tsx';
import '../styles/control.css';

interface Props {
  /** Сегодняшний мониторинг: номер записи и районы под наблюдением.
      `null` — рабочего процесса на сегодня нет, и вмешиваться не во что. */
  monitor: { code: string; places: string[] } | null;
  /** Уйти в мониторинг: единственная дорога отсюда, когда дня ещё нет. */
  onGoMonitor: () => void;
  /** Момент, от которого движок пересобирает остаток дня. */
  cut: number;
  /** Запущен ли движок: без него ни одно воздействие посчитать нельзя. */
  live: boolean;
  /** Можно ли пересчитать открытый расчёт: он посчитан движком и знает свой
      день. Расчёт, посчитанный в браузере, пересобирать нечем. */
  canReplan: boolean;
  /** Открыт сохранённый пересчёт (остаток дня): пересчитывать его нельзя,
      но совет другой, чем у браузерного расчёта, — открыть расчёт дня. */
  savedReplan?: boolean;
  /** Открыть окно правки на этом событии. */
  onPick: (kind: IncidentKind) => void;
  /** День у движка — для «сколько людей нужно» и сброса журнала. */
  day: string | null;
  /** Открытый расчёт дня — основа журнала и «сколько людей». */
  base?: string;
  /** Журнал сброшен: состояние дня на экране надо перечитать. */
  onJournalReset: () => void;
  /** Заявка словами диспетчера — адрес, а не код. Без открытого дня — код. */
  orderLabel?: (id: string) => string;
  /** С какой минуты аварию есть кому взять (`urgentFrom`, impact.ts): окно
      правки считает аварию не раньше неё, и кнопка карточки говорит то же. */
  urgentStart?: number | null;
  /** Ручное воздействие: кем и чем диспетчер распоряжается сам. Без него
      блок не рисуется — так же, как «События дня» без движка. */
  manual?: ManualProps;
}

/* Управление воздействием — третий этап процесса.

   Планирование отвечает «что должно получиться», мониторинг — «что
   происходит». Здесь единственное место, где диспетчер не смотрит, а
   вмешивается: день пошёл не так, как посчитали, и надо решить, что делать.

   Ключевое решение экрана — событий четыре, а не одно. Соблазн сделать одну
   кнопку «ЧП» велик, но он неверен, и это замерено на зонах заказчика:
   выбытие жать обязательно, задержку — чаще нет. Числа и вердикты — в
   `src/data/impact.ts`: их правят после пересъёмки замеров, не трогая
   экран.

   Поэтому экран обязан не просто уметь пересчитать, а сказать, стоит ли.
   Цена воздействия — разница между «пересчитали» и «поехали как ехали» — это
   то, ради чего сюда заходят, и она приходит числом в ответе движка.

   У каждой карточки события — видимая строка-кнопка «Пересчитать от
   ЧЧ:ММ →»: она открывает окно правки на этом событии, движок пересобирает
   остаток дня, и окно показывает цену. Прежде экран только описывал:
   кнопку, которая ничего не делает, честно не ставили, а рабочий пересчёт
   жил в диспетчерской за «Внести правку». Шаги 5–6 сценария ТЗ теперь
   начинаются здесь. Если пересчитать нельзя, причина стоит над карточками,
   а не в конце экрана: серые кнопки без объяснения рядом — загадка. */




/* Ошибка словами диспетчера: что случилось — своё, жирным; что делать —
   общим разбором (`humanAfter`, errors.ts): по виду сбоя и коду ответа, а не
   по тексту сообщения, как было здесь прежде. Ответ программы расчёта —
   технический, он уходит под «Подробности». */
type Failed = { text: string; detail: string };

function Failure({ what, failed }: { what: string; failed: Failed }) {
  return (
    <div className="ctl__fail" role="alert">
      <Icon name="alert-triangle" size={16} />
      <span>
        <b>{what}</b> {failed.text}
        {failed.detail && (
          <details className="ctl__more">
            <summary>
              <Icon name="chevron-right" size={14} />
              Подробности
            </summary>
            <p className="ctl__fail-detail">{failed.detail}</p>
          </details>
        )}
      </span>
    </div>
  );
}

export function ControlScreen({
  monitor,
  onGoMonitor,
  cut,
  live,
  canReplan,
  savedReplan = false,
  day,
  base,
  onJournalReset,
  orderLabel = (id) => id,
  manual
}: Props) {
  /* Почему пересчёт сейчас недоступен — одной причиной, общей с окном
     правки. Стоит в шапке, рядом с готовностью программы: это одно и то
     же сообщение — сработает ли то, что диспетчер сейчас нажмёт. */
  const blocked = replanBlocked(live, savedReplan, canReplan);
  /* «Сколько ещё людей нужно» — вопрос, который постановщик задал дважды и
     продиктовал формат ответа: «для того чтобы выполнить оставшиеся заявки,
     нужно ещё плюс N исполнителей». Считает движок — планировщиком, а не
     делением часов на смену, — и отвечает ещё и каких. */
  const [staffing, setStaffing] = useState<Staffing | null>(null);
  const [staffingFailed, setStaffingFailed] = useState<Failed | null>(null);
  const [resetting, setResetting] = useState(false);
  /* Сброс журнала необратим: всё, что диспетчер отметил за день, пропадёт.
     Поэтому — вопрос на месте, как «Удалить запись?» в правке записи. */
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetFailed, setResetFailed] = useState<Failed | null>(null);
  /* Сброс удался — сказать об этом. Прежде после «Да, сбросить» вопрос
     просто пропадал, и было не понять, стёрлось ли. */
  const [resetDone, setResetDone] = useState(false);

  useEffect(() => {
    setStaffing(null);
    setStaffingFailed(null);
    if (!day || !live) return;
    let alive = true;
    loadStaffing(day, base)
      .then((answer) => alive && setStaffing(answer))
      .catch(
        (failure) =>
          alive &&
          setStaffingFailed(
            humanAfter(
              failure,
              'Откройте экран ещё раз чуть позже; если повторится — сообщите администратору.'
            )
          )
      );
    return () => {
      alive = false;
    };
  }, [day, base, live]);

  const reset = async () => {
    if (!day || resetting) return;
    setResetting(true);
    setResetFailed(null);
    try {
      await resetJournal(day, base);
      setConfirmReset(false);
      setResetDone(true);
      onJournalReset();
    } catch (failure) {
      /* Прежде ошибка сброса терялась: кнопка возвращалась в покой, и было
         непонятно, сбросилось или нет. */
      setResetFailed(
        humanAfter(
          failure,
          'Нажмите «Сбросить события дня» ещё раз; если повторится — сообщите администратору.'
        )
      );
    } finally {
      setResetting(false);
    }
  };

  /* Рабочего процесса на сегодня нет — и это весь экран.

     Воздействие вмешивается в день, который идёт: диспетчер смотрит за
     районами, ему звонят, он отмечает. Без открытого мониторинга
     вмешиваться не во что, и показывать выбор событий — обещать работу,
     которой нет: отметка легла бы в журнал участка, за которым сегодня
     никто не смотрит. Прежде экран этого не различал и звал пересчитать
     последний расчёт из архива, подписываясь «план расчёта R009, от 07:00
     до конца смены» — числами, которые к сегодняшнему дню отношения не
     имеют. */
  if (!monitor) {
    return (
      <div className="dash enter ctl">
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Управление воздействием</h2>
          </div>
          <div className="emptynote">
            <p className="emptynote__title">Нет рабочего процесса на сегодня</p>
            <span>
              Отмечать нечего: мониторинг сегодня не открывали. Отметьте районы, возьмите их
              в работу — и всё, что за день случится, отмечается здесь.
            </span>
            <button type="button" className="runcard__go" onClick={onGoMonitor}>
              <Icon name="navigation-arrow" size={13} />
              Открыть мониторинг
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="dash enter ctl">
      {/* Одна панель, а не две. Прежде «Управление воздействием» было
          заголовком с одной фразой и без содержимого, а под ним отдельной
          панелью стоял выбор события — два заголовка про одно и то же
          место. Объяснение тоже одной строкой: раскрывать «Подробнее»
          ради второй фразы незачем, она короче самой кнопки. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Управление воздействием</h2>
          {/* Подпись называет рабочий процесс дня, а не открытый расчёт:
              отметка ложится в сегодняшний мониторинг и в его журнал. */}
          <span className="dash__section-note">
            мониторинг {monitor.code}
            {monitor.places.length > 0 && ` · ${monitor.places.join(', ')}`}
          </span>
        </div>

        {/* Готовность программы расчёта — сразу под заголовком, до выбора
            события: она говорит, сработает ли вообще то, что диспетчер
            сейчас нажмёт. Внизу экрана, где строка стояла прежде, её не
            читали — до неё доходили уже после того, как нажали. */}
        {engineSilent() ? (
          <div className="ctrlnote">
            <Icon name="alert-triangle" size={16} />
            <span>
              <b>Программа расчёта не ответила на последний запрос.</b> Проверьте, что она
              запущена, и отметьте событие ещё раз.
            </span>
          </div>
        ) : blocked ? (
          <div className="ctrlnote">
            <Icon name="alert-triangle" size={16} />
            <span>
              <b>{blocked.what}</b> {blocked.todo}
            </span>
          </div>
        ) : (
          <div className="ctrlnote">
            <Icon name="lightning" size={16} />
            <span>
              <b>Программа расчёта запущена.</b> Отметьте, что случилось, — остаток дня
              пересобирается от {hhmm(cut)} за полторы секунды.
            </span>
          </div>
        )}

        {manual && live && <ManualEvent {...manual} />}
      </section>

      {day && live && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Сколько ещё людей нужно</h2>
          </div>
          {staffing ? (
            <div className="ctl__staff">
              {/* Главное число — крупно, как просил постановщик: «+N
                  исполнителей». Кого именно — строками под ним. Подпись
                  выбирается по данным: ноль при заявках без исполнителя —
                  не «хватает», а «людьми не закрыть» (контракт, staffing). */}
              <StatTile
                className="ctl__staff-tile"
                label="Нужно ещё"
                value={staffing.needed > 0 ? `+${staffing.needed}` : '0'}
                unit={
                  staffing.unassigned_now === 0
                    ? 'никого не нужно'
                    : staffing.needed > 0
                      ? pluralWord(staffing.needed, 'человек', 'человека', 'человек')
                      : 'людьми не закрыть'
                }
                caption={
                  staffing.unassigned_now > 0
                    ? `без исполнителя сейчас: ${staffing.unassigned_now}` +
                      (!staffing.closes_all && staffing.needed > 0 ? ' · не наверняка' : '')
                    : undefined
                }
              />
              {/* Ответ разложен на части с именами, а не высыпан подряд.
                  Прежде в одну колонку шли фраза движка, строки слотов,
                  оговорка о надёжности и список незакрываемых заявок — всё
                  одинаковым текстом, и понять, где кончается «кого взять» и
                  начинается «чего всё равно не закрыть», можно было только
                  вчитавшись. Вопросов здесь три, и у каждого свой заголовок. */}
              <div className="ctl__staff-body">
                <p className="ctl__staff-phrase">{staffing.phrase}</p>

                {staffing.slots.length > 0 && (
                  <div className="ctl__staff-part">
                    <span className="ctl__staff-head">Кого добавить</span>
                    <div className="ctl__slots">
                      {staffing.slots.map((slot, index) => (
                        <div className="setrow" key={index}>
                          <span className="setrow__key">+{slot.count}</span>
                          <span className="setrow__val">
                            {slot.skills_title}
                            <span className="setrow__note">
                              {` · ${slot.transport_title.toLowerCase()} · ${hhmm(slot.shift_start)}–${hhmm(slot.shift_end)}`}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                    {staffing.reliability && (
                      <p className="ctl__staff-note">{staffing.reliability}</p>
                    )}
                  </div>
                )}

                {staffing.still_unassigned.length > 0 && (
                  <div className="ctl__staff-part">
                    <span className="ctl__staff-head">Людьми не закрыть</span>
                    <ul className="ctl__list">
                      {staffing.still_unassigned.map((id) => (
                        <li key={id}>{orderLabel(id)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          ) : staffingFailed ? (
            <Failure what="Не получилось посчитать, сколько людей нужно." failed={staffingFailed} />
          ) : (
            <p className="ctl__text">Считаю — несколько пересчётов дня, до полуминуты…</p>
          )}
        </section>
      )}


      {day && live && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">События дня</h2>
            <span className="dash__section-note">журнал диспетчера по этому участку</span>
          </div>
          {/* Прежде здесь объяснялось, чем отличается пересчёт от журнала
              и пересчёт от прогноза дня: на экране стояли четыре карточки,
              считавшие от прогноза. Карточек больше нет, объяснять нечего —
              осталось то, ради чего секция и есть: сброс. */}
          <p className="ctl__lede-first">
            Ваши отметки хранятся в журнале участка. Сбросить — вернуть день к
            утреннему плану: проиграли сценарий, показали, начали заново.
          </p>
          {confirmReset ? (
            <div className="ctl__ask">
              <span className="ctl__ask-text">
                Стереть все отметки за день и вернуться к утреннему плану? Отменить это нельзя.
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={reset}
                disabled={resetting}
                iconLeft={<Icon name="trash" size={14} />}
              >
                {resetting ? 'Сбрасываю…' : 'Да, сбросить'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmReset(false)}
                disabled={resetting}
              >
                Нет
              </Button>
            </div>
          ) : (
            /* Кнопка в своей строке, а не вплотную к абзацу: она стояла
               прижатой к тексту и налезала на него верхним краем. */
            <div className="ctl__reset">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setResetFailed(null);
                  setResetDone(false);
                  setConfirmReset(true);
                }}
                iconLeft={<Icon name="trash" size={14} />}
              >
                Сбросить события дня
              </Button>
            </div>
          )}
          {resetDone && !confirmReset && (
            <div className="ctrlnote">
              <Icon name="check-circle" size={16} />
              <span>События дня сброшены: день вернулся к утреннему плану.</span>
            </div>
          )}
          {resetFailed && (
            <Failure what="События дня не сброшены — отметки остались как были." failed={resetFailed} />
          )}
        </section>
      )}

    </div>
  );
}
