import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import type { RunId } from '../data/load.ts';
import { runCode, shortStamp, whenLabel } from '../data/load.ts';
import type { WorkDay } from '../data/duty.ts';
import { takeDuty, useDuty, workDays } from '../data/duty.ts';
import { monthName, pluralWord, weekdayName } from '../data/derive.ts';
import { monitorCode, useMonitors } from '../data/monitor.ts';
import type { MonitorRun } from '../data/monitor.ts';
import type { Registry, RunStat } from '../data/registry.ts';
import { ZoneMap } from '../app/ZoneMap.tsx';
import { zonePalette } from '../data/zones.ts';

interface Props {
  /** Районы, отмеченные к наблюдению. */
  watched: string[];
  onWatch: (keys: string[]) => void;
  /** Открыть живой вид по отмеченным районам. */
  onEnter: () => void;
  /** Разобрать расчёт карточкой поверх экрана: прошедший мониторинг называет
      расчёты, которые вели его районы, и вопрос «а что это за план» задают
      прямо отсюда. */
  onOpenRun?: (id: RunId) => void;
  /** Справочник: из него карточка района берёт карту плана и его числа.
      Пусто, пока он грузится, — карточка тогда стоит без карты. */
  registry: Registry | null;
}

/* Вход в мониторинг: который сейчас час и по каким районам смотрим.

   Раздел начинается с сегодняшнего дня — крупно, как на часах в
   диспетчерской: живой вид отвечает на «что происходит сейчас», и первое,
   что он обязан сказать, — какое это «сейчас».

   Дальше районы. Смотреть за ними приходится разом: три района посчитаны
   порознь, а смена у диспетчера одна. Поэтому районы отмечают галочками, а
   расчёт каждому выбирают из списка под кнопкой — своим, потому что у
   каждого района свой план на этот день.

   Внизу — прошедшие мониторинги карточками, как расчёты в базе. Запись
   заводится сама при запуске наблюдения и получает сквозной номер; в ней
   лежит то, чего больше нигде нет, — разбор по районам: какой расчёт вёл
   район, сколько в нём было инженеров и сколько маршрутов они закрыли. */
export function MonitorGate({ watched, onWatch, onEnter, onOpenRun, registry }: Props) {
  /* Подписка на «взят в работу»: карточки районов читаются заново, когда
     расчёт меняют прямо на этом экране. */
  useDuty();
  const past = useMonitors();
  const days = workDays();

  /* Часы идут сами. Шаг в десять секунд: показываем минуты, и минута,
     сменившаяся с опозданием на полминуты, читается как стоящие часы. */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const weekday = weekdayName(now);
  const today = `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${now.getDate()} ${monthName(now)}`;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const ready = days.filter((day) => day.holder);


  /* Что предложить району без выбранного расчёта: самый свежий его расчёт.
     Он же встаёт в работу, когда район отмечают. */
  const offerOf = (day: WorkDay): RunId | null => day.holder ?? day.runs[0] ?? null;

  /* Отметить район — значит и сказать, каким планом его вести.

     Смотрят за районом по расчёту: без него живой вид не знает, чей план
     разложить, и отмеченный район молча выпал бы из наблюдения. Поэтому
     галочка на районе без выбранного расчёта сама берёт в работу
     предложенный — тот, что карточка и показывает картой. Захотят другой —
     сменят кнопкой, список под ней. */
  const toggle = (day: WorkDay) => {
    if (watched.includes(day.key)) {
      onWatch(watched.filter((one) => one !== day.key));
      return;
    }
    const offer = offerOf(day);
    if (!offer) return;
    if (!day.holder) takeDuty(offer, day.date);
    onWatch([...watched, day.key]);
  };

  /* Районы с выбранным расчётом отмечаются сами — один раз, на первый заход.

     Расчёт, взятый в работу, и есть ответ диспетчера на «чем ведём этот
     район сегодня»: спрашивать его второй раз галочкой значит заставлять
     повторять уже сказанное. Дальше отметки принадлежат диспетчеру: снял
     район — он остаётся снятым, и возвращать его на место экран не лезет. */
  const filled = useRef(false);
  useEffect(() => {
    if (filled.current || watched.length > 0) return;
    const onWork = days.filter((day) => day.holder).map((day) => day.key);
    if (onWork.length === 0) return;
    filled.current = true;
    onWatch(onWork);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days.length]);

  const allOn = days.length > 0 && days.every((day) => watched.includes(day.key));

  /* «Отметить все» доделывает и то, чего не хватает: район без расчёта
     молча отмеченным быть не может — смотреть за ним нечего, — поэтому
     кнопка ставит ему предложенный расчёт в работу и только потом
     отмечает. Это то же решение, что диспетчер принял бы вручную, просто
     сделанное разом для трёх районов. */
  const markAll = () => {
    if (allOn) {
      onWatch([]);
      return;
    }
    for (const day of days) {
      if (day.holder) continue;
      const offer = offerOf(day);
      if (offer) takeDuty(offer, day.date);
    }
    onWatch(days.filter((day) => offerOf(day)).map((day) => day.key));
  };

  const statOf = (id: RunId | null): RunStat | null =>
    id && registry ? (registry.stats.byRun.find((row) => row.run.id === id) ?? null) : null;

  /* Цвета районов — те же, что в живом виде: цвет берётся от названия, и
     карточка с картой мониторинга красят район одинаково. */
  const tints = zonePalette(days.map((day) => day.place));


  return (
    <div className="dash enter">
      <section className="panel mongate__hero">
        <span className="mongate__label">Мониторинг</span>
        <div className="mongate__now">
          <h2 className="mongate__day">{today}</h2>
          <span className="mongate__clock">{clock}</span>
        </div>

      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Районы на сегодня</h2>
          {days.length > 0 && (
            <button type="button" className="mday__all" onClick={markAll}>
              <Icon name={allOn ? 'x' : 'check-circle'} size={13} />
              {allOn ? 'Снять все' : 'Отметить все'}
            </button>
          )}
        </div>

        {days.length === 0 ? (
          <p className="clients__lede">
            Расчётов пока нет — смотреть не за чем. Начните с диспетчерской.
          </p>
        ) : (
          <>
            <div className="zonegrid">
              {days.map((day) => (
                <ZoneCard
                  key={day.key}
                  day={day}
                  offer={offerOf(day)}
                  stat={statOf(day.holder ?? offerOf(day))}
                  statOf={statOf}
                  bounds={registry?.bounds ?? null}
                  tint={tints.get(day.place) ?? '#4C7DF0'}
                  watched={watched.includes(day.key)}
                  onToggle={() => toggle(day)}
                />
              ))}
            </div>

            <div className="gatehero__actions">
              {/* Не «смотреть»: за этой кнопкой диспетчер разворачивает
                  мониторинг во весь экран и работает в нём весь день. Это
                  начало работы, и названа она так же, как везде, где день
                  берут в работу. Оранжевый — цвет действия во всём сервисе. */}
              <Button
                variant="accent"
                className="gatehero__cta"
                iconLeft={<Icon name="play" size={14} />}
                onClick={onEnter}
                disabled={watched.length === 0}
              >
                {watched.length === 0
                  ? 'Отметьте хотя бы один район'
                  : `В работу · ${watched.length} ${pluralWord(watched.length, 'район', 'района', 'районов')}`}
              </Button>
              {/* Счёт стоит у кнопки, а не в заголовке: это ответ на «можно
                  ли уже смотреть», и читают его перед нажатием. */}
              <span className="gatehero__note">
                {ready.length} из {days.length} районов с выбранным расчётом
              </span>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Прошедшие мониторинги</h2>
          <span className="dash__section-note">
            {past.length === 0
              ? 'записей пока нет'
              : `${past.length} ${pluralWord(past.length, 'запись', 'записи', 'записей')}`}
          </span>
        </div>

        {past.length === 0 ? (
          <p className="clients__lede">
            Запись заводится сама, когда день берут в работу: отметьте районы и нажмите «В
            работу» — этот мониторинг встанет здесь карточкой со своим номером. На день
            запись одна: к ней подтягивается всё, что за день наблюдали.
          </p>
        ) : (
          <div className="monlist">
            {past.map((row) => (
              <MonitorCard key={row.id} row={row} onOpenRun={onOpenRun} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* Карточка района — той же породы, что карточка расчёта в базе: имя сверху,
   земля участка картой, числа плана под ней и выбор расчёта внизу.

   Картой, а не строкой: «Восток» — слово, которое ничего не говорит тому,
   кто не помнит нарезку города наизусть, а пятно на городе отвечает сразу.
   Маршрутов на ней нет — только кант по краю участка, тем же цветом, каким
   район покрашен в живом виде. Щелчок по карте отмечает район: рука идёт к
   самой большой части карточки, и требовать от неё попадания в квадратик
   галочки незачем.

   Район без выбранного расчёта карточка не гасит: это не поломка, а обычное
   утро — планы посчитаны, какой взять, ещё не решили. Такой район показывает
   предложенный расчёт и говорит, что он предложен. */
function ZoneCard({
  day,
  offer,
  stat,
  statOf,
  bounds,
  tint,
  watched,
  onToggle
}: {
  day: WorkDay;
  /** Что предложено району без выбранного расчёта: самый свежий его план. */
  offer: RunId | null;
  /** Числа и набросок того расчёта, который карточка показывает. */
  stat: RunStat | null;
  /** Числа любого расчёта района — ими подписан список выбора. */
  statOf: (id: RunId | null) => RunStat | null;
  bounds: Registry['bounds'] | null;
  tint: string;
  watched: boolean;
  onToggle: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const holder = day.holder;
  const shown = holder ?? offer;

  return (
    <article className={'zcard' + (watched ? ' zcard--on' : '')}>
      <label className="zcard__head">
        <input
          type="checkbox"
          className="mday__box"
          checked={watched}
          onChange={onToggle}
          disabled={!shown}
        />
        <span className="zcard__place">{day.place}</span>
        <span className="zcard__dot" style={{ background: tint }} aria-hidden="true" />
        <span className="zcard__date">{day.date.split('-').reverse().join('.')}</span>
      </label>

      {stat && bounds ? (
        <ZoneMap
          sketch={stat.sketch}
          bounds={bounds}
          tint={tint}
          label={watched ? `Снять ${day.place} с наблюдения` : `Отметить ${day.place}`}
          onOpen={onToggle}
        />
      ) : (
        <div className="zcard__blank">
          {!shown ? 'Расчёта на район нет' : bounds ? 'План не прочитался' : 'План загружается'}
        </div>
      )}

      {/* Расчёт района: номер и день, когда его посчитали. Больше здесь
          ничего не нужно — чем он отличается от соседних, видно в списке
          выбора, где у каждого стоят его числа. */}
      <div className="zcard__run">
        {shown && stat ? (
          <>
            <Icon
              name={holder ? 'check-circle' : 'lightning'}
              size={13}
              className={holder ? 'mday__holder-icon' : 'zcard__offer-icon'}
            />
            <b>{runCode(shown)}</b>
            <span className="zcard__made">— {shortStamp(stat.run.created)}</span>
          </>
        ) : shown ? (
          <b>{runCode(shown)}</b>
        ) : (
          <span className="mday__none">Расчёта нет</span>
        )}
      </div>

      {stat && (
        <div className="engquick engquick--sub zcard__nums">
          <div className="engquick__tile">
            <span className="engquick__value">{stat.orders}</span>
            <span className="engquick__label">Заявок</span>
          </div>
          <div className="engquick__tile">
            <span className="engquick__value">{stat.routes}</span>
            <span className="engquick__label">Маршрутов</span>
          </div>
          <div className="engquick__tile">
            <span className="engquick__value">{stat.engineersOnRoute}</span>
            <span className="engquick__label">Инженеров</span>
          </div>
          <div className="engquick__tile" title="Прогноз выполнения по симуляции">
            <span className="engquick__value">
              {Math.round(stat.coverage * 100)}
              <span className="engquick__unit">%</span>
            </span>
            <span className="engquick__label">Прогноз выполнения</span>
          </div>
        </div>
      )}

      {/* Выбор расчёта раскрывается поверх карточки, а не внутри неё: список
          внутри раздвигал карточку, а с ней и весь ряд — соседние районы
          уезжали вниз от нажатия, к которому не имеют отношения. */}
      <div className="zcard__pick">
        <button
          type="button"
          className="mday__more zcard__more"
          onClick={() => setPicking((was) => !was)}
          aria-expanded={picking}
          disabled={day.runs.length === 0}
        >
          {holder ? 'Сменить расчёт' : 'Выбрать расчёт'}
          <Icon name={picking ? 'chevron-up' : 'chevron-down'} size={13} />
        </button>

        {picking && (
          <RunPicker
            day={day}
            statOf={statOf}
            onClose={() => setPicking(false)}
          />
        )}
      </div>
    </article>
  );
}

/* Чем упорядочить расчёты района. Свежий сверху — как обычно и ищут; но
   когда выбирают, чем вести день, спрашивают и по-другому: «а где покрытие
   больше» и «где заявок больше». */
type Sort = 'fresh' | 'coverage' | 'orders';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'fresh', label: 'Свежие' },
  { value: 'coverage', label: 'Прогноз' },
  { value: 'orders', label: 'Заявки' }
];

/* Список расчётов района — поверх карточки.

   Строка расчёта устроена как в ленте диспетчерской: номер, а за ним три
   числа через косую черту. Порядок тот же, что и там, — сколько рук,
   сколько маршрутов, что вышло, — и читать их дважды по-разному не
   приходится. */
function RunPicker({
  day,
  statOf,
  onClose
}: {
  day: WorkDay;
  statOf: (id: RunId | null) => RunStat | null;
  onClose: () => void;
}) {
  const [sort, setSort] = useState<Sort>('fresh');
  /* Показывать ли всю историю района. Закрыто по умолчанию: к дню привязан
     расчёт, и остальные прогоны того же дня — черновики к нему. Открывают
     список тогда, когда привязанного нет или он не тот. */
  const [all, setAll] = useState(() => day.holder === null);
  const box = useRef<HTMLDivElement>(null);

  /* Список закрывается щелчком мимо и по Esc: он перекрывает карточку, и
     выхода из него должно быть два. */
  useEffect(() => {
    const away = (event: MouseEvent) => {
      const node = box.current;
      if (node && !node.contains(event.target as Node)) onClose();
    };
    const esc = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);

  /* Что предлагать. Расчёт привязывают к дню в самих расчётах — кнопкой «В
     работу», — и мониторинг берёт эту привязку как ответ: район ведёт тот
     план, который на его день подвязали. Всю историю прогонов показывать
     здесь незачем, её открывают отдельно. */
  const bound = day.holder ? [day.holder] : [];
  const listed = all ? day.runs : bound;

  const rows = listed.map((id) => ({ id, stat: statOf(id) }));
  const sorted = [...rows].sort((a, b) => {
    if (sort === 'coverage') return (b.stat?.coverage ?? 0) - (a.stat?.coverage ?? 0);
    if (sort === 'orders') return (b.stat?.orders ?? 0) - (a.stat?.orders ?? 0);
    /* Свежие сверху: история сложена от старого к новому, и порядок дня
       участка её уже повторяет. */
    return 0;
  });

  return (
    <div className="zpick" ref={box} role="dialog" aria-label={`Расчёты района ${day.place}`}>
      <div className="zpick__head">
        <span className="zpick__title">
          {all
            ? `Все расчёты дня · ${day.runs.length}`
            : bound.length > 0
              ? 'Привязан к этому дню'
              : 'К этому дню ничего не привязано'}
        </span>
        {all && (
          <div className="zpick__sorts">
            {SORTS.map((one) => (
              <button
                key={one.value}
                type="button"
                className={'zpick__sort' + (sort === one.value ? ' zpick__sort--on' : '')}
                onClick={() => setSort(one.value)}
              >
                {one.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="zpick__list">
        {sorted.map(({ id, stat }, index) => {
          const working = day.holder === id;
          return (
            <button
              key={id}
              type="button"
              className={'zpick__run' + (working ? ' zpick__run--on' : '')}
              disabled={working}
              onClick={() => {
                takeDuty(id, day.date);
                onClose();
              }}
              title={
                working
                  ? `${runCode(id)} уже ведёт ${day.place}`
                  : `Вести ${day.place} расчётом ${runCode(id)}`
              }
            >
              {/* Отметка выбранного — слева, у самого края строки: глаз
                  идёт по началу строк, и искать её в конце пришлось бы
                  отдельным движением. Место под неё держится и у
                  невыбранных, иначе строки разъезжаются. */}
              <span className="zpick__mark" aria-hidden={!working}>
                {working && <Icon name="check-circle" size={12} />}
              </span>
              <span className="zpick__no">#{index + 1}</span>
              <span className="zpick__code">{runCode(id)}</span>
              <span className="zpick__meta" title={PICK_HINT}>
                {stat
                  ? `${stat.engineersOnRoute}/${stat.routes}/${Math.round(stat.coverage * 100)}%`
                  : '—'}
              </span>
              <span className="zpick__made">{stat ? shortStamp(stat.run.created) : ''}</span>
            </button>
          );
        })}

        {sorted.length === 0 && (
          <span className="zpick__empty">Расчётов на этот день нет</span>
        )}
      </div>

      {/* Добавить расчёт, которого в привязке нет, — здесь же: привязка
          делается в базе расчётов, но менять её приходится по ходу дня. */}
      {day.runs.length > bound.length && (
        <button type="button" className="zpick__all" onClick={() => setAll((was) => !was)}>
          <Icon name={all ? 'chevron-up' : 'stack'} size={12} />
          {all ? 'Только привязанный' : `Добавить из расчётов дня · ${day.runs.length}`}
        </button>
      )}
    </div>
  );
}

const PICK_HINT = 'Инженеров на маршрутах / маршрутов / прогноз выполнения';

const fullDate = (iso: string) => {
  const [year, month, day] = iso.split('-');
  return day ? `${day}.${month}.${year}` : iso;
};

/* Карточка прошедшего мониторинга — той же породы, что карточка расчёта в
   базе: номер в углу, числа плиткой, разбор по районам списком.

   Числа — итог дня: сколько заявок и маршрутов день должен был закрыть и
   сколько закрыл. Ни одно из них не считается заново: и план, и факт
   приходят из живого вида, который их и показывал. */
function MonitorCard({
  row,
  onOpenRun
}: {
  row: MonitorRun;
  onOpenRun?: (id: RunId) => void;
}) {
  const result = row.result;
  const routes = row.parts.reduce((sum, part) => sum + part.routes, 0);
  const routesDone = row.parts.reduce((sum, part) => sum + part.routesDone, 0);
  const zones = row.parts.length || row.places.length;

  return (
    <article className="moncard">
      <div className="moncard__head">
        <span className="moncard__ident">
          <span className="engcard__idlabel">id:</span>
          <span className="moncard__code">{monitorCode(row.no)}</span>
        </span>
        <span className="moncard__when">
          {whenLabel(row.date)} · {fullDate(row.date)}, {row.started}
        </span>
      </div>

      {/* Четыре числа дня: сколько районов вели, сколько заявок и маршрутов
          закрыли из положенного и сколько людей на это вышло. Каждое — «факт
          из плана», в одном и том же порядке, чтобы их не приходилось читать
          по-разному. */}
      <div className="engquick">
        <div className="engquick__tile engquick__tile--main">
          <span className="engquick__value">{zones}</span>
          <span className="engquick__label">
            {pluralWord(zones, 'район', 'района', 'районов')}
          </span>
        </div>
        <div className="engquick__tile" title="Заявок выполнено из тех, что стояли в планах">
          <span className="engquick__value">
            {result ? `${result.done} из ${result.orders}` : '—'}
          </span>
          <span className="engquick__label">Заявок выполнено</span>
        </div>
        <div className="engquick__tile" title="Маршрутов пройдено до последней заявки из всех маршрутов дня">
          <span className="engquick__value">
            {routes === 0 ? '—' : `${routesDone} из ${routes}`}
          </span>
          <span className="engquick__label">Маршрутов закрыто</span>
        </div>
        <div className="engquick__tile" title="Инженеров вышло на смену из штата наблюдаемых районов">
          <span className="engquick__value">
            {result ? `${result.onShift} из ${result.engineers}` : '—'}
          </span>
          <span className="engquick__label">Инженеров на смене</span>
        </div>
      </div>

      {/* Беда дня — красной плашкой: остальные числа карточки нейтральны, и
          строка о срывах между ними читалась как ещё один факт из ряда. */}
      {result && result.late > 0 && (
        <p className="moncard__late">
          <Icon name="lightning" size={12} />
          {result.late} {pluralWord(result.late, 'инженер', 'инженера', 'инженеров')} не укладывались
          в сроки
        </p>
      )}

      <div className="moncard__parts">
        {row.parts.length === 0 ? (
          /* Наблюдение закрыли раньше, чем дни районов успели загрузиться:
             какие районы отметили — известно, а чисел по ним нет. */
          <div className="moncard__chips">
            {row.places.map((place) => (
              <span key={place} className="homechip homechip--quiet">
                {place}
              </span>
            ))}
            {row.places.length === 0 && (
              <span className="moncard__empty">Районы не отмечены</span>
            )}
          </div>
        ) : (
          <div className="monpart__list">
            {row.parts.map((part) => (
              <div key={part.run} className="monpart">
                <span className="monpart__place">{part.place}</span>
                <button
                  type="button"
                  className="monpart__run"
                  onClick={() => onOpenRun?.(part.run)}
                  disabled={!onOpenRun}
                  title={`Разобрать расчёт ${runCode(part.run)}`}
                >
                  {runCode(part.run)}
                </button>
                <span className="monpart__date">{fullDate(part.date)}</span>
                {/* Подпись слева, число справа: три строки подряд читают
                    столбиком, и числа обязаны стоять друг под другом. */}
                <span className="monpart__nums">
                  <span>Инженеров</span>
                  <b>{part.onShift}</b>
                </span>
                <span className="monpart__nums">
                  <span>Маршрутов</span>
                  <b>
                    {part.routesDone} из {part.routes}
                  </b>
                </span>
                <span className="monpart__nums">
                  <span>Заявок</span>
                  <b>
                    {part.done} из {part.orders}
                  </b>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
