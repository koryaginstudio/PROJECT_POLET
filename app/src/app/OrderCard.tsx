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
  /** Вид работ, по которому сейчас отобран список: в карточке он помечен,
      чтобы было видно, за что заявка сюда попала. Отбирают в полосе
      фильтров сверху — здесь метка только подсвечена и не нажимается. */
  workType?: string | null;
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
export function OrderCard({ row, seat, onOpen, dense = false, workType = null, runs = [] }: Props) {
  const urgent = isUrgent(row.priorityClass, row.priority);
  const free = !row.engineerId;
  /* Запас — сколько остаётся от закрытия окна до крайнего срока. Это и есть
     цена промаха: заявку, у которой запаса нет, переносить некуда. */
  const slack = row.slaDeadline - row.windowEnd;
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
          <span className="runcard__code ordcard__title" title={row.workTitle}>
            <Icon name={workTypeIcon(row.workType)} size={15} />
            {row.workTitle}
          </span>
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

      {/* Номер и окно приёма — то же место, где у инженера табельный и смена:
          метка записи, а не её итог. */}
      <span className="runcard__stamp">
        {!dense && (
          <span className="engcard__idwrap">
            <span className="engcard__idlabel">id:</span>
            <span className="crewpro__id engcard__idbadge">{row.id}</span>
          </span>
        )}
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

      {!dense && (
        /* Окно на шкале дня — та же полоса, что в панели заявки: одна заявка
           показана одинаково везде, где её показывают. */
        <div className="ordwin">
          <OrderWindow from={row.windowStart} to={row.windowEnd} risky={slack <= 0} />
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
        /* Три числа в строке, как у инженера: сколько работы, какое окно и
           сколько остаётся сверх окна до крайнего срока. Работа крупнее —
           это первый ответ, остальные два его обстоятельства. */
        <div className="engquick">
          <div className="engquick__tile engquick__tile--main">
            <span className="engquick__value">
              {row.estMinutes}
              <span className="engquick__unit">мин</span>
            </span>
            <span className="engquick__label">Работа</span>
          </div>
          <div className="engquick__tile">
            <span className="engquick__value">
              {dec(width / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">Окно</span>
          </div>
          <div className={'engquick__tile' + (slack <= 0 ? ' engquick__tile--bad' : '')}>
            <span className="engquick__value">
              {dec(Math.max(0, slack) / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">Запас</span>
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
          {row.contactName && (
            <div className="engfacts__row">
              <dt>Клиент</dt>
              <dd className="engfacts__stack">
                <span>{row.contactName}</span>
                {row.contactPhone && <span className="engfacts__sub">{row.contactPhone}</span>}
              </dd>
            </div>
          )}
        </dl>
      )}

      {/* Признаки заявки — тем же рядом, что навыки у инженера: просто то,
          чем эта заявка отличается от соседней. Навык подсвечен, когда
          совпадает с отбором наверху. */}
      {!dense && (
        <div className="runcard__actions engcard__skills">
          <span className={'chip chip--sm' + (workType === row.workType ? ' chip--on' : '')}>
            <Icon name={skillIcon(row.skill)} size={12} />
            {skillName(row.skill)}
          </span>
          {urgent && (
            <span className="chip chip--sm chip--danger">
              <Icon name="alert-triangle" size={12} />
              Срочная
            </span>
          )}
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
