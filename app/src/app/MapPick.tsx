import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { deadline, hhmm, homeOf, placeOf, visits } from '../data/derive.ts';
import { transportIcon, transportName } from '../data/dictionary.ts';
import { PersonName } from './PersonName.tsx';
import { routeColor } from './MapBoard.tsx';
import { routeLabel, routeNumber } from '../data/routeIds.ts';

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
  /** Расчёт: вместе с инженером он опознаёт маршрут, а значит, даёт его
      собственный номер — тот же, что стоит на карте. */
  runId: string;
  /** Выбранный маршрут и выбранная заявка — что из них показывать, решает
      сам. */
  pinned: string | null;
  selectedOrder: string | null;
  /** Кто выезжает из общего гнезда, если нажали на него. */
  nest: string[] | null;
  /** Выбрать маршрут из перечня гнезда. */
  onPickRoute: (id: string) => void;
  /** Навести на маршрут из перечня гнезда: пока карта затихла, так её
      разбирают по одному пути. Пусто — наведение ничего не меняет. */
  onHoverRoute?: (id: string | null) => void;
  /** Закрыть сводку: вернуть итоги расчёта. */
  onClose: () => void;
  /** Открыть карточку из базы поверх карты. Не задано — сводка только
      рассказывает: так она стоит в мониторинге, где разбор записей не
      открывают, а смотрят на ход смены. */
  onOpenEngineer?: (id: string) => void;
  onOpenOrder?: (id: string) => void;
  /** «Почему этот исполнитель» — в сводку, где у выбранной заявки стоят
      кандидаты и объяснение движка. Шаг сценария ТЗ «карта → почему».
      Не задано — кнопки нет. */
  onExplain?: () => void;
  /** Чей это маршрут, когда на карте день не один: номер маршрута сквозной
      по базе и считается от пары «расчёт — инженер». Не задан — все
      маршруты принадлежат `runId`. */
  routeKeyOf?: (engineerId: string) => { runId: string; engineerId: string };
}

/** Минуты словами: «3 ч 40 мин». */
const spell = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
};

export function MapPick({
  view,
  runId,
  pinned,
  selectedOrder,
  nest,
  onPickRoute,
  onHoverRoute,
  onClose,
  onOpenEngineer,
  onOpenOrder,
  onExplain,
  routeKeyOf
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

  const head = (
    tone: string,
    title: React.ReactNode,
    note: string,
    icon?: string,
    /* Куда ведёт сам заголовок. Задан — вся шапка становится кнопкой: о
       выбранном спрашивают, нажимая на него, а не выискивая строку внизу
       карточки. */
    onOpen?: () => void,
    /* Вторая карточка в паре крестика не носит: закрывают ответ целиком, и
       два крестика подряд читались бы как два разных выхода. */
    quiet = false
  ) => (
    <div className={'mpick__head' + (onOpen ? ' mpick__head--open' : '')}>
      <span className="mpick__mark" style={{ background: tone }} />
      {onOpen ? (
        <button type="button" className="mpick__title mpick__title--go" onClick={onOpen}>
          {title}
          <Icon name="arrow-right" size={13} />
        </button>
      ) : (
        <span className="mpick__title">{title}</span>
      )}
      {/* Подпись под заголовком идёт от самого края карточки, а не от
          названия: иначе значок средства передвижения стоит с отступом в
          цветную точку и выглядит съехавшим вправо. */}
      <span className="mpick__note">
        {icon && <Icon name={icon} size={11} />}
        {note}
      </span>
      {!quiet && (
        <button
          type="button"
          className="mapstat__fold"
          onClick={onClose}
          title="Вернуть итоги расчёта"
          aria-label="Закрыть сводку"
        >
          <Icon name="x" size={14} />
        </button>
      )}
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
          {row('Выезжают', `${crowd.length} чел.`)}
          {row(
            'Заявок у них',
            `${crowd.reduce((sum, one) => sum + one.visits, 0)}`
          )}
        </div>

        {/* Перечень тех, кто отсюда выезжает. Наведение на строку зажигает
            его путь на затихшей карте, щелчок — оставляет только его. */}
        <div className="mpick__crowd">
          {crowd.map((one) => (
            <button
              key={one.engineer.id}
              type="button"
              className="mpick__one"
              onClick={() => onPickRoute(one.engineer.id)}
              onMouseEnter={() => onHoverRoute?.(one.engineer.id)}
              onMouseLeave={() => onHoverRoute?.(null)}
              onFocus={() => onHoverRoute?.(one.engineer.id)}
              onBlur={() => onHoverRoute?.(null)}
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
    /* Беда заявки, если она есть. Точка на карте помечена знаком, а сводка
       о ней молчала — выходило, что тревога видна, пока смотришь на город,
       и пропадает, стоит о нём спросить.

       Две беды и обе от движка: срок сорван — приезд позже крайнего срока;
       под угрозой — запас так мал, что любая задержка срывает срок. */
    const late = placement?.slaBreached ?? false;
    const shaky = (placement?.stop.risk ?? 'low') !== 'low';
    const trouble = late
      ? {
          title: 'Срок сорван',
          text: stop
            ? `Приезд в ${hhmm(stop.arrive)}, крайний срок — ${deadline(order.sla_deadline)}.`
            : 'Плановый приезд позже крайнего срока.'
        }
      : shaky
        ? {
            title: 'Под угрозой',
            text: `Запас до срока ${stop?.slack_minutes ?? 0} мин: любая задержка в пути срывает срок.`
          }
        : null;

    return (
      <section className="mapstat mpick" aria-label="Выбранная заявка">
        {head(
          placement ? colorOf(placement.engineerId) : '#8A8A8A',
          <b className="mpick__name">{order.id}</b>,
          order.work_title,
          undefined,
          onOpenOrder ? () => onOpenOrder(order.id) : undefined
        )}

        {trouble && (
          <button
            type="button"
            className="mpick__trouble"
            onClick={() => onOpenOrder?.(order.id)}
            disabled={!onOpenOrder}
            title={onOpenOrder ? 'Открыть карточку заявки' : undefined}
          >
            <Icon name="alert-triangle" size={14} />
            <span className="mpick__trouble-body">
              <b>{trouble.title}</b>
              <span>{trouble.text}</span>
            </span>
            {onOpenOrder && <Icon name="chevron-right" size={13} />}
          </button>
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
              onOpenEngineer ? (
                <button
                  type="button"
                  className="mpick__link"
                  onClick={() => onOpenEngineer(mine.id)}
                >
                  <PersonName name={mine.name} stacked={false} />
                </button>
              ) : (
                <PersonName name={mine.name} stacked={false} />
              )
            ) : (
              <span className="mpick__none">Не нашёлся</span>
            )
          )}
          {/* Почему не нашёлся — ТЗ 2.5, словами движка. */}
          {!mine &&
            order.unassigned_reason &&
            row(
              'Почему',
              order.unassigned_reason.text.charAt(0).toUpperCase() +
                order.unassigned_reason.text.slice(1)
            )}
        </div>

        {onExplain && (
          <button type="button" className="mapstat__go" onClick={onExplain}>
            {mine ? 'Почему этот исполнитель' : 'Почему не назначена'}
            <Icon name="arrow-right" size={13} />
          </button>
        )}
        {onOpenOrder && (
          <button type="button" className="mapstat__go" onClick={() => onOpenOrder(order.id)}>
            Открыть карточку заявки
            <Icon name="arrow-right" size={13} />
          </button>
        )}
      </section>
    );
  }

  /* Маршрут одной карточкой: номер и числа дня, а под чертой — человек,
     который его везёт.

     Двумя карточками, одна над другой, это занимало половину карты: у
     маршрута свои пять строк, у инженера свои три, и каждая со своим
     заголовком и своей чертой. Вопрос-то один — «что это за путь», а кто
     за рулём, часть ответа, а не отдельный разговор.

     Числа не повторяются: день принадлежит маршруту, свойства — человеку. */
  const crew = load!;
  const totals = crew.route?.totals;
  const routeKey = routeKeyOf?.(crew.engineer.id) ?? { runId, engineerId: crew.engineer.id };
  const number = routeLabel(routeNumber(routeKey.runId, routeKey.engineerId));
  const tone = colorOf(crew.engineer.id);

  return (
    <section className="mapstat mpick" aria-label="Выбранный маршрут">
      {head(
        tone,
        <b className="mpick__name">{number}</b>,
        crew.engineer.transport ? transportName(crew.engineer.transport) : 'Транспорт не указан',
        crew.engineer.transport ? transportIcon(crew.engineer.transport) : undefined,
        onOpenEngineer ? () => onOpenEngineer(crew.engineer.id) : undefined
      )}

      <div className="mpick__rows">
        {row('Заявок', String(crew.visits))}
        {row('Загрузка', `${Math.round(crew.occupancy * 100)}%`)}
        {totals && row('В пути', spell(totals.travel_minutes))}
        {totals && row('Работа', spell(totals.work_minutes))}
        {totals && row('День', `${hhmm(totals.start)}–${hhmm(totals.end)}`)}
      </div>

      {/* Кто везёт. Отделено чертой, а не заголовком: это продолжение
          ответа о маршруте, а не новая карточка. */}
      <div className="mpick__rows mpick__rows--crew">
        {row(
          'Исполнитель',
          onOpenEngineer ? (
            <button
              type="button"
              className="mpick__link"
              onClick={() => onOpenEngineer(crew.engineer.id)}
              title="Открыть карточку инженера"
            >
              <PersonName name={crew.engineer.name} stacked={false} />
            </button>
          ) : (
            <PersonName name={crew.engineer.name} stacked={false} />
          )
        )}
        {row('Смена', `${hhmm(crew.engineer.shift_start)}–${hhmm(crew.engineer.shift_end)}`)}
        {row('Выезжает из', homeOf(crew.engineer))}
      </div>
    </section>
  );
}
