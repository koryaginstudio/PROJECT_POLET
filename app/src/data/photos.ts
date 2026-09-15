/* Лица инженеров.

   Своих карточек сотрудников у стенда нет: инженеры приходят из выгрузки, а в
   ней есть имя, навыки и смена — фотографии там нет и не будет. Поэтому лицо
   выдаёт стенд.

   Два правила, и оба жёсткие.

   **Лицо закреплено за человеком.** Считается из одного только табельного
   номера и больше ни из чего. Раньше снимки раздавались по очереди из того
   списка, который попросили, — и один и тот же инженер получал одно лицо в
   базе, где показан весь штат, и другое в диспетчерской, где показана смена
   одного расчёта. Человек, меняющий лицо при переходе между разделами, хуже,
   чем человек вовсе без лица.

   **Лицо не повторяется.** Двое с одним лицом в соседних карточках читаются
   как сбой данных. Снимков четырнадцать, инженеров тридцать четыре, поэтому
   те, кому фотографии не хватило, получают не чужое лицо, а свой знак —
   инициалы на своём цвете. Положите в `public/photos` ещё снимков, допишите
   их сюда, и они разберутся сами: знаки уступят место фотографиям.

   Когда придут настоящие фотографии, отсюда уйдёт только источник: карточка
   спрашивает лицо по инженеру и не знает, откуда оно взялось. */

const PHOTOS = [
  'photo-02.jpg',
  'photo-03.jpg',
  'photo-04.jpg',
  'photo-05.jpg',
  'photo-06.jpg',
  'photo-07.jpg',
  'photo-08.jpg',
  'photo-09.jpg',
  'photo-10.jpg',
  'photo-11.jpg',
  'photo-12.jpg',
  'photo-13.jpg',
  'photo-p1.jpg',
  'photo-p2.jpg'
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

/** Номер человека из табельного: `E07` → 7. Не число — `null`. */
function seatOf(id: string): number | null {
  const digits = id.match(/\d+/);
  if (!digits) return null;
  const value = Number(digits[0]);
  return Number.isFinite(value) ? value : null;
}

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

/** Лицо одного инженера. Считается из табельного номера, поэтому одинаково в
    любом разделе и при любом отборе.

    Снимок достаётся тем, чей номер попал в длину списка снимков: номера идут
    подряд с нуля, поэтому раздача выходит взаимно однозначной — двое одного
    лица не получат. Остальным — свой знак. */
export function faceOf(engineer: Faced): string {
  const seat = seatOf(engineer.id);
  if (seat !== null && seat < PHOTOS.length) return `/photos/${PHOTOS[seat]}`;
  return markFor(engineer.id, engineer.name);
}

/** Лица для списка: табельный → путь или знак. */
export function photosFor(crew: Faced[]): Map<string, string> {
  return new Map(crew.map((engineer) => [engineer.id, faceOf(engineer)]));
}
