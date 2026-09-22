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
  /** Номер дня, по которому считали: 1…30. */
  day: number;
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
  explain: Explain;
  simulation: Simulation;
  shifts: Shifts;
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

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

async function call<T>(path: string, init?: RequestInit, timeout = CALL_TIMEOUT): Promise<T> {
  if (!base) throw new EngineError('Движок не запущен');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeout) });
  } catch (error) {
    /* Истёкший срок и упавшая сеть — разные ответы: первый значит, что
       движок есть, но занят или завис, и «проверьте, что запущен» здесь
       посылает искать не там. */
    if ((error as { name?: string })?.name === 'TimeoutError') {
      throw new EngineError(`Движок не ответил за ${Math.round(timeout / 1000)} с`);
    }
    throw new EngineError('Движок не отвечает — проверьте, что он запущен');
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new EngineError(`Движок ответил не JSON (${response.status})`);
  }
  if (!response.ok) {
    const said = (body as { error?: string }).error;
    throw new EngineError(said ?? `Движок ответил ${response.status}`);
  }
  return body as T;
}

/** История расчётов движка, старые первыми. */
export const listRuns = () =>
  call<{ runs: EngineRun[] }>('/runs').then((body) => body.runs);

/** Заводит расчёт: движок считает день с этими переменными и кладёт
    результат к себе в архив. Занимает около восьми секунд — это работа
    планировщика, а не задержка сети. */
export const createEngineRun = (day: number, params: EngineParams, note = '') =>
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
export const loadEngineForms = (id: string) =>
  call<EngineForms>(`/runs/${encodeURIComponent(id)}`);

/** Одна форма. Базам данных нужен только план, и тянуть ради них
    объяснение на полтораста килобайт незачем. */
export const loadEngineForm = <T>(id: string, kind: string) =>
  call<T>(`/runs/${encodeURIComponent(id)}/${kind}`);

/** Заметка человека к расчёту. Движок её не читает — хранит и отдаёт. */
export const noteEngineRun = (id: string, note: string) =>
  call<EngineRun>(`/runs/${encodeURIComponent(id)}/note`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ note })
  });

/** Какие дни движок умеет считать и какие уже посчитаны. */
export const listDays = () =>
  call<{ ready: number[]; available: number[] }>('/days');

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
  /** Номер дня у движка. */
  day: number;
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
  incident?: ReplanIncident;
  /** 1.2: пусто — движок ещё на 1.1, событие выводится из заполненных полей. */
  event?: ReplanEvent | null;
}

export type ReplanResult = Plan & { meta: Plan['meta'] & { replan: ReplanMeta } };

/** Собирает строку запроса из события так, как её ждёт движок. Табельные
    номера приходят из данных и экранируются: номер с пробелом или знаком
    «&» иначе разрезал бы запрос на два. */
function incidentQuery(spec: IncidentSpec): string {
  const parts = [`day=${spec.day}`, `at=${spec.at}`];
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
  return parts.join('&');
}

/** Пересчитывает остаток дня. Занимает около полутора секунд — это работа
    планировщика, и прятать её не нужно. */
export const replanDay = (spec: IncidentSpec) =>
  call<ReplanResult>(`/replan?${incidentQuery(spec)}`, undefined, SOLVE_TIMEOUT);

/** Кладёт результат пересчёта в архив. Движок не считает заново: результат
    у него уже есть, он только сохраняет его отдельной записью. */
export const saveReplan = (spec: IncidentSpec, source: string, note = '') =>
  call<EngineRun>('/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source,
      note,
      replan: {
        day: spec.day,
        at: spec.at,
        urgent: spec.kind === 'urgent' ? spec.urgent ?? 2 : 0,
        urgent_near: spec.kind === 'urgent' ? spec.urgentNear : undefined,
        disabled: spec.kind === 'disabled' ? spec.engineerId : undefined,
        delayed:
          spec.kind === 'delayed' ? `${spec.engineerId}:${spec.minutes ?? 40}` : undefined
      }
    })
  });

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
  day?: number;
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
