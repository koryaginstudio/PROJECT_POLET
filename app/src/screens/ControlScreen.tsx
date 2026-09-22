import { useEffect, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { StatTile } from '../ds/components/data/StatTile.jsx';
import { hhmm, pluralWord } from '../data/derive.ts';
import type { IncidentKind, Staffing } from '../data/api.ts';
import { loadStaffing, resetJournal } from '../data/api.ts';
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
}

/* Управление воздействием — третий этап процесса.

   Планирование отвечает «что должно получиться», мониторинг — «что
   происходит». Здесь единственное место, где диспетчер не смотрит, а
   вмешивается: день пошёл не так, как посчитали, и надо решить, что делать.

   Ключевое решение экрана — событий четыре, а не одно. Соблазн сделать одну
   кнопку «ЧП» велик, но он неверен, и это замерено на зонах заказчика
   (`замеры-21-09/выбытие-на-зонах.txt`, `прокол-на-зонах.txt`): выбытие
   инженера утром стоит дню 4,6 визита, и пересчёт возвращает 3,2 — жать
   обязательно. Задержка на сорок минут стоит 0,2–0,3 визита, и пересчёт
   из неё не возвращает ничего — буферы съедают её сами. Система, которая перетасовывает бригаду из-за прокола
   колеса, хуже той, что не делает ничего: людям уже позвонили и сказали
   ехать.

   Поэтому экран обязан не просто уметь пересчитать, а сказать, стоит ли.
   Цена воздействия — разница между «пересчитали» и «поехали как ехали» — это
   то, ради чего сюда заходят, и она приходит числом в ответе движка.

   Карточка события — кнопка: она открывает окно правки на этом событии,
   движок пересобирает остаток дня, и окно показывает цену. Прежде экран
   только описывал: кнопку, которая ничего не делает, честно не ставили, а
   рабочий пересчёт жил в диспетчерской за «Внести правку». Шаги 5–6
   сценария ТЗ теперь начинаются здесь. */

interface Kind {
  key: IncidentKind;
  icon: string;
  title: string;
  what: string;
  /** Во что событие обходится дню, если ничего не делать. */
  cost: string;
  /** Что возвращает пересчёт. */
  back: string;
  /** Стоит ли жать. Замерено, а не придумано. */
  verdict: 'press' | 'skip';
  verdictText: string;
}

const KINDS: Kind[] = [
  {
    key: 'urgent',
    icon: 'alert-triangle',
    title: 'Авария',
    what: 'В середине дня приходят срочные заявки, которых не было в плане.',
    cost: 'Без пересчёта они просто не попадают в маршруты.',
    back: 'Две аварии дают +2,0 заявки за день: влезают 1,9 из 2.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    key: 'disabled',
    icon: 'user',
    title: 'Инженер выбыл',
    what: 'Сегодня его не будет — заболел, отозвали, машина не поехала.',
    cost: 'Утром стоит дню 4,6 заявки, днём — 2,5–2,9.',
    back: 'Пересчёт возвращает 3,2 из них утром и 1,8 днём.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    key: 'delayed',
    icon: 'clock',
    title: 'Инженер задержится',
    what: 'Прокол, пробка, затянулась прошлая заявка — выйдет на маршрут позже.',
    cost: 'Стоит дню 0,2–0,3 заявки — запас времени в маршрутах съедает её сам.',
    back: 'Пересчёт из неё ничего не возвращает: ноль в пределах шума.',
    verdict: 'skip',
    verdictText: 'Чаще не стоит'
  },
  {
    /* Третье событие пересчёта из ТЗ. Его здесь не было вовсе. */
    key: 'cancel',
    icon: 'x-circle',
    title: 'Абонент отказался',
    what: 'Заявку сняли — по звонку или уже на месте. Освободилось время.',
    cost: 'Ничего не стоит: работы стало меньше.',
    back: 'Пересчёт ставит в освободившееся время то, что не влезало.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  }
];

/* Пояснение для экрана: первая фраза видна, остальное — под «Подробнее».
   Длинные абзацы писались для жюри, а диспетчеру, который заходит сюда в
   середине дня, нужна одна строка «что здесь делают». Остальное не
   выбрасываем: оно по-прежнему отвечает на вопрос «почему так». */
function Lede({ text }: { text: string }) {
  const end = text.indexOf('. ');
  if (end < 0) return <p className="clients__lede ctl__lede-first">{text}</p>;
  return (
    <div className="ctl__lede">
      <p className="ctl__lede-first">{text.slice(0, end + 1)}</p>
      <details className="ctl__more">
        <summary>
          <Icon name="chevron-right" size={14} />
          Подробнее
        </summary>
        <p className="ctl__more-body">{text.slice(end + 2)}</p>
      </details>
    </div>
  );
}

/* Ошибка словами диспетчера: что случилось и что делать. Ответ программы
   расчёта — технический, он уходит под «Подробности». Свой маленький
   разборщик, как в окне правки: общего в интерфейсе пока нет. */
function Failure({ what, todo, detail }: { what: string; todo: string; detail: string }) {
  const tooLong = detail.toLowerCase().includes('не ответил за');
  const down = detail.toLowerCase().includes('не запущен') || detail.toLowerCase().includes('не отвечает');
  return (
    <div className="ctl__fail" role="alert">
      <Icon name="alert-triangle" size={16} />
      <span>
        <b>{what}</b>{' '}
        {down
          ? 'Программа расчёта не отвечает — проверьте, что она запущена, и попробуйте ещё раз.'
          : tooLong
            ? 'Расчёт идёт дольше обычного — подождите минуту и попробуйте ещё раз.'
            : todo}
        <details className="ctl__more">
          <summary>
            <Icon name="chevron-right" size={14} />
            Подробности
          </summary>
          <p className="ctl__fail-detail">{detail}</p>
        </details>
      </span>
    </div>
  );
}

const reason = (failure: unknown) =>
  failure instanceof Error ? failure.message : 'нет ответа';

export function ControlScreen({
  runCode,
  cut,
  live,
  canReplan,
  savedReplan = false,
  onPick,
  day,
  base,
  onJournalReset
}: Props) {
  /* «Сколько ещё людей нужно» — вопрос, который постановщик задал дважды и
     продиктовал формат ответа: «для того чтобы выполнить оставшиеся заявки,
     нужно ещё плюс N исполнителей». Считает движок — планировщиком, а не
     делением часов на смену, — и отвечает ещё и каких. */
  const [staffing, setStaffing] = useState<Staffing | null>(null);
  const [staffingFailed, setStaffingFailed] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  /* Сброс журнала необратим: всё, что диспетчер отметил за день, пропадёт.
     Поэтому — вопрос на месте, как «Удалить запись?» в правке записи. */
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetFailed, setResetFailed] = useState<string | null>(null);

  useEffect(() => {
    setStaffing(null);
    setStaffingFailed(null);
    if (!day || !live) return;
    let alive = true;
    loadStaffing(day, base)
      .then((answer) => alive && setStaffing(answer))
      .catch((failure) => alive && setStaffingFailed(reason(failure)));
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
      onJournalReset();
    } catch (failure) {
      /* Прежде ошибка сброса терялась: кнопка возвращалась в покой, и было
         непонятно, сбросилось или нет. */
      setResetFailed(reason(failure));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="dash enter ctl">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Управление воздействием</h2>
          <span className="dash__section-note">
            план расчёта {runCode}, от {hhmm(cut)} до конца смены
          </span>
        </div>
        <Lede
          text={
            'День пошёл не так, как посчитали — здесь объявляют, что случилось, и остаток смены ' +
            'пересобирается за полторы секунды. Уже закрытые заявки не трогаются, а тем, кому уже ' +
            'сказали ехать, без нужды не меняют адрес.'
          }
        />
      </section>

      {/* Четыре события, а не одна кнопка «ЧП». Это не удобство, а вывод из
          замеров: жать пересчёт стоит в трёх случаях из четырёх, и диспетчер
          должен видеть, в каком он сейчас. У каждой карточки — видимая
          строка-кнопка «Пересчитать от ЧЧ:ММ →»: прежде кнопкой была вся
          карточка, и догадаться, что на неё жмут, было не из чего. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Что случилось</h2>
          <span className="dash__section-note">четыре разных события, не одно</span>
        </div>

        <div className="actgrid">
          {KINDS.map((kind) => (
            <div key={kind.key} className="actcard">
              <span className="actcard__top">
                <span className="actcard__icon">
                  <Icon name={kind.icon} size={16} />
                </span>
                <span className="actcard__title">{kind.title}</span>
                <Badge tone={kind.verdict === 'press' ? 'danger' : 'neutral'}>
                  {kind.verdictText}
                </Badge>
              </span>
              <p className="actcard__what">{kind.what}</p>
              <span className="actcard__rows">
                <span className="actcard__row">
                  <span>Стоит дню</span>
                  <b>{kind.cost}</b>
                </span>
                <span className="actcard__row">
                  <span>Пересчёт вернёт</span>
                  <b>{kind.back}</b>
                </span>
              </span>
              <Button
                className="actcard__go"
                variant="secondary"
                onClick={() => onPick(kind.key)}
                disabled={!canReplan}
                iconRight={<Icon name="arrow-right" size={16} />}
              >
                Пересчитать от {hhmm(cut)}
              </Button>
            </div>
          ))}
        </div>
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
                  исполнителей». Кого именно — строками справа. */}
              <StatTile
                label="Нужно ещё"
                value={staffing.needed > 0 ? `+${staffing.needed}` : '0'}
                unit={
                  staffing.needed > 0
                    ? pluralWord(staffing.needed, 'человек', 'человека', 'человек')
                    : 'людей хватает'
                }
                caption={
                  staffing.unassigned_now > 0
                    ? `без исполнителя сейчас: ${staffing.unassigned_now}`
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
                  <p className="ctl__text">
                    Добавлением людей не закрыть: {staffing.still_unassigned.join(', ')}.
                  </p>
                )}
              </div>
            </div>
          ) : staffingFailed ? (
            <Failure
              what="Не получилось посчитать, сколько людей нужно."
              todo="Откройте экран ещё раз чуть позже; если повторится — сообщите администратору."
              detail={staffingFailed}
            />
          ) : (
            <p className="ctl__text">Считаю — несколько пересчётов дня, до полуминуты…</p>
          )}
        </section>
      )}

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Чего это будет стоить</h2>
        </div>
        <Lede
          text={
            'На каждое воздействие приходит не только новый план, но и его цена. Это и есть то, ' +
            'ради чего сюда заходят: пересчитать можно всегда, а вот нужно ли — вопрос, на который ' +
            'до сих пор отвечали на глаз.'
          }
        />
        <div className="setrow">
          <span className="setrow__key">Заявок выиграли</span>
          <span className="setrow__val">
            сколько влезло после пересчёта против того, сколько влезло бы без него
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Кого не тронули</span>
          <span className="setrow__val">
            доля заявок, сохранивших исполнителя — по тем, кого событие не касалось
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Судьба заявок выбывшего</span>
          <span className="setrow__val">подхватили другие · остались за ним · не влезли никуда</span>
        </div>
      </section>

      {day && live && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">События дня</h2>
            <span className="dash__section-note">журнал диспетчера по этому участку</span>
          </div>
          <Lede
            text={
              'Что вы сообщили — выполнено, сорвалось, отправлено, в пути, закреплено — ' +
              'запомнено, и пересчёт от событий дня идёт от этого. Сбросить — вернуть день к ' +
              'утреннему плану: проиграли сценарий, показали, начали заново.'
            }
          />
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
                setConfirmReset(true);
              }}
              iconLeft={<Icon name="trash" size={14} />}
            >
              Сбросить события дня
            </Button>
          )}
          {resetFailed && (
            <Failure
              what="События дня не сброшены — отметки остались как были."
              todo="Нажмите «Сбросить события дня» ещё раз; если повторится — сообщите администратору."
              detail={resetFailed}
            />
          )}
        </section>
      )}

      <section className="panel">
        <div className="ctrlnote">
          <Icon name={live && canReplan ? 'lightning' : 'alert-triangle'} size={16} />
          <span>
            {live && canReplan ? (
              <>
                <b>Программа расчёта запущена.</b> Выберите, что случилось: откроется окно правки,
                остаток дня пересоберётся от {hhmm(cut)}, и вы увидите цену. Принятый пересчёт
                откроется в диспетчерской — посмотреть до того, как сохранять.
              </>
            ) : live && savedReplan ? (
              <>
                <b>Это сохранённый пересчёт.</b> Пересчитывать можно от расчёта дня — откройте его.
              </>
            ) : live ? (
              <>
                <b>Этот расчёт пересчитать нельзя.</b> Он посчитан в браузере, и дня у программы
                расчёта за ним нет. Откройте или заведите расчёт у программы расчёта.
              </>
            ) : (
              <>
                <b>Программа расчёта не запущена.</b> Без неё воздействие посчитать нечем —
                пересчёт это работа планировщика, а не заранее записанный файл.
              </>
            )}
          </span>
        </div>
      </section>
    </div>
  );
}
