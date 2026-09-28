import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import {
  buildLiveRoster,
  cutMinutes,
  monthName,
  pluralWord,
  shortName,
  weekdayName
} from '../data/derive.ts';
import type { RunId, DaySummary } from '../data/load.ts';
import { runCode, whenLabel } from '../data/load.ts';
import type { Registry, RouteRecord } from '../data/registry.ts';
import { engineerKey } from '../data/registry.ts';
import { RunCard } from '../app/RunCard.tsx';
import { useDuty, workDays } from '../data/duty.ts';
/* Знак хозяйства без слов. Файлов два, и они разные: `mark.svg` нарисован
   чёрным — он для светлой темы; белая пчела живёт внутри тёмного логотипа
   вместе со словом, и на тёмной теме берётся она, обрезанная по слову. Ни
   тот ни другой не перекрашиваем: оба лежат такими, какими пришли от
   заказчика (assets/logo/SOURCE.md). */
import mark from '../ds/assets/logo/mark.svg';
import markOnDark from '../ds/assets/logo/lockup-h-on-dark.svg';
import { successOf, todayKey, useShifts, wasWatched, watchTime } from '../data/watch.ts';
import { monitorCode, useMonitors } from '../data/monitor.ts';
import type { WatchShift } from '../data/watch.ts';
import { SortMenu } from '../app/SortMenu.tsx';
import type { SortRule } from '../app/SortMenu.tsx';
import type { SectionId } from '../app/nav.ts';

interface Props {
  day: Day;
  /** План, который сейчас на экране. `view` собран из него же, и числа на
      плитках обязаны браться из одного плана с ним. */
  plan: Day['plan'];
  view: DayView;
  runs: DaySummary[] | null;
  /** Справочники: числа у кнопок баз данных и участок инженера для карточки.
      Пусто, пока не собрались, — числа тогда не рисуются. */
  registry: Registry | null;
  activeRun: RunId;
  /** Дни участков, отмеченные к наблюдению, и идёт ли оно прямо сейчас. */
  watched: string[];
  watching: boolean;
  onWatch: (keys: string[]) => void;
  /** Перейти к живому виду по отмеченным дням — минуя меню мониторинга. */
  onEnterWatch: () => void;
  /* Второй довод — вкладка раздела: «Сравнить расчёты» ведёт не в статистику
     вообще, а в её сравнение. */
  onGoSection: (id: SectionId, view?: string) => void;
  /** Разобрать расчёт карточкой поверх экрана — той же, что в базе расчётов. */
  onOpenRunCard: (id: RunId) => void;
  /** Разобрать смену: журнал дня окном поверх. */
  onOpenShift: (date: string) => void;
  /** Карточка инженера поверх экрана. Ключ собирает Главная: справочник
      различает людей по паре «участок — номер». */
  onOpenEngineer: (key: string) => void;
  /** Завести первый расчёт — когда истории ещё нет. */
  onCreate: () => void;
}

const percent = (share: number) => `${Math.round(share)}%`;

/* Сколько прошедших смен и расчётов показываем рядом. Дальше — свои
   разделы: Главная отвечает на «что было за последние дни», а не заменяет
   собой архив. */
const SHIFTS_SHOWN = 7;
const RUNS_SHOWN = 6;

/* По чему упорядочены смены в статистике. Первым — время: смену ищут «за
   вчера» и «за прошлую неделю», а не «где вышло лучше». Остальные два
   правила отвечают на вопросы руководителя: где день просел и где было
   больше всего работы. Порядок переворачивается повторным нажатием на
   выбранное правило — как в базах. */
type ShiftSort = 'date' | 'success' | 'volume';

const SHIFT_SORTS: (SortRule & { value: ShiftSort })[] = [
  {
    value: 'date',
    label: 'По времени',
    note: 'Когда была смена',
    up: 'Сначала давние',
    down: 'Сначала свежие'
  },
  {
    value: 'success',
    label: 'По выполнению',
    note: 'Какая доля заявок закрыта',
    up: 'Сначала слабые',
    down: 'Сначала полные'
  },
  {
    value: 'volume',
    label: 'По объёму',
    note: 'Сколько заявок было в смене',
    up: 'Сначала лёгкие',
    down: 'Сначала тяжёлые'
  }
];

/** «2026-09-24» → «24.09». Год в плотном ряду карточек не помещается, а
    смены различают днём: за год их набирается двести пятьдесят, и все они
    из этого года. */
const shortDate = (iso: string) => {
  const [, month, day] = iso.split('-');
  return day ? `${day}.${month}` : iso;
};

/** «2026-09-24» → «24.09.2026»: в разборе смены год уже нужен. */
const fullDate = (iso: string) => {
  const [year, month, day] = iso.split('-');
  return day ? `${day}.${month}.${year}` : iso;
};

/* Точка входа в сервис. Остальные разделы отвечают на свой узкий вопрос —
   этот отвечает сразу на четыре самых частых: что происходит по дню прямо
   сейчас, как прошли предыдущие смены, что считали за это время и куда
   идти дальше.

   Своих данных почти не заводит: живые числа читает из открытого дня,
   смены — из журнала наблюдения, расчёты — из истории, числа баз — из
   справочников. Всё, что отсюда открывается, открывается там же, где ему
   место: расчёт и инженер — карточкой поверх экрана, день — мониторингом,
   база — своим разделом. */
export function HomeScreen({
  plan,
  view,
  runs,
  registry,
  activeRun,
  watched,
  watching,
  onWatch,
  onEnterWatch,
  onGoSection,
  onOpenRunCard,
  onOpenShift,
  onOpenEngineer,
  onCreate
}: Props) {
  /* Подписка на «взят в работу»: список дней участков читается заново, когда
     рабочий расчёт меняют в мониторинге или в базе. */
  useDuty();
  const days = workDays();
  const shifts = useShifts();
  const monitorRuns = useMonitors();
  const [sort, setSort] = useState<ShiftSort>('date');
  const [desc, setDesc] = useState(true);

  const cut = cutMinutes();
  const roster = useMemo(() => buildLiveRoster(view, cut), [view, cut]);
  const live = useMemo(() => {
    const working = roster.filter((r) => r.status === 'working');
    const enroute = roster.filter((r) => r.status === 'enroute');
    const overdue = roster.filter((r) => r.status === 'overdue');
    const done = roster.reduce((sum, r) => sum + r.visitsDone, 0);
    const total = roster.reduce((sum, r) => sum + r.visitsTotal, 0);
    return { working, enroute, overdue, done, total };
  }, [roster]);

  /* Часы идут сами, шагом в десять секунд: показываем минуты, и минута,
     сменившаяся с опозданием на полминуты, читается как стоящие часы. */
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const weekday = weekdayName(now);
  const today = `${weekday[0].toUpperCase()}${weekday.slice(1)}, ${now.getDate()} ${monthName(now)}`;
  const clock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const ready = days.filter((one) => one.holder);

  /* Что стоит за отмеченными участками.

     Галочки у дней справа до сих пор ничего не меняли на экране: они копили
     набор для кнопки «Смотреть», и до самого живого вида диспетчер не знал,
     много ли отметил. А это первый вопрос перед наблюдением — сколько
     заявок, маршрутов и людей берётся под присмотр.

     Числа берём из справочника, по рабочим расчётам отмеченных дней: он их
     уже посчитал для баз и статистики, и второй раз считать те же суммы
     незачем. Покрытие складываем по заявкам, а не средним из долей: участок
     на две сотни заявок весит больше участка на пять десятков. */
  const picked = useMemo(() => {
    if (!registry) return null;
    const runsOfDays = days
      .filter((one) => watched.includes(one.key) && one.holder)
      .map((one) => one.holder as RunId);
    if (runsOfDays.length === 0) return null;
    const rows = registry.stats.byRun.filter((one) => runsOfDays.includes(one.run.id));
    if (rows.length === 0) return null;
    const sum = (pick: (one: (typeof rows)[number]) => number) =>
      rows.reduce((total, one) => total + pick(one), 0);
    const orders = sum((one) => one.orders);
    return {
      places: rows.length,
      orders,
      routes: sum((one) => one.routes),
      engineers: sum((one) => one.engineersTotal),
      coverage: orders > 0 ? sum((one) => one.coverage * one.orders) / orders : 0
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, days, watched.join('|')]);
  /* Последние расчёты — свода справочника, а не ленты истории: карточке
     базы нужны её числа и набросок карты, и считает их справочник. */
  const recentRuns = useMemo(
    () => (registry ? [...registry.stats.byRun].slice(-RUNS_SHOWN).reverse() : []),
    [registry]
  );

  /* Маршруты по расчётам — для списков внутри карточек. Считаем один раз на
     весь ряд: реестр общий, и шесть карточек просеивали бы его шесть раз. */
  const routesByRun = useMemo(() => {
    const map = new Map<string, RouteRecord[]>();
    for (const route of registry?.routes ?? []) {
      const list = map.get(route.run.id);
      if (list) list.push(route);
      else map.set(route.run.id, [route]);
    }
    for (const list of map.values()) list.sort((a, b) => a.number - b.number);
    return map;
  }, [registry]);

  /* Смены для статистики: журнал уже отсортирован свежими сверху, здесь
     только переупорядочивание по выбранному правилу. Смена без снимка
     итогов (заходили, но живого вида не открывали) в порядке по выполнению
     уходит вниз: сравнивать её не с чем. */
  const ranked = useMemo(() => {
    const rows = [...shifts];
    const side = desc ? 1 : -1;
    rows.sort((a, b) => {
      if (sort === 'success') {
        const first = successOf(a);
        const second = successOf(b);
        if (first === null || second === null) {
          if (first === second) return b.date.localeCompare(a.date);
          return first === null ? 1 : -1;
        }
        return (second - first) * side || b.date.localeCompare(a.date);
      }
      if (sort === 'volume') {
        const first = a.result?.orders ?? 0;
        const second = b.result?.orders ?? 0;
        return (second - first) * side || b.date.localeCompare(a.date);
      }
      return b.date.localeCompare(a.date) * side;
    });
    return rows;
  }, [shifts, sort, desc]);

  /* Свод по всем сменам журнала: сколько дней отработано и какая доля
     заявок на них закрыта. Считается по сменам со снимком — только они и
     говорят о выполнении. */
  const total = useMemo(() => {
    const withResult = shifts.filter((one) => one.result && one.result.orders > 0);
    const orders = withResult.reduce((sum, one) => sum + (one.result?.orders ?? 0), 0);
    const done = withResult.reduce((sum, one) => sum + (one.result?.done ?? 0), 0);
    const minutes = shifts.reduce((sum, one) => sum + one.minutes, 0);
    return {
      shifts: shifts.length,
      watched: shifts.filter(wasWatched).length,
      orders,
      done,
      minutes,
      share: orders > 0 ? (done / orders) * 100 : null
    };
  }, [shifts]);

  /* Свод по записям мониторинга: средние за все дни и ряд самих дней.
     Пусто — блока нет: пустые плитки с прочерками рассказывают только о
     том, что мониторинг ещё не открывали, а это уже сказано выше. */
  const board = useMemo(() => {
    const rows = monitorRuns
      .map((one) => {
        const result = one.result;
        return {
          id: one.id,
          no: one.no,
          date: one.date,
          zones: one.parts.length || one.places.length,
          crew: result?.onShift ?? 0,
          share: result && result.orders > 0 ? (result.done / result.orders) * 100 : null,
          orders: result?.orders ?? 0,
          done: result?.done ?? 0,
          late: result?.late ?? 0,
          routes: one.parts.reduce((sum, part) => sum + part.routes, 0),
          routesDone: one.parts.reduce((sum, part) => sum + part.routesDone, 0)
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    if (rows.length === 0) return null;

    const scored = rows.filter((one) => one.share !== null);
    const sum = (pick: (one: (typeof rows)[number]) => number) =>
      rows.reduce((total, one) => total + pick(one), 0);
    const orders = sum((one) => one.orders);
    const done = sum((one) => one.done);
    return {
      count: rows.length,
      rows: rows.slice(0, SHIFTS_SHOWN),
      zones: Math.max(...rows.map((one) => one.zones)),
      orders,
      done,
      /* Доля по всем заявкам сразу, а не среднее из долей: день на двести
         заявок и день на двадцать весят в работе по-разному. */
      share: orders > 0 ? (done / orders) * 100 : 0,
      routes: sum((one) => one.routes),
      routesDone: sum((one) => one.routesDone),
      crew: rows.length > 0 ? sum((one) => one.crew) / rows.length : 0,
      late: sum((one) => one.late),
      best: scored.length > 0 ? scored.reduce((a, b) => ((b.share ?? 0) > (a.share ?? 0) ? b : a)) : null,
      worst: scored.length > 0 ? scored.reduce((a, b) => ((b.share ?? 0) < (a.share ?? 0) ? b : a)) : null
    };
  }, [monitorRuns]);

  return (
    <div className="dash enter">
      {/* ─── мониторинг ───────────────────────────────────────────────────
          Первое, зачем сюда приходят: что происходит сейчас и по каким дням
          за этим смотрят. Числа слева — живые, по открытому расчёту; справа
          — дни участков с их рабочими расчётами, откуда наблюдение и
          начинается. */}
      <section className="panel">
        {/* День и часы — крупно и в левом углу, как в воротах мониторинга:
            Главная отвечает на «что происходит сейчас», и первое, что она
            обязана сказать, — какое это «сейчас». Название раздела стоит
            под ними подписью: его и так знают, а время читают. */}
        <div className="homehead">
          <h2 className="homehead__day">
            {today}
            <span className="homehead__clock">{clock}</span>
          </h2>
          {/* Пчела — без слов. Главная открывается первой, и на ней уместен
              знак хозяйства: имя сервиса и так стоит в шапке страницы, а
              здесь нужен не он, а лицо.

              Знаков два, и какой показать, решает тема, а не разметка — тот
              же приём, что у логотипа в шапке страницы: тема бывает
              системной, и в разметке о ней ничего не известно. */}
          <span className="homehead__marks" aria-hidden="true">
            <span
              className="homehead__mark homehead__mark--light"
              style={{ ['--mark' as string]: `url(${mark})` }}
            />
            <span
              className="homehead__mark homehead__mark--dark"
              style={{ ['--mark' as string]: `url(${markOnDark})` }}
            />
          </span>
        </div>

        <div className="homehero">
          <div className="homehero__live">
            {/* Живые числа стоят, только пока наблюдение идёт.

                Прежде они висели здесь всегда — по тому расчёту, что открыт
                в диспетчерской, — и Главная в шесть утра бодро сообщала
                «2 на объекте» о плане, за которым никто не смотрит. Число,
                снятое неизвестно с чего, хуже отсутствия числа: по нему
                принимают решения. Наблюдение не запущено — здесь пусто, и
                на его месте то, ради чего сюда пришли: что взять под
                присмотр. */}
            {watching && watched.length > 0 && (
              <>
                <div className="homelive">
              <span className="homelive__item">
                <b className="homelive__value">{live.working.length}</b>
                <span>На объекте</span>
              </span>
              <span className="homelive__item">
                <b className="homelive__value">{live.enroute.length}</b>
                <span>В пути</span>
              </span>
              <span
                className={'homelive__item' + (live.overdue.length > 0 ? ' homelive__item--danger' : '')}
              >
                <b className="homelive__value">{live.overdue.length}</b>
                <span>Опаздывают</span>
              </span>
              <span className="homelive__item">
                <b className="homelive__value">
                  {live.done}
                  <span className="homelive__of"> из {live.total}</span>
                </b>
                <span>Визитов закрыто</span>
              </span>
            </div>

            {/* Опаздывающие названы поимённо: это то, ради чего в мониторинг
                и заходят, а фамилия отвечает на «кто» быстрее любого числа.
                Щелчок открывает карточку человека поверх экрана. */}
            {live.overdue.length > 0 && (
              <div className="homelate">
                <span className="homelate__label">Опаздывают:</span>
                {live.overdue.slice(0, 6).map((one) => (
                  <button
                    key={one.engineer.id}
                    type="button"
                    className="homechip homechip--danger"
                    title={`Карточка инженера: ${one.engineer.name}`}
                    onClick={() => onOpenEngineer(engineerKey(plan.meta.day, one.engineer.id))}
                  >
                    {shortName(one.engineer.name)}
                    <span className="homechip__num">
                      +{one.lateMinutes}
                      {' мин'}
                    </span>
                  </button>
                ))}
                {live.overdue.length > 6 && (
                  <span className="homelate__rest">и ещё {live.overdue.length - 6}</span>
                )}
              </div>
            )}
            </>
            )}

            {/* Свод по отмеченным участкам — под числами и вместо них, когда
                наблюдение не идёт. Он отвечает галочкам справа: отметили
                участок — здесь прибавилось его хозяйство. */}
            {picked ? (
              <div className="homepick">
                <span className="homepick__label">
                  <Icon name="check-circle" size={13} />
                  Под присмотром: {picked.places} {pluralWord(picked.places, 'участок', 'участка', 'участков')}
                </span>
                <span className="homepick__row">
                  <span className="homepick__item">
                    <b>{picked.orders}</b> {pluralWord(picked.orders, 'заявка', 'заявки', 'заявок')}
                  </span>
                  <span className="homepick__item">
                    <b>{picked.routes}</b> {pluralWord(picked.routes, 'маршрут', 'маршрута', 'маршрутов')}
                  </span>
                  <span className="homepick__item">
                    <b>{picked.engineers}</b> {pluralWord(picked.engineers, 'инженер', 'инженера', 'инженеров')}
                  </span>
                  <span className="homepick__item">
                    <b>{percent(picked.coverage * 100)}</b> покрытие
                  </span>
                </span>
              </div>
            ) : (
              <p className="homehero__note">
                {ready.length === 0
                  ? 'Ни у одного дня нет рабочего расчёта: выберите его справа, и день можно будет взять под присмотр.'
                  : 'Отметьте дни участков справа — здесь встанет то, что за ними стоит: заявки, маршруты и люди.'}
              </p>
            )}

            <div className="home__actions">
              {/* Первое действие — вернуться к наблюдению: за ним диспетчер
                  разворачивает мониторинг и работает в нём весь день.
                  Остальные два идут в том порядке, в каком к ним обращаются:
                  воздействие — по ходу дня, диспетчерская — когда нужен
                  новый план. */}
              {/* Подпись одна на все случаи: диспетчер весь день живёт в
                  наблюдении и возвращается к нему — отмечены участки или
                  нет, идёт оно сейчас или его ещё не открывали. Три разных
                  слова на одной кнопке заставляли читать её каждый раз
                  заново, а ведёт она всегда в одно место. */}
              <Button
                variant="accent"
                iconLeft={<Icon name="navigation-arrow" size={14} />}
                onClick={watched.length > 0 ? onEnterWatch : () => onGoSection('monitor')}
              >
                Вернуться к наблюдению
              </Button>
              <button type="button" className="runcard__act" onClick={() => onGoSection('control')}>
                <Icon name="lightning" size={13} />
                Воздействие
              </button>
              <button type="button" className="runcard__act" onClick={() => onGoSection('dispatch')}>
                <Icon name="gauge" size={13} />
                Диспетчерская
              </button>
            </div>
          </div>

          <div className="homehero__days">
            <div className="homehero__days-head">
              <span className="homehero__days-title">Дни участков</span>
              <span className="dash__section-note">
                {ready.length} из {days.length} с рабочим расчётом
              </span>
            </div>

            {days.length === 0 ? (
              <p className="homehero__empty">
                Расчётов пока нет — смотреть не за чем. Начните с диспетчерской.
              </p>
            ) : (
              <div className="homedays">
                {days.slice(0, 4).map((one) => {
                  const on = watched.includes(one.key);
                  return (
                    <div key={one.key} className={'homeday' + (on ? ' homeday--on' : '')}>
                      <label className="homeday__pick">
                        <input
                          type="checkbox"
                          className="mday__box"
                          checked={on}
                          disabled={!one.holder}
                          onChange={() =>
                            onWatch(
                              on ? watched.filter((key) => key !== one.key) : [...watched, one.key]
                            )
                          }
                        />
                        <span className="homeday__place">{one.place}</span>
                        <span className="homeday__date">{fullDate(one.date)}</span>
                      </label>

                      {one.holder ? (
                        <button
                          type="button"
                          className="homechip"
                          title={`Разобрать расчёт ${runCode(one.holder)}`}
                          onClick={() => onOpenRunCard(one.holder as RunId)}
                        >
                          <Icon name="check-circle" size={12} />
                          {runCode(one.holder)}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="homeday__pickrun"
                          onClick={() => onGoSection('monitor')}
                        >
                          Выбрать расчёт
                          <Icon name="arrow-right" size={12} />
                        </button>
                      )}
                    </div>
                  );
                })}
                {days.length > 4 && (
                  <button
                    type="button"
                    className="homeday__more"
                    onClick={() => onGoSection('monitor')}
                  >
                    Ещё {days.length - 4} {pluralWord(days.length - 4, 'день', 'дня', 'дней')} в мониторинге
                    <Icon name="arrow-right" size={12} />
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ─── как идут мониторинги ────────────────────────────────────────
          Один день ничего не говорит: он либо вышел, либо нет. Смысл
          появляется на ряде — видно, какой день провалился против прочих,
          сколько людей обычно выходит и насколько день вообще довозят до
          конца. Считается по записям мониторинга, а не по планам: план
          обещает, запись говорит, что вышло. */}
      {board !== null && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Как идут мониторинги</h2>
          </div>

          <p className="dbbar__summary home__summary">
            <b>
              {board.count} {pluralWord(board.count, 'мониторинг', 'мониторинга', 'мониторингов')}
            </b>{' '}
            в журнале · <b>{board.zones}</b>{' '}
            {pluralWord(board.zones, 'район', 'района', 'районов')} под наблюдением ·{' '}
            <b>
              {board.done} из {board.orders}
            </b>{' '}
            заявок закрыто
          </p>

          {/* Части внутри карточки разведены подписанными чертами: свод,
              средние и сами дни отвечают на разные вопросы, а стояли одной
              стопкой — глаз читал их как один длинный список. */}
          <div className="homepart">
            <span>В среднем за всё время</span>
          </div>

          <div className="dbstats">
            <div className="dbstat">
              <span className="dbstat__value">{percent(board.share)}</span>
              <span className="dbstat__label">Выполнение в среднем за день</span>
            </div>
            <div className="dbstat">
              <span className="dbstat__value">
                {board.routesDone} из {board.routes}
              </span>
              <span className="dbstat__label">Маршрутов закрыто</span>
            </div>
            <div className="dbstat">
              <span className="dbstat__value">{Math.round(board.crew)}</span>
              <span className="dbstat__label">Инженеров на смене в среднем</span>
            </div>
            <div className={'dbstat' + (board.late > 0 ? ' dbstat--bad' : '')}>
              <span className="dbstat__value">{board.late}</span>
              <span className="dbstat__label">Срывов сроков за всё время</span>
            </div>
          </div>

          {/* Ряд дней: у каждого своя полоса выполнения, и слабый день виден
              в ряду сразу — без чтения чисел. Лучший и слабый названы
              вслух: это первое, о чём спрашивают, посмотрев на ряд. */}
          <div className="homepart">
            <span>
              Дни под наблюдением · {board.rows.length}
            </span>
          </div>

          <div className="homemons">
            {board.rows.map((one) => (
              <button
                key={one.id}
                type="button"
                className={'homemon' + (one.share !== null && one.share < 80 ? ' homemon--low' : '')}
                onClick={() => onOpenShift(one.date)}
                title={`Разобрать смену ${fullDate(one.date)}`}
              >
                <span className="homemon__top">
                  <span className="homemon__code">{monitorCode(one.no)}</span>
                  <span className="homemon__when">{shortDate(one.date)}</span>
                </span>
                <span className="homemon__value">
                  {one.share === null ? '—' : percent(one.share)}
                </span>
                <span className="homemon__bar" aria-hidden="true">
                  <span
                    className="homemon__fill"
                    style={{ width: `${Math.min(100, one.share ?? 0)}%` }}
                  />
                </span>
                <span className="homemon__facts">
                  {one.zones} {pluralWord(one.zones, 'район', 'района', 'районов')} ·{' '}
                  {one.crew} {pluralWord(one.crew, 'инженер', 'инженера', 'инженеров')}
                </span>
              </button>
            ))}
          </div>

          {board.best && board.worst && board.best.id !== board.worst.id && (
            <p className="homefoot">
              <Icon name="check-circle" size={13} />
              Лучший день — {fullDate(board.best.date)}, {percent(board.best.share ?? 0)}; слабее
              всех {fullDate(board.worst.date)}, {percent(board.worst.share ?? 0)}.
            </p>
          )}
        </section>
      )}

      {/* ─── прошедшие смены ──────────────────────────────────────────────
          Быстрый ход назад: вчерашний день открывается одним щелчком, и в
          нём виден журнал — что за день произошло и чем он кончился. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Прошедшие смены</h2>
        </div>

        {/* Свод выборки — строкой под заголовком, как над списками в базах:
            сколько записей, за сколько дней смотрели и что из этого вышло. */}
        {total.shifts > 0 && (
          <p className="dbbar__summary home__summary">
            <b>
              {total.shifts} {pluralWord(total.shifts, 'смена', 'смены', 'смен')}
            </b>{' '}
            в журнале · <b>{total.watched}</b>{' '}
            {pluralWord(total.watched, 'день', 'дня', 'дней')} под наблюдением ·{' '}
            <b>
              {total.done} из {total.orders}
            </b>{' '}
            заявок закрыто · <b>{watchTime(total.minutes)}</b> наблюдения
          </p>
        )}

        {shifts.length === 0 ? (
          <div className="emptynote">
            <p className="emptynote__title">Отработанных смен пока нет</p>
            <span>
              Смена заводится сама, как только открыт мониторинг: в неё попадают участки, за
              которыми смотрели, время наблюдения и всё, что за день произошло.
            </span>
            <button type="button" className="runcard__go" onClick={() => onGoSection('monitor')}>
              <Icon name="navigation-arrow" size={13} />
              Открыть мониторинг
            </button>
          </div>
        ) : (
          <>
            <div className="homepart">
              <span>
                Смены по дням · {shifts.length}
              </span>
            </div>

            <div className="homeshifts">
              {shifts.slice(0, SHIFTS_SHOWN).map((shift) => (
                <ShiftCard key={shift.date} shift={shift} onOpen={() => onOpenShift(shift.date)} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ─── расчёты ──────────────────────────────────────────────────────
          История счёта: последние расчёты карточками, каждая открывается
          разбором поверх экрана — тем же, что в базе расчётов. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Последние расчёты</h2>
          <button type="button" className="dash__section-link" onClick={() => onGoSection('db-runs')}>
            Все расчёты
            <Icon name="arrow-right" size={12} />
          </button>
        </div>

        {!runs || !registry ? (
          <p className="stub__body">Собираем расчёты…</p>
        ) : recentRuns.length === 0 ? (
          /* Пустая история — словами и кнопкой, а не пустым местом: пустой
             ряд плиток читается как «не загрузилось». */
          <div className="emptynote">
            <p className="emptynote__title">Расчётов пока нет</p>
            <span>Первый расчёт заводится в диспетчерской: выберите зону и запустите счёт.</span>
            <button type="button" className="runcard__go" onClick={onCreate}>
              <Icon name="shuffle" size={13} />
              Создать расчёт
            </button>
          </div>
        ) : (
          /* Карточки те же, что в базе расчётов: расчёт — одна вещь, и
             узнавать его на Главной диспетчер должен по тому же виду, по
             какому он листает архив. Отбора к сравнению и кнопки «Открыть»
             здесь нет: Главная показывает последнее, а работают с расчётом
             там, где он живёт. */
          <div className="runs__grid" style={{ '--per-row': 4 } as CSSProperties}>
            {recentRuns.map((row) => (
              <RunCard
                key={row.run.id}
                row={row}
                bounds={registry.bounds}
                routes={routesByRun.get(row.run.id) ?? []}
                isActive={row.run.id === activeRun}
                picked={false}
                showCompare={false}
                showOpen={false}
                onOpen={onOpenRunCard}
                onOpenMap={onOpenRunCard}
                onGo={() => onGoSection('dispatch')}
                onCompare={() => undefined}
              />
            ))}
          </div>
        )}
      </section>

      {/* ─── статистика по сменам ─────────────────────────────────────────
          То же, что в карточках выше, но рядами и по всем дням сразу: так
          видно, как сервис отработал неделю, а не один вчерашний день. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Отработанные дни</h2>
          {shifts.length > 1 && (
            <SortMenu
              rules={SHIFT_SORTS}
              value={sort}
              desc={desc}
              onPick={(value) => {
                if (value === sort) {
                  setDesc((was) => !was);
                  return;
                }
                setSort(value as ShiftSort);
                setDesc(true);
              }}
              onOrder={setDesc}
            />
          )}
        </div>

        {shifts.length === 0 ? (
          <p className="homehero__empty">
            Статистика собирается из смен: каждый день, когда открывали мониторинг, становится
            строкой этой таблицы.
          </p>
        ) : (
          <>
            <div className="dbstats">
              <div className="dbstat">
                <span className="dbstat__value">{total.watched}</span>
                <span className="dbstat__label">
                  {pluralWord(
                    total.watched,
                    'День под наблюдением',
                    'Дня под наблюдением',
                    'Дней под наблюдением'
                  )}
                </span>
              </div>
              <div className="dbstat">
                <span className="dbstat__value">
                  {total.share === null ? '—' : percent(total.share)}
                </span>
                <span className="dbstat__label">Выполнено за всё время</span>
              </div>
              <div className="dbstat">
                <span className="dbstat__value">
                  {total.done} из {total.orders}
                </span>
                <span className="dbstat__label">Заявок закрыто</span>
              </div>
              <div className="dbstat">
                <span className="dbstat__value">{watchTime(total.minutes)}</span>
                <span className="dbstat__label">Всего под наблюдением</span>
              </div>
            </div>

            <div className="homestat">
              <div className="homestat__head">
                <span>Смена</span>
                <span>Участки</span>
                <span>Выполнение</span>
                <span>Заявок</span>
                <span>Опоздания</span>
                <span>Наблюдение</span>
              </div>
              {ranked.map((shift) => (
                <ShiftRow key={shift.date} shift={shift} onOpen={() => onOpenShift(shift.date)} />
              ))}
            </div>
          </>
        )}
      </section>

      {/* ─── базы данных ──────────────────────────────────────────────────
          Числа у кнопок — из справочников: сколько записей в базе, а не
          сколько их в открытом расчёте. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Базы данных</h2>
          {/* Пока справочники собираются, об этом надо сказать: числа у
              кнопок в это время пустые. Собрались — говорить нечего, и
              подписи нет: числа стоят у самих кнопок. */}
          {!registry && <span className="dash__section-note">Собираем справочники…</span>}
        </div>
        <div className="tiles">
          <DbTile
            label="Расчёты"
            icon="stack"
            count={runs?.length ?? null}
            onOpen={() => onGoSection('db-runs')}
          />
          <DbTile
            label="Заявки"
            icon="clipboard-list"
            count={registry?.orders.length ?? null}
            onOpen={() => onGoSection('db-orders')}
          />
          <DbTile
            label="Услуги"
            icon="wrench"
            count={registry?.services.length ?? null}
            onOpen={() => onGoSection('db-services')}
          />
          <DbTile
            label="Инженеры"
            icon="users"
            count={registry?.engineers.length ?? null}
            onOpen={() => onGoSection('db-engineers')}
          />
          <DbTile
            label="Клиенты"
            icon="user"
            count={registry?.clients.length ?? null}
            onOpen={() => onGoSection('db-clients')}
          />
          <DbTile
            label="Маршруты"
            icon="path"
            count={registry?.routes.length ?? null}
            onOpen={() => onGoSection('db-routes')}
          />
        </div>
      </section>

    </div>
  );
}

/* Карточка прошедшей смены. Маленькая нарочно: их стоит семь в ряд, и
   каждая отвечает на один вопрос — «как прошёл этот день». Разбор с
   журналом открывается щелчком. */
function ShiftCard({ shift, onOpen }: { shift: WatchShift; onOpen: () => void }) {
  const share = successOf(shift);
  const late = shift.result?.late ?? 0;
  /* Сегодняшняя смена ещё идёт, и её доля — не оценка дня, а его середина:
     красить её как просевшую нельзя — к вечеру она дорастёт сама. */
  const running = shift.date === todayKey();
  return (
    <button type="button" className="homeshift" onClick={onOpen} title="Разобрать смену">
      <span className="homeshift__top">
        <span className="homeshift__when">{whenLabel(shift.date)}</span>
        <span className="homeshift__date">{shortDate(shift.date)}</span>
      </span>

      <span
        className={
          'homeshift__value' + (!running && share !== null && share < 80 ? ' homeshift__value--low' : '')
        }
      >
        {share === null ? '—' : percent(share)}
      </span>
      <span className="homeshift__label">
        {share === null
          ? 'Живой вид не открывали'
          : running
            ? `Выполнено к ${shift.seen}`
            : 'Заявок выполнено'}
      </span>

      {/* Полоса выполнения: доля читается взглядом раньше, чем числом. */}
      <span className="homeshift__bar" aria-hidden="true">
        <span className="homeshift__fill" style={{ width: `${Math.min(100, share ?? 0)}%` }} />
      </span>

      <span className="homeshift__fact">
        {shift.result ? `${shift.result.done} из ${shift.result.orders} заявок` : 'Без итогов дня'}
        {late > 0 && ` · опозданий ${late}`}
      </span>
      <span className="homeshift__fact homeshift__fact--muted">
        {wasWatched(shift) ? watchTime(shift.minutes) : 'В мониторинг не заходили'}
        {shift.events.length > 0 &&
          ` · ${shift.events.length} ${pluralWord(shift.events.length, 'событие', 'события', 'событий')}`}
      </span>
    </button>
  );
}

/* Строка смены в таблице отработанных дней. Та же смена, что и в карточке,
   но в ряду с остальными: колонки отвечают на «где просели» одним взглядом
   сверху вниз. */
function ShiftRow({ shift, onOpen }: { shift: WatchShift; onOpen: () => void }) {
  const share = successOf(shift);
  const result = shift.result;
  /* Идущую смену не оцениваем цветом: см. `ShiftCard`. */
  const running = shift.date === todayKey();
  return (
    <button type="button" className="homestat__row" onClick={onOpen} title="Разобрать смену">
      <span className="homestat__day">
        <b>{whenLabel(shift.date)}</b>
        <span className="homestat__date">{fullDate(shift.date)}</span>
      </span>

      <span className="homestat__places">
        {shift.places.length === 0 ? (
          <span className="homestat__muted">Без наблюдения</span>
        ) : (
          shift.places.map((place) => (
            <span key={place} className="homechip homechip--quiet">
              {place.split(' · ')[0]}
            </span>
          ))
        )}
      </span>

      <span className="homestat__share">
        <span className="homeshift__bar" aria-hidden="true">
          <span className="homeshift__fill" style={{ width: `${Math.min(100, share ?? 0)}%` }} />
        </span>
        <b className={!running && share !== null && share < 80 ? 'homestat__low' : undefined}>
          {share === null ? '—' : percent(share)}
        </b>
      </span>

      <span className="homestat__num">
        {result ? `${result.done} из ${result.orders}` : '—'}
      </span>

      <span className={'homestat__num' + ((result?.late ?? 0) > 0 ? ' homestat__low' : '')}>
        {result ? result.late : '—'}
      </span>

      <span className="homestat__num homestat__muted">
        {wasWatched(shift) ? watchTime(shift.minutes) : '—'}
      </span>
    </button>
  );
}

/* Плитка базы: название, значок и сколько в ней записей. Число приходит
   пустым, пока справочники собираются, — тогда его просто нет, а не ноль:
   ноль читался бы как пустая база. */
function DbTile({
  label,
  icon,
  count,
  onOpen
}: {
  label: string;
  icon: string;
  count: number | null;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="ctile" onClick={onOpen}>
      <span className="ctile__head">
        <span className="ctile__icon">
          <Icon name={icon} size={15} />
        </span>
        <span className="ctile__label">{label}</span>
      </span>
      {count !== null && count > 0 && (
        <span className="ctile__value">
          {count}{' '}
          <span className="ctile__unit">{pluralWord(count, 'запись', 'записи', 'записей')}</span>
        </span>
      )}
    </button>
  );
}
