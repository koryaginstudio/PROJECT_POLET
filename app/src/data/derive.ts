/* Всё, что интерфейс считает из контракта. Ни одного зашитого справочника:
   типы работ, навыки и районы перечисляются из того, что пришло в файле. */

import type { Day, Engineer, Minutes, Order, Plan, Risk, Route, Stop } from './contract.ts';
import { engineerOnShift, orderClosed, skillName } from './dictionary.ts';
import { clampDay, service } from './service.ts';

export const hhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/* ─── доли и распределения ───────────────────────────────────────────────
   Подписи в процентах округляются вместе, а не поодиночке: шесть независимых
   округлений дают в сумме 101%. Раздаём остаток по наибольшим хвостам. */

export function wholePercents(counts: number[]): number[] {
  const sum = counts.reduce((a, b) => a + b, 0);
  if (sum <= 0) return counts.map(() => 0);
  const raw = counts.map((count) => (count / sum) * 100);
  const whole = raw.map(Math.floor);
  const order = raw
    .map((value, index) => ({ rest: value - Math.floor(value), index }))
    .sort((a, b) => b.rest - a.rest);
  let left = 100 - whole.reduce((a, b) => a + b, 0);
  for (const { index } of order) {
    if (left <= 0) break;
    whole[index] += 1;
    left -= 1;
  }
  return whole;
}

/** Один сектор кольца: непересекающаяся группа. */
export interface DistributionSlice {
  key: string;
  label: string;
  count: number;
  ids: string[];
  /** Из каких категорий сложилась группа. Длина > 1 — это совмещение. */
  categoryKeys: string[];
}

/** Категория целиком, вместе с теми, кто попал ещё куда-то. */
export interface DistributionCategory {
  key: string;
  label: string;
  count: number;
  ids: string[];
}

export interface Distribution {
  total: number;
  slices: DistributionSlice[];
  categories: DistributionCategory[];
  /** Сколько элементов попали больше чем в одну категорию. */
  overlapping: number;
  /** Сумма по категориям: больше total ровно на величину совмещений. */
  categorySum: number;
}

/* Круг обязан складываться в целое, поэтому его секторы — не категории, а их
   непересекающиеся сочетания: инженер с двумя навыками занимает один сектор
   «Подключение + Ремонт», а не половинки двух. Категории считаются рядом и
   честно дают сумму больше целого — ровно на величину совмещений. */
export function buildDistribution<T>(
  items: T[],
  idOf: (item: T) => string,
  keysOf: (item: T) => string[],
  labelOf: (key: string) => string
): Distribution {
  const combos = new Map<string, { keys: string[]; ids: string[] }>();
  const categories = new Map<string, string[]>();
  let overlapping = 0;
  let categorySum = 0;

  for (const item of items) {
    const id = idOf(item);
    const keys = [...new Set(keysOf(item))].sort();
    if (keys.length === 0) continue;
    if (keys.length > 1) overlapping += 1;
    categorySum += keys.length;

    const comboKey = keys.join('+');
    const combo = combos.get(comboKey) ?? { keys, ids: [] };
    combo.ids.push(id);
    combos.set(comboKey, combo);

    for (const key of keys) categories.set(key, [...(categories.get(key) ?? []), id]);
  }

  const slices = [...combos.entries()]
    .map(([key, combo]) => ({
      key,
      label: combo.keys.map(labelOf).join(' + '),
      count: combo.ids.length,
      ids: combo.ids,
      categoryKeys: combo.keys
    }))
    /* Сначала чистые категории, потом совмещения — так кольцо читается
       от простого к сложному, а не прыгает. */
    .sort((a, b) =>
      a.categoryKeys.length - b.categoryKeys.length || b.count - a.count || a.label.localeCompare(b.label)
    );

  return {
    total: items.length,
    slices,
    categories: [...categories.entries()]
      .map(([key, ids]) => ({ key, label: labelOf(key), count: ids.length, ids }))
      .sort((a, b) => b.count - a.count),
    overlapping,
    categorySum
  };
}

/** Прочерк на месте числа, которого нет. Один на все форматы: «NaN:NaN» и
    «NaN ч» на экране читаются как сломанная программа, а пустое поле в чужом
    плане — обычное дело. */
const DASH = '—';

/* Крайние сроки в контракте уходят за полночь: 2220 минут — это 13:00
   следующего дня, а не «37:00». Часы без даты здесь врут, поэтому день
   выносится словом. */
export function deadline(m: number) {
  if (!Number.isFinite(m)) return DASH;
  const days = Math.floor(m / (24 * 60));
  const rest = m % (24 * 60);
  if (days === 0) return hhmm(rest);
  if (days === 1) return `${hhmm(rest)} завтра`;
  return `${hhmm(rest)} через ${days} дн.`;
}

/** Переносима ли заявка на завтра. Правило одно на весь интерфейс — воронка,
    карточка, колокольчик и выгрузка зовут только его, иначе одна и та же
    заявка «горит» на пульте и «можно завтра» в карточке.

    Если у плана есть граница суток (`meta.hard_end`, её пишут и движок, и
    браузерный планировщик) — правило движка из CONTRACT.md: сегодня обязана
    быть сделана заявка со сроком не позже границы, всё, что позже, можно на
    завтра. На синтетике граница 21:00, и срок 21:30 там уже «завтра» — так
    считает и сам движок, и число переносимых на пульте сходится с его.

    Если границы нет (старая запись) — срок за полночью. Это та же граница,
    по которой `deadline` пишет «завтра», а не конец оси из настроек: срок в
    22:00 при оси до 21:00 всё ещё сегодняшний, и переносить такую заявку
    значило бы сорвать его. */
export const isDeferrable = (order: Pick<Order, 'sla_deadline'>, hardEnd?: Minutes) =>
  hardEnd != null ? order.sla_deadline > hardEnd : order.sla_deadline >= 24 * 60;

/** Граница суток плана для оси времени. Из плана, если он её знает; у старой
    записи без поля — по самим данным, как Гант Антона: концы смен, маршрутов
    и окон невзятых заявок. Не выше полуночи: ось — одни сутки. */
export function planHorizon(plan: Plan): Minutes {
  if (plan.meta.hard_end != null) return Math.min(24 * 60, plan.meta.hard_end);
  let top = 0;
  for (const e of plan.engineers) top = Math.max(top, e.shift_end);
  for (const r of plan.routes) top = Math.max(top, r.totals.end);
  for (const o of plan.orders) top = Math.max(top, o.window_end);
  return Math.min(24 * 60, top);
}

/** Русский десятичный разделитель — запятая. */
export const dec = (n: number, digits = 1) =>
  Number.isFinite(n)
    ? n.toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : DASH;

export const pct = (n: number) => `${dec(n)}`;

/** Русская форма слова без числа: визит, визита, визитов. Отдельно от
    `plural`, чтобы число перед ней можно было набрать жирным самим —
    склеить с уже готовым «8 визитов» второе число значило бы получить
    «8 8 визитов». */
/** Первая буква прописной, остальное как есть: «визитов» → «Визитов». Не
    трогает регистр остального слова — «переработки» не должно стать
    «Переработки» с испорченным окончанием, если слово когда-нибудь придёт
    уже смешанным по регистру. */
export const capitalize = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/** Фамилия с инициалами: «Попов О. Н.». Полное ФИО не встаёт ни в плитку
    шириной в треть карточки, ни в колонку списка, а фамилия — то, чем
    человека называют и по чему его ищут. Целиком имя остаётся в подсказке. */
export function shortName(name: string): string {
  const [surname, first, patronymic] = name.trim().split(/\s+/).filter(Boolean);
  if (!surname) return name;
  const initials = [first, patronymic]
    .filter(Boolean)
    .map((part) => `${part![0].toUpperCase()}.`)
    .join(' ');
  return initials ? `${surname} ${initials}` : surname;
}

export function pluralWord(n: number, one: string, few: string, many: string) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

/** Русская форма числительного: 1 визит, 2 визита, 5 визитов. */
export function plural(n: number, one: string, few: string, many: string) {
  return `${n} ${pluralWord(n, one, few, many)}`;
}

export const visits = (n: number) => plural(n, 'заявка', 'заявки', 'заявок');
export const stops = (n: number) => plural(n, 'остановка', 'остановки', 'остановок');
export const engineers = (n: number) => plural(n, 'инженер', 'инженера', 'инженеров');
export const orders = (n: number) => plural(n, 'заявка', 'заявки', 'заявок');

/* Границы рабочего дня живут в настройках сервиса, а не здесь константами:
   смена с ночными бригадами в 07:00–21:00 не укладывается вовсе. Отсюда они
   только переизлучаются — чтобы всё, что считает день, брало их из одного
   места и не расходилось между экранами. Функции, а не значения: настройку
   двигают на ходу, и вычисленное при загрузке модуля осталось бы прежним. */
export { dayStart, dayEnd, daySpan, clampDay, dayHours } from './service.ts';
export type { ServiceSettings, Thresholds } from './service.ts';

/** Часы одной строкой. Формат — настройка сервиса: «4,9 ч» короче в таблице,
    «4 ч 54 мин» точнее в карточке, и спорить об этом должен не код. */
export function hoursText(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (service().hours === 'words') {
    const h = Math.floor(total / 60);
    const m = total % 60;
    return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
  }
  return `${dec(total / 60)} ч`;
}

/* ─── где заявка ─────────────────────────────────────────────────────────
   С 1.1 у заявки есть почтовый адрес дома, и место называется им: район —
   это полгорода, а инженер едет в подъезд. Район остаётся второй строкой
   там, где для неё есть место. На синтетической сети адрес приходит пустым,
   и тогда местом снова становится район — интерфейс от этого не ломается. */

export const placeOf = (order: Order) => order.address ?? order.district;

/** Адрес выезда инженера. Пусто на синтетической сети — тогда говорим о том,
    что достоверно известно, а не выдумываем адрес. */
export const homeOf = (engineer: Engineer) => engineer.home_address ?? 'Адрес не указан';

/* ─── линия маршрута ─────────────────────────────────────────────────────
   Маршрут на карте — не прямые между точками, а ломаная по улицам: каждый
   перегон приходит от маршрутизатора внутри своей остановки. Склеиваем их в
   одну линию, выбрасывая стык — конец предыдущего перегона и начало
   следующего это один и тот же дом.

   Перегон, у которого геометрии нет, заменяем прямой до точки заявки: соврать
   про дорогу нельзя, а порядок объезда известен и без неё. */
export function roadPath(
  route: Route,
  home: [number, number],
  pointOf: (orderId: string) => [number, number] | undefined
): [number, number][] {
  return roadLegs(route, home, pointOf).path;
}

/** Ломаная маршрута вместе с границами перегонов.

    Границы нужны карте: маршрут, дважды проходящий один перекрёсток, на
    сплошной линии читается как развилка — по какой из веток инженер едет
    сейчас, а по какой потом, не видно. Разрезав путь по перегонам и
    нарисовав их по очереди, каждый со своей тёмной каймой, мы получаем то
    же, что на дорожных схемах: поздний перегон проходит поверх раннего, и
    поворот читается сам собой.

    `breaks[i]` — номер вершины, на которой кончается i-й перегон; следующий
    начинается с неё же, чтобы линия не рвалась. */
export function roadLegs(
  route: Route,
  home: [number, number],
  pointOf: (orderId: string) => [number, number] | undefined
): { path: [number, number][]; breaks: number[] } {
  const path: [number, number][] = [home];
  const breaks: number[] = [];
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1];

  for (const stop of route.stops) {
    const leg = stop.geometry;
    if (leg && leg.length >= 2) {
      for (const point of leg) {
        const last = path[path.length - 1];
        if (!last || !same(last, point)) path.push(point);
      }
      breaks.push(path.length - 1);
      continue;
    }
    const point = pointOf(stop.order_id);
    if (point) {
      const last = path[path.length - 1];
      if (!last || !same(last, point)) path.push(point);
    }
    breaks.push(path.length - 1);
  }

  return { path, breaks };
}

export interface EngineerLoad {
  engineer: Engineer;
  route?: Route;
  visits: number;
  occupancy: number;
  /** Вышел, но маршрута не получил. Тот, кто сегодня не на смене, сюда не
      попадает: он не «свободен», его просто нет. */
  idle: boolean;
  /** Сегодня на смене. Планировщик кладёт в план весь штат, а раздаёт
      заявки только вышедшим, и различать их обязан каждый, кто считает
      свободных. */
  onShift: boolean;
}

/** Средняя занятость по маршрутам, доля 0…1. Одна формула на все экраны и
    на выгрузку: среднее по тем, у кого маршрут есть, без нулей за тех, кому
    заявок не дали, — простаивающих называют отдельно, числом. Пустое или
    нечисловое поле в чужом плане не портит среднее, а выпадает из него. */
export function occupancyMean(items: readonly { occupancy: number }[]): number {
  const known = items.map((item) => item.occupancy).filter((value) => Number.isFinite(value));
  if (known.length === 0) return 0;
  return known.reduce((sum, value) => sum + value, 0) / known.length;
}

export interface Metric {
  key: string;
  label: string;
  value: string;
  unit?: string;
  caption: string;
  /** Точка у подписи: на это число стоит посмотреть, и насколько срочно. */
  flag: 'ok' | 'watch' | 'bad';
  /** Чем оно плохо — расшифровка точки. */
  hint?: string;
  /** Куда ведёт число: раздел правой панели, где оно разложено по строкам. */
  group: string;
}

export type StageKey =
  | 'planned'
  | 'enroute'
  | 'working'
  | 'done'
  | 'overdue'
  | 'failed'
  | 'unassigned'
  | 'closed';

export interface Stage {
  key: StageKey;
  label: string;
  /** Чем этап на самом деле является, если название оставляет вопрос. */
  hint?: string;
  /** Сколько заявок на этапе на момент среза. */
  count: number;
  /** Сколько пришло на этап за последний час до среза. Null там, где перехода нет. */
  delta: number | null;
  /** Сколько из них стоят впритык. */
  atRisk: number;
  /** Сколько инженеров задействовано на этапе. */
  crew: number;
  tone: 'planned' | 'accent' | 'success' | 'danger' | 'idle';
  orderIds: string[];
}

/** Куда и когда инженер выехал к этой заявке. `departure` — момент выезда:
    для первой точки это начало смены, дальше — конец предыдущего визита. */
export interface Placement {
  stop: Stop;
  engineerId: string;
  departure: Minutes;
  slaBreached: boolean;
}

export interface Funnel {
  cut: Minutes;
  stages: Stage[];
  lost: { count: number; deferrable: number; orderIds: string[] };
  attention: { count: number; urgent: number; fragile: number; orderIds: string[] };
  total: number;
}

export interface DayView {
  metrics: Metric[];
  loads: EngineerLoad[];
  /** Открытые заявки, которым не нашлось инженера. Закрытых до расчёта здесь
      нет: выполненная заявка — не «без инженера». */
  unassigned: Order[];
  /** Заявки, закрытые до расчёта: выполненные и отменённые в учётной системе.
      В плане лежат со своим статусом, в раскладке не участвуют. */
  closed: Order[];
  orderById: Map<string, Order>;
  engineerById: Map<string, Engineer>;
  routeByEngineer: Map<string, Route>;
  stopByOrder: Map<string, Placement>;
  riskCounts: Record<Risk, number>;
  tightCount: number;
  workTypes: { key: string; title: string; count: number }[];
  deferrable: Order[];
  fragile: { order: Order; failureRate: number }[];
  reasons: { key: string; label: string; value: number }[];
  /** Сколько раз симуляция прогнала этот день. */
  runs: number;
  funnel: Funnel;
  /** Заявка → статус по всему журналу дня, без учёта момента ползунка
      («отправлено», «в пути», «выполнено», «сорвано»): движок отдаёт
      statuses по всем событиям, и заявка, выполненная в 13:40, стоит в
      «Выполнено» и на срезе 09:00. Чтобы не показывать прошлое с фактами из
      будущего, нужно время события в statuses — это просьба к движку.
      Пусто, пока расчёт открыт не на движке или диспетчер ещё ничего не
      сообщил. */
  reported: Record<string, string>;
  /** Жёсткая граница суток этого дня, минуты от полуночи: приходит планом
      от движка. Отдельно от настройки `dayEnd`, потому что это разные
      вещи: `dayEnd` — докуда рисовать ось времени, `hardEnd` — докуда
      заявку обязаны выполнить сегодня. Пока их путали, экран объявлял
      переносимыми на завтра 33 заявки из 205, у которых срок ровно 22:00
      сегодня. Нет у старой записи без поля — тогда граница полночь
      (`isDeferrable`). */
  hardEnd: Minutes | undefined;
}

/** Складывает дни участков в один вид — для карты мониторинга, где за тремя
    районами смотрят разом.

    Складываются только те поля, из которых мониторинг строит картину: люди,
    их маршруты, заявки и отметки журнала. Участки не пересекаются — свои
    инженеры, свои заявки, свой офис, — поэтому склейка тут сложение, а не
    слияние: одинаковых ключей в них не бывает.

    Сводные числа дня — итоги расчёта, воронка, причины, разбор по видам
    работ — остаются от первого дня и намеренно не пересчитываются. Сложить
    их нельзя: покрытие трёх участков — не сумма трёх покрытий, а воронка
    одного дня ничего не говорит о трёх. Мониторинг их не читает: его числа
    считает `buildLiveRoster` по составу смены. Понадобятся — считать заново,
    а не брать отсюда. */
export interface MergedDays {
  /** Дни, сложенные в один вид. */
  view: DayView;
  /** Инженер на общей карте → чей он на самом деле: расчёт и номер внутри
      своего дня. Нужен для сквозных номеров маршрутов: номер считается от
      пары «расчёт — инженер», и придуманный для карты составной номер туда
      попасть не должен. */
  owner: Map<string, { runId: string; engineerId: string }>;
}

export function mergeDays(parts: { runId: string; view: DayView }[]): MergedDays | null {
  if (parts.length === 0) return null;
  const owner = new Map<string, { runId: string; engineerId: string }>();
  if (parts.length === 1) {
    const [only] = parts;
    for (const load of only.view.loads) {
      owner.set(load.engineer.id, { runId: only.runId, engineerId: load.engineer.id });
    }
    return { view: only.view, owner };
  }

  /* Номера инженеров у участков одни и те же: в каждом свои E00…E13. На
     общей карте они сталкиваются, и день, положенный вторым, затирал бы
     людей первого — ровно это и происходило: сорок два инженера в числах и
     четырнадцать на карте. Поэтому на общей карте у инженера составной
     номер, «расчёт::инженер», а настоящий остаётся в `owner`. */
  const tag = (runId: string, id: string) => `${runId}::${id}`;
  const loads: EngineerLoad[] = [];
  const engineerById = new Map<string, Engineer>();
  const routeByEngineer = new Map<string, Route>();
  const stopByOrder = new Map<string, Placement>();

  for (const { runId, view } of parts) {
    for (const load of view.loads) {
      const id = tag(runId, load.engineer.id);
      owner.set(id, { runId, engineerId: load.engineer.id });
      const engineer = { ...load.engineer, id };
      loads.push({ ...load, engineer });
      engineerById.set(id, engineer);
      const route = view.routeByEngineer.get(load.engineer.id);
      if (route) routeByEngineer.set(id, route);
    }
    for (const [orderId, place] of view.stopByOrder) {
      stopByOrder.set(orderId, { ...place, engineerId: tag(runId, place.engineerId) });
    }
  }

  const views = parts.map((one) => one.view);
  const [first] = views;
  return {
    view: {
      ...first,
      loads,
      engineerById,
      routeByEngineer,
      stopByOrder,
      unassigned: views.flatMap((one) => one.unassigned),
      closed: views.flatMap((one) => one.closed),
      deferrable: views.flatMap((one) => one.deferrable),
      fragile: views.flatMap((one) => one.fragile),
      /* Заявки у участков свои: номер наряда общий по выгрузке, и
         сталкиваться им незачем. */
      orderById: new Map(views.flatMap((one) => [...one.orderById])),
      reported: Object.assign({}, ...views.map((one) => one.reported)),
      tightCount: views.reduce((sum, one) => sum + one.tightCount, 0),
      /* Граница суток у участков одна и та же — это день выгрузки. Берём
         позднюю: на ней кончается последняя смена из показанных. */
      hardEnd: views.reduce<Minutes | undefined>(
        (top, one) =>
          one.hardEnd == null ? top : top == null ? one.hardEnd : Math.max(top, one.hardEnd),
        undefined
      )
    },
    owner
  };
}

/** Срез внутри рабочего дня. Данные — план на дату, поэтому «сейчас» берём
    по часам и прижимаем к границам смены. */
export function cutMinutes(now = new Date()): Minutes {
  const minutes = now.getHours() * 60 + now.getMinutes();
  return clampDay(minutes);
}

/** Подписи, тон и пояснение этапов. Экспортированы, потому что канбану они
    нужны и для пустой колонки: колонка без заявок должна называться так же,
    как с ними.

    «Прогноз срыва», а не «не выполнено»: смена ещё не прожита. Движок
    раскладывает план и прогоняет его сотнями итераций, и это число — оценка:
    доля заявок, по которым план выходит за крайний срок и которые с той или
    иной вероятностью сорвутся. Подпись «не выполнено» читалась как факт и
    обещала то, чего в расчёте нет, — диспетчер видел срыв там, где речь о его
    вероятности. «Без инженера» рядом остаётся фактом плана и оговорки не
    требует: этим заявкам движок исполнителя действительно не нашёл.

    Двух слов хватает и по делу, и по месту: этап — это ячейка в ряду из семи,
    и подпись, которая в ней одна переносится на вторую строку, разваливает
    ряд. «Потенциально не выполнено» было точнее по букве и хуже по всему
    остальному.

    Строка `hint` есть только там, где название само оставляет вопрос;
    остальным этапам объяснять нечего. */
export const STAGE_META: Record<StageKey, { label: string; tone: Stage['tone']; hint?: string }> = {
  planned: { label: 'Запланированы', tone: 'planned' },
  enroute: { label: 'Инженер в пути', tone: 'accent' },
  working: { label: 'В работе', tone: 'accent' },
  done: { label: 'Выполнено', tone: 'success' },
  overdue: {
    label: 'Прогноз срыва',
    tone: 'danger',
    hint: 'Оценка расчёта, а не факт: по этим заявкам план выходит за крайний срок, и они сорвутся с той или иной вероятностью. Сколько на самом деле, покажет смена'
  },
  /* Факт из журнала, а не оценка: диспетчер отметил, что заявка сорвалась.
     В «Прогноз срыва» её класть нельзя — там вероятность, и факт в нём
     растворился бы среди предположений. */
  failed: {
    label: 'Сорвалось',
    tone: 'danger',
    hint: 'По журналу: диспетчер отметил, что заявка сорвалась. Это уже случилось, в отличие от прогноза срыва'
  },
  unassigned: { label: 'Без инженера', tone: 'idle' },
  closed: {
    label: 'Закрыта до расчёта',
    tone: 'idle',
    hint: 'Выполнена или отменена в учётной системе ещё до того, как день считали: в раскладку не входила'
  }
};

/** Этапы заявки, у которой есть маршрут. «Без инженера» живёт отдельно:
    оно не выводится из маршрута и добавляется только в воронку смены.
    «Закрыта до расчёта» — тоже: закрытая заявка в воронку дня не входит
    вовсе, воронка считает только то, что раскладывали. */
const ROUTED_STAGES: StageKey[] = ['planned', 'enroute', 'working', 'done', 'overdue'];

/** Этап, который диктует журнал дня, — поверх того, что выводится из плана
    по часам. Журнал знает факты: заявку закрыли, по ней сорвалось, к ней
    выехали. «Назначено» и «отправлено» этапа не меняют: человек ещё не
    выехал, и план по часам знает о его дне больше. Строки — те же, что у
    движка (journal.py, СТАТУСЫ). */
export function reportedStage(status: string | undefined): StageKey | null {
  if (status === 'выполнено') return 'done';
  if (status === 'сорвано') return 'failed';
  if (status === 'в пути') return 'enroute';
  return null;
}

/** Этап заявки с учётом журнала. У журнала нет события «приехал», поэтому
    «в пути» длится до «выполнено»: если план по часам говорит, что человек
    уже на объекте, верим плану, иначе колонка «В работе» у дня с журналом
    пустела бы целиком. Момент перехода по журналу неизвестен — прирост за
    час по таким заявкам не считается. */
function stageWithReport(
  placement: Placement | undefined,
  cut: Minutes,
  slaDeadline: Minutes | null,
  status: string | undefined
): { key: StageKey; enteredAt: Minutes | null } | null {
  const fact = reportedStage(status);
  if (!fact) return placement ? stageOf(placement, cut, slaDeadline) : null;
  if (fact === 'enroute' && placement) {
    const planned = stageOf(placement, cut, slaDeadline);
    if (planned.key === 'working' || planned.key === 'enroute') return planned;
  }
  return { key: fact, enteredAt: null };
}

/** Есть ли у дня журнал: только тогда этап «Сорвалось» вообще возможен и
    показывается — у расчёта без журнала он всегда был бы пустым нулём. */
const hasJournal = (reported: Record<string, string>) => Object.keys(reported).length > 0;

const REASON_LABELS: Record<string, string> = {
  no_show: 'Абонента не было дома',
  missed_window: 'Приехали после закрытия окна',
  no_access: 'Не попали в подъезд',
  dropped: 'Не успели до конца смены'
};

/** Раскладывает назначенные заявки по взаимоисключающим этапам на момент среза.
    Этап — это состояние на срез, а не свойство плана: заявка, которую план
    закрывает после крайнего срока, до самого визита честно стоит в
    «запланированы», и только потом попадает в «прогноз срыва». Иначе в семь
    утра, когда ещё никто не выехал, часть смены уже числилась бы сорванной. */
export function stageOf(
  placement: Placement,
  cut: Minutes,
  slaDeadline: Minutes | null = null
): { key: StageKey; enteredAt: Minutes | null } {
  const { stop, departure } = placement;
  if (cut >= stop.finish) {
    return { key: placement.slaBreached ? 'overdue' : 'done', enteredAt: stop.finish };
  }
  /* Срок вышел, а визит ещё не закрыт — это уже срыв, ждать конца работы незачем. */
  if (slaDeadline !== null && cut >= slaDeadline) return { key: 'overdue', enteredAt: slaDeadline };
  if (cut < departure) return { key: 'planned', enteredAt: null };
  if (cut < stop.start) return { key: 'enroute', enteredAt: departure };
  return { key: 'working', enteredAt: stop.start };
}

interface Bucket {
  ids: string[];
  delta: number;
  atRisk: number;
  crew: Set<string>;
}

const emptyBuckets = (): Record<StageKey, Bucket> => ({
  planned: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  enroute: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  working: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  done: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  overdue: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  failed: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  unassigned: { ids: [], delta: 0, atRisk: 0, crew: new Set() },
  closed: { ids: [], delta: 0, atRisk: 0, crew: new Set() }
});

function stagesFrom(
  placements: Iterable<[string, Placement]>,
  cut: Minutes,
  slaOf: (placement: Placement) => Minutes | null,
  reported: Record<string, string> = {},
  /* Заявки без маршрута в показанном плане, о которых журнал сообщил факт:
     их закрыли или по ним выехали после пересчёта. В «Без инженера» им не
     место, а сумма этапов должна сойтись с числом заявок. */
  extra: [string, StageKey][] = []
): Stage[] {
  const buckets = emptyBuckets();
  for (const [orderId, placement] of placements) {
    const { key, enteredAt } = stageWithReport(placement, cut, slaOf(placement), reported[orderId])!;
    const bucket = buckets[key];
    bucket.ids.push(orderId);
    bucket.crew.add(placement.engineerId);
    if (placement.stop.risk !== 'low') bucket.atRisk += 1;
    if (enteredAt !== null && cut >= enteredAt && cut - enteredAt <= 60) bucket.delta += 1;
  }
  for (const [orderId, key] of extra) buckets[key].ids.push(orderId);
  const keys: StageKey[] = hasJournal(reported) ? [...ROUTED_STAGES, 'failed'] : ROUTED_STAGES;
  return keys.map((key) => ({
    key,
    label: STAGE_META[key].label,
    hint: STAGE_META[key].hint,
    tone: STAGE_META[key].tone,
    count: buckets[key].ids.length,
    delta: key === 'planned' ? null : buckets[key].delta,
    atRisk: buckets[key].atRisk,
    crew: buckets[key].crew.size,
    orderIds: buckets[key].ids
  }));
}

/** Воронка смены на произвольный срез: где заявки находятся в этот момент.
    Этапы разбивают смену без остатка: сумма шести чисел равна общему числу заявок,
    потому что заявки без маршрута вынесены отдельным этапом, а не выброшены. */
export function buildFunnel(
  ordersTotal: number,
  stopByOrder: Map<string, Placement>,
  unassigned: Order[],
  deferrable: Order[],
  fragileIds: string[],
  cut: Minutes,
  slaOf: (placement: Placement) => Minutes | null = () => null,
  hardEnd?: Minutes,
  reported: Record<string, string> = {}
): Funnel {
  /* Без инженера в плане, но с фактом в журнале — уже не «без инженера»:
     её закрыли или к ней едут. Такие уходят на свой этап. */
  const tracked: [string, StageKey][] = [];
  const waiting: Order[] = [];
  for (const order of unassigned) {
    const fact = reportedStage(reported[order.id]);
    if (fact) tracked.push([order.id, fact]);
    else waiting.push(order);
  }
  unassigned = waiting;
  deferrable = deferrable.filter((order) => !reportedStage(reported[order.id]));

  /* Горит та, у которой срок сегодняшний: переносимая на завтра подождёт.
     Граница суток — плана (`hardEnd`), правило то же, что в карточке. */
  const urgent = unassigned.filter((o) => !isDeferrable(o, hardEnd));
  const attentionIds = [...new Set([...urgent.map((o) => o.id), ...fragileIds])];

  /* Заявка без инженера «горит», если её окно уже открыто: раздать её
     без потерь уже нельзя. */
  const burning = unassigned.filter((o) => o.window_start <= cut);
  const unassignedStage: Stage = {
    key: 'unassigned',
    label: STAGE_META.unassigned.label,
    tone: STAGE_META.unassigned.tone,
    count: unassigned.length,
    delta: null,
    atRisk: burning.length,
    crew: 0,
    orderIds: unassigned.map((o) => o.id)
  };

  return {
    cut,
    total: ordersTotal,
    stages: [...stagesFrom(stopByOrder, cut, slaOf, reported, tracked), unassignedStage],
    lost: {
      count: unassigned.length,
      deferrable: deferrable.length,
      orderIds: unassigned.map((o) => o.id)
    },
    attention: {
      count: attentionIds.length,
      urgent: urgent.length,
      fragile: fragileIds.length,
      orderIds: attentionIds
    }
  };
}

/** Те же этапы, но по одному инженеру. */
export function engineerStages(
  stopByOrder: Map<string, Placement>,
  engineerId: string,
  cut: Minutes,
  slaOf: (placement: Placement) => Minutes | null = () => null,
  reported: Record<string, string> = {}
): { total: number; stages: Stage[] } {
  const mine = [...stopByOrder.entries()].filter(([, p]) => p.engineerId === engineerId);
  return { total: mine.length, stages: stagesFrom(mine, cut, slaOf, reported) };
}

/** Этап конкретной заявки на срез — для списков и таблиц. */
export function stageOfOrder(
  view: DayView,
  orderId: string,
  cut: Minutes
): { key: StageKey; label: string; tone: Stage['tone'] } {
  const placement = view.stopByOrder.get(orderId);
  const order = view.orderById.get(orderId);
  /* Закрытая до расчёта заявка маршрута не имеет, но и «без инженера» она
     не осталась — по ней некуда ехать. Проверяется раньше маршрута: в чужом
     плане закрытая заявка может стоять и в маршруте, и тогда это ошибка
     плана, а не этап смены. */
  if (order && orderClosed(order)) return { key: 'closed', ...STAGE_META.closed };
  /* Журнал — раньше маршрута: закрытая по журналу заявка закрыта, даже если
     в показанном плане её нет. */
  const stage = stageWithReport(placement, cut, order?.sla_deadline ?? null, view.reported[orderId]);
  if (!stage) return { key: 'unassigned', ...STAGE_META.unassigned };
  return { key: stage.key, ...STAGE_META[stage.key] };
}

export type SegmentKind = 'travel' | 'wait' | 'work' | 'idle' | 'lunch';

export interface Segment {
  kind: SegmentKind;
  from: Minutes;
  to: Minutes;
  orderId?: string;
  /** Обед выведен из простоя: поля перерыва в контракте пока нет. */
  inferred?: boolean;
}

const LUNCH_WINDOW: [Minutes, Minutes] = [11 * 60, 16 * 60];
const LUNCH_MIN = 45;
const LUNCH_MAX = 120;

/** Лента дня инженера: дорога, ожидание окна, работа, простой.
    Перерыва в контракте нет, поэтому самое длинное дневное ожидание
    помечается как окно под обед — и подписывается как вывод, а не факт. */
export function engineerTimeline(
  route: Route | undefined,
  engineer: Engineer,
  stopByOrder: Map<string, Placement>
): Segment[] {
  if (!route || route.stops.length === 0) return [];
  const segments: Segment[] = [];
  let cursor = engineer.shift_start;

  for (const stop of route.stops) {
    const placement = stopByOrder.get(stop.order_id);
    const departure = placement ? placement.departure : cursor;
    if (departure > cursor) segments.push({ kind: 'idle', from: cursor, to: departure });
    if (stop.arrive > departure) segments.push({ kind: 'travel', from: departure, to: stop.arrive });
    if (stop.start > stop.arrive) segments.push({ kind: 'wait', from: stop.arrive, to: stop.start });
    segments.push({ kind: 'work', from: stop.start, to: stop.finish, orderId: stop.order_id });
    cursor = stop.finish;
  }
  if (engineer.shift_end > cursor) segments.push({ kind: 'idle', from: cursor, to: engineer.shift_end });

  /* Хвост смены после последнего визита — это незанятый вечер, а не перерыв,
     и пятичасовое окно тоже обедом не назовёшь. Ищем паузу разумной длины
     внутри дня. */
  const lastWorkIndex = segments.map((segment) => segment.kind).lastIndexOf('work');
  let lunchIndex = -1;
  let lunchLength = 0;
  segments.forEach((segment, index) => {
    if (segment.kind !== 'wait' && segment.kind !== 'idle') return;
    if (index > lastWorkIndex) return;
    const length = segment.to - segment.from;
    if (length < LUNCH_MIN || length > LUNCH_MAX) return;
    if (segment.to <= LUNCH_WINDOW[0] || segment.from >= LUNCH_WINDOW[1]) return;
    if (length > lunchLength) {
      lunchIndex = index;
      lunchLength = length;
    }
  });
  if (lunchIndex >= 0) {
    segments[lunchIndex].kind = 'lunch';
    segments[lunchIndex].inferred = true;
  }

  return segments;
}

export type LiveStatus = 'off' | 'no-route' | 'before' | 'enroute' | 'working' | 'overdue' | 'done';

const LIVE_STATUS_META: Record<LiveStatus, { label: string; tone: Stage['tone'] }> = {
  /* Не вышел — не то же, что вышел и остался без маршрута: второго можно
     нагрузить прямо сейчас, первого сегодня нет. */
  off: { label: 'Не на смене', tone: 'idle' },
  'no-route': { label: 'Без маршрута', tone: 'idle' },
  before: { label: 'Смена не началась', tone: 'planned' },
  enroute: { label: 'В пути', tone: 'accent' },
  working: { label: 'На объекте', tone: 'accent' },
  overdue: { label: 'Опаздывает', tone: 'danger' },
  done: { label: 'Свободен', tone: 'success' }
};

export interface LiveEngineer {
  engineer: Engineer;
  route?: Route;
  status: LiveStatus;
  label: string;
  tone: Stage['tone'];
  /** Заявка, к которой относится статус: инженер едет туда, работает на ней
      или только что закрыл. Null — на маршруте сейчас нет активной точки. */
  orderId: string | null;
  /** На сколько минут задержан относительно крайнего срока. 0, если в графике. */
  lateMinutes: number;
  visitsDone: number;
  visitsTotal: number;
}

/** Живой статус каждого инженера на срез `cut`. В отличие от `stageOf`, который
    смотрит на одну заявку, здесь для инженера ищется его текущая точка —
    первая в маршруте, ещё не закрытая к этому моменту, — и по ней читается,
    где он сейчас: едет, работает или опаздывает. */
export function buildLiveRoster(view: DayView, cut: Minutes): LiveEngineer[] {
  return view.loads.map(({ engineer, route, onShift }): LiveEngineer => {
    const base = { engineer, route, orderId: null, lateMinutes: 0 };

    if (!onShift) {
      return { ...base, status: 'off', ...LIVE_STATUS_META.off, visitsDone: 0, visitsTotal: 0 };
    }

    if (!route || route.stops.length === 0) {
      return { ...base, status: 'no-route', ...LIVE_STATUS_META['no-route'], visitsDone: 0, visitsTotal: 0 };
    }

    const visitsTotal = route.stops.length;
    if (cut < engineer.shift_start) {
      return { ...base, status: 'before', ...LIVE_STATUS_META.before, visitsDone: 0, visitsTotal };
    }

    /* Точка позади, если так говорит журнал («выполнено», «сорвано») или,
       без его слова, часы плана. «В пути» по журналу держит точку открытой,
       даже когда по плану визит уже кончился: человек не отчитался, и
       «Свободен» про него было бы неправдой. */
    const passed = (stop: Stop) => {
      const said = view.reported[stop.order_id];
      if (said === 'выполнено' || said === 'сорвано') return true;
      if (said === 'в пути') return false;
      return cut >= stop.finish;
    };
    const visitsDone = route.stops.filter(passed).length;
    /* Первая точка маршрута, которую срез ещё не закрыл: до неё все уже
       позади, а departure у неё — либо конец предыдущей, либо начало смены,
       и в обоих случаях он уже наступил, раз мы досюда дошли. */
    const current = route.stops.find((stop) => !passed(stop));
    if (!current) {
      return {
        ...base,
        status: 'done',
        ...LIVE_STATUS_META.done,
        orderId: route.stops[visitsTotal - 1]?.order_id ?? null,
        visitsDone,
        visitsTotal
      };
    }

    const placement = view.stopByOrder.get(current.order_id);
    if (!placement) {
      return { ...base, status: 'no-route', ...LIVE_STATUS_META['no-route'], visitsDone, visitsTotal };
    }
    const slaDeadline = view.orderById.get(current.order_id)?.sla_deadline ?? null;
    const { key } = stageOf(placement, cut, slaDeadline);
    const status: LiveStatus = key === 'overdue' ? 'overdue' : key === 'working' ? 'working' : 'enroute';
    const lateMinutes = key === 'overdue' ? Math.max(0, cut - (slaDeadline ?? current.finish)) : 0;

    return {
      ...base,
      status,
      ...LIVE_STATUS_META[status],
      orderId: current.order_id,
      lateMinutes,
      visitsDone,
      visitsTotal
    };
  });
}

/** Порядок для списка мониторинга: сперва то, что требует внимания. */
export const LIVE_STATUS_ORDER: LiveStatus[] = [
  'overdue',
  'working',
  'enroute',
  'before',
  'done',
  'no-route',
  'off'
];

/* ─── обязательные метрики ТЗ и пересчёт ───────────────────────────────
   Исполнители и пробег считаются одинаково на пульте, в разборе числа и в
   книге Excel. Прежде каждый собирал их у себя, и книга брала только поле
   движка: у браузерного плана, где поля нет, там стоял прочерк, а на
   пульте — сумма по маршрутам. Одно имя, два числа. */

/** Сколько исполнителей получили хотя бы одну заявку. Поле движка главнее:
    метрику, которую сверяют по ТЗ, называет тот, кто её оптимизирует. */
export function engineersUsed(plan: Day['plan']): number {
  return plan.meta.engineers_used ?? plan.routes.filter((route) => route.stops.length > 0).length;
}

/** Пробег плана, км. `null` — километража нет ни в сводке, ни у каждого
    маршрута: сумма по половине маршрутов выдала бы половину пробега за весь. */
export function kmTotal(plan: Day['plan']): number | null {
  if (plan.meta.distance_km_total != null) return plan.meta.distance_km_total;
  const perRoute = plan.routes.map((route) => route.totals.distance_km);
  if (!perRoute.every((value) => value != null)) return null;
  return perRoute.reduce((acc: number, value) => acc + (value ?? 0), 0);
}

/** Момент, с которого пересобран остаток дня, либо `null`, если это план
    дня целиком. Поле `meta.replan` движок кладёт в план пересчёта и хранит
    в архиве вместе с ним; переходник его не трогает. В контракте плана его
    нет — это блок ответа `/replan`, — поэтому читаем осторожно. */
export function replanAt(plan: Day['plan']): Minutes | null {
  const replan = (plan.meta as { replan?: { at?: unknown } | null }).replan;
  return replan && typeof replan.at === 'number' ? replan.at : null;
}

/** `reported` — статусы журнала дня на срез (dayState.statuses): факты
    диспетчера поверх плана. Без журнала — пусто, и всё считается по плану. */
export function buildDayView(day: Day, reported: Record<string, string> = {}): DayView {
  const { plan, simulation } = day;

  const orderById = new Map(plan.orders.map((o) => [o.id, o]));
  const engineerById = new Map(plan.engineers.map((e) => [e.id, e]));
  const routeByEngineer = new Map(plan.routes.map((r) => [r.engineer_id, r]));

  const stopByOrder = new Map<string, Placement>();
  for (const route of plan.routes) {
    const engineer = engineerById.get(route.engineer_id);
    let previousFinish = engineer ? engineer.shift_start : route.totals.start;
    for (const stop of route.stops) {
      const order = orderById.get(stop.order_id);
      stopByOrder.set(stop.order_id, {
        stop,
        engineerId: route.engineer_id,
        departure: Math.min(previousFinish, stop.arrive),
        slaBreached: order ? stop.finish > order.sla_deadline : false
      });
      previousFinish = stop.finish;
    }
  }

  const riskCounts: Record<Risk, number> = { low: 0, medium: 0, high: 0 };
  for (const { stop } of stopByOrder.values()) riskCounts[stop.risk] += 1;
  const tightCount = riskCounts.medium + riskCounts.high;

  const loads: EngineerLoad[] = plan.engineers
    .map((engineer) => {
      const route = routeByEngineer.get(engineer.id);
      const onShift = engineerOnShift(engineer);
      return {
        engineer,
        route,
        visits: route?.totals.visits ?? 0,
        occupancy: route?.totals.occupancy ?? 0,
        idle: onShift && (!route || route.totals.visits === 0),
        onShift
      };
    })
    .sort((a, b) => b.occupancy - a.occupancy);

  /* Закрытые до расчёта заявки отсеиваются и здесь, а не только в
     планировщике: план приходит и из архива движка, и из старой записи, и
     «без инженера» там может стоять выполненная заявка. Выполненная — не
     «без инженера», по ней некуда ехать. */
  const closed = plan.orders.filter(orderClosed);
  const unassigned = plan.unassigned
    .map((id) => orderById.get(id))
    .filter((o): o is Order => o !== undefined && !orderClosed(o));

  /* Жёсткая граница суток — из плана: что считать сегодняшним. Без поля
     (старая запись) — неизвестна, и `isDeferrable` берёт полночь. Ось
     времени от неё не зависит: её тянет `setPlanHorizon` в App. */
  const hardEnd = plan.meta.hard_end;

  const deferrable = unassigned.filter((o) => isDeferrable(o, hardEnd));

  const byType = new Map<string, { title: string; count: number }>();
  for (const order of plan.orders) {
    const entry = byType.get(order.work_type) ?? { title: order.work_title, count: 0 };
    entry.count += 1;
    byType.set(order.work_type, entry);
  }
  const workTypes = [...byType.entries()]
    .map(([key, v]) => ({ key, title: v.title, count: v.count }))
    .sort((a, b) => b.count - a.count);

  const fragile = simulation.fragile
    .map((f) => ({ order: orderById.get(f.order_id), failureRate: f.failure_rate }))
    .filter((f): f is { order: Order; failureRate: number } => Boolean(f.order));

  const reasons = Object.entries(simulation.reasons)
    .map(([key, value]) => ({ key, label: REASON_LABELS[key] ?? key, value }))
    .sort((a, b) => b.value - a.value);

  const slaOf = (placement: Placement) => orderById.get(placement.stop.order_id)?.sla_deadline ?? null;
  const funnel = buildFunnel(
    plan.meta.orders_total,
    stopByOrder,
    unassigned,
    deferrable,
    fragile.map((f) => f.order.id),
    cutMinutes(),
    slaOf,
    hardEnd,
    reported
  );

  const spread = plan.meta.balance;

  /* Точка у подписи вместо цветного числа: цифры на пульте одинаково
     чёрные, а отметка говорит, с какой из них начинать разбор. Пороги
     грубые и общие для всех дней — это подсказка, а не оценка плана. */

  /* Простой считается на той же базе, на какой он накоплен. Простой маршрута
     — это ожидание внутри его окна, от выезда до конца последнего визита;
     хвост смены после последнего визита и смены тех, кто маршрута не
     получил, в него не входят — так решил планировщик, и делить это
     ожидание на смены всего штата значило бы показать четверть незанятого
     времени как одну восьмую. Делим на сумму окон маршрутов. */
  const routeMinutes = plan.routes.reduce(
    (sum, route) => sum + Math.max(0, route.totals.end - route.totals.start),
    0
  );
  const lostShare = plan.meta.orders_total > 0 ? unassigned.length / plan.meta.orders_total : 0;

  /* Разрыв — между самым загруженным и самым свободным из тех, у кого
     маршрут есть. Нули за тех, кому заявок не дали, сюда не идут: с ними
     знаменатель упирался в сотую, и разрыв выходил в шестьдесят раз при
     загрузках от тридцати до восьмидесяти процентов. Простаивающих называет
     подпись — отдельным числом, а не бесконечным разрывом. */
  const routed = loads.filter((load) => !load.idle && load.route);
  const busiest = routed.length ? Math.max(...routed.map((load) => load.occupancy)) : 0;
  const loosest = routed.length ? Math.min(...routed.map((load) => load.occupancy)) : 0;
  const gap = loosest > 0 ? busiest / loosest : 1;
  const idleCount = loads.filter((load) => load.idle).length;

  const mark = (bad: boolean, watch: boolean, hint: string): Pick<Metric, 'flag' | 'hint'> =>
    bad ? { flag: 'bad', hint } : watch ? { flag: 'watch', hint } : { flag: 'ok' };

  /* Пороги приходят из настроек сервиса. Прежде они стояли здесь числами и
     были подписаны как «грубые и общие для всех дней»; общими они и остались,
     но теперь их можно подвинуть под свою норму, не трогая код. */
  const limit = service().thresholds;

  const used = engineersUsed(plan);

  /* Пересчёт — план остатка дня, а не дня. Сравнивать его с базовым
     вариантом нечестно: базовый раскладывал день с утра, а пересчёт — только
     то, что осталось после ЧП, и меньше километров у него просто потому, что
     меньше дня. А прогноз рядом — от исходного плана: своего прогноза у
     пересчёта нет (у сохранённого движок его и не отдаёт), и покрытие из
     него на пульте пересчёта читалось бы итогом дня, которого на экране нет.
     Поэтому у пересчёта каждая плитка говорит, про какой отрезок она, и
     числа берутся из самого плана. */
  const restFrom = replanAt(plan);
  const rest = restFrom === null ? null : `Остаток дня с ${hhmm(restFrom)}`;
  const base = rest === null ? plan.meta.baseline ?? null : null;
  const idleMinutes =
    rest === null
      ? simulation.idle_minutes
      : plan.routes.reduce((sum, route) => sum + route.totals.idle_minutes, 0);
  const assignedShare =
    plan.meta.orders_total > 0 ? (plan.meta.orders_assigned / plan.meta.orders_total) * 100 : 0;
  const idleShare = routeMinutes > 0 ? idleMinutes / routeMinutes : 0;

  /* Прогноз показывается только у плана на день целиком: своего прогноза у
     пересчёта нет — движок его для остатка дня не считает. */
  const forecast: Metric[] =
    rest === null
      ? [
          {
            /* Это прогноз, а не факт. Симуляция разыгрывает день много раз и
               считает, сколько заявок доедет в среднем, поэтому и подпись
               дробная: целое «49 из 56» обещало бы точность, которой нет, и
               вдобавок не сходилось бы с процентом рядом. */
            key: 'coverage',
            label: 'Прогноз выполнения',
            value: pct(simulation.coverage),
            unit: '%',
            caption: `В среднем ${dec(simulation.done.mean)} из ${simulation.orders_total} заявок`,
            group: 'metric:coverage',
            ...mark(
              simulation.coverage < limit.coverageBad,
              simulation.coverage < limit.coverageWatch,
              'По прогнозу дня часть заявок в среднем не будет выполнена'
            )
          }
        ]
      : [];

  /* Порядок плиток — путь чтения дня. Первые четыре — то, что вышло: сколько
     заявок покрыто, сколько их всего, сколько человек их везёт, у скольких
     инженера нет. Следующие четыре — разбор того, почему вышло так: прогноз,
     простой, перекос загрузки. Пробега на пульте нет: километры дня сравнивают
     с базовым вариантом в «Сводке» — здесь их не с чем сопоставить, и голое
     число без сравнения только путает. */
  const metrics: Metric[] = [
    {
      /* Твёрдое число дня: сколько заявок получили инженера. Доля и подпись
         под ней считаются из одного и того же и сходятся между собой —
         в отличие от прогноза, который приходит из симуляции. */
      key: 'assigned',
      label: 'Покрытие',
      value: pct(assignedShare),
      unit: '%',
      caption:
        (rest === null ? '' : `${rest}: `) +
        `${plan.meta.orders_assigned} из ${plan.meta.orders_total} заявок`,
      group: 'metric:assigned',
      ...mark(
        assignedShare < limit.coverageBad,
        assignedShare < limit.coverageWatch,
        rest === null
          ? 'Часть заявок осталась без инженера'
          : 'В остатке дня часть заявок осталась без инженера'
      )
    },
    {
      /* Знаменатель покрытия — тем же разбором: сколько заявок в расчёте
         вообще, до вопроса, у скольких из них есть инженер. */
      key: 'orders',
      label: 'Заявок',
      value: String(plan.meta.orders_total),
      unit: 'з.',
      caption: rest ?? 'Всего в расчёте',
      group: 'metric:assigned',
      flag: 'ok'
    },
    {
      key: 'engineers',
      /* «Инженеров», а не «Исполнителей»: в программе человек с маршрутом
         зовётся инженером везде — в базе, в отборах, в подписи «без
         инженера», — и второе слово для того же самого только сбивает. */
      label: 'Инженеров',
      value: String(used),
      unit: 'чел.',
      caption:
        rest ??
        (base
          ? `Базовый (без планировщика) — ${base.engineers_used}`
          : `Из ${plan.meta.engineers_total} в штате`),
      group: 'metric:engineers',
      flag: 'ok'
    },
    {
      key: 'unassigned',
      label: 'Без инженера',
      value: String(unassigned.length),
      unit: 'з.',
      caption: rest ?? 'Не найден инженер',
      group: 'unassigned',
      ...mark(lostShare > 0.1, unassigned.length > 0, 'Для этих заявок не найден инженер')
    },
    ...forecast,
    {
      key: 'idle',
      label: 'Общий простой',
      value: dec(idleMinutes / 60),
      unit: 'ч',
      caption: rest ?? 'Ожидание свободных окон',
      group: 'metric:idle',
      ...mark(
        idleShare > limit.idleBad / 100,
        idleShare > limit.idleWatch / 100,
        'Ожидание свободных окон занимает заметную долю времени на маршрутах'
      )
    },
    {
      key: 'balance',
      label: 'Разрыв загрузки',
      value: dec(gap),
      unit: '\u00d7',
      caption:
        `Загрузка от ${Math.round(loosest * 100)}% до ${Math.round(busiest * 100)}%` +
        (idleCount > 0 ? `, без маршрута: ${idleCount}` : ''),
      group: 'metric:spread',
      ...mark(
        gap >= limit.gapBad,
        gap >= limit.gapWatch,
        'Разница между самым загруженным и самым свободным инженером велика'
      )
    },
    {
      /* Разрыв показывает только края, а неравномерность — всех инженеров:
         один перегруженный и один свободный при ровной середине дают тот же
         разрыв, что и смена, разъехавшаяся целиком. */
      key: 'gini',
      label: 'Неравномерность',
      value: dec(spread.gini, 2),
      caption: 'Ближе к нулю — нагрузка ровнее',
      group: 'metric:gini',
      ...mark(
        spread.gini > limit.giniBad,
        spread.gini > limit.giniWatch,
        'Нагрузка распределена между инженерами неравномерно'
      )
    }
  ];

  return {
    metrics,
    loads,
    unassigned,
    closed,
    orderById,
    engineerById,
    routeByEngineer,
    stopByOrder,
    riskCounts,
    tightCount,
    workTypes,
    deferrable,
    fragile,
    reasons,
    runs: simulation.meta.runs,
    funnel,
    reported,
    hardEnd
  };
}

/* ─── статус смены, не зависящий от среза ────────────────────────────────
   Кольца отвечают на вопрос «как собран день», а не «что происходит сейчас»:
   их три доли берутся из плана и симуляции и не меняются, когда диспетчер
   двигает время. Всё, что живёт по часам, показывают этапы и шкала выше. */

export interface StatusSplit {
  key: string;
  label: string;
  count: number;
  ids: string[];
  tone: 'ok' | 'wait' | 'bad';
}

/** Заявка проблемная, если инженер есть, но план по ней шаткий:
    нарушен крайний срок, нет запаса времени или её роняют прогоны. */
export function ordersStatus(view: DayView): StatusSplit[] {
  const fragile = new Set(view.fragile.map((f) => f.order.id));
  const assigned = [...view.stopByOrder.entries()];
  const problem = assigned.filter(
    ([id, placement]) => placement.slaBreached || placement.stop.risk !== 'low' || fragile.has(id)
  );
  const problemIds = new Set(problem.map(([id]) => id));
  const clean = assigned.filter(([id]) => !problemIds.has(id));

  return [
    { key: 'assigned', label: 'Назначен', count: clean.length, ids: clean.map(([id]) => id), tone: 'ok' },
    {
      key: 'unassigned',
      label: 'Без инженера',
      count: view.unassigned.length,
      ids: view.unassigned.map((o) => o.id),
      tone: 'wait'
    },
    { key: 'problem', label: 'Проблема', count: problem.length, ids: [...problemIds], tone: 'bad' }
  ];
}

/** У инженера проблема, если маршрут есть, но он перегружен или рвёт срок.
    Четыре доли складываются в весь штат: с маршрутом, свободные, проблемные
    и те, кого сегодня нет. Последних раньше считали свободными — а
    свободный это тот, кому можно дать заявку прямо сейчас. */
export function crewStatus(view: DayView): StatusSplit[] {
  const breached = new Set(
    [...view.stopByOrder.values()].filter((p) => p.slaBreached).map((p) => p.engineerId)
  );
  const withRoute = view.loads.filter((l) => l.onShift && !l.idle);
  const heavy = service().thresholds.occupancy / 100;
  const problem = withRoute.filter((l) => l.occupancy >= heavy || breached.has(l.engineer.id));
  const problemIds = new Set(problem.map((l) => l.engineer.id));
  const clean = withRoute.filter((l) => !problemIds.has(l.engineer.id));
  const idle = view.loads.filter((l) => l.idle);
  const off = view.loads.filter((l) => !l.onShift);

  return [
    {
      key: 'routed',
      label: 'В работе',
      count: clean.length,
      ids: clean.map((l) => l.engineer.id),
      tone: 'ok'
    },
    {
      key: 'idle',
      label: 'Свободны',
      count: idle.length,
      ids: idle.map((l) => l.engineer.id),
      tone: 'wait'
    },
    {
      key: 'problem',
      label: 'Проблема',
      count: problem.length,
      ids: [...problemIds],
      tone: 'bad'
    },
    {
      key: 'off',
      label: 'Не на смене',
      count: off.length,
      ids: off.map((l) => l.engineer.id),
      tone: 'wait'
    }
  ];
}

/* ─── доски «Заявки» и «Инженеры» ──────────────────────────────────────
   Обе зависят от среза: «горит» и «свободен сейчас» имеют смысл только
   относительно момента, на который смотрит диспетчер. */

export interface ProblemBucket {
  key: string;
  label: string;
  count: number;
  orderIds: string[];
}

export interface BoardValue {
  key: string;
  label: string;
  icon: string;
  value: number;
  note: string;
  tone: 'neutral' | 'success' | 'danger' | 'accent';
  /** Раскрывается списком в правой панели. */
  groupKey?: string;
  orderIds: string[];
}

export interface OrdersBoard {
  values: BoardValue[];
  byType: { key: string; title: string; count: number; orderIds: string[] }[];
  problemBuckets: ProblemBucket[];
  /** С инженером: заявка стоит в чьём-то маршруте. */
  assignedIds: string[];
  /** Без инженера, окно ещё впереди. */
  freshIds: string[];
  /** Без инженера, окно уже открыто. */
  burningIds: string[];
  /** Уникальные id всего проблемного — то же число, что в квадрате «Проблемные». */
  problemIds: string[];
  /** Закрытые до расчёта: в «всего» входят, в раскладке нет. */
  closedIds: string[];
}

/** Заявка «новая», если исполнителя нет, а окно ещё даже не начиналось:
    её никто не тронул, и время пока есть. */
export function buildOrdersBoard(view: DayView, cut: Minutes): OrdersBoard {
  const assigned = [...view.stopByOrder.keys()];
  const fresh = view.unassigned.filter((o) => o.window_start > cut);
  const burning = view.unassigned.filter((o) => o.window_start <= cut);
  const sla = [...view.stopByOrder.entries()].filter(([, p]) => p.slaBreached);
  const tight = [...view.stopByOrder.entries()].filter(([, p]) => p.stop.risk !== 'low');
  const fragile = view.fragile;

  /* Заявки без инженера считаются в своём квадрате и в своей доле кольца,
     поэтому сюда они не попадают: иначе одно и то же число уезжало бы в два
     места и «проблемных» к вечеру становилось больше, чем заявок с риском. */
  const problemBuckets: ProblemBucket[] = [
    { key: 'sla', label: 'План нарушает крайний срок', count: sla.length, orderIds: sla.map(([id]) => id) },
    { key: 'tight', label: 'Стоят впритык', count: tight.length, orderIds: tight.map(([id]) => id) },
    {
      key: 'fragile',
      label: 'Держатся на честном слове',
      count: fragile.length,
      orderIds: fragile.map((f) => f.order.id)
    }
  ].filter((bucket) => bucket.count > 0);

  const problemIds = [...new Set(problemBuckets.flatMap((b) => b.orderIds))];

  const byType = view.workTypes.map((type) => ({
    key: type.key,
    title: type.title,
    count: type.count,
    orderIds: [...view.orderById.values()].filter((o) => o.work_type === type.key).map((o) => o.id)
  }));

  /* Первые три квадрата — разбиение без остатка: всего = с инженером + без
     инженера + закрытые до расчёта. Закрытых квадрата нет — они не ждут
     решения, — но в подписи к «всего» они названы, иначе сумма двух соседних
     квадратов не сходилась бы с первым. Четвёртый считает другое: он режет
     те же заявки поперёк, поэтому и подписан как срез, а не как ещё одна доля. */
  const closedNote = view.closed.length > 0 ? ` + ${view.closed.length} закрыто до расчёта` : '';
  return {
    values: [
      {
        key: 'total',
        label: 'Всего заявок',
        icon: 'clipboard-list',
        value: view.orderById.size,
        note: `${assigned.length} с инженером + ${view.unassigned.length} без${closedNote}`,
        tone: 'neutral',
        groupKey: 'all',
        orderIds: [...view.orderById.keys()]
      },
      {
        key: 'inwork',
        label: 'С инженером',
        icon: 'check-circle',
        value: assigned.length,
        note: 'Стоят в маршрутах',
        tone: 'success',
        groupKey: 'inwork',
        orderIds: assigned
      },
      {
        key: 'unassigned',
        label: 'Без инженера',
        icon: 'user',
        value: view.unassigned.length,
        note: burning.length > 0 ? `${burning.length} с открытым окном` : 'Окна ещё не открылись',
        tone: burning.length > 0 ? 'danger' : 'accent',
        groupKey: 'unassigned',
        orderIds: view.unassigned.map((o) => o.id)
      },
      {
        key: 'problems',
        label: 'Проблемные',
        icon: 'warning',
        value: problemIds.length,
        note: 'Инженер есть, но план шаткий',
        tone: 'danger',
        groupKey: 'problems',
        orderIds: problemIds
      }
    ],
    byType,
    problemBuckets,
    assignedIds: assigned,
    freshIds: fresh.map((o) => o.id),
    burningIds: burning.map((o) => o.id),
    problemIds,
    closedIds: view.closed.map((o) => o.id)
  };
}

export interface CrewBoard {
  values: BoardValue[];
  bySkill: { key: string; label: string; count: number; engineerIds: string[] }[];
  problemBuckets: { key: string; label: string; count: number; engineerIds: string[] }[];
  /** Вышел, а движок не поставил в маршрут ни одной заявки. */
  freeIds: string[];
  /** Сегодня не на смене: в штате числится, заявок не получает. */
  offShiftIds: string[];
}

/* Доска инженеров, как и доска заявок, описывает собранный день, а не текущую
   минуту: срез сюда не приходит вовсе. «Свободен» здесь значит «вышел, а
   движок не дал ни одной заявки», а не «сейчас не на визите» — и не «сегодня
   не работает»: того, кто не вышел, нагрузить нельзя. */
export function buildCrewBoard(view: DayView): CrewBoard {
  const onShift = view.loads.filter((l) => l.onShift && !l.idle);
  const free = view.loads.filter((l) => l.idle);
  const off = view.loads.filter((l) => !l.onShift);
  const heavy = service().thresholds.occupancy / 100;
  const overloaded = onShift.filter((l) => l.occupancy >= heavy);
  const withBreach = onShift.filter((load) =>
    [...view.stopByOrder.values()].some((p) => p.engineerId === load.engineer.id && p.slaBreached)
  );

  /* Незадействованные инженеры стоят отдельным квадратом и отдельной долей
     кольца, поэтому в «проблемных» их нет — иначе одно число уехало бы в два
     места. Остаются перегруз и сорванный срок. */
  const problemBuckets = [
    {
      key: 'overloaded',
      label: `Загрузка выше ${Math.round(heavy * 100)}%`,
      count: overloaded.length,
      engineerIds: overloaded.map((l) => l.engineer.id)
    },
    {
      key: 'breach',
      label: 'В маршруте есть нарушение срока',
      count: withBreach.length,
      engineerIds: withBreach.map((l) => l.engineer.id)
    }
  ].filter((bucket) => bucket.count > 0);

  const problemIds = [...new Set(problemBuckets.flatMap((b) => b.engineerIds))];

  const skills = new Map<string, string[]>();
  for (const load of view.loads) {
    for (const skill of load.engineer.skills) {
      skills.set(skill, [...(skills.get(skill) ?? []), load.engineer.id]);
    }
  }

  return {
    values: [
      {
        key: 'total',
        label: 'Всего инженеров',
        icon: 'users',
        value: view.loads.length,
        /* В штате, а не в смене: план держит весь штат, а вышли не все. */
        note: off.length > 0 ? `В штате, не на смене: ${off.length}` : 'В штате, все на смене',
        tone: 'neutral',
        groupKey: 'crew-all',
        orderIds: view.loads.map((l) => l.engineer.id)
      },
      {
        key: 'onshift',
        label: 'С маршрутом',
        icon: 'check-circle',
        value: onShift.length,
        note: 'Расчёт дал заявки',
        tone: 'success',
        groupKey: 'crew-onshift',
        orderIds: onShift.map((l) => l.engineer.id)
      },
      {
        key: 'problems',
        label: 'Проблемные',
        icon: 'warning',
        value: problemIds.length,
        note: 'Перегруз или срыв срока',
        tone: 'danger',
        groupKey: 'crew-problems',
        orderIds: problemIds
      },
      {
        key: 'free',
        label: 'Свободны',
        icon: 'info',
        value: free.length,
        note: 'Расчёт не дал ни одной заявки',
        tone: 'accent',
        groupKey: 'crew-free',
        orderIds: free.map((l) => l.engineer.id)
      }
    ],
    bySkill: [...skills.entries()]
      .map(([key, ids]) => ({ key, label: skillName(key), count: ids.length, engineerIds: ids }))
      .sort((a, b) => b.count - a.count),
    problemBuckets,
    freeIds: free.map((l) => l.engineer.id),
    offShiftIds: off.map((l) => l.engineer.id)
  };
}
