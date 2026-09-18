/* Номера клиентов.

   Клиента в контракте нет вовсе: заказчик описан точкой обслуживания — адрес
   дома, район, окно приёма. Пока на точку смотрели в её собственной строке,
   адреса хватало. Как только клиента понадобилось называть — найти инженера,
   который к нему ездил, сослаться на него в разговоре, — оказалось, что
   называть его нечем: «Москва, улица Верхние Поля, 38к2» в поиск не наберёшь,
   а порядковый номер в списке меняется от сортировки и означает лишь «третий
   сверху при этом отборе».

   Поэтому номер выдаём мы, и выдаём один раз на адрес: C0001, C0002 и дальше
   подряд по всей базе. Устроено это ровно как у маршрутов — см.
   `routeIds.ts`, — и по той же причине: номер должен опознавать саму запись, а
   не её место в сегодняшней выборке.

   Однажды выданный номер закреплён навсегда и переживает перезагрузку. Адрес,
   пропавший из данных, свой номер уносит с собой: пропуск в нумерации честнее,
   чем номер, под которым вчера был один дом, а сегодня другой. */

const STORE_KEY = 'polet.clientIds.v1';

interface Ledger {
  /** Следующий свободный номер. Выданные не переиспользуются. */
  next: number;
  /** Ключ точки (её адрес) → выданный номер. */
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
    /* Запись испортилась — начинаем чистую. */
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

/** Как номер выглядит для человека: C0001. Четыре знака — с запасом: адресов
    в базе две сотни, и тысячи она переживёт, не переполнившись. */
export const clientLabel = (number: number) => 'C' + String(number).padStart(4, '0');

/** Номера сразу для всех точек базы: новым выдаются следующие свободные,
    известным возвращаются их собственные — те же самые и через месяц.

    Пачкой, а не по одной: сотня адресов — это сотня записей в хранилище
    браузера, если выдавать их поштучно, и каждая перезаписывает весь реестр
    целиком.

    Порядок выдачи задаёт тот, кто зовёт: база собирает адреса по всем
    расчётам сразу и в одном и том же порядке, поэтому первый увиденный адрес
    и получает C0001. */
export function clientNumbers(keys: string[]): Map<string, number> {
  const store = read();
  const byKey = { ...store.byKey };
  let next = store.next;
  let added = false;

  const out = new Map<string, number>();
  for (const key of keys) {
    if (!byKey[key]) {
      byKey[key] = next;
      next += 1;
      added = true;
    }
    out.set(key, byKey[key]);
  }

  if (added) write({ next, byKey });
  return out;
}
