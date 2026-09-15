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

/** Что человеку разрешено править. Табельный номер, участок и точка выезда
    сюда не входят: номер — то, чем человека сводят между расчётами, а
    участок с офисом приходят из дня и человеку не принадлежат. */
export interface CrewPatch {
  name?: string;
  phone?: string | null;
  transport?: string | null;
  status?: string | null;
  skills?: string[];
  shift_start?: number;
  shift_end?: number;
}

interface CrewEdits {
  patch: Record<string, CrewPatch>;
  /** Табельные тех, кого убрали из штата. */
  removed: string[];
}

const STORE_KEY = 'polet.crew-edits.v1';

const EMPTY: CrewEdits = { patch: {}, removed: [] };

function read(): CrewEdits {
  if (typeof localStorage === 'undefined') return { ...EMPTY, patch: {}, removed: [] };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...EMPTY, patch: {}, removed: [] };
    const parsed = JSON.parse(raw) as Partial<CrewEdits>;
    return {
      patch: parsed.patch ?? {},
      removed: Array.isArray(parsed.removed) ? parsed.removed : []
    };
  } catch {
    return { ...EMPTY, patch: {}, removed: [] };
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

/** Убран ли человек из штата. */
export const crewRemoved = (id: string) => edits.removed.includes(id);

/** Правка, наложенная на человека. Пусто — его не трогали. */
export const crewPatch = (id: string): CrewPatch | undefined => edits.patch[id];

/** Сколько правок держит браузер. */
export const crewEditCount = () => Object.keys(edits.patch).length + edits.removed.length;

export function editCrew(id: string, patch: CrewPatch): void {
  edits.patch[id] = { ...edits.patch[id], ...patch };
  save();
}

export function removeCrew(id: string): void {
  if (!edits.removed.includes(id)) edits.removed.push(id);
  save();
}

export function restoreCrew(id: string): void {
  edits.removed = edits.removed.filter((one) => one !== id);
  delete edits.patch[id];
  save();
}

export function clearCrewEdits(): void {
  edits = { patch: {}, removed: [] };
  save();
}

/** Накладывает правки на список инженеров зоны. Убранные из штата исчезают
    отсюда совсем: человек, которого в компании нет, не должен ни стоять в
    справочнике, ни получать заявки. */
export function applyCrew(crew: Engineer[]): Engineer[] {
  if (edits.removed.length === 0 && Object.keys(edits.patch).length === 0) return crew;
  return crew
    .filter((engineer) => !edits.removed.includes(engineer.id))
    .map((engineer) => {
      const patch = edits.patch[engineer.id];
      return patch ? { ...engineer, ...patch } : engineer;
    });
}
