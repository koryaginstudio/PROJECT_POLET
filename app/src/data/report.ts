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

import type { Day } from './contract.ts';
import type { RunEntry } from './load.ts';
import { dayEnd, deadline, hhmm, placeOf, homeOf } from './derive.ts';
import { skillName } from './dictionary.ts';
import { workbook, download } from './xlsx.ts';
import type { Sheet } from './xlsx.ts';

const RISK: Record<string, string> = {
  low: 'спокойно',
  medium: 'впритык',
  high: 'под угрозой'
};

const PRIORITY: Record<number, string> = {
  0: 'обычный',
  1: 'повторный визит',
  2: 'авария'
};

/** Доля 0…1 процентом: в книге проценты пишутся числом, чтобы по ним можно
    было сортировать и считать, а не строкой со знаком. */
const percent = (share: number) => Math.round(share * 1000) / 10;

export function buildReport(day: Day, run: RunEntry): Sheet[] {
  const { plan, explain, simulation } = day;
  const orderById = new Map(plan.orders.map((order) => [order.id, order]));
  const engineerById = new Map(plan.engineers.map((engineer) => [engineer.id, engineer]));

  /* ─── сводка ───────────────────────────────────────────────────────────
     Две колонки, а не таблица: это карточка расчёта, и читают её сверху
     вниз. Переменные движка стоят здесь же — без них два расчёта на одном
     дне выглядят необъяснимо разными. */
  const summary: Sheet = {
    name: 'Сводка',
    rows: [
      ['Расчёт', run.code],
      ['Заведён', run.created.replace('T', ' ')],
      ['День', run.day ?? '—'],
      ['Заметка', run.note ?? ''],
      [],
      ['Заявок в дне', plan.meta.orders_total],
      ['Разложено по инженерам', plan.meta.orders_assigned],
      ['Осталось без инженера', plan.unassigned.length],
      ['Инженеров в штате', plan.meta.engineers_total],
      ['Инженеров с маршрутом', new Set(plan.routes.map((r) => r.engineer_id)).size],
      [],
      ['Покрытие по симуляции, %', simulation.coverage],
      ['Прогонов симуляции', simulation.meta.runs],
      ['Выполнено визитов, среднее', simulation.done.mean],
      ['Выполнено, нижняя граница (p10)', simulation.done.p10],
      ['Выполнено, верхняя граница (p90)', simulation.done.p90],
      [],
      ['Неравномерность загрузки (джини)', plan.meta.balance.gini],
      ['Загрузка, минимум %', percent(plan.meta.balance.occupancy_min)],
      ['Загрузка, максимум %', percent(plan.meta.balance.occupancy_max)],
      ['Загрузка, среднее %', percent(plan.meta.balance.occupancy_mean)],
      ['Инженеров без маршрута', plan.meta.balance.idle_engineers],
      [],
      ['Переработка всего, мин', simulation.overtime_minutes],
      ['Простой всего, мин', simulation.idle_minutes],
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
        'Загрузка, %'
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
          percent(route.totals.occupancy)
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

  const orders: Sheet = {
    name: 'Заявки',
    rows: [
      [
        'Заявка',
        'Что делаем',
        'Код работ',
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
        'Работы, мин',
        'Нужен доступ',
        'Статус',
        'Инженер',
        '№ визита',
        'Приезд',
        'Начало',
        'Конец',
        'Запас, мин',
        'Риск',
        'Почему так'
      ],
      ...plan.orders.map((order) => {
        const placed = seqByOrder.get(order.id);
        const why = explain.orders[order.id]?.summary ?? '';
        return [
          order.id,
          order.work_title,
          order.work_type,
          skillName(order.skill),
          placeOf(order),
          order.district,
          order.lat,
          order.lon,
          hhmm(order.window_start),
          hhmm(order.window_end),
          deadline(order.sla_deadline),
          order.sla_deadline > dayEnd() ? 'да' : 'нет',
          PRIORITY[order.priority] ?? String(order.priority),
          order.est_minutes,
          order.needs_access ? 'да' : 'нет',
          placed ? 'в маршруте' : 'без инженера',
          placed?.engineer ?? '',
          placed ? placed.stop.seq + 1 : '',
          placed ? hhmm(placed.stop.arrive) : '',
          placed ? hhmm(placed.stop.start) : '',
          placed ? hhmm(placed.stop.finish) : '',
          placed ? placed.stop.slack_minutes : '',
          placed ? RISK[placed.stop.risk] ?? placed.stop.risk : '',
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
        'Ожидание, мин',
        'Запас, мин',
        'Риск',
        'Нужен доступ'
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
        stop.wait_minutes,
        stop.slack_minutes,
        RISK[stop.risk] ?? stop.risk,
        order?.needs_access ? 'да' : 'нет'
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
        'Приоритет',
        'Работы, мин',
        'Нужен навык',
        'Почему не влезла'
      ],
      ...plan.unassigned.map((id) => {
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
          order ? PRIORITY[order.priority] ?? String(order.priority) : '',
          order?.est_minutes ?? '',
          order ? skillName(order.skill) : '',
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
          hhmm(engineer.shift_start),
          hhmm(engineer.shift_end),
          engineer.shift_end - engineer.shift_start,
          homeOf(engineer),
          engineer.home_lat,
          engineer.home_lon,
          route ? 'да' : 'нет',
          route?.totals.visits ?? 0,
          route ? hhmm(route.totals.start) : '',
          route ? hhmm(route.totals.end) : '',
          route?.totals.travel_minutes ?? 0,
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
    if (order.needs_access) spot.access += 1;
    if (order.priority >= 2) spot.urgent += 1;
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
          spot.orders.length - spot.assigned,
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
    no_skill: 'нет навыка'
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
