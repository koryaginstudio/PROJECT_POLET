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

import { engineDayTitle, loadAllOrders, loadRoster, loadRunData, missingEngineZones, RUNS } from './load.ts';
import type { RosterEngineer, RunId } from './load.ts';
import type { Engineer, Order, Plan, Route, Simulation } from './contract.ts';
import { occupancyMean, placeOf, roadPath } from './derive.ts';
import { isUrgent, orderClosed } from './dictionary.ts';
import { routeLabel, routeNumbers } from './routeIds.ts';
import { clientLabel, clientNumbers } from './clientIds.ts';
import { companyOf } from './companies.ts';

export interface RunRef {
  id: RunId;
  /** Номер расчёта, как он показан наружу: R001, R002… */
  code: string;
  date: string;
  /** Дата и время, когда расчёт завели: «2026-09-08T06:12». */
  created: string;
  /** Заметка человека к записи. Движок её не заполняет. */
  note?: string;
  /** День движка («восток», «югоцентр»), по которому считали. Пусто у
      расчёта браузера. Нужен ключу инженера: см. `engineerKey`. */
  day?: string;
}

/** Ключ записи инженера в справочнике.

    У движка номера E00…E13 одни и те же на каждом участке, а люди за ними
    разные: E00 Востока и E00 Югоцентра — два человека с разными сменами и
    офисами. Ключом по одному номеру справочник склеивал их в одну карточку
    с суммой чужих часов (Антон ловил ту же беду в своей сборке набора).
    Поэтому у инженера движка ключ — «участок:номер». У файлов вёрстки
    номера сквозные на всю компанию, и там ключ — сам номер: человек,
    приписанный к двум участкам, остаётся одним человеком. */
export const engineerKey = (day: string | undefined | null, id: string) =>
  day ? `${day}:${id}` : id;

/** Номер инженера в плане дня по ключу справочника — или `null`, если ключ
    про другой участок. Нужен переходам из карточки в открытый расчёт:
    диспетчерская знает людей по номеру плана, справочник — по ключу. */
export function engineerInDay(key: string, day: string | undefined | null): string | null {
  const cut = key.indexOf(':');
  if (cut < 0) return key;
  return key.slice(0, cut) === day ? key.slice(cut + 1) : null;
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
  /** Сквозной номер точки на всю базу: C0001, C0002… Выдаётся раз и
      закрепляется за адресом — см. `clientIds.ts`. Им клиента находят
      поиском и им же его называют, потому что адресом не назовёшь. */
  code: string;
  /** Тот же номер числом — им сортируют. */
  number: number;
  /** Кто заказывает: название компании-клиента. В выгрузке нарядов клиента
      нет — там точка обслуживания и контактное лицо, — поэтому название
      берётся из своего справочника по номеру точки, см. `companies.ts`. */
  company: string;
  /** Как точку называют в интерфейсе: адрес дома либо район. */
  address: string;
  district: string;
  /** Координаты дома — по ним точку показывают на карте. */
  lat: number;
  lon: number;
  /** Открытых заявок по всем прогонам — тех, что ждали инженера. Закрытые
      до расчёта в это число не входят: доля «обслужено из» считается от
      него, и выполненная в учётной системе заявка не должна числиться
      необслуженной. */
  orders: number;
  /** Из них попали в маршрут. */
  assigned: number;
  /** Заявок, закрытых до расчёта: выполненных и отменённых. */
  closed: number;
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

/* ─── услуги ─────────────────────────────────────────────────────────────

   Услуга — это вид работ: что именно делают на объекте. «Конвергенция
   абонента», «Нет линка», «Замена приставки». В выгрузке их восемнадцать, и
   к навыку они не сводятся: навыков по ТЗ ровно три, и каждый покрывает
   несколько услуг.

   Путать их нельзя, и справочник нужен именно затем, чтобы показать связь:
   услуга → какой навык требует, сколько занимает, что везти, нужна ли машина.
   Навык отвечает на «кто может взять», услуга — на «что он там будет
   делать». */

export interface ServiceRecord {
  /** Код вида работ, как он пришёл в данных. */
  key: string;
  /** Название услуги. */
  title: string;
  /** Навык по ТЗ, который она требует. */
  skill: string;
  /** Класс заявки из учётной системы. */
  orderClass: string | null;
  /** Длительность работ, минуты. Если в данных она разная — крайние значения. */
  minutes: number;
  minutesTo: number;
  /** Что везти с собой. */
  equipment: string[];
  /** Требуемый транспорт или `null`, если ограничения нет. */
  requiredTransport: string | null;
  /** Сколько таких заявок в данных открытых — ждущих инженера. Доля
      «разложено из» считается от этого числа. */
  orders: number;
  /** Сколько закрытых до расчёта: выполненных и отменённых. */
  closed: number;
  /** Из них срочных. */
  urgent: number;
  /** Из них требуют доступа в квартиру. */
  access: number;
  /** Сколько раз открытая заявка услуги попадала в расчёты и сколько из
      них разложено. */
  planned: number;
  assigned: number;
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
  /** Ключ точки обслуживания в базе клиентов. Ссылка, а не совпадение строк:
      экраны сверяли адрес показанной строкой, а она собрана для показа — на
      наборе без адресов туда попадал весь район одной кучей. */
  clientKey: string;
  /** Сквозной номер точки: C0105. По нему заявку ищут и им её подписывают. */
  clientCode: string;
  /** Кто заказал: та же компания, что стоит на этом адресе в базе клиентов.
      Считается один раз, реестром, и берётся обеими базами оттуда: назови мы
      её в двух местах по-своему — и одна и та же заявка оказалась бы от
      разных заказчиков на соседних экранах. */
  company: string;
  windowStart: number;
  windowEnd: number;
  slaDeadline: number;
  /** Граница суток расчёта этой заявки (`plan.meta.hard_end`). Нужна шкале
      окна в базах: без неё шкала тянулась бы до конца дня того расчёта,
      который открыт сейчас, и одна заявка в базе и в панели выглядела бы
      по-разному. Пусто у плана без границы — шкала встаёт на настройку. */
  hardEnd: number | null;
  priority: number;
  estMinutes: number;
  needsAccess: boolean;
  /** Инженер, которому заявка досталась в этом расчёте, — номер в плане. */
  engineerId: string | null;
  /** Он же ключом справочника — по нему открывают карточку инженера. */
  engineerKey: string | null;
  engineerName: string | null;
  /** Порядковый номер визита в маршруте, если заявка в него попала. */
  seq: number | null;
  /** Почему в маршрут не попала — словами движка (ТЗ 2.5). Пусто у
      назначенной и у плана без объяснения. */
  unassignedWhy: string | null;
  /** Когда инженер начинает и кончает работу на объекте по плану, минуты от
      полуночи. Пусто у заявки, которая в маршрут не попала: у невзятой
      работы времени нет — есть только окно, когда её были готовы принять. */
  visitStart: number | null;
  visitEnd: number | null;
  /** Номер маршрута, в котором стоит этот визит: M0001. Пусто у невзятой. */
  routeCode: string | null;

  /* ─── что о заявке говорит сама выгрузка ───────────────────────────────
     Схема 1.2 приносит о заявке больше, чем нужно движку для раскладки:
     класс из учётной системы, статус визита, технологию, оборудование и
     контакт клиента. Движку это безразлично, справочнику — нет: база
     заявок отвечает на «что мы об этой заявке знаем», а не на «как она
     легла в маршрут», и молча терять половину колонок выгрузки ей нельзя.
     Пустые поля остаются пустыми: набор без технологии не должен
     показывать выдуманную. */
  lat: number;
  lon: number;
  orderClass: string | null;
  priorityClass: string | null;
  status: string | null;
  requiredTransport: string | null;
  requiredEquipment: string[];
  tech: string | null;
  gigabit: boolean | null;
  contactName: string | null;
  contactPhone: string | null;
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
  /** Номер инженера в плане: по нему маршрут открывают в диспетчерской. */
  engineerId: string;
  /** Он же ключом справочника — по нему открывают карточку инженера. */
  engineerKey: string;
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
  /** Номера заявок маршрута — в порядке объезда. Ими маршрут и назван по
      существу: «где он был» отвечается адресами, а не районами, а район
      слишком крупен, чтобы что-то о визите сказать. */
  orderIds: string[];
  /** Остановок с высоким риском опоздания. */
  risky: number;

  /* ─── чем маршрут лёг по городу ────────────────────────────────────────
     Запись маршрута до сих пор состояла из одних чисел, и карточке в базе
     нечего было показать: числа у двух маршрутов совпадают до минуты, а
     ездят они в разных концах области. Геометрия здесь та же, что в
     наброске расчёта и на большой карте, — один и тот же путь не должен
     идти в трёх местах по-разному. */

  /** Ломаная по улицам: от места выезда инженера и дальше по визитам,
      `[широта, долгота]`. Пусто, когда маршрут не из чего сложить: инженера
      нет в плане либо перегонов меньше двух. */
  path: [number, number][];
  /** Точки визитов по порядку объезда — ими на карточке помечают остановки. */
  stops: [number, number][];
  /** Какая по счёту линия маршрута в наброске расчёта. Ею маршрут красится, и
      два маршрута одного расчёта не сливаются в один цвет. Пусто у маршрута,
      которого в наброске нет: инженера нет в плане либо перегонов меньше
      двух — красить нечего, и первую линию он занимать не должен. */
  lane: number | null;
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
  /** Ключ записи: у инженера движка «участок:номер», см. `engineerKey`. */
  id: string;
  /** Табельный номер, как его показывают: E00, E001. */
  code: string;
  name: string;
  skills: string[];
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

  /* Поля 1.2. Приходят из выгрузки и до сих пор в справочник не доходили,
     хотя тип транспорта ТЗ называет обязательным полем инженера наравне со
     сменой и навыками. Пусто — движок отдаёт 1.1 и этих полей не знает. */

  /** Тип транспортного средства: `car`, `walk`, `bike`, `transit`. */
  transport: string | null;
  /** Бригада, как она названа в выгрузке. */
  team: string | null;
  /** Участок приписки: «Восток», «Юго-Восток», «Центр». Первый из `posts`. */
  zone: string | null;
  /** Куда человек приписан, откуда выезжает и в какую смену. Обычно один; у
      того, кто работает в двух зонах, — два, и офис со сменой в них свои.

      Смена живёт здесь, а не только в `shiftStart`/`shiftEnd`: график не
      свойство человека, он считается по нарядам того дня. Сводная пара
      наверху — из последнего расчёта, и когда смены расходятся, показывать
      надо их, а не её. */
  posts: { zone: string; homeAddress: string | null; shiftStart: number; shiftEnd: number }[];
  phone: string | null;
  /** `on_shift` | `off_shift` | `unavailable`. */
  status: string | null;
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
  /** Человеко-минуты на объектах по всем маршрутам расчёта. */
  workMinutes: number;
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
  services: ServiceRecord[];
  /** Почасовой разрез каждого расчёта — для наложения в сравнении. */
  profiles: RunProfile[];
  stats: RegistryStats;
  /** Участки программы расчёта, чей план не прочитался: их штата и заявок
      в справочнике нет. Пусто — всё на месте (и всегда пусто без неё). */
  missingZones: string[];
}

/** Ключ точки обслуживания: адрес, а если его нет — район с координатами.

    Одно правило на обе базы. Клиенты собираются по нему, заявки по нему же
    на клиентов ссылаются; разойдись эти два места — и связь между базами
    порвалась бы, не сказав ни слова. */
export const clientKeyOf = (order: Order) =>
  order.address ?? `${order.district} · ${order.lat},${order.lon}`;

function buildClients(plans: { run: RunRef; plan: Plan }[]): ClientRecord[] {
  /* Копится запись без номера и без заказчика: номер выдаётся в самом конце,
     всем адресам разом, а заказчик — по этому номеру, и до тех пор ни того,
     ни другого у точки просто нет. */
  type Building = Omit<ClientRecord, 'code' | 'number' | 'company'> & {
    minutes: number[];
    typeSet: Set<string>;
    runSet: Set<string>;
  };
  const map = new Map<string, Building>();

  for (const { run, plan } of plans) {
    for (const order of plan.orders) {
      /* Ключ — адрес: одна и та же квартира приходит в разных расчётах, и это
         одна точка, а не две. Дом без адреса опознаём по координатам, чтобы
         соседние дома одного района не слиплись в одну строку. */
      const key = clientKeyOf(order);
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
          closed: 0,
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
      /* Закрытая до расчёта заявка — часть истории точки, но не часть
         «обслужено из»: инженера она не ждала. */
      if (orderClosed(order)) entry.closed += 1;
      else {
        entry.orders += 1;
        if (order.assigned_to) entry.assigned += 1;
      }
      if (order.needs_access) entry.access += 1;
      /* Срочность — по правилу справочника, одному на весь интерфейс:
         класс, если он пришёл, иначе уровень. Своё правило «уровень от
         второго» расходилось с базой услуг на заявках, где класс `normal`
         стоит при высоком уровне. */
      if (isUrgent(order.priority_class, order.priority)) entry.urgent += 1;
      entry.minutes.push(order.est_minutes);
      entry.typeSet.add(order.work_type);
      entry.runSet.add(run.id);
      entry.firstWindow = Math.min(entry.firstWindow, order.window_start);
    }
  }

  /* Номера выдаём в том порядке, в каком адреса встретились в расчётах: у
     первого увиденного дома C0001. Порядок обхода задан расчётами, а он
     одинаков от загрузки к загрузке, так что и номера выйдут те же. */
  const numbers = clientNumbers([...map.keys()]);

  return [...map.values()]
    .map((entry) => ({
      key: entry.key,
      code: clientLabel(numbers.get(entry.key) ?? 0),
      number: numbers.get(entry.key) ?? 0,
      company: companyOf(numbers.get(entry.key) ?? 0),
      address: entry.address,
      district: entry.district,
      lat: entry.lat,
      lon: entry.lon,
      orders: entry.orders,
      assigned: entry.assigned,
      closed: entry.closed,
      runs: entry.runSet.size,
      workTypes: [...entry.typeSet],
      access: entry.access,
      urgent: entry.urgent,
      avgMinutes: Math.round(entry.minutes.reduce((a, b) => a + b, 0) / entry.minutes.length),
      firstWindow: entry.firstWindow
    }))
    .sort((a, b) => b.orders - a.orders || a.address.localeCompare(b.address, 'ru'));
}

function buildOrders(
  plans: { run: RunRef; plan: Plan }[],
  routes: RouteRecord[],
  clients: ClientRecord[]
): OrderRecord[] {
  const list: OrderRecord[] = [];
  /* Номер маршрута по паре «расчёт + инженер»: его выдала сборка маршрутов,
     и заново выдавать его здесь нельзя — он выйдет другим. */
  const routeCodeByKey = new Map(routes.map((route) => [route.key, route.code]));
  /* Заказчик у заявки тот же, что у её точки в базе клиентов: ключ точки —
     это её адрес, и обе базы опознают его одинаково. Заявка с адресом, не
     попавшим в клиенты, не бывает — клиенты из тех же заявок и собраны, — но
     запасное имя всё равно нужно: пустая строка на месте заказчика читалась
     бы как «заказчика нет», а он есть, просто адрес записан так, что точку по
     нему не опознать. */
  const byKey = new Map(clients.map((client) => [client.key, client]));
  /* Ключ точки собирается тем же правилом, что и в самой базе клиентов, и
     правило это живёт в одном месте — иначе две базы опознают один дом
     по-разному, и связь между ними рвётся молча. */
  const keyFor = (order: Order) => clientKeyOf(order);

  for (const { run, plan } of plans) {
    const nameById = new Map(plan.engineers.map((e) => [e.id, e.name]));
    /* Порядок и время визита лежат в маршруте, а не в заявке: собираем один
       раз, чтобы не искать их по остановкам для каждой строки. Время — то,
       что посчитал движок: когда инженер встанет у двери и когда от неё
       отойдёт. Окно приёма, которое стоит в самой заявке, отвечает на другой
       вопрос — когда клиент готов принять, а не когда к нему приедут. */
    const stopByOrder = new Map<string, { seq: number; start: number; finish: number }>();
    for (const route of plan.routes) {
      for (const stop of route.stops) {
        stopByOrder.set(stop.order_id, {
          seq: stop.seq,
          start: stop.start,
          finish: stop.finish
        });
      }
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
        clientKey: keyFor(order),
        clientCode: byKey.get(keyFor(order))?.code ?? '',
        company: byKey.get(keyFor(order))?.company ?? 'Клиент не опознан',
        windowStart: order.window_start,
        windowEnd: order.window_end,
        slaDeadline: order.sla_deadline,
        hardEnd: plan.meta.hard_end ?? null,
        priority: order.priority,
        estMinutes: order.est_minutes,
        needsAccess: order.needs_access,
        engineerId: order.assigned_to,
        engineerKey: order.assigned_to ? engineerKey(run.day, order.assigned_to) : null,
        engineerName: order.assigned_to ? nameById.get(order.assigned_to) ?? order.assigned_to : null,
        seq: stopByOrder.get(order.id)?.seq ?? null,
        unassignedWhy: order.assigned_to ? null : order.unassigned_reason?.text ?? null,
        visitStart: stopByOrder.get(order.id)?.start ?? null,
        visitEnd: stopByOrder.get(order.id)?.finish ?? null,
        routeCode: order.assigned_to
          ? routeCodeByKey.get(`${run.id}:${order.assigned_to}`) ?? null
          : null,
        lat: order.lat,
        lon: order.lon,
        orderClass: order.order_class ?? null,
        priorityClass: order.priority_class ?? null,
        status: order.status ?? null,
        requiredTransport: order.required_transport ?? null,
        requiredEquipment: order.required_equipment ?? [],
        tech: order.tech ?? null,
        gigabit: order.gigabit ?? null,
        contactName: order.contact?.name ?? null,
        contactPhone: order.contact?.phone ?? null
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
    /* Линии плана и их порядок: номер линии — это цвет маршрута, и берётся он
       оттуда же, откуда сама линия. */
    const lines = pathsOf(plan);
    const lanes = [...lines.keys()];
    for (const route of plan.routes) {
      const districts: string[] = [];
      const orderIds: string[] = [];
      let risky = 0;
      for (const stop of route.stops) {
        const district = districtByOrder.get(stop.order_id);
        if (district && !districts.includes(district)) districts.push(district);
        orderIds.push(stop.order_id);
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
        engineerKey: engineerKey(run.day, route.engineer_id),
        engineerName: nameById.get(route.engineer_id) ?? route.engineer_id,
        visits: route.totals.visits,
        travelMinutes: route.totals.travel_minutes,
        workMinutes: workMinutesOf(route),
        idleMinutes: route.totals.idle_minutes,
        overtimeMinutes: route.totals.overtime_minutes,
        occupancy: route.totals.occupancy,
        start: route.totals.start,
        end: route.totals.end,
        districts,
        orderIds,
        risky,
        path: lines.get(route.engineer_id)?.path ?? [],
        stops: lines.get(route.engineer_id)?.stops ?? [],
        /* Маршрута, которого нет в наброске, нет и среди линий: красить
           нечего, и место в ряду цветов ему ни к чему. Раньше здесь стоял
           ноль, и такой маршрут красился цветом первой линии — чужим. */
        lane: lanes.includes(route.engineer_id) ? lanes.indexOf(route.engineer_id) : null
      });
    }
  }
  return list.sort(
    (a, b) => a.run.code.localeCompare(b.run.code) || a.engineerName.localeCompare(b.engineerName)
  );
}

type EngineerEntry = EngineerRecord & { skillSet: Set<string> };

/** Заводит запись инженера, если её ещё нет, и возвращает её. Заводится она
    одинаково и для штата, и для расчёта: разница только в том, что у первого
    все счётчики так и остаются нулями. */
function blank(
  map: Map<string, EngineerEntry>,
  engineer: Engineer,
  day: string | undefined
): EngineerEntry {
  const key = engineerKey(day, engineer.id);
  const known = map.get(key);
  if (known) return known;
  const entry: EngineerEntry = {
    id: key,
    code: engineer.id,
    name: engineer.name,
    skills: [],
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
    transport: engineer.transport ?? null,
    team: engineer.team ?? null,
    zone: engineer.zone ?? null,
    phone: engineer.phone ?? null,
    status: engineer.status ?? null,
    posts: [],
    byRun: [],
    skillSet: new Set<string>(engineer.skills)
  };
  map.set(key, entry);
  return entry;
}

/** Запоминает участок, офис и смену. Участок не удваивается: один и тот же
    человек приходит из каждого расчёта своей зоны. График при этом
    обновляется — последний расчёт зоны и есть её нынешний график. */
function notePost(entry: EngineerEntry, engineer: Engineer): void {
  if (!engineer.zone) return;
  const known = entry.posts.find((post) => post.zone === engineer.zone);
  if (known) {
    known.homeAddress = engineer.home_address;
    known.shiftStart = engineer.shift_start;
    known.shiftEnd = engineer.shift_end;
    return;
  }
  entry.posts.push({
    zone: engineer.zone,
    homeAddress: engineer.home_address,
    shiftStart: engineer.shift_start,
    shiftEnd: engineer.shift_end
  });
}

/** Каталог услуг: из всех данных, а не только из посчитанного. Расчёты
    добавляют к нему то, чего в данных нет, — сколько раз услугу удалось
    разложить. */
function buildServices(orders: Order[], plans: { plan: Plan }[]): ServiceRecord[] {
  const map = new Map<string, ServiceRecord & { equipSet: Set<string> }>();

  const touch = (order: Order) => {
    let entry = map.get(order.work_type);
    if (!entry) {
      entry = {
        key: order.work_type,
        title: order.work_title || order.work_type,
        skill: order.skill,
        orderClass: order.order_class ?? null,
        minutes: order.est_minutes,
        minutesTo: order.est_minutes,
        equipment: [],
        requiredTransport: order.required_transport ?? null,
        orders: 0,
        closed: 0,
        urgent: 0,
        access: 0,
        planned: 0,
        assigned: 0,
        equipSet: new Set<string>()
      };
      map.set(order.work_type, entry);
    }
    entry.minutes = Math.min(entry.minutes, order.est_minutes);
    entry.minutesTo = Math.max(entry.minutesTo, order.est_minutes);
    for (const item of order.required_equipment ?? []) entry.equipSet.add(item);
    /* Требование к транспорту у одной услуги одно: если в данных оно где-то
       стоит, а где-то нет, считаем, что услуга его требует, — пропустить
       ограничение хуже, чем показать лишнее. */
    if (order.required_transport) entry.requiredTransport = order.required_transport;
    return entry;
  };

  for (const order of orders) {
    const entry = touch(order);
    /* Закрытые — отдельным числом: доля разложенных считается от открытых,
       и выполненная заявка в «не разложено» попадать не должна. */
    if (orderClosed(order)) entry.closed += 1;
    else entry.orders += 1;
    /* Срочность считаем тем же правилом, что и весь остальной интерфейс:
       есть `priority_class` — он и решает, нет — выводим из уровня. Своё
       правило здесь («класс срочный ИЛИ уровень от второго») расходилось с
       общим на заявках, где движок прислал `normal` при высоком уровне, и
       база услуг показывала за один и тот же срок два разных числа срочных:
       одно из записи, другое посчитанное по заявкам. */
    if (isUrgent(order.priority_class, order.priority)) entry.urgent += 1;
    if (order.needs_access) entry.access += 1;
  }

  for (const { plan } of plans) {
    for (const order of plan.orders) {
      const entry = touch(order);
      if (orderClosed(order)) continue;
      entry.planned += 1;
      if (order.assigned_to) entry.assigned += 1;
    }
  }

  return [...map.values()]
    .map(({ equipSet, ...rest }) => ({ ...rest, equipment: [...equipSet] }))
    .sort((a, b) => b.orders - a.orders || a.title.localeCompare(b.title));
}

function buildEngineers(
  plans: { run: RunRef; plan: Plan }[],
  roster: RosterEngineer[]
): EngineerRecord[] {
  const map = new Map<string, EngineerEntry>();

  /* Сначала весь штат, потом выработка. Порядок здесь смысловой: человек
     числится в компании независимо от того, попал ли он хоть в один расчёт,
     и база обязана показать его с нулями, а не спрятать. */
  for (const engineer of roster) notePost(blank(map, engineer, engineer.day), engineer);

  for (const { run, plan } of plans) {
    const routeByEngineer = new Map(plan.routes.map((r) => [r.engineer_id, r]));
    /* У инженера движка участка в плане нет — он один на весь день; без
       него у человека в базе не было бы ни участка, ни офиса выезда. */
    const dayTitle = run.day ? engineDayTitle(run.day) : null;
    for (const planned of plan.engineers) {
      const engineer = planned.zone || !dayTitle ? planned : { ...planned, zone: dayTitle };
      const entry = blank(map, engineer, run.day);
      notePost(entry, engineer);
      entry.runs += 1;
      /* Смена берётся из последнего прогона: справочник показывает то,
         каким инженер числится сейчас, а не каким был в первом расчёте. */
      entry.shiftStart = engineer.shift_start;
      entry.shiftEnd = engineer.shift_end;
      entry.homeAddress = engineer.home_address;
      entry.transport = engineer.transport ?? entry.transport;
      entry.team = engineer.team ?? entry.team;
      entry.zone = engineer.zone ?? entry.zone;
      entry.phone = engineer.phone ?? entry.phone;
      entry.status = engineer.status ?? entry.status;
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
        workMinutes: route ? workMinutesOf(route) : 0,
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
      entry.workMinutes += workMinutesOf(route);
      entry.overtimeMinutes += route.totals.overtime_minutes;
    }
  }

  return [...map.values()]
    .map((entry) => ({
      id: entry.id,
      code: entry.code,
      name: entry.name,
      skills: [...entry.skillSet],
      runs: entry.runs,
      routes: entry.routes,
      visits: entry.visits,
      travelMinutes: entry.travelMinutes,
      workMinutes: entry.workMinutes,
      overtimeMinutes: entry.overtimeMinutes,
      /* Среднее — той же формулой, что и везде: по сменам с маршрутом. */
      occupancyMean: occupancyMean(entry.byRun.filter((shift) => shift.routed)),
      idleRuns: entry.idleRuns,
      shiftStart: entry.shiftStart,
      shiftEnd: entry.shiftEnd,
      homeAddress: entry.homeAddress,
      transport: entry.transport,
      team: entry.team,
      zone: entry.posts[0]?.zone ?? entry.zone,
      posts: entry.posts,
      phone: entry.phone,
      status: entry.status,
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

/* Линии маршрутов плана: `id инженера → ломаная по улицам` и точки визитов к
   ней. Порядок вставки — порядок `plan.routes`, и он же порядок линий в
   наброске расчёта: им маршрут красится, и одна и та же линия в карточке
   расчёта и в карточке маршрута выходит одного цвета.

   Считаются один раз на план, а не на запись истории: файлов три, а расчётов
   два десятка, и один и тот же план приходит в них тем же объектом. Отсюда
   же их берёт и набросок: разбирать одну и ту же геометрию дважды — раз для
   расчёта, раз для маршрута — незачем, а разойдись эти два разбора, и путь
   в двух карточках пошёл бы по-разному. */
const pathCache = new WeakMap<Plan, Map<string, { path: [number, number][]; stops: [number, number][] }>>();

function pathsOf(plan: Plan) {
  const cached = pathCache.get(plan);
  if (cached) return cached;

  const orderById = new Map(plan.orders.map((order) => [order.id, order]));
  const engineerById = new Map(plan.engineers.map((engineer) => [engineer.id, engineer]));
  const map = new Map<string, { path: [number, number][]; stops: [number, number][] }>();

  for (const route of plan.routes) {
    const home = engineerById.get(route.engineer_id);
    if (!home) continue;
    /* Та же линия по улицам, что и на большой карте: карточка — уменьшенный
       вид того же расчёта, и путь в ней не должен идти иначе. */
    const path = roadPath(route, [home.home_lat, home.home_lon], (orderId) => {
      const order = orderById.get(orderId);
      return order ? [order.lat, order.lon] : undefined;
    });
    if (path.length < 2) continue;
    const stops = route.stops
      .map((stop) => orderById.get(stop.order_id))
      .filter((order): order is NonNullable<typeof order> => Boolean(order))
      .map((order) => [order.lat, order.lon] as [number, number]);
    map.set(route.engineer_id, { path, stops });
  }

  pathCache.set(plan, map);
  return map;
}

/* Наброски считаем один раз на источник — по той же причине и так же, как
   линии над ними. */
const sketchCache = new WeakMap<Plan, RunSketch>();

function buildSketch(plan: Plan): RunSketch {
  const cached = sketchCache.get(plan);
  if (cached) return cached;

  const orderById = new Map(plan.orders.map((order) => [order.id, order]));
  const routes = [...pathsOf(plan).values()].map((one) => one.path);

  const loose = plan.unassigned
    .map((id) => orderById.get(id))
    .filter((order): order is NonNullable<typeof order> => Boolean(order))
    .map((order) => [order.lat, order.lon] as [number, number]);

  const sketch = { routes, loose };
  sketchCache.set(plan, sketch);
  return sketch;
}

/* Часы на объектах по одному маршруту.

   Берём из итогов, а когда их там нет — складываем по остановкам: «начал» и
   «закончил» у визита есть всегда, и разница между ними это и есть работа на
   объекте — без дороги и без ожидания, пока откроется окно. Поле итогов
   контракт называет обязательным, но приходит план не только от нашего
   планировщика: в архиве движка лежат прогоны, посчитанные когда угодно и
   чем угодно, и одного пустого поля хватало, чтобы сумма по всем маршрутам
   стала `NaN`, а карточка расчёта показала «NaN мин». Пустое поле в чужом
   плане — обычное дело; «NaN» на экране читается как сломанная программа. */
function workMinutesOf(route: Route): number {
  const total = route.totals.work_minutes;
  if (Number.isFinite(total)) return total;
  return route.stops.reduce((sum, stop) => sum + Math.max(0, stop.finish - stop.start), 0);
}

function buildStats(
  plans: { run: RunRef; plan: Plan; simulation: Simulation }[],
  engineers: EngineerRecord[]
): RegistryStats {
  const workTypes = new Map<string, number>();
  /* Заявки считаются по номерам, а не по строкам планов: номер сквозной на
     всю базу, и одна и та же заявка, разложенная в трёх расчётах одной зоны,
     — одна заявка, а не три. Раньше сумма шла по длине планов, и повторный
     расчёт той же зоны удваивал «заявок обработано». Разложенной заявка
     считается, если инженера ей нашёл хоть один расчёт. */
  const seen = new Set<string>();
  const placed = new Set<string>();

  const byRun: RunStat[] = plans.map(({ run, plan, simulation }) => {
    for (const order of plan.orders) {
      if (order.assigned_to) placed.add(order.id);
      if (seen.has(order.id)) continue;
      seen.add(order.id);
      workTypes.set(order.work_type, (workTypes.get(order.work_type) ?? 0) + 1);
    }
    const visits = plan.routes.reduce((sum, r) => sum + r.totals.visits, 0);
    const work = plan.routes.reduce((sum, r) => sum + workMinutesOf(r), 0);
    const travel = plan.routes.reduce((sum, r) => sum + r.totals.travel_minutes, 0);
    const occupancy = occupancyMean(plan.routes.map((r) => r.totals));
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
      workMinutes: work,
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
    orders: seen.size,
    assigned: placed.size,
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
  const [data, roster, catalogue] = await Promise.all([
    loadRunData(),
    loadRoster(),
    loadAllOrders()
  ]);

  const plans = RUNS.filter((entry) => data.has(entry.id)).map((entry) => ({
    run: {
      id: entry.id,
      code: entry.code,
      date: entry.date,
      created: entry.created,
      note: entry.note,
      /* День движка — только у его расчётов: у расчёта браузера ключ
         инженера остаётся его номером. */
      day: entry.source === null ? entry.day : undefined
    } as RunRef,
    plan: data.get(entry.id)!.plan,
    simulation: data.get(entry.id)!.simulation
  }));

  const engineers = buildEngineers(plans, roster);
  const services = buildServices(catalogue, plans);
  const workTypeTitle: Record<string, string> = {};
  for (const { plan } of plans) {
    for (const order of plan.orders) workTypeTitle[order.work_type] = order.work_title;
  }

  /* Маршруты собираются раньше заявок: номер маршрута выдаётся при их
     сборке, а заявке он нужен готовым — визит называют маршрутом, в котором
     он стоит. Собрать их наоборот значило бы выдать номера дважды и в разном
     порядке. */
  const routes = buildRoutes(plans);
  /* Клиенты собираются раньше заявок: заказчик закрепляется за точкой при их
     сборке, а заявке он нужен готовым — иначе название пришлось бы раздавать
     дважды и по-разному. */
  const clients = buildClients(plans);

  return {
    runs: plans.map((p) => p.run),
    bounds: cityBounds(plans),
    workTypeTitle,
    orders: buildOrders(plans, routes, clients),
    clients,
    routes,
    engineers,
    services,
    profiles: buildProfiles(plans),
    stats: buildStats(plans, engineers),
    missingZones: missingEngineZones()
  };
}
