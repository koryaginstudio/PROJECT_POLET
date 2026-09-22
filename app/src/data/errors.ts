/* Ошибка — человеку: что случилось и что делать.

   До этого на экран уходил `failure.message` как есть: «Движок ответил 409»,
   «Failed to fetch», «plan: схема 2.0…». Диспетчеру это ничего не говорит —
   ни что сломалось, ни что нажать. Здесь каждое известное нам падение
   переводится в две фразы: заголовок («Программа расчёта не отвечает») и
   совет («Проверьте, что она запущена, и повторите»). Техническая строка
   не теряется — она уходит в `detail` и показывается под «Подробности»:
   её прочтёт тот, кто будет чинить.

   Разбор идёт по виду ошибки и коду ответа, а не по тексту сообщения:
   текст движок волен переписать, а код и вид — часть контракта. */

import { EngineError } from './api.ts';

/* `ContractError` узнаём по имени, а не через `instanceof`: он живёт в
   load.ts, а load.ts сам берёт отсюда `HumanRefusal` — импорт в обе стороны
   был бы кольцом. */
const isContractError = (e: unknown): e is Error =>
  e instanceof Error && e.name === 'ContractError';

export interface HumanError {
  /** Что случилось — одной фразой. */
  title: string;
  /** Что делать. */
  hint: string;
  /** Техническое: ответ сервера, код, строка исключения. Может быть пустым. */
  detail: string;
}

/** Отказ, который уже сказан словами человеку: разбирать его незачем.
    Им отвечают места, где интерфейс сам знает, почему не может, — «этот
    набор программа расчёта не считает», — вместо подстановки чего попало. */
export class HumanRefusal extends Error {
  constructor(readonly title: string, readonly hint: string) {
    super(`${title}. ${hint}`);
    this.name = 'HumanRefusal';
  }
}

/** Что сказать, если ошибка нам незнакома. Экран, который её ловит, знает
    свой случай лучше: «Экран не открылся» у защиты от падения, «Событие не
    записалось» у журнала. */
export type Fallback = Pick<HumanError, 'title' | 'hint'>;

const UNKNOWN: Fallback = {
  title: 'Не получилось',
  hint: 'Повторите ещё раз. Если не поможет — обновите страницу.'
};

const OFFLINE: Fallback = {
  title: 'Программа расчёта не отвечает',
  hint: 'Проверьте, что она запущена, и повторите.'
};

const TIMEOUT: Fallback = {
  title: 'Программа расчёта не успела ответить',
  hint: 'Она занята долгим расчётом. Подождите минуту и повторите.'
};

/** По коду ответа. Ключи — то, чем движок отвечает по контракту
    (vrptw/CONTRACT.md): 400 — не принял запрос, 404 — записи нет,
    409 — показанный план устарел. */
function byStatus(status: number | null): Fallback | null {
  if (status === 400) {
    return {
      title: 'Программа расчёта не приняла запрос',
      hint: 'Проверьте выбранные значения и повторите. Причина — в «Подробностях».'
    };
  }
  if (status === 404) {
    return {
      title: 'Расчёт не найден в архиве',
      hint: 'Его могли удалить или архив начали заново. Откройте другой расчёт из списка.'
    };
  }
  if (status === 409) {
    return {
      title: 'План устарел: пересчитайте заново',
      hint: 'После показа пересчёта в дне что-то изменилось. Нажмите «Пересчитать» и примите новый вариант.'
    };
  }
  if (status !== null && status >= 500) {
    return {
      title: 'В программе расчёта произошла ошибка',
      hint: 'Повторите через минуту. Если не поможет — перезапустите её и передайте администратору «Подробности».'
    };
  }
  return null;
}

/** Свои слова для кода ответа — у места, которое знает свой случай лучше.
    409 при «Принять» значит «пересчитайте и примите», а при «Сохранить» —
    «пересчитайте и сохраните»: одна подсказка на оба сбивала бы с толку. */
export type ByStatus = Partial<Record<number, Fallback>>;

const text = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e ?? ''));

/** Переводит пойманное в две фразы для человека и строку для того, кто чинит. */
export function humanError(
  e: unknown,
  fallback: Fallback = UNKNOWN,
  statuses: ByStatus = {}
): HumanError {
  if (e instanceof HumanRefusal) return { title: e.title, hint: e.hint, detail: '' };

  if (e instanceof EngineError) {
    const detail = e.status !== null ? `${e.status}: ${e.message}` : e.message;
    if (e.failure === 'offline') return { ...OFFLINE, detail };
    if (e.failure === 'timeout') return { ...TIMEOUT, detail };
    if (e.failure === 'garbled') {
      return {
        title: 'Программа расчёта ответила непонятно',
        hint: 'Обновите страницу. Если повторится — передайте администратору «Подробности».',
        detail
      };
    }
    const own = e.status !== null ? statuses[e.status] : undefined;
    return { ...(own ?? byStatus(e.status) ?? fallback), detail };
  }

  if (isContractError(e)) {
    return {
      title: 'Данные расчёта пришли не в том виде',
      hint: 'Откройте другой расчёт или обновите страницу. Если повторится — передайте администратору «Подробности».',
      detail: e.message
    };
  }

  /* Мимо `call`: сеть упала у `fetch` напрямую — браузер говорит об этом
     TypeError, а истёкший срок — TimeoutError. */
  const name = (e as { name?: string } | null)?.name;
  if (name === 'TimeoutError') return { ...TIMEOUT, detail: text(e) };
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    return {
      title: 'Нет связи',
      hint: 'Проверьте сеть и что программа расчёта запущена, затем повторите.',
      detail: text(e)
    };
  }

  return { ...fallback, detail: text(e) };
}

/** Заголовок с точкой в конце — если своего знака там ещё нет. Одно правило
    для строки и для DayFail: иначе они разойдутся («…заново..»). */
export function titleWithStop(title: string): string {
  return /[.!?:…]$/.test(title) ? title : `${title}.`;
}

/** То же одной строкой — для мест, где под ошибку отведена строка текста. */
export function humanLine(e: unknown, fallback?: Fallback, statuses?: ByStatus): string {
  const { title, hint } = humanError(e, fallback, statuses);
  return `${titleWithStop(title)} ${hint}`;
}

/** Строка после своего заголовка места («<b>Сравнение не сохранилось.</b> …»):
    у знакомой ошибки — её заголовок и совет, у незнакомой — один совет.
    Свой заголовок в запасном варианте повторил бы заголовок места:
    «Сохранить не вышло. Запись не сохранилась. …». */
export function humanAfter(
  e: unknown,
  hint: string,
  statuses?: ByStatus
): { text: string; detail: string } {
  const human = humanError(e, { title: '', hint }, statuses);
  return {
    text: human.title ? `${titleWithStop(human.title)} ${human.hint}` : human.hint,
    detail: human.detail
  };
}
