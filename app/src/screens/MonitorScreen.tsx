import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import {
  buildDayView,
  buildLiveRoster,
  cutMinutes,
  dayDot,
  dayEnd,
  dayStart,
  hhmm,
  LIVE_STATUS_ORDER,
  mergeDays,
  placeOf,
  pluralWord,
  weekdayName
} from '../data/derive.ts';
import type { LiveEngineer } from '../data/derive.ts';
import { loadDay, runCode, runDate } from '../data/load.ts';
import type { RunId } from '../data/load.ts';
import { dayLabel, takeDuty, useDuty, workDays } from '../data/duty.ts';
import { loadTraffic } from '../data/traffic.ts';
import type { Traffic } from '../data/traffic.ts';
import { MapBoard, routeColor, surnameOf } from '../app/MapBoard.tsx';
import { MapPick } from '../app/MapPick.tsx';
import { transportIcon } from '../data/dictionary.ts';
import { routeLabel, routeNumber } from '../data/routeIds.ts';

interface Props {
  /** Открытый расчёт: его день уже загружен и приходит в `view` вместе с
      отметками журнала. */
  runId: string;
  /** Рабочие расчёты дней, за которыми смотрят. Их планы раздел догружает
      сам и кладёт на одну карту. Пусто — смотреть не за чем. */
  runs: RunId[];
  /** Вид раздела: «обзор» — город во весь экран с полосой живых чисел,
      «сводка» — те же числа списком, опаздывающие и состав смены. */
  mode: string;
  view: DayView;
  live: string | null;
  onLive: (engineerId: string | null) => void;
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  /** Показать маршрут, не переключая: щелчок по заявке оставляет её путь на
      карте, сколько бы раз по заявкам этого пути ни щёлкали. */
  onShowRoute: (engineerId: string | null) => void;
  focus: number;
  /** Выбранная заявка: её выбирают щелчком по точке, и сводка внизу слева
      отвечает о ней. */
  selectedOrder: string | null;
  onSelectOrder: (id: string | null) => void;
  onSelectEngineer: (id: string) => void;
}

const RANK: Record<string, number> = Object.fromEntries(
  LIVE_STATUS_ORDER.map((key, index) => [key, index])
);

/* Мониторинг. Диспетчерская отвечает на «каким должен быть план» и живёт от
   среза, который двигает диспетчер; мониторинг отвечает на «что происходит
   сейчас» и читает то же время, что на часах, — сам, без ручки. Здесь нет
   пересчёта и нет пульта: только то, что план обещал, и то, что видно на
   срезе прямо сейчас. */
export function MonitorScreen({
  view,
  runId,
  runs,
  mode,
  live,
  onLive,
  pinned,
  onPin,
  onShowRoute,
  focus,
  selectedOrder,
  onSelectOrder,
  onSelectEngineer
}: Props) {
  const [now, setNow] = useState(() => new Date());

  /* Часы плана дискретны по минутам, поэтому раз в двадцать секунд достаточно:
     ничего чаще минуты в данных всё равно не изменится, а отметка «обновлено»
     живой оставаться должна. */
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  /* Дни участков, за которыми смотрят, кладутся на одну карту.

     План открытого расчёта уже загружен и приходит готовым видом — с
     отметками журнала. Остальные раздел догружает сам, и журнала у них нет:
     движок ведёт его от одного плана, и чужие факты в чужой день не
     переносятся. Поэтому у догруженных дней отметок пусто, а состояние людей
     считается по плану и часам — ровно то, что мониторинг и обещает. */
  /* Не ответивший день лежит здесь как `null`, а не пропуском: пропуск
     неотличим от «ещё едет», и карта ждала бы его вечно. */
  const [others, setOthers] = useState<Map<RunId, DayView | null>>(new Map());
  const wanted = runs.filter((id) => id !== runId).join('|');
  useEffect(() => {
    let alive = true;
    const need = wanted ? wanted.split('|') : [];
    if (need.length === 0) {
      setOthers(new Map());
      return;
    }
    Promise.all(
      need.map((id) =>
        loadDay(id)
          .then((day) => [id, buildDayView(day, {})] as const)
          .catch(() => [id, null] as const)
      )
    ).then((pairs) => {
      if (!alive) return;
      setOthers(new Map(pairs));
    });
    return () => {
      alive = false;
    };
  }, [wanted]);

  /* Дни, которых ещё нет. Пока хоть один в пути, карта закрыта завесой: при
     смене расчёта на участке половина города осталась бы от прежнего плана,
     а половина — от нового, и разницу никто бы не заметил.

     Считается из того же, что рисует карту, отдельного «идёт загрузка» не
     держим: лишний признак живёт своей жизнью и однажды остаётся поднятым
     навсегда. */
  const awaiting = runs.filter((id) => id !== runId && !others.has(id));

  /* Участки, снятые с карты. Смотрят за тремя районами разом, а разбирают
     по одному: сорок маршрутов на одном городе — это каша, и способ из неё
     выйти должен быть под рукой. Сняли участок — его нет ни на карте, ни в
     числах смены: они считаются по тому, что показано, иначе полоса внизу
     говорила бы об одном дне, а город показывал другой. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const shownRuns = runs.filter((id) => !hidden.has(id));

  /* Что показываем: открытый день плюс догруженные, в том порядке, в каком
     их отметили. Пока чужой день грузится, на карте просто меньше участков —
     это честнее, чем держать её пустой до последнего ответа. */
  const merged = useMemo(() => {
    const parts = shownRuns
      .map((id) => ({ runId: id, view: id === runId ? view : others.get(id) }))
      .filter((one): one is { runId: RunId; view: DayView } => Boolean(one.view));
    return mergeDays(parts.length > 0 ? parts : [{ runId, view }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownRuns.join('|'), runId, view, others]);
  const shown = merged?.view ?? view;

  /* Чей маршрут, когда участков несколько: номер сквозной по базе и считается
     от пары «расчёт — инженер», а не от составного номера с общей карты. */
  const routeKeyOf = (engineerId: string) =>
    merged?.owner.get(engineerId) ?? { runId, engineerId };

  /* Чей это участок. На общей карте лежат дни трёх районов, и место выезда
     у них бывает одно на всех: без имени участка «Общий выезд» не говорит
     главного — чья это бригада. */
  const zoneOf = (engineerId: string) => {
    const owner = merged?.owner.get(engineerId);
    return owner ? dayLabel(owner.runId as RunId, runDate(owner.runId as RunId)).split(' · ')[0] : null;
  };


  /* Обстановка в городе. Читается при открытии и раз в пять минут: баллы
     держатся дольше, а чаще спрашивать чужой источник незачем. Не ответил —
     строки о пробках на плашке просто нет. */
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  useEffect(() => {
    let alive = true;
    const ask = () => {
      loadTraffic().then((next) => {
        if (alive) setTraffic(next);
      });
    };
    ask();
    const id = window.setInterval(ask, 300_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  /* Подписка на «взят в работу»: сам список не нужен — нужно, чтобы плашка
     перерисовалась, когда расчёт берут в работу или снимают с неё. */
  useDuty();

  /* Участки, за которыми смотрим: кто ведёт день, сколько людей в смене и
     чьи маршруты на карте.

     Перечень маршрутов стоял отдельной карточкой в том же углу и повторял
     общий список для трёх районов разом: четырнадцать строк подряд, и по
     какому участку идёт каждая, читалось только по номеру. Здесь он разобран
     по участкам и убран внутрь — район раскрывают, когда смотрят именно на
     него.

     Цвет и опознание маршрута берутся с общей карты, а не считаются заново:
     на карте порядок маршрутов задаёт цвет, и отдельный счёт развёл бы
     точку в списке с линией на городе. Имя участка берём у того же слоя,
     что собирает ключ дня, — иначе подпись здесь и подпись на кнопке
     «В работу» разойдутся. */
  const groups = useMemo(() => {
    const list = runs.map((id) => ({
      run: id,
      code: runCode(id),
      date: runDate(id),
      place: dayLabel(id, runDate(id)).split(' · ')[0],
      /* Инженеров в смене — всех, и тех, кому работы не досталось: сколько
         людей на участке, спрашивают про людей, а не про линии. */
      crew: 0,
      routes: [] as {
        id: string;
        number: string;
        color: string;
        ride: string;
        name: string;
        visits: number;
        occupancy: number;
      }[]
    }));
    const byRun = new Map(list.map((one) => [one.run, one]));
    /* Скрытого участка на общей карте нет, и маршрутов у него в перечне не
       будет: перечень рассказывает про то, что видно. */
    shown.loads.forEach((load, index) => {
      const owner = merged?.owner.get(load.engineer.id) ?? { runId, engineerId: load.engineer.id };
      const group = byRun.get(owner.runId as RunId);
      if (!group) return;
      group.crew += 1;
      if (!load.route || load.route.stops.length === 0) return;
      group.routes.push({
        id: load.engineer.id,
        number: routeLabel(routeNumber(owner.runId, owner.engineerId)),
        color: routeColor(index),
        ride: transportIcon(load.engineer.transport ?? ''),
        name: load.engineer.name,
        visits: load.visits,
        occupancy: load.occupancy
      });
    });
    for (const group of list) group.routes.sort((a, b) => a.number.localeCompare(b.number));
    return list;
  }, [runs, runId, shown, merged]);

  /* Раскрытый участок и участок, которому меняют расчёт, — по одному за раз.
     Три раскрытых списка разом не поместились бы в угол карты, а два
     раскрытых ряда «чем ведём» сделали бы из плашки базу расчётов. */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [pickGroup, setPickGroup] = useState<string | null>(null);

  /* Выбрали на карте маршрут или заявку — плашка открывает тот участок,
     которому они принадлежат, и подводит к нужной строке.

     Без этого ответ на щелчок расходился надвое: внизу слева вставала
     сводка о выбранном, а наверху справа участок этого маршрута оставался
     свёрнутым, будто щёлкнули не по нему. Разворачивает участок сам экран —
     спрашивать «а в каком он районе» диспетчеру не приходится. */
  const chosen = pinned ?? (selectedOrder ? shown.stopByOrder.get(selectedOrder)?.engineerId : null);
  const chosenRun = chosen ? merged?.owner.get(chosen)?.runId : null;
  useEffect(() => {
    if (!chosenRun) return;
    setOpenGroup(chosenRun);
    setPickGroup(null);
  }, [chosenRun, chosen]);

  /* И подводит к строке: у участка их четырнадцать, а перечень в углу
     карты показывает восемь — выбранный маршрут мог остаться за нижним
     краем. */
  useEffect(() => {
    if (!chosen) return;
    const row = document.querySelector<HTMLElement>(`[data-route="${CSS.escape(chosen)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [chosen, openGroup]);

  /* Чем ещё можно вести этот день: расчёты того же участка на ту же дату.
     Список тот же, что в меню раздела, — там его и собирают. */
  const days = workDays();
  const runsOfDay = (id: RunId) => days.find((day) => day.runs.includes(id)) ?? null;

  /* Выбрали маршрут или заявку — полоса чисел уступает место сводке о
     выбранном. */
  const picked = Boolean(pinned || selectedOrder);

  const cut = cutMinutes(now);
  const wall = now.getHours() * 60 + now.getMinutes();
  const beforeShift = wall < dayStart();
  const afterShift = wall > dayEnd();
  /* Какой день разложен в плане. Часы идут настенные, а план — на день
     выгрузки, и без подписи «сейчас 14:20» на плане 17 августа читалось бы
     как сегодняшнее положение дел. */
  const planDay = runDate(runId).split('-').reverse().join('.');

  const roster = useMemo(() => buildLiveRoster(shown, cut), [shown, cut]);
  const sorted = useMemo(
    () => [...roster].sort((a, b) => RANK[a.status] - RANK[b.status] || a.engineer.name.localeCompare(b.engineer.name)),
    [roster]
  );
  const alerts = useMemo(
    () => sorted.filter((row) => row.status === 'overdue'),
    [sorted]
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of roster) map.set(row.status, (map.get(row.status) ?? 0) + 1);
    return map;
  }, [roster]);

  /* Ход работы числами. Одни и те же в обоих видах — в обзоре полосой поверх
     города, в сводке плитками над списком, — поэтому считаются один раз.

     Порядок не случаен: сперва те, кто сейчас в деле, потом беда, потом
     запас. Опаздывающие стоят третьими, а не первыми: читают полосу слева
     направо, и начинать день с чужой беды незачем — она никуда не денется
     и помечена цветом. */
  const tiles = [
    { key: 'working', label: 'На объекте', value: counts.get('working') ?? 0, caption: 'Работают прямо сейчас', bad: false },
    { key: 'enroute', label: 'В пути', value: counts.get('enroute') ?? 0, caption: 'Едут к следующей заявке', bad: false },
    { key: 'overdue', label: 'Опаздывают', value: counts.get('overdue') ?? 0, caption: 'Не успевают к сроку', bad: true },
    { key: 'done', label: 'Освободились', value: counts.get('done') ?? 0, caption: 'День закончен', bad: false },
    {
      key: 'before',
      label: 'Ещё не в работе',
      value: (counts.get('before') ?? 0) + (counts.get('no-route') ?? 0),
      caption: 'Смена не началась',
      bad: false
    }
  ];

  /* Часы настенные и не замирают: срез плана прижат к границам смены, и это
     сказано отдельной строкой, а не подменой времени — «21:00, обновлено
     21:30» читалось как поломка. */
  const clock = (
    <span className="livenow" title="Текущее время: раздел показывает состояние плана на эту минуту и обновляется сам">
      <span className="livenow__dot" />
      {hhmm(wall)}
      <span className="livenow__stamp">
        {planDay ? `план от ${planDay} · ` : ''}обновлено {hhmm(wall)}
      </span>
    </span>
  );

  const offShift =
    beforeShift || afterShift ? (
      <p className="clients__lede">
        {beforeShift
          ? `Смена по плану начинается в ${hhmm(dayStart())}: часы ещё вне рабочего окна, показано положение на её начало.`
          : `Смена по плану закончилась в ${hhmm(dayEnd())}: часы уже вне рабочего окна, показано положение на её конец.`}
      </p>
    ) : null;

  /* Обзор — город во весь экран, как в диспетчерской, а числа полосой поверх
     него. Мониторинг отвечает на «как идёт работа», и ответ этот прежде
     всего зрительный: где люди сейчас, кто куда едет. Таблица под картой на
     этот вопрос отвечала последней — до неё доезжали колесом. */
  if (mode === 'overview') {
    return (
      <div className="mapview enter">
        <MapBoard
          view={shown}
          runId={runId}
          routeKeyOf={routeKeyOf}
          live={live}
          onLive={onLive}
          pinned={pinned}
          onPin={onPin}
          focus={focus}
          onSelectOrder={(id) => {
            onSelectOrder(id);
            onShowRoute(id ? (shown.stopByOrder.get(id)?.engineerId ?? null) : null);
          }}
          onSelectEngineer={onSelectEngineer}
          selectedOrder={selectedOrder}
          fill
          /* Перечень маршрутов у карты погашен: они разобраны по участкам
             внутри плашки смены. */
          routeList={false}
          zoneOf={zoneOf}
          /* Щелчок по общему выезду раскрывает его участок в плашке:
             спрашивают «кто отсюда выезжает», а перечень выезжающих лежит
             там. Прозрачностью на карте он не заведует — это дело
             наведения, и держит его сама карта. */
          onSelectNest={(ids) => {
            const owner = ids.length > 0 ? merged?.owner.get(ids[0]) : undefined;
            setOpenGroup(owner ? (owner.runId as RunId) : null);
            setPickGroup(null);
          }}
          busy={awaiting.length > 0}
          busyNote={awaiting
            .map((id) => dayLabel(id, runDate(id)).split(' · ')[0])
            .join(', ')}
          topRight={
            <section className="livecard" aria-label="Смена сейчас">
              <span className="livecard__now">
                <span className="livecard__dot" aria-hidden="true" />
                <span className="livecard__time">{hhmm(wall)}</span>
                {/* День рядом с часами: смотрят на живую смену, и «12:20»
                    без дня недели одинаково подходит любому вторнику. */}
                <span className="livecard__when">
                  / {weekdayName(now)} / {dayDot(now)}
                </span>
              </span>

              {/* Пробки — сразу под часами: это второе, что рассказывает о
                  минуте за окном, и стоять оно должно рядом с первым, а не
                  за перечнем участков. Нет строки — нет и сведений:
                  источник не ответил, а выдумывать баллы нельзя, по ним
                  судят о причинах опозданий. */}
              {traffic && (
                <span className="livecard__jamrow">
                  <span className="livecard__label">Пробки в Москве</span>
                  <span className="livecard__value">
                    <span className={'livecard__jam livecard__jam--' + traffic.tone} />
                    {traffic.level} {pluralWord(traffic.level, 'балл', 'балла', 'баллов')}
                  </span>
                </span>
              )}

              <span className="livecard__rows">
                {/* Участок за участком: кто ведёт день, сколько людей в
                    смене и — по нажатию — чьи маршруты сегодня на карте.
                    Участков бывает три, и общая подпись «расчёт R013» на
                    три района была бы неправдой: у каждого свой рабочий
                    расчёт, и меняют их порознь. */}
                {groups.map((group) => {
                  const off = hidden.has(group.run);
                  const open = openGroup === group.run && !off;
                  const picking = pickGroup === group.run;
                  const day = runsOfDay(group.run);
                  const others = day ? day.runs.filter((id) => id !== group.run) : [];
                  return (
                    <span
                      className={'livegroup' + (off ? ' livegroup--off' : '')}
                      key={group.run}
                    >
                      <span className="livegroup__head">
                        <button
                          type="button"
                          className={'livegroup__open' + (open ? ' livegroup__open--on' : '')}
                          onClick={() => {
                            setOpenGroup(open ? null : group.run);
                            setPickGroup(null);
                          }}
                          disabled={off}
                          aria-expanded={open}
                          title={
                            open
                              ? `Свернуть маршруты: ${group.place}`
                              : `Маршруты на сегодня: ${group.place}`
                          }
                        >
                          <span className="livegroup__place">
                            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
                            {group.place}
                          </span>
                          <span className="livegroup__crew">
                            {off ? 'скрыт' : `${group.crew} инж.`}
                          </span>
                        </button>

                        {/* Глаз снимает участок с карты и из чисел смены.
                            Последний показанный снять нельзя: пустая карта
                            в живом виде — не ответ ни на один вопрос. */}
                        <button
                          type="button"
                          className={'livegroup__eye' + (off ? ' livegroup__eye--off' : '')}
                          onClick={() =>
                            setHidden((was) => {
                              const next = new Set(was);
                              if (next.has(group.run)) next.delete(group.run);
                              else next.add(group.run);
                              return next;
                            })
                          }
                          aria-pressed={!off}
                          disabled={!off && shownRuns.length <= 1}
                          title={
                            off
                              ? `Вернуть ${group.place} на карту`
                              : shownRuns.length <= 1
                                ? 'Это последний участок на карте'
                                : `Убрать ${group.place} с карты`
                          }
                        >
                          {/* Зачёркнутого глаза в наборе знаков нет, и
                              выдумывать его здесь незачем: погашенный глаз
                              рядом со словом «скрыт» говорит то же самое. */}
                          <Icon name="eye" size={13} />
                        </button>

                        {/* Номер расчёта — кнопка: день ведут одним планом,
                            а посчитано их несколько, и менять план проще
                            там же, где написано, каким ведут. */}
                        <button
                          type="button"
                          className={'livegroup__run' + (picking ? ' livegroup__run--on' : '')}
                          onClick={() => {
                            setPickGroup(picking ? null : group.run);
                            setOpenGroup(null);
                          }}
                          aria-expanded={picking}
                          disabled={others.length === 0 && !picking}
                          title={
                            others.length === 0
                              ? `${group.code} — единственный расчёт на этот день`
                              : `Ведёт ${group.code} · сменить расчёт`
                          }
                        >
                          {group.code}
                          <Icon name="chevron-down" size={11} />
                        </button>
                      </span>

                      {/* Чем ещё можно вести этот день. Выбранный расчёт
                          встаёт на работу сразу — карта под завесой
                          перекладывается на его план. */}
                      {picking && (
                        <span className="livegroup__runs">
                          {others.length === 0 ? (
                            <span className="livegroup__empty">
                              Других расчётов на этот день нет
                            </span>
                          ) : (
                            others.map((id) => (
                              <button
                                key={id}
                                type="button"
                                className="livegroup__pick"
                                onClick={() => {
                                  takeDuty(id, day?.date ?? group.date);
                                  setPickGroup(null);
                                }}
                                title={`Вести ${group.place} расчётом ${runCode(id)}`}
                              >
                                <span className="livegroup__pick-code">{runCode(id)}</span>
                                <span className="livegroup__pick-note">взять в работу</span>
                              </button>
                            ))
                          )}
                        </span>
                      )}

                      {/* Маршруты участка. Наведение подсвечивает путь на
                          карте, нажатие оставляет его одного — то же, что
                          делал общий перечень, только теперь видно, чей
                          маршрут. */}
                      {open && (
                        <span className="livegroup__list">
                          {group.routes.length === 0 ? (
                            <span className="livegroup__empty">
                              Маршрутов нет: план на этот участок пуст.
                            </span>
                          ) : (
                            group.routes.map((route) => (
                              <button
                                key={route.id}
                                type="button"
                                className={
                                  'livegroup__item' +
                                  (chosen === route.id ? ' livegroup__item--on' : '') +
                                  (live === route.id && chosen !== route.id
                                    ? ' livegroup__item--live'
                                    : '')
                                }
                                onMouseEnter={() => onLive(route.id)}
                                onMouseLeave={() => onLive(null)}
                                onFocus={() => onLive(route.id)}
                                onBlur={() => onLive(null)}
                                onClick={() => onPin(pinned === route.id ? null : route.id)}
                                data-route={route.id}
                                aria-pressed={pinned === route.id}
                                title={`${route.number} · ${route.name} · ${route.visits} заявок · загрузка ${Math.round(
                                  route.occupancy * 100
                                )}%`}
                              >
                                <span
                                  className="livegroup__dot"
                                  style={{ background: route.color }}
                                />
                                <Icon name={route.ride} size={12} />
                                <span className="livegroup__num">{route.number}</span>
                                <span className="livegroup__who">{surnameOf(route.name)}</span>
                                <span className="livegroup__visits">{route.visits}</span>
                              </button>
                            ))
                          )}
                        </span>
                      )}
                    </span>
                  );
                })}

              </span>

              {(beforeShift || afterShift) && (
                <span className="livecard__off">
                  {beforeShift
                    ? `Смена по плану с ${hhmm(dayStart())} — показано её начало.`
                    : `Смена по плану до ${hhmm(dayEnd())} — показан её конец.`}
                </span>
              )}

              {/* Отметка обмена — самым тихим, что есть на плашке: она не
                  сообщает ничего нового, она свидетельствует, что число
                  выше живое. «Синхронизация», а не «обновлено»: обновляется
                  вид, а сверяются с источником — и сказано про второе. */}
              <span className="livecard__foot">
                <span className="livecard__stamp">синхронизация: {hhmm(wall)}</span>
              </span>
            </section>
          }
          /* Числа хода работы — полосой внизу, на том же месте, где в
             диспетчерской стоят итоги расчёта: там их и ищут глазами. Наверху
             справа — состояние смены, здесь — её счёт.

             Выбрали маршрут или заявку — на том же месте встаёт сводка о
             выбранном, ровно как в диспетчерской. Прежде мониторинг на
             щелчок отвечал одной подсветкой: линия становилась ярче, а что
             это за маршрут и чья это заявка, экран не говорил. */
          aside={
            <div className={'mapdrag' + (picked ? ' mapdrag--pick' : '')}>
              {picked ? (
                <MapPick
                  view={shown}
                  runId={runId}
                  routeKeyOf={routeKeyOf}
                  pinned={pinned}
                  selectedOrder={selectedOrder}
                  nest={null}
                  onPickRoute={(id) => {
                    onLive(null);
                    onPin(id);
                  }}
                  onHoverRoute={onLive}
                  onClose={() => {
                    onSelectOrder(null);
                    onPin(null);
                  }}
                />
              ) : (
                <MonitorTiles tiles={tiles} />
              )}
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Ход работы</h2>
          {clock}
        </div>

        {offShift}

        <div className="dbstats">
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('working') ?? 0}</span>
            <span className="dbstat__label">На объекте</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('enroute') ?? 0}</span>
            <span className="dbstat__label">В пути</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('overdue') ?? 0}</span>
            <span className="dbstat__label">Опаздывают</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('done') ?? 0}</span>
            <span className="dbstat__label">Освободились</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{(counts.get('before') ?? 0) + (counts.get('no-route') ?? 0)}</span>
            <span className="dbstat__label">Ещё не в работе</span>
          </div>
        </div>
      </section>

      {alerts.length > 0 && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Требуют внимания</h2>
            <span className="dash__section-note">{alerts.length} опаздывают прямо сейчас</span>
          </div>
          <div className="alerts">
            {alerts.map((row) => (
              <button
                key={row.engineer.id}
                type="button"
                className="alert alert--danger"
                onClick={() => row.orderId && onSelectOrder(row.orderId)}
                onMouseEnter={() => onLive(row.engineer.id)}
                onMouseLeave={() => onLive(null)}
              >
                <Icon name="alert-triangle" size={16} />
                <span className="alert__body">
                  <span className="alert__title">{row.engineer.name}</span>
                  <span className="alert__note">
                    Опаздывает на {row.lateMinutes} мин
                    {row.orderId ? ` · заявка ${row.orderId}` : ''}
                  </span>
                </span>
                <Icon name="chevron-right" size={14} />
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Инженеры на смене</h2>
        </div>
        {/* Пустой состав — словами: в расчёте без инженеров пустой список
            читался бы как несработавший экран. */}
        {sorted.length === 0 ? (
          <p className="clients__lede">В этом расчёте на смене никого нет: план посчитан без инженеров.</p>
        ) : (
          <div className="roster">
            {sorted.map((row) => (
              <RosterRow
                key={row.engineer.id}
                row={row}
                view={shown}
                active={live === row.engineer.id || pinned === row.engineer.id}
                onLive={onLive}
                onPin={onPin}
                onSelectEngineer={onSelectEngineer}
              />
            ))}
          </div>
        )}
      </section>

      {/* Карты здесь нет: город живёт в «Обзоре», во весь экран. Вторая
          карта под списком повторяла бы ту же работу вполовину меньшего
          размера, и смотреть на движение людей было бы неудобно в обоих
          местах сразу. */}
    </div>
  );
}

/* Полоса хода работы — числа смены поверх карты. Отдельным лицом, потому
   что стоит она то на карте, то уступает место сводке выбранного, а список
   плиток у неё один и тот же. */
function MonitorTiles({
  tiles
}: {
  tiles: { key: string; label: string; value: number; caption: string; bad: boolean }[];
}) {
  return (
    <section className="mapstat" aria-label="Ход работы сейчас">
      <div className="mapstat__metrics">
        {tiles.map((tile) => (
          <span key={tile.key} className="cmetric cmetric--flat" title={tile.caption}>
            <span className="cmetric__label">
              {tile.bad && tile.value > 0 && <span className="cmetric__dot cmetric__dot--bad" />}
              {tile.label}
            </span>
            <span className="cmetric__value">
              {tile.value}
              <span className="cmetric__unit">чел.</span>
            </span>
            <span className="cmetric__caption">{tile.caption}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

function RosterRow({
  row,
  view,
  active,
  onLive,
  onPin,
  onSelectEngineer
}: {
  row: LiveEngineer;
  view: DayView;
  active: boolean;
  onLive: (id: string | null) => void;
  onPin: (id: string | null) => void;
  onSelectEngineer: (id: string) => void;
}) {
  /* Куда едет и что делает — адресом и видом работ, а не одним номером:
     «Едет к R0193» ничего не говорит тому, кто не держит номера в голове.
     Номер остаётся в подсказке. */
  const target = row.orderId ? view.orderById.get(row.orderId) : undefined;
  const where = target ? `${placeOf(target)} · ${target.work_title}` : row.orderId ?? '';
  return (
    <button
      type="button"
      className={'roster__row' + (active ? ' roster__row--active' : '')}
      onMouseEnter={() => onLive(row.engineer.id)}
      onMouseLeave={() => onLive(null)}
      onClick={() => {
        onPin(row.engineer.id);
        onSelectEngineer(row.engineer.id);
      }}
    >
      <span className="roster__name">{row.engineer.name}</span>
      <span className={'pill pill--' + row.tone}>{row.label}</span>
      <span className="roster__note" title={row.orderId ? `Заявка ${row.orderId}` : undefined}>
        {row.status === 'overdue' && `Опаздывает на ${row.lateMinutes} мин${where ? ` · ${where}` : ''}`}
        {row.status === 'working' && row.orderId && `Работает: ${where}`}
        {row.status === 'enroute' && row.orderId && `Едет: ${where}`}
        {(row.status === 'done' || row.status === 'before' || row.status === 'no-route') && '—'}
      </span>
      <span className="roster__visits">
        {row.visitsDone} из {row.visitsTotal}
      </span>
    </button>
  );
}
