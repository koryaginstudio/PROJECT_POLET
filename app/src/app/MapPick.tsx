import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { deadline, hhmm, homeOf, placeOf, visits } from '../data/derive.ts';
import { transportIcon, transportName } from '../data/dictionary.ts';
import { PersonName } from './PersonName.tsx';
import { routeColor } from './MapBoard.tsx';

/* Краткая сводка о том, что выбрано на карте.

   Обзор встречает картой, а правую колонку занимали итоги расчёта — числа
   про день целиком. Пока ничего не выбрано, это верно: спрашивают именно
   «что вообще получилось». Но стоило щёлкнуть по маршруту или по точке, и
   отвечать было нечем: маршрут подсвечивался, заявка обводилась, а колонка
   продолжала говорить про день. Щелчок по точке и вовсе уводил в соседнюю
   вкладку — человек терял и карту, и место, на которое смотрел.

   Теперь колонка отвечает на то, о чём спросили: выбран маршрут — сводка о
   нём, выбрана заявка — о ней. Крестик возвращает итоги расчёта, и это
   единственный способ «закрыть» выбор, не ища его на самой карте.

   Заявка важнее маршрута: щёлкнув по точке внутри выбранного маршрута,
   спрашивают про точку. Поэтому она и показывается.

   Подписи здесь — вход в базы: имя инженера и номер заявки открывают
   карточку из справочника поверх карты. Это тот же разбор, что и в базах
   данных, только принесённый к месту, где спросили. */

interface Props {
  view: DayView;
  /** Выбранный маршрут и выбранная заявка — что из них показывать, решает
      сам. */
  pinned: string | null;
  selectedOrder: string | null;
  /** Кто выезжает из общего гнезда, если нажали на него. */
  nest: string[] | null;
  /** Выбрать маршрут из перечня гнезда. */
  onPickRoute: (id: string) => void;
  /** Закрыть сводку: вернуть итоги расчёта. */
  onClose: () => void;
  /** Открыть карточку из базы поверх карты. */
  onOpenEngineer: (id: string) => void;
  onOpenOrder: (id: string) => void;
}

/** Минуты словами: «3 ч 40 мин». */
const spell = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
};

export function MapPick({
  view,
  pinned,
  selectedOrder,
  nest,
  onPickRoute,
  onClose,
  onOpenEngineer,
  onOpenOrder
}: Props) {
  const colorOf = (engineerId: string) =>
    routeColor(view.loads.findIndex((item) => item.engineer.id === engineerId));

  const order = selectedOrder ? view.orderById.get(selectedOrder) : undefined;
  const placement = selectedOrder ? view.stopByOrder.get(selectedOrder) : undefined;
  const load = pinned ? view.loads.find((item) => item.engineer.id === pinned) : undefined;

  const crowd = nest
    ? view.loads.filter((one) => nest.includes(one.engineer.id))
    : [];

  if (!order && !load && crowd.length === 0) return null;

  const head = (tone: string, title: React.ReactNode, note: string, icon?: string) => (
    <div className="mpick__head">
      <span className="mpick__mark" style={{ background: tone }} />
      <span className="mpick__title">
        {title}
        <span className="mpick__note">
          {icon && <Icon name={icon} size={11} />}
          {note}
        </span>
      </span>
      <button type="button" className="mapstat__fold" onClick={onClose} title="Вернуть итоги расчёта" aria-label="Закрыть сводку">
        <Icon name="x" size={14} />
      </button>
    </div>
  );

  const row = (label: string, value: React.ReactNode) => (
    <div className="mpick__row" key={label}>
      <span className="mpick__label">{label}</span>
      <span className="mpick__value">{value}</span>
    </div>
  );

  /* Общее гнездо выезда. Отвечает на «кто отсюда едет»: место одно, а путей
     из него дюжина, и выбрать нужный можно прямо здесь. */
  if (crowd.length > 0 && !order && !load) {
    return (
      <section className="mapstat mpick" aria-label="Общий выезд">
        {head('#8A8A8A', <b className="mpick__name">Общий выезд</b>, homeOf(crowd[0].engineer))}

        <div className="mpick__rows">
          {row('Выезжают', `${crowd.length}`)}
        </div>

        <div className="mpick__crowd">
          {crowd.map((one) => (
            <button
              key={one.engineer.id}
              type="button"
              className="mpick__one"
              onClick={() => onPickRoute(one.engineer.id)}
              title={`Показать маршрут: ${one.engineer.name}`}
            >
              <span className="mpick__mark" style={{ background: colorOf(one.engineer.id) }} />
              <PersonName name={one.engineer.name} stacked={false} />
              <span className="mpick__num">{visits(one.visits)}</span>
            </button>
          ))}
        </div>
      </section>
    );
  }

  /* Заявка. Отвечает на «что это за точка и кто на неё едет». */
  if (order) {
    const mine = placement ? view.engineerById.get(placement.engineerId) : undefined;
    const stop = placement?.stop;
    return (
      <section className="mapstat mpick" aria-label="Выбранная заявка">
        {head(
          placement ? colorOf(placement.engineerId) : '#8A8A8A',
          <b className="mpick__name">{order.id}</b>,
          order.work_title
        )}

        <div className="mpick__rows">
          {row('Адрес', placeOf(order))}
          {row('Окно приёма', `${hhmm(order.window_start)}–${hhmm(order.window_end)}`)}
          {/* Срок уходит за полночь у трети заявок: «37:00» читается как
              опечатка, а «13:00 завтра» — как срок. */}
          {row('Крайний срок', deadline(order.sla_deadline))}
          {row('Работа', `${order.est_minutes} мин`)}
          {stop && row('Визит', `${hhmm(stop.arrive)}–${hhmm(stop.finish)}`)}
          {row(
            'Инженер',
            mine ? (
              <button type="button" className="mpick__link" onClick={() => onOpenEngineer(mine.id)}>
                <PersonName name={mine.name} stacked={false} />
              </button>
            ) : (
              <span className="mpick__none">Не нашёлся</span>
            )
          )}
        </div>

        <button type="button" className="mapstat__go" onClick={() => onOpenOrder(order.id)}>
          Открыть карточку заявки
          <Icon name="arrow-right" size={13} />
        </button>
      </section>
    );
  }

  /* Маршрут. Отвечает на «чей это путь и каков его день». */
  const crew = load!;
  const totals = crew.route?.totals;
  return (
    <section className="mapstat mpick" aria-label="Выбранный маршрут">
      {head(
        colorOf(crew.engineer.id),
        <button type="button" className="mpick__link" onClick={() => onOpenEngineer(crew.engineer.id)}>
          <PersonName name={crew.engineer.name} stacked={false} />
        </button>,
        crew.engineer.transport ? transportName(crew.engineer.transport) : 'Транспорт не указан',
        crew.engineer.transport ? transportIcon(crew.engineer.transport) : undefined
      )}

      <div className="mpick__rows">
        {row('Визитов', String(crew.visits))}
        {row('Загрузка', `${Math.round(crew.occupancy * 100)}%`)}
        {totals && row('В пути', spell(totals.travel_minutes))}
        {totals && row('Работа', spell(totals.work_minutes))}
        {totals && row('День', `${hhmm(totals.start)}–${hhmm(totals.end)}`)}
      </div>

      <button type="button" className="mapstat__go" onClick={() => onOpenEngineer(crew.engineer.id)}>
        Открыть карточку инженера
        <Icon name="arrow-right" size={13} />
      </button>
    </section>
  );
}
