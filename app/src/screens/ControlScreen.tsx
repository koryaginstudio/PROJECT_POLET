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
  /** Расчёт, к плану которого применяют воздействие. */
  runCode: string;
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
  runCode,
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
          <span className="dash__section-note">
            план расчёта {runCode}, от {hhmm(cut)} до конца смены
          </span>
        </div>
        <p className="ctl__lede-first">
          День пошёл не так, как посчитали: отметьте, что случилось, и
          остаток смены пересобирается за полторы секунды.
        </p>
        {manual && live && <ManualEvent {...manual} />}
        {!live && (
          <p className="ctl__lede-first">
            Программа расчёта не запущена — отмечать и пересчитывать нечем.
          </p>
        )}
      </section>

      {day && live && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Сколько ещё людей нужно</h2>
            <span className="dash__section-note">по плану участка, считает программа расчёта</span>
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
              <div>
                <p className="ctl__staff-phrase">{staffing.phrase}</p>
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
                {staffing.reliability && <p className="ctl__text">{staffing.reliability}</p>}
                {staffing.still_unassigned.length > 0 && (
                  <>
                    <p className="ctl__text">Добавлением людей не закрыть:</p>
                    <ul className="ctl__list">
                      {staffing.still_unassigned.map((id) => (
                        <li key={id}>{orderLabel(id)}</li>
                      ))}
                    </ul>
                  </>
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

      {/* Готовность — внизу, одной строкой. Причины недоступности стоят
          над карточками, рядом с серыми кнопками, и здесь не повторяются.
          «Запущена» — только если движок ответил на последний запрос: флаг
          `live` помнит запуск, и после неудачного сброса или пересчёта
          строка спорила с ошибкой над ней. */}
      {!blocked && (
        <section className="panel">
          {engineSilent() ? (
            <div className="ctrlnote">
              <Icon name="alert-triangle" size={16} />
              <span>
                <b>Программа расчёта не ответила на последний запрос.</b> Проверьте, что она
                запущена, и выберите событие ещё раз.
              </span>
            </div>
          ) : (
            <div className="ctrlnote">
              <Icon name="lightning" size={16} />
              <span>
                <b>Программа расчёта запущена.</b> Выберите, что случилось: откроется окно правки,
                остаток дня пересоберётся от {hhmm(cut)}, и вы увидите цену. Принятый пересчёт
                откроется в диспетчерской — посмотреть до того, как сохранять.
              </span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
