/* Единственное место, которое знает, откуда берутся данные.

   Источников два, и они уживаются рядом:

   - **фикстуры** — три дня, записанные в файлы. На них интерфейс верстают,
     и на них он открывается, когда движок не запущен. История в этом
     режиме собрана по кругу: записей двадцать четыре, файлов три. Это
     не обман, а каркас — так видно, как выглядит список, когда расчётов
     много, и цифры внутри каждой записи настоящие;
   - **движок** — живой сервер, который считает день по-настоящему и
     хранит архив. Его расчёты дописываются в конец истории.

   Правка источника живёт здесь и нигде больше: формы по контракту
   одинаковые, и всё, что выше, разницы не видит. */

import { SCHEMA, schemaAccepted } from './contract.ts';
import type { Day, Explain, Plan, Shifts, Simulation } from './contract.ts';
import { ENGINE_DEFAULTS } from './engine.ts';
import type { EngineParams } from './engine.ts';
import {
  createEngineRun,
  engineAlive,
  loadEngineForm,
  loadEngineForms,
  listRuns,
  noteEngineRun,
  probeEngine
} from './api.ts';

/* Источники данных — файлы на диске. Их три, и это отдельная сущность от
   расчёта: расчёт живёт в истории под своим номером и датой, а данные к нему
   приходят из источника. */
export const SOURCES = ['day-01', 'day-02', 'day-07'] as const;
export type SourceId = (typeof SOURCES)[number];

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

/* Сколько расчётов держим в истории. Больше, чем помещается в ленту
   подшапки: лента показывает последние, остальные достаются из списка —
   ради этого список и нужен. */
const HISTORY = 24;

const pad = (value: number) => String(value).padStart(2, '0');

const iso = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/* Час расчёта: движок считает смену ночью, до выхода бригад. Минуты разведены
   по номеру записи — иначе двадцать четыре расчёта в истории отличались бы
   друг от друга одной только датой. */
const runMinute = (index: number) => 5 * 60 + 20 + ((index * 37) % 95);

/* История расчётов. Источников три, а записей пятнадцать: архив собран по
   кругу, чтобы каркас истории было видно целиком — как выглядит строка
   выбора, когда расчётов много, и как по ней искать нужный. Цифры внутри
   записи настоящие, они приходят из источника; синтетические тут номер,
   дата и время. Когда появится настоящий архив, изменится только этот список —
   всё, что ниже, читает уже его. */
function buildRuns(): RunEntry[] {
  const today = new Date();
  const runs: RunEntry[] = [];
  for (let index = 0; index < HISTORY; index += 1) {
    /* Первым идёт самый старый: номера растут вместе с датой, как в любом
       журнале, и R015 — это сегодня. */
    const daysBack = HISTORY - 1 - index;
    const date = new Date(today);
    date.setDate(date.getDate() - daysBack);
    runs.push({
      id: 'run-' + String(index + 1).padStart(2, '0'),
      code: 'R' + String(index + 1).padStart(3, '0'),
      date: iso(date),
      created: `${iso(date)}T${clock(runMinute(index))}`,
      source: SOURCES[index % SOURCES.length],
      params: { ...ENGINE_DEFAULTS }
    });
  }
  return runs;
}

/* ─── правки истории ─────────────────────────────────────────────────────

   Расчёт считает движок, а номер, время создания и заметку заводит человек.
   Терять их при обновлении страницы незачем, сервера у нас пока нет —
   поэтому правки лежат в браузере и накладываются на историю при загрузке.

   Хранится не сама история, а только правки к ней: список строится заново на
   каждый заход (даты в нём считаются от сегодняшнего дня), и записанный
   целиком он бы устарел на следующее утро. */

const STORE_KEY = 'polet.run-edits.v1';

interface RunEdits {
  patch: Record<RunId, RunPatch>;
  removed: RunId[];
}

const EMPTY_EDITS: RunEdits = { patch: {}, removed: [] };

function readEdits(): RunEdits {
  if (typeof localStorage === 'undefined') return { ...EMPTY_EDITS };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...EMPTY_EDITS };
    const parsed = JSON.parse(raw) as Partial<RunEdits>;
    return {
      patch: parsed.patch ?? {},
      removed: Array.isArray(parsed.removed) ? parsed.removed : []
    };
  } catch {
    /* Испорченная запись — не повод не открыться: начинаем с чистого листа. */
    return { ...EMPTY_EDITS };
  }
}

let edits = readEdits();

function saveEdits() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(edits));
  } catch {
    /* Хранилище может быть закрыто настройками браузера. Правка тогда живёт
       до перезагрузки — это хуже, чем ничего не делать, но не ошибка. */
  }
}

function applyEdits(list: RunEntry[]): RunEntry[] {
  const gone = new Set(edits.removed);
  return list
    .filter((run) => !gone.has(run.id))
    .map((run) => (edits.patch[run.id] ? { ...run, ...edits.patch[run.id] } : run));
}

export const RUNS: RunEntry[] = applyEdits(buildRuns());

const RUN_BY_ID = new Map(RUNS.map((run) => [run.id, run]));

/* ─── живой движок ───────────────────────────────────────────────────────

   Движок может быть запущен, а может и не быть. Ищем его один раз при
   старте, до первой отрисовки: в истории уже должны стоять все записи,
   иначе адрес в строке браузера откроет не тот расчёт.

   Найденный архив дописывается в конец истории, а не заменяет её.
   Заменять нечем: настоящих расчётов поначалу два-три, и разделы баз,
   собранные по ним, оказались бы пустыми. Прошлое остаётся фикстурным
   каркасом, новое — настоящим, и одно от другого отличимо: у настоящего
   есть номер дня и время счёта.

   Номера при склейке пересчитываются по месту в истории. Движок ведёт
   свою нумерацию с R001, и без этого в списке оказались бы два R001 —
   один фикстурный, другой настоящий. Номер — это то, чем расчёты
   различают вслух, и двух одинаковых быть не должно. */

let engineOn = false;

/** Запущен ли движок. Интерфейс этим не управляет — только показывает. */
export const engineReady = () => engineOn;

const codeAt = (index: number) => 'R' + String(index + 1).padStart(3, '0');

/** Ищет движок и подтягивает его архив. Вызывается один раз при старте. */
export async function attachEngine(): Promise<boolean> {
  engineOn = await probeEngine();
  if (!engineOn) return false;

  let archive;
  try {
    archive = await listRuns();
  } catch {
    /* Движок отозвался на проверку, но архив не отдал. Открываемся на
       фикстурах: пустой экран хуже, чем экран без вчерашних расчётов. */
    return false;
  }

  for (const record of archive) {
    const entry: RunEntry = {
      id: record.id,
      code: codeAt(RUNS.length),
      date: record.date,
      created: record.created,
      source: null,
      day: record.day,
      solveSeconds: record.summary.solve_seconds,
      params: record.params,
      note: record.note || undefined
    };
    RUNS.push(entry);
    RUN_BY_ID.set(entry.id, entry);
  }
  /* Правки человека (номер, время, заметка) лежат в браузере и должны
     лечь и на пришедшие записи тоже. */
  for (const run of RUNS) {
    const patch = edits.patch[run.id];
    if (patch) Object.assign(run, patch);
  }
  return true;
}

/** Открытый по умолчанию расчёт — самый свежий из оставшихся.

    Читается как функция, а не как константа: архив движка приезжает после
    того, как модуль разобран, и константа навсегда запомнила бы последнюю
    фикстуру. Ровно на этом интерфейс и открывал предпоследний расчёт
    вместо сегодняшнего. */
export const latestRun = (): RunId => RUNS[RUNS.length - 1].id;

/** Заводит расчёт.

    С живым движком это настоящий счёт: он раскладывает день по инженерам
    с присланными переменными и кладёт результат к себе в архив. Занимает
    около восьми секунд — это работа планировщика, и прятать её не нужно.

    Без движка считать нечем, и запись берёт данные следующего источника
    по кругу. Врать про это не надо: переменные запоминаются и показаны
    рядом с расчётом, а цифры плана честно те же, что у источника. */
export async function createRun(params: EngineParams, day?: number): Promise<RunEntry> {
  const index = RUNS.length;
  const now = new Date();

  if (engineOn) {
    /* День выбирается по кругу из тех же трёх, что показаны в фикстурах:
       так новый расчёт сопоставим с прошлыми, а не сравнивает вчерашний
       день с позавчерашним. */
    const DAYS = [1, 2, 7];
    const record = await createEngineRun(day ?? DAYS[index % DAYS.length], params);
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

  const entry: RunEntry = {
    id: 'run-' + String(index + 1).padStart(2, '0'),
    code: codeAt(index),
    date: iso(now),
    /* Время у заведённого расчёта настоящее: его завели вот сейчас. */
    created: `${iso(now)}T${clock(now.getHours() * 60 + now.getMinutes())}`,
    source: SOURCES[index % SOURCES.length],
    params
  };
  RUNS.push(entry);
  RUN_BY_ID.set(entry.id, entry);
  return entry;
}

/** Правит поля записи, которые заводит человек. Цифры плана не трогает —
    их в `RunPatch` и нет. */
export function updateRun(id: RunId, patch: RunPatch): void {
  const entry = RUN_BY_ID.get(id);
  if (!entry) return;
  Object.assign(entry, patch);
  edits.patch[id] = { ...edits.patch[id], ...patch };
  saveEdits();

  /* Заметка к настоящему расчёту переживает не только перезагрузку, но и
     смену браузера: движок хранит её рядом с планом. Не дошла — не беда,
     копия осталась в браузере, и следующая правка попробует снова. */
  if (entry.source === null && engineAlive() && patch.note !== undefined) {
    noteEngineRun(id, patch.note).catch(() => undefined);
  }
}

/** Убирает запись из истории. Данные источника при этом остаются на месте:
    удаляется запись о расчёте, а не день, по которому его считали. */
export function deleteRun(id: RunId): void {
  const at = RUNS.findIndex((run) => run.id === id);
  if (at === -1) return;
  RUNS.splice(at, 1);
  RUN_BY_ID.delete(id);
  delete edits.patch[id];
  if (!edits.removed.includes(id)) edits.removed.push(id);
  saveEdits();
}

/** Сколько правок держит браузер: столько-то изменённых записей и столько-то
    удалённых. Нужно настройкам — там их и снимают. */
export const runEditCount = () => Object.keys(edits.patch).length + edits.removed.length;

/** Снимает все правки. Историю при этом не восстанавливает: список строится
    при загрузке, поэтому удалённые записи вернутся после обновления страницы. */
export function clearRunEdits(): void {
  edits = { ...EMPTY_EDITS, patch: {}, removed: [] };
  saveEdits();
}

export const runEntry = (id: RunId): RunEntry => RUN_BY_ID.get(id) ?? RUNS[RUNS.length - 1];

export const runCode = (id: RunId) => runEntry(id).code;

export const runDate = (id: RunId) => runEntry(id).date;

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

/** План одного источника отдельно от остальных трёх форм: базам данных нужен
    только он, и тянуть ради них симуляцию с объяснением незачем. */
export const loadPlan = (source: SourceId) => fetchForm<Plan>(source, 'plan');

/** Симуляция отдельно: покрытие живёт там, и разделы поверх прогонов считают
    его тем же числом, что и пульт расчёта. */
export const loadSimulation = (source: SourceId) => fetchForm<Simulation>(source, 'simulation');

export async function loadDay(id: RunId): Promise<Day> {
  const source = runEntry(id).source;

  /* Расчёт движка приходит одним ответом: четыре формы уже лежат у него
     рядом, и четыре запроса вместо одного ничего бы не ускорили. */
  if (source === null) {
    const forms = await loadEngineForms(id);
    for (const kind of ['plan', 'explain', 'simulation', 'shifts'] as const) {
      checkForm(forms[kind], kind);
    }
    return {
      id,
      plan: forms.plan,
      explain: forms.explain,
      simulation: forms.simulation,
      shifts: forms.shifts
    };
  }

  const [plan, explain, simulation, shifts] = await Promise.all([
    fetchForm<Plan>(source, 'plan'),
    fetchForm<Explain>(source, 'explain'),
    fetchForm<Simulation>(source, 'simulation'),
    fetchForm<Shifts>(source, 'shifts')
  ]);
  return { id, plan, explain, simulation, shifts };
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

/** Читает каждый источник один раз и раздаёт по записям истории: файлов три,
    записей пятнадцать, и тянуть один и тот же план пятнадцать раз незачем. */
export async function loadBySource<T>(read: (source: SourceId) => Promise<T>): Promise<Map<SourceId, T>> {
  const pairs = await Promise.all(
    SOURCES.map(async (source) => [source, await read(source)] as const)
  );
  return new Map(pairs);
}

/** План и симуляция для каждой записи истории.

    Здесь сходятся оба источника, и экономия у них разная. Фикстуры
    читаются по одному разу на файл и раздаются по записям: файлов три,
    записей двадцать четыре, и тянуть один и тот же план двадцать четыре
    раза незачем. Расчёт движка — сам себе источник, и читается по разу.

    Всё, что строит сводки и базы данных, ходит сюда: иначе один раздел
    однажды окажется собран по фикстурам, а соседний — по архиву. */
export async function loadRunData(): Promise<Map<RunId, { plan: Plan; simulation: Simulation }>> {
  const needFixtures = RUNS.some((run) => run.source !== null);
  const [plans, simulations] = needFixtures
    ? await Promise.all([loadBySource(loadPlan), loadBySource(loadSimulation)])
    : [new Map<SourceId, Plan>(), new Map<SourceId, Simulation>()];

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

  const out = new Map<RunId, { plan: Plan; simulation: Simulation }>();
  for (const run of RUNS) {
    if (run.source === null) {
      const pair = byRun.get(run.id);
      if (pair) out.set(run.id, pair);
      continue;
    }
    out.set(run.id, {
      plan: plans.get(run.source)!,
      simulation: simulations.get(run.source)!
    });
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
