import { useEffect, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { hhmm } from '../data/derive.ts';
import type { IncidentKind, Staffing } from '../data/api.ts';
import { loadStaffing, resetJournal } from '../data/api.ts';

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
    back: 'Две аварии дают +2,0 визита за день: влезают 1,9 из 2.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    key: 'disabled',
    icon: 'user',
    title: 'Инженер выбыл',
    what: 'Сегодня его не будет — заболел, отозвали, машина не поехала.',
    cost: 'Утром стоит дню 4,6 визита, днём — 2,5–2,9.',
    back: 'Пересчёт возвращает 3,2 из них утром и 1,8 днём.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    key: 'delayed',
    icon: 'clock',
    title: 'Инженер задержится',
    what: 'Прокол, пробка, затянувшийся визит — выйдет на маршрут позже.',
    cost: 'Стоит дню 0,2–0,3 визита — буферы съедают её сами.',
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

export function ControlScreen({
  runCode,
  cut,
  live,
  canReplan,
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

  useEffect(() => {
    setStaffing(null);
    setStaffingFailed(null);
    if (!day || !live) return;
    let alive = true;
    loadStaffing(day, base)
      .then((answer) => alive && setStaffing(answer))
      .catch((failure) => alive && setStaffingFailed(failure instanceof Error ? failure.message : 'не посчиталось'));
    return () => {
      alive = false;
    };
  }, [day, base, live]);

  const reset = async () => {
    if (!day || resetting) return;
    setResetting(true);
    try {
      await resetJournal(day, base);
      onJournalReset();
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Управление воздействием</h2>
          <span className="dash__section-note">
            план расчёта {runCode}, от {hhmm(cut)} до конца смены
          </span>
        </div>
        <p className="clients__lede">
          День пошёл не так, как посчитали. Здесь объявляют, что случилось, и движок пересобирает
          остаток смены за полторы секунды. Уже закрытые визиты не трогаются, а тем, кому уже
          сказали ехать, без нужды не меняют адрес.
        </p>
      </section>

      {/* Четыре события, а не одна кнопка «ЧП». Это не удобство, а вывод из
          замеров: жать пересчёт стоит в трёх случаях из четырёх, и диспетчер
          должен видеть, в каком он сейчас. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Что случилось</h2>
          <span className="dash__section-note">четыре разных события, не одно</span>
        </div>

        <div className="actgrid">
          {KINDS.map((kind) => (
            <button
              key={kind.key}
              type="button"
              className="actcard actcard--button"
              onClick={() => onPick(kind.key)}
              disabled={!canReplan}
              title={canReplan ? `Пересчитать остаток дня от ${hhmm(cut)}` : undefined}
            >
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
            </button>
          ))}
        </div>
      </section>

      {day && live && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Сколько ещё людей нужно</h2>
            <span className="dash__section-note">по плану участка, считает движок</span>
          </div>
          {staffing ? (
            <>
              <p className="clients__lede">{staffing.phrase}</p>
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
              {staffing.reliability && <p className="stub__body">{staffing.reliability}</p>}
              {staffing.still_unassigned.length > 0 && (
                <p className="stub__body">
                  Добавлением людей не закрыть: {staffing.still_unassigned.join(', ')}.
                </p>
              )}
            </>
          ) : staffingFailed ? (
            <p className="stub__body">Не посчиталось: {staffingFailed}</p>
          ) : (
            <p className="stub__body">Считаю — несколько пересчётов дня, до полуминуты…</p>
          )}
        </section>
      )}

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Чего это будет стоить</h2>
        </div>
        <p className="clients__lede">
          На каждое воздействие движок отвечает не только новым планом, но и его ценой. Это и есть
          то, ради чего сюда заходят: пересчитать можно всегда, а вот нужно ли — вопрос, на который
          до сих пор отвечали на глаз.
        </p>
        <div className="setrow">
          <span className="setrow__key">Визитов выиграли</span>
          <span className="setrow__val">
            сколько влезло после пересчёта против того, сколько влезло бы без него
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Кого не тронули</span>
          <span className="setrow__val">
            доля визитов, сохранивших исполнителя — по тем, кого событие не касалось
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Судьба визитов выбывшего</span>
          <span className="setrow__val">подхватили другие · остались за ним · не влезли никуда</span>
        </div>
      </section>

      {day && live && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">События дня</h2>
            <span className="dash__section-note">журнал диспетчера по этому участку</span>
          </div>
          <p className="clients__lede">
            Что вы сообщили — выполнено, сорвалось, отправлено, в пути, закреплено — движок помнит, и
            пересчёт от журнала идёт от этого. Сбросить — вернуть день к утреннему плану: прогнали
            сценарий, показали, начали заново.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={reset}
            disabled={resetting}
            iconLeft={<Icon name="trash" size={14} />}
          >
            {resetting ? 'Сбрасываю…' : 'Сбросить события дня'}
          </Button>
        </section>
      )}

      <section className="panel">
        <div className="ctrlnote">
          <Icon name={live ? 'lightning' : 'alert-triangle'} size={16} />
          <span>
            {live && canReplan ? (
              <>
                <b>Движок запущен.</b> Выберите, что случилось: откроется окно правки, движок
                пересоберёт остаток дня от {hhmm(cut)} и покажет цену. Принятый пересчёт откроется в
                диспетчерской — посмотреть до того, как сохранять.
              </>
            ) : live ? (
              <>
                <b>Этот расчёт пересчитать нельзя.</b> Он посчитан в браузере, а не движком, и дня у
                движка за ним нет. Откройте или заведите расчёт движка.
              </>
            ) : (
              <>
                <b>Движок не запущен.</b> Без него воздействие посчитать нечем — пересчёт это
                работа планировщика, а не заранее записанный файл.
              </>
            )}
          </span>
        </div>
      </section>
    </div>
  );
}
