import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import {
  buildDayView,
  buildLiveRoster,
  clampDay,
  dayDot,
  dayEnd,
  dayStart,
  hhmm,
  mergeDays,
  pluralWord,
  weekdayName
} from '../data/derive.ts';
import { loadDay, runCode, runDate, runDay } from '../data/load.ts';
import type { RunId } from '../data/load.ts';
import { dayLabel, takeDuty, useDuty, workDays } from '../data/duty.ts';
import { markWatch } from '../data/watch.ts';
import { markMonitor } from '../data/monitor.ts';
import { buildLiveSpots } from '../data/live.ts';
import { loadTraffic } from '../data/traffic.ts';
import type { Traffic } from '../data/traffic.ts';
import { MapBoard, routeColor, surnameOf } from '../app/MapBoard.tsx';
import { zonePalette } from '../data/zones.ts';
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
  /** Пишутся ли отметки в журнал смены и в запись мониторинга. Гасится,
      когда смотрят прошедший день: числа вчерашнего плана, записанные в
      сегодняшнюю смену, — не отметка, а ложь о том, как шёл этот день. */
  logging?: boolean;
  /** День прошедшего мониторинга, если смотрят его, а не сегодняшний. ISO.
      Пусто — открыт живой день. */
  reviewDay?: string | null;
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
  /** Открыть разбор записи поверх карты — карточкой из баз. Заявка знает
      свой расчёт: на общей карте лежат дни трёх участков. */
  onOpenOrder: (runId: string, orderId: string) => void;
  onOpenEngineer: (dayName: string | null, engineerId: string) => void;
  /** Собрать новый расчёт: туда ведёт предупреждение о пробках. */
  onRecalc: () => void;
  onSelectEngineer: (id: string) => void;
}

/* Средства передвижения в том порядке, в каком их читают: сперва машины —
   их большинство, — потом всё остальное. Значки те же, что в перечнях
   маршрутов и в базах. */
/* С какого числа баллов город считается вставшим. Пять — обычный
   московский день; шесть и выше означает, что дорога идёт не так, как
   заложено в расчёте. */
const JAM_ALERT = 6;

/* Как часто раздел сверяется с часами, миллисекунды. */
const BEAT_MS = 250;

/* Скорости ручки: настоящее время и ускоренный ход. Двух хватает: между
   «как в жизни» и «день за десять минут» третьей меры нет — её выбирали бы
   дольше, чем она экономит. */
const SPEEDS = [
  { value: 1, label: '×1', title: 'Время идёт как настоящее' },
  { value: 60, label: '×60', title: 'Ускоренный ход: минута плана за секунду' }
];

const RIDES = [
  { key: 'car', icon: 'car', title: 'Автомобиль' },
  { key: 'transit', icon: 'bus', title: 'Общественный транспорт' },
  { key: 'walk', icon: 'person-walk', title: 'Пешком' },
  { key: 'bike', icon: 'bicycle', title: 'Велосипед' }
];

/* Мониторинг. Диспетчерская отвечает на «каким должен быть план» и живёт от
   среза, который двигает диспетчер; мониторинг отвечает на «что происходит
   сейчас» и читает то же время, что на часах, — сам, без ручки. Здесь нет
   пересчёта и нет пульта: только то, что план обещал, и то, что видно на
   срезе прямо сейчас. */
export function MonitorScreen({
  view,
  runId,
  runs,
  logging = true,
  reviewDay = null,
  live,
  onLive,
  pinned,
  onPin,
  onShowRoute,
  focus,
  selectedOrder,
  onSelectOrder,
  onOpenOrder,
  onOpenEngineer,
  onRecalc,
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

  /* Секундный такт — для живых точек на карте.

     Числа смены от него не зависят: в данных ничего чаще минуты не меняется,
     и пересчитывать состав смены каждую секунду не за чем. А вот инженер,
     переставляемый раз в минуту, читается как поломка — стоит двадцать
     секунд, потом прыгает на квартал. Поэтому такт частый, а срез,
     по которому считаются числа, по-прежнему целая минута. */
  /* Такт чаще секунды нарочно. Точка на карте доезжает между тактами сама —
     плавность ей даёт переход, — но переход идёт по прямой, а дорога
     поворачивает: чем реже такт, тем заметнее точка срезает углы. Четверть
     секунды — та мера, при которой на ускоренном ходу срезка меньше
     толщины линии.

     Числа смены от такта не зависят: они считаются по целой минуте среза и
     между её сменами не пересчитываются. */
  const [beat, setBeat] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setBeat(Date.now()), BEAT_MS);
    return () => window.clearInterval(id);
  }, []);

  /* Ручка среза.

     Мониторинг живёт по настенным часам — и это правильно: он отвечает на
     «что происходит сейчас». Но данные под ним — план на день выгрузки, и в
     три часа ночи или в восемь утра на карте не происходит ничего: смена
     ещё не началась, точек нет, и показать живой вид нельзя вовсе.
     Диспетчеру же и руководителю случается смотреть на него именно в эти
     часы.

     Поэтому рядом с часами стоит ручка: срез можно отвести на любой час
     смены и пустить время быстрее — минута плана за секунду. Тихая нарочно:
     по умолчанию её нет, есть настоящее время, и вернуться к нему — одно
     нажатие. Пока ручка отведена, часы прямо говорят, что показан не
     нынешний час, а выбранный: подменять время молча нельзя, по нему
     сверяются с бригадой.

     `null` — идём по часам. Иначе минута среза, ход (во сколько раз время
     идёт быстрее настоящего) и признак того, что оно идёт. Ход и пуск
     разведены нарочно: скорость выбирают один раз, а останавливают и
     пускают много, и кнопка «стоп», стирающая выбранную скорость, заставляла
     бы выбирать её заново после каждой остановки. */
  const [hand, setHand] = useState<{ at: number; speed: number; play: boolean } | null>(null);

  /* Оговорку об опытном виде можно убрать с карты — она честная, но не
     новость: прочитав её однажды, диспетчер работает дальше. Закрытие живёт
     ровно столько, сколько открыт раздел: вернулся в мониторинг — оговорка
     снова на месте. Помнить её закрытой навсегда нельзя, пока настоящего
     отслеживания нет: карта каждый раз обещает то, чего не делает. */
  const [noteOff, setNoteOff] = useState(false);
  /* Когда ручку двигали в последний раз. Ход считается от настоящего
     времени, а не от числа тактов: такт может задержаться — вкладка ушла в
     тень, браузер сберёг батарею, — и счёт по тактам отстал бы от часов. */
  const handAt = useRef(0);

  /* Ход ручки. Срез растёт ровно на столько, сколько прошло настоящего
     времени, помноженное на выбранный ход. Дошли до конца смены — ручка
     сама встаёт: дальше в плане ничего нет. */
  useEffect(() => {
    if (!hand || !hand.play) return;
    const now = Date.now();
    const went = Math.max(0, now - (handAt.current || now));
    handAt.current = now;
    if (went === 0) return;
    setHand((was) => {
      if (!was || !was.play) return was;
      const next = was.at + (went / 60_000) * was.speed;
      /* Догнали настоящее время — ручка не нужна: отпускаем её, и раздел
         снова идёт по часам. Останавливать срез на месте было бы хуже:
         диспетчер остался бы с замершим городом и оговоркой о неактуальном
         времени там, где время как раз стало актуальным. */
      return next >= ceiling ? null : { ...was, at: next };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [beat]);

  /* Тронуть ручку. Отдельным действием, потому что зовут его трое: ползунок,
     выбор хода и кнопка пуска, — и каждому надо не забыть отметить, откуда
     считать прошедшее время. Что не названо, то остаётся прежним: сменили
     скорость — время продолжает идти, тронули ползунок — скорость та же. */
  const setSlice = (change: { at?: number; speed?: number; play?: boolean }) => {
    handAt.current = Date.now();
    setHand((was) => {
      const base = was ?? { at: ceiling, speed: 1, play: true };
      const at = change.at ?? base.at;
      return {
        at: Math.min(ceiling, Math.max(dayStart(), at)),
        speed: change.speed ?? base.speed,
        play: change.play ?? base.play
      };
    });
  };

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
  /* Отбор по средству передвижения. Пусто — показаны все: отбор нужен не
     каждый день, и молчание здесь значит «весь город», а не «ничего».

     Скрытый вид уходит с карты целиком — и маршруты, и точки их заявок:
     иначе на карте оставались бы кружки без путей, и было бы непонятно,
     кто к ним едет. */
  const [rides, setRides] = useState<Set<string>>(new Set());

  const whole = merged?.view ?? view;
  const shown = useMemo(() => {
    if (rides.size === 0) return whole;
    const keep = whole.loads.filter((load) => rides.has(load.engineer.transport ?? 'car'));
    const mine = new Set(keep.map((load) => load.engineer.id));
    const stopByOrder = new Map(
      [...whole.stopByOrder].filter(([, place]) => mine.has(place.engineerId))
    );
    const orderById = new Map(
      [...whole.orderById].filter(([id]) => stopByOrder.has(id) || !whole.stopByOrder.has(id))
    );
    return {
      ...whole,
      loads: keep,
      engineerById: new Map([...whole.engineerById].filter(([id]) => mine.has(id))),
      routeByEngineer: new Map([...whole.routeByEngineer].filter(([id]) => mine.has(id))),
      stopByOrder,
      orderById
    };
  }, [whole, rides]);

  /* Чей маршрут, когда участков несколько: номер сквозной по базе и считается
     от пары «расчёт — инженер», а не от составного номера с общей карты. */
  const routeKeyOf = useCallback(
    (engineerId: string) => merged?.owner.get(engineerId) ?? { runId, engineerId },
    [merged, runId]
  );

  /* Чей это участок. На общей карте лежат дни трёх районов, и место выезда
     у них бывает одно на всех: без имени участка «Общий выезд» не говорит
     главного — чья это бригада.

     Запомнено намертво, и это не бережливость ради бережливости. По этим
     двум определителям карта считает земли участков — межу по дорожной сети
     города, сотни ломаных, четверть секунды работы. Считает она их заново,
     когда определитель приходит другим, а созданный в ходе отрисовки он
     другой всегда. Пока раздел перерисовывался раз в двадцать секунд, этого
     никто не замечал; с живыми точками он ожил каждую секунду — и карта
     встала намертво, пересчитывая границы города по шестьдесят раз в
     минуту. */
  const zoneOf = useCallback(
    (engineerId: string) => {
      const owner = merged?.owner.get(engineerId);
      return owner
        ? dayLabel(owner.runId as RunId, runDate(owner.runId as RunId)).split(' · ')[0]
        : null;
    },
    [merged]
  );


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
  /* Цвета участков — на весь набор сразу и по всем отмеченным дням, а не
     по показанным: сняли участок с карты, вернули обратно — цвет у него тот
     же, каким был. Карта берёт цвет отсюда же. */
  const tints = useMemo(
    () => zonePalette(runs.map((id) => dayLabel(id, runDate(id)).split(' · ')[0])),
    [runs]
  );
  const zoneTint = useCallback(
    (title: string) => tints.get(title) ?? 'var(--glass-ink-soft)',
    [tints]
  );

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

  /* Сколько человек каким средством едет. Считается по всем показанным
     участкам, а не по отобранным: иначе нажатая кнопка обнуляла бы счёт у
     соседних и отбор нельзя было бы расширить. */
  const tally = useMemo(() => {
    const map = new Map<string, number>();
    for (const load of whole.loads) {
      const ride = load.engineer.transport ?? 'car';
      map.set(ride, (map.get(ride) ?? 0) + 1);
    }
    return map;
  }, [whole]);

  /* Выбрали маршрут или заявку — полоса чисел уступает место сводке о
     выбранном. */
  const picked = Boolean(pinned || selectedOrder);

  /* Время на часах — дробными минутами: внутри минуты живая точка едет, и
     без дробной части она стояла бы и прыгала. */
  const tick = new Date(beat);
  const wallFine = tick.getHours() * 60 + tick.getMinutes() + tick.getSeconds() / 60;
  /* Срез, на котором стоит весь раздел: по часам или отведённый ручкой. */
  const flow = hand ? hand.at : wallFine;
  /* Числа смены считаются по целой минуте: в плане ничего дробнее нет, и
     пересчитывать состав шестьдесят раз в минуту незачем. */
  const cut = clampDay(Math.floor(flow));
  const wall = Math.floor(flow);
  /* Настоящее время — им подписана синхронизация: обмен идёт сейчас, куда бы
     ни отвели срез. */
  const sync = Math.floor(wallFine);

  /* Докуда можно отвести срез. Дальше настоящего времени — нельзя: за ним
     у мониторинга нет ответа. План на остаток дня, конечно, известен — но
     это план, а не то, что происходит; живой вид, показывающий половину
     седьмого в половине пятого, обещал бы знание будущего, которого нет ни
     у кого. Назад — сколько угодно: прошлое сегодняшней смены уже случилось.

     Часы прижаты к границам смены: до её начала отводить некуда, и ручка
     стоит на первой минуте. */
  const ceiling = clampDay(Math.floor(wallFine));

  /* Показанное время разошлось с настоящим. Не то же, что «ручка тронута»:
     на ходу ×1 срез идёт вровень с часами и показывает ровно ту же минуту —
     кричать о неактуальном времени, когда оно актуально, значит приучить
     не читать предупреждение вовсе. Расходится — говорим. */
  const stale = hand !== null && Math.abs(wall - sync) >= 1;
  const beforeShift = wall < dayStart();
  const afterShift = wall > dayEnd();

  /* Где инженеры на этот срез. Считается по дробной минуте — тем и живёт
     карта: точка едет внутри минуты, а не переставляется на её границе.

     По показанному, а не по всему наблюдаемому: снятый с карты участок точек
     не получает, и отбор по транспорту убирает их вместе с линиями. */
  const spots = useMemo(() => buildLiveSpots(shown, flow), [shown, flow]);
  /* Какой день разложен в плане. Часы идут настенные, а план — на день
     выгрузки, и без подписи «сейчас 14:20» на плане 17 августа читалось бы
     как сегодняшнее положение дел. */
  const planDay = runDate(runId).split('-').reverse().join('.');
  /* Мониторинг не сегодняшнего дня. Раздел отвечает на «что происходит
     сейчас», и всё на нём читают как настоящее положение дел; но смотреть
     можно и прошедшую запись — её выбирают лентой мониторингов в подшапке.
     Тогда на карте не работа за окном, а план того дня, разложенный на
     нынешний час, и молчать об этом нельзя: по таким числам звонят в
     бригаду. Оговорка стоит первой строкой плашки и не гаснет. */
  const reviewStamp = reviewDay ? reviewDay.split('-').reverse().join('.') : null;

  const roster = useMemo(() => buildLiveRoster(shown, cut), [shown, cut]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of roster) map.set(row.status, (map.get(row.status) ?? 0) + 1);
    return map;
  }, [roster]);

  /* Отметка в журнале смены: раздел открыт, и вот что в нём видно на эту
     минуту.

     Пишется здесь, а не в оболочке: только живой вид знает, за какими
     участками смотрят и что с ними к этому часу. Числа те же, что на полосе
     итогов, — второй раз они нигде не считаются. Отметка идёт с шагом
     самого раздела (раз в двадцать секунд), а журнал уже сам решает, что из
     этого записать: см. `markWatch`. */
  const visitsDone = useMemo(() => roster.reduce((sum, row) => sum + row.visitsDone, 0), [roster]);
  const ordersAll = shown.orderById.size;
  const assignedShare = ordersAll > 0 ? ((ordersAll - shown.unassigned.length) / ordersAll) * 100 : 0;

  /* Разбор по районам для записи мониторинга. Считается по дням районов
     порознь, а не по общей карте: вопрос «сколько инженеров было на Востоке
     и сколько маршрутов они закрыли» задают о районе.

     Берём все наблюдаемые районы, а не показанные: снятый с карты район из
     наблюдения не выходит — его сняли, чтобы разглядеть соседа, — и отбор по
     средству передвижения к записи тоже не относится. */
  const parts = useMemo(() => {
    return runs
      .map((id) => {
        const day = id === runId ? view : others.get(id);
        if (!day) return null;
        const crew = buildLiveRoster(day, cut);
        const routes = crew.filter((row) => row.route && row.route.stops.length > 0);
        return {
          run: id,
          place: dayLabel(id, runDate(id)).split(' · ')[0],
          date: runDate(id),
          engineers: crew.length,
          onShift: crew.filter((row) => row.status !== 'off').length,
          routes: routes.length,
          /* Пройденный маршрут — тот, у которого позади все точки. Это и
             есть «маршрутов выполнено»: маршрут кончается последней
             заявкой, и половина пути выполнением не считается. */
          routesDone: routes.filter((row) => row.visitsDone >= row.visitsTotal).length,
          orders: day.orderById.size,
          done: crew.reduce((sum, row) => sum + row.visitsDone, 0)
        };
      })
      .filter((part): part is NonNullable<typeof part> => part !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.join('|'), runId, view, others, cut]);

  useEffect(() => {
    const result = {
      orders: ordersAll,
      done: visitsDone,
      onShift: roster.filter((row) => row.status !== 'off').length,
      engineers: roster.length,
      late: counts.get('overdue') ?? 0,
      assigned: assignedShare
    };
    if (logging) {
      markWatch(result);
      /* Та же отметка идёт в запись запуска: смена копит календарный день,
         запись — одно наблюдение с его районами. */
      markMonitor(result, parts);
    }
    /* Отметка идёт по своим часам — раз в двадцать секунд, — а не по всякой
       перемене чисел. На ускоренном ходу срез пробегает минуту за секунду, и
       привязка к числам смены писала бы журнал по четыре раза в секунду:
       журнал рассказывает о наблюдении, а не о каждом кадре. Числа он берёт
       те, что видны в эту минуту. */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now]);

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

  /* Часы смены для шкалы под рельсом и место минуты на ней, долей ширины. */
  const atPercent = (minute: number) => {
    const span = dayEnd() - dayStart();
    if (span <= 0) return 0;
    const held = Math.min(dayEnd(), Math.max(dayStart(), minute));
    return ((held - dayStart()) / span) * 100;
  };
  const hourMarks: number[] = [];
  for (let minute = Math.ceil(dayStart() / 60) * 60; minute <= dayEnd(); minute += 60) {
    hourMarks.push(minute);
  }

  /* Ручка среза — тихой строкой при часах: рельс по смене, кнопка хода и
     возврат к настоящему времени. Стоит она в обоих видах раздела, потому
     что срез в них один: отвели его в обзоре — сводка отвечает о том же
     часе. */
  const handRow = (
    <span className={'livehand' + (hand ? ' livehand--on' : '')}>
      <span className="livehand__track">
        <input
          type="range"
          className="livehand__rail"
          min={dayStart()}
          max={ceiling}
          step={1}
          value={Math.min(ceiling, Math.max(dayStart(), wall))}
          /* Отвели ползунок — время пошло. Прежде оно вставало на выбранной
             минуте и стояло, пока не нажмут ход: диспетчер отводил срез,
             смотрел на замерший город и не понимал, почему живой вид не
             живой. Ход при этом берётся прежний: остановили нарочно —
             значит, и смотреть хотят стоп-кадр. */
          onChange={(e) => setSlice({ at: Number(e.target.value), play: true })}
          aria-label="Срез времени внутри смены"
          title="Отвести срез на другой час смены"
        />
        {/* Шкала под рельсом. Без неё ползунок — просто полоска: отвести
            срез «на два часа назад» по ней можно только наугад, а диспетчер
            думает часами. Засечка на каждый час, подпись через три: в углу
            карты места на тринадцать чисел нет, а ритм в три часа читается
            сам. Красная метка — настоящее время: когда срез отведён рукой,
            сразу видно, насколько далеко он ушёл от часов. */}
        <span className="livehand__scale" aria-hidden="true">
          {hourMarks.map((minute) => {
            const named = (minute / 60) % 3 === 0;
            return (
              <span
                key={minute}
                className={'livehand__tick' + (named ? ' livehand__tick--named' : '')}
                style={{ left: `${atPercent(minute)}%` }}
              >
                {named && <b>{hhmm(minute).slice(0, 2)}</b>}
              </span>
            );
          })}
          {hand && (
            <span
              className="livehand__wall"
              style={{ left: `${atPercent(sync)}%` }}
              title={`Настоящее время: ${hhmm(sync)}`}
            />
          )}
        </span>
      </span>
      {/* Ряд под шкалой разведён по трём местам, и каждое отвечает за своё.

          Слева — ход: во сколько раз время быстрее настоящего. Выбирают его
          редко и заранее, поэтому он и стоит с краю.

          Посередине, ровно под серединой шкалы, — пуск и остановка. Это то,
          что нажимают чаще всего, и место у него главное.

          Справа — выход: возврат к настоящему времени. Не кнопка, а ссылка
          словами: кнопка рядом с двумя рядами кнопок читалась бы как третий
          ход, а это не ход, а отказ от ручки вовсе. */}
      <span className="livehand__keys">
        <span className="livehand__speeds">
          {SPEEDS.map((step) => (
            <button
              key={step.value}
              type="button"
              className={
                'livehand__key' + (hand && hand.speed === step.value ? ' livehand__key--on' : '')
              }
                    onClick={() => setSlice({ speed: step.value, play: true })}
              title={step.title}
              aria-pressed={Boolean(hand && hand.speed === step.value)}
            >
              {step.label}
            </button>
          ))}
        </span>

        <button
          type="button"
          className={'livehand__run' + (hand?.play ? ' livehand__run--on' : '')}
          onClick={() => setSlice({ play: !hand?.play })}
          title={
            hand?.play
              ? 'Остановить: срез замрёт на этой минуте'
              : 'Пустить время от этой минуты'
          }
          aria-pressed={Boolean(hand?.play)}
          aria-label={hand?.play ? 'Остановить время' : 'Пустить время'}
        >
          <Icon name={hand?.play ? 'pause' : 'play'} size={12} />
        </button>

        {hand ? (
          <button type="button" className="livehand__back" onClick={() => setHand(null)}>
            к часам
          </button>
        ) : (
          <span className="livehand__back livehand__back--off">к часам</span>
        )}
      </span>
    </span>
  );

  /* Обзор — город во весь экран, как в диспетчерской, а числа полосой поверх
     него. Мониторинг отвечает на «как идёт работа», и ответ этот прежде
     всего зрительный: где люди сейчас, кто куда едет. Таблица под картой на
     этот вопрос отвечала последней — до неё доезжали колесом. */
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
        /* Где люди сейчас: точка на каждом, пройденное в цвете, будущее
           серым. В диспетчерской этого нет — там смотрят на день целиком,
           и делить его на прошлое и будущее нечем. */
        progress={spots}
        fill
        /* Перечень маршрутов у карты погашен: они разобраны по участкам
           внутри плашки смены. */
        routeList={false}
        zoneOf={zoneOf}
        zoneTint={zoneTint}
        zoneSource={whole}
        /* Щелчок по общему выезду раскрывает его участок в плашке:
           спрашивают «кто отсюда выезжает», а перечень выезжающих лежит
           там. Прозрачностью на карте он не заведует — это дело
           наведения, и держит его сама карта. */
        onSelectNest={(ids) => {
          const owner = ids.length > 0 ? merged?.owner.get(ids[0]) : undefined;
          const run = owner ? (owner.runId as RunId) : null;
          setOpenGroup(run);
          setPickGroup(null);
          /* Щелчок по общему выезду оставляет на карте один его участок:
             спрашивают «кто отсюда выезжает», а соседние районы к ответу
             не относятся. Повторный щелчок по тому же гнезду возвращает
             всех — иначе, разобравшись с одним участком, пришлось бы
             искать его глаз в плашке, чтобы вернуть остальные. */
          if (!run) return;
          setHidden((was) => {
            const alone = runs.length - was.size === 1 && !was.has(run);
            return alone ? new Set() : new Set(runs.filter((id) => id !== run));
          });
        }}
        /* Оговорка о том, что это за вид. Живые точки считаются по плану
           расчёта, а не по приборам инженеров: в выгрузке заказчика
           отслеживания нет и в контракте движка его тоже нет. Без этой
           оговорки карта обещает то, чего не делает, — и первый же
           вопрос «почему инженер на карте там, а по телефону в другом
           месте» будет задан не ей, а нам. Молчать об этом нельзя,
           прятать в подсказку — тоже: на карту смотрят, а не читают её. */
        banner={
          noteOff ? null : (
            <span className="geonote">
              <Icon name="info" size={12} />
              <span className="geonote__body">
                <b>Опытный вид мониторинга.</b> Инженеры двигаются по плану расчёта:
                отслеживания с их приборов пока нет.
              </span>
              <button
                type="button"
                className="geonote__close"
                onClick={() => setNoteOff(true)}
                aria-label="Закрыть оговорку"
                title="Закрыть: вернётся при следующем заходе в мониторинг"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          )
        }
        busy={awaiting.length > 0}
        busyNote={awaiting
          .map((id) => dayLabel(id, runDate(id)).split(' · ')[0])
          .join(', ')}
        topRight={
          <section
            className={'livecard' + (stale ? ' livecard--stale' : '')}
            aria-label="Смена сейчас"
          >
            {/* Пометка о неактуальном времени — первой строкой карточки.

                Мониторинг отвечает на «что происходит сейчас», и всё, что
                на нём написано, читают как настоящее положение дел. Стоит
                отвести срез — и каждое число на экране становится прошлым
                или будущим, оставаясь на вид живым. По таким числам звонят
                в бригаду и переставляют заявки, поэтому оговорка здесь не
                тонкая подпись при часах, а первое, что видно, и не гаснет,
                пока срез отведён.

                Кнопкой, а не надписью: сказав «вы смотрите не тот час»,
                честно тут же дать выход. */}
            {stale && (
              <button
                type="button"
                className="livecard__stale-note"
                onClick={() => setHand(null)}
                title="Вернуться к настоящему времени"
              >
                <Icon name="warning" size={13} />
                <span className="livecard__stale-body">
                  <b>Не текущее время</b>
                  <span>
                    Срез {hhmm(wall)} · часы {hhmm(sync)}
                  </span>
                </span>
                <span className="livecard__stale-back">к часам</span>
              </button>
            )}
            {/* Не сегодняшний день — та же по силе оговорка, что и об
                отведённом срезе, и стоит она там же: до часов, до чисел,
                до карты. */}
            {reviewStamp && (
              <span className="livecard__stale-note livecard__stale-note--day">
                <Icon name="warning" size={13} />
                <span className="livecard__stale-body">
                  <b>Неактуальный мониторинг</b>
                  <span>
                    Запись за {reviewStamp} · план от {planDay}. Наблюдение за сегодняшним днём
                    приостановлено.
                  </span>
                </span>
              </span>
            )}
            <span className="livecard__now">
              <span className="livecard__dot" aria-hidden="true" />
              <span className="livecard__time">{hhmm(wall)}</span>
              {/* День рядом с часами: смотрят на живую смену, и «12:20»
                  без дня недели одинаково подходит любому вторнику.
                  Отведённая ручка занимает это же место словом «срез» и
                  настоящим временем: иначе выбранный час читался бы как
                  нынешний. */}
              <span className="livecard__when">
                {stale ? `/ срез / часы ${hhmm(sync)}` : `/ ${weekdayName(now)} / ${dayDot(now)}`}
              </span>
            </span>
            {handRow}

            {/* Пробки — сразу под часами: это второе, что рассказывает о
                минуте за окном, и стоять оно должно рядом с первым, а не
                за перечнем участков. Нет строки — нет и сведений:
                источник не ответил, а выдумывать баллы нельзя, по ним
                судят о причинах опозданий. */}
            {traffic && (
              <span className="livecard__jamrow">
                <span className="livecard__label">
                  <Icon name="traffic-light" size={13} />
                  Пробки в Москве
                </span>
                <span className="livecard__value">
                  <span className={'livecard__jam livecard__jam--' + traffic.tone} />
                  {traffic.level} {pluralWord(traffic.level, 'балл', 'балла', 'баллов')}
                </span>
              </span>
            )}

            {/* Город стоит гуще, чем рассчитывал план.

                Движок о пробках не знает вовсе: время в пути у него одна
                оценка на весь день, а запас между визитами — те самые
                минуты из рычага «время и запас». Значит в день, когда
                город встал, план обещает больше, чем сможет: маршруты
                посчитаны по спокойной дороге.

                Сказать об этом должен экран — больше некому. Порог
                договорной: до пяти баллов в Москве идёт обычный день, с
                шести начинается то, чего в плане нет. */}
            {traffic && traffic.level >= JAM_ALERT && (
              <button
                type="button"
                className="livecard__alarm"
                onClick={onRecalc}
                title="Собрать новый расчёт с большим запасом между визитами"
              >
                <Icon name="warning" size={14} />
                <span className="livecard__alarm-body">
                  <b>Пробки выше расчётных</b>
                  <span>
                    План считался по спокойной дороге. Стоит пересчитать день с бо́льшим
                    запасом между визитами.
                  </span>
                </span>
                <Icon name="chevron-right" size={13} />
              </button>
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
                    <span
                      className={'livegroup__head' + (open ? ' livegroup__head--open' : '')}
                    >
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
                          {/* Цвет участка — тот же, каким он закрашен на
                              карте: точка связывает строку в плашке с
                              пятном на городе. */}
                          <i
                            className="livegroup__tone"
                            style={{ background: zoneTint(group.place) }}
                          />
                          {group.place}
                        </span>
                        <span className="livegroup__crew">
                          {off ? 'скрыт' : `${group.crew} инж.`}
                        </span>
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

            {/* Кто чем едет. Ряд стоит под участками: сперва «где чья
                земля», потом «на чём по ней ездят». Нажатая кнопка
                оставляет на карте только свой вид, нажатые вместе —
                несколько; отжать все значит вернуть весь город. */}
            <span className="liverides">
              {RIDES.map((ride) => {
                const on = rides.has(ride.key);
                const count = tally.get(ride.key) ?? 0;
                return (
                  <button
                    key={ride.key}
                    type="button"
                    className={'liveride' + (on ? ' liveride--on' : '')}
                    onClick={() =>
                      setRides((was) => {
                        const next = new Set(was);
                        if (next.has(ride.key)) next.delete(ride.key);
                        else next.add(ride.key);
                        return next;
                      })
                    }
                    aria-pressed={on}
                    disabled={count === 0 && !on}
                    title={`${ride.title}: ${count} на смене`}
                  >
                    <Icon name={ride.icon} size={13} />
                    <span className="liveride__count">{count}</span>
                  </button>
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
              <span className="livecard__stamp">синхронизация: {hhmm(sync)}</span>
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
                /* Разбор записи — поверх карты. Чей это расчёт, знает
                   общая карта: у заявки спрашиваем её инженера, у
                   инженера — день его участка. */
                onOpenOrder={(id) => {
                  const who = shown.stopByOrder.get(id)?.engineerId;
                  const owner = who ? merged?.owner.get(who) : undefined;
                  onOpenOrder(owner?.runId ?? runId, id);
                }}
                onOpenEngineer={(id) => {
                  const owner = merged?.owner.get(id);
                  onOpenEngineer(runDay(owner?.runId ?? runId), owner?.engineerId ?? id);
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
