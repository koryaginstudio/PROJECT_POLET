import { ownFace } from './faces.ts';

/* Лица инженеров.

   Своих карточек сотрудников у сервиса нет: инженеры приходят из выгрузки, а
   в ней есть имя, навыки и смена — фотографии там нет и не будет. Поэтому
   лицо выдаёт сервис, и выдаёт он его таблицей.

   Таблица, а не раздача по порядку. Прежде снимки раздавались по списку
   записей справочника: тридцать четыре файла на сорок две записи, кому не
   хватило — знак с инициалами. Раздача зависела от того, какой справочник
   собрался: сменился состав участков — и лица переехали с человека на
   человека. Здесь же четырнадцать человек штата названы поимённо, и у
   каждого свой файл, закреплённый навсегда.

   Кого в таблице нет — тот без фотографии, со знаком из инициалов. Это не
   нехватка, а правило: нового человека сервис в лицо не знает и выдумывать
   ему лицо не станет. Своё лицо заводит диспетчер — кнопкой в карточке
   инженера, снимок ложится в `faces.ts`.

   Раньше здесь стояли ещё два правила — «лицо считается из имени» и «лицо
   не повторяется», — и оба были следствием раздачи. Таблице они не нужны:
   повторов в ней нет по построению, а закреплено лицо за строкой таблицы, а
   не за хешем чего бы то ни было. */

/** Штат и его лица. Табельный номер один на все участки: E05 значит E05
    везде, и человек это один и тот же — Ерохин Данил. Имя стоит рядом
    затем, что в плане движка у инженера бывает номер без участка, а в
    иных местах — имя без номера: искать человека можно с любой стороны. */
const CREW: { tab: string; name: string; photo: string }[] = [
  { tab: 'E00', name: 'Белов Артём', photo: 'photo-02.jpg' },
  { tab: 'E01', name: 'Гущин Сергей', photo: 'photo-03.jpg' },
  { tab: 'E02', name: 'Мухин Ильдар', photo: 'photo-04.jpg' },
  { tab: 'E03', name: 'Рожков Павел', photo: 'photo-05.jpg' },
  { tab: 'E04', name: 'Саврасов Никита', photo: 'photo-06.jpg' },
  { tab: 'E05', name: 'Ерохин Данил', photo: 'photo-07.jpg' },
  { tab: 'E06', name: 'Пятков Олег', photo: 'photo-08.jpg' },
  { tab: 'E07', name: 'Шитов Роман', photo: 'photo-09.jpg' },
  { tab: 'E08', name: 'Юсупов Марат', photo: 'photo-10.jpg' },
  { tab: 'E09', name: 'Лапин Кирилл', photo: 'photo-11.jpg' },
  { tab: 'E10', name: 'Тимофеев Егор', photo: 'photo-12.jpg' },
  { tab: 'E11', name: 'Дуров Антон', photo: 'photo-13.jpg' },
  { tab: 'E12', name: 'Ильин Виктор', photo: 'photo-14.jpg' },
  { tab: 'E13', name: 'Назаров Глеб', photo: 'photo-15.jpg' }
];

/* Цвета для знаков. Приглушённые: знак стоит там же, где фотография, и не
   должен спорить с ней яркостью в одном ряду. */
const MARK_COLORS = [
  '#5B6B7C',
  '#6E6A82',
  '#4F7268',
  '#7C6350',
  '#5A6E86',
  '#7A5F6B',
  '#57705A',
  '#6B6450'
];

function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) >>> 0;
  }
  return value;
}

/** Инициалы: первая буква фамилии и первая буква имени. Выгрузка называет
    бригаду то одной фамилией, то ФИО целиком — берём то, что пришло. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  return parts
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
}

/* Знак рисуется здесь же и отдаётся картинкой. Так вызывающей стороне не
   нужно знать, лицо ей досталось или знак: и то и другое — `src` для `img`,
   и ни одна карточка от этого не меняется. */
function markFor(id: string, name: string): string {
  const color = MARK_COLORS[hash(id) % MARK_COLORS.length];
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
    `<rect width="200" height="200" fill="${color}"/>` +
    `<text x="100" y="100" fill="#fff" font-family="Onest, system-ui, sans-serif" ` +
    `font-size="78" font-weight="600" text-anchor="middle" dominant-baseline="central">` +
    `${initialsOf(name)}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export interface Faced {
  id: string;
  name: string;
}

/** Имя как ключ: регистр, двойные пробелы и «ё» сводятся к одному виду. */
const whoOf = (name: string) =>
  name.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

const byTab = new Map(CREW.map((one) => [one.tab, `/photos/${one.photo}`]));
const byName = new Map(CREW.map((one) => [whoOf(one.name), `/photos/${one.photo}`]));

/** Табельный номер из любого вида записи.

    Справочник ключует записи участком («восток:E05»), общая карта —
    расчётом и инженером («run-…::E05»), план движка зовёт человека просто
    «E05». Во всех трёх номер один и тот же, и выуживается он одинаково. */
export function tabOf(id: string): string {
  const found = /E\d{2,}/.exec(id);
  return found ? found[0] : id;
}

/** Раздача снимков больше ничего не делает: лица закреплены таблицей и от
    состава справочника не зависят. Вызов оставлен, чтобы сбор справочника
    не знал об этой перемене. */
export function noteCrew(_crew: Faced[]): void {
  /* нарочно пусто */
}

/** Лицо одного инженера: свой снимок, если его завели; иначе закреплённый
    за ним в таблице; иначе знак с инициалами. */
export function faceOf(engineer: Faced): string {
  const tab = tabOf(engineer.id);
  const own = ownFace(tab);
  if (own) return own;
  const fixed = byTab.get(tab) ?? byName.get(whoOf(engineer.name));
  if (fixed) return fixed;
  return markFor(engineer.id, engineer.name);
}

/** Есть ли у человека настоящая фотография — своя или из таблицы штата.
    По этому карточка понимает, предлагать ли завести снимок. */
export const hasFace = (engineer: Faced): boolean =>
  Boolean(ownFace(tabOf(engineer.id)) ?? byTab.get(tabOf(engineer.id)) ?? byName.get(whoOf(engineer.name)));

/** Лица для списка: табельный → путь или знак. */
export function photosFor(crew: Faced[]): Map<string, string> {
  return new Map(crew.map((engineer) => [engineer.id, faceOf(engineer)]));
}
