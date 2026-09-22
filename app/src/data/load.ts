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
import { engineDefaults } from './engine.ts';
import type { EngineParams } from './engine.ts';
import { useDictionaries } from './dictionary.ts';
import { riskThresholds } from './knobs.ts';
import { applyCrew, crewVersion } from './crew.ts';
import { applyShift, hasShiftInput, shiftKey } from './shift.ts';
import type { ShiftInput } from './shift.ts';
import { datasetByKey, datasets } from './datasets.ts';
import type { Dataset } from './datasets.ts';
import { planDay } from './planner.ts';
import { readRoads, roadsCover } from './roads.ts';
import type { Roads } from './roads.ts';
import type { PlannedDay } from './planner.ts';
import {
  createEngineRun,
  engineAlive,
  loadCatalogue,
  loadEngineDay,
  loadEngineForm,
  loadEngineForms,
  listRuns,
  noteEngineRun,
  probeEngine
} from './api.ts';
import type { EngineCatalogue, EngineRun } from './api.ts';
import { изДвижка } from './fromEngine.ts';
import { HumanRefusal } from './errors.ts';

/* Источник данных — это день, который раскладывают. Их два рода, и в
   интерфейсе они неотличимы:

   - **встроенные** — три зоны выгрузки «Билайн Бизнес», лежат файлами рядом
     с сайтом. Названия пришли вместе с данными; ТЗ зон не называет вовсе;
   - **загруженные** — наборы, которые диспетчер принёс файлом. Живут в
     браузере, см. `datasets.ts`.

   Список источников поэтому не константа: набор, загруженный минуту назад,
   обязан встать в тот же ряд, что и встроенные. */
export const BUILT_IN = ['east', 'southeast', 'center'] as const;

/** Источник: ключ встроенной зоны либо ключ загруженного набора. */
export type SourceId = string;

const BUILT_IN_TITLES: Record<string, string> = {
  east: 'Восток',
  southeast: 'Юго-Восток',
  center: 'Центр'
};

/** Все источники: встроенные зоны и загруженные наборы. */
export const sources = (): SourceId[] => [...BUILT_IN, ...datasets().map((one) => one.key)];

/** Как источник называется на экране. */
export const zoneTitle = (zone: SourceId) =>
  BUILT_IN_TITLES[zone] ?? datasetByKey(zone)?.title ?? zone;

/** Встроенный ли это источник. Загруженный можно удалить, встроенный нет. */
export const isBuiltIn = (zone: SourceId) => (BUILT_IN as readonly string[]).includes(zone);

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
  /** День у движка: зона выгрузки либо номер синтетического дня строкой.
      Есть только у расчётов движка. */
  day?: string;
  /** Какие формы у записи есть — со слов движка. Раньше здесь стояла
      догадка «есть поле replan — значит пересчёт», и на записи, которую
      сохранила старая версия движка, догадка давала неверный ответ:
      запись считалась обычным расчётом, её план не отдавался, и карточка
      молча исчезала с экрана. */
  forms?: string[];
  /** Сколько солвер думал над этим планом, секунды. Только у настоящих. */
  solveSeconds?: number;
  /** С какими переменными движка его считали. */
  params: EngineParams;
  /** Вводные смены, с которыми его считали: кто вышел, у кого сняли навык,
      что дописали поверх выгрузки. Хранятся с записью, а не только в форме:
      план пересчитывается при каждом открытии, и без них повторный расчёт
      разошёлся бы с тем, что диспетчер видел утром. */
  shift?: ShiftInput;
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
      (run) => run && typeof run.id === 'string' && (run.source === null || Boolean(run.source))
    );
  } catch {
    /* Испорченная запись — не повод не открыться: начинаем с чистого листа. */
    return [];
  }
}

export const RUNS: RunEntry[] = readStored();

/* Расчёты, посчитанные в браузере, пока движок запущен, не показываются —
   см. `hideLocalRuns`. Из хранилища они при этом не стираются: движок
   погасят — и они вернутся на место. */
const LOCAL_HIDDEN: RunEntry[] = [];

function saveRuns() {
  if (typeof localStorage === 'undefined') return;
  try {
    /* Расчёты движка живут в его архиве и записываются туда им самим —
       дублировать их в браузере незачем. */
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify([...LOCAL_HIDDEN, ...RUNS.filter((run) => run.source !== null)])
    );
  } catch {
    /* Хранилище может быть закрыто настройками браузера. Запись тогда живёт
       до перезагрузки — это хуже, чем ничего не делать, но не ошибка. */
  }
}

const RUN_BY_ID = new Map(RUNS.map((run) => [run.id, run]));

/** Убирает из списка расчёты, посчитанные в браузере. Зовётся, когда движок
    нашёлся.

    Прежде они оставались в одном списке с расчётами движка и открывались
    браузерным планировщиком — базовым вариантом ТЗ — даже при живом
    движке: щелчок по старой записи показывал на защите чужой план под
    видом нашего. С движком план считает движок, и точка. */
export function hideLocalRuns(): void {
  for (let i = RUNS.length - 1; i >= 0; i -= 1) {
    const run = RUNS[i];
    if (run.source === null) continue;
    LOCAL_HIDDEN.unshift(run);
    RUN_BY_ID.delete(run.id);
    RUNS.splice(i, 1);
  }
}

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

/* Следующий номер — за самым большим из существующих, а не «длина истории
   плюс один»: после удаления среднего расчёта длина уменьшается, и новый
   получал бы номер, который уже носит последний в списке. Номер, который
   человек переписал по-своему, в счёт не идёт: он не из этого ряда. */
function nextCode(): string {
  let last = 0;
  for (const run of RUNS) {
    const match = /^R(\d+)$/.exec(run.code);
    if (match) last = Math.max(last, Number(match[1]));
  }
  return 'R' + String(last + 1).padStart(3, '0');
}

/** Ищет движок. Вызывается один раз при старте.

    Здесь стояло «архив движка в историю не подтягивается, и это не
    оплошность» с тремя причинами: движок не принимает реальную выгрузку,
    транспорта как ограничения в его модели нет, день обрывается в 21:00
    при окнах приёма до 22:00.

    Все три закрыты 15 сентября. Движок принимает зоны выгрузки
    (`/api/days` отдаёт `zones`), транспорт стал третьей обязательной
    группой ограничений с предельной дальностью перегона, а граница дня
    стала полем дня и у настоящих данных равна 22:00 — она приходит в
    `plan.meta.hard_end`. Условие снято, архив читается. */
export async function attachEngine(): Promise<boolean> {
  engineOn = await probeEngine();
  return engineOn;
}

/* Имена зон у движка. У вёрстки они свои с самого начала, и это не
   расхождение подписей, а разные наборы данных: `center` — это «Центр» из
   набора дизайнера, `югоцентр` — участок из выгрузки заказчика. Переводим
   в одном месте, чтобы остальной код про это не знал. */
const ENGINE_ZONE: Record<string, string> = {
  east: 'восток',
  southeast: 'юго-восток',
  center: 'югоцентр'
};

/** Как день движка называется на экране: «юго-восток» → «Юго-Восток».
    Синтетический день — «день 7». Нужно заставке прогрева в main.tsx. */
export function engineDayTitle(day: string): string {
  const zone = Object.keys(ENGINE_ZONE).find((key) => ENGINE_ZONE[key] === day);
  if (zone) return zoneTitle(zone);
  return /^\d+$/.test(day) ? `день ${day}` : day;
}

/** Умеет ли движок считать по нашим данным. Да — см. `attachEngine`. */
const engineTakesRealData = () => true;

/** Архив движка. */
export async function engineArchive() {
  return listRuns();
}

/** Дописывает архив движка в историю — то, что описано в комментарии к
    `RUN_BY_ID` выше, но до сих пор нигде не звалось.

    Номера расчётов пересчитываются по месту в истории: движок ведёт свою
    нумерацию с R001, и без этого в списке стояли бы два R001.

    Возвращает, сколько записей прибавилось: звавшему надо знать, надо ли
    заводить первый расчёт самому. */
export async function pullArchive(): Promise<number> {
  if (!engineOn || !engineTakesRealData()) return 0;
  const записи = await engineArchive();
  let добавлено = 0;
  for (const record of записи) {
    if (RUN_BY_ID.has(record.id)) continue;
    adoptEngineRun(record);
    добавлено += 1;
  }
  return добавлено;
}

/** Запись архива движка — в историю, если её там ещё нет. Одна дорога для
    архива, нового расчёта и сохранённого пересчёта: прежде сохранённый
    пересчёт в историю не попадал, и `runEntry` подменял его последней
    записью — открывался чужой расчёт. */
export function adoptEngineRun(record: EngineRun): RunEntry {
  const known = RUN_BY_ID.get(record.id);
  if (known) return known;
  const entry: RunEntry = {
    id: record.id,
    /* Номер движка, а не место в списке: расчёты браузера при живом
       движке спрятаны, и повторов нет, а «R003» на экране обязано быть
       тем же R003, что в архиве движка и в заметке «Правка расчёта R003». */
    code: record.code || nextCode(),
    date: record.date,
    created: record.created,
    note: record.note,
    source: null,
    day: record.day,
    forms: record.forms,
    solveSeconds: record.summary.solve_seconds,
    params: record.params
  };
  RUNS.push(entry);
  RUN_BY_ID.set(entry.id, entry);
  return entry;
}

/** Открытый по умолчанию расчёт — самый свежий из оставшихся.

    Пустая строка, пока история пуста: считать ещё нечего, и диспетчерская
    встречает предложением завести первый расчёт.

    Читается как функция, а не как константа: архив движка приезжает после
    того, как модуль разобран, и константа навсегда запомнила бы то, что
    было до него. */
export const latestRun = (): RunId => {
  /* Сохранённый пересчёт — остаток дня, а не день: открывать с него
     диспетчерскую нельзя. У записей браузера `forms` нет. */
  for (let i = RUNS.length - 1; i >= 0; i -= 1) {
    const forms = RUNS[i].forms;
    if (forms === undefined || forms.includes('simulation')) return RUNS[i].id;
  }
  return '';
};

/** Заводит расчёт по выбранной зоне.

    С живым движком это его счёт: он раскладывает день с присланными
    переменными и кладёт результат к себе в архив.

    Без движка день считается здесь же, в браузере, — базовым вариантом
    ТЗ. План не запоминается: он пересчитывается по зоне и переменным,
    когда понадобится, и всегда выходит тем же самым. */
export async function createRun(
  params: EngineParams,
  zone: SourceId = BUILT_IN[0],
  day?: string,
  shift?: ShiftInput
): Promise<RunEntry> {
  const now = new Date();

  if (engineOn && engineTakesRealData()) {
    /* Зона выгрузки, а не синтетический день. `day ?? 1` здесь оставался
       единственным путём, и он уводил на синтетический день 1 — то есть на
       80 выдуманных заявок вместо 56 настоящих. */
    /* День, если его назвали, важнее зоны: «Ручное управление» у расчёта
       движка зовёт сюда без зоны и с днём, а умолчание зоны — «восток», и
       прежде любой расчёт пересчитывался по востоку. Не назвали ни то, ни
       другое — отказ, а не синтетический день 1. */
    const target = day ?? ENGINE_ZONE[zone];
    if (!target) {
      throw new HumanRefusal(
        `Набор «${zoneTitle(zone)}» программа расчёта не считает`,
        'Выберите участок Восток, Юго-Восток или Центр.'
      );
    }
    return adoptEngineRun(await createEngineRun(target, params));
  }

  const started = performance.now();
  const computed = await computeDay(zone, params, shift);
  const entry: RunEntry = {
    id: `run-${Date.now().toString(36)}`,
    /* Номер выдаётся после счёта, а не до: два расчёта, заведённые подряд,
       иначе получили бы один номер, пока первый ещё считался. */
    code: nextCode(),
    date: computed.plan.meta.date,
    /* Время у заведённого расчёта настоящее: его завели вот сейчас. */
    created: `${iso(now)}T${clock(now.getHours() * 60 + now.getMinutes())}`,
    source: zone,
    solveSeconds: Number(((performance.now() - started) / 1000).toFixed(2)),
    params,
    /* Пустые вводные в запись не пишем: «считали выгрузку как есть» — это
       отсутствие вводных, а не вводные из трёх пустых списков. */
    ...(hasShiftInput(shift) ? { shift } : {})
  };
  RUNS.push(entry);
  RUN_BY_ID.set(entry.id, entry);
  saveRuns();
  return entry;
}

/** Заводит стартовую историю: по расчёту на каждую встроенную зону.

    История живёт в хранилище браузера, а оно своё у каждого адреса: открыл
    стенд на другом порту — и список расчётов пуст, хотя данные те же самые.
    Пустой список при этом не говорит «ничего не считали», он говорит «этот
    браузер здесь впервые», и разбираться в этом диспетчеру незачем — тем
    более что считать нечего: зоны лежат файлами и готовы к расчёту всегда.

    Поэтому первый заход считает их сам, по одной на зону, с переменными
    движка по умолчанию. Дальше история живёт как обычно: расчёты добавляют
    кнопкой, удаляют по одному, и повторно затравка не срабатывает — пустой
    она становится только после того, как всё стёрли руками, а это уже
    осознанное «начать сначала».

    Затравка одна, и зовётся она один раз — из main.tsx, до первой
    отрисовки: адрес читается при первом рендере, и к нему в истории уже
    должны стоять все записи. Прежде вторая копия той же логики жила в
    main.tsx, и две расходились: одна сеяла при движке, другая нет.

    Возвращает, завела ли что-нибудь. */
export async function seedRuns(): Promise<boolean> {
  if (engineOn && engineTakesRealData()) {
    /* С живым движком история приходит из его архива, а не считается
       заново: считать поверх его расчётов свои значило бы выдать
       посчитанное здесь за посчитанное им. Браузерные записи при нём
       прячем — см. `hideLocalRuns`.

       Архив подтягивается всегда, а не только на пустом списке: иначе
       браузер, в котором уже были свои расчёты, архива движка не видел бы. */
    hideLocalRuns();
    /* Архив не прочитался — не сеем: иначе каждый сбой `GET /runs`
       дописывал бы в архив движка ещё три расчёта. Сеем, только если он
       прочитан и пуст. */
    const прочитан = await pullArchive().then(() => true, () => false);
    if (!прочитан || RUNS.length > 0) return false;
  } else if (RUNS.length > 0) {
    return false;
  }

  for (const zone of BUILT_IN) {
    try {
      await createRun(engineDefaults(), zone);
    } catch {
      /* Зона может не прочитаться — файла нет, сеть отвалилась. Остальные
         от этого не страдают: две зоны из трёх лучше, чем пустой список. */
    }
  }
  return RUNS.length > 0;
}

/* ─── правки записей ─────────────────────────────────────────────────────

   Номер, время создания и заметку у расчёта заводит человек. Чтобы «снять
   все правки» значило то, что написано, надо помнить, каким поле было до
   первой правки: без этого снимать нечего — правка уже стала записью.

   Поэтому при первой правке поля его прежнее значение уходит в слепок, и
   он же хранится рядом с историей. Снятие возвращает записи из слепка и
   слепок стирает. Второй и следующие разы поле в слепок уже не кладутся:
   вернуться надо к исходному, а не к предпоследнему. */

const BASE_KEY = 'polet.runs.base.v1';

type RunBase = Record<RunId, RunPatch>;

function readBase(): RunBase {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(BASE_KEY);
    const parsed = raw ? (JSON.parse(raw) as RunBase) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const RUN_BASE: RunBase = readBase();

function saveBase() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BASE_KEY, JSON.stringify(RUN_BASE));
  } catch {
    /* Та же причина, что и у истории: закрытое хранилище не ошибка. */
  }
}

/** Правит поля записи, которые заводит человек. Цифры плана не трогает —
    их в `RunPatch` и нет. */
export function updateRun(id: RunId, patch: RunPatch): void {
  const entry = RUN_BY_ID.get(id);
  if (!entry) return;
  /* Расчёт движка живёт в его архиве, и номер с датой там свои: правка здесь
     прожила бы до перезагрузки, а потом архив вернул бы прежние — и «R003»
     на экране перестал бы совпадать с R003 в заметке «Правка расчёта R003».
     У такой записи правится только заметка: её движок хранит сам. */
  if (entry.source === null) patch = patch.note === undefined ? {} : { note: patch.note };

  const before = RUN_BASE[id] ?? {};
  let snapped = false;
  for (const field of Object.keys(patch) as (keyof RunPatch)[]) {
    if (patch[field] === entry[field]) continue;
    if (field in before) continue;
    (before as Record<string, unknown>)[field] = entry[field];
    snapped = true;
  }
  if (snapped) {
    RUN_BASE[id] = before;
    saveBase();
  }

  Object.assign(entry, patch);
  saveRuns();

  /* Заметка к расчёту движка переживает не только перезагрузку, но и смену
     браузера: движок хранит её рядом с планом. */
  if (entry.source === null && engineAlive() && patch.note !== undefined) {
    noteEngineRun(id, patch.note).catch(() => undefined);
  }
}

/** Убирает запись из истории. Данные зоны при этом остаются на месте:
    удаляется расчёт, а не день, по которому его считали.

    Возвращает, удалила ли. Расчёт движка не удаляется: он в его архиве, и
    ручки удаления у движка нет — убранная отсюда запись вернулась бы при
    следующей загрузке, а до того на неё ещё ссылались бы сохранённые
    пересчёты и сравнения. */
export function deleteRun(id: RunId): boolean {
  const at = RUNS.findIndex((run) => run.id === id);
  if (at === -1) return false;
  if (RUNS[at].source === null) return false;
  RUNS.splice(at, 1);
  RUN_BY_ID.delete(id);
  delete RUN_BASE[id];
  saveBase();
  saveRuns();
  return true;
}

/** Сколько записей правил человек. Именно записей, а не полей: диспетчер
    считает правки записями — «трогал три расчёта», — и снимаются они тоже
    записями, все разом. */
export const runEditCount = () =>
  Object.keys(RUN_BASE).filter((id) => RUN_BY_ID.has(id)).length;

/** Возвращает правленые записи к исходным значениям. Историю не трогает:
    расчёты остаются на месте, у них откатываются номер, время и заметка. */
export function clearRunEdits(): void {
  for (const [id, before] of Object.entries(RUN_BASE)) {
    const entry = RUN_BY_ID.get(id);
    if (entry) Object.assign(entry, before);
    delete RUN_BASE[id];
  }
  saveBase();
  saveRuns();
}

/** Сколько расчётов держит браузер. Нужно настройкам: стереть историю —
    отдельное действие, и цена у него своя. */
export const runCount = () => RUNS.filter((run) => run.source !== null).length;

/** Стирает всю историю расчётов. Данные зон не трогает: они лежат файлами
    и к истории отношения не имеют.

    Зовётся из одного места — из настроек, после подтверждения. Всё, что
    показывает открытый расчёт, после этого ссылается в пустоту, поэтому
    звавший обязан увести экран туда, где расчёт не нужен. */
export function clearHistory(): void {
  RUNS.length = 0;
  LOCAL_HIDDEN.length = 0;
  RUN_BY_ID.clear();
  for (const id of Object.keys(RUN_BASE)) delete RUN_BASE[id];
  saveBase();
  saveRuns();
}

/** Запись расчёта по номеру.

    Неизвестный номер отдаёт последнюю запись — ссылка на удалённый расчёт
    открывает свежий, а не пустой экран. Пустая история не отдаёт ничего, и
    это не исключительный случай, а первое утро: звавший обязан проверить.
    Раньше здесь стоял тип без пустоты, и два места в оболочке читали у неё
    поля напрямую — стёртая история роняла экран в белое. */
export const runEntry = (id: RunId): RunEntry | undefined =>
  RUN_BY_ID.get(id) ?? RUNS[RUNS.length - 1];

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

/** День без времени: «2026-09-16T20:01» и «2026-09-16» дают одно и то же.
    Нужен потому, что дату расчёта пишут в двух видах — у дня она без часов,
    у записи в истории с часами, — а сравнивают их наравне. */
export const dayOf = (iso: string) => iso.split('T')[0] ?? iso;

/** Сколько дней назад была эта дата. */
export function daysAgo(iso: string): number {
  const then = new Date(dayOf(iso) + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - then.getTime()) / 86_400_000);
}

/** Расчёты приходят с датой, а диспетчер помнит их «вчерашним» и «недельной
    давности» — переводим на этот язык.

    Считается это по дню, когда расчёт завели, а не по дню, который в нём
    разложен. Дни разные: выгрузка «Билайн Бизнес» собрана за 17 августа, и
    расчёт по ней, посчитанный сегодня, подписывался «30 дн. назад» — тогда
    как в базе расчётов рядом стояла сегодняшняя дата. Диспетчер ищет здесь
    свою работу — «что я считал вчера», — а какой день разложен, сказано в
    самом расчёте. */
export function whenLabel(iso: string): string {
  const days = daysAgo(iso);
  if (days <= 0) return 'Сегодня';
  if (days === 1) return 'Вчера';
  if (days === 2) return 'Позавчера';
  return `${days} дн. назад`;
}

const endpoint = (source: string, kind: string) => `/data/${source}/${kind}.json`;

/* Предельный срок на чтение файла. Без него зависший обмен — сеть
   отвалилась посреди ответа — держал бы «загружаем» до закрытия вкладки.
   Файлы лежат рядом с сайтом, и самый тяжёлый из них, дороги зоны на
   полтора мегабайта, читается за секунды; пятнадцать — с запасом на
   плохую сеть. */
const FETCH_TIMEOUT = 15_000;

const timeLimit = () => AbortSignal.timeout(FETCH_TIMEOUT);

/** Истёк ли срок, а не упала сеть: разные слова в ошибке. */
const timedOut = (error: unknown) => (error as { name?: string })?.name === 'TimeoutError';

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
    response = await fetch(url, { signal: timeLimit() });
  } catch (error) {
    throw new ContractError(
      kind,
      timedOut(error) ? `Сервер не ответил за ${FETCH_TIMEOUT / 1000} с` : 'Сервер не ответил'
    );
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
  /** Дороги зоны для карты и длины перегонов. `null` у набора, который
      принесли со стороны: его адресов нет в нашем графе. */
  roads: Roads | null;
}

/* Дороги лежат рядом с заявками отдельным файлом и грузятся вместе с ними.
   Файл тяжелее прочих — в нём ломаная на каждую пару адресов зоны, — но
   читается один раз за сеанс и переиспользуется всеми расчётами по этой
   зоне. Его отсутствие не ошибка: расчёт вернётся к прямым линиям, а
   интерфейс откроется как ни в чём не бывало.

   Два исхода здесь разные. Файла нет или он не разобрался — это свойство
   зоны, и ответ `null` можно запомнить. Сеть не ответила — это свойство
   минуты, и такой обмен отсюда выходит отказом: звавший снимет его с кеша,
   и следующий заход сходит в сеть заново. */
async function fetchRoads(zone: SourceId): Promise<Roads | null> {
  const response = await fetch(`/data/${zone}/roads.json`, { signal: timeLimit() });
  if (!response.ok) {
    /* Молча возвращаться к прямым нельзя: на экране это выглядит не как
       «файла нет», а как «программа врёт про маршруты», и искать причину
       приходится по всему коду. Сама карта скажет о том же словом, а здесь
       остаётся след для того, кто полезет в консоль. */
    console.warn(
      `[polet] дороги зоны «${zone}» не отдались (${response.status}) — карта нарисует перегоны прямыми`
    );
    return null;
  }
  const roads = readRoads(await response.json());
  if (!roads) {
    console.warn(`[polet] дороги зоны «${zone}» не разобрались — карта нарисует перегоны прямыми`);
  }
  return roads;
}

/* Дороги одной зоны читаются один раз за сеанс: файл на полтора мегабайта, и
   перечитывать его ради каждого загруженного набора незачем. */
const roadsCache = new Map<SourceId, Promise<Roads | null>>();

const zoneRoads = (zone: SourceId): Promise<Roads | null> => {
  const ready = roadsCache.get(zone);
  if (ready) return ready;
  /* Отказ сети из кеша убираем — тем же приёмом, что у планов: иначе одна
     потерянная секунда навсегда оставляла бы зону без дорог, и каждый
     следующий заход получал бы тот же отклонённый обмен, не сходив в сеть. */
  const reading = fetchRoads(zone).catch((error: unknown) => {
    console.warn(`[polet] дороги зоны «${zone}» не прочитались:`, error);
    roadsCache.delete(zone);
    return null;
  });
  roadsCache.set(zone, reading);
  return reading;
};

/* Дороги для набора, загруженного диспетчером.

   Своего файла дорог у такого набора нет — его собирает `dataset/roads.py`
   рядом с зоной, — и до сих пор карта рисовала по нему одни отрезки. Но чаще
   всего диспетчер подкладывает ту же выгрузку, что лежит и встроенной зоной:
   те же дома, те же координаты до шестого знака. Тогда готовые ломаные
   подходят как есть, и незачем показывать прямые из-за того, что набор пришёл
   другим путём.

   Поэтому ищем зону, чьи дороги накрывают набор, и берём её. Порог — половина
   точек: набор бывает частью зоны (подложили один участок), и терять из-за
   этого дороги жалко; а совпадение ниже половины — случайное, пара домов на
   границе, и рисовать по чужим улицам хуже, чем по прямой. */
async function borrowRoads(set: Dataset): Promise<Roads | null> {
  const points: [number, number][] = [
    ...set.orders.map((order) => [order.lat, order.lon] as [number, number]),
    ...set.engineers.map((one) => [one.home_lat, one.home_lon] as [number, number])
  ].filter((point) => Number.isFinite(point[0]) && Number.isFinite(point[1]));

  if (points.length === 0) return null;

  let best: Roads | null = null;
  let bestShare = 0;
  for (const zone of BUILT_IN) {
    const roads = await zoneRoads(zone);
    if (!roads) continue;
    const share = roadsCover(roads, points) / points.length;
    if (share > bestShare) {
      bestShare = share;
      best = roads;
    }
  }

  if (bestShare < 0.5) {
    console.warn(
      `[polet] для набора «${set.title}» готовых дорог не нашлось (совпало ${Math.round(bestShare * 100)} % точек) — карта нарисует перегоны прямыми`
    );
    return null;
  }
  return best;
}

const zoneCache = new Map<SourceId, Promise<ZoneData>>();
let zoneVersion = crewVersion();

/** Заявки и инженеры зоны. Читается один раз за сеанс. */
export function loadZone(zone: SourceId): Promise<ZoneData> {
  /* Кеш зоны живёт до правки штата: поправленный транспорт обязан дойти и
     до справочника, и до плана, не дожидаясь перезагрузки. */
  if (zoneVersion !== crewVersion()) {
    zoneCache.clear();
    planCache.clear();
    zoneVersion = crewVersion();
  }
  const cached = zoneCache.get(zone);
  if (cached) return cached;

  const reading = (async (): Promise<ZoneData> => {
    /* Загруженный набор уже разобран и лежит в браузере — ходить за ним
       некуда. */
    const stored = datasetByKey(zone);
    if (stored) {
      return {
        zone,
        date: stored.date,
        title: stored.title,
        orders: stored.orders,
        engineers: applyCrew(stored.engineers),
        roads: await borrowRoads(stored)
      };
    }

    const [orders, engineers, roads] = await Promise.all([
      fetchForm<OrdersForm>(zone, 'orders'),
      fetchForm<EngineersForm>(zone, 'engineers'),
      zoneRoads(zone)
    ]);
    return {
      zone,
      date: orders.meta.date,
      title: orders.meta.zone || zoneTitle(zone),
      orders: orders.orders,
      engineers: applyCrew(engineers.engineers),
      roads
    };
  })();

  zoneCache.set(zone, reading);
  /* Отказ из кеша убираем: файл не отдался один раз — не значит, что зона
     закрыта до перезагрузки страницы. */
  reading.catch(() => zoneCache.delete(zone));
  return reading;
}

/** Весь штат компании — записи инженеров из всех зон, как они есть в файлах.

    Нужен базам данных. База — это справочник хозяйства, а не отчёт по
    расчётам: человек числится в штате независимо от того, посчитали сегодня
    его зону или нет. Собранная по одним расчётам, база показывала двенадцать
    человек там, где их тридцать четыре, — и молча меняла размер штата от
    того, что диспетчер завёл ещё один расчёт.

    Записи не сводятся здесь, и это намеренно: инженер, который работает в
    двух зонах, — один человек, но приписан он к двум участкам и выезжает из
    двух разных офисов. Сведи его тут — и одна из точек выезда потеряется.
    Сводит их справочник, и он же складывает то, что у человека одно, с тем,
    что у него своё на каждом участке. */
export async function loadRoster(): Promise<Engineer[]> {
  const zones = await Promise.all(sources().map((zone) => loadZone(zone).catch(() => null)));
  return zones.flatMap((data) => data?.engineers ?? []);
}

/** Участок так, как он есть в данных: название, офис и рамки рабочего дня.

    Рамки считаются по окнам приёма самого участка — от первого открывшегося
    до последнего закрывшегося. Это и есть его временные ограничения: за ними
    заявок нет, и смена за них выходить не должна.

    Офис берётся у первого же инженера участка: он один на всех — из него они
    и выезжают. */
export interface Place {
  zone: string;
  home: string | null;
  from: number;
  to: number;
}

export async function loadPlaces(): Promise<Place[]> {
  const zones = await Promise.all(sources().map((zone) => loadZone(zone).catch(() => null)));
  const byTitle = new Map<string, Place>();

  for (const data of zones) {
    if (!data || data.orders.length === 0) continue;
    const title = data.engineers[0]?.zone ?? data.title;
    const from = Math.min(...data.orders.map((order) => order.window_start));
    const to = Math.max(...data.orders.map((order) => order.window_end));
    const known = byTitle.get(title);
    byTitle.set(title, {
      zone: title,
      home: data.engineers[0]?.home_address ?? known?.home ?? null,
      from: known ? Math.min(known.from, from) : from,
      to: known ? Math.max(known.to, to) : to
    });
  }

  return [...byTitle.values()].sort((a, b) => a.zone.localeCompare(b.zone));
}

/** Все заявки всех источников. Нужны справочнику услуг: услуга числится в
    каталоге независимо от того, посчитали её сегодня или нет. */
export async function loadAllOrders(): Promise<Order[]> {
  const zones = await Promise.all(sources().map((zone) => loadZone(zone).catch(() => null)));
  return zones.flatMap((data) => data?.orders ?? []);
}

let dictionaries: Promise<Dictionaries | null> | null = null;

/* Файла нет — это ответ, и он запоминается. Сеть не ответила — отказ, и он
   уходит наружу, чтобы кеш его не запомнил. */
async function fetchDictionaries(): Promise<Dictionaries | null> {
  const response = await fetch('/data/dictionaries.json', { signal: timeLimit() });
  if (!response.ok) return null;
  const body = (await response.json()) as Dictionaries;
  return body.kind === 'dictionaries' ? body : null;
}

/** Подписи ко всем кодам. Формы может не быть — тогда работаем на встроенном
    словаре, и ни один экран от этого не ломается.

    Прочитанная форма тут же становится верхним слоем словаря: до сих пор
    файл качался, клался в запись дня и на этом всё кончалось — подписи на
    экранах оставались встроенными, и восемнадцать типов работ из выгрузки
    справочник не видел.

    С живым движком поверх файла ложится его справочник: русские названия
    навыков и видов работ он знает лучше. Файл остаётся снизу, а не
    уходит: подписи технологий (FMC, FTTB, GPON) есть только в нём. */
/* Справочники движка в форму словарей контракта.

   Слой подписей у интерфейса и так двухэтажный — встроенный снизу,
   пришедший с данными сверху, — и движку в нём место сверху: он знает
   про справочники больше нас. Русские названия навыков лежали у него в
   коде и наружу не отдавались ни одной ручкой; мы показывали голые
   `install` и `emergency`, а список видов работ собирали по тому, что
   случилось в открытом дне, отчего фильтр на разных зонах выходил
   разным. */
function словариИзСправочника(справочник: EngineCatalogue): Dictionaries {
  const свести = <T extends { code: string; title: string }>(список: T[]) =>
    Object.fromEntries(список.map((one) => [one.code, one.title]));
  return {
    schema: справочник.schema,
    kind: 'dictionaries',
    skills: свести(справочник.skills),
    work_types: свести(справочник.work_types),
    transports: свести(справочник.transport),
    equipment: свести(справочник.equipment ?? [])
  };
}

/** Верхний словарь поверх нижнего — по каждому разделу подписей. */
function поверх(низ: Dictionaries | null, верх: Dictionaries | null): Dictionaries | null {
  if (!низ) return верх;
  if (!верх) return низ;
  const итог: Record<string, unknown> = { ...низ };
  for (const [ключ, значение] of Object.entries(верх)) {
    const было = итог[ключ];
    итог[ключ] =
      значение && typeof значение === 'object' && было && typeof было === 'object'
        ? { ...(было as object), ...(значение as object) }
        : значение;
  }
  return итог as unknown as Dictionaries;
}

export function loadDictionaries(): Promise<Dictionaries | null> {
  if (!dictionaries) {
    dictionaries = Promise.all([
      fetchDictionaries(),
      /* Справочник движка не отозвался — остаёмся на файле. */
      engineOn ? loadCatalogue().then(словариИзСправочника).catch(() => null) : null
    ])
      .then(([файл, движок]) => {
        const body = поверх(файл, движок);
        useDictionaries(body);
        return body;
      })
      .catch(() => {
        /* Отказ сети — не «формы нет»: снимаем с кеша, следующий заход
           попробует снова, а до тех пор работаем на встроенном словаре. */
        dictionaries = null;
        return null;
      });
  }
  return dictionaries;
}

/* Один и тот же день с одними и теми же переменными считается один раз:
   история, базы данных и сводки спрашивают план по многу раз, а расчёт от
   этого не меняется. */
const planCache = new Map<string, Promise<PlannedDay>>();

/* Пороги риска входят в ключ: раскладку они не меняют, но подпись у визита
   — да, и план, посчитанный при прежних порогах, показывал бы прежние. */
const planKey = (zone: SourceId, params: EngineParams, shift?: ShiftInput) => {
  const risk = riskThresholds();
  return (
    `${zone}|${crewVersion()}|${params.duration_factor}|${params.buffer_base}|` +
    `${params.buffer_step}|${params.balance_weight}|${risk.high}/${risk.medium}|${shiftKey(shift)}`
  );
};

/** Считает день по данным зоны с вводными смены.

    Вводные входят в ключ кеша: день без снятого инженера и день с ним — это
    два разных плана, и отдавать второй вместо первого нельзя. */
export function computeDay(
  zone: SourceId,
  params: EngineParams,
  shift?: ShiftInput
): Promise<PlannedDay> {
  const key = planKey(zone, params, shift);
  const cached = planCache.get(key);
  if (cached) return cached;

  const computing = (async () => {
    /* Справочник — до счёта: планировщик пишет объяснения словами
       справочника, а план запоминается, и объяснение, собранное до прихода
       подписей, осталось бы на встроенных словах до перезагрузки. */
    const [data] = await Promise.all([loadZone(zone), loadDictionaries()]);
    const day = applyShift(data, shift);
    return planDay(day.orders, day.engineers, params, day.date, day.roads);
  })();

  planCache.set(key, computing);
  /* Отказ из кеша убираем: одна потерянная секунда сети иначе навсегда
     закрывала бы расчёт по этой зоне — каждый следующий заход получал бы
     тот же отклонённый обмен, не сходив в сеть ни разу. */
  computing.catch(() => planCache.delete(key));
  return computing;
}

export async function loadDay(id: RunId): Promise<Day> {
  const entry = runEntry(id);
  if (!entry) throw new ContractError('plan', 'расчёт не найден');

  /* Расчёт движка приходит одним ответом: четыре формы уже лежат у него
     рядом, и четыре запроса вместо одного ничего бы не ускорили. */
  if (entry.source === null) {
    const forms = await loadEngineForms(id);
    /* Сохранённый пересчёт: план остатка дня (`kind: "replan"`), а три
       остальные формы — дня, от которого он отпочковался, как у черновика
       правки. Панели объяснения это знают: чужое объяснение они не
       показывают, если исполнитель в пересчёте другой. */
    if ((forms.plan.kind as string) === 'replan' || !forms.explain) {
      const plan = { ...forms.plan, kind: 'plan' } as Plan;
      checkForm(plan, 'plan');
      const whole = await loadEngineDay(entry.day ?? forms.run.day);
      checkForm(whole.explain!, 'explain');
      checkForm(whole.simulation!, 'simulation');
      checkForm(whole.shifts!, 'shifts');
      return {
        id,
        plan: изДвижка(plan),
        explain: whole.explain!,
        simulation: whole.simulation!,
        shifts: whole.shifts!,
        dictionaries: await loadDictionaries()
      };
    }
    for (const kind of ['plan', 'explain', 'simulation', 'shifts'] as const) {
      checkForm(forms[kind]!, kind);
    }
    return {
      id,
      /* На языке вёрстки: иначе у планов движка пустели километры,
         сравнение с базовым, транспорт и закрепления — см. `fromEngine.ts`. */
      plan: изДвижка(forms.plan),
      explain: forms.explain!,
      simulation: forms.simulation!,
      shifts: forms.shifts!,
      dictionaries: await loadDictionaries()
    };
  }

  const [computed, dict] = await Promise.all([
    computeDay(entry.source, entry.params, entry.shift),
    loadDictionaries()
  ]);
  return { id, ...computed, dictionaries: dict };
}

export interface DaySummary {
  id: RunId;
  code: string;
  /** День, который разложен в расчёте: дата выгрузки, а не работы диспетчера. */
  date: string;
  /** Когда расчёт завели. По нему подписывают «сегодня» и «вчера» и отбирают
      по периодам: в списках ищут свою работу, а не день выгрузки. */
  created: string;
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
  /* Сохранённые пересчёты в список не идут: у них нет ни симуляции, ни
     покрытия — это план остатка дня, а не план дня. Раньше мы просили у них
     `simulation`, получали 400, и `Promise.all` ронял весь список: одна
     запись, которой не может быть формы, оставляла диспетчерскую на
     «Собираем расчёты…».

     Спрашиваем у движка полем `forms`, а не угадываем. Угадывать здесь
     пробовали дважды, и оба раза мимо: по `kind` — это подпись человека
     («срочные заявки в 13:40»), она стоит и у обычных расчётов; по
     наличию `replan` — а у записи, сохранённой старой версией движка,
     пометка есть, а замысла нет, и она молча пропадала из списка.

     Записи без поля (архив старее движка) считаем полными, как было. */
  const умеет = (run: RunEntry, форма: string) =>
    run.forms === undefined || run.forms.includes(форма);
  const remote = RUNS.filter((run) => run.source === null
                                      && умеет(run, 'plan')
                                      && умеет(run, 'simulation'));
  const fetched = await Promise.all(
    remote.map(async (run) => {
      try {
        const [plan, simulation] = await Promise.all([
          loadEngineForm<Plan>(run.id, 'plan'),
          loadEngineForm<Simulation>(run.id, 'simulation')
        ]);
        checkForm(plan, 'plan');
        checkForm(simulation, 'simulation');
        return [run.id, { plan: изДвижка(plan), simulation }] as const;
      } catch (error) {
        /* Один расчёт не прочитался — остальные от этого не страдают.
           Молчать нельзя: в списке он просто не появится, и без следа в
           консоли это выглядит как «расчёт пропал», а не «форма не
           отдалась». */
        console.warn(`[polet] расчёт ${run.code} не прочитался у движка:`, error);
        return null;
      }
    })
  );
  const byRun = new Map(fetched.filter((pair): pair is NonNullable<typeof pair> => pair !== null));

  const own = RUNS.filter((run) => run.source !== null);
  const computed = await Promise.all(
    own.map(async (run) => {
      /* То же и для своих: набор, который удалили из загруженных, или зона,
         чей файл не прочитался, не должны гасить весь список. */
      try {
        const day = await computeDay(run.source!, run.params, run.shift);
        return [run.id, { plan: day.plan, simulation: day.simulation }] as const;
      } catch (error) {
        console.warn(`[polet] расчёт ${run.code} не посчитался:`, error);
        return null;
      }
    })
  );
  for (const pair of computed) if (pair) byRun.set(pair[0], pair[1]);

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
      created: run.created,
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
