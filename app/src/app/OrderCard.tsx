import { Icon } from '../ds/components/core/Icon.jsx';
import type { OrderRecord } from '../data/registry.ts';
import { dec, deadline, hhmm } from '../data/derive.ts';
import { requiredTransportWhy } from '../data/rationale.ts';
import {
  equipmentName,
  isUrgent,
  orderClassName,
  priorityClassName,
  requiredTransportName,
  skillIcon,
  skillName,
  statusName,
  techName,
  workTypeIcon
} from '../data/dictionary.ts';
import { WhyMark } from './WhyMark.tsx';
import { OrderWindow } from './OrderWindow.tsx';
import { faceOf } from '../data/photos.ts';

interface Props {
  row: OrderRecord;
  /** Какая по счёту в списке. Список отбирают и переупорядочивают, поэтому
      номер приходит снаружи: карточка своего места в ряду не знает. */
  seat?: number;
  /** Открыть карточку заявки целиком. Нет — карточка не нажимается. */
  onOpen?: () => void;
  /** Строка справочника вместо карточки: без шкалы дня, полей и половины
      цифр. */
  dense?: boolean;
  /** Виды работ, отмеченные в полосе отбора: в карточке метка подсвечена,
      чтобы было видно, за что заявка сюда попала. Отмечают наверху — здесь
      метка только подсвечена и не нажимается. */
  workType?: string[];
  /** В каких ещё расчётах встречается заявка с этим номером. Считает база:
      карточка видит одну строку и о соседних прогонах не знает. */
  runs?: { runId: string; code: string }[];
}

/* Карточка заявки. Собрана по образцу карточки инженера, и это то же
   осознанное повторение: две базы об одном хозяйстве, и место в карточке
   обязано значить одно и то же. Сверху — чем заявка называется, под ней
   метка записи: номер и окно приёма там же, где у инженера табельный и
   смена. В середине картинка, ниже три главных числа, поля выгрузки,
   признаки и расчёты.

   Вместо фотографии — окно приёма на шкале дня. У инженера картинка
   отвечает на «кто это», у заявки такого вопроса нет: её узнают по номеру.
   Зато есть вопрос, на который не отвечает ни одно число в карточке, —
   «когда её вообще можно сделать»: окно в два часа посреди дня и окно с
   девяти до девяти это разные заявки, а в строке «12:00–14:00» разницы не
   видно, пока не прочитаешь обе. */
/** День заявки коротко: «17 авг». Полная дата в карточке не нужна — год в
    наборе один, — а «2026-08-17» в плитке занимает всю строку. */
function dayLabel(iso: string): string {
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const [, month, day] = iso.split('-');
  const index = Number(month) - 1;
  return MONTHS[index] ? `${Number(day)} ${MONTHS[index]}` : iso;
}

/** Фамилия с инициалами: «Попов О. Н.». Полное ФИО в плитку шириной в треть
    карточки не встаёт ни при какой плотности, а фамилия — то, чем человека
    называют. Целиком имя остаётся в подсказке. */
function shortName(name: string): string {
  const [surname, first, patronymic] = name.trim().split(/\s+/).filter(Boolean);
  if (!surname) return name;
  const initials = [first, patronymic]
    .filter(Boolean)
    .map((part) => `${part![0].toUpperCase()}.`)
    .join(' ');
  return initials ? `${surname} ${initials}` : surname;
}

export function OrderCard({ row, seat, onOpen, dense = false, workType = [], runs = [] }: Props) {
  const urgent = isUrgent(row.priorityClass, row.priority);
  const free = !row.engineerId;
  /* Запас — сколько остаётся от закрытия окна до крайнего срока. Это и есть
     цена промаха: заявку, у которой запаса нет, переносить некуда. */
  const slack = row.slaDeadline - row.windowEnd;
  /* Визит выходит за окно приёма: инженер приедет, когда принимать уже
     некому. Считается по плану, а не по сроку — это разные беды. */
  const late = row.visitEnd != null && row.visitEnd > row.windowEnd;
  const width = row.windowEnd - row.windowStart;
  /* Расчёты, где встречается тот же номер — от свежего к старому. */
  const others = runs.filter((ref) => ref.runId !== row.run.id);

  return (
    /* Вся карточка — вход в заявку: значки внутри живут своей жизнью, но
       отдельных кнопок у неё нет. */
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
          {/* Номер заявки — первым и крупно, ровно как код у карточки
              расчёта. Им заявку называют, по нему её ищут и на него ссылаются
              в разговоре; название работы отвечает на другой вопрос — «что
              там делать» — и стоит строкой ниже, вместе с адресом. */}
          <span className="runcard__code">{row.id}</span>
          {/* Срочность — сразу за номером и насыщенным красным: это первое,
              что нужно знать о заявке. В ряду серых чипов внизу, где она
              стояла раньше, её замечали последней. */}
          {urgent && (
            <span className="ordcard__urgent" title="Срочная заявка">
              <Icon name="warning" size={11} />
              Срочная
            </span>
          )}
          {/* Метка на месте пометки «открыт» у расчёта и метки простоя у
              инженера: там она о состоянии дел, здесь — о том единственном
              состоянии заявки, которое стоит знать до чтения цифр. */}
          {free && (
            <span
              className="runcard__open ordcard__free"
              title="Заявка не досталась никому: инженера в этом расчёте у неё нет"
              aria-label="Без инженера"
            >
              <Icon name="user" size={12} />
            </span>
          )}
        </span>
        {seat !== undefined && (
          <span className="engcard__seat">#{String(seat).padStart(3, '0')}</span>
        )}
      </div>

      {/* Под номером — что делаем и куда ехать: то же место, где у инженера
          стоит смена, а у расчёта время, когда его завели. Номер ушёл отсюда
          наверх, в заголовок, и держать его здесь вторым отпечатком незачем. */}
      <span className="runcard__stamp ordcard__what">
        <span className="ordcard__work" title={row.workTitle}>
          <Icon name={workTypeIcon(row.workType)} size={12} />
          {row.workTitle}
        </span>
        {/* Окно приёма здесь — только в плотном виде. В обычном оно подписано
            над своей полосой строкой ниже, и два одинаковых времени подряд
            читались как ошибка вёрстки, а не как метка записи. */}
        {dense && (
          <span className="engcard__shift">
            <Icon name="clock" size={12} />
            {hhmm(row.windowStart)}–{hhmm(row.windowEnd)}
          </span>
        )}
      </span>

      {/* Адрес отдельной строкой: он длиннее всего остального в шапке и в
          одну строку с видом работ не встаёт. */}
      <span className="ordcard__where" title={`${row.address} · ${row.district}`}>
        <Icon name="map-pin" size={12} />
        {row.address}
      </span>

      {!dense && (
        /* Окно на шкале дня — та же полоса, что в панели заявки: одна заявка
           показана одинаково везде, где её показывают. */
        <div className="ordwin">
          <OrderWindow
            from={row.windowStart}
            to={row.windowEnd}
            start={row.visitStart ?? undefined}
            finish={row.visitEnd ?? undefined}
            risky={slack <= 0}
          />
        </div>
      )}

      {dense ? (
        <>
          <span className="runcard__value">
            {row.estMinutes}
            <span className="runcard__unit">мин</span>
          </span>
          <span className="runcard__label">Работа</span>
        </>
      ) : (
        /* Три главных ответа о заявке: кто её вёз, что на ней делали и когда.
           Раньше на этом месте стояли длительность, ширина окна и запас —
           три числа, ни одно из которых не отвечает на первый вопрос к
           строке справочника: «кто ездил и когда». Числа не пропали, они
           стоят ниже, среди прочих обстоятельств.

           Значения здесь текстовые, и это единственное место, где плитка
           `engquick` держит не цифру: имя и вид работ числом не выразить, а
           заводить ради них четвёртый вид плитки значило бы развести
           одинаковые по смыслу ряды в трёх базах. */
        /* Четыре главных ответа о заявке — сеткой два на два, а не рядом в
           одну строку. В строку они не встают: имя, вид работ и время — это
           текст, и в колонке шириной в четверть карточки каждое ломалось на
           три строки, а соседки расходились по высоте. Два на два дают каждой
           вдвое больше ширины и ровный низ. */
        <div className="ordquick">
          <div className="ordquick__tile">
            <span className="ordquick__label">Тип услуги</span>
            <span className="ordquick__value" title={row.workTitle}>
              {row.workTitle}
            </span>
          </div>

          <div className={'ordquick__tile' + (free ? ' ordquick__tile--bad' : '')}>
            <span className="ordquick__label">Кто выполнял</span>
            {row.engineerName ? (
              /* Лицо рядом с фамилией: в базе инженеров человека узнают по
                 нему, и здесь оно то же самое — снимок раздаётся по
                 табельному, а не по месту в списке. */
              <span className="ordquick__who" title={row.engineerName}>
                <img
                  className="ordquick__face"
                  src={faceOf({ id: row.engineerId!, name: row.engineerName })}
                  alt=""
                  loading="lazy"
                />
                <span className="ordquick__value">{shortName(row.engineerName)}</span>
              </span>
            ) : (
              <span className="ordquick__value">не назначен</span>
            )}
          </div>

          <div className="ordquick__tile">
            <span className="ordquick__label">Когда назначена</span>
            {/* День заявки: у одного номера в разных расчётах свои дни, и без
                даты «был в 10:31» не отвечает на «когда именно». */}
            <span className="ordquick__value">{dayLabel(row.run.date)}</span>
          </div>

          {/* Красным — когда визит не укладывается в окно: инженер приезжает
              тогда, когда клиент уже не принимает. Это и есть тревога про
              соотношение двух времён, а нулевой запас до крайнего срока —
              про другое, и он сказан своей строкой ниже. */}
          <div className={'ordquick__tile' + (late ? ' ordquick__tile--bad' : '')}>
            <span className="ordquick__label">
              {row.visitStart == null ? 'Окно приёма' : 'Окно · когда был'}
            </span>
            <span className="ordquick__value">
              {hhmm(row.windowStart)}–{hhmm(row.windowEnd)}
              {row.visitStart != null && (
                <span className="ordquick__sub"> · был {hhmm(row.visitStart)}</span>
              )}
            </span>
          </div>
        </div>
      )}

      {dense ? (
        <div className="runcard__facts">
          {/* Окно уже стоит в метке записи строкой выше — здесь только то,
              чего там нет: кто везёт и куда. */}
          <span className={'runcard__fact' + (free ? ' runcard__fact--bad' : '')}>
            {row.engineerName ?? 'без инженера'} · {row.district}
          </span>
        </div>
      ) : (
        /* Как заявка легла в план. Считается по расчёту и от прогона к
           прогону меняется — в отличие от полей ниже, которые пришли
           выгрузкой и одни и те же везде. */
        <dl className="engmetrics">
          <div className="engmetrics__row">
            <dt>Работа на объекте</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.estMinutes} мин</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Ширина окна</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{dec(width / 60)} ч</dd>
          </div>
          <div className={'engmetrics__row' + (slack <= 0 ? ' engmetrics__row--bad' : '')}>
            <dt>Запас до срока</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{dec(Math.max(0, slack) / 60)} ч</dd>
          </div>
          <div className={'engmetrics__row' + (slack <= 0 ? ' engmetrics__row--bad' : '')}>
            <dt>Крайний срок</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{deadline(row.slaDeadline)}</dd>
          </div>
          <div className={'engmetrics__row' + (urgent ? ' engmetrics__row--bad' : '')}>
            <dt>Приоритет</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{priorityClassName(row.priorityClass, row.priority)}</dd>
          </div>
          {row.status && (
            <div className="engmetrics__row">
              <dt>Состояние</dt>
              <span className="engmetrics__leader" aria-hidden="true" />
              <dd>{statusName(row.status)}</dd>
            </div>
          )}
          <div className={'engmetrics__row' + (free ? ' engmetrics__row--bad' : '')}>
            <dt>Инженер</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.engineerId ?? 'нет'}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Визит в маршруте</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.seq === null ? '—' : `№ ${row.seq + 1}`}</dd>
          </div>
        </dl>
      )}

      {/* Что о заявке говорит сама выгрузка. Пустые поля не рисуются: набор
          без технологии не должен показывать пустую строку «Технология». */}
      {!dense && (
        <dl className="engfacts">
          <div className="engfacts__row">
            <dt>Адрес</dt>
            <dd className="engfacts__stack">
              <span>{row.address}</span>
              <span className="engfacts__sub">{row.district}</span>
            </dd>
          </div>
          {row.orderClass && (
            <div className="engfacts__row">
              <dt>Класс</dt>
              <dd>{orderClassName(row.orderClass)}</dd>
            </div>
          )}
          {row.tech && (
            <div className="engfacts__row">
              <dt>Технология</dt>
              <dd className="engfacts__tight">
                {techName(row.tech)}
                {row.gigabit ? ' · гигабит' : ''}
              </dd>
            </div>
          )}
          {row.requiredEquipment.length > 0 && (
            <div className="engfacts__row">
              <dt>Везти</dt>
              <dd>{row.requiredEquipment.map(equipmentName).join(', ')}</dd>
            </div>
          )}
          {row.requiredTransport && (
            <div className="engfacts__row">
              <dt>
                Транспорт
                <WhyMark text={requiredTransportWhy(row.requiredTransport, row.workType)} />
              </dt>
              <dd className="engfacts__tight">{requiredTransportName(row.requiredTransport)}</dd>
            </div>
          )}
          {/* Кто заказал — компания, а не контактное лицо. Контакт это тот,
              кому звонить у подъезда; заказчик — тот, с кем договор, и
              вопрос «чья это заявка» задают именно о нём. Имя с телефоном
              осталось подчинённой строкой: оно нужно в дороге, а не при
              чтении справочника. */}
          <div className="engfacts__row">
            <dt>Клиент</dt>
            <dd className="engfacts__stack">
              <span>{row.company}</span>
              {row.contactName && (
                <span className="engfacts__sub">
                  {row.contactName}
                  {row.contactPhone ? ` · ${row.contactPhone}` : ''}
                </span>
              )}
            </dd>
          </div>
        </dl>
      )}

      {/* Признаки заявки — тем же рядом, что навыки у инженера: просто то,
          чем эта заявка отличается от соседней. Навык подсвечен, когда
          совпадает с отбором наверху. */}
      {!dense && (
        <div className="runcard__actions engcard__skills">
          <span
            className={'chip chip--sm' + (workType.includes(row.workType) ? ' chip--on' : '')}
          >
            <Icon name={skillIcon(row.skill)} size={12} />
            {skillName(row.skill)}
          </span>
          {row.needsAccess && (
            <span className="chip chip--sm">
              <Icon name="house" size={12} />
              Нужен доступ
            </span>
          )}
        </div>
      )}

      {/* В каких ещё сохранённых расчётах встречается тот же номер. Строка
          отвечает на «считали ли её ещё где-то»: номера в прогонах
          повторяются, и заявка, которую в одном расчёте никто не взял, в
          другом могла лечь в маршрут. */}
      {!dense && others.length > 0 && (
        <div className="engcard__runs">
          <span className="engcard__runs-label">Есть также в:</span>
          {others.map((ref) => (
            <span key={ref.runId} className="chip chip--sm">
              {ref.code}
            </span>
          ))}
        </div>
      )}

    </article>
  );
}
