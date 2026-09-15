import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineerRecord } from '../data/registry.ts';
import { dec, hhmm, hoursText, pluralWord } from '../data/derive.ts';
import { shiftWhy, transportWhy } from '../data/rationale.ts';
import { teamName } from '../data/dictionary.ts';
import { WhyMark } from './WhyMark.tsx';
import { PersonName } from './PersonName.tsx';
import {
  skillIcon,
  skillName,
  transportIcon,
  transportShort
} from '../data/dictionary.ts';

interface Props {
  row: EngineerRecord;
  /** Какой по счёту в списке. Список отбирают и переупорядочивают, поэтому
      номер приходит снаружи: карточка своего места в ряду не знает. */
  seat?: number;
  /** Открыть профиль. Нет — карточка не нажимается. Правка внутри профиля,
      у карточки в списке своей кнопки правки больше нет — двух путей к
      одному диалогу правки не нужно. */
  onOpen?: () => void;
  /** Время за выбранный срок, минуты: работа на объектах плюс дорога.
      Считает база — она одна знает, какой срок сейчас выбран. Без неё
      карточка показывает занятость, как показывала раньше. */
  workedMinutes?: number;
  /** Из чего это время сложилось. */
  workMinutes?: number;
  travelMinutes?: number;
  /** Снимок инженера, путь от корня сайта. Раздаёт его база — карточка только
      показывает и не знает, откуда он взялся. */
  photo?: string;
  /** Строка истории вместо карточки: без ряда смен, навыков и половины цифр. */
  dense?: boolean;
  /** Навык, по которому сейчас отобран список: в карточке он помечен, чтобы
      было видно, за что инженер сюда попал. Щелчок по любому навыку меняет
      отбор — то же, что и в полосе сверху, только под рукой. */
  skill?: string | null;
  onSkill?: (key: string) => void;
}


/* Карточка инженера. Собрана по образцу карточки расчёта, и это не сходство
   ради сходства: обе базы отвечают на один и тот же вопрос — «что у нас есть
   и каково оно», — и раз уж диспетчер научился читать карточку расчёта, то
   же место в карточке инженера должно значить то же самое. Номер сверху,
   метка записи под ним, картинка в середине, главное число, факты мелким,
   действия внизу.

   Вместо карты дня — фотография. Расчёты различают цифрами: у них нет лица,
   и картинка в карточке единственная возможность показать, чем один день
   отличается от другого. Людей различают по лицу — и диспетчер, который
   ищет в списке Семёнова, узнаёт его быстрее, чем прочитает фамилию. Любая
   диаграмма на этом месте отвечала бы на вопрос, которого он здесь не
   задаёт: цифры смены стоят рядом и сказаны словами. */
export function EngineerCard({
  row,
  seat,
  onOpen,
  photo,
  dense = false,
  skill = null,
  onSkill,
  workedMinutes,
  workMinutes,
  travelMinutes
}: Props) {
  const idle = row.idleRuns > 0;
  const sameShift =
    row.posts.length <= 1 ||
    row.posts.every(
      (post) => post.shiftStart === row.posts[0].shiftStart && post.shiftEnd === row.posts[0].shiftEnd
    );
  const loose = row.occupancyMean > 0 && row.occupancyMean < 0.6;

  return (
    /* Вся карточка — вход в профиль. Кнопка правки и значки внутри неё живут
       своей жизнью: нажатие на них до карточки не доходит, иначе правка
       открывала бы заодно и профиль. */
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
          <span className="runcard__code engcard__name" title={row.name}>
            <PersonName name={row.name} stacked={!dense} />
          </span>
          {/* Метка на месте пометки «открыт» у расчёта: там она говорит
              «этот расчёт сейчас в работе», здесь — «этот человек в
              последних прогонах оставался без маршрута». И там и там это
              единственное состояние записи, о котором стоит знать до того,
              как читать цифры. */}
          {idle && (
            <span
              className="runcard__open engcard__idle"
              title={`Оставался без маршрута: ${row.idleRuns} из ${row.runs} прогонов`}
              aria-label="Оставался без маршрута"
            >
              <Icon name="clock" size={12} />
            </span>
          )}
        </span>
        {/* Табельный — тем же значком, что и в профиле: правый верхний угол
            карточки и правый верхний угол профиля должны называть человека
            одинаково, иначе кажется, что это два разных номера. Подпись
            «id:» перед ним серая и мельче — читается как подсказка к
            номеру, а не спорит с ним весом. */}
        {!dense && (
          <span className="engcard__idwrap">
            <span className="engcard__idlabel">id:</span>
            <span className="crewpro__id engcard__idbadge">{row.id}</span>
          </span>
        )}
      </div>

      {/* Под именем — смена: то же место, где у расчёта стоит время, когда
          его завели. Это метка записи, а не её итог. */}
      <span className="runcard__stamp">
        {/* Номер по списку — первым, до часов: им карточку называют вслух и
            по нему её находят глазами в длинном ряду. */}
        {seat !== undefined && (
          <span className="engcard__seat">#{String(seat).padStart(3, '0')}</span>
        )}
        <Icon name="clock" size={12} />
        {/* График не свойство человека: он считается по нарядам дня, и у
            того, кто работает на двух участках, смены расходятся. Одну из
            них в шапке показывать нельзя — вторая пропадёт молча. Когда они
            расходятся, шапка говорит об этом, а сами смены стоят у своих
            участков ниже. */}
        {sameShift ? `${hhmm(row.shiftStart)}–${hhmm(row.shiftEnd)}` : 'смена по участкам'}
        {!dense && <WhyMark text={shiftWhy} />}
      </span>

      {!dense && (
        /* Снимок кадрируется по верхней трети: портреты сняты по-разному, но
           лицо в них всегда выше середины, и кадр по центру срезал бы его у
           вертикальных. */
        <div className="engphoto">
          {photo ? (
            <img className="engphoto__img" src={photo} alt="" loading="lazy" />
          ) : (
            /* Пока снимка нет, место под него остаётся: карточки без фото не
               должны быть на голову ниже соседних — ряд разъезжается. */
            <span className="engphoto__blank" aria-hidden="true">
              {row.name.slice(0, 1)}
            </span>
          )}
        </div>
      )}

      {/* Главное число — часы за выбранный срок. Занятость отвечала на
          другой вопрос: она про плотность одного маршрута и не растёт от
          того, что человек отработал больше смен. Подпись не говорит
          «отработано»: число складывает работу на объектах и дорогу между
          ними, а дорога — не работа в этом смысле слова, инженер в пути
          занят, но не «отрабатывает». */}
      {workedMinutes === undefined ? (
        <>
          <span className="runcard__value">
            {dec(row.occupancyMean * 100)}
            <span className="runcard__unit">%</span>
          </span>
          <span className="runcard__label">
            {dense ? 'Занятость' : 'Средняя занятость маршрута'}
          </span>
        </>
      ) : (
        <>
          <span className="runcard__value">
            {dec(workedMinutes / 60)}
            <span className="runcard__unit">ч</span>
          </span>
          <span className="runcard__label">
            {dense ? 'Часы' : 'Рабочие часы'}
          </span>
        </>
      )}

      {/* Визиты и переработка — сразу под главным числом, в одну строку и
          собственными крупными числами: это те два факта о человеке,
          которые спрашивают чаще остальных, и мелкой подписью через запятую
          они терялись бы рядом с настоящим заголовком карточки. */}
      {!dense && (
        <div className="engquick">
          <div className="engquick__tile">
            <span className="engquick__value">{row.visits}</span>
            <span className="engquick__label">
              {pluralWord(row.visits, 'визит', 'визита', 'визитов')}
            </span>
          </div>
          <div className={'engquick__tile' + (row.overtimeMinutes > 0 ? ' engquick__tile--bad' : '')}>
            <span className="engquick__value">
              {row.overtimeMinutes > 0 ? hoursText(row.overtimeMinutes) : '0'}
            </span>
            <span className="engquick__label">переработки</span>
          </div>
        </div>
      )}

      {dense ? (
        <div className="runcard__facts">
          <span className={'runcard__fact' + (idle ? ' runcard__fact--bad' : '')}>
            <b>{row.visits}</b> визитов · <b>{row.routes}</b> из {row.runs} смен
          </span>
        </div>
      ) : (
        /* Строка-другая сплошным текстом («6 ч 15 мин работа · 1 ч 0 мин
           дорога») читается медленно: числа и слова перемешаны, и глазу не
           за что зацепиться. Список «подпись — значение», тот же приём, что
           и у полей ниже (транспорт, участок), — подпись слева тихо, число
           справа и жирным, и колонка чисел читается охватом сразу. Визиты и
           переработка отсюда ушли выше, к главному числу — повторять их
           здесь незачем. */
        <dl className="engmetrics">
          <div className="engmetrics__row">
            <dt>Работа</dt>
            <dd>{hoursText(workMinutes ?? row.workMinutes)}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Дорога</dt>
            <dd>{hoursText(travelMinutes ?? row.travelMinutes)}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Маршрутом</dt>
            <dd>{row.routes} из {row.runs}</dd>
          </div>
          <div className={'engmetrics__row' + (idle ? ' engmetrics__row--bad' : '')}>
            <dt>Без маршрута</dt>
            <dd>{row.idleRuns}</dd>
          </div>
          <div className={'engmetrics__row' + (loose ? ' engmetrics__row--bad' : '')}>
            <dt>Занятость</dt>
            <dd>{dec(row.occupancyMean * 100)} %</dd>
          </div>
        </dl>
      )}

      {/* Что о человеке говорит сама выгрузка. Стоит отдельно от цифр
          маршрута: те считаются по расчётам и меняются от прогона к прогону,
          а это — карточка сотрудника, и она одна и та же в любом расчёте.
          Пустые поля не рисуются: набор, где транспорт не указан, не должен
          показывать пустую строку «Транспорт». */}
      {!dense && (
        <dl className="engfacts">
          {row.transport && (
            /* Значок объяснения стоит у подписи, а не у значения: в колонке
               значения он отъедал четверть ширины, и «Общ. транспорт»
               переносился на вторую строку. */
            <div className="engfacts__row">
              <dt>
                Транспорт
                <WhyMark text={transportWhy(row.transport)} />
              </dt>
              <dd className="engfacts__tight">
                <Icon name={transportIcon(row.transport)} size={12} />
                {transportShort(row.transport)}
              </dd>
            </div>
          )}
          {row.team && (
            /* Слово «Бригада» стоит подписью и снято со значения: в двух
               зонах из трёх выгрузка пишет «Бригада Попов», и вместе с
               подписью выходило «Бригада · Бригада Попов». */
            <div className="engfacts__row">
              <dt>Бригада</dt>
              <dd>{teamName(row.team)}</dd>
            </div>
          )}
          {row.posts.map((post) => (
            /* Участок вместе с адресом офиса: адрес — свойство участка, а не
               человека, и в своей строке он перестаёт выглядеть личным.
               Строк столько, сколько участков: тот, кто работает в двух
               зонах, выезжает из двух разных офисов. */
            <div className="engfacts__row" key={post.zone}>
              <dt>Участок</dt>
              <dd className="engfacts__stack">
                <span>
                  {post.zone}
                  <span className="engfacts__shift">
                    {' '}
                    ({hhmm(post.shiftStart)}–{hhmm(post.shiftEnd)})
                  </span>
                </span>
                {post.homeAddress && (
                  <span className="engfacts__sub">выезд: {post.homeAddress}</span>
                )}
              </dd>
            </div>
          ))}
          {row.phone && (
            <div className="engfacts__row">
              <dt>Телефон</dt>
              <dd>{row.phone}</dd>
            </div>
          )}
        </dl>
      )}

      {/* Навыки стоят там же, где у расчёта действия, и работают как действия:
          щелчок отбирает список по навыку. Открывать у инженера нечего — своей
          страницы у него нет, — а «кто ещё это умеет» спрашивают о нём чаще
          всего. */}
      {!dense && (
        <div className="runcard__actions engcard__skills">
          {row.skills.map((key) => (
            <button
              key={key}
              type="button"
              className={'chip chip--sm' + (skill === key ? ' chip--on' : '')}
              onClick={() => onSkill?.(key)}
              aria-pressed={skill === key}
              title={
                skill === key ? `Снять отбор по навыку «${skillName(key)}»` : `Показать всех, кто умеет «${skillName(key)}»`
              }
            >
              <Icon name={skillIcon(key)} size={12} />
              {skillName(key)}
            </button>
          ))}
        </div>
      )}
    </article>
  );
}
