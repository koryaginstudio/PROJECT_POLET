import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineerRecord } from '../data/registry.ts';
import { capitalize, dec, hhmm, hoursText, pluralWord } from '../data/derive.ts';
import { transportWhy } from '../data/rationale.ts';
import { teamName } from '../data/dictionary.ts';
import { WhyMark } from './WhyMark.tsx';
import { PersonName } from './PersonName.tsx';
import { skillIcon, skillName, transportShort } from '../data/dictionary.ts';

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
      было видно, за что инженер сюда попал. Отбирают навыком в полосе
      фильтров сверху — здесь он только подсвечен, не нажимается: карточка
      целиком открывает профиль, и щелчок по навыку внутри неё раньше и
      открывал профиль, и молча менял фильтр всего списка, что читалось как
      сбой, а не как две разные команды одним нажатием. */
  skill?: string | null;
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
        {/* Номер по списку — в правом верхнем углу: место заметное, но само
            число служебное, и веса пилюли табельного ему не нужно. Виден и
            в плотном виде — там он раньше стоял в строке смены, и терять
            его при переходе в эту вёрстку незачем. */}
        {seat !== undefined && (
          <span className="engcard__seat">#{String(seat).padStart(3, '0')}</span>
        )}
      </div>

      {/* Под именем — смена: то же место, где у расчёта стоит время, когда
          его завели. Это метка записи, а не её итог. */}
      <span className="runcard__stamp">
        {/* Табельный — тем же значком, что и в профиле: он называет
            человека, и место рядом со сменой ему подходит не хуже угла
            карточки. Подпись «id:» перед ним серая и мельче — читается как
            подсказка к номеру, а не спорит с ним весом. */}
        {!dense && (
          <span className="engcard__idwrap">
            <span className="engcard__idlabel">id:</span>
            <span className="crewpro__id engcard__idbadge">{row.id}</span>
          </span>
        )}
        {/* Значок и время — одна пара, а не три равноудалённых элемента:
            общий `gap` строки давал часам ту же дистанцию до значка, что и
            значку до номера, и значок читался подвешенным между двумя
            текстами, а не подписью к времени. */}
        <span className="engcard__shift">
          <Icon name="clock" size={12} />
          {/* График не свойство человека: он считается по нарядам дня, и у
              того, кто работает на двух участках, смены расходятся. Одну из
              них в шапке показывать нельзя — вторая пропадёт молча. Когда они
              расходятся, шапка говорит об этом, а сами смены стоят у своих
              участков ниже. */}
          {sameShift ? `${hhmm(row.shiftStart)}–${hhmm(row.shiftEnd)}` : 'смена по участкам'}
        </span>
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

      {dense ? (
        /* В плотном виде — одно число, как и раньше: строка и без того
           короткая, третьему-четвёртому факту в ней не хватит места. */
        workedMinutes === undefined ? (
          <>
            <span className="runcard__value">
              {dec(row.occupancyMean * 100)}
              <span className="runcard__unit">%</span>
            </span>
            <span className="runcard__label">Занятость</span>
          </>
        ) : (
          <>
            <span className="runcard__value">
              {dec(workedMinutes / 60)}
              <span className="runcard__unit">ч</span>
            </span>
            <span className="runcard__label">Часы</span>
          </>
        )
      ) : (
        /* Все три числа в одной строке: часы, визиты, переработка — их
           спрашивают друг за другом, и разнесённые по разным строкам они
           читались как заголовок и что-то после него, а не как три равно
           важных факта о смене. Часы крупнее — это по-прежнему первый ответ,
           а не рядовой факт в общем ряду. */
        <div className="engquick">
          <div className="engquick__tile engquick__tile--main">
            {workedMinutes === undefined ? (
              <>
                <span className="engquick__value">
                  {dec(row.occupancyMean * 100)}
                  <span className="engquick__unit">%</span>
                </span>
                <span className="engquick__label">Занятость</span>
              </>
            ) : (
              <>
                <span className="engquick__value">
                  {dec(workedMinutes / 60)}
                  <span className="engquick__unit">ч</span>
                </span>
                <span className="engquick__label">Часы</span>
              </>
            )}
          </div>
          <div className="engquick__tile">
            <span className="engquick__value">{row.visits}</span>
            <span className="engquick__label">
              {capitalize(pluralWord(row.visits, 'визит', 'визита', 'визитов'))}
            </span>
          </div>
          <div className={'engquick__tile' + (row.overtimeMinutes > 0 ? ' engquick__tile--bad' : '')}>
            {/* Часы всегда десятичной дробью, «1,3 ч», а не «1 ч 20 мин»:
                это компактная строка из трёх чисел, а не таблица, и здесь
                важнее единообразие с двумя соседними числами, чем формат
                часов, который выбран в настройках сервиса. */}
            <span className="engquick__value">
              {dec(row.overtimeMinutes / 60)}
              <span className="engquick__unit">ч</span>
            </span>
            <span className="engquick__label">Переработки</span>
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
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{hoursText(workMinutes ?? row.workMinutes)}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Дорога</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{hoursText(travelMinutes ?? row.travelMinutes)}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Маршрутом</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.routes} из {row.runs}</dd>
          </div>
          <div className={'engmetrics__row' + (idle ? ' engmetrics__row--bad' : '')}>
            <dt>Без маршрута</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.idleRuns}</dd>
          </div>
          <div className={'engmetrics__row' + (loose ? ' engmetrics__row--bad' : '')}>
            <dt>Занятость</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
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
            // Без значка в значении: у соседних строк значение — голый
            // текст без отступа слева, а значок перед словом сдвигал бы
            // «Автомобиль» правее их на свою ширину. Значок транспорта и
            // так виден в трёх других местах карточки.
            <div className="engfacts__row">
              <dt>
                Транспорт
                <WhyMark text={transportWhy(row.transport)} />
              </dt>
              <dd className="engfacts__tight">{transportShort(row.transport)}</dd>
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

      {/* Навыки — просто список того, чем человек владеет. Отбор по навыку
          живёт в полосе фильтров над списком; здесь чип только подсвечен,
          когда совпадает с активным там фильтром, а не дублирует его —
          щелчок по нему внутри карточки, которая целиком ведёт в профиль,
          был лишней, скрытой командой поверх открытия профиля. */}
      {!dense && (
        <div className="runcard__actions engcard__skills">
          {row.skills.map((key) => (
            <span key={key} className={'chip chip--sm' + (skill === key ? ' chip--on' : '')}>
              <Icon name={skillIcon(key)} size={12} />
              {skillName(key)}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}
