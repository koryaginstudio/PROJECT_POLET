import { Icon } from '../ds/components/core/Icon.jsx';
import type { RouteRecord } from '../data/registry.ts';
import { capitalize, dec, hhmm, hoursText, pluralWord, shortName } from '../data/derive.ts';
import { faceOf } from '../data/photos.ts';
import { RouteMap } from './RouteMap.tsx';
import { looseShare } from '../screens/db/DbHead.tsx';

interface Props {
  row: RouteRecord;
  /** Какой по счёту в списке. Список отбирают и переупорядочивают, поэтому
      номер приходит снаружи: карточка своего места в ряду не знает. */
  seat?: number;
  /** Остальные маршруты того же расчёта — тихой подложкой под своей линией.
      Считает база: карточка видит одну запись и о соседях не знает. */
  others?: [number, number][][];
  /** Строка справочника вместо карточки: без карты, полей и половины цифр. */
  dense?: boolean;
  /** Открыть маршрут на большой карте расчёта, закрепив его там. Другого
      «открыть» у маршрута нет: своего экрана у него не заводится, а место,
      где маршрут смотрят целиком, — карта дня. */
  onOpen: () => void;
  /** День, на который построен план: `2026-09-08` → `08.09.2026`. */
  day?: string;
  /** Открыть профиль инженера, который ехал. Нет — имя не нажимается. */
  onOpenEngineer?: () => void;
  /** Открыть заявку маршрута по номеру. Нет — чипы заявок не нажимаются. */
  onOpenOrder?: (orderId: string) => void;
}

/* День расчёта из ISO-даты выгрузки. */
const dayOf = (date: string) => {
  const [year, month, day] = date.split('-');
  return year && month && day ? `${day}.${month}.${year}` : date;
};

/* Карточка маршрута. Собрана по образцу карточек расчёта, инженера и заявки,
   и это то же осознанное повторение: четыре базы отвечают на один вопрос —
   «что у нас есть и каково оно», — и одно и то же место в карточке обязано
   значить одно и то же, в какую бы из них диспетчер ни зашёл. Номер сверху,
   метка записи под ним, картинка в середине, три главных числа в строку,
   список «подпись — значение», поля записи и ряд чипов внизу.

   Риска в карточке нет вовсе — ни числом, ни меткой. «Рискованная остановка»
   это визит, к которому инженер по плану не успевает, и понять это из слова
   «Риск» с цифрой рядом невозможно: величина требует объяснения длиннее
   самой карточки. Место, где о ней говорят полными словами, — доска
   статистики наверху базы и таблица; справочник же отвечает на «что это за
   маршрут», а не пересказывает всё, что о нём посчитано.

   Своё здесь — карта. У расчёта на этом месте день целиком, у инженера лицо,
   у заявки окно приёма; маршрут же тем и отличается от соседнего, где он
   прошёл, а числами это не сказать: двенадцать визитов по одному кварталу и
   двенадцать через полобласти считаются одинаково. Поэтому в середине — своя
   линия во всю плитку, а не общий план дня. */
export function RouteCard({
  row,
  seat,
  others = [],
  dense = false,
  onOpen,
  day,
  onOpenEngineer,
  onOpenOrder
}: Props) {
  const overtime = row.overtimeMinutes > 0;
  /* Порог недогруза — общий на все базы, а не своё число в каждой карточке. */
  const loose = row.occupancy > 0 && row.occupancy < looseShare();
  /* Плотная строка — единственный вид карточки без кнопки карты внутри, и
     тогда дорога с клавиатуры нужна ей самой. В обычном виде такую дорогу
     даёт плитка карты, подписанная словами, и вторая точка фокуса вокруг
     всего содержимого только удлиняла бы обход табом. Заодно в плотном виде
     нет заметки: перехватывать пробел у её поля здесь нечему. */
  const keys = dense
    ? {
        role: 'button' as const,
        tabIndex: 0,
        onKeyDown: (event: React.KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }
      }
    : {};

  return (
    /* Вся карточка ведёт на карту расчёта, к этому маршруту: щелчок по
       номеру, по цифрам, по пустому месту — всё это «покажи, где он ездил».
       Кнопки внутри отвечают за себя сами, и щелчок по ним сюда не доходит.

       Клавиатуре карточка целиком не нужна там, где внутри есть кнопка
       карты: тот же довод, что и у карточки расчёта — дорога туда же
       подписана словами («Открыть маршрут M0012 на карте расчёта R001»), а
       лишняя точка фокуса вокруг всего содержимого удлиняла бы обход табом
       вдвое и называлась бы при этом целой карточкой разом. В плотной
       строке кнопки карты нет, и там карточка эту дорогу берёт на себя —
       см. `keys` выше. */
    <article
      className="runcard runcard--flat runcard--open"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        onOpen();
      }}
      {...keys}
    >
      <div className="runcard__head">
        <span className="runcard__ident">
          {/* Подпись «id:» перед номером — та же, что у табельного в карточке
              инженера и у номера расчёта: то, чем запись называют и по чему
              её находят. */}
          <span className="runcard__id">
            <span className="engcard__idlabel">id:</span>
            <span className="runcard__code">{row.code}</span>
          </span>
        </span>
        {seat !== undefined && (
          <span className="engcard__seat">#{String(seat).padStart(3, '0')}</span>
        )}
      </div>

      {/* Под номером — чей это маршрут и когда: то же место, где у расчёта
          время записи, а у инженера смена. Маршрут без расчёта не бывает, и
          номер M0012 сам по себе не отвечает, из какого он дня. */}
      <span className="runcard__stamp">
        <span className="engcard__idwrap">
          <span className="engcard__idlabel">расчёт:</span>
          <span className="crewpro__id engcard__idbadge">{row.run.code}</span>
        </span>
        <span className="engcard__shift">
          <Icon name="clock" size={12} />
          {hhmm(row.start)}–{hhmm(row.end)}
        </span>
      </span>

      {!dense && (
        <RouteMap
          path={row.path}
          stops={row.stops}
          others={others}
          lane={row.lane}
          label={`Открыть маршрут ${row.code} на карте расчёта ${row.run.code}`}
          onOpen={onOpen}
        />
      )}

      {dense ? (
        <>
          <span className="runcard__value">
            {row.visits}
            <span className="runcard__unit">
              {pluralWord(row.visits, 'заявка', 'заявки', 'заявок')}
            </span>
          </span>
          <span className="runcard__label">За смену</span>
        </>
      ) : (
        /* Три числа в строке, как у инженера, заявки и расчёта, — то, чем
           один маршрут отличается от другого прежде всего: сколько на нём
           адресов, насколько плотно он набит и вылезает ли за смену.
           Остальное — дорога, работа, простой, риск — договаривает список
           ниже, и переработки там уже нет: она сказана здесь. */
        <div className="engquick">
          <div className="engquick__tile engquick__tile--main">
            <span className="engquick__value">{row.visits}</span>
            <span className="engquick__label">
              {capitalize(pluralWord(row.visits, 'заявка', 'заявки', 'заявок'))}
            </span>
          </div>
          <div
            className={'engquick__tile' + (loose ? ' engquick__tile--bad' : '')}
            title="Доля рабочего времени смены, занятая маршрутом"
          >
            {/* С десятой доли, как занятость в карточках инженера и расчёта:
                одно и то же число во всех справочниках должно быть названо с
                одной точностью. */}
            <span className="engquick__value">
              {dec(row.occupancy * 100)}
              <span className="engquick__unit">%</span>
            </span>
            <span className="engquick__label">Занятость</span>
          </div>
          <div className={'engquick__tile' + (overtime ? ' engquick__tile--bad' : '')}>
            <span className="engquick__value">
              {dec(row.overtimeMinutes / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">Сверх смены</span>
          </div>
        </div>
      )}

      {dense ? (
        <div className="runcard__facts">
          <span className={'runcard__fact' + (overtime ? ' runcard__fact--bad' : '')}>
            {shortName(row.engineerName)} · <b>{hoursText(row.travelMinutes)}</b> в дороге
          </span>
        </div>
      ) : (
        /* Как прошло время смены — вторым рядом ячеек, а не списком «подпись
           слева, число справа». Списком эти три строки читались плохо: в
           колонке подписей помещается слово, значение прижато к правому краю,
           и между ними на всю карточку тянется пустое место, которое глаз
           каждый раз пересекает заново. Три равные ячейки слева направо
           читаются одним движением, и это те же три части, из которых
           складывается смена: ехал, работал, ждал.

           Часы здесь десятичной дробью — «5,3 ч», а не «5 ч 18 мин». Три
           ячейки делят ширину карточки поровну, и на каждую приходится
           пальца полтора: «5 ч 18 мин» в них не влезало и лезло на соседку,
           так что вместо трёх чисел выходила каша из букв. Формат тот же,
           что у часов в карточке инженера, и по той же причине — это
           компактный ряд, а не таблица, где у часов своё место.

           Ряд подчинённый: кегль меньше верхнего. Наверху то, чем маршрут
           называют, — сколько адресов и как плотно; здесь то, из чего это
           сложилось. Равные по весу ряды спорили бы, какой читать первым. */
        <div className="engquick engquick--sub">
          <div className="engquick__tile">
            <span className="engquick__value">
              {dec(row.travelMinutes / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">В дороге</span>
          </div>
          <div className="engquick__tile">
            <span className="engquick__value">
              {dec(row.workMinutes / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">В работе</span>
          </div>
          {/* Простой — это оплаченное время, за которое ничего не сделано:
              инженер приехал раньше, чем клиент готов принять, и ждёт
              открытия окна. */}
          <div className="engquick__tile">
            <span className="engquick__value">
              {dec(row.idleMinutes / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">Простой</span>
          </div>
        </div>
      )}

      {/* Что о маршруте говорит сама запись, а не его итог: кто ехал и на
          какой день построен план. Лицо рядом с фамилией — то же, по
          которому человека узнают в базе инженеров: снимок раздаётся по
          табельному, а не по месту в списке.

          Имя — переход в профиль человека: маршрут отвечает на «где он
          ездил», а «кто он такой» — вопрос к базе инженеров, и дорога туда
          должна начинаться там, где имя написано. Кнопкой имя выглядит
          только под курсором: вся карточка и так нажимается, и ещё одна
          обведённая кнопка внутри неё спорила бы с ней. */}
      {!dense && (
        <dl className="engfacts">
          <div className="engfacts__row">
            <dt>Инженер</dt>
            {/* Табельный — хвостом к имени, а не подписью под ним. Под именем
                он читался как вторая строка адреса и растил строку вдвое;
                справа же он ровно то, чем и является, — короткая приписка к
                фамилии, по которой человека сверяют. */}
            <dd>
              {(() => {
                const who = (
                  <>
                    <img
                      className="engfacts__face"
                      src={faceOf({ id: row.engineerId, name: row.engineerName })}
                      alt=""
                      loading="lazy"
                    />
                    {shortName(row.engineerName)}
                    <span className="engfacts__sub">{row.engineerId}</span>
                  </>
                );
                return onOpenEngineer ? (
                  <button
                    type="button"
                    className="engfacts__who dblink"
                    title={`${row.engineerName} — открыть профиль`}
                    onClick={onOpenEngineer}
                  >
                    {who}
                  </button>
                ) : (
                  <span className="engfacts__who" title={row.engineerName}>
                    {who}
                  </span>
                );
              })()}
            </dd>
          </div>
          {day && (
            <div className="engfacts__row">
              <dt>План на</dt>
              <dd>{dayOf(day)}</dd>
            </div>
          )}
        </dl>
      )}

      {/* Заявки маршрута своими номерами, в порядке объезда. Раньше здесь
          стояли районы, и это был ответ не на тот вопрос: «Таганский,
          Нижегородский» говорит, в какой части города он был, но не говорит,
          что он там делал, — а маршрут это и есть список конкретных заявок.
          По номеру заявку находят в соседней базе; номер стоит и на самой
          карточке заявки, и в маршруте он тот же.

          Тем же рядом чипов, что навыки у инженера и признаки у заявки.
          Чип нажимается и открывает заявку: номер здесь и есть ссылка, и
          искать его руками в соседней базе — лишний ход. Щелчок по чипу до
          карточки не доходит — иначе открывалась бы ещё и карта. */}
      {!dense && row.orderIds.length > 0 && (
        <div className="runcard__actions engcard__skills">
          {row.orderIds.map((id, index) =>
            onOpenOrder ? (
              <button
                key={id}
                type="button"
                className="chip chip--sm"
                title={`Заявка № ${index + 1} — открыть заявку ${id}`}
                onClick={() => onOpenOrder(id)}
              >
                <Icon name="clipboard-list" size={12} />
                {id}
              </button>
            ) : (
              <span key={id} className="chip chip--sm" title={`Заявка № ${index + 1} — заявка ${id}`}>
                <Icon name="clipboard-list" size={12} />
                {id}
              </span>
            )
          )}
        </div>
      )}

    </article>
  );
}
