/* Заметки к записям справочников.

   У расчёта заметка была с самого начала: диспетчер записывал, зачем он его
   считал и чем тот кончился. Оказалось, что это нужно каждой записи, а не
   одному расчёту. Про инженера помнят, что он не любит работать после восьми;
   про адрес — что домофон не работает и звонить надо по телефону; про заявку
   — что клиент просил перезвонить за час. Ничего этого нет ни в выгрузке, ни
   в расчёте, и взяться ему неоткуда, кроме как от человека, который это знает.

   Хранилище одно на все базы и ключ у него общий: вид записи и её номер.
   Держать по реестру на базу значило бы шесть почти одинаковых модулей,
   расходящихся друг с другом на первой же правке.

   Живёт в браузере, рядом с остальным, что рабочее место помнит о себе само:
   номерами маршрутов и клиентов, правками штата, заводскими значениями
   движка. Движок про заметки не знает и знать не должен — это не входные
   данные для расчёта, а память диспетчера. Запись у заметки своя: расчёт
   пересчитали, штат поправили, а заметка про человека осталась.

   Заметка расчёта сюда не переехала: она лежит в самой записи истории и
   уходит на сервер вместе с ней, когда движок начинает отдавать свой архив.
   Разводить её надвое ради единообразия было бы хуже, чем оставить как есть. */

const STORE_KEY = 'polet.notes.v1';

/** Какой базе принадлежит запись. От вида зависит только ключ — всё
    остальное у заметок одинаково. */
export type NoteKind = 'engineer' | 'order' | 'client' | 'route' | 'service';

type Store = Record<string, string>;

let store: Store | null = null;

/* Кто ждёт обновления. Заметку правят в карточке, а показывают её и карточка,
   и профиль, и соседний список — без общего оповещения один из них остался бы
   с прежним текстом до перезагрузки. */
const watchers = new Set<() => void>();

function read(): Store {
  if (store) return store;
  if (typeof localStorage === 'undefined') {
    store = {};
    return store;
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Store) : null;
    store = parsed && typeof parsed === 'object' ? { ...parsed } : {};
  } catch {
    /* Запись испортилась. Заметки — не данные расчёта: потерять их обидно,
       но показывать вместо базы пустой экран из-за них нельзя. */
    store = {};
  }
  return store;
}

function write(next: Store) {
  store = next;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* Места нет или запись запрещена: заметка доживёт до перезагрузки в
       памяти. Это лучше, чем отказать в правке. */
  }
  for (const notify of watchers) notify();
}

const keyOf = (kind: NoteKind, id: string) => `${kind}:${id}`;

/** Заметка к записи. Пусто — её не заводили. */
export const noteOf = (kind: NoteKind, id: string): string => read()[keyOf(kind, id)] ?? '';

/** Записывает заметку. Пустая строка стирает: заметка «ничего» — это
    отсутствие заметки, и держать её в хранилище незачем. */
export function setNote(kind: NoteKind, id: string, text: string): void {
  const key = keyOf(kind, id);
  const next = { ...read() };
  const trimmed = text.trim();

  if (trimmed) next[key] = trimmed;
  else delete next[key];

  write(next);
}

/** Сколько заметок заведено в этой базе. Нужно её шапке: «заметок — 12»
    отвечает на «есть ли тут вообще что-то моё». */
export function noteCount(kind: NoteKind): number {
  const prefix = `${kind}:`;
  return Object.keys(read()).filter((key) => key.startsWith(prefix)).length;
}

/** Подписка на правки. Возвращает отписку. */
export function watchNotes(notify: () => void): () => void {
  watchers.add(notify);
  return () => {
    watchers.delete(notify);
  };
}
