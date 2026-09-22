import { Icon } from '../ds/components/core/Icon.jsx';
import type { ClientRecord } from '../data/registry.ts';
import { capitalize, pluralWord } from '../data/derive.ts';
import { workTypeIcon } from '../data/dictionary.ts';
import { service } from '../data/service.ts';

interface Props {
  row: ClientRecord;
  /** Сколько всего расчётов в базе — чтобы сказать «в 2 из 3», а не «в 2». */
  runsTotal: number;
  /** Подписи видов работ: их состав задают данные, и в коде карточки
      восемнадцать заголовков из выгрузки не перечислить. */
  workTypeTitle: Record<string, string>;
  /** Строка списка вместо карточки: без фактов и половины цифр. */
  dense?: boolean;
  /** Вид работ, по которому сейчас отобран список: в карточке он помечен,
      чтобы было видно, за что адрес сюда попал. */
  workType?: string | null;
  /** Щелчок по карточке открывает запись. Без него карточка только
      показывает: обещать открытие там, где открывать нечего, нельзя. */
  onOpen?: () => void;
}

/* Карточка клиента. Собрана по образцу карточек расчёта и инженера, и это не
   сходство ради сходства: три базы отвечают на один вопрос — «что у нас есть
   и каково оно», — и одно и то же место в карточке обязано значить одно и то
   же. Номер сверху, метка записи под ним, главное число, факты мелким, чипы
   внизу.

   Классы рядов цифр и списков фактов взяты у карточки инженера вместе с их
   именами (`engquick`, `engmetrics`, `engfacts`). Второе имя для той же вещи
   означало бы вторую копию тех же стилей, которая начнёт расходиться с
   первой на первой же правке.

   Картинки в середине нет. У расчёта там карта дня, у инженера лицо, у
   маршрута своя линия — и каждая отвечает на вопрос, на который не отвечают
   числа. У клиента такого вопроса не нашлось: логотипов в выгрузке нет, и
   на их месте семьдесят пикселей занимала пустая рамка с надписью «логотип»
   — в каждой из ста девяноста пяти карточек. Ряд от её снятия не
   разъезжается: сняли у всех разом. Координат тоже нет: «55,6758, 37,6040»
   диспетчеру не говорит ничего, а адрес и так стоит в шапке. */
export function ClientCard({
  row,
  runsTotal,
  workTypeTitle,
  dense = false,
  workType = null,
  onOpen
}: Props) {
  const rate = row.orders === 0 ? 0 : row.assigned / row.orders;
  const missed = row.orders - row.assigned;
  /* В метке записи — улица и дом, без города. Город в адресе стоит первым и в
     карточке не различает ничего: из ста девяноста пяти адресов сто
     восемьдесят пять московские, а у подмосковных город и район — одно и то
     же слово, и оно стоит строкой ниже. Съедал он при этом целую строку из
     трёх: колонка карточки узкая, и «Москва,» выталкивало номер дома за край.
     Полный адрес остаётся в подсказке.

     Режем только там, где после города остаётся и улица, и дом, — то есть
     запятых не меньше двух. Адрес без города («Мантулинская улица, 2») от
     такой стрижки лишился бы улицы, а точка, опознанная одним районом, —
     всего названия. */
  const comma = row.address.indexOf(', ');
  const cut = comma > 0 && row.address.indexOf(', ', comma + 2) > 0;
  const street = cut ? row.address.slice(comma + 2) : row.address;
  /* Адрес, до которого доезжают не всегда, — это единственное состояние
     записи, о котором стоит знать до того, как читать цифры. То же место, где
     у расчёта стоит пометка «открыт», а у инженера — «оставался без
     маршрута». Граница «плохо» — та же, что у покрытия в настройках сервиса:
     два числа об одном и том же не должны краснеть по разным правилам. */
  const poor = rate * 100 < service().thresholds.coverageBad;

  return (
    /* Вся карточка — вход в запись: значки внутри живут своей жизнью, но
       отдельных кнопок у неё нет. Тот же приём, что у карточки заявки:
       обёртка кнопкой не годится — кнопка в кнопке не работает ни мышью,
       ни с клавиатуры. */
    <article
      className={'runcard runcard--flat' + (onOpen ? ' runcard--open' : '') + (dense ? ' runcard--dense' : '')}
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
        <span className="runcard__ident clicard__ident">
          {/* Первым — кто заказывает, а не куда ехать. Адрес отвечает на
              «куда», и это вопрос маршрута; в базе клиентов вопрос другой —
              «кто это и сколько мы для него сделали». Диспетчер ищет здесь
              сеть магазинов или клинику, а не дом: дом он и так увидит в
              заявке. Адрес стоит строкой ниже, на месте метки записи.

              Название обрезается в две строки, целиком читается подсказкой:
              длинное название в три-четыре строки растило карточку, и ряд
              карточек расходился по высоте. */}
          <span className="runcard__code clicard__name" title={row.company}>
            {row.company}
          </span>
          {/* Красная плашка со словом, а не голый значок. Значок треугольника
              в углу карточки не говорит, что именно не так, — а сказать надо
              одно: до этого клиента доезжают не всегда. Сделано тем же
              приёмом, что «Срочная» у заявки: одна беда — одна плашка, и
              читается она, а не расшифровывается. */}
          {poor && (
            <span
              className="ordcard__urgent"
              title={`Обслужено ${row.assigned} из ${row.orders} заявок: каждая пятая и чаще остаётся без инженера`}
            >
              <Icon name="warning" size={11} />
              Проблема
            </span>
          )}
        </span>
        {/* Сквозной номер точки, а не её место в списке. Позиция менялась от
            каждой смены сортировки и означала лишь «третий сверху при этом
            отборе» — назвать по ней клиента было нельзя, а именно за этим к
            номеру и обращаются. */}
        <span className="engcard__seat clicard__code" title="Номер точки обслуживания">
          {row.code}
        </span>
      </div>

      {/* Под названием — адрес и район: то же место, где у расчёта время
          записи, а у инженера смена. Это метка записи, а не её итог: одна и
          та же компания встречается в базе несколькими точками, и различают
          их как раз адресом. Полный адрес, с городом, — в подсказке; строки
          «Полный адрес» ниже больше нет, она повторяла эту. */}
      <span className="runcard__stamp clicard__stamp">
        <span className="clicard__where" title={row.address}>
          <Icon name="map-pin" size={12} />
          {street}
        </span>
        {/* Названия районов бывают длиннее строки — «Орехово Борисово
            Северное» не встаёт ни в какую ширину карточки. Такое обрывается
            многоточием, а целиком читается подсказкой. */}
        <span className="clicard__district" title={row.district}>
          {row.district}
        </span>
      </span>

      {dense ? (
        <>
          <span className="runcard__value">
            {row.orders}
            <span className="runcard__unit">
              {' '}
              {pluralWord(row.orders, 'заявка', 'заявки', 'заявок')}
            </span>
          </span>
          <span className="runcard__label">За всё время</span>
        </>
      ) : (
        /* Три числа в одной строке: заявок, обслужено, срочных — их
           спрашивают друг за другом. Заявки крупнее: это первый ответ на
           «что это за адрес», остальные — уточнение к нему. */
        <div className="engquick clicard__quick">
          <div className="engquick__tile engquick__tile--main">
            <span className="engquick__value">{row.orders}</span>
            <span className="engquick__label">
              {capitalize(pluralWord(row.orders, 'заявка', 'заявки', 'заявок'))}
            </span>
          </div>
          <div className={'engquick__tile' + (poor ? ' engquick__tile--bad' : '')}>
            <span className="engquick__value">
              {Math.round(rate * 100)}
              <span className="engquick__unit">%</span>
            </span>
            {/* «Покрытие», а не «обслужено»: тем же словом эта доля названа
                в таблице рядом, в карточке расчёта и в сводке дня — один
                интерфейс, и одна величина не должна менять имя от экрана к
                экрану. Оно же на две буквы короче, и в узкой плитке помещается
                целиком, тогда как «обслужено» обрывалось на последней. */}
            <span className="engquick__label">Покрытие</span>
          </div>
          <div className={'engquick__tile' + (row.urgent > 0 ? ' engquick__tile--bad' : '')}>
            <span className="engquick__value">{row.urgent}</span>
            <span className="engquick__label">Срочных</span>
          </div>
        </div>
      )}

      {dense ? (
        <div className="runcard__facts">
          <span className={'runcard__fact' + (poor ? ' runcard__fact--bad' : '')}>
            <b>{row.assigned}</b> обслужено · <b>{missed}</b> без инженера
          </span>
        </div>
      ) : (
        /* Список «подпись — значение», тот же приём, что и в карточке
           инженера: подпись слева тихо, число справа и жирным, и колонка
           чисел читается охватом сразу. */
        <dl className="engmetrics">
          <div className="engmetrics__row">
            <dt>Обслужено</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>
              {row.assigned} из {row.orders}
            </dd>
          </div>
          <div className={'engmetrics__row' + (missed > 0 ? ' engmetrics__row--bad' : '')}>
            <dt>Без инженера</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{missed}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Средняя работа</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.avgMinutes} мин</dd>
          </div>
          <div className="engmetrics__row">
            <dt>В расчётах</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>
              {row.runs} из {runsTotal}
            </dd>
          </div>
        </dl>
      )}

      {/* Виды работ — просто список того, что здесь заказывали. Отбор по виду
          живёт в полосе фильтров над списком; здесь чип только подсвечен,
          когда совпадает с активным там фильтром. */}
      {!dense && row.workTypes.length > 0 && (
        <div className="runcard__actions clicard__types">
          {row.workTypes.map((type) => (
            <span
              key={type}
              className={'chip chip--sm' + (workType === type ? ' chip--on' : '')}
            >
              <Icon name={workTypeIcon(type)} size={12} />
              {workTypeTitle[type] ?? type}
            </span>
          ))}
        </div>
      )}

    </article>
  );
}
