/* Сквозной поиск по всем базам.

   Раньше поиск в шапке смотрел внутрь открытого расчёта и знал две вещи:
   заявки и инженеров того дня, который сейчас на экране. Всё остальное —
   клиент, услуга, маршрут, соседний расчёт — в него не попадало, а на
   экранах баз данных он не отвечал вовсе: найденное клалось в правую
   панель, а её там нет. Диспетчер набирал фамилию, видел на экране две
   строки с этой фамилией и читал «ничего не нашлось».

   Теперь он ищет по справочникам — то есть по всему, что вообще есть, — и
   каждая находка ведёт в свою карточку. Вход у диспетчера один: ему звонят.
   Звонящий называет себя, адрес, номер наряда или фамилию инженера, который
   должен был приехать, — и любого из этих слов должно хватать.

   Телефон здесь наравне с номером: в выгрузке заказчика он есть у всех
   заявок и у всех инженеров, а искать по нему до сих пор было нельзя ни в
   одном месте программы. Набранный как угодно — «+7 977…», «8 977…»,
   «413-52-01» — он приводится к цифрам и сверяется хвостом: диспетчер
   читает номер с определителя, а не из справочника, и формат там свой. */

import type {
  ClientRecord,
  EngineerRecord,
  OrderRecord,
  Registry,
  RouteRecord,
  ServiceRecord
} from './registry.ts';
import { hhmm } from './derive.ts';

export type HitKind = 'order' | 'client' | 'engineer' | 'route' | 'service' | 'run';

export interface Hit {
  kind: HitKind;
  /** Ключ записи в справочнике: по нему находка открывается. */
  key: string;
  /** Номер, которым запись называют вслух. */
  code: string;
  title: string;
  meta: string;
  /** Чем запись совпала: «телефон», «адрес», «инженер». Диспетчеру нужно
      видеть не только что нашлось, но и почему — иначе строка с чужим на
      вид названием читается как промах поиска. */
  why: string;
  rank: number;
}

/** Сколько находок показываем. Больше десятка в выпадающем списке уже не
    читаются взглядом — за ними идут в саму базу, где есть отбор. */
export const FIND_LIMIT = 12;

/** Сколько находок одного рода. Без этого двести заявок с одной улицы
    вытеснили бы и клиента, и инженера, и маршрут. */
const PER_KIND = 4;

const norm = (text: string) => text.toLowerCase().replace(/ё/g, 'е');

/** Цифры номера без формата. Восьмёрку и семёрку в начале одиннадцатизначного
    отбрасываем: «8 977…» и «+7 977…» — один и тот же телефон. */
function digits(text: string): string {
  const only = text.replace(/\D/g, '');
  return only.length === 11 && (only[0] === '8' || only[0] === '7') ? only.slice(1) : only;
}

/** Как мог быть набран искомый номер.

    Диспетчер читает номер с определителя и бросает набирать на середине:
    «+7 977 413» — это семь цифр, из которых первая код страны, а хранится
    номер без неё. Поэтому недобранный номер сверяем в двух видах — как есть
    и без ведущей восьмёрки или семёрки. Полностью набранный приводится к
    одному виду сам и второго не требует. */
function phoneForms(raw: string): string[] {
  const only = digits(raw);
  if (only.length >= 11 || only.length < 4) return [only];
  const head = only[0];
  return head === '7' || head === '8' ? [only, only.slice(1)] : [only];
}

/* Запрос считается телефонным, когда в нём хотя бы четыре цифры подряд и
   ничего, кроме цифр и знаков телефонной записи. Четыре — это последние
   четыре цифры номера, которыми его чаще всего и называют. */
const PHONE_SHAPED = /^[\d\s+()\-.]+$/;

const isPhoneQuery = (raw: string) => PHONE_SHAPED.test(raw) && digits(raw).length >= 4;

/* Вес находки. Меньше — выше в списке. Точный номер всегда первым: если
   диспетчер набрал R0042 целиком, он знает, что ищет, и гадать за него не
   нужно. Дальше телефон, начало номера, начало названия и вхождение. */
const EXACT = 0;
const PHONE = 1;
const CODE_PREFIX = 2;
const TITLE_PREFIX = 3;
const TITLE_PART = 4;
const FIELD_PART = 5;

interface Probe {
  rank: number;
  why: string;
}

/** Сверяет запрос с полями записи и возвращает лучшее совпадение.

    `code` — номер, `title` — то, чем запись названа, `fields` — всё
    остальное, с подписью: подпись попадёт в строку находки и объяснит, за
    что запись сюда попала. */
function probe(
  query: string,
  code: string,
  title: string,
  fields: [string, string | null | undefined][]
): Probe | null {
  const lowCode = norm(code);
  const lowTitle = norm(title);
  /* «Совпал номер» говорим только там, где номер и есть номер. У услуги код
     вида работ — это её название словом, и подпись «номер» под словом
     «Авария» объясняла бы ровно ничего. */
  const codeWhy = lowCode === lowTitle ? '' : 'номер';
  if (lowCode === query) return { rank: EXACT, why: codeWhy };

  if (lowTitle === query) return { rank: EXACT, why: '' };
  if (lowCode.startsWith(query)) return { rank: CODE_PREFIX, why: codeWhy };
  if (lowTitle.startsWith(query)) return { rank: TITLE_PREFIX, why: '' };
  if (lowTitle.includes(query)) return { rank: TITLE_PART, why: '' };

  for (const [label, value] of fields) {
    if (!value) continue;
    if (norm(value).includes(query)) return { rank: FIELD_PART, why: label };
  }
  return null;
}

/** Сверяет телефоны записи с набранными цифрами. */
function probePhone(forms: string[], phones: [string, string | null | undefined][]): Probe | null {
  for (const [label, value] of phones) {
    if (!value) continue;
    const known = digits(value);
    if (known && forms.some((form) => form.length >= 4 && known.includes(form))) {
      return { rank: PHONE, why: label };
    }
  }
  return null;
}

const orderHit = (order: OrderRecord, found: Probe): Hit => ({
  kind: 'order',
  key: order.key,
  code: order.id,
  title: order.workTitle,
  meta:
    `${order.address} · расчёт ${order.run.code}` +
    (order.engineerName ? ` · ${order.engineerName}` : ' · без инженера'),
  why: found.why,
  rank: found.rank
});

const clientHit = (client: ClientRecord, found: Probe): Hit => ({
  kind: 'client',
  key: client.key,
  code: client.code,
  title: client.company,
  meta: `${client.address} · ${client.district} · ${client.orders} заявок`,
  why: found.why,
  rank: found.rank
});

const engineerHit = (engineer: EngineerRecord, found: Probe): Hit => ({
  kind: 'engineer',
  key: engineer.id,
  code: engineer.code,
  title: engineer.name,
  /* У программы расчёта номера E00…E13 и имена по шаблону одни и те же на
     каждом участке: без участка три строки «Артём Белов E00» не различить.
     Составной ключ («участок:номер») — признак именно такого инженера. */
  meta:
    (engineer.id.includes(':') && engineer.zone ? `${engineer.zone} · ` : '') +
    `смена ${hhmm(engineer.shiftStart)}–${hhmm(engineer.shiftEnd)} · ` +
    `${engineer.visits} заявок в ${engineer.runs} расчётах`,
  why: found.why,
  rank: found.rank
});

const routeHit = (route: RouteRecord, found: Probe): Hit => ({
  kind: 'route',
  key: route.key,
  code: route.code,
  title: route.engineerName,
  meta:
    `расчёт ${route.run.code} · ${route.visits} заявок · ` +
    `${hhmm(route.start)}–${hhmm(route.end)}`,
  why: found.why,
  rank: found.rank
});

const serviceHit = (service: ServiceRecord, found: Probe): Hit => ({
  kind: 'service',
  key: service.key,
  code: service.key,
  title: service.title,
  meta: `${service.orders} заявок · ${service.minutes} мин`,
  why: found.why,
  rank: found.rank
});

/** Ищет по всем справочникам сразу.

    Запрос короче двух знаков не ищем: по одной букве находится половина
    базы, и список подсказок становится шумом. Исключение — цифры: «12» это
    уже осмысленный хвост номера. */
export function findAll(registry: Registry | null, raw: string): Hit[] {
  const query = norm(raw.trim());
  if (!registry || query.length < 2) return [];

  const phone = isPhoneQuery(raw.trim()) ? phoneForms(raw.trim()) : null;
  const found: Hit[] = [];

  for (const order of registry.orders) {
    const hit = phone
      ? probePhone(phone, [['телефон', order.contactPhone]])
      : probe(query, order.id, order.workTitle, [
          ['адрес', order.address],
          ['клиент', order.company],
          ['контакт', order.contactName],
          ['инженер', order.engineerName],
          ['маршрут', order.routeCode],
          ['расчёт', order.run.code],
          ['район', order.district],
          ['навык', order.skill]
        ]);
    if (hit) found.push(orderHit(order, hit));
  }

  for (const client of registry.clients) {
    const hit = phone
      ? null
      : probe(query, client.code, client.company, [
          ['адрес', client.address],
          ['район', client.district]
        ]);
    if (hit) found.push(clientHit(client, hit));
  }

  for (const engineer of registry.engineers) {
    const hit = phone
      ? probePhone(phone, [['телефон', engineer.phone]])
      : probe(query, engineer.code, engineer.name, [
          ['бригада', engineer.team],
          ['участок', engineer.zone],
          ['выезжает из', engineer.homeAddress],
          ['навык', engineer.skills.join(' ')]
        ]);
    if (hit) found.push(engineerHit(engineer, hit));
  }

  for (const route of registry.routes) {
    const hit = phone
      ? null
      : probe(query, route.code, route.engineerName, [
          ['табельный', route.engineerId],
          ['расчёт', route.run.code],
          ['район', route.districts.join(' ')],
          /* Номер заявки в маршруте: «в каком маршруте ехала R0052» — вопрос,
             на который до сих пор не отвечало ни одно место программы. */
          ['заявка', route.orderIds.join(' ')]
        ]);
    if (hit) found.push(routeHit(route, hit));
  }

  for (const service of registry.services) {
    const hit = phone
      ? null
      : probe(query, service.key, service.title, [
          ['навык', service.skill],
          ['оборудование', service.equipment.join(' ')]
        ]);
    if (hit) found.push(serviceHit(service, hit));
  }

  for (const run of registry.runs) {
    const hit = phone ? null : probe(query, run.code, run.code, [['дата', run.date], ['заметка', run.note]]);
    if (hit) {
      found.push({
        kind: 'run',
        key: run.id,
        code: run.code,
        title: `Расчёт ${run.code}`,
        meta: `${run.date} · заведён ${run.created.replace('T', ', ')}`,
        why: hit.why,
        rank: hit.rank
      });
    }
  }

  /* Сортируем по весу, при равном — по номеру: одинаково подходящие записи
     должны идти в том же порядке, что и в базе, а не в порядке перебора. */
  found.sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code, 'ru'));

  /* Потолок на род держим после сортировки: в первую четвёрку заявок должны
     попасть лучшие, а не первые попавшиеся. */
  const taken = new Map<HitKind, number>();
  const shown: Hit[] = [];
  for (const hit of found) {
    const count = taken.get(hit.kind) ?? 0;
    if (count >= PER_KIND) continue;
    taken.set(hit.kind, count + 1);
    shown.push(hit);
    if (shown.length >= FIND_LIMIT) break;
  }
  return shown;
}

/** Как род записи называется в заголовке группы. */
export const KIND_TITLE: Record<HitKind, string> = {
  order: 'Заявки',
  client: 'Клиенты',
  engineer: 'Инженеры',
  route: 'Маршруты',
  service: 'Услуги',
  run: 'Расчёты'
};

/** Знак рода записи — тот же, что у раздела в меню. */
export const KIND_ICON: Record<HitKind, string> = {
  order: 'clipboard-list',
  client: 'user',
  engineer: 'users',
  route: 'path',
  service: 'wrench',
  run: 'stack'
};

/** Порядок групп в списке находок: сперва то, за чем приходят чаще. */
export const KIND_ORDER: HitKind[] = ['order', 'client', 'engineer', 'route', 'service', 'run'];
