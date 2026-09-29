import { useEffect, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { Engineer, Order } from '../data/contract.ts';
import { hhmm } from '../data/derive.ts';
import type { JournalEvent } from '../data/api.ts';

/* Ручное воздействие: одно место, где диспетчер делает что угодно сам.

   Четыре карточки выше отвечают на «что будет, если», и выбирают за
   человека: кто выбыл, какую заявку сняли — движку сказано `auto`, он берёт
   самого занятого и самую дорогую отмену. Для показа это верно, для работы
   нет: у диспетчера звонит конкретный Ерохин про конкретный адрес.

   Отдельные кнопки под заявкой у нас уже есть — в панели детали
   (`DispatcherBlock`): отправить наряд, выехал, выполнено, сорвалось,
   переназначить. Но чтобы до них добраться, надо сперва найти заявку на
   карте или в списке и открыть её. А три события про самого инженера —
   выбыл, вернулся, задержится — руками не ставились нигде: движок их
   принимает с 20 сентября, тип в интерфейсе описан, а экрана не было.

   Поэтому здесь простое меню из обычных списков: что случилось, с кем, во
   сколько — и «Записать». Ничего не угадывается: инженер и заявка
   выбираются из тех, что есть в этом расчёте.

   Событие ложится в журнал на момент ползунка, как и у кнопок под заявкой:
   два места, пишущие в один журнал, обязаны writeать одинаково. */

/** Что движок принимает руками. `order_new` сюда не берём: заявке нужны
    адрес, окно и вид работ, и это форма, а не строка меню — она живёт в
    «Новом расчёте». */
type Kind = Exclude<JournalEvent['kind'], 'order_new'>;

/* Событие: заголовок, иконка и строчка «что это» — ровно как в окне
   «Внести правку» на сводке. Там это уже придумано и работает, второго
   языка для того же разговора заводить незачем. */
const СОБЫТИЯ: {
  value: Kind; title: string; what: string; icon: string; про: 'заявку' | 'инженера';
}[] = [
  { value: 'assigned', title: 'Передать другому', icon: 'shuffle', про: 'заявку',
    what: 'Заявку забирает другой инженер — по звонку или по вашему решению.' },
  { value: 'dispatched', title: 'Отправить наряд', icon: 'truck', про: 'заявку',
    what: 'Наряд ушёл инженеру: он знает адрес и время.' },
  { value: 'en_route', title: 'Выехал', icon: 'navigation-arrow', про: 'заявку',
    what: 'Инженер в пути к этой заявке.' },
  { value: 'done', title: 'Выполнена', icon: 'check-circle', про: 'заявку',
    what: 'Работа закрыта, инженер свободен.' },
  { value: 'failed', title: 'Сорвалась', icon: 'x-circle', про: 'заявку',
    what: 'Не пустили, никого нет дома, не успели в окно или отказались.' },
  { value: 'engineer_delayed', title: 'Задержится', icon: 'clock', про: 'инженера',
    what: 'Прокол, пробка, затянулась прошлая заявка — выйдет позже.' },
  { value: 'engineer_out', title: 'Выбыл', icon: 'user', про: 'инженера',
    what: 'Сегодня его не будет — заболел, отозвали, машина не поехала.' },
  { value: 'engineer_back', title: 'Вернулся в строй', icon: 'check', про: 'инженера',
    what: 'Снова на маршруте: остаток дня можно на него рассчитывать.' }
];

const ГРУППЫ: { про: 'заявку' | 'инженера'; title: string }[] = [
  { про: 'заявку', title: 'По заявке' },
  { про: 'инженера', title: 'По инженеру' }
];


/* Чем пересобирать остаток дня после отметки. Окно правки знает четыре
   события, наших восемь: «выбыл» ложится на «инженер выбыл», «задержится»
   на «задержится», «сорвалась» на «отказ абонента». Остальное — на
   аварию: она единственная про «пришло сверх плана». */
const КУДА: Partial<Record<Kind, 'urgent' | 'cancel' | 'disabled' | 'delayed'>> = {
  engineer_out: 'disabled',
  engineer_delayed: 'delayed',
  failed: 'cancel'
};

const ПРИЧИНЫ = [
  { value: 'no_show', label: 'Абонента нет дома' },
  { value: 'no_access', label: 'Не пустили' },
  { value: 'missed_window', label: 'Не успели в окно' },
  { value: 'cancelled', label: 'Отказались' }
] as const;

type Reason = (typeof ПРИЧИНЫ)[number]['value'];

export interface ManualProps {
  engineers: Engineer[];
  orders: Order[];
  /** Момент ползунка: на него запишется событие. */
  cut: number;
  busy: boolean;
  /** Чем кончилась неудачная запись: фраза движка как есть. */
  failed: { order: string; message: string; detail: string } | null;
  /** Записать событие на указанную минуту от полуночи. */
  onEvent: (event: JournalEvent, at: number) => void;
  /** Заявка словами диспетчера — адрес, а не код. */
  orderLabel?: (id: string) => string;
  /** Заявки этого инженера по плану — по порядку объезда, с временем
      начала работы. Пусто — маршрута у него в этом расчёте нет. */
  stopsOf?: (engineer: string) => { order: string; at: number }[];
  /** Открыть окно правки на подходящем событии: отметить — одно дело,
      пересобрать остаток дня — другое, и второе делает движок. */
  onRecalc?: (kind: 'urgent' | 'cancel' | 'disabled' | 'delayed') => void;
}

/** Отказ движка без служебных приставок. Приходит он как
    «400: плохой параметр: заявка … никому не назначена», а человеку
    нужна только последняя часть: код ответа и слово «параметр» ему не
    говорят ничего, а дело говорит остаток. */
const чистаяПричина = (detail: string) =>
  (detail || '')
    .replace(/^\s*\d{3}\s*:\s*/, '')
    .replace(/^\s*(плохой параметр|ошибка)\s*:\s*/i, '')
    .trim();

export function ManualEvent({
  engineers, orders, cut, busy, failed, onEvent, orderLabel, onRecalc, stopsOf
}: ManualProps) {
  /* Начинаем с невыбранного: первый шаг — это вопрос, а не готовый
     ответ. Подставленное заранее событие читается как «уже решено», и
     человек жмёт «Записать», не заметив, что записывает не то. */
  const [kind, setKind] = useState<Kind | ''>('');
  const [engineer, setEngineer] = useState('');
  /* Кому передают заявку. Отдельно от «кто»: у передачи две стороны, и
     прежде обе жили в одном поле — диспетчер называл только принимающего,
     а чья это заявка, оставалось на совести списка из всех заявок дня. */
  const [to, setTo] = useState('');
  const [order, setOrder] = useState('');
  const [minutes, setMinutes] = useState(40);
  const [reason, setReason] = useState<Reason>('no_show');
  /* Время события своё, а не только момент ползунка: диспетчер узнаёт о
     случившемся позже, чем оно случилось, и «в 9:40, а не сейчас» — это
     обычное дело. Ползунок остаётся значением по умолчанию. */
  const [at, setAt] = useState(cut);
  const [записано, setЗаписано] = useState<string | null>(null);

  /* Ползунок подвинули — время события идёт за ним, пока его не трогали
     руками. Тронутое не перебиваем: иначе введённое пропадало бы. */
  const [своёВремя, setСвоёВремя] = useState(false);
  useEffect(() => {
    if (!своёВремя) setAt(cut);
  }, [cut, своёВремя]);

  const выбрано = СОБЫТИЯ.find((one) => one.value === kind);
  const проЗаявку = выбрано?.про === 'заявку';

  /* Разговор идёт от человека к заявке, а не наоборот.

     Прежде событие по заявке спрашивало «какая заявка» списком из всех
     заявок расчёта — двести с лишним строк, подписанных кодом. Диспетчер
     знает не код, а кто ему позвонил: «Ерохин стоит на Мантулинской».
     Поэтому сперва инженер, а заявки — только его, по порядку объезда и со
     временем работы, как в окне «Внести правку». */
  const мойМаршрут = engineer && stopsOf ? stopsOf(engineer) : [];
  const подпись = (id: string) =>
    (orderLabel ? orderLabel(id) : orders.find((one) => one.id === id)?.address ?? id) || id;

  /* Маршрута у инженера может и не быть: его заявки тогда ищутся по
     закреплению в выгрузке, а если нет и его — берётся весь список.
     Молча показать пустой выбор нельзя: заявка у человека есть, а
     сказать о ней нечем. */
  const заявкиИнженера: { value: string; label: string }[] = мойМаршрут.length
    ? мойМаршрут.map((stop) => ({ value: stop.order, label: `${hhmm(stop.at)} · ${подпись(stop.order)}` }))
    : orders
        .filter((one) => !engineer || one.assigned_to === engineer)
        .map((one) => ({ value: one.id, label: подпись(one.id) }));

  const нуженИнженер = Boolean(выбрано);
  const нужнаЗаявка = Boolean(выбрано) && проЗаявку;
  const нуженПринимающий = kind === 'assigned';

  const мало =
    !выбрано || (нуженИнженер && !engineer) || (нужнаЗаявка && !order) ||
    (нуженПринимающий && !to) ||
    (kind === 'engineer_delayed' && !(minutes > 0));

  const записать = () => {
    if (мало) return;
    setЗаписано(null);
    if (kind === 'assigned') onEvent({ kind, order, engineer: to }, at);
    else if (kind === 'failed') onEvent({ kind, order, reason }, at);
    else if (проЗаявку) onEvent({ kind: kind as 'dispatched' | 'en_route' | 'done', order }, at);
    else if (kind === 'engineer_delayed') onEvent({ kind, engineer, minutes }, at);
    else onEvent({ kind: kind as 'engineer_out' | 'engineer_back', engineer }, at);
    setЗаписано(`${выбрано!.title.toLowerCase()} — записано на ${hhmm(at)}`);
  };

  /* Шаги открываются по мере ответов: пока не сказано, что случилось,
     спрашивать «с кем» не о чем. Сразу все поля на экране — это форма, а
     диспетчеру нужен разговор: случилось вот это, вот с кем, вот когда. */

  return (
    <div className="manual">
      {/* Разметка окна «Внести правку» со сводки: подзаголовок, строки
          событий с иконкой и пояснением, под ними поля. Тот же разговор —
          тот же язык; второй набор классов для него завести было бы
          обманом узнавания. */}
      {ГРУППЫ.map((группа) => (
        <div className="manual__group" key={группа.про}>
          <span className="manual__group-title">{группа.title}</span>
          <div className="incident__kinds">
            {СОБЫТИЯ.filter((one) => one.про === группа.про).map((one) => (
              <button
                key={one.value}
                type="button"
                className={'incident__kind' + (kind === one.value ? ' incident__kind--on' : '')}
                aria-pressed={kind === one.value}
                onClick={() => {
                  /* Повторный щелчок по выбранному снимает выбор: строка
                     работает переключателем, как всякая кнопка с
                     `aria-pressed`. Прежде снять выбранное было нечем —
                     оставалось выбрать другое событие или уйти с экрана. */
                  setKind((было) => (было === one.value ? '' : one.value));
                  /* Выбор сбрасывается: заявка, выбранная для «сорвалось»,
                     к «инженер выбыл» отношения не имеет. */
                  setOrder('');
                  setEngineer('');
                  setTo('');
                  setЗаписано(null);
                }}
              >
                <span className="incident__kind-top">
                  <Icon name={one.icon} size={15} />
                  <span className="incident__kind-title">{one.title}</span>
                </span>
                <span className="incident__kind-what">{one.what}</span>
              </button>
            ))}
          </div>
        </div>
      ))}

      {выбрано && (
        <div className="incident__params">
          {/* Время — первым полем, как в окне «Внести правку»: о случившемся
              узнают позже, чем оно случилось, и «во сколько» — первое, что
              диспетчер уточняет по телефону. */}
          <label className="incident__field">
            <span className="incident__field-label">Когда случилось</span>
            <input
              className="rule__input"
              id="manual-at"
              type="time"
              value={hhmm(at)}
              onChange={(e) => {
                const [h, m] = e.currentTarget.value.split(':').map(Number);
                if (Number.isFinite(h) && Number.isFinite(m)) {
                  setAt(h * 60 + m);
                  setСвоёВремя(true);
                }
              }}
            />
          </label>

          <label className="incident__field">
            <span className="incident__field-label">
              {проЗаявку ? 'У кого' : 'Кто'}
            </span>
            <Select
              size="sm"
              id="manual-engineer"
              value={engineer}
              onChange={(e: { target: { value: string } }) => {
                setEngineer(e.target.value);
                /* Сменили человека — его заявка больше не при чём. */
                setOrder('');
              }}
              options={[
                { value: '', label: engineers.length ? 'Выберите инженера' : 'Инженеров в расчёте нет' },
                ...engineers.map((one) => ({ value: one.id, label: one.name || one.id }))
              ]}
            />
          </label>

          {нужнаЗаявка && (
            <label className="incident__field">
              <span className="incident__field-label">Какая заявка</span>
              <Select
                size="sm"
                id="manual-order"
                value={order}
                disabled={!engineer}
                onChange={(e: { target: { value: string } }) => setOrder(e.target.value)}
                options={[
                  {
                    value: '',
                    label: !engineer
                      ? 'Сначала выберите инженера'
                      : заявкиИнженера.length
                        ? 'Выберите заявку'
                        : 'Заявок у него в этом расчёте нет'
                  },
                  ...заявкиИнженера
                ]}
              />
            </label>
          )}

          {нуженПринимающий && (
            <label className="incident__field">
              <span className="incident__field-label">Кому передать</span>
              <Select
                size="sm"
                id="manual-to"
                value={to}
                onChange={(e: { target: { value: string } }) => setTo(e.target.value)}
                options={[
                  { value: '', label: 'Выберите инженера' },
                  ...engineers
                    .filter((one) => one.id !== engineer)
                    .map((one) => ({ value: one.id, label: one.name || one.id }))
                ]}
              />
            </label>
          )}

          {kind === 'failed' && (
            <label className="incident__field">
              <span className="incident__field-label">Почему</span>
              <Select
                size="sm"
                id="manual-reason"
                value={reason}
                onChange={(e: { target: { value: string } }) => setReason(e.target.value as Reason)}
                options={ПРИЧИНЫ.map((one) => ({ value: one.value, label: one.label }))}
              />
            </label>
          )}

          {kind === 'engineer_delayed' && (
            <label className="incident__field">
              <span className="incident__field-label">На сколько</span>
              <Select
                size="sm"
                id="manual-minutes"
                value={String(minutes)}
                onChange={(e: { target: { value: string } }) => setMinutes(Number(e.target.value))}
                options={[15, 30, 40, 60, 90, 120].map((d) => ({ value: String(d), label: `${d} мин` }))}
              />
            </label>
          )}
        </div>
      )}

      <div className="manual__go">
        <Button
          variant="primary"
          size="sm"
          onClick={записать}
          disabled={мало || busy}
          iconLeft={<Icon name="check-circle" size={14} />}
        >
          {busy ? 'Записываю…' : 'Записать'}
        </Button>
        {onRecalc && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onRecalc(КУДА[kind as Kind] ?? 'urgent')}
            iconLeft={<Icon name="lightning" size={14} />}
          >
            Пересчитать остаток дня
          </Button>
        )}
        {записано && !failed && (
          <span className="manual__ok">
            <Icon name="check-circle" size={14} /> {записано}
          </span>
        )}
      </div>

      {failed && (
        <p className="manual__err">
          <b>Событие не записано.</b>{' '}
          {/* Фраза движка, а не наша обёртка: он отказывает по делу и
              говорит, чего не хватило. */}
          {чистаяПричина(failed.detail) || failed.message}
        </p>
      )}
    </div>
  );
}
