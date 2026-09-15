/* Базы данных: то, что живёт над отдельным расчётом.

   Правая панель и разделы диспетчерской всегда отвечают на вопрос «что в этом
   прогоне». Здесь вопрос другой — «что у нас есть вообще»: клиенты, маршруты и
   инженеры, собранные по всем прогонам сразу. Поэтому загрузка тоже своя: берём
   планы всех расчётов и складываем их в три справочника.

   Справочника клиентов в контракте нет — заказчик описан точкой обслуживания.
   С 1.1 у точки есть почтовый адрес дома, и база клиентов собрана по адресам:
   один дом — одна строка, сколько бы заявок оттуда ни приходило. До 1.1
   адреса не было и точкой считался район; если стенд запущен на синтетической
   сети и адрес приходит пустым, база молча возвращается к прежнему поведению.
   Ничего к контракту здесь не придумывается. */

import { loadRunData, RUNS } from './load.ts';
import type { RunId } from './load.ts';
import type { Plan, Simulation } from './contract.ts';
import { placeOf, roadPath } from './derive.ts';
import { routeLabel, routeNumbers } from './routeIds.ts';

export interface RunRef {
  id: RunId;
  /** Номер расчёта, как он показан наружу: R001, R002… */
  code: string;
  date: string;
  /** Дата и время, когда расчёт завели: «2026-09-08T06:12». */
  created: string;
  /** Заметка человека к записи. Движок её не заполняет. */
  note?: string;
}

/** Итог расчёта на карте: маршруты по порядку объезда и невзятые заявки.

    Координаты отдаём как есть, в градусах: подложку под них подставляет уже
    экран — он знает свой размер и свой масштаб, а проекция у карты не
    линейная, и заранее приведённые доли на тайлы не лягут. */
export interface RunSketch {
  /** Маршруты: от места выезда инженера и дальше по визитам, `[широта, долгота]`. */
  routes: [number, number][][];
  /** Заявки, которые никто не взял. */
  loose: [number, number][];
}

/** Рамка, в которую укладываются все расчёты сразу. */
export interface Bounds {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export interface ClientRecord {
  /** Ключ точки обслуживания: почтовый адрес дома, а без него — район. */
  key: string;
  /** Как точку называют в интерфейсе: адрес дома либо район. */
  address: string;
  district: string;
  /** Координаты дома — по ним точку показывают на карте. */
  lat: number;
  lon: number;
  /** Заявок по всем прогонам. */
  orders: number;
  /** Из них попали в маршрут. */
  assigned: number;
  /** В скольких прогонах район вообще встречался. */
  runs: number;
  /** Виды работ, которые здесь заказывали. */
  workTypes: string[];
  /** Заявок, где нужен доступ в подъезд. */
  access: number;
  /** Заявок с высоким приоритетом. */
  urgent: number;
  /** Средняя длительность работы на точке. */
  avgMinutes: number;
  /** Раньше всего открывающееся окно приёма по всем прогонам. */
  firstWindow: number;
}

export interface OrderRecord {
  /** Заявка уникальна парой «расчёт + номер»: номера в прогонах повторяются,
      а стоят за ними разные точки и окна. */
  key: string;
  id: string;
  run: RunRef;
  workType: string;
  workTitle: string;
  skill: string;
  /** Адрес дома либо, если стенд без адресов, район. */
  address: string;
  district: string;
  windowStart: number;
  windowEnd: number;
  slaDeadline: number;
  priority: number;
  estMinutes: number;
  needsAccess: boolean;
  /** Инженер, которому заявка досталась в этом расчёте. */
  engineerId: string | null;
  engineerName: string | null;
  /** Порядковый номер визита в маршруте, если заявка в него попала. */
  seq: number | null;
}

export interface RouteRecord {
  /** Маршрут уникален парой «расчёт + инженер». */
  key: string;
  /** Собственный номер маршрута на всю базу: M0001, M0002… Не начинается
      заново в каждом расчёте — первый маршрут R001 и первый маршрут R003 под
      одним номером стоять не могут. */
  code: string;
  /** Тот же номер числом — им сортируют. */
  number: number;
  run: RunRef;
  engineerId: string;
  engineerName: string;
  visits: number;
  travelMinutes: number;
  workMinutes: number;
  idleMinutes: number;
  overtimeMinutes: number;
  occupancy: number;
  start: number;
  end: number;
  /** Районы, которые маршрут прошёл, в порядке первого появления. */
  districts: string[];
  /** Остановок с высоким риском опоздания. */
  risky: number;
}

/** Как инженер отработал в одном прогоне. Ряд из таких смен и есть его
    история: сводные числа отвечают «сколько всего», а смена от смены видно
    только здесь — и по чему считать за срок, тоже. */
export interface EngineerShift {
  runId: string;
  code: string;
  /** Когда завели расчёт, ISO: по нему отбирают срок. */
  created: string;
  /** Дали ли маршрут в этом прогоне. Нет — инженер вышел и остался без работы. */
  routed: boolean;
  visits: number;
  travelMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
  /** Занятость маршрута, доля 0…1. Без маршрута — ноль. */
  occupancy: number;
}

export interface EngineerRecord {
  id: string;
  name: string;
  skills: string[];
  grade: number;
  /** В скольких прогонах инженер числится в штате. */
  runs: number;
  /** В скольких из них получил маршрут. */
  routes: number;
  visits: number;
  travelMinutes: number;
  workMinutes: number;
  overtimeMinutes: number;
  /** Средняя занятость по маршрутам, доля 0…1. */
  occupancyMean: number;
  /** Прогоны, где инженер вышел, но остался без маршрута. */
  idleRuns: number;
  /** Смена из последнего прогона: график меняется от расчёта к расчёту. */
  shiftStart: number;
  shiftEnd: number;
  /** Откуда выезжает — адрес из последнего прогона. Пусто на стенде без адресов. */
  homeAddress: string | null;
  /** Смены по прогонам, от старого к свежему. Только те, где инженер был в
      штате: ноль визитов в прогоне, где его не выводили, — это не простой. */
  byRun: EngineerShift[];
}

/** Сводка по одному расчёту — строка для статистики и базы расчётов. */
export interface RunStat {
  run: RunRef;
  orders: number;
  assigned: number;
  /** Покрытие из симуляции, 0…1. То же число, что в пульте расчёта и в
      сравнении: одна метрика под одним именем во всём интерфейсе. */
  coverage: number;
  /** Доля разложенных заявок в плане, 0…1. Это не покрытие: движок разложил,
      а симуляция говорит, сколько из этого доедет. */
  assignedShare: number;
  routes: number;
  visits: number;
  travelMinutes: number;
  occupancy: number;
  engineersTotal: number;
  engineersOnRoute: number;
  sketch: RunSketch;
}

export interface Tally {
  key: string;
  count: number;
}

export interface RegistryStats {
  orders: number;
  assigned: number;
  /** Заявки по видам работ по всем прогонам. */
  byWorkType: Tally[];
  /** Инженеры по навыкам: считаем людей, а не заявки. */
  bySkill: Tally[];
  byRun: RunStat[];
}

/** Один час смены в разрезе одного расчёта. Всё, что можно наложить друг на
    друга и увидеть, чем два плана расходятся по ходу дня. */
export interface HourSlice {
  /** Начало часа, минуты от полуночи. */
  at: number;
  /** Инженеров, занятых в этот час хоть чем-то: в пути или на объекте. */
  busy: number;
  /** Из них на объекте. */
  working: number;
  /** Из них в пути. */
  travelling: number;
  /** Визитов закрыто за час. */
  done: number;
  /** Человеко-минут работы за час — по всем инженерам вместе. */
  workMinutes: number;
  /** Человеко-минут в пути за час. */
  travelMinutes: number;
  /** Человеко-минут ожидания открытия окна. */
  waitMinutes: number;
}

/** Как расчёт прожил день по часам. */
export interface RunProfile {
  run: RunRef;
  hours: HourSlice[];
}

export interface Registry {
  runs: RunRef[];
  /** Общая рамка всех расчётов: карта в карточке строится по ней, поэтому
      город в соседних карточках стоит на одном и том же месте. */
  bounds: Bounds;
  /** Названия видов работ из самих данных: код в файле, слово рядом — из
      заявки. Свой список здесь не заводим, 15 сентября коды придут другими. */
  workTypeTitle: Record<string, string>;
  orders: OrderRecord[];
  clients: ClientRecord[];
  routes: RouteRecord[];
  engineers: EngineerRecord[];
  /** Почасовой разрез каждого расчёта — для наложения в сравнении. */
  profiles: RunProfile[];
  stats: RegistryStats;
}

function buildClients(plans: { run: RunRef; plan: Plan }[]): ClientRecord[] {
  const map = new Map<
    string,
    ClientRecord & { minutes: number[]; typeSet: Set<string>; runSet: Set<string> }
  >();

  for (const { run, plan } of plans) {
    for (const order of plan.orders) {
      /* Ключ — адрес: одна и та же квартира приходит в разных расчётах, и это
         одна точка, а не две. Дом без адреса опознаём по координатам, чтобы
         соседние дома одного района не слиплись в одну строку. */
      const key = order.address ?? `${order.district} · ${order.lat},${order.lon}`;
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key,
          address: placeOf(order),
          district: order.district,
          lat: order.lat,
          lon: order.lon,
          orders: 0,
          assigned: 0,
          runs: 0,
          workTypes: [],
          access: 0,
          urgent: 0,
          avgMinutes: 0,
          firstWindow: Infinity,
          minutes: [],
          typeSet: new Set<string>(),
          runSet: new Set<string>()
        };
        map.set(key, entry);
      }
      entry.orders += 1;
      if (order.assigned_to) entry.assigned += 1;
      if (order.needs_access) entry.access += 1;
      if (order.priority >= 2) entry.urgent += 1;
      entry.minutes.push(order.est_minutes);
      entry.typeSet.add(order.work_type);
      entry.runSet.add(run.id);
      entry.firstWindow = Math.min(entry.firstWindow, order.window_start);
    }
  }

  return [...map.values()]
    .map((entry) => ({
      key: entry.key,
      address: entry.address,
      district: entry.district,
      lat: entry.lat,
      lon: entry.lon,
      orders: entry.orders,
      assigned: entry.assigned,
      runs: entry.runSet.size,
      workTypes: [...entry.typeSet],
      access: entry.access,
      urgent: entry.urgent,
      avgMinutes: Math.round(entry.minutes.reduce((a, b) => a + b, 0) / entry.minutes.length),
      firstWindow: entry.firstWindow
    }))
    .sort((a, b) => b.orders - a.orders || a.address.localeCompare(b.address, 'ru'));
}

function buildOrders(plans: { run: RunRef; plan: Plan }[]): OrderRecord[] {
  const list: OrderRecord[] = [];
  for (const { run, plan } of plans) {
    const nameById = new Map(plan.engineers.map((e) => [e.id, e.name]));
    /* Порядок визита лежит в маршруте, а не в заявке: собираем один раз, чтобы
       не искать его по остановкам для каждой строки. */
    const seqByOrder = new Map<string, number>();
    for (const route of plan.routes) {
      for (const stop of route.stops) seqByOrder.set(stop.order_id, stop.seq);
    }
    for (const order of plan.orders) {
      list.push({
        key: `${run.id}:${order.id}`,
        id: order.id,
        run,
        workType: order.work_type,
        workTitle: order.work_title,
        skill: order.skill,
        address: placeOf(order),
        district: order.district,
        windowStart: order.window_start,
        windowEnd: order.window_end,
        slaDeadline: order.sla_deadline,
        priority: order.priority,
        estMinutes: order.est_minutes,
        needsAccess: order.needs_access,
        engineerId: order.assigned_to,
        engineerName: order.assigned_to ? nameById.get(order.assigned_to) ?? order.assigned_to : null,
        seq: seqByOrder.get(order.id) ?? null
      });
    }
  }
  return list.sort(
    (a, b) => a.run.code.localeCompare(b.run.code) || a.id.localeCompare(b.id)
  );
}

/* Почасовой разрез расчёта.

   Сравнивать планы по итогам — «покрытие 66 против 67» — можно, но это ответ
   на «что вышло», а не на «чем они отличались». Отличаются они ходом дня: в
   одном к десяти утра на маршрутах двенадцать инженеров, в другом семь, и к
   вечеру первый упирается в потолок, а второй досиживает смену. Такое видно
   только наложением по часам.

   Считается из тех же остановок, что и всё остальное. Перегон до визита
   занимает время от конца предыдущего визита до прибытия; ожидание — от
   прибытия до начала работы, если приехали раньше окна; работа — от начала до
   конца. Часы режем по суткам целиком, 0…23, а не по границам смены: границы
   стали настройкой, а справочник собирается один раз, и разрез, посчитанный
   под прежние границы, пережил бы их смену. Обрезает уже тот, кто рисует.

   Человеко-минуты, а не минуты: в одном часу работают несколько инженеров
   сразу, и сумма по ним — это и есть «сколько сделано за час». */
const HOURS_IN_DAY = 24;

function buildProfiles(plans: { run: RunRef; plan: Plan }[]): RunProfile[] {
  return plans.map(({ run, plan }) => {
    const hours: HourSlice[] = Array.from({ length: HOURS_IN_DAY }, (_, index) => ({
      at: index * 60,
      busy: 0,
      working: 0,
      travelling: 0,
      done: 0,
      workMinutes: 0,
      travelMinutes: 0,
      waitMinutes: 0
    }));

    /* Занятость инженера в часу считаем множествами, а не счётчиком: один и
       тот же человек может за час и доехать, и поработать, и попасть в «занят»
       он должен один раз. */
    const busyAt: Set<string>[] = hours.map(() => new Set());
    const workAt: Set<string>[] = hours.map(() => new Set());
    const driveAt: Set<string>[] = hours.map(() => new Set());

    /** Разливает отрезок по часам: в каждый час — своя доля минут. */
    const spread = (
      from: number,
      to: number,
      add: (hour: number, minutes: number) => void,
      mark?: Set<string>[]
    ) => {
      if (!(to > from)) return;
      const first = Math.max(0, Math.floor(from / 60));
      const last = Math.min(HOURS_IN_DAY - 1, Math.floor((to - 1) / 60));
      for (let hour = first; hour <= last; hour += 1) {
        const left = Math.max(from, hour * 60);
        const right = Math.min(to, (hour + 1) * 60);
        if (right <= left) continue;
        add(hour, right - left);
        mark?.[hour].add('1');
      }
    };

    for (const route of plan.routes) {
      const who = route.engineer_id;
      let leaves = route.totals.start;
      for (const stop of route.stops) {
        /* Перегон: от момента выезда до прибытия. Первый считается от начала
           смены, дальше — от конца предыдущего визита. */
        spread(leaves, stop.arrive, (hour, minutes) => {
          hours[hour].travelMinutes += minutes;
          driveAt[hour].add(who);
          busyAt[hour].add(who);
        });
        spread(stop.arrive, stop.start, (hour, minutes) => {
          hours[hour].waitMinutes += minutes;
          busyAt[hour].add(who);
        });
        spread(stop.start, stop.finish, (hour, minutes) => {
          hours[hour].workMinutes += minutes;
          workAt[hour].add(who);
          busyAt[hour].add(who);
        });
        const closed = Math.min(HOURS_IN_DAY - 1, Math.floor(stop.finish / 60));
        if (closed >= 0) hours[closed].done += 1;
        leaves = stop.finish;
      }
    }

    hours.forEach((slice, index) => {
      slice.busy = busyAt[index].size;
      slice.working = workAt[index].size;
      slice.travelling = driveAt[index].size;
    });

    return { run, hours };
  });
}

function buildRoutes(plans: { run: RunRef; plan: Plan }[]): RouteRecord[] {
  const list: RouteRecord[] = [];
  /* Номера выдаём от старых расчётов к свежим: тогда порядок номеров совпадает
     с порядком, в котором маршруты появлялись, и M0001 — действительно первый
     посчитанный маршрут, а не тот, что случайно оказался первым в загрузке. */
  const ordered = [...plans].sort((a, b) => a.run.created.localeCompare(b.run.created));
  const numbers = new Map<string, number>();
  for (const { run, plan } of ordered) {
    const keys = [...plan.routes]
      .sort((a, b) => a.engineer_id.localeCompare(b.engineer_id))
      .map((route) => ({ runId: run.id, engineerId: route.engineer_id }));
    routeNumbers(keys).forEach((number, index) => {
      const item = keys[index];
      if (item) numbers.set(`${item.runId}:${item.engineerId}`, number);
    });
  }
  for (const { run, plan } of plans) {
    const nameById = new Map(plan.engineers.map((e) => [e.id, e.name]));
    const districtByOrder = new Map(plan.orders.map((o) => [o.id, o.district]));
    for (const route of plan.routes) {
      const districts: string[] = [];
      let risky = 0;
      for (const stop of route.stops) {
        const district = districtByOrder.get(stop.order_id);
        if (district && !districts.includes(district)) districts.push(district);
        if (stop.risk === 'high') risky += 1;
      }
      const key = `${run.id}:${route.engineer_id}`;
      const number = numbers.get(key) ?? 0;
      list.push({
        key,
        code: routeLabel(number),
        number,
        run,
        engineerId: route.engineer_id,
        engineerName: nameById.get(route.engineer_id) ?? route.engineer_id,
        visits: route.totals.visits,
        travelMinutes: route.totals.travel_minutes,
        workMinutes: route.totals.work_minutes,
        idleMinutes: route.totals.idle_minutes,
        overtimeMinutes: route.totals.overtime_minutes,
        occupancy: route.totals.occupancy,
        start: route.totals.start,
        end: route.totals.end,
        districts,
        risky
      });
    }
  }
  return list.sort(
    (a, b) => a.run.code.localeCompare(b.run.code) || a.engineerName.localeCompare(b.engineerName)
  );
}

function buildEngineers(plans: { run: RunRef; plan: Plan }[]): EngineerRecord[] {
  const map = new Map<string, EngineerRecord & { skillSet: Set<string>; occupancies: number[] }>();

  for (const { run, plan } of plans) {
    const routeByEngineer = new Map(plan.routes.map((r) => [r.engineer_id, r]));
    for (const engineer of plan.engineers) {
      let entry = map.get(engineer.id);
      if (!entry) {
        entry = {
          id: engineer.id,
          name: engineer.name,
          skills: [],
          grade: engineer.grade,
          runs: 0,
          routes: 0,
          visits: 0,
          travelMinutes: 0,
          workMinutes: 0,
          overtimeMinutes: 0,
          occupancyMean: 0,
          idleRuns: 0,
          shiftStart: engineer.shift_start,
          shiftEnd: engineer.shift_end,
          homeAddress: engineer.home_address,
          byRun: [],
          skillSet: new Set<string>(),
          occupancies: []
        };
        map.set(engineer.id, entry);
      }
      entry.runs += 1;
      /* Грейд и смена берутся из последнего прогона: справочник показывает
         то, каким инженер числится сейчас, а не каким был в первом расчёте. */
      entry.grade = engineer.grade;
      entry.shiftStart = engineer.shift_start;
      entry.shiftEnd = engineer.shift_end;
      entry.homeAddress = engineer.home_address;
      for (const skill of engineer.skills) entry.skillSet.add(skill);

      const route = routeByEngineer.get(engineer.id);
      /* Смену записываем и тогда, когда маршрута не было: прогон, в котором
         инженер вышел и остался без работы, — такая же часть его истории,
         как и прогон с двенадцатью визитами. */
      entry.byRun.push({
        runId: run.id,
        code: run.code,
        created: run.created,
        routed: Boolean(route),
        visits: route?.totals.visits ?? 0,
        travelMinutes: route?.totals.travel_minutes ?? 0,
        workMinutes: route?.totals.work_minutes ?? 0,
        overtimeMinutes: route?.totals.overtime_minutes ?? 0,
        occupancy: route?.totals.occupancy ?? 0
      });

      if (!route) {
        entry.idleRuns += 1;
        continue;
      }
      entry.routes += 1;
      entry.visits += route.totals.visits;
      entry.travelMinutes += route.totals.travel_minutes;
      entry.workMinutes += route.totals.work_minutes;
      entry.overtimeMinutes += route.totals.overtime_minutes;
      entry.occupancies.push(route.totals.occupancy);
    }
  }

  return [...map.values()]
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      skills: [...entry.skillSet],
      grade: entry.grade,
      runs: entry.runs,
      routes: entry.routes,
      visits: entry.visits,
      travelMinutes: entry.travelMinutes,
      workMinutes: entry.workMinutes,
      overtimeMinutes: entry.overtimeMinutes,
      occupancyMean: entry.occupancies.length
        ? entry.occupancies.reduce((a, b) => a + b, 0) / entry.occupancies.length
        : 0,
      idleRuns: entry.idleRuns,
      shiftStart: entry.shiftStart,
      shiftEnd: entry.shiftEnd,
      homeAddress: entry.homeAddress,
      byRun: entry.byRun
    }))
    .sort((a, b) => b.visits - a.visits || a.name.localeCompare(b.name));
}

/* Рамка всех расчётов сразу: карта в карточке строится по ней, поэтому один и
   тот же город в разных карточках стоит на одном и том же месте. */
function cityBounds(plans: { plan: Plan }[]): Bounds {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  const take = (lat: number, lon: number) => {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  };
  for (const { plan } of plans) {
    for (const order of plan.orders) take(order.lat, order.lon);
    for (const engineer of plan.engineers) take(engineer.home_lat, engineer.home_lon);
  }
  return { minLat, maxLat, minLon, maxLon };
}

/* Наброски считаем один раз на источник, а не на запись истории: файлов три,
   а расчётов два десятка, и один и тот же план приходит в них тем же объектом.
   Двадцать четыре раза разбирать одну и ту же геометрию незачем. */
const sketchCache = new WeakMap<Plan, RunSketch>();

function buildSketch(plan: Plan): RunSketch {
  const cached = sketchCache.get(plan);
  if (cached) return cached;

  const orderById = new Map(plan.orders.map((order) => [order.id, order]));
  const engineerById = new Map(plan.engineers.map((engineer) => [engineer.id, engineer]));

  const routes: [number, number][][] = [];
  for (const route of plan.routes) {
    const home = engineerById.get(route.engineer_id);
    if (!home) continue;
    /* Та же линия по улицам, что и на большой карте: карточка — уменьшенный
       вид того же расчёта, и путь в ней не должен идти иначе. */
    const points = roadPath(route, [home.home_lat, home.home_lon], (orderId) => {
      const order = orderById.get(orderId);
      return order ? [order.lat, order.lon] : undefined;
    });
    if (points.length < 2) continue;
    routes.push(points);
  }

  const loose = plan.unassigned
    .map((id) => orderById.get(id))
    .filter((order): order is NonNullable<typeof order> => Boolean(order))
    .map((order) => [order.lat, order.lon] as [number, number]);

  const sketch = { routes, loose };
  sketchCache.set(plan, sketch);
  return sketch;
}

function buildStats(
  plans: { run: RunRef; plan: Plan; simulation: Simulation }[],
  engineers: EngineerRecord[]
): RegistryStats {
  const workTypes = new Map<string, number>();
  let orders = 0;
  let assigned = 0;

  const byRun: RunStat[] = plans.map(({ run, plan, simulation }) => {
    orders += plan.orders.length;
    for (const order of plan.orders) {
      if (order.assigned_to) assigned += 1;
      workTypes.set(order.work_type, (workTypes.get(order.work_type) ?? 0) + 1);
    }
    const visits = plan.routes.reduce((sum, r) => sum + r.totals.visits, 0);
    const travel = plan.routes.reduce((sum, r) => sum + r.totals.travel_minutes, 0);
    const occupancy =
      plan.routes.reduce((sum, r) => sum + r.totals.occupancy, 0) / (plan.routes.length || 1);
    return {
      run,
      orders: plan.meta.orders_total,
      assigned: plan.meta.orders_assigned,
      coverage: simulation.coverage / 100,
      assignedShare: plan.meta.orders_total
        ? plan.meta.orders_assigned / plan.meta.orders_total
        : 0,
      routes: plan.routes.length,
      visits,
      travelMinutes: travel,
      occupancy,
      engineersTotal: plan.meta.engineers_total,
      engineersOnRoute: new Set(plan.routes.map((r) => r.engineer_id)).size,
      sketch: buildSketch(plan)
    };
  });

  const skills = new Map<string, number>();
  for (const engineer of engineers) {
    for (const key of engineer.skills) skills.set(key, (skills.get(key) ?? 0) + 1);
  }

  const tally = (map: Map<string, number>) =>
    [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return {
    orders,
    assigned,
    byWorkType: tally(workTypes),
    bySkill: tally(skills),
    byRun
  };
}

/** Собирает справочники по всем расчётам сразу. */
export async function loadRegistry(): Promise<Registry> {
  /* Данные берём там же, где их берут сводки: один источник на весь
     интерфейс, иначе один раздел однажды окажется собран по фикстурам, а
     соседний — по архиву движка. Дата — из реестра, а не из файла: в файле
     она одна на всех, в истории у каждого расчёта своя. */
  const data = await loadRunData();

  const plans = RUNS.filter((entry) => data.has(entry.id)).map((entry) => ({
    run: {
      id: entry.id,
      code: entry.code,
      date: entry.date,
      created: entry.created,
      note: entry.note
    } as RunRef,
    plan: data.get(entry.id)!.plan,
    simulation: data.get(entry.id)!.simulation
  }));

  const engineers = buildEngineers(plans);
  const workTypeTitle: Record<string, string> = {};
  for (const { plan } of plans) {
    for (const order of plan.orders) workTypeTitle[order.work_type] = order.work_title;
  }

  return {
    runs: plans.map((p) => p.run),
    bounds: cityBounds(plans),
    workTypeTitle,
    orders: buildOrders(plans),
    clients: buildClients(plans),
    routes: buildRoutes(plans),
    engineers,
    profiles: buildProfiles(plans),
    stats: buildStats(plans, engineers)
  };
}
