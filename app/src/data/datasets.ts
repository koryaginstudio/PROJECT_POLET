/* Наборы данных, загруженные диспетчером.

   ТЗ требует этого прямо: решение должно загружать готовые тестовые данные из
   CSV или JSON либо работать на встроенном наборе. Встроенных у нас три —
   зоны выгрузки «Билайн Бизнес», — и они лежат файлами рядом с сайтом. Всё,
   что приносят сверх них, живёт здесь.

   Загруженный набор ничем не отличается от встроенного: он так же становится
   источником для расчёта и так же попадает во все базы данных. Разница одна —
   встроенный читается с диска, загруженный из браузера.

   Хранилище — браузер. Сервера у нас нет, а набор нужен и завтра: диспетчер,
   которому пришлось бы заново подкладывать файл после каждой перезагрузки,
   перестал бы им пользоваться на второй день.

   Формы читаем те же, что отдаёт сборка набора, — контракт 1.2 «orders» и
   «engineers». Это не прихоть: заявке нужны координаты, длительность и навык,
   а инженеру смена, навыки и транспорт, и взять их из сырой выгрузки нарядов
   нельзя — там нет ни того, ни другого. Выгрузку в набор превращает
   `dataset/build.py`, и он же ходит в геокодер за координатами. */

import { SCHEMA, schemaAccepted } from './contract.ts';
import { HumanRefusal } from './errors.ts';
import type { Engineer, Order } from './contract.ts';

export interface Dataset {
  /** Ключ источника. Свой у каждого набора и в адресе расчёта. */
  key: string;
  /** Как набор называют на экране. */
  title: string;
  /** День, на который собран набор. */
  date: string;
  /** Когда его загрузили, ISO. */
  added: string;
  orders: Order[];
  engineers: Engineer[];
}

const STORE_KEY = 'polet.datasets.v1';

function read(): Dataset[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Dataset[];
    return Array.isArray(parsed) ? parsed.filter((one) => one && one.key && one.orders) : [];
  } catch {
    return [];
  }
}

let loaded: Dataset[] = read();

/** Все загруженные наборы, от старого к свежему. */
export const datasets = () => loaded;

export const datasetByKey = (key: string) => loaded.find((one) => one.key === key);

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(loaded));
  } catch {
    /* Хранилище браузера кончилось. Набор остаётся в памяти до перезагрузки —
       это хуже, чем сохранить, но лучше, чем потерять прямо сейчас. */
    throw new HumanRefusal(
      'Хранилище браузера переполнено',
      'Набор будет работать до перезагрузки страницы. Удалите ненужные наборы в настройках.'
    );
  }
}

export function removeDataset(key: string): void {
  loaded = loaded.filter((one) => one.key !== key);
  persist();
}

/* ─── разбор файлов ──────────────────────────────────────────────────────

   Набор — это две формы, и приносят их по-разному: то двумя файлами рядом,
   то одним, где обе лежат вместе. Принимаем оба способа и не заставляем
   человека помнить, который из них правильный. */

interface AnyForm {
  schema?: string;
  kind?: string;
  meta?: { date?: string; zone?: string };
  orders?: unknown;
  engineers?: unknown;
}

export interface ReadResult {
  orders: Order[];
  engineers: Engineer[];
  date: string;
  title: string;
  /** Что не так с тем, что принесли. Пусто — набор годен. */
  problems: string[];
}

/* Проверка записи возвращает не «да/нет», а название первого поля, которое
   не так, — или пусто, если запись годна. Раньше проверялось меньше, и
   заявка без крайнего срока проходила: планировщик считал её переносимой
   на «NaN», а экран писал «NaN:NaN». Проверяется всё, без чего запись не
   разложить и не показать: число обязано быть конечным — `NaN` и `Infinity`
   в JSON не бывает, но `null` на месте числа бывает сплошь и рядом. */

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

function orderFault(value: unknown): string | null {
  const one = value as Partial<Order> | null;
  if (!one || typeof one !== 'object') return 'запись не объект';
  if (!text(one.id)) return 'нет номера (id)';
  if (!text(one.skill)) return 'нет навыка (skill)';
  if (!text(one.district)) return 'нет района (district)';
  if (!finite(one.lat) || !finite(one.lon)) return 'нет координат (lat, lon)';
  if (!finite(one.window_start) || !finite(one.window_end)) {
    return 'нет окна приёма (window_start, window_end)';
  }
  if (!finite(one.sla_deadline)) return 'нет крайнего срока (sla_deadline)';
  if (!finite(one.priority)) return 'нет приоритета (priority)';
  if (!finite(one.est_minutes)) return 'нет длительности работ (est_minutes)';
  return null;
}

function engineerFault(value: unknown): string | null {
  const one = value as Partial<Engineer> | null;
  if (!one || typeof one !== 'object') return 'запись не объект';
  if (!text(one.id)) return 'нет табельного номера (id)';
  if (!text(one.name)) return 'нет имени (name)';
  if (!Array.isArray(one.skills)) return 'нет навыков (skills)';
  if (!finite(one.shift_start) || !finite(one.shift_end)) {
    return 'нет смены (shift_start, shift_end)';
  }
  if (!finite(one.home_lat) || !finite(one.home_lon)) {
    return 'нет координат точки выезда (home_lat, home_lon)';
  }
  return null;
}

/** Как назвать запись в сообщении: по номеру, если он есть, иначе по месту. */
const recordName = (value: unknown, index: number, what: string) => {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'string' && id ? `${what} ${id}` : `${what} №${index + 1}`;
};

/** Сколько плохих записей называть поимённо. Дальше — числом: список на
    двести строк никто не прочтёт, а первые пять говорят, что чинить. */
const NAMED_FAULTS = 5;

/** Проверяет список записей и описывает, что в них не так. Пусто — все
    годны. */
function faultsOf(
  list: unknown[],
  what: string,
  faultOf: (value: unknown) => string | null
): string[] {
  const faults: string[] = [];
  let more = 0;
  list.forEach((value, index) => {
    const fault = faultOf(value);
    if (!fault) return;
    if (faults.length < NAMED_FAULTS) faults.push(`${recordName(value, index, what)}: ${fault}`);
    else more += 1;
  });
  if (more > 0) faults.push(`и ещё ${more} с теми же недостатками`);
  return faults;
}

/** Сегодняшняя дата по местным часам, как пишет её история расчётов.
    `toISOString` дал бы Гринвич — и вечером в Москве набор датировался бы
    ещё вчерашним днём. */
const pad = (value: number) => String(value).padStart(2, '0');
const localDate = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localStamp = (date: Date) =>
  `${localDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** Разбирает принесённые файлы в набор. Ничего не сохраняет. */
export async function readDataset(files: File[]): Promise<ReadResult> {
  const problems: string[] = [];
  const orders: Order[] = [];
  const engineers: Engineer[] = [];
  let date = '';
  let title = '';

  for (const file of files) {
    if (!/\.json$/i.test(file.name)) {
      problems.push(
        `«${file.name}» — не JSON. Набор принимается формами контракта ${SCHEMA}: ` +
          'orders.json и engineers.json. Сырую выгрузку нарядов сначала собирает dataset/build.py — ' +
          'в ней нет ни координат, ни длительности работ, ни инженеров.'
      );
      continue;
    }

    let body: AnyForm;
    try {
      body = JSON.parse(await file.text()) as AnyForm;
    } catch {
      problems.push(`«${file.name}» не разобрался как JSON.`);
      continue;
    }

    if (body.schema && !schemaAccepted(body.schema)) {
      problems.push(
        `«${file.name}»: схема ${body.schema}, интерфейс собран под ${SCHEMA}.`
      );
      continue;
    }

    date = body.meta?.date || date;
    title = body.meta?.zone || title;

    const rawOrders = Array.isArray(body.orders) ? (body.orders as unknown[]) : [];
    const rawEngineers = Array.isArray(body.engineers) ? (body.engineers as unknown[]) : [];

    /* Файл с негодной записью отклоняется целиком, а не прореживается:
       пропущенная молча заявка — это заявка, по которой никто не поедет, и
       узнать об этом диспетчер мог бы только сверив список с исходником.
       Сообщение называет поле и запись — то, что нужно, чтобы поправить
       файл и принести снова. */
    const orderFaults = faultsOf(rawOrders, 'заявка', orderFault);
    const engineerFaults = faultsOf(rawEngineers, 'инженер', engineerFault);
    for (const fault of [...orderFaults, ...engineerFaults]) problems.push(`«${file.name}»: ${fault}.`);
    if (orderFaults.length > 0 || engineerFaults.length > 0) {
      problems.push(`«${file.name}» отклонён: поправьте записи выше и загрузите файл снова.`);
      continue;
    }

    if (rawOrders.length === 0 && rawEngineers.length === 0) {
      problems.push(`«${file.name}»: ни заявок, ни инженеров не нашлось.`);
    }

    orders.push(...(rawOrders as Order[]));
    engineers.push(...(rawEngineers as Engineer[]));
  }

  if (orders.length === 0) problems.push('В наборе нет ни одной заявки — считать нечего.');
  if (engineers.length === 0) {
    problems.push('В наборе нет ни одного инженера — раскладывать заявки некому.');
  }

  return { orders, engineers, date: date || localDate(new Date()), title, problems };
}

/** Сохраняет разобранный набор и возвращает его. Ключ выдаётся здесь: он
    попадает в адрес расчёта и обязан пережить перезагрузку. */
export function saveDataset(read: ReadResult, title: string): Dataset {
  const dataset: Dataset = {
    key: `set-${Date.now().toString(36)}`,
    title: title.trim() || read.title || 'Загруженный набор',
    date: read.date,
    /* Местное время, как у записи расчёта в истории: рядом с ней это и
       показывают, и по Гринвичу набор «загружался» бы на три часа раньше. */
    added: localStamp(new Date()),
    orders: read.orders,
    engineers: read.engineers
  };
  loaded = [...loaded, dataset];
  persist();
  return dataset;
}
