/* Единственное место, которое знает, откуда берутся данные.

   Источник данных один — выгрузка «Билайн Бизнес» за 17 августа 2026 года,
   разложенная на три зоны обслуживания. В каждой зоне свои заявки, свои
   инженеры и свой офис: это три самостоятельных рабочих дня, а не части
   одного. Лежат они файлами в `public/data/<зона>/` и приходят в интерфейс
   в формах контракта 1.2 «orders» и «engineers».

   Готовых планов на диске нет и быть не должно: план — это результат
   расчёта, а не данные. Считается он двумя способами:

   - **движок** — живой сервер, если запущен. Считает по-настоящему и
     хранит архив у себя;
   - **расчёт в интерфейсе** — временная замена движку, пока тот не
     принимает реальные данные. Раскладывает заявки базовым вариантом
     ТЗ (пункт 2.3) прямо в браузере, см. `planner.ts`.

   История расчётов начинается пустой: пока никто ничего не считал,
   показывать нечего. Записи появляются от кнопки «Создать расчёт» и живут
   в браузере — сервера у нас пока нет. Сам план в браузере не хранится:
   расчёт детерминированный, и по зоне с переменными он повторяется
   один в один, сколько ни пересчитывай. */

import { SCHEMA, schemaAccepted } from './contract.ts';
import type { Day, Dictionaries, Engineer, Order, Plan, Simulation } from './contract.ts';
import type { EngineParams } from './engine.ts';
import { planDay } from './planner.ts';
import type { PlannedDay } from './planner.ts';
import {
  createEngineRun,
  engineAlive,
  loadEngineForm,
  loadEngineForms,
  listRuns,
  noteEngineRun,
  probeEngine
} from './api.ts';

/* Зоны обслуживания — то, как выгрузка поделена на рабочие дни. Названия
   пришли вместе с данными от заказчика; ТЗ зон не называет вовсе. */
export const SOURCES = ['east', 'southeast', 'center'] as const;
export type SourceId = (typeof SOURCES)[number];

/** Как зона называется на экране. */
export const ZONE_TITLES: Record<SourceId, string> = {
  east: 'Восток',
  southeast: 'Юго-Восток',
  center: 'Центр'
};

export const zoneTitle = (zone: SourceId) => ZONE_TITLES[zone] ?? zone;

export type RunId = string;

/** Расчёт движка — запись в истории. К календарю привязан датой, к данным —
    источником. */
export interface RunEntry {
  id: RunId;
  /** Номер, под которым расчёт известен наружу: R001 и дальше. */
  code: string;
  /** Дата расчёта, ISO. Живёт в реестре, а не в файле: файлов три, а записей
      в истории пятнадцать. */
  date: string;
  /** Когда расчёт завели: дата и время, «2026-09-08T06:12». У истории время
      синтетическое, как и её даты; у расчёта, заведённого кнопкой, — настоящее. */
  created: string;
  /** Откуда брать формы: имя файла-фикстуры либо `null` — тогда расчёт
      лежит в архиве движка и забирается оттуда по своему номеру. */
  source: SourceId | null;
  /** Номер дня у движка, 1…30. Есть только у настоящих расчётов. */
  day?: number;
  /** Сколько солвер думал над этим планом, секунды. Только у настоящих. */
  solveSeconds?: number;
  /** С какими переменными движка его считали. */
  params: EngineParams;
  /** Заметка человека: зачем этот расчёт считали и чем он кончился. Движок
      её не заполняет и не читает — это подпись к записи, а не входные данные. */
  note?: string;
}

/** Поля записи, которые заводит человек, а не движок: номер, время и заметка.
    Цифры плана в этот список не входят и правке не подлежат — их посчитал
    солвер, и переписывать их значило бы врать про расчёт. */
export type RunPatch = Partial<Pick<RunEntry, 'code' | 'created' | 'note'>>;

const pad = (value: number) => String(value).padStart(2, '0');

const iso = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/* ─── история расчётов ───────────────────────────────────────────────────

   Пустая, пока никто ничего не посчитал. Записи заводит кнопка «Создать
   расчёт» и хранит их браузер: сервера у нас пока нет, а терять историю при
   обновлении страницы незачем.

   Хранится только запись — зона, переменные, номер, дата и заметка. Самого
   плана в хранилище нет: расчёт по одним и тем же данным с одними и теми же
   переменными повторяется один в один, и держать в браузере то, что
   пересчитывается за доли секунды, значит упереться в его квоту на пустом
   месте. */

const STORE_KEY = 'polet.runs.v2';

function readStored(): RunEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RunEntry[];
    if (!Array.isArray(parsed)) return [];
    /* Записи из прошлых версий могли ссылаться на источники, которых больше
       нет: синтетические дни ушли в архив вместе со своими планами. */
    return parsed.filter(
      (run) => run && typeof run.id === 'string' && (run.source === null || SOURCES.includes(run.source))
    );
  } catch {
    /* Испорченная запись — не повод не открыться: начинаем с чистого листа. */
    return [];
  }
}

export const RUNS: RunEntry[] = readStored();

function saveRuns() {
  if (typeof localStorage === 'undefined') return;
  try {
    /* Расчёты движка живут в его архиве и записываются туда им самим —
       дублировать их в браузере незачем. */
    localStorage.setItem(STORE_KEY, JSON.stringify(RUNS.filter((run) => run.source !== null)));
  } catch {
    /* Хранилище может быть закрыто настройками браузера. Запись тогда живёт
       до перезагрузки — это хуже, чем ничего не делать, но не ошибка. */
  }
}

const RUN_BY_ID = new Map(RUNS.map((run) => [run.id, run]));

/* ─── живой движок ───────────────────────────────────────────────────────

   Движок может быть запущен, а может и не быть. Ищем его один раз при
   старте, до первой отрисовки: в истории уже должны стоять все записи,
   иначе адрес в строке браузера откроет не тот расчёт.

   Найденный архив дописывается в конец истории, а не заменяет её: свои
   расчёты и расчёты движка стоят в одном списке и различимы — у движка
   есть номер дня и время счёта.

   Номера при склейке пересчитываются по месту в истории. Движок ведёт
   свою нумерацию с R001, и без этого в списке оказались бы два R001 —
   один свой, другой с движка. Номер — это то, чем расчёты различают
   вслух, и двух одинаковых быть не должно. */

let engineOn = false;

/** Запущен ли движок. Интерфейс этим не управляет — только показывает. */
export const engineReady = () => engineOn;

const codeAt = (index: number) => 'R' + String(index + 1).padStart(3, '0');

/** Ищет движок. Вызывается один раз при старте.

    Архив движка в историю сейчас не подтягивается, и это не оплошность.
    Движок считает свои собственные синтетические дни: реальную выгрузку он
    принимать пока не умеет, транспорта как ограничения в его модели нет, а
    день он обрывает в 21:00, тогда как окна приёма в выгрузке доходят до
    22:00. Показывать его расчёты рядом с расчётами по настоящим данным
    значило бы смешать два разных дня в одном списке.

    Как только движок начнёт принимать зоны выгрузки, отсюда возвращается
    чтение архива, а `createRun` снова пойдёт считать к нему. */
export async function attachEngine(): Promise<boolean> {
  engineOn = await probeEngine();
  return engineOn;
}

/** Умеет ли движок считать по нашим данным. Пока нет — см. `attachEngine`. */
const engineTakesRealData = () => false;

/** Архив движка. Сейчас не используется: ждёт, когда движок примет выгрузку. */
export async function engineArchive() {
  return listRuns();
}

/** Открытый по умолчанию расчёт — самый свежий из оставшихся.

    Пустая строка, пока история пуста: считать ещё нечего, и диспетчерская
    встречает предложением завести первый расчёт.

    Читается как функция, а не как константа: архив движка приезжает после
    того, как модуль разобран, и константа навсегда запомнила бы то, что
    было до него. */
export const latestRun = (): RunId => RUNS[RUNS.length - 1]?.id ?? '';

/** Заводит расчёт по выбранной зоне.

    С живым движком это его счёт: он раскладывает день с присланными
    переменными и кладёт результат к себе в архив.

    Без движка день считается здесь же, в браузере, — базовым вариантом
    ТЗ. План не запоминается: он пересчитывается по зоне и переменным,
    когда понадобится, и всегда выходит тем же самым. */
export async function createRun(
  params: EngineParams,
  zone: SourceId = SOURCES[0],
  day?: number
): Promise<RunEntry> {
  const index = RUNS.length;
  const now = new Date();

  if (engineOn && engineTakesRealData()) {
    const record = await createEngineRun(day ?? 1, params);
    const entry: RunEntry = {
      id: record.id,
      code: codeAt(index),
      date: record.date,
      created: record.created,
      source: null,
      day: record.day,
      solveSeconds: record.summary.solve_seconds,
      params: record.params
    };
    RUNS.push(entry);
    RUN_BY_ID.set(entry.id, entry);
    return entry;
  }

  const started = performance.now();
  const computed = await computeDay(zone, params);
  const entry: RunEntry = {
    id: `run-${Date.now().toString(36)}`,
    code: codeAt(index),
    date: computed.plan.meta.date,
    /* Время у заведённого расчёта настоящее: его завели вот сейчас. */
    created: `${iso(now)}T${clock(now.getHours() * 60 + now.getMinutes())}`,
    source: zone,
    solveSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    params
  };
  RUNS.push(entry);
  RUN_BY_ID.set(entry.id, entry);
  saveRuns();
  return entry;
}

/** Правит поля записи, которые заводит человек. Цифры плана не трогает —
    их в `RunPatch` и нет. */
export function updateRun(id: RunId, patch: RunPatch): void {
  const entry = RUN_BY_ID.get(id);
  if (!entry) return;
  Object.assign(entry, patch);
  saveRuns();

  /* Заметка к расчёту движка переживает не только перезагрузку, но и смену
     браузера: движок хранит её рядом с планом. */
  if (entry.source === null && engineAlive() && patch.note !== undefined) {
    noteEngineRun(id, patch.note).catch(() => undefined);
  }
}

/** Убирает запись из истории. Данные зоны при этом остаются на месте:
    удаляется расчёт, а не день, по которому его считали. */
export function deleteRun(id: RunId): void {
  const at = RUNS.findIndex((run) => run.id === id);
  if (at === -1) return;
  RUNS.splice(at, 1);
  RUN_BY_ID.delete(id);
  saveRuns();
}

/** Сколько расчётов держит браузер. Нужно настройкам — там их и снимают. */
export const runEditCount = () => RUNS.filter((run) => run.source !== null).length;

/** Стирает всю историю расчётов. Данные зон не трогает: они лежат файлами
    и к истории отношения не имеют. */
export function clearRunEdits(): void {
  RUNS.length = 0;
  RUN_BY_ID.clear();
  saveRuns();
}

export const runEntry = (id: RunId): RunEntry => RUN_BY_ID.get(id) ?? RUNS[RUNS.length - 1];

export const runCode = (id: RunId) => runEntry(id)?.code ?? '';

export const runDate = (id: RunId) => runEntry(id)?.date ?? '';

/** Дата и время расчёта так, как их читают: «08.09.2026, 06:12». */
export function stampOf(created: string): string {
  const [date, time = ''] = created.split('T');
  const [year, month, day] = date.split('-');
  return time ? `${day}.${month}.${year}, ${time}` : `${day}.${month}.${year}`;
}

/** То же самое покороче: «08.09.26, 06:12». В плотной строке год целиком не
    помещается и переносится, а различают расчёты всё равно днём и часом. */
export function shortStamp(created: string): string {
  const [date, time = ''] = created.split('T');
  const [year, month, day] = date.split('-');
  return time ? `${day}.${month}.${year.slice(2)}, ${time}` : `${day}.${month}.${year.slice(2)}`;
}

/** Сколько дней назад была эта дата. */
export function daysAgo(iso: string): number {
  const then = new Date(iso + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then.getTime()) / 86_400_000);
}

/** Расчёты приходят с датой, а диспетчер помнит их «вчерашним» и «недельной
    давности» — переводим на этот язык. */
export function whenLabel(iso: string): string {
  const days = daysAgo(iso);
  if (days <= 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (days === 2) return 'Позавчера';
  return `${days} дн. назад`;
}

const endpoint = (source: string, kind: string) => `/data/${source}/${kind}.json`;

export class ContractError extends Error {
  constructor(readonly kind: string, readonly detail: string) {
    super(`${kind}: ${detail}`);
    this.name = 'ContractError';
  }
}

/** Проверка формы на входе: та ли это форма и та ли схема.

    Стоит одинаково и для файла, и для ответа движка. Источник разный —
    контракт один, и «схема 2.0, а интерфейс собран под 1.2» надо поймать
    на границе, а не на экране, где цифры молча разъедутся.

    Сверяется старшая цифра. Раньше сверялась строка целиком, и это было верно
    ровно до того дня, когда версии разошлись: движок отдаёт 1.1, интерфейс
    собран под 1.2, поля добавлены и ни одно не убрано — данные годны, а
    строгое равенство отвергло бы их все до единой. Дополняющая младшая версия
    на то и дополняющая. */
function checkForm(body: { schema: string; kind: string }, kind: string): void {
  if (body.kind !== kind) throw new ContractError(kind, `пришла форма «${body.kind}»`);
  if (!schemaAccepted(body.schema)) {
    throw new ContractError(kind, `схема ${body.schema}, интерфейс собран под ${SCHEMA}`);
  }
}

async function fetchForm<T extends { schema: string; kind: string }>(
  source: string,
  kind: T['kind']
): Promise<T> {
  const url = endpoint(source, kind);
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new ContractError(kind, 'Сервер не ответил');
  }
  if (!response.ok) throw new ContractError(kind, `ответ ${response.status}`);

  let body: T;
  try {
    body = (await response.json()) as T;
  } catch {
    throw new ContractError(kind, 'Тело ответа не разобралось как JSON');
  }

  checkForm(body, kind);
  return body;
}

/* ─── данные зоны и расчёт по ним ────────────────────────────────────────

   Заявки и инженеры лежат файлами и от расчёта не зависят: пересчитать день
   десять раз с разными переменными — это десять планов по одним и тем же
   данным. Поэтому данные читаются один раз на зону и держатся в памяти, а
   планы считаются поверх них.

   Справочник подписей общий на все зоны: состав кодов задают данные, и
   восемнадцать типов работ из выгрузки в коде интерфейса не перечислить. */

interface OrdersForm {
  schema: string;
  kind: 'orders';
  meta: { date: string; zone: string };
  orders: Order[];
}

interface EngineersForm {
  schema: string;
  kind: 'engineers';
  meta: { date: string; zone: string };
  engineers: Engineer[];
}

export interface ZoneData {
  zone: SourceId;
  date: string;
  title: string;
  orders: Order[];
  engineers: Engineer[];
}

const zoneCache = new Map<SourceId, Promise<ZoneData>>();

/** Заявки и инженеры зоны. Читается один раз за сеанс. */
export function loadZone(zone: SourceId): Promise<ZoneData> {
  const cached = zoneCache.get(zone);
  if (cached) return cached;

  const reading = (async (): Promise<ZoneData> => {
    const [orders, engineers] = await Promise.all([
      fetchForm<OrdersForm>(zone, 'orders'),
      fetchForm<EngineersForm>(zone, 'engineers')
    ]);
    return {
      zone,
      date: orders.meta.date,
      title: orders.meta.zone || zoneTitle(zone),
      orders: orders.orders,
      engineers: engineers.engineers
    };
  })();

  zoneCache.set(zone, reading);
  return reading;
}

/** Весь штат компании — инженеры всех зон, каждый по одному разу.

    Нужен базам данных. База — это справочник хозяйства, а не отчёт по
    расчётам: человек числится в штате независимо от того, посчитали сегодня
    его зону или нет. Собранная по одним расчётам, база показывала двенадцать
    человек там, где их тридцать четыре, — и молча меняла размер штата от
    того, что диспетчер завёл ещё один расчёт.

    Сводятся по табельному номеру: инженер, который работает в двух зонах, —
    один человек. Навыки при этом складываются: в одной зоне он за день
    делал одно, в другой другое, а умеет и то и другое. */
export async function loadRoster(): Promise<Engineer[]> {
  const zones = await Promise.all(SOURCES.map((zone) => loadZone(zone).catch(() => null)));
  const byId = new Map<string, Engineer>();
  for (const data of zones) {
    if (!data) continue;
    for (const engineer of data.engineers) {
      const known = byId.get(engineer.id);
      if (!known) {
        byId.set(engineer.id, engineer);
        continue;
      }
      known.skills = [...new Set([...known.skills, ...engineer.skills])];
    }
  }
  return [...byId.values()];
}

let dictionaries: Promise<Dictionaries | null> | null = null;

/** Подписи ко всем кодам. Формы может не быть — тогда работаем на встроенном
    словаре, и ни один экран от этого не ломается. */
export function loadDictionaries(): Promise<Dictionaries | null> {
  if (!dictionaries) {
    dictionaries = (async () => {
      try {
        const response = await fetch('/data/dictionaries.json');
        if (!response.ok) return null;
        const body = (await response.json()) as Dictionaries;
        return body.kind === 'dictionaries' ? body : null;
      } catch {
        return null;
      }
    })();
  }
  return dictionaries;
}

/* Один и тот же день с одними и теми же переменными считается один раз:
   история, базы данных и сводки спрашивают план по многу раз, а расчёт от
   этого не меняется. */
const planCache = new Map<string, Promise<PlannedDay>>();

const planKey = (zone: SourceId, params: EngineParams) =>
  `${zone}|${params.duration_factor}|${params.buffer_base}|${params.buffer_step}|${params.balance_weight}`;

/** Считает день по данным зоны. */
export function computeDay(zone: SourceId, params: EngineParams): Promise<PlannedDay> {
  const key = planKey(zone, params);
  const cached = planCache.get(key);
  if (cached) return cached;

  const computing = (async () => {
    const data = await loadZone(zone);
    return planDay(data.orders, data.engineers, params, data.date);
  })();

  planCache.set(key, computing);
  return computing;
}

export async function loadDay(id: RunId): Promise<Day> {
  const entry = runEntry(id);
  if (!entry) throw new ContractError('plan', 'расчёт не найден');

  /* Расчёт движка приходит одним ответом: четыре формы уже лежат у него
     рядом, и четыре запроса вместо одного ничего бы не ускорили. */
  if (entry.source === null) {
    const forms = await loadEngineForms(id);
    for (const kind of ['plan', 'explain', 'simulation', 'shifts'] as const) {
      checkForm(forms[kind], kind);
    }
    return {
      id,
      plan: forms.plan,
      explain: forms.explain,
      simulation: forms.simulation,
      shifts: forms.shifts,
      dictionaries: await loadDictionaries()
    };
  }

  const [computed, dict] = await Promise.all([
    computeDay(entry.source, entry.params),
    loadDictionaries()
  ]);
  return { id, ...computed, dictionaries: dict };
}

export interface DaySummary {
  id: RunId;
  code: string;
  date: string;
  coverage: number;
  ordersTotal: number;
  ordersAssigned: number;
  unassigned: number;
  engineersTotal: number;
  engineersOnShift: number;
  gini: number;
  occupancyMin: number;
  occupancyMax: number;
  topReason: { key: string; value: number } | null;
}

/** План и симуляция для каждой записи истории.

    Здесь сходятся оба источника: свои расчёты считаются по данным зоны,
    расчёты движка забираются из его архива. Всё, что строит сводки и базы
    данных, ходит сюда — иначе один раздел однажды окажется собран по своим
    расчётам, а соседний по чужим. */
export async function loadRunData(): Promise<Map<RunId, { plan: Plan; simulation: Simulation }>> {
  const remote = RUNS.filter((run) => run.source === null);
  const fetched = await Promise.all(
    remote.map(async (run) => {
      const [plan, simulation] = await Promise.all([
        loadEngineForm<Plan>(run.id, 'plan'),
        loadEngineForm<Simulation>(run.id, 'simulation')
      ]);
      checkForm(plan, 'plan');
      checkForm(simulation, 'simulation');
      return [run.id, { plan, simulation }] as const;
    })
  );
  const byRun = new Map(fetched);

  const own = RUNS.filter((run) => run.source !== null);
  const computed = await Promise.all(
    own.map(async (run) => {
      const day = await computeDay(run.source!, run.params);
      return [run.id, { plan: day.plan, simulation: day.simulation }] as const;
    })
  );
  for (const [id, pair] of computed) byRun.set(id, pair);

  const out = new Map<RunId, { plan: Plan; simulation: Simulation }>();
  for (const run of RUNS) {
    const pair = byRun.get(run.id);
    if (pair) out.set(run.id, pair);
  }
  return out;
}

/** Короткая сводка по каждому расчёту для строки выбора и базы расчётов.
    Тянет только две формы из четырёх — списку большего не нужно. */
export async function loadSummaries(): Promise<DaySummary[]> {
  const data = await loadRunData();

  return RUNS.filter((run) => data.has(run.id)).map((run) => {
    const { plan, simulation } = data.get(run.id)!;
    const reasons = Object.entries(simulation.reasons).sort((a, b) => b[1] - a[1]);
    return {
      id: run.id,
      code: run.code,
      date: run.date,
      coverage: simulation.coverage,
      ordersTotal: plan.meta.orders_total,
      ordersAssigned: plan.meta.orders_assigned,
      unassigned: plan.unassigned.length,
      engineersTotal: plan.meta.engineers_total,
      engineersOnShift: new Set(plan.routes.map((r) => r.engineer_id)).size,
      gini: plan.meta.balance.gini,
      occupancyMin: plan.meta.balance.occupancy_min,
      occupancyMax: plan.meta.balance.occupancy_max,
      topReason: reasons[0] ? { key: reasons[0][0], value: reasons[0][1] } : null
    };
  });
}
