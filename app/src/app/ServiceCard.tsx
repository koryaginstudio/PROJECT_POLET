import { Icon } from '../ds/components/core/Icon.jsx';
import type { ServiceCrew, ServiceRecord } from '../data/registry.ts';
import { pluralWord } from '../data/derive.ts';
import {
  equipmentName,
  orderClassName,
  requiredTransportName,
  skillIcon,
  skillName,
  skillShort
} from '../data/dictionary.ts';
import { requiredTransportWhy } from '../data/rationale.ts';
import { WhyMark } from './WhyMark.tsx';

interface Props {
  row: ServiceRecord;
  /** Какая по счёту в списке. */
  seat?: number;
  /** Числа услуги за выбранный срок. Считает база: запись хранит итоги по
      всем данным сразу, а срок выбирают наверху. Без них карточка показывает
      итоги записи. */
  slice?: { orders: number; assigned: number; urgent: number; access: number; planned: number };
  /** Строка справочника вместо карточки: без полей и половины цифр. */
  dense?: boolean;
  /** Навыки, отмеченные в полосе отбора: в карточке навык подсвечен, чтобы
      было видно, за что услуга сюда попала. */
  skills?: string[];
  /** Кто может взять услугу и сколько всего инженеров в справочнике. Без
      них карточка полосу «кто умеет» не рисует: врать числом хуже, чем
      промолчать. */
  crew?: ServiceCrew;
  staff?: number;
  /** Щелчок по карточке открывает запись. Без него карточка только
      показывает: обещать открытие там, где открывать нечего, нельзя. */
  onOpen?: () => void;
}

/* Карточка услуги. Собрана по образцу карточек расчёта, инженера и заявки —
   те же места под то же самое: название сверху, метка записи под ним, три
   главных числа в строку, список «подпись — значение», поля выгрузки и ряд
   признаков внизу.

   Картинки в середине у неё нет, и это правильно. У расчёта там день картой,
   у инженера лицо, у заявки окно приёма — каждая отвечает на вопрос, которого
   числами не задать. У услуги такого вопроса не нашлось: полоса длительности,
   стоявшая там прежде, показывала ровно то же, что число «90 мин» строкой
   ниже, только длиной. Картинка, пересказывающая соседнюю цифру, — не
   картинка, а лишние полсантиметра высоты в каждой из восемнадцати
   карточек. */
export function ServiceCard({
  row,
  seat,
  slice,
  dense = false,
  skills = [],
  crew,
  staff,
  onOpen
}: Props) {
  const orders = slice ? slice.orders : row.orders;
  const urgent = slice ? slice.urgent : row.urgent;
  const access = slice ? slice.access : row.access;
  /* Разложенность считается по расчётам: в данных услуга просто есть, а
     разложил её движок или нет — свойство прогона. Без прогонов строка
     молчит, а не показывает ноль: ноль читался бы как «не разложили». */
  const planned = slice ? slice.planned : row.planned;
  const assigned = slice ? slice.assigned : row.assigned;
  const loose = planned > 0 && assigned < planned;
  const spread = row.minutesTo > row.minutes;

  return (
    /* Вся карточка — вход в запись: значки внутри живут своей жизнью, но
       отдельных кнопок у неё нет. Тот же приём, что у карточки заявки:
       обёртка кнопкой не годится — кнопка в кнопке не работает ни мышью,
       ни с клавиатуры. */
    <article
      className={'runcard runcard--flat' + (onOpen ? ' runcard--open' : '')}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={(event) => {
        if (!onOpen) return;
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="runcard__head">
        <span className="runcard__ident">
          {/* Название и есть имя услуги: им её называют и по нему ищут.
              В нынешней выгрузке код вида работ — то же самое слово, и
              отдельно он не показан вовсе; когда он придёт кодом, встанет
              меткой записи ниже. */}
          <span className="runcard__code srvcard__name" title={row.title}>
            {row.title}
          </span>
          {/* Метка на месте пометки простоя у инженера и «без инженера» у
              заявки: то единственное состояние услуги, которое стоит знать
              до чтения цифр, — что заявки по ней остаются лежать. */}
          {loose && (
            <span
              className="runcard__open srvcard__loose"
              title={`Без инженера осталось заявок: ${planned - assigned} из ${planned}`}
              aria-label="Есть нераспределённые заявки"
            >
              <Icon name="user" size={12} />
            </span>
          )}
        </span>
        {seat !== undefined && (
          <span className="engcard__seat">#{String(seat).padStart(3, '0')}</span>
        )}
      </div>

      {/* Под названием — навык: то же место, где у инженера табельный со
          сменой, а у расчёта время записи. Навык здесь потому, что он и
          отвечает на «кто вообще может это взять», — а услуга с навыком не
          совпадает, и путать их нельзя.

          Код вида работ стоит рядом только тогда, когда он и название —
          разные строки. В нынешней выгрузке они совпадают слово в слово, и
          бейдж повторял бы заголовок карточки целиком; в выгрузке, где код
          придёт кодом, он нужен — по нему заявку сверяют с учётной
          системой. */}
      <span className="runcard__stamp">
        {row.key !== row.title && (
          <span className="engcard__idwrap">
            <span className="engcard__idlabel">id:</span>
            <span className="crewpro__id engcard__idbadge">{row.key}</span>
          </span>
        )}
        {/* Навык коротким именем — тем же, что и в тесных местах в остальном
            интерфейсе: «Работы на подключение и дозаказы» в строку метки не
            встаёт, а рядом с ним стоит ещё и код. Полное название — в
            подсказке и в чипе внизу карточки, где ему хватает ширины. */}
        <span className="engcard__shift srvcard__skill" title={skillName(row.skill)}>
          <Icon name={skillIcon(row.skill)} size={12} />
          {skillShort(row.skill)}
        </span>
      </span>

      {/* Кто это умеет — выше чисел и крупнее их.

          Оператору, который услуги знает наизусть, карточка отвечала на
          «сколько заявок» и «сколько занимает», но не на тот вопрос, с
          которым к ней приходят: назвали работу — кого на неё посылать.
          Навык под названием на него отвечает только тому, кто держит в
          голове, у кого какой навык.

          Считано и по транспорту: услуга с автомобилем недоступна тому, у
          кого его нет, сколько бы навыков он ни имел. Имена — когда их
          мало; тридцать три фамилии на карточке не читает никто, и вместо
          них там счёт. */}
      {!dense && crew && staff !== undefined && (
        <div className={'srvcrew' + (crew.able.length <= staff / 3 ? ' srvcrew--few' : '')}>
          <span className="srvcrew__top">
            <Icon name="users" size={14} />
            Могут взять <b>{crew.able.length}</b> из {staff}
          </span>
          {/* Второй строкой — то, чего не говорит счёт. Мало кого — имена;
              много, но транспорт отсекает, — насколько; иначе насколько
              навык редкий. «Почти весь штат» только когда это правда: у
              аварийных работ тринадцать из сорока двух — не почти весь. */}
          <span className="srvcrew__note">
            {crew.able.length === 0
              ? 'Взять эту работу некому'
              : crew.able.length <= 8
                ? crew.able.map((one) => one.name).join(', ')
                : crew.skilled.length > crew.able.length
                  ? `навык есть у ${crew.skilled.length}, но ${crew.skilled.length - crew.able.length} без нужного транспорта`
                  : crew.able.length >= staff * 0.75
                    ? 'почти весь штат'
                    : `остальные ${staff - crew.able.length} этого не умеют`}
          </span>
        </div>
      )}

      {dense ? (
        <>
          <span className="runcard__value">
            {orders}
            <span className="runcard__unit">
              {pluralWord(orders, 'заявка', 'заявки', 'заявок')}
            </span>
          </span>
          <span className="runcard__label">По этой услуге</span>
        </>
      ) : (
        /* Три числа в строке, как у трёх соседних баз: сколько такой работы
           заказывают, сколько она занимает и какая доля доходит до инженера.
           Из них и складывается ответ «что это за услуга для плана». */
        <div className="engquick">
          <div className="engquick__tile engquick__tile--main">
            <span className="engquick__value">{orders}</span>
            <span className="engquick__label">Заявок</span>
          </div>
          {/* Длительность — верхней границей, и когда границы две, об этом
              сказано словом «до». Иначе «90 мин» у услуги, которую делают то
              за полчаса, то за полтора часа, читалось бы как её обычная
              длительность: по плану держать надо худшую, но обещать её как
              единственную нельзя. Обе границы и разброс — на шкале выше. */}
          <div className="engquick__tile" title="Сколько занимает работа на объекте">
            <span className="engquick__value">
              {spread && <span className="engquick__unit">до </span>}
              {row.minutesTo}
              <span className="engquick__unit">мин</span>
            </span>
            <span className="engquick__label">Работы</span>
          </div>
          <div className={'engquick__tile' + (loose ? ' engquick__tile--bad' : '')}>
            <span className="engquick__value">
              {planned > 0 ? `${Math.round((assigned / planned) * 100)}%` : '—'}
            </span>
            <span className="engquick__label">Разложено</span>
          </div>
        </div>
      )}

      {dense ? (
        <div className="runcard__facts">
          <span className={'runcard__fact' + (loose ? ' runcard__fact--bad' : '')}>
            {skillName(row.skill)} · <b>{spread ? `${row.minutes}–${row.minutesTo}` : row.minutes}</b>{' '}
            мин
          </span>
        </div>
      ) : (
        /* Чем услуга оборачивается в плане. Считается по заявкам и расчётам и
           от срока к сроку меняется — в отличие от полей ниже, которые
           пришли выгрузкой и одни и те же всегда. */
        <dl className="engmetrics">
          <div className={'engmetrics__row' + (urgent > 0 ? ' engmetrics__row--bad' : '')}>
            <dt>Срочных</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{urgent}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Нужен доступ</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{access}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>В расчётах</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{planned > 0 ? planned : 'не считалась'}</dd>
          </div>
          <div className={'engmetrics__row' + (loose ? ' engmetrics__row--bad' : '')}>
            <dt>Без инженера</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{planned > 0 ? planned - assigned : '—'}</dd>
          </div>
        </dl>
      )}

      {/* Что об услуге говорит сама выгрузка. Пустые поля не рисуются: услуга
          без ограничения по транспорту не должна показывать пустую строку
          «Транспорт». */}
      {!dense && (
        <dl className="engfacts">
          {row.orderClass && (
            <div className="engfacts__row">
              <dt>Класс заявки</dt>
              <dd>{orderClassName(row.orderClass)}</dd>
            </div>
          )}
          <div className="engfacts__row">
            <dt>
              Транспорт
              {row.requiredTransport && (
                <WhyMark text={requiredTransportWhy(row.requiredTransport, row.key)} />
              )}
            </dt>
            <dd className="engfacts__tight">
              {row.requiredTransport
                ? requiredTransportName(row.requiredTransport)
                : 'без ограничения'}
            </dd>
          </div>
          <div className="engfacts__row">
            <dt>Везти</dt>
            <dd>
              {row.equipment.length > 0 ? row.equipment.map(equipmentName).join(', ') : 'ничего'}
            </dd>
          </div>
        </dl>
      )}

      {/* Признаки услуги — тем же рядом, что навыки у инженера: просто то,
          чем эта услуга отличается от соседней. Навык подсвечен, когда
          совпадает с отбором наверху. */}
      {!dense && (
        <div className="runcard__actions engcard__skills">
          <span className={'chip chip--sm' + (skills.includes(row.skill) ? ' chip--on' : '')}>
            <Icon name={skillIcon(row.skill)} size={12} />
            {skillName(row.skill)}
          </span>
          {row.requiredTransport && (
            <span className="chip chip--sm">
              <Icon name="car" size={12} />
              {requiredTransportName(row.requiredTransport)}
            </span>
          )}
          {row.equipment.length > 0 && (
            <span className="chip chip--sm" title={row.equipment.map(equipmentName).join(', ')}>
              <Icon name="wrench" size={12} />
              Оборудование
            </span>
          )}
        </div>
      )}

    </article>
  );
}
