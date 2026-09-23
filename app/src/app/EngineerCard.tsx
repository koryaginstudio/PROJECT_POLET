import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineerRecord } from '../data/registry.ts';
import { capitalize, dec, hhmm, hoursText, pluralWord } from '../data/derive.ts';
import { transportWhy } from '../data/rationale.ts';
import { teamName } from '../data/dictionary.ts';
import { WhyMark } from './WhyMark.tsx';
import { PersonName } from './PersonName.tsx';
import { skillIcon, skillName, transportShort } from '../data/dictionary.ts';
import { looseShare } from '../screens/db/DbHead.tsx';

/** Бригада, если она не сводится к самому человеку. В выгрузке заказчика
    поле «бригада» у большинства заполнено именем самого инженера, а у
    одного — «Бригада Каушнян», где Каушнян он сам. Показывать в строке
    «Бригада» фамилию того, о ком строка, — значит повторить заголовок
    карточки; такое читается как пустое, и пустым и показывается. */
export function crewTeam(row: Pick<EngineerRecord, 'name' | 'team'>): string | null {
  if (!row.team) return null;
  const team = teamName(row.team).trim().toLowerCase();
  const name = row.name.trim().toLowerCase();
  const surname = name.split(/\s+/)[0] ?? name;
  if (!team || team === name || team === surname) return null;
  return teamName(row.team);
}

/** Конфликт штата: человек числится в двух участках, и смены в них
    накладываются друг на друга. В один день его ждут в двух местах разом —
    это ошибка данных, и молчать о ней карточка не должна. Участки со
    сменами, которые не пересекаются (утро в одном, вечер в другом), —
    не конфликт. */
export function postsClash(row: Pick<EngineerRecord, 'posts'>): boolean {
  const posts = row.posts;
  if (posts.length < 2) return false;
  for (let i = 0; i < posts.length; i += 1) {
    for (let j = i + 1; j < posts.length; j += 1) {
      const a = posts[i];
      const b = posts[j];
      if (a.shiftStart < b.shiftEnd && b.shiftStart < a.shiftEnd) return true;
    }
  }
  return false;
}

/* Числительное словом. Участков у человека бывает и три: пока штат приходил
   разрозненными записями, больше двух в одной не сходилось, и текст метки был
   написан на «двух» намертво. */
const COUNT_WORDS: Record<number, string> = { 2: 'двух', 3: 'трёх', 4: 'четырёх' };

/** Текст метки конфликта — один на карточку, строку и таблицу. */
export const clashText = (posts: number) =>
  `в ${COUNT_WORDS[posts] ?? 'нескольких'} участках, смены пересекаются`;

/** Перечисление словами: «Восток, Юго-восток и Югоцентр». Склейка через «и»
   давала «Восток и Юго-восток и Югоцентр» — на двух это читалось, на трёх
   уже нет. */
export function listWords(items: string[]): string {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`;
}

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
  /** Навыки, по которым сейчас отобран список: в карточке они помечены, чтобы
      было видно, за что инженер сюда попал. Отбирают навыками в полосе
      фильтров сверху — здесь они только подсвечены, не нажимаются: карточка
      целиком открывает профиль, и щелчок по навыку внутри неё раньше и
      открывал профиль, и молча менял фильтр всего списка, что читалось как
      сбой, а не как две разные команды одним нажатием. */
  skills?: string[];
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
  skills = [],
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
  const clash = postsClash(row);
  /* Порог недогруза — общий на все базы, а не своё число в каждой карточке. */
  const loose = row.occupancyMean > 0 && row.occupancyMean < looseShare();
  const team = crewTeam(row);
  /* Расчёты, где у него был маршрут — от свежего к старому: тот, который
     считали последним, интереснее того, что случился месяц назад. */
  const routedRuns = [...row.byRun].reverse().filter((shift) => shift.routed);

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
              title={`Оставался без маршрута: ${row.idleRuns} из ${row.runs} расчётов`}
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
            <span className="crewpro__id engcard__idbadge">{row.code}</span>
            {/* Номер программы расчёта повторяется на каждом участке: рядом
                с ним — участок, иначе три карточки E00 не различить. */}
            {row.id.includes(':') && row.zone && (
              <span className="engcard__idlabel">{row.zone}</span>
            )}
          </span>
        )}
        {/* Значок и время — одна пара, а не три равноудалённых элемента:
            общий `gap` строки давал часам ту же дистанцию до значка, что и
            значку до номера, и значок читался подвешенным между двумя
            текстами, а не подписью к времени. */}
        <span className={'engcard__shift' + (clash ? ' engcard__clash' : '')}>
          <Icon name={clash ? 'warning' : 'clock'} size={12} />
          {/* График не свойство человека: он считается по нарядам дня, и у
              того, кто работает на двух участках, смены расходятся. Одну из
              них в шапке показывать нельзя — вторая пропадёт молча. Когда они
              расходятся, шапка говорит об этом, а сами смены стоят у своих
              участков ниже. Когда они ещё и накладываются, это уже не
              график, а конфликт штата — и место смены занимает красная
              метка. */}
          {clash
            ? clashText(row.posts.length)
            : sameShift
              ? `${hhmm(row.shiftStart)}–${hhmm(row.shiftEnd)}`
              : 'смена по участкам'}
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
              {capitalize(pluralWord(row.visits, 'заявка', 'заявки', 'заявок'))}
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
            <b>{row.visits}</b> заявок · <b>{row.routes}</b> из {row.runs} смен
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
            <dt>Маршрутов</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.routes}</dd>
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
          {team && (
            /* Слово «Бригада» стоит подписью и снято со значения: в двух
               зонах из трёх выгрузка пишет «Бригада Попов», и вместе с
               подписью выходило «Бригада · Бригада Попов». Строки нет
               вовсе, когда бригада названа именем самого инженера: см.
               `crewTeam`. */
            <div className="engfacts__row">
              <dt>Бригада</dt>
              <dd>{team}</dd>
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
            <span key={key} className={'chip chip--sm' + (skills.includes(key) ? ' chip--on' : '')}>
              <Icon name={skillIcon(key)} size={12} />
              {skillName(key)}
            </span>
          ))}
        </div>
      )}

      {/* В каких из сохранённых расчётов он занят — внизу, отдельной строкой
          от навыков: те про то, чем он владеет вообще, эти — про конкретные
          расчёты, где он стоит в плане. Расчёт, куда он вышел, но остался
          без маршрута, сюда не попадает: строка отвечает на «где он в
          деле», а не «где он числится». */}
      {!dense && routedRuns.length > 0 && (
        <div className="engcard__runs">
          <span className="engcard__runs-label">Участвует в:</span>
          {routedRuns.map((shift) => (
            <span key={shift.runId} className="chip chip--sm">
              {shift.code}
            </span>
          ))}
        </div>
      )}

    </article>
  );
}
