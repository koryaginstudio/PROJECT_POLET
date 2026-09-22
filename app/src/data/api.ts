/* Живой движок: единственное место, которое знает его адрес и его пути.

   Движок — отдельная программа на питоне, которая считает день и хранит
   архив расчётов. Он может быть запущен, а может и не быть, и интерфейс
   обязан открываться в обоих случаях: на защите сервер поднимут, а при
   вёрстке он никому не нужен. Поэтому здесь нет ни одного места, где
   отсутствие движка считается ошибкой, — есть только `probe`, который
   честно отвечает «нашёлся» или «нет».

   Адрес не настраивается и не зашит. Их всего два, и оба проверяются по
   очереди:

   - `/api` — интерфейс лежит в папке `web/` рядом с движком и открывается
     с того же адреса. Это рабочий вариант для защиты: один порт, и
     вопроса CORS не возникает вовсе;
   - `http://localhost:8000/api` — интерфейс на своём dev-сервере, движок
     отдельно. Так удобно верстать.

   Ни ключей, ни конфигурации: то и другое пришлось бы держать в сборке,
   а на защите с чужим ноутбуком лишний шаг настройки — это лишний способ
   не открыться. */

import type { Explain, Plan, Shifts, Simulation } from './contract.ts';
import type { EngineParams } from './engine.ts';

const CANDIDATES = ['/api', 'http://localhost:8000/api'];

/* Сколько ждём ответа на проверку. Движок либо рядом, либо его нет:
   секунды хватает с запасом, а дольше держать пустой экран нечестно. */
const PROBE_TIMEOUT = 1000;

/* Сколько ждём обычного ответа. Без предела зависший обмен держал бы экран
   в «загружаем» до закрытия вкладки; пятнадцати секунд хватает на любой
   ответ из архива с запасом. Счёт — дело другое: план движок думает около
   восьми секунд, пересчёт полторы, и рвать это на пятнадцатой было бы
   рано, — ему минута. */
const CALL_TIMEOUT = 15_000;
const SOLVE_TIMEOUT = 60_000;

/** Расчёт так, как его отдаёт движок. Числа в `summary` посчитаны им же,
    интерфейс их не пересчитывает: одна метрика — один источник. */
export interface EngineRun {
  id: string;
  code: string;
  /** День, по которому считали: зона выгрузки («восток», «юго-восток»,
      «югоцентр») либо номер синтетического дня строкой, «1»…«30».
      Строка с 15 сентября: до этого дни были только синтетическими. */
  day: string;
  date: string;
  created: string;
  note: string;
  params: EngineParams;
  /** Стоят ли заводские значения переменных. Считает движок — он же знает,
      какие у него заводские. */
  factory: boolean;
  /** График смен взят у дня целиком, а не подобран под эти переменные.
      Движок говорит об этом сам, чтобы интерфейс не выдавал чужую форму
      за часть расчёта. */
  shifts_from_day: boolean;
  /** Пометка человека о том, чем был расчёт: «срочные заявки в 13:40».
      Это подпись, а не вид записи — по ней различать нельзя. */
  kind?: string;
  /** Какие формы у записи можно попросить. Движок отвечает этим сам, и
      угадывать больше не надо: у обычного расчёта все четыре, у
      сохранённого пересчёта только `plan`, а у записи, сохранённой
      старой версией движка, — пустой список: по ней есть только сводка
      на карточке. Попросить неназванную форму — получить 400. */
  forms?: string[];
  /** Замысел сохранённого пересчёта: день, момент и что случилось. Есть
      только у пересчётов, и это единственный надёжный признак того, что
      перед нами план остатка дня, а не план дня. У пересчёта нет ни
      симуляции, ни объяснения: попросишь — движок ответит 400. */
  replan?: {
    day: string;
    at: number;
    urgent?: number | null;
    cancelled?: string | null;
    disabled?: string | null;
    delayed?: string | null;
    source?: string;
    run?: number;
  } | null;
  summary: {
    orders_total: number;
    orders_assigned: number;
    unassigned: number;
    engineers_total: number;
    engineers_on_route: number;
    coverage: number;
    gini: number;
    occupancy_min: number;
    occupancy_max: number;
    /** Сколько солвер думал над этим планом. Показываем честно: это та
        самая цифра, которой мы хвалимся. */
    solve_seconds: number;
  };
}

export interface EngineForms {
  run: EngineRun;
  plan: Plan;
  /* У сохранённого пересчёта своих трёх форм нет (server.py, run_forms):
     только план остатка дня, `kind: "replan"`. */
  explain?: Explain;
  simulation?: Simulation;
  shifts?: Shifts;
}

/** Адрес движка, если он нашёлся. `null` — работаем на фикстурах. */
let base: string | null = null;

export const engineBase = () => base;
export const engineAlive = () => base !== null;

/** Ищет движок по обоим адресам. Вызывается один раз при запуске.

    Отрицательный ответ — не ошибка и в консоль не пишется: отсутствие
    движка это обычный режим работы, а не поломка. */
export async function probeEngine(): Promise<boolean> {
  for (const candidate of CANDIDATES) {
    try {
      const stop = AbortSignal.timeout(PROBE_TIMEOUT);
      const response = await fetch(`${candidate}/health`, { signal: stop });
      if (!response.ok) continue;
      const body = (await response.json()) as { status?: string };
      if (body.status !== 'ok') continue;
      base = candidate;
      return true;
    } catch {
      /* Не отозвался — пробуем следующий. */
    }
  }
  base = null;
  return false;
}

/** Прогрев движка: он открывает порт сразу, а дни считает в фоне. */
export interface EngineWarming {
  ready: string[];
  pending: string[];
  current: string | null;
  seconds: number;
}

/* Сколько ждём ответа о прогреве. Не секунду, как при поиске: пока движок
   греется, фоновый поток занят днями, и /health может ответить медленнее. */
const WARMING_TIMEOUT = 5000;

/** Что движок ещё считает. `null` — всё готово (или движка нет);
    `'unknown'` — не ответил вовремя: это не «готово», а «спросите ещё раз».
    Спутать одно с другим — значит снять заставку и сеять в недогретый движок. */
export async function engineWarming(): Promise<EngineWarming | null | 'unknown'> {
  if (base === null) return null;
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(WARMING_TIMEOUT) });
    if (!response.ok) return 'unknown';
    const body = (await response.json()) as { warming?: EngineWarming | null };
    return body.warming ?? null;
  } catch {
    return 'unknown';
  }
}

/** Отчего не вышел обмен с движком. Нужно `humanError` (errors.ts): «не
    запущен», «думает дольше срока» и «отказал с объяснением» — три разных
    совета человеку, и различать их по тексту сообщения было бы хрупко. */
export type EngineFailure = 'offline' | 'timeout' | 'garbled' | 'refused';

export class EngineError extends Error {
  /** Код ответа сервера, если ответ был. */
  readonly status: number | null;
  readonly failure: EngineFailure;
  constructor(message: string, failure: EngineFailure = 'refused', status: number | null = null) {
    super(message);
    this.name = 'EngineError';
    this.failure = failure;
    this.status = status;
  }
}

async function call<T>(path: string, init?: RequestInit, timeout = CALL_TIMEOUT): Promise<T> {
  if (!base) throw new EngineError('Движок не запущен', 'offline');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    /* Истёкший срок и упавшая сеть — разные ответы: первый значит, что
       движок есть, но занят или завис, и «проверьте, что запущен» здесь
       посылает искать не там. */
    if ((error as { name?: string })?.name === 'TimeoutError') {
      throw new EngineError(`Движок не ответил за ${Math.round(timeout / 1000)} с`, 'timeout');
    }
    throw new EngineError('Движок не отвечает — проверьте, что он запущен', 'offline');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EngineError(`Движок ответил не JSON (${response.status})`, 'garbled', response.status);
  }
  if (!response.ok) {
    const said = (body as { error?: string }).error;
    throw new EngineError(said ?? `Движок ответил ${response.status}`, 'refused', response.status);
  }
  return body as T;
}

/** История расчётов движка, старые первыми. */
export const listRuns = () =>
  call<{ runs: EngineRun[] }>('/runs').then((body) => body.runs);

/** Заводит расчёт: движок считает день с этими переменными и кладёт
    результат к себе в архив. Занимает около восьми секунд — это работа
    планировщика, а не задержка сети. */
export const createEngineRun = (day: string, params: EngineParams, note = '') =>
  call<EngineRun>(
    '/runs',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ day, params, note })
    },
    SOLVE_TIMEOUT
  );

/** Все четыре формы одного расчёта. */
/* Срок — как у счёта: формы расчёта с переменными, которых нет в кэше,
   движок пересчитывает при запросе, и это до 45 с. */
export const loadEngineForms = (id: string) =>
  call<EngineForms>(`/runs/${encodeURIComponent(id)}`, undefined, SOLVE_TIMEOUT);

/** Четыре формы целого дня — GET /api/day. Нужны пересчёту из архива:
    объяснение, сводка и график — дня, от которого он отпочковался. */
/* Срок — как у счёта: холодный день движок считает до восьми секунд. */
export const loadEngineDay = (day: string) =>
  call<Omit<EngineForms, 'run'>>(`/day?day=${encodeURIComponent(day)}`, undefined, SOLVE_TIMEOUT);

/** План целого дня движка — GET /api/plan?day=<зона>. Из него при живом
    движке базы данных берут штат, участки и заявки участка: номера
    инженеров и заявок в нём те же, что в расчётах, и база не смешивает две
    разные бригады. Первый запрос по непосчитанной зоне запускает расчёт,
    поэтому срок — как у расчёта, а не как у обычного запроса. */
export const loadDayPlan = (day: string) =>
  call<Plan>(`/plan?day=${encodeURIComponent(day)}`, undefined, SOLVE_TIMEOUT);

/** Одна форма. Базам данных нужен только план, и тянуть ради них
    объяснение на полтораста килобайт незачем. */
/* Срок — как у `loadEngineForms`: форма может пересчитываться на лету. */
export const loadEngineForm = <T>(id: string, kind: string) =>
  call<T>(`/runs/${encodeURIComponent(id)}/${kind}`, undefined, SOLVE_TIMEOUT);

/** Заметка человека к расчёту. Движок её не читает — хранит и отдаёт. */
export const noteEngineRun = (id: string, note: string) =>
  call<EngineRun>(`/runs/${encodeURIComponent(id)}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note })
  });

/** Справочники движка: навыки, виды работ, типы транспорта.

    До этой ручки русские названия навыков нам взять было негде —
    приходили голые `install` и `emergency`, а список видов работ
    собирался по тому, что случилось в открытом дне, и на разных зонах
    выходил разным. */
export interface EngineCatalogue {
  schema: string;
  kind: 'catalogue';
  skills: { code: string; title: string }[];
  work_types: {
    code: string; title: string; skill: string;
    est_minutes: number; needs_access: boolean;
    requires_transport: string | null;
  }[];
  transport: { code: string; title: string; max_km: number | null }[];
  /** Приборы, которые везут на заявку, и сколько каждого выдают утром
      сверх маршрута. Необязательное: у движка до схемы 1.5 его нет. */
  equipment?: { code: string; title: string; reserve: number }[];
}

export const loadCatalogue = () => call<EngineCatalogue>('/catalogue');

/** Одна настройка движка: значение, заводское и пределы. */
export interface EngineSetting {
  value: number;
  default: number;
  min: number;
  max: number;
  about: string;
}

/** Семь настроек движка. Окну правки нужна одна — штраф за смену
    исполнителя: ползунок встаёт туда, где стоит настройка компании, а не
    на заводской ноль вёрстки. Иначе пересчёт с экрана молча считался бы
    с другим штрафом, чем тот, что в настройках. */
export const loadEngineSettings = () =>
  call<{ settings: Record<string, EngineSetting>; fingerprint: string }>('/settings');

/** Какие дни движок умеет считать и какие уже посчитаны. */
export const listDays = () =>
  call<{ ready: string[]; available: string[] }>('/days');

/* ─── пересчёт внутри дня ────────────────────────────────────────────────

   То, ради чего движок и нужен на экране: день пошёл не так, как посчитали,
   и остаток надо переложить. Три события, и они разной цены — см. описание
   в самом окне правки. */

/* Четвёртое событие — отмена заявки — названо в 1.2 явно. Движок умеет её и
   сегодня: заявку просто не подают на вход. Но «не подать» нельзя вызвать —
   у интерфейса должно быть имя для того, что делает диспетчер, иначе кнопки
   для третьего сценария ТЗ взяться неоткуда. */
export type IncidentKind = 'urgent' | 'cancel' | 'disabled' | 'delayed';

export interface IncidentSpec {
  /** День у движка: зона выгрузки либо номер синтетического дня строкой. */
  day: string;
  /** Момент, от которого пересобирается остаток, минуты от полуночи. */
  at: number;
  kind: IncidentKind;
  /** Какую заявку снимают. Только для `cancel`. */
  orderId?: string;
  /** Сколько аварий пришло. Только для `urgent`. */
  urgent?: number;
  /** У кого на участке случилась авария. Только для `urgent`, и поле
      необязательное: пусто — авария «где-то по городу», как было раньше.
      Названному инженеру заявка не назначается — она идёт в общий пул,
      и кто поедет, решает движок. */
  urgentNear?: string;
  /** Кто выбыл или задержался. Для `disabled` и `delayed`. */
  engineerId?: string;
  /** На сколько задержится, минуты. Только для `delayed`. */
  minutes?: number;
  /** Штраф за смену исполнителя — живой контрол окна правки: насколько
      пересчёт держится за то, кому уже сказали ехать. Пусто — настройка
      компании. */
  churnPenalty?: number;
  /** Ярлык принятого пересчёта от журнала: сохранение берёт журнал на
      момент показа, а не уже принятый. */
  adoptToken?: string;
  /** Открытый расчёт дня: пересчёт идёт от его плана и переменных, а не от
      плана компании. Пусто — от плана компании. */
  base?: string;
  /** От чего считать остаток: `sim` — день разыгран движком, `journal` — от
      того, о чём отчитался диспетчер. Пусто — `sim`. */
  source?: 'sim' | 'journal';
}

/** Разбор отмены: что купила освободившаяся ёмкость. */
export interface ReplanCancel {
  kind: 'cancelled';
  order_ids: string[];
  /** Сколько минут работы освободилось, по нормативу. */
  freed_minutes: number;
  /** Заявки, которых исходный план не брал, а теперь берёт. */
  picked_up: string[];
  picked_up_count: number;
  stability_others: number;
}

/** Разбор ЧП с инженером: куда делись визиты, которые были у него впереди. */
export interface ReplanIncident {
  kind: 'disabled' | 'delayed';
  engineer_id: string;
  minutes: number | null;
  /** Было впереди — и дальше три исхода, которые в сумме дают ровно его. */
  pending_was: string[];
  rescued: string[];
  kept: string[];
  lost: string[];
  /** Доля сохранивших исполнителя среди тех, кого ЧП не касалось. */
  stability_others: number;
  /** 1.2: кто сменил инженера или место в маршруте, не выпав из плана.
      Сегодня пересчёт говорит, кого спасли и кого потеряли, но молчит о тех,
      кто просто переехал, — а для диспетчера это и есть главный вопрос после
      ЧП: не «сколько потеряли», а «что теперь поменялось в моих маршрутах». */
  moved?: string[] | null;
}

/** 1.2: что именно случилось. Сегодня о событии приходится догадываться по
    тому, какие поля заполнены: есть `incident` — значит, ЧП с инженером, пришли
    `urgent_ids` — значит, авария. Пока событий три, это терпимо; журнал событий
    за день на догадках не построишь. */
export interface ReplanEvent {
  type: IncidentKind;
  /** Для срочной заявки и отмены. */
  order_id?: string | null;
  /** Для ЧП с инженером. */
  engineer_id?: string | null;
}

/** Что вернул пересчёт: план на остаток дня плюс его цена. */
export interface ReplanMeta {
  /** Только у пересчёта от журнала: его передают в «Принять». */
  adopt_token?: string;
  at: number;
  solve_seconds: number;
  stability: number;
  urgent_ids: string[];
  urgent_assigned: number;
  /** У кого на участке случилась авария. null — по городу. */
  urgent_near?: string | null;
  done_before: string[];
  failed_before: Record<string, string>;
  /** Сколько визитов в новом плане и сколько было бы без пересчёта. */
  assigned_now: number;
  assigned_as_is: number;
  incident?: ReplanIncident | ReplanCancel;
  /** Штраф за смену исполнителя, с которым считали. */
  churn_penalty?: number;
  /** Заявки, к которым исполнитель уже едет: в пересчёте их нет, они его. */
  underway?: Record<string, string>;
  /** 1.2: пусто — движок ещё на 1.1, событие выводится из заполненных полей. */
  event?: ReplanEvent | null;
}

export type ReplanResult = Plan & { meta: Plan['meta'] & { replan: ReplanMeta } };

/** Собирает строку запроса из события так, как её ждёт движок. Табельные
    номера приходят из данных и экранируются: номер с пробелом или знаком
    «&» иначе разрезал бы запрос на два. */
function incidentQuery(spec: IncidentSpec): string {
  /* Имена зон кириллические: браузер закодировал бы их и сам, но строка
     запроса собирается здесь, и кодировать её — наша работа. */
  const parts = [`day=${encodeURIComponent(spec.day)}`, `at=${spec.at}`];
  if (spec.base) parts.push(`base=${encodeURIComponent(spec.base)}`);
  /* Аварии передаются числом, и ноль — законное значение: при ЧП с
     инженером никаких аварий не приходит, и просить их заодно значило бы
     мерить два события сразу. */
  parts.push(`urgent=${spec.kind === 'urgent' ? spec.urgent ?? 2 : 0}`);
  if (spec.kind === 'urgent' && spec.urgentNear) {
    parts.push(`urgent_near=${encodeURIComponent(spec.urgentNear)}`);
  }
  if (spec.kind === 'disabled' && spec.engineerId) {
    parts.push(`disabled=${encodeURIComponent(spec.engineerId)}`);
  }
  if (spec.kind === 'delayed' && spec.engineerId) {
    parts.push(`delayed=${encodeURIComponent(`${spec.engineerId}:${spec.minutes ?? 40}`)}`);
  }
  /* Отмена — третье событие пересчёта из ТЗ. Тип был, а в запрос она не
     попадала: движок считал обычный пересчёт без отмены. `auto` — заявка,
     отказ от которой освободит больше всего времени. */
  if (spec.kind === 'cancel') parts.push(`cancelled=${encodeURIComponent(spec.orderId ?? 'auto')}`);
  if (spec.churnPenalty !== undefined) parts.push(`churn_penalty=${spec.churnPenalty}`);
  if (spec.source) parts.push(`source=${spec.source}`);
  return parts.join('&');
}

/** Пересчитывает остаток дня. Занимает около полутора секунд — это работа
    планировщика, и прятать её не нужно. */
export const replanDay = (spec: IncidentSpec) =>
  call<ReplanResult>(`/replan?${incidentQuery(spec)}`, undefined, SOLVE_TIMEOUT);

/** Кладёт результат пересчёта в архив. Движок не считает заново: результат
    у него уже есть, он только сохраняет его отдельной записью.

    `source` здесь — источник состояния дня (`sim` или `journal`), как его
    понимает движок. Сюда прежде уходил номер родительского расчёта, и
    движок отвечал 400 на каждое сохранение: «Сохранить» не работало ни
    разу. Номер родителя едет в заметке — это подпись человеку. */
export const saveReplan = (spec: IncidentSpec, note = '') =>
  call<EngineRun>('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source: spec.source ?? 'sim',
      note,
      replan: {
        day: spec.day,
        at: spec.at,
        urgent: spec.kind === 'urgent' ? spec.urgent ?? 2 : 0,
        urgent_near: spec.kind === 'urgent' ? spec.urgentNear : undefined,
        cancelled: spec.kind === 'cancel' ? spec.orderId ?? 'auto' : undefined,
        disabled: spec.kind === 'disabled' ? spec.engineerId : undefined,
        delayed:
          spec.kind === 'delayed' ? `${spec.engineerId}:${spec.minutes ?? 40}` : undefined,
        churn_penalty: spec.churnPenalty,
        adopt_token: spec.adoptToken,
        base: spec.base
      }
    })
  },
  /* Сохранение не считает заново, но при устаревшем кэше движок достраивает
     план сам — пятнадцати секунд на это мало. */
  SOLVE_TIMEOUT);

/* ─── сохранённые сравнения ──────────────────────────────────────────────

   Сравнение движок не считает: он складывает рядом уже посчитанное и
   хранит запись о том, что и когда сравнивали. Цифры уходят снимком —
   теми самыми, что были на экране в момент сохранения. Ссылками на
   расчёты обойтись нельзя: расчёт могут переименовать или удалить, а
   сравнение обязано остаться читаемым — оно отвечает на вопрос «что мы
   видели, когда принимали решение». */

/** Один расчёт внутри сохранённого сравнения: номер, когда считали и
    цифры на момент сохранения. Имена полей — как у движка. */
export interface SavedCompareRun {
  id: string;
  code: string;
  created: string;
  day?: string;
  source?: string | null;
  note?: string;
  orders: number;
  assigned: number;
  coverage: number;
  assigned_share: number;
  routes: number;
  visits: number;
  travel_minutes: number;
  occupancy: number;
  engineers_total: number;
  engineers_on_route: number;
}

export interface SavedCompare {
  id: string;
  /** Номер наружу: C001 и дальше. */
  code: string;
  date: string;
  created: string;
  note: string;
  runs: SavedCompareRun[];
}

/** Сохранённые сравнения, старые первыми. */
export const listCompares = () =>
  call<{ compares: SavedCompare[] }>('/compares').then((body) => body.compares);

/** Кладёт набор в архив. Границы набора движок проверяет сам. */
export const saveCompare = (runs: SavedCompareRun[], note = '') =>
  call<SavedCompare>('/compares', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runs, note })
  });

/** Убирает сравнение из архива. Расчёты при этом не трогаются. */
export const deleteCompare = (id: string) =>
  call<{ deleted: string }>(`/compares/${encodeURIComponent(id)}`, { method: 'DELETE' });

/* ─── журнал диспетчера ──────────────────────────────────────────────────

   То, что случилось на самом деле, сообщает диспетчер, и пересчёт идёт от
   этого (`source=journal`), а не от дня, разыгранного движком. Ручек у
   движка было много, а клиента в вёрстке не было ни одного: ни ручного
   переназначения — единственного «необходимо заложить» с сессии вопросов,
   — ни статусов «отправлено» и «в пути», о которых просила обратная связь
   организаторов. */

/** Событие дня. Время — минуты от полуночи, как везде в контракте. */
export type JournalEvent =
  | { kind: 'assigned'; order: string; engineer: string; position?: number }
  | { kind: 'dispatched' | 'en_route' | 'done'; order: string }
  | { kind: 'failed'; order: string; reason: 'no_show' | 'no_access' | 'missed_window' | 'cancelled' }
  | { kind: 'engineer_out' | 'engineer_back'; engineer: string }
  | { kind: 'engineer_delayed'; engineer: string; minutes: number };

/** Записывает событие. Невозможное движок отвергает словами — их и
    показываем: «инженер E06 не может взять 52405: нет навыка…». */
/* `base` у ручек журнала — открытый расчёт дня: у каждого расчёта свой
   журнал, заведённый от его плана. Пусто — журнал плана компании. */
const baseQuery = (base?: string) => (base ? `&base=${encodeURIComponent(base)}` : '');

/* У ручек журнала срок счёта: событие, состояние и «Принять» заставляют
   движок проиграть день заново, а у непрогретого расчёта это не секунды. */
export const postEvent = (day: string, at: number, event: JournalEvent, base?: string) =>
  call<{ recorded: Record<string, unknown>; summary: Record<string, unknown> }>('/event', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, at, base, ...event })
  }, SOLVE_TIMEOUT);

/** Что движок знает о дне по отчётам диспетчера. */
export interface DayState {
  day: string;
  at: number;
  done: string[];
  failed: Record<string, string>;
  /** Заявка → статус по всем, о которых что-то сообщили. Остальные в чьём-то
      маршруте — «назначено». */
  statuses: Record<string, string>;
  /** Заявка → инженер, который к ней едет. */
  underway: Record<string, string>;
  summary: { events: number; done: number; failed: number; absent: string[] };
}

export const loadDayState = (day: string, at: number, base?: string) =>
  call<DayState>(`/state?day=${encodeURIComponent(day)}&at=${at}${baseQuery(base)}`, undefined, SOLVE_TIMEOUT);

/** «Принять» пересчёт от журнала: показанный план становится назначением
    дня. Показ журнал не трогает; если после него что-то сообщили — 409,
    пересчитать заново. */
export const adoptJournal = (day: string, token: string, base?: string) =>
  call<{ adopted: string; summary: Record<string, unknown> }>('/journal/adopt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, token, base })
  }, SOLVE_TIMEOUT);

/** Забыть всё сообщённое по дню и вернуться к утреннему плану. Нужен и на
    защите: сценарий прогнали, показали — и день снова чистый. */
export const resetJournal = (day: string, base?: string) =>
  call<{ summary: Record<string, unknown> }>('/journal/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ day, base })
  }, SOLVE_TIMEOUT);

/* ─── сколько ещё людей нужно ────────────────────────────────────────────

   Ответ в том виде, в каком его продиктовал постановщик: «для того чтобы
   выполнить оставшиеся заявки, нужно ещё плюс N исполнителей», — и
   каких: навыки, транспорт, часы смены. Считает планировщик, а не деление
   часов на смену. */

export interface StaffingSlot {
  count: number;
  skills: string[];
  skills_title: string;
  transport: string;
  transport_title: string;
  shift_start: number;
  shift_end: number;
}

export interface Staffing {
  unassigned_now: number;
  needed: number;
  closes_all: boolean;
  phrase: string;
  reliability?: string;
  slots: StaffingSlot[];
  still_unassigned: string[];
}

/* Срок счёта: «сколько людей» — это несколько прогонов планировщика, до минуты. */
export const loadStaffing = (day: string, base?: string) =>
  call<Staffing>(`/staffing?day=${encodeURIComponent(day)}${baseQuery(base)}`, undefined, SOLVE_TIMEOUT);
