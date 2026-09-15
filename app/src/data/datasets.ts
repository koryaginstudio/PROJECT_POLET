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
    throw new Error(
      'Хранилище браузера переполнено: набор будет работать до перезагрузки страницы. ' +
        'Удалите ненужные наборы в настройках.'
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

const isOrder = (value: unknown): value is Order => {
  const one = value as Order;
  return Boolean(
    one &&
      typeof one.id === 'string' &&
      typeof one.lat === 'number' &&
      typeof one.lon === 'number' &&
      typeof one.window_start === 'number' &&
      typeof one.window_end === 'number' &&
      typeof one.est_minutes === 'number' &&
      typeof one.skill === 'string'
  );
};

const isEngineer = (value: unknown): value is Engineer => {
  const one = value as Engineer;
  return Boolean(
    one &&
      typeof one.id === 'string' &&
      typeof one.name === 'string' &&
      Array.isArray(one.skills) &&
      typeof one.shift_start === 'number' &&
      typeof one.shift_end === 'number' &&
      typeof one.home_lat === 'number' &&
      typeof one.home_lon === 'number'
  );
};

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

    const gotOrders = Array.isArray(body.orders) ? body.orders.filter(isOrder) : [];
    const gotEngineers = Array.isArray(body.engineers) ? body.engineers.filter(isEngineer) : [];

    if (Array.isArray(body.orders) && gotOrders.length < body.orders.length) {
      problems.push(
        `«${file.name}»: ${body.orders.length - gotOrders.length} заявок без обязательных полей ` +
          '(номер, координаты, окно приёма, длительность, навык) — они пропущены.'
      );
    }
    if (Array.isArray(body.engineers) && gotEngineers.length < body.engineers.length) {
      problems.push(
        `«${file.name}»: ${body.engineers.length - gotEngineers.length} инженеров без обязательных ` +
          'полей (номер, имя, навыки, смена, точка выезда) — они пропущены.'
      );
    }
    if (gotOrders.length === 0 && gotEngineers.length === 0) {
      problems.push(`«${file.name}»: ни заявок, ни инженеров не нашлось.`);
    }

    orders.push(...gotOrders);
    engineers.push(...gotEngineers);
  }

  if (orders.length === 0) problems.push('В наборе нет ни одной заявки — считать нечего.');
  if (engineers.length === 0) {
    problems.push('В наборе нет ни одного инженера — раскладывать заявки некому.');
  }

  return { orders, engineers, date: date || new Date().toISOString().slice(0, 10), title, problems };
}

/** Сохраняет разобранный набор и возвращает его. Ключ выдаётся здесь: он
    попадает в адрес расчёта и обязан пережить перезагрузку. */
export function saveDataset(read: ReadResult, title: string): Dataset {
  const dataset: Dataset = {
    key: `set-${Date.now().toString(36)}`,
    title: title.trim() || read.title || 'Загруженный набор',
    date: read.date,
    added: new Date().toISOString(),
    orders: read.orders,
    engineers: read.engineers
  };
  loaded = [...loaded, dataset];
  persist();
  return dataset;
}
