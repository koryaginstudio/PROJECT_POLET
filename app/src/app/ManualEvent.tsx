import { useState } from 'react';
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
  onEvent: (event: JournalEvent) => void;
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
  const [kind, setKind] = useState<Kind>('engineer_delayed');
  const [engineer, setEngineer] = useState('');
  const [order, setOrder] = useState('');
  const [minutes, setMinutes] = useState(40);
  const [reason, setReason] = useState<Reason>('no_show');

  const выбрано = СОБЫТИЯ.find((one) => one.value === kind)!;
  const проЗаявку = выбрано.про === 'заявку';
  /* «Передать другому» — единственное, где нужны оба: и заявка, и кому. */
  const нуженИнженер = !проЗаявку || kind === 'assigned';

  const мало =
    (проЗаявку && !order) || (нуженИнженер && !engineer) ||
    (kind === 'engineer_delayed' && !(minutes > 0));

  const подпись = (one: Order) =>
    `${one.id} · ${orderLabel ? orderLabel(one.id) : (one.address ?? '')}`.trim();

  const записать = () => {
    if (мало) return;
    if (kind === 'assigned') onEvent({ kind, order, engineer });
    else if (kind === 'failed') onEvent({ kind, order, reason });
    else if (проЗаявку) onEvent({ kind: kind as 'dispatched' | 'en_route' | 'done', order });
    else if (kind === 'engineer_delayed') onEvent({ kind, engineer, minutes });
    else onEvent({ kind: kind as 'engineer_out' | 'engineer_back', engineer });
  };

  return (
    <div className="manual">
      <div className="manual__row">
        <Select
          className="manual__field"
          id="manual-kind"
          label="Что случилось"
          value={kind}
          onChange={(e: { target: { value: string } }) => setKind(e.target.value as Kind)}
          options={СОБЫТИЯ.map((one) => ({ value: one.value, label: one.label }))}
        />

        {проЗаявку && (
          <Select
            className="manual__field"
            id="manual-order"
            label="Заявка"
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
            label={kind === 'assigned' ? 'Кому передать' : 'Инженер'}
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
            label="Почему сорвалось"
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

      <div className="manual__go">
        <Button
          variant="primary"
          size="sm"
          onClick={записать}
          disabled={мало || busy}
          iconLeft={<Icon name="check-circle" size={14} />}
        >
          {busy ? 'Записываю…' : `Записать на ${hhmm(cut)}`}
        </Button>
        <span className="manual__note">
          Событие ляжет в журнал на момент ползунка — тот же журнал, что у кнопок под заявкой.
        </span>
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
