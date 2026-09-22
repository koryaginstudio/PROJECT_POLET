/* Выгрузка расчёта книгой Excel.

   В книгу идёт весь расчёт, а не только то, как поработал движок. Заявки
   все до одной со всеми полями, весь штат, точки обслуживания, маршруты,
   визиты по порядку объезда и разбор движка по каждой заявке. Правило
   простое: если это известно про расчёт — это должно быть в выгрузке.
   Человек, открывший её, не должен возвращаться в интерфейс за цифрой,
   которая там была.

   Восемь листов, и у каждого свой читатель. Сводка — для того, кто
   спрашивает «что вышло». Заявки — для того, кому нужен весь массив.
   Маршруты и визиты — для тех, кто поедет и кто раздаёт. Без инженера —
   для разговора с начальством. Инженеры и клиенты — справочники этого дня.
   Почему так — единственный лист, который отвечает на «а нельзя было
   иначе».

   Ни одна цифра здесь не считается заново: всё берётся из форм, которые
   вернул движок. Посчитать среднее в выгрузке своим способом — верный путь к
   тому, что однажды отчёт и экран назовут разные числа одним именем.
   Исключение одно — свёртка заявок по адресу на листе клиентов, и она
   ничего не выводит, а только группирует. */

import type { Day, Order } from './contract.ts';
import { engineDayTitle } from './load.ts';
import type { RunEntry } from './load.ts';
import { deadline, hhmm, isDeferrable, placeOf, homeOf } from './derive.ts';
import {
  engineerStatusName,
  equipmentName,
  isUrgent,
  orderClassName,
  orderClosed,
  priorityClassName,
  priorityName,
  reasonName,
  requiredTransportName,
  skillName,
  statusName,
  teamName,
  techName,
  transportName
} from './dictionary.ts';
import { workbook, download } from './xlsx.ts';
import type { Cell, Sheet } from './xlsx.ts';

const RISK: Record<string, string> = {
  low: 'спокойно',
  medium: 'впритык',
  high: 'под угрозой'
};

/** Доля 0…1 процентом: в книге проценты пишутся числом, чтобы по ним можно
    было сортировать и считать, а не строкой со знаком. */
const percent = (share: number) => Math.round(share * 1000) / 10;

/** Число из чужого плана: поле может отсутствовать, и тогда в ячейке
    прочерк, а не `undefined`, который Excel показал бы пустотой без
    объяснения. */
const num = (value: number | null | undefined): Cell => (Number.isFinite(value) ? value : '—');

/* Подписи к полям заявки — словами справочника, теми же, что на экране.
   Свои слова здесь стояли раньше: «авария» вместо «Высокий», «повторный
   визит» вместо «Средний», — и в книге приоритет назывался не так, как в
   карточке той же заявки. */
const yesNo = (value: boolean | null | undefined) => (value ? 'да' : 'нет');
const equipmentOf = (order: Order) => (order.required_equipment ?? []).map(equipmentName).join(', ');
const techOf = (order: Order) => (order.tech ? techName(order.tech) : '');

export function buildReport(day: Day, run: RunEntry): Sheet[] {
  const { plan, explain, simulation } = day;
  const orderById = new Map(plan.orders.map((order) => [order.id, order]));
  const engineerById = new Map(plan.engineers.map((engineer) => [engineer.id, engineer]));
  const nameOf = (engineerId: string | null | undefined) =>
    engineerId ? engineerById.get(engineerId)?.name ?? engineerId : '';

  /* Закрытых до расчёта считаем по самим заявкам, а не по полю: план из
     архива движка поля не знает, а статусы у заявок есть. */
  const closed = plan.orders.filter(orderClosed).length;
  const unassigned = plan.unassigned.filter((id) => {
    const order = orderById.get(id);
    return !order || !orderClosed(order);
  });

  /* Симуляции могло не быть: расчёт в интерфейсе день не разыгрывает, и
     тогда границы разброса — не оценка, а то же число, что и среднее.
     Печатать их как p10 и p90 значило бы выдать одно значение за три. */
  const simulated = simulation.meta.runs > 0;
  const baseline = plan.meta.baseline;

  /* ─── сводка ───────────────────────────────────────────────────────────
     Две колонки, а не таблица: это карточка расчёта, и читают её сверху
     вниз. Переменные движка стоят здесь же — без них два расчёта на одном
     дне выглядят необъяснимо разными. */
  const summary: Sheet = {
    name: 'Сводка',
    rows: [
      ['Расчёт', run.code],
      ['Заведён', run.created.replace('T', ' ')],
      /* Участок словами выгрузки («Югоцентр»), а не кодом движка: рядом
         на экранах стоит то же слово, и в выгрузке оно обязано совпасть. */
      ['Участок', run.day ? engineDayTitle(run.day) : '—'],
      ['Заметка', run.note ?? ''],
      [],
      ['Заявок в выгрузке', plan.orders.length],
      ['Закрыто до расчёта', closed],
      ['Заявок в расчёте', plan.meta.orders_total],
      ['Разложено по инженерам', plan.meta.orders_assigned],
      ['Осталось без инженера', unassigned.length],
      ['Инженеров в штате', plan.meta.engineers_total],
      ['Инженеров с маршрутом', new Set(plan.routes.map((r) => r.engineer_id)).size],
      ['Пробег всего, км', num(plan.meta.distance_km_total)],
      [],
      [simulated ? 'Покрытие по симуляции, %' : 'Заявок разложено, %', simulation.coverage],
      ['Прогонов симуляции', simulation.meta.runs],
      [simulated ? 'Выполнено визитов, среднее' : 'Разложено визитов', simulation.done.mean],
      ['Выполнено, нижняя граница (p10)', simulated ? simulation.done.p10 : 'не разыгрывалось'],
      ['Выполнено, верхняя граница (p90)', simulated ? simulation.done.p90 : 'не разыгрывалось'],
      [],
      ['Неравномерность загрузки (джини)', plan.meta.balance.gini],
      ['Загрузка, минимум %', percent(plan.meta.balance.occupancy_min)],
      ['Загрузка, максимум %', percent(plan.meta.balance.occupancy_max)],
      ['Загрузка, среднее %', percent(plan.meta.balance.occupancy_mean)],
      ['Инженеров без маршрута', plan.meta.balance.idle_engineers],
      [],
      ['Переработка всего, мин', simulation.overtime_minutes],
      ['Простой всего, мин', simulation.idle_minutes],
      /* Базовый вариант ТЗ — вторая половина требования «сравните с
         базовым»: без него число разложенных не с чем сравнить. Пусто у
         плана, который его не считал. */
      ...(baseline
        ? ([
            [],
            ['— базовый вариант —', ''],
            ['Разложено базовым вариантом', baseline.orders_assigned],
            ['Инженеров с маршрутом у базового', baseline.engineers_used],
            ['Пробег базового, км', num(baseline.distance_km_total)],
            ['В дороге у базового, мин', baseline.travel_minutes_total],
            ['Чем считали базовый', baseline.solver]
          ] as Cell[][])
        : []),
      [],
      ['— переменные движка —', ''],
      ['Запас по времени работ', run.params.duration_factor],
      ['Консервативность маршрута, мин', run.params.buffer_step],
      ['Зазор до первого визита, мин', run.params.buffer_base],
      ['Равномерность загрузки', run.params.balance_weight],
      ['Держаться за объявленный план', run.params.churn_penalty],
      [],
      ['Схема контракта', plan.schema],
      ['Солвер', plan.meta.solver],
      ['Время счёта, с', run.solveSeconds ?? '—']
    ]
  };

  /* ─── маршруты ─────────────────────────────────────────────────────── */
  const routes: Sheet = {
    name: 'Маршруты',
    rows: [
      [
        'Инженер',
        'Табельный',
        'Выезжает из',
        'Смена с',
        'Смена до',
        'Визитов',
        'Первый визит',
        'Последний визит',
        'В дороге, мин',
        'В работе, мин',
        'Ожидание окон, мин',
        'Переработка, мин',
        'Загрузка, %',
        'Пробег, км',
        'Транспорт'
      ],
      ...plan.routes.map((route) => {
        const engineer = engineerById.get(route.engineer_id);
        return [
          engineer?.name ?? route.engineer_id,
          route.engineer_id,
          engineer ? homeOf(engineer) : '',
          engineer ? hhmm(engineer.shift_start) : '',
          engineer ? hhmm(engineer.shift_end) : '',
          route.totals.visits,
          hhmm(route.totals.start),
          hhmm(route.totals.end),
          route.totals.travel_minutes,
          route.totals.work_minutes,
          route.totals.idle_minutes,
          route.totals.overtime_minutes,
          percent(route.totals.occupancy),
          num(route.totals.distance_km),
          engineer?.transport ? transportName(engineer.transport) : ''
        ];
      })
    ]
  };

  /* ─── заявки ────────────────────────────────────────────────────────
     Все до одной, а не только невзятые. Выгрузка расчёта — это выгрузка
     дня целиком: кто-то откроет её, чтобы разобрать отказы, а кто-то —
     чтобы просто увидеть весь массив заявок с адресами и окнами, и второму
     лист «без инженера» ничего не даёт. */
  const seqByOrder = new Map<string, { engineer: string; stop: (typeof plan.routes)[0]['stops'][0] }>();
  for (const route of plan.routes) {
    const engineer = engineerById.get(route.engineer_id);
    for (const stop of route.stops) {
      seqByOrder.set(stop.order_id, { engineer: engineer?.name ?? route.engineer_id, stop });
    }
  }

  /* Поля схемы 1.2 стоят рядом с полями раскладки: класс из учётной
     системы, статус визита, транспорт, оборудование, технология, контакт и
     закрепление. Движку они безразличны, читателю книги — нет: «что мы об
     этой заявке знаем» и «как она легла» — один лист, а не два. */
  const orders: Sheet = {
    name: 'Заявки',
    rows: [
      [
        'Заявка',
        'Что делаем',
        'Код работ',
        'Класс',
        'Нужен навык',
        'Адрес',
        'Район',
        'Широта',
        'Долгота',
        'Окно с',
        'Окно до',
        'Крайний срок',
        'Переносима на завтра',
        'Приоритет',
        'Уровень приоритета',
        'Работы, мин',
        'Нужен доступ',
        'Статус в выгрузке',
        'Транспорт',
        'Оборудование',
        'Технология',
        'Гигабит',
        'Контакт',
        'Телефон',
        'Закреплена за',
        'В плане',
        'Инженер',
        '№ визита',
        'Приезд',
        'Начало',
        'Конец',
        'Перегон, км',
        'Запас, мин',
        'Риск',
        'Причина отказа',
        'Почему так'
      ],
      ...plan.orders.map((order) => {
        const placed = seqByOrder.get(order.id);
        const why = explain.orders[order.id]?.summary ?? '';
        const inPlan = orderClosed(order)
          ? 'закрыта до расчёта'
          : placed
            ? 'в маршруте'
            : 'без инженера';
        return [
          order.id,
          order.work_title,
          order.work_type,
          order.order_class ? orderClassName(order.order_class) : '',
          skillName(order.skill),
          placeOf(order),
          order.district,
          order.lat,
          order.lon,
          hhmm(order.window_start),
          hhmm(order.window_end),
          deadline(order.sla_deadline),
          yesNo(isDeferrable(order)),
          priorityClassName(order.priority_class, order.priority),
          priorityName(order.priority),
          order.est_minutes,
          yesNo(order.needs_access),
          order.status ? statusName(order.status) : '',
          requiredTransportName(order.required_transport),
          equipmentOf(order),
          techOf(order),
          order.gigabit == null ? '' : yesNo(order.gigabit),
          order.contact?.name ?? '',
          order.contact?.phone ?? '',
          nameOf(order.locked_to),
          inPlan,
          placed?.engineer ?? '',
          placed ? placed.stop.seq + 1 : '',
          placed ? hhmm(placed.stop.arrive) : '',
          placed ? hhmm(placed.stop.start) : '',
          placed ? hhmm(placed.stop.finish) : '',
          placed ? num(placed.stop.distance_km) : '',
          placed ? placed.stop.slack_minutes : '',
          placed ? RISK[placed.stop.risk] ?? placed.stop.risk : '',
          order.unassigned_reason ? reasonName(order.unassigned_reason.code) : '',
          why
        ];
      })
    ]
  };

  /* ─── визиты ────────────────────────────────────────────────────────
     Лист, который печатают и раздают: строка — одна поездка, по порядку
     объезда, с адресом и часом. */
  const visits: Sheet = {
    name: 'Визиты',
    rows: [
      [
        'Инженер',
        '№ визита',
        'Заявка',
        'Что делаем',
        'Адрес',
        'Район',
        'Окно с',
        'Окно до',
        'Приезд',
        'Начало',
        'Конец',
        'Дорога, мин',
        'Перегон, км',
        'Ожидание, мин',
        'Запас, мин',
        'Риск',
        'Нужен доступ',
        'Оборудование',
        'Контакт',
        'Телефон'
      ]
    ]
  };
  for (const route of plan.routes) {
    const engineer = engineerById.get(route.engineer_id);
    for (const stop of route.stops) {
      const order = orderById.get(stop.order_id);
      visits.rows.push([
        engineer?.name ?? route.engineer_id,
        stop.seq + 1,
        stop.order_id,
        order?.work_title ?? '',
        order ? placeOf(order) : '',
        order?.district ?? '',
        order ? hhmm(order.window_start) : '',
        order ? hhmm(order.window_end) : '',
        hhmm(stop.arrive),
        hhmm(stop.start),
        hhmm(stop.finish),
        stop.travel_minutes,
        num(stop.distance_km),
        stop.wait_minutes,
        stop.slack_minutes,
        RISK[stop.risk] ?? stop.risk,
        yesNo(order?.needs_access),
        order ? equipmentOf(order) : '',
        order?.contact?.name ?? '',
        order?.contact?.phone ?? ''
      ]);
    }
  }

  /* ─── без инженера ──────────────────────────────────────────────────
     Лист, ради которого выгрузку и открывают во второй раз. Причина берётся
     из «объяснения»: движок сам знает, почему заявка никуда не влезла, и
     придумывать за него здесь нечего. */
  const loose: Sheet = {
    name: 'Без инженера',
    rows: [
      [
        'Заявка',
        'Что делаем',
        'Адрес',
        'Район',
        'Окно с',
        'Окно до',
        'Крайний срок',
        'Переносима на завтра',
        'Приоритет',
        'Работы, мин',
        'Нужен навык',
        'Транспорт',
        'Закреплена за',
        'Причина',
        'Почему не влезла'
      ],
      ...unassigned.map((id) => {
        const order = orderById.get(id);
        const why = explain.orders[id]?.summary ?? '';
        return [
          id,
          order?.work_title ?? '',
          order ? placeOf(order) : '',
          order?.district ?? '',
          order ? hhmm(order.window_start) : '',
          order ? hhmm(order.window_end) : '',
          order ? deadline(order.sla_deadline) : '',
          order ? yesNo(isDeferrable(order)) : '',
          order ? priorityClassName(order.priority_class, order.priority) : '',
          order?.est_minutes ?? '',
          order ? skillName(order.skill) : '',
          order ? requiredTransportName(order.required_transport) : '',
          nameOf(order?.locked_to),
          order?.unassigned_reason ? reasonName(order.unassigned_reason.code) : '',
          why
        ];
      })
    ]
  };

  /* ─── инженеры ──────────────────────────────────────────────────────
     Весь штат, а не только те, кто поехал: инженер без маршрута — это факт
     расчёта, и в выгрузке он должен быть виден, а не отсутствовать. */
  const crew: Sheet = {
    name: 'Инженеры',
    rows: [
      [
        'Табельный',
        'Имя',
        'Навыки',
        'Разряд',
        'Статус',
        'Транспорт',
        'Бригада',
        'Участок',
        'Телефон',
        'Смена с',
        'Смена до',
        'Длина смены, мин',
        'Выезжает из',
        'Широта',
        'Долгота',
        'Получил маршрут',
        'Визитов',
        'Первый визит',
        'Последний визит',
        'В дороге, мин',
        'Пробег, км',
        'В работе, мин',
        'Ожидание окон, мин',
        'Переработка, мин',
        'Загрузка, %',
        'Визитов под угрозой'
      ],
      ...plan.engineers.map((engineer) => {
        const route = plan.routes.find((r) => r.engineer_id === engineer.id);
        const risky = route
          ? route.stops.filter((stop) => stop.risk !== 'low').length
          : 0;
        return [
          engineer.id,
          engineer.name,
          engineer.skills.map(skillName).join(', '),
          engineer.grade,
          engineer.status ? engineerStatusName(engineer.status) : '',
          engineer.transport ? transportName(engineer.transport) : '',
          engineer.team ? teamName(engineer.team) : '',
          engineer.zone ?? '',
          engineer.phone ?? '',
          hhmm(engineer.shift_start),
          hhmm(engineer.shift_end),
          engineer.shift_end - engineer.shift_start,
          homeOf(engineer),
          engineer.home_lat,
          engineer.home_lon,
          yesNo(Boolean(route)),
          route?.totals.visits ?? 0,
          route ? hhmm(route.totals.start) : '',
          route ? hhmm(route.totals.end) : '',
          route?.totals.travel_minutes ?? 0,
          route ? num(route.totals.distance_km) : 0,
          route?.totals.work_minutes ?? 0,
          route?.totals.idle_minutes ?? 0,
          route?.totals.overtime_minutes ?? 0,
          route ? percent(route.totals.occupancy) : 0,
          risky
        ];
      })
    ]
  };

  /* ─── клиенты ───────────────────────────────────────────────────────
     Точки обслуживания этого дня, свёрнутые по адресу. Справочника клиентов
     в контракте нет, и выдумывать его здесь нельзя — но дом, откуда пришли
     две заявки, это один дом, и в выгрузке он должен быть одной строкой. */
  interface Spot {
    address: string;
    district: string;
    lat: number;
    lon: number;
    orders: string[];
    assigned: number;
    closed: number;
    access: number;
    urgent: number;
    minutes: number;
    types: Set<string>;
    firstWindow: number;
    lastWindow: number;
  }
  const spots = new Map<string, Spot>();
  for (const order of plan.orders) {
    const key = order.address ?? `${order.district} · ${order.lat},${order.lon}`;
    let spot = spots.get(key);
    if (!spot) {
      spot = {
        address: placeOf(order),
        district: order.district,
        lat: order.lat,
        lon: order.lon,
        orders: [],
        assigned: 0,
        closed: 0,
        access: 0,
        urgent: 0,
        minutes: 0,
        types: new Set<string>(),
        firstWindow: Infinity,
        lastWindow: 0
      };
      spots.set(key, spot);
    }
    spot.orders.push(order.id);
    if (seqByOrder.has(order.id)) spot.assigned += 1;
    if (orderClosed(order)) spot.closed += 1;
    if (order.needs_access) spot.access += 1;
    if (isUrgent(order.priority_class, order.priority)) spot.urgent += 1;
    spot.minutes += order.est_minutes;
    spot.types.add(order.work_title);
    spot.firstWindow = Math.min(spot.firstWindow, order.window_start);
    spot.lastWindow = Math.max(spot.lastWindow, order.window_end);
  }

  const clients: Sheet = {
    name: 'Клиенты',
    rows: [
      [
        'Адрес обслуживания',
        'Район',
        'Широта',
        'Долгота',
        'Заявок',
        'В маршруте',
        'Без инженера',
        'Закрыто до расчёта',
        'Виды работ',
        'Нужен доступ',
        'Срочных',
        'Работы всего, мин',
        'Раннее окно',
        'Позднее окно',
        'Номера заявок'
      ],
      ...[...spots.values()]
        .sort((a, b) => b.orders.length - a.orders.length || a.address.localeCompare(b.address, 'ru'))
        .map((spot) => [
          spot.address,
          spot.district,
          spot.lat,
          spot.lon,
          spot.orders.length,
          spot.assigned,
          /* Без инженера — из открытых: закрытая до расчёта его не ждала. */
          spot.orders.length - spot.assigned - spot.closed,
          spot.closed,
          [...spot.types].join(', '),
          spot.access,
          spot.urgent,
          spot.minutes,
          hhmm(spot.firstWindow),
          hhmm(spot.lastWindow),
          spot.orders.join(', ')
        ])
    ]
  };

  /* ─── почему так ────────────────────────────────────────────────────
     Разбор движка по каждой заявке: кого он рассматривал и почему тот не
     подошёл. Это единственный лист, который отвечает на «а нельзя было
     иначе», и без него выгрузка описывает результат, но не решение. */
  const VERDICT: Record<string, string> = {
    chosen: 'выбран',
    feasible: 'мог взять',
    no_room: 'нет места в маршруте',
    shift_mismatch: 'не совпадает смена',
    no_skill: 'нет навыка',
    no_vehicle: 'нет транспорта',
    no_equipment: 'нет оборудования'
  };
  const reasons: Sheet = {
    name: 'Почему так',
    rows: [
      ['Заявка', 'Итог', 'Инженер', 'Вердикт', 'Стоимость', 'Пояснение']
    ]
  };
  for (const order of plan.orders) {
    const card = explain.orders[order.id];
    if (!card) continue;
    for (const candidate of card.candidates) {
      const engineer = engineerById.get(candidate.engineer_id);
      reasons.rows.push([
        order.id,
        card.summary,
        engineer?.name ?? candidate.engineer_id,
        VERDICT[candidate.verdict] ?? candidate.verdict,
        candidate.cost ?? '',
        candidate.note
      ]);
    }
  }

  return [summary, orders, routes, visits, loose, crew, clients, reasons];
}

/** Собирает книгу и отдаёт её браузеру. */
export function exportRun(day: Day, run: RunEntry): void {
  const blob = workbook(buildReport(day, run));
  /* Имя файла — номер расчёта и дата: в папке «Загрузки» через неделю по
     нему и ищут, а «отчёт (3).xlsx» не ищется никак. */
  download(blob, `Расчёт ${run.code} — ${run.date}.xlsx`);
}
