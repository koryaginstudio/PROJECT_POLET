import { useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import {
  buildLiveRoster,
  cutMinutes,
  dec,
  hhmm,
  monthName,
  pluralWord,
  shortName,
  weekdayName
} from '../data/derive.ts';
import type { RunId, DaySummary } from '../data/load.ts';
import { engineReady, runCode, runEntry, whenLabel } from '../data/load.ts';
import type { Registry } from '../data/registry.ts';
import { engineerKey } from '../data/registry.ts';
import { dayLabel, useDuty, workDays } from '../data/duty.ts';
import { successOf, todayKey, useShifts, wasWatched, watchTime } from '../data/watch.ts';
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
  day,
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

  const now = new Date();
  const today = `${weekdayName(now)}, ${now.getDate()} ${monthName(now)}`;
  const ready = days.filter((one) => one.holder);
  const recent = useMemo(() => (runs ?? []).slice(-RUNS_SHOWN).reverse(), [runs]);

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

  const activeDay = runEntry(activeRun);
  const activePlace = activeDay ? dayLabel(activeRun, activeDay.date) : '';

  return (
    <div className="dash enter">
      {/* ─── мониторинг ───────────────────────────────────────────────────
          Первое, зачем сюда приходят: что происходит сейчас и по каким дням
          за этим смотрят. Числа слева — живые, по открытому расчёту; справа
          — дни участков с их рабочими расчётами, откуда наблюдение и
          начинается. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Мониторинг</h2>
          <span className="dash__section-note">
            Сегодня {today} · {hhmm(cut)}
          </span>
        </div>

        <div className="homehero">
          <div className="homehero__live">
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

            <p className="homehero__note">
              Числа по расчёту{' '}
              <button
                type="button"
                className="homelink"
                onClick={() => onOpenRunCard(activeRun)}
                title={`Разобрать расчёт ${runCode(activeRun)}`}
              >
                {runCode(activeRun)}
              </button>
              {activePlace && <> · {activePlace}</>} · прогноз выполнения{' '}
              {percent(day.simulation.coverage)} · назначено {plan.meta.orders_assigned} из{' '}
              {plan.meta.orders_total}
            </p>

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

            <div className="home__actions">
              <Button
                variant="primary"
                iconLeft={<Icon name="navigation-arrow" size={14} />}
                onClick={watched.length > 0 ? onEnterWatch : () => onGoSection('monitor')}
              >
                {watching
                  ? 'Вернуться к наблюдению'
                  : watched.length > 0
                    ? `Смотреть · ${watched.length} ${pluralWord(watched.length, 'день', 'дня', 'дней')}`
                    : 'Открыть мониторинг'}
              </Button>
              <button type="button" className="runcard__act" onClick={() => onGoSection('dispatch')}>
                <Icon name="gauge" size={13} />
                Диспетчерская
              </button>
              <button type="button" className="runcard__act" onClick={() => onGoSection('control')}>
                <Icon name="lightning" size={13} />
                Воздействие
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

      {/* ─── прошедшие смены ──────────────────────────────────────────────
          Быстрый ход назад: вчерашний день открывается одним щелчком, и в
          нём виден журнал — что за день произошло и чем он кончился. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Прошедшие смены</h2>
          <span className="dash__section-note">
            {total.shifts === 0
              ? 'Журнал пуст'
              : `${total.shifts} ${pluralWord(total.shifts, 'смена', 'смены', 'смен')} в журнале`}
          </span>
        </div>

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
          <div className="homeshifts">
            {shifts.slice(0, SHIFTS_SHOWN).map((shift) => (
              <ShiftCard key={shift.date} shift={shift} onOpen={() => onOpenShift(shift.date)} />
            ))}
          </div>
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

        {!runs ? (
          <p className="stub__body">Собираем расчёты…</p>
        ) : recent.length === 0 ? (
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
          <div className="homeruns">
            {recent.map((run) => {
              const isActive = run.id === activeRun;
              return (
                <button
                  key={run.id}
                  type="button"
                  className={'homerun' + (isActive ? ' homerun--active' : '')}
                  title={`Разобрать расчёт ${run.code}`}
                  onClick={() => onOpenRunCard(run.id)}
                >
                  <span className="homerun__top">
                    <span className="homerun__code">{run.code}</span>
                    {isActive ? (
                      <Badge tone="accent" dot>
                        открыт
                      </Badge>
                    ) : (
                      <span className="homerun__when">{whenLabel(run.created)}</span>
                    )}
                  </span>
                  <span className="homerun__value">
                    {dec(run.coverage)}
                    <span className="runcard__unit">%</span>
                  </span>
                  <span className="homerun__label">Прогноз выполнения</span>
                  <span className="homerun__fact">{dayLabel(run.id, run.date)}</span>
                  <span className="homerun__fact">
                    Назначено {run.ordersAssigned} из {run.ordersTotal} · без инженера{' '}
                    {run.unassigned}
                  </span>
                </button>
              );
            })}
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
          <span className="dash__section-note">
            {registry ? 'Записи по всем расчётам сразу' : 'Собираем справочники…'}
          </span>
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

      {/* ─── что ещё можно сделать ────────────────────────────────────────
          Действия, а не разделы: то, ради чего в сервис заходят помимо
          наблюдения. Строкой внизу — откуда сейчас берутся расчёты: это
          первое, что спрашивают, когда числа выглядят неожиданно. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Дальше</h2>
        </div>
        <div className="tiles">
          <button type="button" className="ctile" onClick={onCreate}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="plus" size={15} />
              </span>
              <span className="ctile__label">Создать расчёт</span>
            </span>
          </button>
          <button type="button" className="ctile" onClick={() => onGoSection('stats', 'compare')}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="shuffle" size={15} />
              </span>
              <span className="ctile__label">Сравнить расчёты</span>
            </span>
          </button>
          <button type="button" className="ctile" onClick={() => onGoSection('control')}>
            <span className="ctile__head">
              <span className="ctile__icon">
                <Icon name="lightning" size={15} />
              </span>
              <span className="ctile__label">Объявить событие</span>
            </span>
          </button>
        </div>

        {/* Настройки плиткой не стоят: они живут внизу меню и под шестерёнкой
            в шапке, а третьей дорогой туда же ряд действий стал бы длиннее
            ровно на то, что и так под рукой. */}
        <p className="homefoot">
          <Icon name={engineReady() ? 'check-circle' : 'info'} size={13} />
          {engineReady()
            ? 'Расчёты считает программа расчёта: она запущена и отвечает.'
            : 'Программа расчёта не отвечает — планы считаются в браузере, базовым вариантом.'}
        </p>
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
