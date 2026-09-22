import { useEffect, useState } from 'react';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { Engineer, Order } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import { hhmm, orders as pluralOrders } from '../data/derive.ts';
import { statusIcon, statusName, transportShort } from '../data/dictionary.ts';
import type { JournalEvent } from '../data/api.ts';

/** Что диспетчер может сделать с заявкой, пока расчёт открыт на движке. */
export interface DispatcherActions {
  /** Заявка → статус по журналу. Нет в словаре — «назначено», если у
      заявки есть исполнитель. */
  statuses: Record<string, string>;
  /** Заявка → инженер, у которого она по журналу (впереди в его списке
      или он уже едет к ней). Null — состояние дня ещё не пришло. */
  holders: Record<string, string> | null;
  /** Момент ползунка: на него запишется событие. */
  cut: number;
  /** Начало шкалы — там ползунок стоит, пока его не трогали. Запасное
      значение: начало смены блок берёт у инженеров показанного дня. */
  dayStart: number;
  /** Идёт запись события. */
  busy: boolean;
  /** Чем кончилась неудачная запись и по какой заявке — словами движка. */
  failed: { order: string; message: string } | null;
  onEvent: (event: JournalEvent) => void;
}

type FailReason = 'no_show' | 'no_access' | 'missed_window' | 'cancelled';

const REASONS: { value: FailReason; label: string }[] = [
  { value: 'no_show', label: 'Абонента нет дома' },
  { value: 'no_access', label: 'Не пустили' },
  { value: 'missed_window', label: 'Не успели в окно' },
  { value: 'cancelled', label: 'Абонент отказался' }
];

type Tone = 'neutral' | 'accent' | 'success' | 'danger' | 'outline';

/* Статус журнала → код словаря статусов: подпись и значок берутся оттуда
   же, откуда их берут списки, и «В пути» везде выглядит одинаково.
   «Назначено» по словарю — «не отправлена», но диспетчеру важнее, что
   исполнитель уже есть, поэтому подпись у него своя. */
const STATUS_VIEW: Record<string, { code: string; label?: string; tone: Tone }> = {
  назначено: { code: 'draft', label: 'Назначена, наряд не отправлен', tone: 'neutral' },
  отправлено: { code: 'sent', tone: 'accent' },
  'в пути': { code: 'en_route', tone: 'accent' },
  выполнено: { code: 'done', tone: 'success' },
  сорвано: { code: 'failed', label: 'Сорвалось', tone: 'danger' }
};

/* Следующий шаг по ходу работы. Кнопка одна и главная: диспетчер не
   выбирает из четырёх равных, а подтверждает то, что случилось дальше. */
const NEXT_STEP: Record<
  string,
  { kind: 'dispatched' | 'en_route' | 'done'; label: string; icon: string }
> = {
  назначено: { kind: 'dispatched', label: 'Отправить наряд', icon: 'truck' },
  отправлено: { kind: 'en_route', label: 'Выехал', icon: 'navigation-arrow' },
  'в пути': { kind: 'done', label: 'Выполнено', icon: 'check-circle' }
};

/* Отказы движка, в словах которых уже есть «что делать» (journal.py,
   _assign и _check): вместо общей фразы — человеческая строка с именем
   вместо табельного. Неизвестный отказ — общая фраза, слова движка
   остаются под «Подробностями». */
function explainRefusal(message: string, nameOf: (id: string) => string): string | null {
  let m = message.match(/(\S+) уже в пути к (\S+?);/);
  if (m) return `${nameOf(m[1])} уже едет к другой заявке (${m[2]}) — сначала отметьте её выполненной или сорванной.`;
  m = message.match(/исполнителя (\S+) сегодня нет/) ?? message.match(/инженера (\S+) сегодня не будет/);
  if (m) return `${nameOf(m[1])} сегодня не работает — отдайте заявку другому инженеру.`;
  m = message.match(/инженер (\S+) не может взять \S+: (.+)$/);
  if (m) return `${nameOf(m[1])} не может взять эту заявку: ${m[2]}. Выберите другого инженера.`;
  if (/уже отчитались/.test(message)) return 'По заявке уже отчитались — изменить её исход нельзя.';
  if (/никому не назначена/.test(message)) return 'Заявка ни за кем не числится — сначала закрепите её за инженером.';
  if (/исполнитель уже едет к/.test(message)) return 'Инженер уже едет к этой заявке — следующий шаг «Выполнено».';
  m = message.match(/уже «([^»]+)»/);
  if (m) return `Заявка уже в статусе «${m[1]}» — посмотрите статус выше и выберите следующий шаг.`;
  return null;
}

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
   за движком: невозможное он отвергает словами, и они показываются здесь,
   под «Подробностями». */
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
  /* Срыв необратим, и причину выбирают после нажатия, а не заранее: пока
     «Сорвалось» не нажато, выбор причины только занимает место. */
  const [failing, setFailing] = useState(false);
  const [reason, setReason] = useState<FailReason | ''>('');
  /* Событие, которое ждёт подтверждения: запись на начало смены или
     необратимое «Выполнено». */
  const [asking, setAsking] = useState<JournalEvent | null>(null);
  /* Сдвинутый ползунок отменяет вопрос: иначе «Записать на начало смены»
     уходило бы уже на новое время под старым текстом. */
  useEffect(() => setAsking(null), [dispatcher.cut]);

  const busy = dispatcher.busy;
  const nameOf = (id: string) => view.engineerById.get(id)?.name ?? id;

  /* D8: у кого заявка — решает журнал, а не план на экране. План мог быть
     посчитан раньше, чем диспетчер кого-то закрепил, и тогда «Отправить
     наряд» ушёл бы не тому, чьё имя видно в карточке. Пока состояние дня
     не пришло, верим плану. */
  const shown = order.assigned_to ?? null;
  const holder = dispatcher.holders ? (dispatcher.holders[order.id] ?? null) : shown;
  /* Статус — после держателя: если по журналу заявка у кого-то, а событий
     по ней не было, она «назначено», даже когда в показанном плане её нет. */
  const status = dispatcher.statuses[order.id] ?? (holder ? 'назначено' : 'без исполнителя');
  const closed = status === 'выполнено' || status === 'сорвано';
  /* Заявка «в пути» в маршруты пересчёта не попадает (CONTRACT.md: она
     только в meta.replan.underway), и после принятого пересчёта у неё нет
     исполнителя в плане. Это не расхождение: человек едет, и закреплять её
     заново нельзя — движок сбросил бы статус в «назначено». */
  const riding = status === 'в пути' && holder !== null && shown === null;
  const stale = dispatcher.holders !== null && !closed && !riding && holder !== shown;
  const held = holder !== null;

  /* Кого можно назвать: владеет навыком и ездит на том, что заявке нужно.
     Остальное — сегодня ли он в строю, есть ли прибор в машине — знает
     движок и скажет сам. Исключаем того, у кого заявка по журналу: отдать
     её ему же незачем. Показанного на экране, наоборот, оставляем — за
     ним и закрепляют, когда журнал разошёлся с планом. */
  const capable = [...view.engineerById.values()]
    .filter(
      (engineer) =>
        engineer.id !== holder &&
        engineer.skills.includes(order.skill) &&
        (!order.required_transport || engineer.transport === order.required_transport)
    )
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  /* По решению владельца исполнитель по умолчанию не выбран: подставленный
     первый по алфавиту закреплялся одним случайным нажатием. Выбор, которого
     нет в списке, тоже считается пустым. */
  const chosen = capable.some((engineer) => engineer.id === to) ? to : '';
  const canPickShown = stale && shown !== null && capable.some((engineer) => engineer.id === shown);

  /* Кому отдаём — имя, на чём ездит и сколько у него уже заявок: табельный
     номер диспетчеру ничего не говорит. */
  const optionLabel = (engineer: Engineer) =>
    [
      engineer.name,
      engineer.transport ? transportShort(engineer.transport) : '',
      pluralOrders(view.routeByEngineer.get(engineer.id)?.stops.length ?? 0)
    ]
      .filter(Boolean)
      .join(' · ');

  /* Событие пишется на момент ползунка. Начало смены — у держателя, а без
     него самое раннее у инженеров дня: начало шкалы (07:00) раньше смены
     (обычно 08:00), и сравнивать с ним значило молчать на настоящем начале
     смены. «Выполнено в 08:00» — почти всегда забытая шкала, а не факт:
     переспрашиваем прямо здесь. */
  const starts = [...view.engineerById.values()].map((engineer) => engineer.shift_start);
  const shiftStart =
    (holder ? view.engineerById.get(holder)?.shift_start : undefined) ??
    (starts.length ? Math.min(...starts) : dispatcher.dayStart);
  const atStart = dispatcher.cut <= shiftStart;
  const beforeShift = dispatcher.cut < shiftStart;
  /* «Выполнено» необратимо: после него движок отвергает любое событие по
     заявке. Поэтому его подтверждают всегда, не только на начале смены. */
  const send = (event: JournalEvent, confirmed = false) => {
    if ((atStart || event.kind === 'done') && !confirmed) {
      setAsking(event);
      return;
    }
    setAsking(null);
    setFailing(false);
    setReason('');
    dispatcher.onEvent(event);
  };

  const look = STATUS_VIEW[status];
  const next = NEXT_STEP[status];
  /* Из «назначено» и «отправлено» движок позволяет сразу «выполнено»:
     диспетчеру позвонили «сделал» — трёх событий подряд на одну минуту
     не нужно. Кнопка вторичная: главная по-прежнему одна. */
  const canFinishEarly = status === 'назначено' || status === 'отправлено';
  const failed = dispatcher.failed?.order === order.id ? dispatcher.failed.message : null;
  const failedText = failed ? explainRefusal(failed, nameOf) : null;

  return (
    <section className="dispatch">
      <div className="detail__head">
        <h3 className="detail__subtitle">Распоряжение диспетчера</h3>
      </div>

      <div className="dispatch__status">
        {look ? (
          <Badge size="lg" tone={look.tone}>
            <Icon name={statusIcon(look.code)} size={14} />
            {look.label ?? statusName(look.code)}
          </Badge>
        ) : (
          <Badge size="lg" tone="outline">
            <Icon name="user" size={14} />
            Без исполнителя
          </Badge>
        )}
        {holder && !stale && <span className="dispatch__who">{nameOf(holder)}</span>}
      </div>

      {order.locked_to && (
        <p className="dispatch__line">
          Закреплена за {nameOf(order.locked_to)} — пересчёт её не отнимет
        </p>
      )}

      {stale && (
        <div className="dispatch__stale">
          <Icon name="alert-triangle" size={16} />
          <span>
            {holder
              ? `По журналу заявка у ${nameOf(holder)}: сначала закрепите`
              : 'По журналу заявка ни за кем не числится: сначала закрепите'}
          </span>
          {canPickShown && shown && (
            <Button variant="ghost" size="sm" onClick={() => setTo(shown)}>
              Выбрать: {nameOf(shown)}
            </Button>
          )}
        </div>
      )}

      {!closed && (
        <p className={'dispatch__when' + (atStart ? ' dispatch__when--warn' : '')}>
          <Icon name="clock" size={16} />
          <span>
            Событие запишется на {hhmm(dispatcher.cut)}
            {atStart &&
              (beforeShift
                ? ` — раньше начала смены (${hhmm(shiftStart)}). Если событие было позже, передвиньте время на шкале`
                : ' — это начало смены. Если событие было позже, передвиньте время на шкале')}
          </span>
        </p>
      )}

      {asking && (
        <div className="dispatch__ask" role="alert">
          <span>
            {asking.kind === 'done'
              ? `Отметить выполненной на ${hhmm(dispatcher.cut)}${atStart ? ' (начало смены)' : ''}? Отменить будет нельзя`
              : `Записать на ${beforeShift ? 'время до начала смены' : 'начало смены'}, ${hhmm(dispatcher.cut)}?`}
          </span>
          <span className="dispatch__row">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => send(asking, true)}>
              {asking.kind === 'done' ? 'Выполнено' : 'Записать'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAsking(null)}>
              {atStart ? 'Сначала выберу время' : 'Отмена'}
            </Button>
          </span>
        </div>
      )}

      {!closed && held && !asking && !failing && (
        <div className="dispatch__row dispatch__actions">
          {next && (
            <Button
              variant="accent"
              disabled={busy || stale}
              onClick={() => send({ kind: next.kind, order: order.id })}
              iconLeft={<Icon name={next.icon} size={16} />}
            >
              {next.label}
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={busy || stale}
            onClick={() => setFailing(true)}
            iconLeft={<Icon name="x-circle" size={16} />}
          >
            Сорвалось
          </Button>
          {canFinishEarly && (
            <Button
              variant="secondary"
              disabled={busy || stale}
              onClick={() => send({ kind: 'done', order: order.id })}
              iconLeft={<Icon name="check-circle" size={16} />}
            >
              Уже выполнено
            </Button>
          )}
        </div>
      )}

      {!closed && held && failing && !asking && (
        <div className="dispatch__fail">
          <Select
            id={'dispatch-fail-' + order.id}
            label="Почему сорвалось"
            value={reason}
            onChange={(e) => setReason(e.target.value as FailReason | '')}
            options={[{ value: '', label: 'Выберите причину' }, ...REASONS]}
          />
          <span className="dispatch__row">
            <Button
              variant="primary"
              size="sm"
              disabled={busy || stale || !reason}
              onClick={() => reason && send({ kind: 'failed', order: order.id, reason })}
            >
              Записать срыв
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFailing(false)}>
              Отмена
            </Button>
          </span>
        </div>
      )}

      {!closed && !riding && !asking && (
        <div className="dispatch__pin">
          <span className="dispatch__pin-label">
            {held ? 'Отдать другому' : 'Назначить вручную'}
          </span>
          <span className="dispatch__row">
            <Select
              className="dispatch__pick"
              value={chosen}
              onChange={(e) => setTo(e.target.value)}
              options={[
                { value: '', label: 'Выберите инженера' },
                ...capable.map((engineer) => ({ value: engineer.id, label: optionLabel(engineer) }))
              ]}
            />
            <Button
              variant="secondary"
              disabled={busy || !chosen}
              onClick={() => send({ kind: 'assigned', order: order.id, engineer: chosen })}
              iconLeft={<Icon name="user" size={16} />}
            >
              Закрепить и пересчитать
            </Button>
          </span>
        </div>
      )}

      {failed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>
            <b>Событие не записано.</b>{' '}
            {failedText ?? 'Проверьте статус заявки и время на шкале и попробуйте ещё раз.'}
            <details className="dispatch__more">
              <summary>Подробности</summary>
              {failed}
            </details>
          </span>
        </div>
      )}
    </section>
  );
}
