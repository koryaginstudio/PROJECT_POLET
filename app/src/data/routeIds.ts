/* Номера маршрутов.

   Маршрут в контракте своего номера не имеет: движок отдаёт его парой
   «расчёт + инженер», и внутри каждого плана маршруты идут с первого. Пока на
   маршрут смотрели только внутри его расчёта, этого хватало. Как только
   маршруты собраны в базу по всем расчётам сразу, оказывается, что первый
   маршрут есть и в R001, и в R003, — и сказать «маршрут 01» в такой базе
   значит не сказать ничего.

   Поэтому номер выдаём мы, и выдаём один раз на маршрут: M0001, M0002 и
   дальше подряд по всей базе. Номер не привязан к номеру расчёта и не
   начинается заново в каждом новом плане — он опознаёт именно маршрут, как
   номер заказа опознаёт заказ.

   Однажды выданный номер закреплён навсегда: он записан рядом с ключом
   маршрута и переживает перезагрузку. Удалённый расчёт свои номера уносит с
   собой — заново они никому не выдаются, и в нумерации остаётся пропуск. Это
   правильно: пропуск честнее, чем номер, под которым вчера был один маршрут,
   а сегодня другой.

   Хранится в браузере, рядом с остальным, что рабочее место помнит о себе
   само: правками записей и заводскими значениями движка. Движок про эти
   номера не знает — до тех пор, пока не начнёт отдавать свои. */

const STORE_KEY = 'polet.routeIds.v1';

interface Ledger {
  /** Следующий свободный номер. Выданные не переиспользуются. */
  next: number;
  /** Ключ маршрута «расчёт:инженер» → выданный номер. */
  byKey: Record<string, number>;
}

const EMPTY: Ledger = { next: 1, byKey: {} };

let ledger: Ledger | null = null;

function read(): Ledger {
  if (ledger) return ledger;
  if (typeof localStorage === 'undefined') {
    ledger = { ...EMPTY, byKey: {} };
    return ledger;
  }
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Ledger>) : null;
    ledger =
      parsed && typeof parsed.next === 'number' && parsed.byKey
        ? { next: parsed.next, byKey: { ...parsed.byKey } }
        : { ...EMPTY, byKey: {} };
  } catch {
    /* Запись испортилась — начинаем чистую. Потерянные номера хуже, чем
       упавший экран базы, но выбор здесь только такой. */
    ledger = { ...EMPTY, byKey: {} };
  }
  return ledger;
}

function write(next: Ledger) {
  ledger = next;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    /* Места нет или запись запрещена: номера доживут до перезагрузки в
       памяти, и это лучше, чем отказать базе в показе. */
  }
}

/** Как номер выглядит для человека: M0001. Четыре знака — с запасом на базу
    в тысячи маршрутов; дальше номер просто станет длиннее, а не переполнится. */
export const routeLabel = (number: number) => 'M' + String(number).padStart(4, '0');

/** Ключ маршрута: расчёт и инженер опознают его в контракте однозначно. */
export const routeKey = (runId: string, engineerId: string) => `${runId}:${engineerId}`;

/** Номер маршрута. Новому выдаётся следующий свободный, известному
    возвращается его собственный — тот же самый и через месяц.

    Порядок выдачи задаёт тот, кто зовёт: база собирает маршруты от старых
    расчётов к свежим, и номера ложатся в том же порядке. */
export function routeNumber(runId: string, engineerId: string): number {
  const key = routeKey(runId, engineerId);
  const store = read();
  const known = store.byKey[key];
  if (known) return known;
  const number = store.next;
  write({ next: number + 1, byKey: { ...store.byKey, [key]: number } });
  return number;
}

/** Номера сразу для целого списка маршрутов: одна запись на всю базу вместо
    записи на каждый маршрут. Порядок списка и есть порядок выдачи. */
export function routeNumbers(keys: { runId: string; engineerId: string }[]): number[] {
  const store = read();
  const byKey = { ...store.byKey };
  let next = store.next;
  let added = false;
  const numbers = keys.map(({ runId, engineerId }) => {
    const key = routeKey(runId, engineerId);
    if (!byKey[key]) {
      byKey[key] = next;
      next += 1;
      added = true;
    }
    return byKey[key];
  });
  if (added) write({ next, byKey });
  return numbers;
}
