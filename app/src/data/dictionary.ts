/* Словари известных кодов справочников. Здесь нет ни одного жёсткого списка:
   неизвестный код показывается как есть и получает нейтральную иконку.
   Перечисляем то, что пришло в файле, а словарь лишь украшает знакомое.

   С 1.2 у словаря два слоя. Нижний — встроенный, он здесь ниже: коды, которые
   заданы самим ТЗ, и коды, пришедшие из выгрузки заказчика. Верхний —
   `dictionaries.json`, пятая форма контракта: если она пришла, подписи берутся
   оттуда. Так состав справочников задают данные, а не код интерфейса, — в
   выгрузке восемнадцать типов работ, и предугадать их список нельзя. */

import type { Dictionaries } from './contract.ts';

/* ─── верхний слой: подписи из контракта ─────────────────────────────────── */

let loaded: Dictionaries | null = null;

/** Принять справочники расчёта. `null` — вернуться на встроенные подписи.
    Зовётся при загрузке дня, до первой отрисовки. */
export function useDictionaries(next: Dictionaries | null | undefined): void {
  loaded = next ?? null;
}

/** Подпись к коду: сначала то, что пришло с данными, потом встроенное, потом
    сам код. Последнее — не заглушка, а осознанный выход: показать незнакомый
    код честнее, чем спрятать его за «прочее». */
function label(section: keyof Dictionaries, key: string, builtin: Record<string, string>): string {
  const outer = loaded?.[section] as Record<string, string> | undefined;
  return outer?.[key] ?? builtin[key] ?? key;
}

/* ─── типы работ и навыки ────────────────────────────────────────────────── */

const WORK_TYPE_ICONS: Record<string, string> = {
  install: 'plus',
  repair: 'wrench',
  diag: 'gauge',
  cpe: 'layers',
  line: 'route'
};

/* Навыки двух поколений сразу. `install`/`repair`/`line` — то, чем считает
   сегодняшний движок; `connect`/`local`/`emergency` — справочник ТЗ, и он же
   ложится на колонку «Тип заявки BK» в выгрузке один в один. Пока движок не
   перешёл на второй, в данных встречается первый, и знать интерфейс обязан
   оба. */
const SKILL_ICONS: Record<string, string> = {
  install: 'plus',
  repair: 'wrench',
  line: 'route',
  connect: 'plus',
  local: 'wrench',
  emergency: 'lightning'
};

const SKILL_NAMES: Record<string, string> = {
  install: 'Подключение',
  repair: 'Ремонт',
  line: 'Линейные работы',
  connect: 'Работы на подключение и дозаказы',
  local: 'Локальные работы',
  emergency: 'Аварийные работы'
};

/* Короткая подпись навыка для тесных мест — кнопки в полосе отбора. Сокращено
   ровно одно значение из трёх: «Работы на подключение и дозаказы» не влезает
   в ряд кнопок и переносится на вторую строку, остальные влезают и трогать их
   незачем. Полное название справочника стоит шапкой в самом списке. */
const SKILL_SHORT: Record<string, string> = {
  connect: 'Подключения и дозаказы'
};

/* Порядок навыков — от основного потока к редкому: подключения и конвергенция
   идут сотнями, локальные работы десятками, аварии единичны. По нему стоят
   группы видов работ в полосе отбора. Незнакомый навык уходит в конец, а не
   втискивается в середину: где его место, данные не говорят. */
const SKILL_ORDER = ['connect', 'local', 'emergency'];

export const workTypeIcon = (key: string) => WORK_TYPE_ICONS[key] ?? 'clipboard-list';
export const skillIcon = (key: string) => SKILL_ICONS[key] ?? 'wrench';
export const skillName = (key: string) => label('skills', key, SKILL_NAMES);
export const skillShort = (key: string) => SKILL_SHORT[key] ?? skillName(key);
export const skillRank = (key: string) => {
  const index = SKILL_ORDER.indexOf(key);
  return index === -1 ? SKILL_ORDER.length : index;
};
export const workTypeName = (key: string, title?: string) =>
  (loaded?.work_types?.[key] ?? title ?? key);

/* ─── приоритет ──────────────────────────────────────────────────────────── */

/* Приоритет приходит числом. Слово рядом — только подпись к порядку,
   неизвестный уровень показывается как есть. */
const PRIORITY_NAMES: Record<string, string> = {
  '0': 'Базовый',
  '1': 'Средний',
  '2': 'Высокий'
};

export const priorityName = (n: number) => PRIORITY_NAMES[String(n)] ?? `уровень ${n}`;

const PRIORITY_CLASS_NAMES: Record<string, string> = {
  normal: 'Обычная',
  urgent: 'Срочная'
};

/** Приоритет словами ТЗ. Поле `priority_class` необязательное: движок 1.1 его
    не отдаёт, и тогда работает правило вывода из контракта — от второго уровня
    и выше заявка считается срочной. */
export function priorityClassName(cls: string | null | undefined, priority: number): string {
  const key = cls ?? (priority >= 2 ? 'urgent' : 'normal');
  return PRIORITY_CLASS_NAMES[key] ?? key;
}

export const isUrgent = (cls: string | null | undefined, priority: number) =>
  (cls ?? (priority >= 2 ? 'urgent' : 'normal')) === 'urgent';

/* ─── транспорт ──────────────────────────────────────────────────────────── */

const TRANSPORT_NAMES: Record<string, string> = {
  car: 'Автомобиль',
  walk: 'Пешеход',
  bike: 'Велосипед',
  transit: 'Общественный транспорт'
};

/* Свой значок на каждый из четырёх типов: раньше у пешего стоял «человек», а
   у общественного транспорта — «люди», и в ряду карточек оба читались как
   один и тот же символ на двух разных инженерах. */
const TRANSPORT_ICONS: Record<string, string> = {
  car: 'car',
  walk: 'person-walk',
  bike: 'bicycle',
  transit: 'bus'
};

export const transportName = (key: string) => label('transports', key, TRANSPORT_NAMES);
export const transportIcon = (key: string) => TRANSPORT_ICONS[key] ?? 'navigation';

/* Короткая подпись для тесных мест — карточки в ряду по четыре. Сокращено
   ровно одно значение из четырёх: «Общественный транспорт» не влезает в
   колонку и переносится на вторую строку, остальные влезают и трогать их
   незачем. Полное название справочника ТЗ остаётся в таблице, в окне правки
   и в объяснении. */
const TRANSPORT_SHORT: Record<string, string> = {
  transit: 'Общ. транспорт'
};

export const transportShort = (key: string) => TRANSPORT_SHORT[key] ?? transportName(key);

/** Требование заявки по транспорту словами. Пусто — не пробел в данных:
    ТЗ говорит прямо, что тип указывается только при наличии ограничения. */
export const requiredTransportName = (key: string | null | undefined) =>
  key ? transportName(key) : 'Без ограничения';

/* ─── класс заявки ───────────────────────────────────────────────────────── */

const ORDER_CLASS_NAMES: Record<string, string> = {
  connection: 'Подключение',
  addon: 'Дозаказ',
  incident: 'Локальная заявка',
  outage: 'Глобальная проблема'
};

const ORDER_CLASS_ICONS: Record<string, string> = {
  connection: 'plus',
  addon: 'layers',
  incident: 'wrench',
  outage: 'warning'
};

export const orderClassName = (key: string) => label('order_classes', key, ORDER_CLASS_NAMES);
export const orderClassIcon = (key: string) => ORDER_CLASS_ICONS[key] ?? 'clipboard-list';

/* ─── статус визита ──────────────────────────────────────────────────────── */

/* Семь значений колонки «Статус BK» из выгрузки — готовый жизненный цикл
   визита, и именно по нему живёт интерфейс инженера. Порядок здесь не
   алфавитный, а хронологический: заявку заводят, отправляют, по ней едут,
   работают — и дальше три исхода. */
const STATUS_NAMES: Record<string, string> = {
  draft: 'Не отправлена',
  sent: 'Отправлена',
  en_route: 'В пути',
  in_progress: 'В работе',
  done: 'Выполнена',
  cancelled: 'Отменена',
  overdue: 'Просрочена'
};

const STATUS_ICONS: Record<string, string> = {
  draft: 'clipboard-list',
  sent: 'envelope',
  en_route: 'navigation',
  in_progress: 'wrench',
  done: 'check-circle',
  cancelled: 'x-circle',
  overdue: 'alert-triangle'
};

/** Порядок жизненного цикла: по нему сортируют списки и рисуют шкалу визита.
    Неизвестный статус уходит в конец, а не притворяется началом. */
const STATUS_ORDER = ['draft', 'sent', 'en_route', 'in_progress', 'done', 'cancelled', 'overdue'];

export const statusName = (key: string) => label('statuses', key, STATUS_NAMES);
export const statusIcon = (key: string) => STATUS_ICONS[key] ?? 'clipboard-list';
export const statusRank = (key: string) => {
  const index = STATUS_ORDER.indexOf(key);
  return index === -1 ? STATUS_ORDER.length : index;
};

/** Статусы по порядку жизненного цикла — для фильтров и воронки. */
export const statusCodes = () => [...STATUS_ORDER];

/* ─── оборудование и технология ──────────────────────────────────────────── */

const EQUIPMENT_NAMES: Record<string, string> = {
  router: 'Роутер',
  stb: 'ТВ-приставка',
  ont: 'Оптический терминал',
  cable: 'Кабель',
  splitter: 'Сплиттер',
  speaker: 'Умная колонка'
};

export const equipmentName = (key: string) => label('equipment', key, EQUIPMENT_NAMES);

/** Список приборов словами, одинаковые — счётом: «Роутер × 2, ТВ-приставка».
    Движок отдаёт оборудование штуками, и два роутера на одну заявку
    читались бы «Роутер, Роутер». */
export function equipmentList(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return [...counts.entries()]
    .map(([key, count]) => (count > 1 ? `${equipmentName(key)} × ${count}` : equipmentName(key)))
    .join(', ');
}

/* Технологию в выгрузке пишут аббревиатурой, и расшифровывать её незачем:
   FMC и FTTB на планёрке произносят именно так. Словарь здесь нужен только
   затем, чтобы данные могли подписать то, чего мы не знаем. */
export const techName = (key: string) => label('techs', key, {});

/* ─── причина, по которой заявка осталась без инженера ───────────────────── */

/* Текст причины приходит от движка вместе с кодом: он знает подробности,
   которых нет в коде. Здесь — короткая подпись для колонки списка, где
   развёрнутой фразе не хватит места. */
const REASON_NAMES: Record<string, string> = {
  no_skill: 'Нет навыка',
  no_vehicle: 'Нет транспорта',
  no_equipment: 'Нет оборудования',
  no_time: 'Все заняты',
  window_missed: 'Окно вне смен',
  unreachable: 'Не успеть'
};

export const reasonName = (key: string) => REASON_NAMES[key] ?? key;

/** Название бригады без слова «Бригада»: оно стоит подписью поля.

    Выгрузка заполнена по-разному — «Бригада Попов» на Востоке и просто
    «Бахарев Андрей» в Центре. Снимаем приставку там, где она есть, и не
    трогаем то, где её нет: подпись поля скажет слово один раз за обоих. */
export const teamName = (team: string) => team.replace(/^Бригада\s+/i, '').trim() || team;
