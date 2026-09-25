/* Таблица из файла — к виду, который принимает программа расчёта.

   Программа расчёта читает один формат: выгрузку дня с колонками «Заявка»,
   «Тип заявки BK», «Начало», «Окончание», «Адрес» и строкой «Адрес офиса»
   внизу. Разделитель она подбирает сама — точка с запятой, запятая или
   табуляция.

   Диспетчеру же файл приходит в том виде, в каком его отдала чужая система:
   выгрузкой CSV, таблицей в Markdown из переписки, книгой Excel. Смысл в них
   один и тот же, поэтому здесь они и сводятся к одному: MD и Excel
   превращаются в ту же самую CSV и уходят программе тем же путём, что и
   родная выгрузка. Никакого второго пути к расчёту у них нет — он один.

   Книгу Excel читаем сами, без сторонней библиотеки: .xlsx — это zip с
   двумя XML внутри, а распаковку умеет сам браузер (`DecompressionStream`).
   Полмегабайта чужого кода ради одного экрана здесь не нужны. */

/** Ячейки одной строки таблицы. */
export type Row = string[];

/** Что принимает каждая кнопка импорта. */
export const ACCEPT = {
  csv: '.csv,text/csv,text/plain',
  md: '.md,.markdown,text/markdown',
  xlsx: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
} as const;

export type ImportKind = keyof typeof ACCEPT;

/* ─── CSV ─────────────────────────────────────────────────────────────── */

const DELIMITER = ';';

/** Ячейка в CSV. Кавычки, разделитель и перенос строки требуют кавычек —
    иначе строка развалится на две. */
function cell(value: string): string {
  const text = value ?? '';
  if (text === '') return '';
  return /["\n\r;,\t]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function rowsToCsv(rows: Row[]): string {
  return rows.map((row) => row.map(cell).join(DELIMITER)).join('\r\n');
}

/* ─── Markdown ────────────────────────────────────────────────────────── */

/** Строка-разделитель шапки: |---|:--:|. Она разметка, а не данные. */
const RULE = /^[\s|:-]+$/;

/** Таблица Markdown в строки. Берём только строки с вертикальной чертой:
    заголовок, подпись и прочий текст вокруг таблицы к данным не относятся. */
export function mdToRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes('|')) continue;
    if (RULE.test(trimmed) && trimmed.includes('-')) continue;
    /* Внешние черты необязательны: «a | b» — тоже строка таблицы. */
    const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    rows.push(body.split(/(?<!\\)\|/).map((one) => one.trim().replace(/\\\|/g, '|')));
  }
  return rows;
}

/* ─── Excel ───────────────────────────────────────────────────────────── */

interface ZipEntry {
  name: string;
  method: number;
  from: number;
  size: number;
}

const view = (buffer: ArrayBuffer) => new DataView(buffer);

/** Оглавление zip. Ищем его с конца — там оно и лежит. */
function zipEntries(buffer: ArrayBuffer): ZipEntry[] {
  const dv = view(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 66000; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('это не книга Excel: внутри нет оглавления zip');

  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(at, true) !== 0x02014b50) break;
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const entry: ZipEntry = {
      name: decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen)),
      method: dv.getUint16(at + 10, true),
      from: local,
      size: dv.getUint32(at + 20, true)
    };
    entries.push(entry);
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Содержимое одной записи zip текстом. */
async function unzip(buffer: ArrayBuffer, entry: ZipEntry): Promise<string> {
  const dv = view(buffer);
  const nameLen = dv.getUint16(entry.from + 26, true);
  const extraLen = dv.getUint16(entry.from + 28, true);
  const start = entry.from + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buffer, start, entry.size);
  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) throw new Error('книга сжата незнакомым способом');
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('браузер не умеет распаковывать книгу — сохраните лист как CSV');
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
};

function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X'))
      return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
    return ENTITIES[code] ?? whole;
  });
}

/** Все <t> внутри куска XML — текст ячейки может быть разбит на части. */
function textOf(xml: string): string {
  let out = '';
  for (const found of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g)) {
    out += unescapeXml(found[1] ?? '');
  }
  return out;
}

/** Общие строки книги: Excel хранит текст ячеек отдельным списком. */
function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)].map((one) =>
    textOf(one[1] ?? '')
  );
}

/** Номер колонки из ссылки на ячейку: A→0, B→1, AA→26. */
function columnOf(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? 'A';
  let n = 0;
  for (const letter of letters) n = n * 26 + (letter.charCodeAt(0) - 64);
  return n - 1;
}

/** Дата Excel числом — в «17.08.2026 20:00». Книга хранит дату как номер
    дня от 1900 года, и без обратного перевода в «Начале» оказалось бы
    «46256,83». Переводим только то, что стоит в колонках времени: обычное
    число заявки трогать нельзя. */
function excelDate(serial: number): string {
  /* 25569 — дней от 1900 до 1970; 1 день лишний из-за несуществующего
     29 февраля 1900 года, который Excel считает настоящим. */
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(serial);
  const two = (n: number) => String(n).padStart(2, '0');
  return (
    `${two(date.getUTCDate())}.${two(date.getUTCMonth() + 1)}.${date.getUTCFullYear()} ` +
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}`
  );
}

const TIME_COLUMNS = ['Начало', 'Окончание'];
const SERIAL_FROM = 20000;
const SERIAL_TO = 80000;

/** Первый лист книги — строками. */
export async function xlsxToRows(buffer: ArrayBuffer): Promise<Row[]> {
  const entries = zipEntries(buffer);
  const sheet =
    entries.find((one) => one.name === 'xl/worksheets/sheet1.xml') ??
    entries.find((one) => /^xl\/worksheets\/[^/]+\.xml$/.test(one.name));
  if (!sheet) throw new Error('в книге нет ни одного листа');

  const stringsEntry = entries.find((one) => one.name === 'xl/sharedStrings.xml');
  const strings = stringsEntry ? sharedStrings(await unzip(buffer, stringsEntry)) : [];
  const xml = await unzip(buffer, sheet);

  const rows: Row[] = [];
  for (const rowXml of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const row: Row = [];
    for (const cellXml of (rowXml[1] ?? '').matchAll(
      /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g
    )) {
      const attrs = cellXml[1] ?? '';
      const body = cellXml[2] ?? '';
      const at = columnOf(/r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? 'A1');
      const type = /t="([^"]+)"/.exec(attrs)?.[1] ?? 'n';
      let value: string;
      if (type === 's') {
        const index = Number(unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? ''));
        value = strings[index] ?? '';
      } else if (type === 'inlineStr') {
        value = textOf(body);
      } else if (type === 'str') {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      } else {
        value = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      }
      while (row.length < at) row.push('');
      row[at] = value;
    }
    rows.push(row);
  }

  /* Время, записанное числом, — обратно в дату. Колонку узнаём по шапке:
     гадать по самому числу нельзя, номер заявки тоже число. */
  const head = rows[0] ?? [];
  const timeAt = head
    .map((title, index) => (TIME_COLUMNS.includes(title.trim()) ? index : -1))
    .filter((index) => index >= 0);
  if (timeAt.length > 0) {
    for (const row of rows.slice(1)) {
      for (const index of timeAt) {
        const value = Number(row[index]);
        if (row[index] && Number.isFinite(value) && value > SERIAL_FROM && value < SERIAL_TO) {
          row[index] = excelDate(value);
        }
      }
    }
  }

  return rows;
}

/* ─── общий вход ──────────────────────────────────────────────────────── */

/** Файл — в байты выгрузки, которые понимает программа расчёта.

    CSV уходит как есть, до последнего байта: кодировку (cp1251 или UTF-8)
    разбирает сама программа, и перекладывать файл через текст значило бы
    сломать то, что она читает правильно. */
export async function toUploadBytes(kind: ImportKind, file: File): Promise<ArrayBuffer> {
  if (kind === 'csv') return file.arrayBuffer();
  const rows =
    kind === 'md' ? mdToRows(await file.text()) : await xlsxToRows(await file.arrayBuffer());
  if (rows.length < 2) {
    throw new Error(
      kind === 'md'
        ? 'в файле нет таблицы: нужна шапка и хотя бы одна строка заявки'
        : 'на первом листе книги нет таблицы: нужна шапка и хотя бы одна строка заявки'
    );
  }
  return new TextEncoder().encode(rowsToCsv(rows)).buffer as ArrayBuffer;
}

/** Имя, под которым выгрузка ляжет в программе расчёта: она различает файлы
    по имени, а расширение у неё всегда одно. */
export const uploadName = (kind: ImportKind, name: string): string =>
  kind === 'csv' ? name : name.replace(/\.[^.]+$/, '') + '.csv';
