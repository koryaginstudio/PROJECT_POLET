import { Icon } from '../ds/components/core/Icon.jsx';
import type { ClientRecord } from '../data/registry.ts';
import { capitalize, dec, pluralWord } from '../data/derive.ts';
import { workTypeIcon } from '../data/dictionary.ts';

interface Props {
  row: ClientRecord;
  /** Сколько всего расчётов в базе — чтобы сказать «в 2 из 3», а не «в 2». */
  runsTotal: number;
  /** Подписи видов работ: их состав задают данные, и в коде карточки
      восемнадцать заголовков из выгрузки не перечислить. */
  workTypeTitle: Record<string, string>;
  /** Логотип клиента, путь от корня сайта. Пока его нет, на этом месте стоит
      пустая рамка — см. ниже, почему она не убирается. */
  logo?: string;
  /** Строка списка вместо карточки: без логотипа, фактов и половины цифр. */
  dense?: boolean;
  /** Вид работ, по которому сейчас отобран список: в карточке он помечен,
      чтобы было видно, за что адрес сюда попал. */
  workType?: string | null;
}

/* Карточка клиента. Собрана по образцу карточек расчёта и инженера, и это не
   сходство ради сходства: три базы отвечают на один вопрос — «что у нас есть
   и каково оно», — и одно и то же место в карточке обязано значить одно и то
   же. Номер сверху, метка записи под ним, картинка в середине, главное число,
   факты мелким, чипы внизу.

   Классы рядов цифр и списков фактов взяты у карточки инженера вместе с их
   именами (`engquick`, `engmetrics`, `engfacts`). Второе имя для той же вещи
   означало бы вторую копию тех же стилей, которая начнёт расходиться с
   первой на первой же правке.

   Вместо карты дня и лица — логотип. У расчёта нет лица, и карта в его
   карточке единственный способ показать, чем один день отличается от
   другого; человека узнают по лицу быстрее, чем прочитают фамилию. Клиента
   узнают по знаку: диспетчер, который ищет в списке нужный адрес, за него и
   цепляется. Самих логотипов у нас пока нет — выгрузка нарядов их не
   содержит, — поэтому на их месте стоит пустая рамка под горизонтальный
   знак. Рамка не убирается, пока знака нет: карточки без картинки были бы на
   голову ниже соседних, и ряд разъезжался бы. */
export function ClientCard({
  row,
  runsTotal,
  workTypeTitle,
  logo,
  dense = false,
  workType = null
}: Props) {
  const rate = row.orders === 0 ? 0 : row.assigned / row.orders;
  const missed = row.orders - row.assigned;
  /* В метке записи — улица и дом, без города. Город в адресе стоит первым и в
     карточке не различает ничего: из ста девяноста пяти адресов сто
     восемьдесят пять московские, а у подмосковных город и район — одно и то
     же слово, и оно стоит строкой ниже. Съедал он при этом целую строку из
     трёх: колонка карточки узкая, и «Москва,» выталкивало номер дома за край.
     Полный адрес остаётся в подсказке и в списке фактов.

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
     маршрута». */
  const poor = rate < 0.8;

  return (
    <article className={'runcard runcard--flat' + (dense ? ' runcard--dense' : '')}>
      <div className="runcard__head">
        <span className="runcard__ident clicard__ident">
          {/* Первым — кто заказывает, а не куда ехать. Адрес отвечает на
              «куда», и это вопрос маршрута; в базе клиентов вопрос другой —
              «кто это и сколько мы для него сделали». Диспетчер ищет здесь
              сеть магазинов или клинику, а не дом: дом он и так увидит в
              заявке. Адрес стоит строкой ниже, на месте метки записи. */}
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
          их как раз адресом. */}
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

      {!dense && (
        /* Место под горизонтальный знак клиента. Пропорция вытянутая, три к
           одному: логотипы компаний рисуют строкой — знак и название рядом, —
           и в квадрате такой знак ужимается до нечитаемого. */
        <div className="clilogo">
          {logo ? (
            <img className="clilogo__img" src={logo} alt="" loading="lazy" />
          ) : (
            <span className="clilogo__blank" aria-hidden="true">
              <Icon name="house" size={18} />
              <span className="clilogo__hint">логотип</span>
            </span>
          )}
        </div>
      )}

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

      {/* Что о точке говорит сама выгрузка. Города здесь больше нет: он и
          так срезан с заголовка, потому что из ста девяноста пяти адресов сто
          восемьдесят пять московские и различает он ровно десять. «Доступ в
          дом» и «Окно приёма» ушли туда же — оба про то, как ехать на
          конкретную заявку, а не про то, что это за клиент: база отвечает на
          «кто он и сколько мы для него сделали», и свойства отдельного визита
          ей не по адресу. Остались координаты — единственное, чем точка
          отличается от соседнего дома, когда адрес записан неточно. */}
      {!dense && (
        <dl className="engfacts">
          <div className="engfacts__row">
            <dt>Полный адрес</dt>
            <dd>{row.address}</dd>
          </div>
          <div className="engfacts__row">
            <dt>Координаты</dt>
            <dd className="engfacts__tight">
              {dec(row.lat, 4)}, {dec(row.lon, 4)}
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
