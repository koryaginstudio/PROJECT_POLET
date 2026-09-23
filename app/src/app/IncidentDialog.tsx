import { useEffect, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { DayView } from '../data/derive.ts';
import { dec, hhmm, orders as ordersWord, pluralWord } from '../data/derive.ts';
import type { IncidentKind, IncidentSpec, ReplanResult } from '../data/api.ts';
import { loadEngineSettings } from '../data/api.ts';
import { CHURN_PRESETS, ENGINE_DEFAULTS } from '../data/engine.ts';
import { IMPACT, urgentFrom } from '../data/impact.ts';
import type { Order } from '../data/contract.ts';
import { useModalFocus } from './modal.ts';
import { pinnedRest } from './pinnedReason.ts';
import { replanBlocked } from './replanBlocked.ts';
import '../styles/control.css';

interface Props {
  open: boolean;
  view: DayView;
  runCode: string;
  /** День у движка. Без него пересчитывать нечего: расчёт, посчитанный
      здесь, в браузере, дня у движка за собой не имеет. */
  day: string | null;
  /** Запущен ли движок. Пересчёт по событию делает он, и без него окно
      честно говорит, что кнопка не сработает. */
  live: boolean;
  /** Открыт сохранённый пересчёт — план остатка дня. Дня у него за собой
      нет по другой причине, чем у браузерного расчёта, и сказать это надо
      по-другому: не «заведите расчёт», а «откройте расчёт дня». */
  savedReplan?: boolean;
  /** Момент, с которого пересобирается остаток. */
  cut: number;
  busy: boolean;
  failed: string | null;
  /** Что вернул пересчёт. Пока пусто — окно показывает форму события. */
  result: ReplanResult | null;
  onClose: () => void;
  onRun: (spec: IncidentSpec) => void;
  /** Оставить пересчёт: он станет несохранённым состоянием на экране. */
  onKeep: () => void;
  /** Каким событием открыть окно. Экран «Воздействия» открывает его уже
      на выбранном событии: диспетчер нажал «Инженер выбыл» — окно про
      выбытие, а не про то, что было выбрано в прошлый раз. */
  initialKind?: IncidentKind;
}

/* Внести правку: день пошёл не так, как посчитали.

   Событий четыре, и это не удобство, а вывод из замеров на зонах: выбытие
   жать обязательно, задержку — чаще нет. Числа и вердикты — в
   `src/data/impact.ts`, одни на это окно и на экран «Воздействия».

   Поэтому у каждого события стоит вердикт, а после пересчёта показывается
   его настоящая цена: сколько визитов выиграли против «поехали как ехали»,
   скольких не тронули, и куда делись визиты выбывшего. Кнопка «пересчитать»
   есть всегда, но решение принимается по этим числам, а не по тому, что она
   доступна.

   Окно живёт в двух состояниях: до пересчёта — выбор события, после —
   его разбор. Разводить это на два окна незачем: вопрос один и тот же,
   просто на него уже ответили. */

const KINDS: {
  value: IncidentKind;
  icon: string;
  title: string;
  what: string;
}[] = [
  {
    value: 'urgent',
    icon: 'alert-triangle',
    title: 'Авария',
    what: 'Пришли срочные заявки, которых не было в плане. Можно указать, на чьём участке.'
  },
  {
    value: 'disabled',
    icon: 'user',
    title: 'Инженер выбыл',
    what: 'Сегодня его не будет: заболел, отозвали, машина не поехала.'
  },
  {
    value: 'delayed',
    icon: 'clock',
    title: 'Инженер задержится',
    what: 'Прокол, пробка, затянулась прошлая заявка — выйдет на маршрут позже.'
  },
  {
    /* Третье событие пересчёта из ТЗ. Тип в вёрстке был, а кнопки не было:
       отмена не попадала в запрос вовсе. */
    value: 'cancel',
    icon: 'x-circle',
    title: 'Абонент отказался',
    what: 'Заявку сняли: освободилось время, и в него может влезть то, что не влезало.'
  }
];

const DELAYS = [20, 30, 40, 60, 90, 120];

/* Ошибка пересчёта словами диспетчера: что случилось и что делать. Текст
   ответа программы расчёта — технический, он нужен тому, кто будет
   разбираться, и уходит под «Подробности». Общего разборщика ошибок в
   интерфейсе пока нет, поэтому здесь свой, маленький: различает только
   три случая, которые меняют совет. */
function explainFailure(message: string): { what: string; todo: string } {
  const text = message.toLowerCase();
  if (text.includes('не ответил за')) {
    return {
      what: 'Расчёт идёт дольше обычного и не успел закончиться.',
      todo: 'Подождите минуту и нажмите «Пересчитать» ещё раз. Если повторится — сообщите администратору.'
    };
  }
  if (text.includes('не запущен') || text.includes('не отвечает')) {
    return {
      what: 'Программа расчёта не отвечает.',
      todo: 'Проверьте, что она запущена, и нажмите «Пересчитать» ещё раз.'
    };
  }
  return {
    what: 'Пересчёт не получился.',
    todo: 'Проверьте время события и исполнителя и нажмите «Пересчитать» ещё раз. Если повторится — передайте администратору текст из «Подробностей».'
  };
}

export function IncidentDialog({
  open,
  view,
  runCode,
  day,
  live,
  savedReplan = false,
  cut,
  busy,
  failed,
  result,
  onClose,
  onRun,
  onKeep,
  initialKind
}: Props) {
  const [kind, setKind] = useState<IncidentKind>('disabled');
  /* Какую заявку сняли. Пусто — `auto`: движок снимет ту, отказ от которой
     освободит больше всего времени. */
  const [orderId, setOrderId] = useState('');
  /* Штраф за смену исполнителя — живой контрол окна правки. Прежде это был
     голый ползунок 0–200: число без смысла для диспетчера. Теперь — те же
     три готовых варианта, что в правилах расчёта (`CHURN_PRESETS`), а по
     умолчанию выбран тот, что совпадает с настройкой компании у программы
     расчёта. `companyChurn` — эта настройка, `null`, пока не прочитали;
     `pickedChurn` — выбор диспетчера в этом окне, `null` — не трогал.
     Настройка не прочиталась — горит «Сбалансированно», умолчание самой
     программы, и штраф уходит в запрос явно: группа, где ничего не
     выбрано, не говорит, с чем будут считать. */
  const [companyChurn, setCompanyChurn] = useState<number | null>(null);
  const [churnUnknown, setChurnUnknown] = useState(false);
  const [pickedChurn, setPickedChurn] = useState<number | null>(null);
  const [engineerId, setEngineerId] = useState('');
  /* У кого на участке авария. Пусто — «по городу»: так считалось раньше,
     и как ответ на вопрос «а вообще?» это по-прежнему законно. */
  const [nearId, setNearId] = useState('');
  const [minutes, setMinutes] = useState(40);
  const [urgent, setUrgent] = useState(2);
  /* Время, вписанное руками в «Когда случилось». Пусто — время по умолчанию
     (ниже, `at`). */
  const [typedAt, setTypedAt] = useState<number | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(open, card);

  /* Момент открытия окна — момент, на котором стоит доска. Диспетчер
     подвинул ползунок к 13:40 и жмёт «внести правку»: пересчитывать надо
     оттуда, а не с начала смены. Вписанное в прошлый раз забывается. */
  useEffect(() => {
    if (open) setTypedAt(null);
  }, [open, cut]);

  /* Выбор живёт до закрытия окна: следующий пересчёт снова начинается с
     настройки компании и «самого загруженного», а не с того, что выбирали в
     прошлый раз. Прежде инженер оставался от прошлого открытия, и если у
     него уже не было работы, список показывал одно, а уходило другое. */
  useEffect(() => {
    if (!open) return;
    setPickedChurn(null);
    setEngineerId('');
    setNearId('');
    setOrderId('');
  }, [open]);

  useEffect(() => {
    if (open && initialKind) setKind(initialKind);
  }, [open, initialKind]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    loadEngineSettings()
      .then(({ settings }) => {
        if (!alive) return;
        const setting = settings.churn_penalty;
        setCompanyChurn(setting ? setting.value : null);
        setChurnUnknown(!setting);
      })
      .catch(() => {
        if (alive) setChurnUnknown(true);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  /* Время события. По умолчанию — момент доски, а у аварии не раньше, чем
     её есть кому взять: самое раннее начало смены у тех, кто умеет аварии
     (`urgentFrom`). Иначе авария в 07:00 давала «0 из 2» без объяснения —
     на востоке и югоцентре аварийщики выходят в 10:00. Вписанное руками
     побеждает: раньше этого времени тоже можно, но тогда ниже сказано,
     почему авария может не встать. */
  const urgentStart = urgentFrom(view.engineerById.values());
  const suggested =
    kind === 'urgent' && urgentStart !== null ? Math.max(cut, urgentStart) : cut;
  const at = typedAt ?? suggested;
  const urgentEarly = kind === 'urgent' && urgentStart !== null && at < urgentStart;

  /* Выбыть или задержаться может только тот, у кого после момента правки
     ещё есть работа. Не выбран никто — «самый загруженный сейчас», `auto`:
     движок сам возьмёт того, у кого впереди больше всего. Это и умолчание:
     диспетчер, которому некогда листать список, получает самый тяжёлый
     случай, а не первого по алфавиту.

     Выбранный берётся, только если он ещё в списке: время «Когда
     случилось» сдвинули — у него может не остаться работы, и тогда честнее
     вернуться к «самому загруженному», чем молча считать по невидимому. */
  const crew = view.loads.filter(
    (load) => load.route && load.route.stops.some((stop) => stop.start >= at)
  );
  const inCrew = (id: string) => crew.some((load) => load.engineer.id === id);
  const chosen = engineerId && inCrew(engineerId) ? engineerId : 'auto';
  const near = nearId && inCrew(nearId) ? nearId : '';
  const needsEngineer = kind === 'disabled' || kind === 'delayed';

  /* Почему нельзя пересчитать. Без дня кнопка недоступна всегда — чужой
     день под видом нашего не подставляется. */
  const blocked = replanBlocked(live, savedReplan, day !== null);
  const ready = blocked === null;

  /* Штраф, с которым пойдёт пересчёт, и вариант, который горит. Настройка
     компании может не совпасть ни с одним из трёх — тогда горит четвёртая
     карточка «Как в правилах». Не прочиталась — умолчание программы. */
  const churn = pickedChurn ?? companyChurn ?? ENGINE_DEFAULTS.churn_penalty;

  /* Что ещё можно снять: визиты, к которым по плану не выехали до момента
     правки. Начатое и сделанное отменять нечего, а к визиту, куда инженер
     уже едет, движок его и доигрывает («в пути») и на отмену отвечает 400. */
  const cancellable = view.loads
    .flatMap((load) => (load.route ? load.route.stops : []))
    .filter((stop) => stop.arrive - stop.travel_minutes >= at)
    .sort((a, b) => a.start - b.start);
  /* Та же защита, что у инженера: после сдвига времени выбранная заявка
     могла уже начаться, и снимать её нечего. */
  const cancelId = orderId && cancellable.some((stop) => stop.order_id === orderId) ? orderId : '';

  const spec: IncidentSpec = {
    /* Пустая строка, а не синтетический день 1: `ready` всё равно не даст
       отправить без дня, а подстановка чужого дня — это молчаливый чужой
       расчёт под видом нашего. */
    day: day ?? '',
    at,
    kind,
    urgent,
    urgentNear: kind === 'urgent' && near ? near : undefined,
    engineerId: needsEngineer ? chosen : undefined,
    minutes,
    orderId: kind === 'cancel' && cancelId ? cancelId : undefined,
    churnPenalty: churn
  };

  /* Имена и адреса вместо кодов. Заявку ищем сначала в открытом дне, потом в
     ответе пересчёта: аварий, пришедших пересчётом, в открытом дне нет, а
     адрес у них приходит в ответе. Нет адреса (синтетическая сеть) —
     вид работ и номер: хоть что-то, что можно сказать по телефону. */
  const resultOrders = new Map<string, Order>((result?.orders ?? []).map((o) => [o.id, o]));
  const orderLabel = (id: string) => {
    const order = view.orderById.get(id) ?? resultOrders.get(id);
    if (!order) return id;
    return order.address ?? `${order.work_title}, ${order.id}`;
  };
  const engineerName = (id: string) =>
    view.engineerById.get(id)?.name ??
    result?.engineers.find((engineer) => engineer.id === id)?.name ??
    id;
  /* Кто после пересчёта едет на заявку — для аварий и для подхваченных. */
  const takenBy = new Map<string, string>();
  for (const route of result?.routes ?? []) {
    for (const stop of route.stops) takenBy.set(stop.order_id, route.engineer_id);
  }
  const withWho = (id: string) => {
    const who = takenBy.get(id);
    return who ? engineerName(who) : null;
  };

  const replan = result?.meta.replan;
  const gain = replan ? replan.assigned_now - replan.assigned_as_is : 0;
  /* Закреплённые диспетчером заявки и встали ли они. Прежде после
     «Закрепить и пересчитать» окно молчало о самой закреплённой заявке, а
     движок мог её и не поставить: «в его смене для неё не нашлось места». */
  const pinnedOrders = (result?.orders ?? []).filter((order) => order.locked_to);
  /* Разбор события: у ЧП с инженером — судьба его визитов, у отмены — что
     купила освободившаяся ёмкость. Формы разные, поэтому и ветки две. */
  const fates = replan?.incident && replan.incident.kind !== 'cancelled' ? replan.incident : null;
  const cancelled = replan?.incident && replan.incident.kind === 'cancelled' ? replan.incident : null;
  /* Заявки, которых «как ехали» не везёт, а пересчёт поставил: у отмены —
     вставшие в освободившееся время, у ЧП с инженером — его заявки,
     подхваченные другими. */
  const newcomers = cancelled ? cancelled.picked_up_count : fates ? fates.rescued.length : 0;
  const newcomersText = cancelled
    ? `в освободившееся время ${pluralWord(newcomers, 'встала', 'встали', 'встали')} ${ordersWord(newcomers)}`
    : `другие подхватили ${ordersWord(newcomers)} ${fates?.kind === 'disabled' ? 'выбывшего' : 'задержавшегося'}`;

  /* Чей участок накрыло — на экране именем, а не кодом: код инженера
     диспетчер держать в голове не обязан. */
  const nearName = replan?.urgent_near
    ? view.loads.find((load) => load.engineer.id === replan.urgent_near)?.engineer.name ??
      replan.urgent_near
    : null;

  /* Список имён или адресов под заголовком. Пустой не рисуется. */
  const names = (title: string, items: string[]) =>
    items.length > 0 && (
      <div className="incident__names">
        <p className="incident__names-title">{title}</p>
        <ul>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      </div>
    );

  const failure = failed ? explainFailure(failed) : null;
  /* Своё число в правилах, не совпадающее ни с одним вариантом, — отдельной
     карточкой: иначе, нажав вариант, к нему не вернуться, не закрыв окно. */
  const companyOwn =
    companyChurn !== null && !CHURN_PRESETS.some((p) => p.penalty === companyChurn)
      ? companyChurn
      : null;
  const usedPreset =
    replan?.churn_penalty !== undefined
      ? CHURN_PRESETS.find((p) => p.penalty === replan.churn_penalty)
      : undefined;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Внести правку">
      <button
        type="button"
        className="modal__veil"
        onClick={() => !busy && onClose()}
        aria-label="Закрыть"
      />

      <div className="modal__card incident__card" ref={card}>
        <div className="modal__head">
          <h3 className="engine__title">
            {result ? 'Что дал пересчёт' : 'Внести правку'} · {runCode}
          </h3>
          {!busy && (
            <span className="modal__esc">
              <kbd>Esc</kbd> — закрыть
            </span>
          )}
          <button
            type="button"
            className="rpanel__x"
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {result && replan ? (
          <>
            <p className="engine__lede">
              Остаток дня пересобран от {hhmm(replan.at)} за {dec(replan.solve_seconds)} с. Ниже —
              чего это стоило.{' '}
              {replan.adopt_token
                ? 'Это пересчёт от событий дня: журнал не тронут, пока вы не нажмёте «Принять», — тогда он станет назначением дня. «Сохранить» потом положит его в архив.'
                : 'Считали от прогноза дня, а не от ваших отметок в журнале. Пересчёт пока нигде не сохранён: он живёт на экране, пока вы не нажмёте «Сохранить».'}
            </p>

            {/* Цена воздействия. Первое число — то, ради чего сюда и
                заходят: пересчёт всегда можно сделать, вопрос был в том,
                нужно ли. */}
            <div className="incident__gain">
              <span className={'incident__gain-value' + (gain > 0 ? '' : ' incident__gain-value--flat')}>
                {gain > 0 ? `+${gain}` : gain < 0 ? `−${-gain}` : gain}
              </span>
              <span className="incident__gain-label">
                {gain > 0 ? (
                  <>
                    {pluralWord(gain, 'заявку', 'заявки', 'заявок')} выиграли пересчётом:{' '}
                    {replan.assigned_now} против {replan.assigned_as_is}, если бы поехали как ехали
                  </>
                ) : replan.urgent_assigned > 0 ? (
                  /* Ноль здесь не значит «запас справился сам». «Как ехали»
                     аварий не везёт вовсе: если они встали, а заявок не
                     прибавилось, место им освободили, сняв заявки попроще. */
                  <>
                    {gain === 0
                      ? `всего заявок столько же — ${replan.assigned_now}`
                      : `всего на ${-gain} ${pluralWord(-gain, 'заявку', 'заявки', 'заявок')} меньше: ${replan.assigned_now} против ${replan.assigned_as_is}`}
                    , но {replan.urgent_assigned}{' '}
                    {pluralWord(replan.urgent_assigned, 'авария встала', 'аварии встали', 'аварий встали')} в
                    план: ради {replan.urgent_assigned === 1 ? 'неё' : 'них'} пересчёт снял заявки
                    попроще — авария важнее
                  </>
                ) : gain < 0 ? (
                  <>
                    после пересчёта на {-gain} {pluralWord(-gain, 'заявку', 'заявки', 'заявок')} меньше,
                    чем если бы поехали как ехали: {replan.assigned_now} против {replan.assigned_as_is}
                  </>
                ) : replan.urgent_ids.length > 0 ? (
                  /* Утром так и выходит: авария живёт три часа от прихода, а
                     смены тех, кто умеет аварии, начинаются позже. Если
                     причина в этом — она названа; иначе только факт. */
                  <>
                    пересчёт ничего не добавил: {ordersWord(replan.assigned_now)} и так, и так.
                    Ни одна авария в план не встала
                    {urgentStart !== null && replan.at < urgentStart
                      ? `: в ${hhmm(replan.at)} на смене нет никого, кто умеет аварии, ближайший — с ${hhmm(urgentStart)}`
                      : ''}
                  </>
                ) : newcomers > 0 ? (
                  /* Ноль при вставших новых — не «ничего не изменилось»: новые
                     встали, и ровно столько же прежних выпало. Иначе рядом
                     стояли «ничего не добавил» и «влезло взамен: 1». */
                  <>
                    всего заявок столько же — {replan.assigned_now}: {newcomersText}, но столько же
                    прежних выпало
                  </>
                ) : (
                  /* «Запас справился сам» — только про задержку. У выбытия
                     ноль значит, что его заявки никто не подхватил, у отмены —
                     что в освободившееся время ничего не влезло. */
                  <>
                    пересчёт ничего не добавил: {ordersWord(replan.assigned_now)} и так, и так
                    {fates?.kind === 'delayed' && '. Запас времени в маршрутах справился сам'}
                  </>
                )}
              </span>
            </div>

            <div className="setrow">
              <span className="setrow__key">Кого не тронули</span>
              <span className="setrow__val">
                {Math.round((replan.incident?.stability_others ?? replan.stability) * 100)}%
                <span className="setrow__note">
                  {replan.incident
                    ? ' заявок сохранили исполнителя — по тем, кого событие не касалось'
                    : ' заявок сохранили исполнителя'}
                </span>
              </span>
            </div>

            {names(
              'Закрепил диспетчер',
              pinnedOrders.map((order) => {
                const who = engineerName(order.locked_to!);
                if (takenBy.get(order.id) === order.locked_to) return `${orderLabel(order.id)} — едет ${who}`;
                const why = order.unassigned_reason ? pinnedRest(order.unassigned_reason.text) : null;
                return `${orderLabel(order.id)} — ${who}, не встала${why ? `: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : ''}`;
              })
            )}

            {replan.urgent_ids.length > 0 && (
              <>
                <div className="setrow">
                  <span className="setrow__key">Аварии</span>
                  <span className="setrow__val">
                    {replan.urgent_assigned} из {replan.urgent_ids.length} влезли в план
                    <span className="setrow__note">
                      {nearName
                        ? ` · на участке, где в ${hhmm(replan.at)} работал ${nearName};` +
                          ' кто поедет — решил пересчёт'
                        : ' · пришли по городу, без привязки к участку'}
                    </span>
                  </span>
                </div>
                {/* Адрес аварии — из ответа пересчёта: в открытом дне её
                    не было. Кто едет — тоже из ответа. */}
                {names(
                  'Куда',
                  replan.urgent_ids.map((id) => {
                    const who = withWho(id);
                    return `${orderLabel(id)} — ${who ? `едет ${who}` : 'никто: не влезла'}`;
                  })
                )}
              </>
            )}

            {cancelled && (
              <>
                <div className="setrow">
                  <span className="setrow__key">Сняли</span>
                  <span className="setrow__val">
                    {cancelled.order_ids.map(orderLabel).join('; ')}
                    <span className="setrow__note">
                      {` · освободилось ${cancelled.freed_minutes} мин работы по нормативу`}
                    </span>
                  </span>
                </div>
                <div className="setrow">
                  <span className="setrow__key">Влезло взамен</span>
                  <span className="setrow__val">
                    {cancelled.picked_up_count > 0
                      ? ordersWord(cancelled.picked_up_count)
                      : 'ничего — освободившееся время заполнить нечем'}
                  </span>
                </div>
                {names(
                  'Что влезло',
                  cancelled.picked_up.map((id) => {
                    const who = withWho(id);
                    return who ? `${orderLabel(id)} — едет ${who}` : orderLabel(id);
                  })
                )}
              </>
            )}

            {/* Судьба заявок выбывшего. Три исхода в сумме дают ровно то,
                что было у него впереди — ничего не теряется по дороге.
                Числа — рядом, чтобы их складывать глазами; адреса — ниже
                списками: в треть окна адрес не помещается. */}
            {fates && (
              <>
                <div className="incident__fates">
                  {(
                    [
                      ['rescued', 'Подхватили другие', 'ok'],
                      ['kept', 'Остались за ним', 'calm'],
                      ['lost', 'Не влезли никуда', 'bad']
                    ] as const
                  ).map(([key, label, tone]) => (
                    <div key={key} className={'incident__fate incident__fate--' + tone}>
                      <span className="incident__fate-value">{fates[key].length}</span>
                      <span className="incident__fate-label">{label}</span>
                    </div>
                  ))}
                </div>
                {names(
                  `Подхватили другие — ${engineerName(fates.engineer_id)} к ним больше не едет`,
                  fates.rescued.map((id) => {
                    const who = withWho(id);
                    return who ? `${orderLabel(id)} — едет ${who}` : orderLabel(id);
                  })
                )}
                {names(`Остались в маршруте: ${engineerName(fates.engineer_id)}`, fates.kept.map(orderLabel))}
                {names('Не влезли никуда — позвонить абоненту', fates.lost.map(orderLabel))}
              </>
            )}

            <div className="manual__foot">
              <span className="manual__note">
                {[
                  fates
                    ? `${engineerName(fates.engineer_id)}: впереди в маршруте ${pluralWord(fates.pending_was.length, 'была', 'было', 'было')} ${ordersWord(fates.pending_was.length)}.`
                    : '',
                  replan.churn_penalty !== undefined
                    ? `Смену исполнителя считали так: ${usedPreset ? usedPreset.label.toLowerCase() : `как в правилах, штраф ${replan.churn_penalty}`}.`
                    : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              </span>
              <span className="manual__actions">
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Отменить правку
                </Button>
                <Button
                  variant="accent"
                  onClick={onKeep}
                  iconLeft={<Icon name="check" size={16} />}
                >
                  Принять
                </Button>
              </span>
            </div>
          </>
        ) : (
          <>
            <h4 className="incident__subtitle">Причина</h4>

            <div className="incident__kinds">
              {KINDS.map((item) => ({ ...item, ...IMPACT[item.value] })).map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={'incident__kind' + (kind === item.value ? ' incident__kind--on' : '')}
                  onClick={() => setKind(item.value)}
                >
                  <span className="incident__kind-top">
                    <Icon name={item.icon} size={15} />
                    <span className="incident__kind-title">{item.title}</span>
                    <span
                      className={
                        'incident__verdict incident__verdict--' +
                        (item.verdict === 'press' ? 'press' : 'skip')
                      }
                    >
                      {item.verdictText}
                    </span>
                  </span>
                  <span className="incident__kind-what">{item.what}</span>
                </button>
              ))}
            </div>

            <div className="incident__params">
              <label className="incident__field">
                <span className="incident__field-label">Когда случилось</span>
                <input
                  className="rule__input"
                  type="time"
                  value={hhmm(at)}
                  onChange={(e) => {
                    const [h, m] = e.currentTarget.value.split(':').map(Number);
                    if (Number.isFinite(h) && Number.isFinite(m)) setTypedAt(h * 60 + m);
                  }}
                />
              </label>

              {needsEngineer && (
                <label className="incident__field">
                  <span className="incident__field-label">Кто</span>
                  <Select
                    size="sm"
                    value={chosen}
                    onChange={(e) => setEngineerId(e.target.value)}
                    options={[
                      { value: 'auto', label: 'Самый загруженный сейчас' },
                      ...crew.map((load) => ({
                        value: load.engineer.id,
                        label: `${load.engineer.name} · ${ordersWord(load.visits)}`
                      }))
                    ]}
                  />
                </label>
              )}

              {kind === 'delayed' && (
                <label className="incident__field">
                  <span className="incident__field-label">На сколько</span>
                  <Select
                    size="sm"
                    value={String(minutes)}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                    options={DELAYS.map((d) => ({ value: String(d), label: `${d} мин` }))}
                  />
                </label>
              )}

              {kind === 'cancel' && (
                <label className="incident__field">
                  <span className="incident__field-label">Какую заявку</span>
                  <Select
                    size="sm"
                    value={cancelId}
                    onChange={(e) => setOrderId(e.target.value)}
                    options={[
                      { value: '', label: 'Ту, что освободит больше всего времени' },
                      ...cancellable.map((stop) => ({
                        value: stop.order_id,
                        label: `${hhmm(stop.start)} · ${orderLabel(stop.order_id)}`
                      }))
                    ]}
                  />
                </label>
              )}

              {kind === 'urgent' && (
                <>
                  <label className="incident__field">
                    <span className="incident__field-label">Сколько аварий</span>
                    <Select
                      size="sm"
                      value={String(urgent)}
                      onChange={(e) => setUrgent(Number(e.target.value))}
                      options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
                    />
                  </label>

                  {/* Чей участок. Диспетчер обычно знает не только время, но
                      и место: авария приходит на трассу, которую ведёт
                      конкретный инженер. Без этого пересчёт отвечал на другой
                      вопрос — про среднюю аварию в среднем районе. Самому
                      названному инженеру заявка не назначается: она идёт в
                      общий пул, и кто поедет, решает движок. */}
                  <label className="incident__field">
                    <span className="incident__field-label">У кого на участке</span>
                    <Select
                      size="sm"
                      value={near}
                      onChange={(e) => setNearId(e.target.value)}
                      options={[
                        { value: '', label: 'По городу — без привязки' },
                        ...crew.map((load) => ({
                          value: load.engineer.id,
                          label: `${load.engineer.name} · ${ordersWord(load.visits)}`
                        }))
                      ]}
                    />
                  </label>
                </>
              )}
            </div>

            {/* Честная граница возможностей формы: адрес, длительность и
                навык для аварии задаёт не диспетчер, а программа расчёта —
                вводить их здесь негде, потому что она их и не примет. Молчать
                об этом значило бы дать понять, что авария — как обычная
                заявка, только с двумя полями; после пересчёта адрес и то,
                кто поехал, показываются настоящими, по ответу движка. */}
            {kind === 'urgent' && (
              <p className="incident__hint">
                Адрес, длительность и навык для каждой аварии подбирает программа расчёта — здесь
                задаётся только их число и, если нужно, участок. После пересчёта ниже будет видно,
                куда именно они встали и кто поехал.
              </p>
            )}

            {/* Время аварии — словами, когда оно не такое, как на доске, или
                когда аварию в это время некому взять. */}
            {kind === 'urgent' && urgentStart === null && (
              <div className="ctrlnote">
                <Icon name="alert-triangle" size={16} />
                <span>В бригаде никто не умеет аварийные работы — авария не встанет ни в какое время.</span>
              </div>
            )}
            {kind === 'urgent' && urgentStart !== null && typedAt === null && cut < urgentStart && (
              <div className="ctrlnote">
                <Icon name="clock" size={16} />
                <span>
                  Время аварии — {hhmm(urgentStart)}, а не {hhmm(cut)}: раньше её некому взять, у тех,
                  кто умеет аварии, самая ранняя смена с {hhmm(urgentStart)}. Можно вписать другое время.
                </span>
              </div>
            )}
            {urgentEarly && urgentStart !== null && (
              <div className="ctrlnote">
                <Icon name="alert-triangle" size={16} />
                <span>
                  В {hhmm(at)} на смене нет никого, кто умеет аварии: ближайший выходит в{' '}
                  {hhmm(urgentStart)}. Авария может его не дождаться — тогда ни одна не встанет.
                </span>
              </div>
            )}

            {/* Живой контрол окна правки — одна из семи договорённых
                настроек: насколько пересчёт держится за то, кому уже сказали
                ехать. Три готовых варианта вместо числа: диспетчер выбирает
                смысл, а не штраф. По умолчанию горит вариант, совпадающий с
                правилами расчёта компании. */}
            <div className="incident__churn">
              <span className="incident__field-label">Насколько держаться за уже назначенных</span>
              <div className="presets" role="radiogroup" aria-label="Насколько держаться за уже назначенных">
                {CHURN_PRESETS.map((item) => (
                  <button
                    key={item.value}
                    type="button"
                    role="radio"
                    aria-checked={item.penalty === churn}
                    className={'preset' + (item.penalty === churn ? ' preset--on' : '')}
                    onClick={() => setPickedChurn(item.penalty)}
                  >
                    <span className="preset__top">
                      <span className="preset__label">{item.label}</span>
                      {item.penalty === companyChurn && (
                        <span className="preset__default">Как в правилах</span>
                      )}
                    </span>
                    <span className="preset__what">{item.what}</span>
                  </button>
                ))}
                {companyOwn !== null && (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={churn === companyOwn}
                    className={'preset' + (churn === companyOwn ? ' preset--on' : '')}
                    onClick={() => setPickedChurn(null)}
                  >
                    <span className="preset__top">
                      <span className="preset__label">Как в правилах</span>
                    </span>
                    <span className="preset__what">
                      В правилах расчёта стоит свой штраф — {companyOwn}. Пересчёт пойдёт с ним,
                      пока вы не выберете другой вариант.
                    </span>
                  </button>
                )}
              </div>
              {churnUnknown && (
                <p className="manual__note">
                  Правила расчёта не прочитались — отмечен вариант по умолчанию программы.
                </p>
              )}
            </div>

            {/* Правду, а не обещание: пересчёт по событию делает движок, и
                пока он не запущен, недоступен он у любого расчёта — новый,
                заведённый кнопкой, считается здесь же, в браузере, и дня у
                движка за собой не имеет. У сохранённого пересчёта дня нет
                по другой причине — он сам остаток дня. */}
            {blocked && (
              <div className="solvefail">
                <Icon name="alert-triangle" size={16} />
                <span>
                  <b>Пересчёт по событию сейчас недоступен. {blocked.what}</b> {blocked.todo}
                </span>
              </div>
            )}

            {failure && (
              <div className="incident__fail" role="alert">
                <Icon name="alert-triangle" size={16} />
                <span>
                  <b>{failure.what}</b> {failure.todo}
                  <details className="incident__more">
                    <summary>
                      <Icon name="chevron-right" size={14} />
                      Подробности
                    </summary>
                    <p className="incident__fail-detail">{failed}</p>
                  </details>
                </span>
              </div>
            )}

            <div className="manual__foot">
              <span className="manual__note">
                {busy ? (
                  <span className="createbar__busy">
                    <span className="createbar__spin" aria-hidden="true" />
                    Пересобираю маршруты — обычно несколько секунд.
                  </span>
                ) : blocked ? (
                  'Кнопка «Пересчитать» недоступна — причина выше.'
                ) : (
                  'Пересчёт ничего не сохранит: результат появится на экране, и решать по нему.'
                )}
              </span>
              <span className="manual__actions">
                <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                  Отмена
                </Button>
                <Button
                  variant="accent"
                  onClick={() => onRun(spec)}
                  disabled={busy || !ready}
                  iconLeft={<Icon name="lightning" size={16} />}
                >
                  {busy ? 'Считаю…' : 'Пересчитать'}
                </Button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
