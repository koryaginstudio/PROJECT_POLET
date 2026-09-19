import type { ExtraOrder } from '../app/SourcePicker.tsx';

/* Разбор выгрузки заявок из CSV.

   Логика лежит отдельно от экрана: она не зависит ни от React, ни от того,
   как выглядит форма, и проверяется сама по себе. */

/** Что нашлось в файле: разобранные заявки и строки, которые пришлось снять. */
export interface Parsed {
  fileName: string;
  orders: ExtraOrder[];
  skipped: { line: number; why: string }[];
  /** Колонки, которых не нашлось: по ним видно, что подставлено по умолчанию. */
  missing: string[];
}

/* Названия колонок ищем по куску слова: в выгрузках они приходят то
   «Адрес объекта», то «адрес_клиента». */
const COLUMNS = {
  address: ['адрес', 'address'],
  work: ['что делаем', 'вид работ', 'работы', 'услуга', 'work'],
  from: ['окно с', 'окно от', 'начало', 'from'],
  to: ['окно до', 'конец', 'to'],
  minutes: ['мин', 'длитель', 'duration'],
  urgent: ['авар', 'срочн', 'urgent']
};

/** Шаблон выгрузки: его скачивают, заполняют поверх примера и присылают. */
export const CSV_TEMPLATE = [
  'Адрес;Что делаем;Окно с;Окно до;Работы, мин;Авария',
  'улица Ленина, 14;Подключение;10:00;14:00;60;нет',
  'проспект Мира, 3, кв. 12;Ремонт;09:00;13:00;90;да'
].join('\n');

/* Разбор CSV. Своими руками, без библиотеки: нужен один диалект — строки,
   кавычки и разделитель, — а весь остальной стандарт к выгрузке из Excel
   отношения не имеет. */
export function parseOrders(text: string, usedIds: Set<string>, fileName: string): Parsed {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  const skipped: Parsed['skipped'] = [];
  if (lines.length < 2) return { fileName, orders: [], skipped, missing: [] };

  /* Разделитель определяем по шапке: Excel в русской локали пишет точку с
     запятой, в английской — запятую, а «сохранить как текст» даёт табуляцию,
     и угадать по расширению нельзя. Берём тот, которого в шапке больше;
     шапка вовсе без разделителей — это одна колонка, и разделитель тогда не
     важен: раньше такая шапка сравнивалась «ноль не меньше нуля» и молча
     проходила как точка с запятой, хотя выбирать было не из чего. */
  const head = lines[0];
  const sep = separatorOf(head);

  const header = split(head, sep).map((cell) => cell.trim().toLowerCase());
  const find = (names: string[]) =>
    header.findIndex((cell) => names.some((name) => cell.includes(name)));

  const at = {
    address: find(COLUMNS.address),
    work: find(COLUMNS.work),
    from: find(COLUMNS.from),
    to: find(COLUMNS.to),
    minutes: find(COLUMNS.minutes),
    urgent: find(COLUMNS.urgent)
  };

  const missing: string[] = [];
  if (at.work < 0) missing.push('что делаем');
  if (at.from < 0 || at.to < 0) missing.push('окно приёма');
  if (at.minutes < 0) missing.push('длительность');

  const used = new Set(usedIds);
  const orders: ExtraOrder[] = [];

  if (at.address < 0) return { fileName, orders, skipped, missing };

  for (let index = 1; index < lines.length; index += 1) {
    const cells = split(lines[index], sep);
    const address = (cells[at.address] ?? '').trim();
    if (!address) {
      skipped.push({ line: index + 1, why: 'пустой адрес' });
      continue;
    }

    /* Подставлять по умолчанию можно только там, где колонки нет вовсе — об
       этом честно сказано в `missing`. Колонка есть, а значение в ней не
       разобралось — это ошибка в строке, и строку надо снять с причиной, а
       не молча поставить ей окно 10:00–14:00 и час работ: такая заявка
       пошла бы в расчёт с временем, которого никто не называл. */
    const from = at.from >= 0 ? minutesOf(cells[at.from]) : null;
    const to = at.to >= 0 ? minutesOf(cells[at.to]) : null;
    if (at.from >= 0 && from === null) {
      skipped.push({ line: index + 1, why: `не разобралось начало окна «${cellText(cells[at.from])}»` });
      continue;
    }
    if (at.to >= 0 && to === null) {
      skipped.push({ line: index + 1, why: `не разобрался конец окна «${cellText(cells[at.to])}»` });
      continue;
    }
    /* Перевёрнутое окно — это ошибка выгрузки, а не заявка на ночную смену:
       такую строку лучше снять, чем тихо поменять местами и посчитать. */
    if (from !== null && to !== null && to <= from) {
      skipped.push({ line: index + 1, why: 'окно кончается раньше, чем начинается' });
      continue;
    }

    const minutes = at.minutes >= 0 ? numberOf(cells[at.minutes]) : null;
    if (at.minutes >= 0 && (minutes === null || minutes <= 0)) {
      skipped.push({
        line: index + 1,
        why: `не разобралась длительность работ «${cellText(cells[at.minutes])}»`
      });
      continue;
    }
    const urgentCell = at.urgent >= 0 ? (cells[at.urgent] ?? '').trim().toLowerCase() : '';

    const id = nextId(used);
    used.add(id);
    orders.push({
      id,
      address,
      workTitle: (cells[at.work] ?? '').trim() || 'Работы по заявке',
      windowStart: from ?? 10 * 60,
      windowEnd: to ?? 14 * 60,
      minutes: minutes !== null ? Math.round(minutes) : 60,
      urgent: ['да', 'yes', '1', 'true', 'авария', 'срочно'].includes(urgentCell)
    });
  }

  return { fileName, orders, skipped, missing };
}

/** Каким знаком шапка разделена на колонки. */
function separatorOf(head: string): string {
  const candidates = [';', ',', '\t'];
  let best = candidates[0];
  let most = 0;
  for (const sep of candidates) {
    const count = head.split(sep).length - 1;
    if (count > most) {
      most = count;
      best = sep;
    }
  }
  return best;
}

/** Значение ячейки для причины снятия: обрезано, чтобы причина влезла в
    строку, и без переводов строк. */
const cellText = (raw: string | undefined) => (raw ?? '').trim().slice(0, 24);

/** Число так, как его пишет Excel в русской локали: «1 234,5» — с
    неразрывным пробелом между разрядами и запятой в дроби. Оба пробела,
    обычный и неразрывный, убираем; запятую меняем на точку. */
function numberOf(raw: string | undefined): number | null {
  const text = (raw ?? '').replace(/[\s  ]/g, '').replace(',', '.');
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** Разбор строки: кавычки держим, потому что в адресе бывает разделитель. */
function split(line: string, sep: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      /* Две кавычки подряд внутри кавычек — это одна кавычка в тексте. */
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
      continue;
    }
    if (char === sep && !quoted) {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += char;
  }
  cells.push(cell);
  return cells;
}

/** «10:00», «10.00», «10» и «9:30» — всё это минуты от полуночи. Пустая
    ячейка и то, что часами не читается, — `null`: решает звавший, снять
    строку или подставить своё. */
function minutesOf(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const match = value.match(/^(\d{1,2})[:.\s]?(\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function nextId(used: Set<string>): string {
  for (let n = 1; n < 1000; n += 1) {
    const id = `X${String(n).padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  return `X${Date.now()}`;
}
