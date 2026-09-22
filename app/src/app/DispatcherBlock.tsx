import { useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { Order } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import type { JournalEvent } from '../data/api.ts';

/** Что диспетчер может сделать с заявкой, пока расчёт открыт на движке. */
export interface DispatcherActions {
  /** Заявка → статус по журналу. Нет в словаре — «назначено», если у
      заявки есть исполнитель. */
  statuses: Record<string, string>;
  /** Идёт запись события. */
  busy: boolean;
  /** Чем кончилась неудачная запись — словами движка. */
  failed: string | null;
  onEvent: (event: JournalEvent) => void;
}

type FailReason = 'no_show' | 'no_access' | 'missed_window' | 'cancelled';

const REASONS: { value: FailReason; label: string }[] = [
  { value: 'no_show', label: 'Абонента нет дома' },
  { value: 'no_access', label: 'Не пустили' },
  { value: 'missed_window', label: 'Не успели в окно' },
  { value: 'cancelled', label: 'Абонент отказался' }
];

/* Распоряжение диспетчера по одной заявке.

   Две вещи, о которых просил заказчик и которых в вёрстке не было:

   - **ручное переназначение** — единственное «необходимо заложить» с сессии
     вопросов. Закрепление — запрет, а не пожелание: заявка останется у
     названного исполнителя или без исполнителя вовсе, и пересчёт её не
     отнимет. После закрепления движок сразу пересобирает остаток дня от
     журнала, и окно правки показывает, чего это стоило;
   - **статусы «отправлено» и «в пути»** — обратная связь организаторов.
     Отправленный наряд держится так же, как закрепление; к заявке «в пути»
     человек уже едет, и пересчёт её не трогает вовсе.

   Кнопки гаснут там, где событие заведомо невозможно, но последнее слово —
   за движком: невозможное он отвергает словами, и они показываются здесь. */
export function DispatcherBlock({
  order,
  view,
  dispatcher
}: {
  order: Order;
  view: DayView;
  dispatcher: DispatcherActions;
}) {
  const [to, setTo] = useState('');
  const [reason, setReason] = useState<FailReason>('no_show');

  const status =
    dispatcher.statuses[order.id] ?? (order.assigned_to ? 'назначено' : 'без исполнителя');
  const closed = status === 'выполнено' || status === 'сорвано';
  const held = Boolean(order.assigned_to);
  const busy = dispatcher.busy;

  /* Кого можно назвать: владеет навыком и ездит на том, что заявке нужно.
     Остальное — сегодня ли он в строю, есть ли прибор в машине — знает
     движок и скажет сам. */
  const capable = [...view.engineerById.values()]
    .filter(
      (engineer) =>
        engineer.id !== order.assigned_to &&
        engineer.skills.includes(order.skill) &&
        (!order.required_transport || engineer.transport === order.required_transport)
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  const chosen = to || capable[0]?.id || '';

  return (
    <section>
      <div className="detail__head">
        <h3 className="detail__subtitle">Распоряжение диспетчера</h3>
      </div>

      <div className="facts">
        <div className="facts__row">
          <span className="facts__key">Статус</span>
          <span className="facts__val">{status}</span>
        </div>
        {order.locked_to && (
          <div className="facts__row">
            <span className="facts__key">Закреплена</span>
            <span className="facts__val">
              за {view.engineerById.get(order.locked_to)?.name ?? order.locked_to} — пересчёт её
              не отнимет
            </span>
          </div>
        )}
      </div>

      {!closed && (
        <div className="dispatch__actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !held || status !== 'назначено'}
            onClick={() => dispatcher.onEvent({ kind: 'dispatched', order: order.id })}
            iconLeft={<Icon name="truck" size={14} />}
          >
            Отправить наряд
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !held || status === 'в пути'}
            onClick={() => dispatcher.onEvent({ kind: 'en_route', order: order.id })}
            iconLeft={<Icon name="navigation-arrow" size={14} />}
          >
            Выехал
          </Button>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !held}
            onClick={() => dispatcher.onEvent({ kind: 'done', order: order.id })}
            iconLeft={<Icon name="check-circle" size={14} />}
          >
            Выполнено
          </Button>
          <span className="dispatch__fail">
            <Select
              size="sm"
              value={reason}
              onChange={(e) => setReason(e.target.value as FailReason)}
              options={REASONS}
            />
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !held}
              onClick={() => dispatcher.onEvent({ kind: 'failed', order: order.id, reason })}
              iconLeft={<Icon name="x-circle" size={14} />}
            >
              Сорвалось
            </Button>
          </span>
        </div>
      )}

      {!closed && (
        <div className="dispatch__pin">
          <span className="dispatch__pin-label">
            {held ? 'Отдать другому' : 'Назначить вручную'}
          </span>
          <span className="dispatch__pin-row">
            <Select
              size="sm"
              value={chosen}
              onChange={(e) => setTo(e.target.value)}
              options={capable.map((engineer) => ({
                value: engineer.id,
                label: `${engineer.name} · ${engineer.id}`
              }))}
            />
            <Button
              variant="accent"
              size="sm"
              disabled={busy || !chosen}
              onClick={() => dispatcher.onEvent({ kind: 'assigned', order: order.id, engineer: chosen })}
              iconLeft={<Icon name="user" size={14} />}
            >
              Закрепить и пересчитать
            </Button>
          </span>
        </div>
      )}

      {dispatcher.failed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>
            <b>Движок не принял.</b> {dispatcher.failed}
          </span>
        </div>
      )}
    </section>
  );
}
