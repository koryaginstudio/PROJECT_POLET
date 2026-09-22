/* Расчёт плана на день по данным выгрузки.

   Это не движок Григория, а его временная замена на стороне интерфейса:
   она раскладывает настоящие заявки по настоящим инженерам, соблюдая три
   обязательные группы ограничений ТЗ, и отдаёт формы контракта 1.2 в том
   же виде, в каком их отдаёт движок. Когда движок научится принимать
   реальные данные, это место заменяется на обращение к нему, а всё, что
   выше по интерфейсу, разницы не заметит.

   Алгоритм — тот самый базовый вариант, который ТЗ описывает в пункте 2.3:
   заявка назначается первому подходящему исполнителю, глобальная
   оптимизация не выполняется. Мы идём чуть дальше базового ровно на один
   шаг: заявки разбираются не в порядке выгрузки, а срочными вперёд, и
   среди подходящих исполнителей берётся тот, кто освободится раньше.
   Базовый вариант при этом считается отдельно и кладётся в `meta.baseline` —
   без него сравнивать план не с чем.

   ── Допущения, которые ТЗ разрешает прямо (пункт 3.2) ──

   Расстояние берётся по дорогам — из `roads.json`, собранного заранее по
   графу OpenStreetMap, — а время считается от него нашей скоростью для
   того транспорта, который есть у инженера. Скорость своя не по бедности:
   маршрутизатор отвечает временем свободного потока, а день, который мы
   раскладываем, идёт в Москве, и по его счёту дорога выходит вдвое быстрее
   правды. Там, где дорог нет — чужой набор, незнакомый адрес, — остаётся
   прежняя оценка: прямая, умноженная на 1.3.

   Глобальной оптимизации всё равно нет, поэтому солвер плана называется
   `demo/greedy`, а не как-нибудь солиднее. */

import { SCHEMA } from './contract.ts';
import type {
  Candidate,
  Engineer,
  Explain,
  Minutes,
  Order,
  Plan,
  Route,
  Shifts,
  Simulation,
  Stop,
  UnassignedReason,
  Verdict
} from './contract.ts';
import type { EngineParams } from './engine.ts';
import { engineerOnShift, isUrgent, orderClosed, skillName, transportName } from './dictionary.ts';
import { occupancyMean } from './derive.ts';
import { riskThresholds } from './knobs.ts';
import type { RiskThresholds } from './knobs.ts';
import { roadLeg } from './roads.ts';
import type { Roads } from './roads.ts';

/** Средняя скорость по городу, км/ч. Автомобиль медленнее, чем кажется:
    в черте города его съедают светофоры и дворы, а не магистрали. */
const SPEED_KMH: Record<string, number> = {
  car: 24,
  bike: 12,
  walk: 4.5,
  transit: 16
};

/** Во сколько раз дорога длиннее прямой линии. Городская застройка редко
    даёт меньше — в плотных кварталах доходит до полутора.

    Запасной вариант: там, где дорожная сеть есть, берётся её длина. Средним
    этот коэффициент угадан верно — по нашим адресам настоящее отношение
    ровно 1,31, — но средним и остаётся: перегон в два километра по прямой
    бывает и четырёхкилометровым, если между домами река или железная
    дорога, и на нём оценка ошибается вдвое. */
const WINDING = 1.3;

const speedOf = (transport: string | null | undefined) =>
  SPEED_KMH[transport ?? 'car'] ?? SPEED_KMH.car;

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface Leg {
  minutes: number;
  km: number;
  /** Линия для карты: по улицам, если сеть есть, иначе отрезок. */
  line: [number, number][];
}

/* Время считается от длины пути и нашей скорости, а не берётся у
   маршрутизатора: OSRM отвечает временем свободного потока, и на московском
   дне это заведомо оптимистично — по его счёту дорога выходит вдвое быстрее
   нашей. Скорость же в таблице выше сведена с городом, светофорами и
   дворами. Длина при этом настоящая, и вместе они дают честный перегон. */
function leg(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  transport: string | null | undefined,
  roads: Roads | null
): Leg {
  const road = roadLeg(roads, fromLat, fromLon, toLat, toLon);
  const km = road ? road.km : haversineKm(fromLat, fromLon, toLat, toLon) * WINDING;
  return {
    km,
    minutes: Math.ceil((km / speedOf(transport)) * 60),
    line: road ? road.line : [
      [fromLat, fromLon],
      [toLat, toLon]
    ]
  };
}

/* ─── состояние маршрута по ходу расчёта ───────────────────────────────── */

interface Progress {
  engineer: Engineer;
  stops: Stop[];
  lat: number;
  lon: number;
  /** Когда инженер освободится в последней точке. */
  free: Minutes;
  travelMinutes: number;
  workMinutes: number;
  km: number;
}

/** Попытка поставить заявку в конец маршрута. */
interface Attempt {
  verdict: Verdict;
  note: string;
  stop?: Stop;
}

/** Зазор перед визитом: base + step × √(номер визита). Растёт с номером
    потому же, почему растёт неопределённость: чем дальше в день, тем больше
    успело накопиться отклонений. */
const bufferFor = (visitIndex: number, params: EngineParams) =>
  Math.round(params.buffer_base + params.buffer_step * Math.sqrt(visitIndex));

function tryPlace(
  progress: Progress,
  order: Order,
  params: EngineParams,
  risk: RiskThresholds,
  roads: Roads | null
): Attempt {
  const engineer = progress.engineer;

  if (!engineer.skills.includes(order.skill)) {
    return { verdict: 'no_skill', note: `нет навыка «${skillName(order.skill)}»` };
  }

  if (order.required_transport && engineer.transport !== order.required_transport) {
    return {
      verdict: 'no_vehicle',
      note: `нужен ${transportName(order.required_transport)}, у инженера ${transportName(
        engineer.transport ?? 'car'
      )}`
    };
  }

  const drive = leg(progress.lat, progress.lon, order.lat, order.lon, engineer.transport, roads);
  const buffer = bufferFor(progress.stops.length, params);
  const arrive = progress.free + drive.minutes + buffer;
  const start = Math.max(arrive, order.window_start, engineer.shift_start);

  if (start > order.window_end) {
    return {
      verdict: 'no_room',
      note: `освободится в ${hhmm(progress.free)}, окно закрывается в ${hhmm(order.window_end)}`
    };
  }

  const duration = Math.ceil(order.est_minutes * params.duration_factor);
  const finish = start + duration;

  if (finish > engineer.shift_end) {
    return {
      verdict: 'shift_mismatch',
      note: `работа закончится в ${hhmm(finish)}, смена до ${hhmm(engineer.shift_end)}`
    };
  }

  const wait = Math.max(0, start - arrive);
  const slack = order.window_end - start;

  return {
    verdict: 'feasible',
    note: `приедет к ${hhmm(arrive)}, запас ${slack} мин`,
    stop: {
      seq: progress.stops.length,
      order_id: order.id,
      arrive,
      start,
      finish,
      travel_minutes: drive.minutes,
      wait_minutes: wait,
      slack_minutes: slack,
      /* Пороги — из каталога настроек, а не числа в коде: это те самые две
         настройки из семи, которые до расчёта доезжают. На раскладку они не
         влияют, только на подпись у визита. */
      risk: slack >= risk.medium ? 'low' : slack >= risk.high ? 'medium' : 'high',
      /* Ломаная по улицам от предыдущей точки до этой — из `roads.json`,
         собранного по графу OSM. Сети нет (чужой набор, незнакомый адрес) —
         остаётся отрезок, и карта рисует перегон грубо. */
      geometry: drive.line,
      distance_km: Number(drive.km.toFixed(2)),
      status: order.status ?? 'draft',
      fact: null,
      late_probability: null
    }
  };
}

const hhmm = (m: Minutes) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Инженер участвует в расчёте, если он сегодня на смене. Правило общее со
    сводками: кто вышел, решает справочник, а не каждый экран по-своему. */
const onShift = (engineer: Engineer) => engineerOnShift(engineer);

/* ─── причина отказа ────────────────────────────────────────────────────

   Заявку отвергли все — надо назвать одну причину, а не перечислять
   двенадцать. Раньше называлась самая строгая из встретившихся, и этого
   хватало ровно до первого смешанного отказа: одного инженера без навыка
   среди одиннадцати занятых довольно, чтобы панель написала «ни у кого нет
   навыка». Навык был у одиннадцати — не хватило им времени, и диспетчер
   читал над списком кандидатов обратное тому, что стояло в самом списке.

   Причина теперь та, что помешала большинству, а при равенстве — та, что
   ниже по цепочке проверок: она называет последнее препятствие, а не
   первое, и подсказывает, что менять. Число стоит в тексте там же: «у
   одиннадцати из двенадцати» и «ни у кого» — разные ответы на один вопрос,
   и путать их нельзя. */

/* Порядок проверок в `tryPlace`: навык, транспорт, окно, смена. Он же
   порядок причин — иначе «ниже по цепочке» считалось бы не по той шкале. */
const REASON_ORDER: Verdict[] = ['no_skill', 'no_vehicle', 'no_room', 'shift_mismatch'];

/** Три текста на причину — по числу тех, кого спрашивали.

    `all` говорит «ни у кого», и говорить так можно, только если это правда.
    `some` называет, скольким именно помешало. `locked` — про закреплённую
    заявку: её предлагали одному инженеру, и «ни у кого на смене» про этот
    случай столь же неверно, сколько про одиннадцать занятых из двенадцати. */
interface ReasonText {
  all: (order: Order) => string;
  some: (order: Order, part: string) => string;
  locked: (order: Order) => string;
}

const REASON_TEXT: Record<string, ReasonText> = {
  no_skill: {
    all: (order) => `Ни у кого на смене нет навыка «${skillName(order.skill)}»`,
    some: (order, part) => `Навыка «${skillName(order.skill)}» нет у ${part}`,
    locked: (order) =>
      `Заявка закреплена за инженером без навыка «${skillName(order.skill)}»`
  },
  no_vehicle: {
    all: (order) =>
      `Нет свободного инженера с транспортом «${transportName(order.required_transport ?? 'car')}»`,
    some: (order, part) =>
      `Транспорта «${transportName(order.required_transport ?? 'car')}» нет у ${part}`,
    locked: (order) =>
      `Заявка закреплена за инженером без транспорта «${transportName(
        order.required_transport ?? 'car'
      )}»`
  },
  no_room: {
    all: (order) =>
      `Свободных исполнителей в окне ${hhmm(order.window_start)}–${hhmm(order.window_end)} нет`,
    some: (order, part) =>
      `В окне ${hhmm(order.window_start)}–${hhmm(order.window_end)} не нашлось места у ${part}`,
    locked: (order) =>
      `У инженера, за которым закреплена заявка, нет места в окне ` +
      `${hhmm(order.window_start)}–${hhmm(order.window_end)}`
  },
  shift_mismatch: {
    all: () => 'Работа не помещается в смену — сдвинуть некуда',
    locked: () => 'У инженера, за которым закреплена заявка, работа не помещается в смену',
    some: (_order, part) => `Работа не помещается в смену у ${part}`
  }
};

const REASON_CODE: Record<string, string> = {
  no_skill: 'no_skill',
  no_vehicle: 'no_vehicle',
  shift_mismatch: 'no_time',
  no_room: 'window_missed'
};

/** «11 инженеров из 12». Родительный падеж после «у»: у одного инженера, у
    двух инженеров — единственное число только на единице, кроме одиннадцати. */
const engineersOf = (count: number, total: number) => {
  const one = count % 10 === 1 && count % 100 !== 11;
  return `${count} ${one ? 'инженера' : 'инженеров'} из ${total}`;
};

function reasonOf(order: Order, verdicts: Verdict[]): UnassignedReason {
  /* Кандидатов нет вовсе — на смене пусто. Прежний код на пустом списке
     отвечал «ни у кого нет навыка»: `every` на пустом массиве истинно для
     любой причины, и побеждала первая. */
  if (verdicts.length === 0) {
    return order.locked_to
      ? { code: 'no_time', text: 'Инженер, за которым закреплена заявка, сегодня не на смене' }
      : { code: 'no_time', text: 'На смене нет ни одного инженера' };
  }

  const count = new Map<Verdict, number>();
  for (const verdict of verdicts) count.set(verdict, (count.get(verdict) ?? 0) + 1);

  let worst: Verdict | null = null;
  let most = 0;
  for (const code of REASON_ORDER) {
    const times = count.get(code) ?? 0;
    /* Нестрогое сравнение и прямой порядок дают при равенстве ту причину,
       что ниже по цепочке: до неё дошли дальше. */
    if (times > 0 && times >= most) {
      most = times;
      worst = code;
    }
  }

  if (!worst) return { code: 'no_time', text: 'Подходящего инженера не нашлось' };

  /* Закреплённую заявку предлагали одному инженеру — про него и говорим.
     «Ни у кого на смене» здесь означало бы, что спрашивали всех. */
  const text = order.locked_to
    ? REASON_TEXT[worst].locked(order)
    : most === verdicts.length
      ? REASON_TEXT[worst].all(order)
      : REASON_TEXT[worst].some(order, engineersOf(most, verdicts.length));
  return { code: REASON_CODE[worst] ?? 'no_time', text };
}

/* ─── базовый вариант ТЗ ────────────────────────────────────────────────

   Пункт 2.3 задаёт его дословно: заявки по порядку поступления, первому по
   порядку во входных данных подходящему инженеру, порядок посещения —
   порядок назначения. Считается ради двух чисел в сводке: без него «план на
   столько-то заявок» не с чем сравнить. */

function runBaseline(
  orders: Order[],
  engineers: Engineer[],
  params: EngineParams,
  risk: RiskThresholds,
  roads: Roads | null
) {
  const crew = engineers.filter(onShift);
  const progress = new Map<string, Progress>(
    crew.map((engineer) => [
      engineer.id,
      {
        engineer,
        stops: [],
        lat: engineer.home_lat,
        lon: engineer.home_lon,
        free: engineer.shift_start,
        travelMinutes: 0,
        workMinutes: 0,
        km: 0
      }
    ])
  );

  let assigned = 0;
  for (const order of orders) {
    for (const engineer of crew) {
      const state = progress.get(engineer.id)!;
      const attempt = tryPlace(state, order, params, risk, roads);
      if (attempt.verdict === 'feasible' && attempt.stop) {
        commit(state, attempt.stop, order);
        assigned += 1;
        break;
      }
    }
  }

  const used = [...progress.values()].filter((state) => state.stops.length > 0);
  return {
    solver: 'greedy',
    orders_assigned: assigned,
    engineers_used: used.length,
    distance_km_total: Number(used.reduce((sum, s) => sum + s.km, 0).toFixed(1)),
    travel_minutes_total: used.reduce((sum, s) => sum + s.travelMinutes, 0)
  };
}

function commit(state: Progress, stop: Stop, order: Order): void {
  state.stops.push(stop);
  state.lat = order.lat;
  state.lon = order.lon;
  state.free = stop.finish;
  state.travelMinutes += stop.travel_minutes;
  state.workMinutes += stop.finish - stop.start;
  state.km += stop.distance_km ?? 0;
}

/* ─── равномерность загрузки ───────────────────────────────────────────── */

function gini(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 0;
  let weighted = 0;
  for (let i = 0; i < sorted.length; i += 1) weighted += (i + 1) * sorted[i];
  return (2 * weighted) / (sorted.length * total) - (sorted.length + 1) / sorted.length;
}

export interface PlannedDay {
  plan: Plan;
  explain: Explain;
  simulation: Simulation;
  shifts: Shifts;
}

/** Считает день: раскладывает заявки по инженерам и собирает четыре формы
    контракта. Расчёт детерминированный — одни и те же данные с одними и
    теми же переменными дают один и тот же план, сколько ни повторяй.

    Раскладываются только открытые заявки. В выгрузке за прошедший день
    больше половины нарядов уже выполнены или отменены, и до сих пор они
    шли в очередь наравне с открытыми: план развозил инженеров по сделанной
    работе, а покрытие считалось от числа, в котором две трети — вчерашний
    день. Закрытые остаются в `orders` со своим статусом — базам данных они
    нужны, — но исполнителя не ждут, в «без инженера» не попадают и в
    итогах плана не считаются. Сколько их, говорит `meta.orders_closed`. */
export function planDay(
  orders: Order[],
  engineers: Engineer[],
  params: EngineParams,
  date: string,
  roads: Roads | null = null
): PlannedDay {
  const crew = engineers.filter(onShift);
  const open = orders.filter((order) => !orderClosed(order));
  const risk = riskThresholds();

  const progress = new Map<string, Progress>(
    crew.map((engineer) => [
      engineer.id,
      {
        engineer,
        stops: [],
        lat: engineer.home_lat,
        lon: engineer.home_lon,
        free: engineer.shift_start,
        travelMinutes: 0,
        workMinutes: 0,
        km: 0
      }
    ])
  );

  /* Срочные вперёд, дальше по началу окна: авария, поставленная в очередь
     после обычного подключения, ждала бы места до вечера. Срочность — по
     правилу справочника, тому же, что и на экранах: иначе планировщик
     считал бы срочной заявку, которую список показывает обычной. */
  const queue = [...open].sort((a, b) => {
    const urgentA = isUrgent(a.priority_class, a.priority) ? 0 : 1;
    const urgentB = isUrgent(b.priority_class, b.priority) ? 0 : 1;
    if (urgentA !== urgentB) return urgentA - urgentB;
    if (a.window_start !== b.window_start) return a.window_start - b.window_start;
    return a.id.localeCompare(b.id);
  });

  const placed = new Map<string, string>();
  const explainOrders: Explain['orders'] = {};
  const unassignedReason = new Map<string, UnassignedReason>();

  for (const order of queue) {
    /* Закреплённая диспетчером заявка не участвует в выборе: она обещана
       конкретному инженеру, и пересматривать это обещание не наше дело. */
    const pool = order.locked_to
      ? crew.filter((engineer) => engineer.id === order.locked_to)
      : crew;

    const candidates: Candidate[] = [];
    let best: { state: Progress; stop: Stop } | null = null;
    let bestCost = Infinity;

    for (const engineer of pool) {
      const state = progress.get(engineer.id)!;
      const attempt = tryPlace(state, order, params, risk, roads);
      candidates.push({
        engineer_id: engineer.id,
        verdict: attempt.verdict,
        cost: attempt.stop ? attempt.stop.arrive : null,
        note: attempt.note
      });

      if (attempt.verdict !== 'feasible' || !attempt.stop) continue;

      /* Цена варианта — когда инженер приедет, плюс штраф за то, что он и
         так загружен больше других. Вес штрафа задаёт диспетчер. */
      const cost = attempt.stop.start + params.balance_weight * state.stops.length;
      if (cost < bestCost) {
        bestCost = cost;
        best = { state, stop: attempt.stop };
      }
    }

    if (best) {
      commit(best.state, best.stop, order);
      placed.set(order.id, best.state.engineer.id);
      const chosen = candidates.find((c) => c.engineer_id === best!.state.engineer.id);
      if (chosen) chosen.verdict = 'chosen';
      explainOrders[order.id] = {
        assigned_to: best.state.engineer.id,
        summary:
          `Назначена ${best.state.engineer.name}: ` +
          `подходит по навыку «${skillName(order.skill)}»` +
          (order.required_transport
            ? `, есть ${transportName(order.required_transport)}`
            : '') +
          `, приезжает к ${hhmm(best.stop.arrive)} при окне ` +
          `${hhmm(order.window_start)}–${hhmm(order.window_end)}.`,
        candidates
      };
    } else {
      const reason = reasonOf(
        order,
        candidates.map((c) => c.verdict)
      );
      unassignedReason.set(order.id, reason);
      explainOrders[order.id] = {
        assigned_to: null,
        summary: reason.text,
        candidates
      };
    }
  }

  /* ─── сборка форм ───────────────────────────────────────────────────── */

  const routes: Route[] = [];
  for (const state of progress.values()) {
    if (state.stops.length === 0) continue;
    const first = state.stops[0];
    const last = state.stops[state.stops.length - 1];
    /* Занятость считается от всей смены, простой — от прожитой её части:
       час, на который инженер вышел позже последнего визита, простоем не
       считается, он просто ещё не наступил. */
    const span = Math.max(1, state.engineer.shift_end - state.engineer.shift_start);
    const departure = first.arrive - first.travel_minutes;
    routes.push({
      engineer_id: state.engineer.id,
      stops: state.stops,
      totals: {
        visits: state.stops.length,
        travel_minutes: state.travelMinutes,
        work_minutes: state.workMinutes,
        idle_minutes: Math.max(0, last.finish - departure - state.travelMinutes - state.workMinutes),
        start: departure,
        end: last.finish,
        overtime_minutes: Math.max(0, last.finish - state.engineer.shift_end),
        occupancy: Number(((state.travelMinutes + state.workMinutes) / span).toFixed(3)),
        distance_km: Number(state.km.toFixed(2))
      }
    });
  }

  const plannedOrders: Order[] = orders.map((order) => ({
    ...order,
    assigned_to: placed.get(order.id) ?? null,
    assigned_by: placed.has(order.id) ? 'solver' : null,
    unassigned_reason: unassignedReason.get(order.id) ?? null
  }));

  /* Без инженера — только открытая: закрытая до расчёта исполнителя не ждала. */
  const unassigned = plannedOrders
    .filter((order) => !order.assigned_to && !orderClosed(order))
    .map((order) => order.id);
  /* Равномерность считается по тем, кто получил маршрут. Нули за вышедших
     без маршрута сюда не кладутся: с ними минимум всегда ноль, разрыв —
     бесконечность, и «Разрыв загрузки» на пульте писал «60×» при загрузках
     от трети до трёх четвертей. Простаивающих называет `idle_engineers`. */
  const occupancies = routes.map((route) => route.totals.occupancy);
  const distanceTotal = routes.reduce((sum, route) => sum + (route.totals.distance_km ?? 0), 0);

  const plan: Plan = {
    schema: SCHEMA,
    kind: 'plan',
    meta: {
      date,
      generated_at: Math.floor(Date.now() / 1000),
      time_format: 'minutes_from_midnight',
      /* Граница суток — как у движка: без неё ось времени встаёт на
         настройку 21:00, а переносимость на завтра считается по полуночи,
         и браузерный план расходился бы с планом движка на тех же данных.
         Не раньше 21:00 и не раньше концов смен вышедших и сегодняшних окон: у
         выгрузки заказчика окна до 22:00, и граница выходит та же, что у
         движка, — 1320. Окна за полночью (заявки на завтра) её не тянут.
         Известное расхождение: ночная бригада со сменой после 22:00 поднимет
         границу к концу своей смены (до полуночи), заявки со сроком между
         22:00 и ею перестанут считаться переносимыми — а у движка граница
         постоянная (1320 или 1260), и там они останутся «на завтра». */
      hard_end: Math.min(
        24 * 60,
        Math.max(
          21 * 60,
          ...crew.map((engineer) => engineer.shift_end),
          ...orders.filter((order) => order.window_end < 24 * 60).map((order) => order.window_end)
        )
      ),
      solver: 'demo/greedy',
      orders_total: open.length,
      orders_assigned: placed.size,
      orders_closed: orders.length - open.length,
      engineers_total: engineers.length,
      balance: {
        gini: Number(gini(occupancies).toFixed(3)),
        occupancy_min: Number((occupancies.length ? Math.min(...occupancies) : 0).toFixed(3)),
        occupancy_max: Number((occupancies.length ? Math.max(...occupancies) : 0).toFixed(3)),
        occupancy_mean: Number(occupancyMean(routes.map((route) => route.totals)).toFixed(3)),
        idle_engineers: crew.length - routes.length
      },
      engineers_used: routes.length,
      distance_km_total: Number(distanceTotal.toFixed(1)),
      baseline: runBaseline(open, engineers, params, risk, roads)
    },
    engineers,
    orders: plannedOrders,
    routes,
    unassigned
  };

  const explain: Explain = {
    schema: SCHEMA,
    kind: 'explain',
    meta: { date, cost_units: 'минуты' },
    orders: explainOrders
  };

  /* Симуляции не было: день не разыгрывается сотнями прогонов, неявки и
     пробки не моделируются. Поэтому `runs` — ноль, разброс нулевой, список
     хрупких визитов пуст, а причин срыва нет вовсе: сорваться ещё нечему.
     Покрытие при этом настоящее, просто означает другое — долю назначенных,
     а не долю выполненных. Причины, по которым заявка осталась без
     инженера, лежат у самой заявки и никуда не делись.

     Проценты, а не доли: контракт объявляет `coverage` и `execution_rate`
     в процентах, и число 0.61 на месте 61.4 показалось бы на экране
     покрытием в полпроцента. */
  const covered = open.length ? (placed.size / open.length) * 100 : 0;

  const simulation: Simulation = {
    schema: SCHEMA,
    kind: 'simulation',
    meta: { date, runs: 0 },
    planned: placed.size,
    orders_total: open.length,
    done: {
      mean: placed.size,
      p10: placed.size,
      p50: placed.size,
      p90: placed.size,
      sd: 0
    },
    coverage: Number(covered.toFixed(1)),
    execution_rate: 100,
    reasons: {},
    overtime_minutes: routes.reduce((sum, route) => sum + route.totals.overtime_minutes, 0),
    idle_minutes: routes.reduce((sum, route) => sum + route.totals.idle_minutes, 0),
    fragile: []
  };

  return { plan, explain, simulation, shifts: buildShifts(open, crew, Number(covered.toFixed(1))) };
}

/* График выхода: спрос по часам против того, кто в это время на смене.
   Рекомендация не считается — сдвигать смены мы не умеем, и выдавать
   текущий график за рекомендованный честнее, чем сочинять другой. Спрос —
   по открытым заявкам: закрытая инженера в своём окне не ждёт. */
function buildShifts(orders: Order[], crew: Engineer[], coverage: number): Shifts {
  const profile: Record<string, number> = {};
  for (const engineer of crew) {
    const key = hhmm(engineer.shift_start);
    profile[key] = (profile[key] ?? 0) + 1;
  }

  const curve: Shifts['curve'] = [];
  for (let minute = 7 * 60; minute <= 22 * 60; minute += 30) {
    const demand: Record<string, number> = {};
    for (const order of orders) {
      if (order.window_start <= minute && minute < order.window_end) {
        demand[order.skill] = (demand[order.skill] ?? 0) + 1;
      }
    }
    const supply = crew.filter(
      (engineer) => engineer.shift_start <= minute && minute < engineer.shift_end
    ).length;
    curve.push({
      minute,
      demand,
      demand_total: Object.values(demand).reduce((sum, v) => sum + v, 0),
      supply_current: supply,
      supply_recommended: supply
    });
  }

  return {
    schema: SCHEMA,
    kind: 'shifts',
    meta: {
      shift_hours: 9,
      allowed_starts: [...new Set(crew.map((e) => hhmm(e.shift_start)))].sort(),
      demand_units: 'заявок в окне'
    },
    current: { profile, expected_coverage: coverage },
    recommended: {
      profile,
      expected_coverage: coverage,
      starts_by_engineer: Object.fromEntries(crew.map((e) => [e.id, hhmm(e.shift_start)]))
    },
    curve
  };
}
