/* Правки штата, сделанные диспетчером.

   Данные о человеке приходят из выгрузки, и выгрузка бывает неправа: телефон
   сменился, человек ушёл, транспорт у него сегодня другой. Заставлять из-за
   этого пересобирать набор — значит не дать поправить вовсе.

   Правка ложится поверх данных на самом входе, а не в карточке. Это важно:
   поправленный транспорт обязан менять и то, какие заявки человек возьмёт, —
   иначе в базе будет написано одно, а планировщик будет считать по другому.
   Поэтому правки применяются там же, где читается зона, и всё, что ниже,
   разницы не видит.

   Хранит их браузер: сервера у нас нет. Исходные файлы не трогаются — правку
   всегда можно снять и вернуться к тому, что прислал заказчик. */

import type { Engineer } from './contract.ts';

/** Правка одного участка: как он называется, откуда выезжают и в какую смену.

    Смена живёт здесь, а не рядом с телефоном, и это не мелочь: график
    считается по нарядам дня на конкретном участке, и у того, кто работает на
    двух, смены разные. Одно поле «смена» на человека переписало бы обе. */
export interface PostPatch {
  zone?: string;
  home_address?: string | null;
  /** Координаты нового адреса выезда. Геокодера в браузере нет, и берутся
      они у офиса участка, если он известен, — см. `officeAt`. Хранятся в
      правке, а не ищутся при каждом чтении: участок, чей офис нужен, мог
      ещё не прочитаться, а правка обязана ложиться одинаково при любом
      порядке загрузки. */
  home_lat?: number;
  home_lon?: number;
  shift_start?: number;
  shift_end?: number;
}

/** Что можно поправить у человека. */
export interface CrewPatch {
  /** Новый табельный номер. */
  id?: string;
  name?: string;
  phone?: string | null;
  transport?: string | null;
  status?: string | null;
  skills?: string[];
  /** Правки по участкам. Ключ — название участка, как оно пришло в данных. */
  posts?: Record<string, PostPatch>;
}

interface CrewEdits {
  patch: Record<string, CrewPatch>;
  /** Табельные тех, кого убрали из штата. */
  removed: string[];
  /** Переименованные номера: новый → исходный. Нужен затем, что правки
      хранятся под тем номером, что стоит в данных, а карточка после
      переименования называет человека уже новым. */
  renamed: Record<string, string>;
}

const STORE_KEY = 'polet.crew-edits.v1';

const blank = (): CrewEdits => ({ patch: {}, removed: [], renamed: {} });

function read(): CrewEdits {
  if (typeof localStorage === 'undefined') return blank();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return blank();
    const parsed = JSON.parse(raw) as Partial<CrewEdits>;
    return {
      patch: parsed.patch ?? {},
      removed: Array.isArray(parsed.removed) ? parsed.removed : [],
      renamed: parsed.renamed ?? {}
    };
  } catch {
    return blank();
  }
}

let edits = read();

/* Счётчик правок. По нему кеши понимают, что данные изменились: расчёт
   кешируется по зоне и переменным, и без этого поправленный транспорт не
   доехал бы до плана до самой перезагрузки. */
let version = 0;

export const crewVersion = () => version;

function save(): void {
  version += 1;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(edits));
  } catch {
    /* Хранилище закрыто настройками браузера: правка живёт до перезагрузки. */
  }
}

/* ─── адреса выезда, чьи координаты известны ──────────────────────────────

   Правка меняет адрес выезда словами, а маршрут считается от координат, и
   геокодировать адрес в браузере нечем. Но адреса, которые предлагает
   карточка, — это офисы участков, а у офиса координаты есть: из него
   выезжает весь участок, и они стоят у каждого его инженера. Запоминаем их
   при чтении зоны и берём отсюда, когда адрес в правке совпал с известным.

   Незнакомый адрес координат не получает, и правка оставляет прежние —
   человек продолжает выезжать с прежней точки, хотя адрес подписан новым.
   Это неточность, о которой сказано здесь, а не тихая подмена: показать
   старые координаты под новым адресом молча было бы хуже. */
const offices = new Map<string, { lat: number; lon: number }>();

/** Запоминает точки выезда. Зовётся при чтении каждой зоны — первым,
    до правок: правленые координаты сами берутся отсюда, и класть их сюда
    обратно значило бы запомнить свою же догадку как факт. */
function rememberOffices(crew: Engineer[]): void {
  for (const engineer of crew) {
    if (!engineer.home_address || offices.has(engineer.home_address)) continue;
    if (!Number.isFinite(engineer.home_lat) || !Number.isFinite(engineer.home_lon)) continue;
    offices.set(engineer.home_address, { lat: engineer.home_lat, lon: engineer.home_lon });
  }
}

/** Координаты офиса по адресу, если он известен. */
export const officeAt = (address: string | null | undefined) =>
  address ? (offices.get(address) ?? null) : null;

/** Под каким номером человек лежит в данных. Карточка называет его тем, что
    видно на экране, а он мог быть переименован. */
export const sourceIdOf = (shownId: string) => edits.renamed[shownId] ?? shownId;

/** Убран ли человек из штата. */
export const crewRemoved = (id: string) => edits.removed.includes(sourceIdOf(id));

/** Сколько правок держит браузер. */
export const crewEditCount = () => Object.keys(edits.patch).length + edits.removed.length;

export function editCrew(shownId: string, patch: CrewPatch): void {
  const source = sourceIdOf(shownId);
  const was = edits.patch[source] ?? {};
  /* Правки участков не заменяются целиком, а дописываются: правят один
     участок, а второй от этого потеряться не должен. */
  const posts = { ...was.posts };
  for (const [zone, one] of Object.entries(patch.posts ?? {})) {
    const next = { ...posts[zone], ...one };
    /* Новый адрес выезда приносит с собой координаты офиса, если адрес
       известен. Прежние координаты в правке при этом не остаются: они от
       прежнего адреса, и под новым им делать нечего. */
    if ('home_address' in one) {
      const office = officeAt(one.home_address);
      delete next.home_lat;
      delete next.home_lon;
      if (office) {
        next.home_lat = office.lat;
        next.home_lon = office.lon;
      }
    }
    posts[zone] = next;
  }
  edits.patch[source] = { ...was, ...patch, posts };

  if (patch.id && patch.id !== shownId) {
    delete edits.renamed[shownId];
    if (patch.id !== source) edits.renamed[patch.id] = source;
  }
  save();
}

export function removeCrew(shownId: string): void {
  const source = sourceIdOf(shownId);
  if (!edits.removed.includes(source)) edits.removed.push(source);
  save();
}

export function restoreCrew(shownId: string): void {
  const source = sourceIdOf(shownId);
  edits.removed = edits.removed.filter((one) => one !== source);
  delete edits.patch[source];
  delete edits.renamed[shownId];
  save();
}

export function clearCrewEdits(): void {
  edits = blank();
  save();
}

/** Накладывает правки на список инженеров зоны. Убранные из штата исчезают
    отсюда совсем: человек, которого в компании нет, не должен ни стоять в
    справочнике, ни получать заявки. */
export function applyCrew(crew: Engineer[]): Engineer[] {
  rememberOffices(crew);
  if (edits.removed.length === 0 && Object.keys(edits.patch).length === 0) return crew;
  return crew
    .filter((engineer) => !edits.removed.includes(engineer.id))
    .map((engineer) => {
      const patch = edits.patch[engineer.id];
      if (!patch) return engineer;

      const { posts, ...person } = patch;
      /* Правка участка ложится только на тот участок, которому она
         принадлежит: у человека их может быть два, и смена в них разная. */
      const post = engineer.zone ? posts?.[engineer.zone] : undefined;
      if (!post) return { ...engineer, ...person };

      /* Адрес поменяли, а координат в правке нет — правка сделана до того,
         как офис прочитался. Пробуем ещё раз сейчас: к этому времени он
         мог уже прийти. */
      const { home_lat, home_lon, ...rest } = post;
      const moved = 'home_address' in post && post.home_address !== engineer.home_address;
      const office =
        moved && home_lat === undefined ? officeAt(post.home_address) : null;
      const where =
        home_lat !== undefined && home_lon !== undefined
          ? { home_lat, home_lon }
          : office
            ? { home_lat: office.lat, home_lon: office.lon }
            : {};
      return { ...engineer, ...person, ...rest, ...where };
    });
}
