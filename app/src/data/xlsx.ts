/* Книга Excel без единой зависимости.

   Выгрузка расчёта — это несколько таблиц сразу: сводка, маршруты, визиты,
   невзятые заявки. CSV их не держит, поэтому нужен настоящий xlsx.

   Готовых библиотек для этого хватает, и все они весят около мегабайта ради
   того, что мы используем на процент: формул, стилей, диаграмм и чтения
   чужих книг здесь нет и не будет. Поэтому книга собирается руками —
   полтораста строк против мегабайта, и на защите с чужим ноутбуком ничего не
   надо доставать из сети.

   Формат простой: xlsx — это zip с несколькими XML внутри. Складываем без
   сжатия (метод 0), тогда из всего zip нужен только CRC32 — таблица на
   256 чисел. Строки пишем встроенными (`inlineStr`), чтобы не заводить
   отдельный словарь: книга из нескольких тысяч ячеек от этого не растолстеет
   настолько, чтобы ради экономии усложнять запись. */

export type Cell = string | number | null | undefined;
export interface Sheet {
  /** Имя листа. Excel не пускает > 31 знака и запрещает : \ / ? * [ ] */
  name: string;
  /** Первая строка — шапка, дальше данные. */
  rows: Cell[][];
}

/* ─── zip ──────────────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface Entry {
  name: string;
  data: Uint8Array;
  crc: number;
  offset: number;
}

/** Складывает файлы в zip без сжатия. */
function zip(files: { name: string; text: string }[]): Blob {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const entries: Entry[] = [];
  let offset = 0;

  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  /* Заголовки zip пишутся числами фиксированной длины с младшего байта. */
  const head = (size: number, values: [number, number][]) => {
    const buffer = new Uint8Array(size);
    const view = new DataView(buffer.buffer);
    for (const [at, value] of values) {
      if (value > 0xffff) view.setUint32(at, value, true);
      else view.setUint16(at, value, true);
    }
    return { buffer, view };
  };

  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);

    const { buffer: local, view } = head(30, []);
    view.setUint32(0, 0x04034b50, true); // подпись локального заголовка
    view.setUint16(4, 20, true); // версия
    view.setUint16(6, 0x0800, true); // флаг: имена в utf-8
    view.setUint16(8, 0, true); // метод: без сжатия
    view.setUint32(14, crc, true);
    view.setUint32(18, data.length, true);
    view.setUint32(22, data.length, true);
    view.setUint16(26, name.length, true);

    entries.push({ name: file.name, data, crc, offset });
    push(local);
    push(name);
    push(data);
  }

  const dirStart = offset;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const { buffer: central, view } = head(46, []);
    view.setUint32(0, 0x02014b50, true); // подпись записи каталога
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, 0, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.data.length, true);
    view.setUint32(24, entry.data.length, true);
    view.setUint16(28, name.length, true);
    view.setUint32(42, entry.offset, true);
    push(central);
    push(name);
  }

  const { buffer: end, view: endView } = head(22, []);
  endView.setUint32(0, 0x06054b50, true); // подпись конца каталога
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - dirStart, true);
  endView.setUint32(16, dirStart, true);
  push(end);

  return new Blob(chunks as BlobPart[], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
}

/* ─── xml ──────────────────────────────────────────────────────────────── */

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    /* Excel не открывает книгу с управляющими символами внутри — выкидываем
       их молча: в наших данных их быть не должно, а ронять выгрузку из-за
       одного невидимого знака в адресе незачем. Перевод строки, возврат
       каретки и табуляция остаются: они законны и встречаются в заметках. */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** Имя столбца по номеру: 0 → A, 26 → AA. */
function column(index: number): string {
  let name = '';
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

function sheetXml(sheet: Sheet): string {
  const rows = sheet.rows
    .map((cells, r) => {
      const inner = cells
        .map((cell, c) => {
          if (cell === null || cell === undefined || cell === '') return '';
          const ref = `${column(c)}${r + 1}`;
          if (typeof cell === 'number' && Number.isFinite(cell)) {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(cell))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${inner}</row>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${rows}</sheetData>` +
    '</worksheet>'
  );
}

/** Имя листа, которое Excel примет. */
const sheetName = (name: string) => name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);

/** Собирает книгу из листов. */
export function workbook(sheets: Sheet[]): Blob {
  const files: { name: string; text: string }[] = [];

  files.push({
    name: '[Content_Types].xml',
    text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join('') +
      '</Types>'
  });

  files.push({
    name: '_rels/.rels',
    text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>'
  });

  files.push({
    name: 'xl/workbook.xml',
    text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets
        .map(
          (sheet, i) =>
            `<sheet name="${esc(sheetName(sheet.name))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        )
        .join('') +
      '</sheets></workbook>'
  });

  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    text:
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
        )
        .join('') +
      '</Relationships>'
  });

  sheets.forEach((sheet, i) => {
    files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(sheet) });
  });

  return zip(files);
}

/** Отдаёт файл браузеру. */
export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  /* Ссылку освобождаем не сразу: Safari успевает начать скачивание не
     раньше следующего кадра, и отозванный url ломает его на полпути. */
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
