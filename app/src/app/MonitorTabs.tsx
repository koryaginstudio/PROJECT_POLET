import { Icon } from '../ds/components/core/Icon.jsx';
import { monitorCode, useMonitors } from '../data/monitor.ts';
import { pluralWord } from '../data/derive.ts';

interface Props {
  /** День мониторинга, который открыт сейчас: ISO, как и ключ записи. */
  active: string | null;
  /** Сегодняшний день: его запись — единственная живая, остальные прошлые. */
  today: string;
  onPick: (id: string) => void;
}

/* Сколько записей держим в ленте. Остальное остаётся в воротах раздела
   карточками: лента отвечает за «вернуться к недавнему», разбор — за
   «посмотреть, чем кончился день». */
const STRIP = 12;

const fullDate = (iso: string) => {
  const [year, month, day] = iso.split('-');
  return day ? `${day}.${month}.${year}` : iso;
};

/* Лента мониторингов в подшапке — то же, чем в диспетчерской служит лента
   расчётов.

   Диспетчер весь день сидит в живом виде, и вопрос «а как шёл вчерашний
   день» задаётся оттуда же, где смотрят сегодняшний. Прежде за ним
   приходилось выходить из наблюдения в ворота раздела, искать карточку и
   возвращаться обратно — три движения ради одного взгляда.

   Живая запись — одна, сегодняшняя, и она помечена точкой. Остальные
   прошлые: их план разложен на другой день, и переход в них спрашивает
   подтверждения — см. оболочку. */
export function MonitorTabs({ active, today, onPick }: Props) {
  const rows = useMonitors();

  if (rows.length === 0) {
    return (
      <div className="runtabs">
        <span className="runtabs__loading">Это первое наблюдение — прошлых записей нет</span>
      </div>
    );
  }

  const visible = rows.slice(0, STRIP);
  /* Открытый день виден всегда, даже если он старый и в последние не попал:
     иначе лента показывала бы выбор, которого в ней нет. */
  if (active && !visible.some((row) => row.id === active)) {
    const found = rows.find((row) => row.id === active);
    if (found) visible.push(found);
  }
  const rest = rows.length - visible.length;

  return (
    <div className="runtabs">
      <div className="runtabs__strip" role="tablist" aria-label="Мониторинг">
        {visible.map((row) => {
          const live = row.id === today;
          const on = row.id === active;
          const zones = row.parts.length || row.places.length;
          return (
            <button
              key={row.id}
              type="button"
              role="tab"
              aria-selected={on}
              className={'runtabs__item' + (on ? ' runtabs__item--active' : '')}
              onClick={() => onPick(row.id)}
              title={
                `${monitorCode(row.no)} · ${fullDate(row.id)}` +
                ` · ${zones} ${pluralWord(zones, 'район', 'района', 'районов')}` +
                ` · наблюдение с ${row.started}` +
                (live ? ' · сегодняшний' : ' · прошедший день')
              }
            >
              {/* Точка у сегодняшней записи: живое наблюдение одно, и
                  отличать его от прошлых приходится с одного взгляда. */}
              {live && <span className="montabs__live" aria-hidden="true" />}
              <span className="runtabs__code">{monitorCode(row.no)}</span>
              <span className="runtabs__meta">{fullDate(row.id)}</span>
            </button>
          );
        })}
      </div>

      {/* Остальное — в воротах раздела: там у каждой записи разбор по
          районам, а в строке его не показать. */}
      {rest > 0 && (
        <span className="runtabs__more runtabs__more--flat" title="Остальные записи — в списке прошедших мониторингов">
          <Icon name="stack" size={14} />
          <span className="runtabs__more-label">Ещё {rest}</span>
        </span>
      )}
    </div>
  );
}
