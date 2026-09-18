/* Вводные смены: то, что диспетчер решил про этот день поверх выгрузки.

   Выгрузка говорит, кто числится в штате и какие наряды заведены. Утро
   говорит другое: один заболел, у второго сегодня нет инструмента для
   линейных работ, а в восемь позвонили и попросили приехать ещё по одному
   адресу. Расчёт обязан считать по второму, а не по первому.

   Раньше всё это собиралось в форме нового расчёта и там же оставалось:
   до движка доезжали только переменные и номер зоны, а состав смены,
   снятые навыки и дописанные заявки в расчёт не попадали. Форма при этом
   молчала, и диспетчер узнавал об этом только по плану, где снятый с
   работы человек развозит заявки.

   Вводные хранятся вместе с записью расчёта, а не только в форме. День
   пересчитывается по зоне и переменным каждый раз, когда его открывают, и
   без сохранённых вводных повторный расчёт разошёлся бы с тем, что
   диспетчер видел утром. */

import type { Engineer, Order } from './contract.ts';
/* Только тип: он описан рядом с чтением зоны, а не в контракте, и ввозится
   как тип, чтобы модули не замкнулись друг на друга в сборке. */
import type { ZoneData } from './load.ts';

/** Заявка, которую диспетчер завёл руками поверх выгрузки. */
export interface ExtraOrder {
  id: string;
  address: string;
  workTitle: string;
  windowStart: number;
  windowEnd: number;
  minutes: number;
  urgent: boolean;
}

/** Вводные одного расчёта. Все поля необязательные: пустые вводные — это
    «считаем выгрузку как есть», обычный случай. */
export interface ShiftInput {
  /** Табельные тех, кто сегодня в смене. Пусто — в смене все из выгрузки. */
  engineers?: string[];
  /** Навыки, снятые у конкретных инженеров на этот расчёт. */
  skillsOff?: Record<string, string[]>;
  /** Заявки, заведённые поверх выгрузки. */
  extra?: ExtraOrder[];
}

/** Есть ли во вводных хоть что-нибудь. Пустые в запись не пишем: они ничего
    не меняют, а в хранилище и в ключе кеша только шумят. */
export const hasShiftInput = (shift?: ShiftInput | null): boolean =>
  !!shift &&
  ((shift.engineers?.length ?? 0) > 0 ||
    Object.keys(shift.skillsOff ?? {}).length > 0 ||
    (shift.extra?.length ?? 0) > 0);

/** Короткая подпись вводных: чем этот расчёт отличается от чистой выгрузки.
    Её показывают в карточке расчёта и в форме — чтобы вводные было видно
    не только в момент, когда их задавали. */
export function shiftSummary(shift: ShiftInput | undefined, staff: number): string[] {
  if (!hasShiftInput(shift)) return [];
  const parts: string[] = [];
  const onShift = shift?.engineers?.length ?? 0;
  if (onShift > 0 && staff > 0 && onShift < staff) {
    parts.push(`в смене ${onShift} из ${staff}`);
  }
  const off = Object.values(shift?.skillsOff ?? {}).reduce((sum, list) => sum + list.length, 0);
  if (off > 0) parts.push(`снято навыков: ${off}`);
  const extra = shift?.extra?.length ?? 0;
  if (extra > 0) parts.push(`заявок сверх выгрузки: ${extra}`);
  return parts;
}

/** Ключ вводных для кеша плана. Один и тот же день с одними и теми же
    вводными считается один раз, с разными — по разу на каждые. */
export function shiftKey(shift?: ShiftInput | null): string {
  if (!hasShiftInput(shift)) return '';
  const crew = [...(shift?.engineers ?? [])].sort().join(',');
  const off = Object.entries(shift?.skillsOff ?? {})
    .map(([id, list]) => `${id}:${[...list].sort().join('+')}`)
    .sort()
    .join(',');
  const extra = (shift?.extra ?? [])
    .map((one) => `${one.id}@${one.address}|${one.windowStart}-${one.windowEnd}|${one.minutes}|${one.urgent ? 1 : 0}`)
    .join(',');
  return `${crew}/${off}/${extra}`;
}

/* Адрес, набранный руками, координат не несёт, а маршрут без координат не
   строится. Ищем адрес среди тех, что уже есть в зоне: повторный выезд по
   знакомому дому — обычное дело, и тогда точка встаёт ровно там, где стояла
   в прошлый раз. Сравниваем по осмысленной части строки, без города и
   регистра: «ул. Тверская, 12» и «Москва, Тверская улица, 12» — один дом.

   Незнакомый адрес ставим в середину зоны. Это приблизительно, и лучше
   приблизительно, чем никак: заявка участвует в расчёте, видна на карте и
   занимает у инженера время — а точную точку диспетчер поправит, когда
   адрес приедет из учётной системы вместе с координатами. */
const NOISE = /(город|москва|улица|ул\.|проспект|просп\.|пр-т|переулок|пер\.|шоссе|ш\.|набережная|наб\.|проезд|бульвар|б-р|площадь|пл\.)/g;

const addressKey = (text: string) =>
  text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(NOISE, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();

function placeExtra(address: string, orders: Order[]): { lat: number; lon: number } {
  const needle = addressKey(address);
  if (needle) {
    const hit = orders.find((order) => {
      const known = addressKey(order.address ?? '');
      return known !== '' && (known === needle || known.includes(needle) || needle.includes(known));
    });
    if (hit) return { lat: hit.lat, lon: hit.lon };
  }
  if (orders.length === 0) return { lat: 0, lon: 0 };
  const lat = orders.reduce((sum, one) => sum + one.lat, 0) / orders.length;
  const lon = orders.reduce((sum, one) => sum + one.lon, 0) / orders.length;
  return { lat, lon };
}

/** Собирает заявку из того, что диспетчер набрал руками.

    Форма спрашивает адрес, работу, окно, длительность и «авария или нет» —
    ровно то, без чего заявку не разложить. Остальное выводится: авария это
    срочный наряд аварийного навыка, всё прочее — подключение. Вид работ
    берём тем же словом, каким диспетчер назвал работу: в выгрузке заказчика
    код вида работ и его название и так совпадают, а незнакомый код
    справочник показывает как есть. */
function buildExtra(one: ExtraOrder, zone: ZoneData): Order {
  const where = placeExtra(one.address, zone.orders);
  /* Район берём у ближайшей по адресу заявки: он нужен отбору и подписям, а
     выдумывать своё название значило бы завести девятнадцатый район. */
  const near = zone.orders.find((order) => order.lat === where.lat && order.lon === where.lon);
  const title = one.workTitle.trim() || (one.urgent ? 'Авария' : 'Заявка на подключение');
  return {
    id: one.id,
    work_type: title,
    work_title: title,
    skill: one.urgent ? 'emergency' : 'connect',
    district: near?.district ?? zone.orders[0]?.district ?? '—',
    address: one.address.trim() || null,
    lat: where.lat,
    lon: where.lon,
    window_start: one.windowStart,
    window_end: one.windowEnd,
    /* Крайний срок у заведённой руками заявки — конец её окна: диспетчер
       назвал время, к которому обещал приехать, и другого срока у неё нет. */
    sla_deadline: one.windowEnd,
    priority: one.urgent ? 3 : 1,
    est_minutes: one.minutes,
    needs_access: false,
    assigned_to: null,
    order_class: one.urgent ? 'outage' : 'connection',
    priority_class: one.urgent ? 'urgent' : 'normal',
    status: 'sent',
    required_transport: null,
    required_equipment: [],
    tech: null,
    gigabit: null,
    contact: null,
    locked_to: null,
    assigned_by: 'dispatcher',
    unassigned_reason: null
  };
}

/** Накладывает вводные смены на данные зоны.

    Снятый со смены человек не исчезает, а становится `off_shift`: он есть в
    штате, просто сегодня не работает. Так честнее и так же считает сам
    планировщик — «всего инженеров» остаётся прежним, а заявки ему не идут.
    Исчезни он совсем, и число инженеров в расчёте молча разошлось бы с
    числом в базе. */
export function applyShift(zone: ZoneData, shift?: ShiftInput | null): ZoneData {
  if (!hasShiftInput(shift)) return zone;

  const onShift = shift?.engineers ? new Set(shift.engineers) : null;
  const skillsOff = shift?.skillsOff ?? {};

  const engineers: Engineer[] = zone.engineers.map((engineer) => {
    const off = skillsOff[engineer.id];
    const benched = onShift !== null && !onShift.has(engineer.id);
    if (!off?.length && !benched) return engineer;
    return {
      ...engineer,
      status: benched ? 'off_shift' : (engineer.status ?? 'on_shift'),
      skills: off?.length ? engineer.skills.filter((skill) => !off.includes(skill)) : engineer.skills
    };
  });

  /* Дописанная заявка с уже занятым номером заменяет прежнюю, а не встаёт
     рядом: два наряда под одним номером диспетчер не различит ни в списке,
     ни вслух. */
  const extra = shift?.extra ?? [];
  const taken = new Set(extra.map((one) => one.id));
  const orders: Order[] = [
    ...zone.orders.filter((order) => !taken.has(order.id)),
    ...extra.map((one) => buildExtra(one, zone))
  ];

  return { ...zone, engineers, orders };
}
