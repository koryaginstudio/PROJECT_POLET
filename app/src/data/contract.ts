/* Типы четырёх форм контракта, schema 1.1.
   Времена — минуты от полуночи. Справочники (work_type, skill) намеренно
   объявлены как string: 15 сентября они придут другими, и вёрстка обязана
   перечислять то, что пришло в файле, а не то, что зашито здесь.

   Что принесла 1.1: стенд переехал с выдуманной модели города на настоящую
   карту. У заявки появился почтовый адрес, у инженера — адрес выезда, а
   `geometry` в остановке стала ломаной по настоящим улицам от маршрутизатора.
   Поля только добавлены, ни одно не переименовано и не убрано.

   Оба адресных поля объявлены как `string | null`: на синтетической сети,
   которая осталась запасным вариантом, они приходят пустыми. Ключ есть
   всегда, поэтому проверять надо именно на `null`.

   Что принесла 1.2 (см. `frontend_kit/CONTRACT-1.2.md`): транспорт как
   ограничение, пробег в километрах, базовый вариант для сравнения, фактический
   ход визита и ручное закрепление заявки. Все поля 1.2 объявлены
   необязательными и приходят пустыми с движка 1.1 — интерфейс обязан работать
   на обеих версиях, просто на старой часть карточек беднее. */

/** Версия, под которую собран интерфейс. Показывается в настройках. */
export const SCHEMA = '1.2';

/* Сверяется старшая цифра, а не строка целиком. Младшая версия по этому
   контракту всегда дополняющая: поля добавляются, ни одно не переименовано и не
   убрано. Отвергать данные из-за выросшей младшей цифры значило бы наказывать
   себя за собственное обещание — а именно это и случится в тот день, когда
   движок начнёт отдавать 1.2, а интерфейс ещё будет собран под 1.1. */
export function schemaAccepted(schema: string): boolean {
  const major = (value: string) => value.split('.')[0];
  return major(schema) === major(SCHEMA);
}

export type Minutes = number;

/** Где инженер находится сейчас. Нужен двоим: карте — показать, где бригада,
    и пересчёту — считать остаток дня от текущего места, а не от офиса. */
export interface Position {
  lat: number;
  lon: number;
  /** Когда засекли, минуты от полуночи. */
  at: Minutes;
}

export interface Engineer {
  id: string;
  name: string;
  skills: string[];
  grade: number;
  shift_start: Minutes;
  shift_end: Minutes;
  /** Адрес, откуда инженер выезжает. `null` — стенд на синтетической сети. */
  home_address: string | null;
  home_lat: number;
  home_lon: number;

  /* ─── 1.2 ─── */

  /** Тип транспортного средства, один: `car`, `walk`, `bike`, `transit`.
      Пока поле пустое, ограничение по транспорту не проверяется: нечем. */
  transport?: string | null;
  /** `on_shift` | `off_shift` | `unavailable`. Последнее — тот самый сценарий
      перепланирования из ТЗ: инженера сегодня не будет. */
  status?: string | null;
  /** Бригада, как она названа в выгрузке: «Бригада Соколов». */
  team?: string | null;
  /** Участок приписки: «Восток», «Юго-Восток», «Центр». */
  zone?: string | null;
  phone?: string | null;
  /** Путь к снимку. Раздаёт стенд, а не движок, — поле описано, чтобы
      настоящим фотографиям, когда они придут, было куда лечь. */
  photo?: string | null;
  position?: Position | null;
}

/** Кого искать на объекте. Выгрузка контактов не содержит — их подставляет
    сборка набора; интерфейсу инженера без них ехать некуда. */
export interface Contact {
  name: string;
  phone: string;
}

/** Почему заявка осталась без инженера.

    То же самое объясняет и `explain.json`, но список заявок без инженера должен
    показывать причину сразу, не подгружая ради одной строки файл на полтораста
    килобайт. `text` — готовая фраза: движок знает подробности, которых нет в
    коде, и повторять его работу в вёрстке незачем. */
export interface UnassignedReason {
  /** `no_skill` | `no_vehicle` | `no_equipment` | `no_time` | `window_missed` | `unreachable` */
  code: string;
  text: string;
}

export interface Order {
  id: string;
  work_type: string;
  work_title: string;
  skill: string;
  district: string;
  /** Почтовый адрес дома: «Мантулинская улица, 2». `null` на синтетической сети. */
  address: string | null;
  lat: number;
  lon: number;
  window_start: Minutes;
  window_end: Minutes;
  sla_deadline: Minutes;
  priority: number;
  est_minutes: number;
  needs_access: boolean;
  assigned_to: string | null;

  /* ─── 1.2 ─── */

  /** Класс заявки из учётной системы: `connection`, `addon`, `incident`,
      `outage`. Он же задаёт требуемый навык — справочник ТЗ ложится на колонку
      «Тип заявки BK» один в один. */
  order_class?: string | null;
  /** Приоритет словами ТЗ: `normal` | `urgent`. Прежнее числовое `priority`
      остаётся; если это поле пустое, правило вывода одно — `priority >= 2`. */
  priority_class?: string | null;
  /** Статус визита: `draft`, `sent`, `en_route`, `in_progress`, `done`,
      `cancelled`, `overdue`. Семь значений выгрузки — готовый жизненный цикл. */
  status?: string | null;
  /** Код транспорта; `null` — ограничения нет, а не «неизвестно». ТЗ говорит
      прямо: требуемый тип указывается только при наличии такого ограничения. */
  required_transport?: string | null;
  /** Что нужно везти с собой: `router`, `stb`, `ont`, `cable`, `splitter`. */
  required_equipment?: string[] | null;
  /** Технология подключения: `FMC`, `FTTB`, `GPON`. */
  tech?: string | null;
  gigabit?: boolean | null;
  contact?: Contact | null;
  /** Инженер, закреплённый диспетчером вручную. Это обещание, а не пожелание:
      пересчёт обязан оставить заявку здесь, даже если это дороже, — либо увести
      её в неназначенные с причиной, но не переселять молча. */
  locked_to?: string | null;
  /** `solver` | `dispatcher` — кто назначил. */
  assigned_by?: string | null;
  unassigned_reason?: UnassignedReason | null;
}

export type Risk = 'low' | 'medium' | 'high';

export interface Stop {
  seq: number;
  order_id: string;
  arrive: Minutes;
  start: Minutes;
  finish: Minutes;
  travel_minutes: number;
  wait_minutes: number;
  slack_minutes: number;
  risk: Risk;
  /** Перегон до этой остановки ломаной по настоящим улицам, `[широта, долгота]`.
      Первый перегон начинается от дома инженера, последняя точка — сам дом
      заявки. Линия уже упрощена с допуском 5 метров, класть в карту можно как
      есть: на самом близком обзоре это десяток пикселей, на городском —
      меньше одного. Точек всегда минимум две; две совпадающие — это следующий визит в
      том же доме, и такой перегон просто ничего не рисует. */
  geometry: [number, number][];

  /* ─── 1.2 ─── */

  /** Пробег перегона до этой точки, километры. Не считается из минут: полчаса
      по центру и полчаса по вылетной магистрали — разный пробег. */
  distance_km?: number | null;
  /** Фактический статус визита, тот же справочник, что у заявки. */
  status?: string | null;
  /** Как получилось на деле — отмечает инженер в своём интерфейсе. Расхождение
      с плановыми `arrive`/`start`/`finish` и есть «обещали против вышло». */
  fact?: VisitFact | null;
  /** Вероятность опоздать, 0…1. Не то же, что `risk`: тот считается из запаса
      по времени и детерминирован, а это приходит из симуляции, где разыграны
      пробки, неявки и разброс длительностей. Визит может стоять с большим
      запасом и всё равно быть хрупким. */
  late_probability?: number | null;
}

/** Фактические времена визита. Пустые поля — этап ещё не наступил: инженер
    доехал и начал, но не закончил. */
export interface VisitFact {
  arrive: Minutes | null;
  start: Minutes | null;
  finish: Minutes | null;
}

export interface RouteTotals {
  visits: number;
  travel_minutes: number;
  work_minutes: number;
  idle_minutes: number;
  start: Minutes;
  end: Minutes;
  overtime_minutes: number;
  occupancy: number;
  /** 1.2: пробег всего маршрута, километры. */
  distance_km?: number | null;
  /** 1.5: что везёт маршрут — утренняя выдача без запаса, прибор → штук. */
  equipment?: Record<string, number> | null;
}

export interface Route {
  engineer_id: string;
  stops: Stop[];
  totals: RouteTotals;
}

/** Базовый вариант того же дня: заявки по порядку, первому подходящему
    инженеру, ничего не переигрывая. Нужен затем, что «хорошо» — это не
    абсолютное число визитов, а разница с тем, как было бы без планировщика. */
export interface Baseline {
  /** Чем считали: `greedy`. */
  solver: string;
  orders_assigned: number;
  engineers_used: number;
  distance_km_total: number | null;
  /** Минут в пути у базового. `null` — не прислали: программа расчёта их не
      отдаёт, в ТЗ это не метрика. Ноль здесь читался бы «в дороге не были». */
  travel_minutes_total?: number | null;
}

export interface Plan {
  schema: string;
  kind: 'plan';
  meta: {
    /** Чем этот день зовут у движка: зона выгрузки («восток») либо номер
        синтетического дня строкой. Нужен, чтобы понять, на какой запрос
        пришёл ответ: по дате не различить, у всех трёх зон она одна.

        Необязательное: браузерный планировщик его не заполняет. */
    day?: string;
    date: string;
    generated_at: number;
    time_format: string;
    /** Жёсткая граница суток, минуты от полуночи: докуда заявку обязаны
        выполнить сегодня. У синтетики 21:00, у выгрузки заказчика 22:00 —
        поэтому её нельзя держать константой и нельзя путать с настройкой
        `dayEnd`, которая задаёт лишь ось времени на экране.

        Пишут и движок, и браузерный планировщик. Необязательное ради
        старых записей: без него ось тянется по данным плана
        (`planHorizon`), а на завтра переносится срок за полночью
        (`isDeferrable`). */
    hard_end?: Minutes;
    solver: string;
    /** Заявок в раскладке — открытых. Закрытые до расчёта сюда не входят:
        они лежат в `orders` со своим статусом, но исполнителя не ждут. */
    orders_total: number;
    orders_assigned: number;
    /** Заявок, закрытых до расчёта: выполненных и отменённых в учётной
        системе. Необязательное: движок 1.1 статусов не знает и закрытых не
        считает — пустое поле читается как ноль. */
    orders_closed?: number | null;
    engineers_total: number;
    /** Что диспетчер закрепил руками: заявка → инженер. Пусто, когда
        закреплений нет. Закрепление — запрет, а не пожелание: такая
        заявка либо у названного инженера, либо не назначена вовсе, и
        пересчёт её не отнимет. Экрану это нужно, чтобы отличить «так
        решил движок» от «так сказал человек».

        Ставится событием `POST /api/event` с `kind: "assigned"`.
        Контрола для этого в вёрстке пока нет. */
    pinned?: Record<string, string>;
    balance: {
      gini: number;
      occupancy_min: number;
      occupancy_max: number;
      occupancy_mean: number;
      idle_engineers: number;
    };

    /* ─── 1.2: обязательные метрики ТЗ ─── */

    /** Сколько исполнителей получили хотя бы один визит. Столько же даёт длина
        `routes`, и интерфейс так и считает, пока поле пустое. Но метрику,
        которую сверяет жюри, должен называть тот, кто её оптимизирует, — а не
        другая сторона провода по косвенному признаку. */
    engineers_used?: number | null;
    /** Суммарный пробег плана, километры. */
    distance_km_total?: number | null;
    /** Тот же день базовым вариантом — вторая половина требования ТЗ
        «сравните с базовым». Это сводка, а не план: полный базовый план, если
        он понадобится на карте, приходит обычным запросом с указанием солвера
        и в той же самой форме. */
    baseline?: Baseline | null;
  };
  engineers: Engineer[];
  orders: Order[];
  routes: Route[];
  unassigned: string[];
}

/* Пять вердиктов были в 1.1, два добавила 1.2 — и добавила ровно потому, что
   появилось ограничение, которого раньше не существовало: отказать по
   транспорту нельзя, пока транспорта нет в модели. */
export type Verdict =
  | 'chosen'
  | 'feasible'
  | 'no_room'
  | 'shift_mismatch'
  | 'no_skill'
  | 'no_vehicle'
  | 'no_equipment';

export interface Candidate {
  engineer_id: string;
  verdict: Verdict;
  cost: number | null;
  note: string;
}

export interface Explain {
  schema: string;
  kind: 'explain';
  meta: { date: string; cost_units: string };
  orders: Record<string, { assigned_to: string | null; summary: string; candidates: Candidate[] }>;
}

export interface Simulation {
  schema: string;
  kind: 'simulation';
  meta: { date: string; runs: number };
  planned: number;
  orders_total: number;
  done: { mean: number; p10: number; p50: number; p90: number; sd: number };
  coverage: number;
  execution_rate: number;
  reasons: Record<string, number>;
  overtime_minutes: number;
  idle_minutes: number;
  fragile: { order_id: string; failure_rate: number }[];
}

export interface Shifts {
  schema: string;
  kind: 'shifts';
  meta: {
    day?: string;
    /** Самая частая длина смены. Одним числом бригаду не описать: у
        заказчика двое из четырнадцати работают восемь часов, остальные
        девять — вся раскладка в `shift_hours_by_count`. Показывать
        «смена 9 ч» рядом с выходом в 14:00 и границей 22:00 нельзя. */
    shift_hours: number;
    /** Длина смены → сколько инженеров на ней. Необязательное: движок
        постарше и браузерный планировщик его не заполняют. */
    shift_hours_by_count?: Record<string, number>;
    allowed_starts: string[];
    demand_units: string;
  };
  current: { profile: Record<string, number>; expected_coverage: number };
  recommended: {
    profile: Record<string, number>;
    expected_coverage: number;
    starts_by_engineer: Record<string, string>;
  };
  curve: {
    minute: Minutes;
    demand: Record<string, number>;
    demand_total: number;
    supply_current: number;
    supply_recommended: number;
  }[];
}

/** Пятая форма, необязательная: подписи к кодам справочников.

    Нужна затем же, зачем контракт запрещает зашивать справочники в вёрстку.
    Состав кодов задают данные — восемнадцать типов работ в выгрузке никто не
    предугадает, — и подписи к ним должны приходить оттуда же, а не жить в коде
    интерфейса, где их правит другой человек и в другой день.

    Если формы нет, подписи берутся из встроенного словаря, а незнакомый код
    показывается как есть. Ни один экран от её отсутствия не ломается. */
export interface Dictionaries {
  schema: string;
  kind: 'dictionaries';
  skills?: Record<string, string>;
  transports?: Record<string, string>;
  order_classes?: Record<string, string>;
  statuses?: Record<string, string>;
  work_types?: Record<string, string>;
  equipment?: Record<string, string>;
  techs?: Record<string, string>;
}

export interface Day {
  id: string;
  plan: Plan;
  explain: Explain;
  simulation: Simulation;
  shifts: Shifts;
  /** 1.2, необязательная форма: пусто — работаем на встроенном словаре. */
  dictionaries?: Dictionaries | null;
}
