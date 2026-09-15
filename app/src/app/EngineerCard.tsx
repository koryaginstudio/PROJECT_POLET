import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineerRecord } from '../data/registry.ts';
import { dec, hhmm, hoursText } from '../data/derive.ts';
import { skillIcon, skillName } from '../data/dictionary.ts';

interface Props {
  row: EngineerRecord;
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
export function EngineerCard({ row, photo, dense = false, skill = null, onSkill }: Props) {
  const idle = row.idleRuns > 0;
  const loose = row.occupancyMean > 0 && row.occupancyMean < 0.6;

  return (
    <article className="runcard runcard--flat">
      <div className="runcard__head">
        <span className="runcard__ident">
          <span className="runcard__code engcard__name" title={row.name}>
            {row.name}
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
        <span className="engcard__grade" title="Грейд инженера">
          {row.grade}
        </span>
      </div>

      {/* Под именем — смена и табельный номер: то же место, где у расчёта
          стоит время, когда его завели. Это метка записи, а не её итог. */}
      <span className="runcard__stamp">
        <Icon name="clock" size={12} />
        {hhmm(row.shiftStart)}–{hhmm(row.shiftEnd)}
        {!dense && <span className="engcard__id">{row.id}</span>}
      </span>

      {/* Откуда выезжает — на месте заметки расчёта, и место под неё держится
          всегда: иначе карточка без адреса съезжает вверх и весь ряд встаёт
          на разной высоте. */}
      <p className="runcard__note" title={row.homeAddress || undefined} aria-hidden={!row.homeAddress}>
        {row.homeAddress}
      </p>

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

      <span className="runcard__value">
        {dec(row.occupancyMean * 100)}
        <span className="runcard__unit">%</span>
      </span>
      <span className="runcard__label">{dense ? 'Занятость' : 'Средняя занятость маршрута'}</span>

      <div className="runcard__facts">
        {dense ? (
          <span className={'runcard__fact' + (idle ? ' runcard__fact--bad' : '')}>
            <b>{row.visits}</b> визитов · <b>{row.routes}</b> из {row.runs} смен
          </span>
        ) : (
          <>
            <span className="runcard__fact">
              <b>{row.routes}</b> из {row.runs} смен с маршрутом
            </span>
            <span className={'runcard__fact' + (idle ? ' runcard__fact--bad' : '')}>
              <b>{row.idleRuns}</b> смен без маршрута
            </span>
            <span className="runcard__fact">
              <b>{row.visits}</b> визитов · {hoursText(row.workMinutes)} в работе
            </span>
            <span className={'runcard__fact' + (loose ? ' runcard__fact--bad' : '')}>
              {hoursText(row.travelMinutes)} в дороге
              {row.overtimeMinutes > 0 ? ` · ${hoursText(row.overtimeMinutes)} сверх смены` : ''}
            </span>
          </>
        )}
      </div>

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
