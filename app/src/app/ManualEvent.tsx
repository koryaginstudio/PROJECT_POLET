import { useEffect, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Input } from '../ds/components/forms/Input.jsx';
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

const СОБЫТИЯ: { value: Kind; label: string; про: 'заявку' | 'инженера' }[] = [
  { value: 'assigned', label: 'Передать заявку другому инженеру', про: 'заявку' },
  { value: 'dispatched', label: 'Отправить наряд', про: 'заявку' },
  { value: 'en_route', label: 'Инженер выехал', про: 'заявку' },
  { value: 'done', label: 'Заявка выполнена', про: 'заявку' },
  { value: 'failed', label: 'Заявка сорвалась', про: 'заявку' },
  { value: 'engineer_delayed', label: 'Инженер задержится', про: 'инженера' },
  { value: 'engineer_out', label: 'Инженер выбыл', про: 'инженера' },
  { value: 'engineer_back', label: 'Инженер вернулся в строй', про: 'инженера' }
];

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

export function ManualEvent({ engineers, orders, cut, busy, failed, onEvent, orderLabel }: ManualProps) {
  /* Начинаем с невыбранного: первый шаг — это вопрос, а не готовый
     ответ. Подставленное заранее событие читается как «уже решено», и
     человек жмёт «Записать», не заметив, что записывает не то. */
  const [kind, setKind] = useState<Kind | ''>('');
  const [engineer, setEngineer] = useState('');
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
  /* «Передать другому» — единственное, где нужны оба: и заявка, и кому. */
  const нуженИнженер = Boolean(выбрано) && (!проЗаявку || kind === 'assigned');

  const мало =
    !выбрано || (проЗаявку && !order) || (нуженИнженер && !engineer) ||
    (kind === 'engineer_delayed' && !(minutes > 0));

  const подпись = (one: Order) =>
    `${one.id} · ${orderLabel ? orderLabel(one.id) : (one.address ?? '')}`.trim();

  const записать = () => {
    if (мало) return;
    setЗаписано(null);
    if (kind === 'assigned') onEvent({ kind, order, engineer }, at);
    else if (kind === 'failed') onEvent({ kind, order, reason }, at);
    else if (проЗаявку) onEvent({ kind: kind as 'dispatched' | 'en_route' | 'done', order }, at);
    else if (kind === 'engineer_delayed') onEvent({ kind, engineer, minutes }, at);
    else onEvent({ kind: kind as 'engineer_out' | 'engineer_back', engineer }, at);
    setЗаписано(`${выбрано!.label.toLowerCase()} — записано на ${hhmm(at)}`);
  };

  /* Шаги открываются по мере ответов: пока не сказано, что случилось,
     спрашивать «с кем» не о чем. Сразу все поля на экране — это форма, а
     диспетчеру нужен разговор: случилось вот это, вот с кем, вот когда. */
  const шаг2 = Boolean(выбрано);
  const шаг3 = шаг2 && !мало;

  const Шаг = ({ n, title, done, children }: {
    n: number; title: string; done?: boolean; children: React.ReactNode;
  }) => (
    <li className={'step' + (done ? ' step--done' : '')}>
      <span className="step__n">{done ? <Icon name="check" size={13} /> : n}</span>
      <div className="step__body">
        <span className="step__title">{title}</span>
        {children}
      </div>
    </li>
  );

  return (
    <div className="manual">
      <ol className="steps">
        <Шаг n={1} title="Что случилось" done={шаг2}>
          <div className="step__choices">
            {СОБЫТИЯ.map((one) => (
              <button
                key={one.value}
                type="button"
                className={'choice' + (kind === one.value ? ' choice--on' : '')}
                onClick={() => {
                  setKind(one.value);
                  /* Выбор сбрасывается: заявка, выбранная для «сорвалось»,
                     к «инженер выбыл» отношения не имеет, и тянуть её
                     дальше значило бы записать не то. */
                  setOrder('');
                  setEngineer('');
                }}
              >
                {one.label}
              </button>
            ))}
          </div>
        </Шаг>

        {шаг2 && (
          <Шаг n={2} title={проЗаявку ? 'По какой заявке' : 'С кем'} done={шаг3}>
            <div className="manual__row">
              {проЗаявку && (
                <Select
                  className="manual__field"
                  id="manual-order"
                  value={order}
                  onChange={(e: { target: { value: string } }) => setOrder(e.target.value)}
                  options={[
                    { value: '', label: orders.length ? 'Выберите заявку' : 'Заявок в расчёте нет' },
                    ...orders.map((one) => ({ value: one.id, label: подпись(one) }))
                  ]}
                />
              )}
              {нуженИнженер && (
                <Select
                  className="manual__field"
                  id="manual-engineer"
                  label={kind === 'assigned' ? 'Кому передать' : undefined}
                  value={engineer}
                  onChange={(e: { target: { value: string } }) => setEngineer(e.target.value)}
                  options={[
                    { value: '', label: engineers.length ? 'Выберите инженера' : 'Инженеров нет' },
                    ...engineers.map((one) => ({ value: one.id, label: `${one.id} · ${one.name}` }))
                  ]}
                />
              )}
              {kind === 'failed' && (
                <Select
                  className="manual__field"
                  id="manual-reason"
                  label="Почему"
                  value={reason}
                  onChange={(e: { target: { value: string } }) => setReason(e.target.value as Reason)}
                  options={ПРИЧИНЫ.map((one) => ({ value: one.value, label: one.label }))}
                />
              )}
              {kind === 'engineer_delayed' && (
                <Input
                  className="manual__field manual__field--narrow"
                  id="manual-minutes"
                  label="На сколько, мин"
                  type="number"
                  value={String(minutes)}
                  onChange={(e: { currentTarget: { value: string } }) =>
                    setMinutes(Number(e.currentTarget.value))
                  }
                />
              )}
            </div>
          </Шаг>
        )}

        {шаг3 && (
          <Шаг n={3} title="Когда">
            <div className="manual__row">
              <Input
                className="manual__field manual__field--narrow"
                id="manual-at"
                type="time"
                value={hhmm(at)}
                onChange={(e: { currentTarget: { value: string } }) => {
                  const [h, m] = e.currentTarget.value.split(':').map(Number);
                  if (Number.isFinite(h) && Number.isFinite(m)) {
                    setAt(h * 60 + m);
                    setСвоёВремя(true);
                  }
                }}
              />
              <span className="manual__note">
                По умолчанию — момент ползунка. Событие ляжет в тот же журнал, что и
                кнопки под заявкой.
              </span>
            </div>
          </Шаг>
        )}
      </ol>

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
        {записано && !failed && (
          <span className="manual__ok">
            <Icon name="check-circle" size={14} /> {записано}
          </span>
        )}
      </div>

      {failed && (
        <p className="manual__err">
          <b>Событие не записано.</b>{' '}
          {/* Фраза движка, а не наша обёртка. Он отказывает по делу и
              говорит, чего не хватило — «заявка никому не назначена:
              сначала назначьте исполнителя». В ручном меню это и есть
              ответ: человек сам выбрал, что записать, и должен узнать,
              почему не вышло, а не «проверьте выбранные значения». */}
          {чистаяПричина(failed.detail) || failed.message}
        </p>
      )}
    </div>
  );
}
