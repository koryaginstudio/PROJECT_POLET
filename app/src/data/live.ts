import type { DayView } from './derive.ts';
import { homeOf, placeOf } from './derive.ts';
import type { Minutes, Risk, Route, Stop } from './contract.ts';

/* Где инженер прямо сейчас.

   Мониторинг до сих пор отвечал числами: столько-то в пути, столько-то на
   объекте, эти опаздывают. На карте же лежал план целиком — одинаковый в
   девять утра и в шесть вечера, — и главный вопрос диспетчера остался без
   ответа: где человек находится в эту минуту и сколько ему ещё осталось.

   Здесь этот ответ и считается. План знает о каждом визите всё: когда
   инженер от прошлой точки выехал, когда доехал, когда взялся за работу и
   когда закончил, а ломаная перегона лежит в самой остановке. Значит
   положение на любую минуту — не догадка, а простая доля: сколько времени
   перегона прошло, столько же его длины и пройдено.

   Это по-прежнему план, а не спутниковая метка: движок раскладывает день, и
   живая точка показывает, где инженер должен быть по этому плану. Ровно за
   этим она и нужна — диспетчер сверяет её с тем, что человек говорит по
   телефону, и расхождение как раз и есть его работа. Отметки журнала
   («в пути», «выполнено», «сорвано») точку поправляют: выполненная заявка
   уходит за спину даже раньше плана, а «в пути» держит её впереди, пока
   человек не отчитался.

   Дробные минуты нарочно. Часы плана дискретны, но точка, переставляемая
   раз в минуту, читается как поломка: стоит двадцать секунд, потом прыгает
   на квартал. Внутри минуты положение считается дробно, и на карте она
   едет.

   Геометрию точка здесь не трогает: где на карте лежит её ломаная, знает
   карта — пути на общих улицах она разводит веером, и живая точка обязана
   ехать по той же нитке, что нарисована. Поэтому отсюда уходит не пара
   координат, а место на маршруте: номер перегона и доля пройденного. */

/** Что инженер делает на этой минуте.

    `before` и `done` точки не получают: пульсировать должно только живое.
    Но маршрут они делят по-разному — у первого весь путь впереди, у второго
    весь позади, — и молчанием эти два случая не различить. */
export type LiveKind = 'before' | 'wait' | 'ride' | 'site' | 'done';

export interface LiveSpot {
  engineerId: string;
  kind: LiveKind;
  /** Визит, к которому едет или на котором стоит: номер в маршруте, от нуля.
      У `before` — первый, у `done` — последний. */
  stopIndex: number;
  /** Доля перегона до этого визита, 0…1. Считается по времени плана: сколько
      времени перегона прошло, столько его длины и пройдено. */
  share: number;
  /** Заявка, о которой речь. */
  orderId: string;
  /** Откуда вышел этот перегон: прошлая заявка или адрес выезда. */
  from: string;
  /** Куда ведёт: адрес заявки. */
  to: string;
  /** Что будет после стоянки — для тех, кто стоит на заявке или ждёт выезда.
      Последний визит дня ответа не имеет, и тогда здесь пусто. */
  next: string;
  /** Когда обещан приезд. */
  arrive: Minutes;
  /** Когда взялся за работу по плану. */
  start: Minutes;
  /** Когда освободится по плану. */
  finish: Minutes;
  /** Сколько ещё ехать или работать, минуты. Округлено вверх: «осталось 0
      мин» о человеке, который ещё в дороге, — неправда. */
  left: number;
  /** На сколько минут план уже выбился за срок заявки. Ноль — идёт в срок. */
  lateMinutes: number;
  /** Запас у визита, к которому едет или на котором стоит, — тот же, что
      считает движок. Высокий риск значит «впритык»: опоздание ещё не факт,
      но план оставил на него мало места. */
  risk: Risk;
  /** Визитов позади и всего. */
  visitsDone: number;
  visitsTotal: number;
}

/** Когда инженер выехал к этому визиту.

    Плановая цепочка визита: закончил прошлый — поехал — приехал — подождал
    окна — начал — закончил. Значит выезд это приезд минус время в пути; но
    раньше, чем он закончил прошлую заявку, выехать нельзя, и между ними
    остаётся простой — та самая пауза, в которую человек свободен. */
const leaveOf = (route: Route, index: number, shiftStart: Minutes): Minutes => {
  const stop = route.stops[index];
  const ride = Math.max(0, stop.travel_minutes ?? 0);
  const floor = index > 0 ? route.stops[index - 1].finish : shiftStart;
  return Math.max(floor, stop.arrive - ride);
};

/** Место инженеров на маршрутах на дробную минуту `cut`.

    Ключ — номер инженера в том виде, в каком его знает карта: на общей карте
    нескольких участков он составной, и разбирать его здесь незачем.

    В ответе только те, у кого есть маршрут и кто сегодня на смене: тот, кого
    в смене нет, на карте не едет и пути не делит. */
export function buildLiveSpots(view: DayView, cut: number): Map<string, LiveSpot> {
  const spots = new Map<string, LiveSpot>();

  for (const { engineer, route, onShift } of view.loads) {
    if (!onShift || !route || route.stops.length === 0) continue;

    const visitsTotal = route.stops.length;
    const label = (stop: Stop) => {
      const order = view.orderById.get(stop.order_id);
      return order ? placeOf(order) : stop.order_id;
    };

    /* Позади ли визит — тем же правилом, что и в составе смены
       (`buildLiveRoster`): сперва слово журнала, потом часы плана. Два
       разных ответа на «прошёл ли он эту точку» развели бы список справа с
       картой. */
    const passed = (stop: Stop) => {
      const said = view.reported[stop.order_id];
      if (said === 'выполнено' || said === 'сорвано') return true;
      if (said === 'в пути') return false;
      return cut >= stop.finish;
    };

    const visitsDone = route.stops.filter(passed).length;
    const first = route.stops[0];
    const last = route.stops[visitsTotal - 1];

    const base = {
      engineerId: engineer.id,
      visitsDone,
      visitsTotal,
      lateMinutes: 0,
      risk: 'low' as Risk,
      next: ''
    };

    /* Смена ещё не началась: весь путь впереди, и точки нет. */
    if (cut < engineer.shift_start) {
      spots.set(engineer.id, {
        ...base,
        kind: 'before',
        stopIndex: 0,
        share: 0,
        orderId: first.order_id,
        from: homeOf(engineer),
        to: label(first),
        arrive: first.arrive,
        start: first.start,
        finish: first.finish,
        left: 0
      });
      continue;
    }

    const index = route.stops.findIndex((stop) => !passed(stop));
    /* День кончился: весь путь позади, и точка гаснет. */
    if (index < 0) {
      spots.set(engineer.id, {
        ...base,
        kind: 'done',
        stopIndex: visitsTotal - 1,
        share: 1,
        orderId: last.order_id,
        from: visitsTotal > 1 ? label(route.stops[visitsTotal - 2]) : homeOf(engineer),
        to: label(last),
        arrive: last.arrive,
        start: last.start,
        finish: last.finish,
        left: 0
      });
      continue;
    }

    const stop = route.stops[index];
    const leave = leaveOf(route, index, engineer.shift_start);
    const said = view.reported[stop.order_id];
    const order = view.orderById.get(stop.order_id);
    /* Опоздание считаем от срока заявки, а не от плана: диспетчеру важно,
       успеет ли инженер к обещанному клиенту времени. */
    const deadline = order?.sla_deadline ?? stop.finish;
    const lateMinutes = cut > deadline ? Math.round(cut - deadline) : 0;

    const common = {
      ...base,
      lateMinutes,
      risk: stop.risk,
      stopIndex: index,
      orderId: stop.order_id,
      from: index > 0 ? label(route.stops[index - 1]) : homeOf(engineer),
      to: label(stop),
      next: index + 1 < visitsTotal ? label(route.stops[index + 1]) : '',
      arrive: stop.arrive,
      start: stop.start,
      finish: stop.finish
    };

    /* Прошлую заявку закрыл, а ехать ещё рано: план оставил запас, и человек
       свободен на прошлой точке. Доля перегона нулевая — точка стоит там,
       откуда поедет. */
    if (cut < leave) {
      spots.set(engineer.id, {
        ...common,
        kind: 'wait',
        share: 0,
        left: Math.ceil(leave - cut)
      });
      continue;
    }

    /* Ещё в дороге: доля перегона — доля прошедшего времени в пути. Журнал
       сильнее плана: сказал «в пути» — значит в пути, даже если по часам
       давно приехал; точка тогда стоит у самого порога.

       Перегон без времени в пути (следующий визит в том же доме) проезжается
       разом: делить на ноль нечего, и доля сразу полная. */
    const riding = cut < stop.arrive || said === 'в пути';
    if (riding) {
      const span = stop.arrive - leave;
      const share = span > 0 ? Math.min(1, Math.max(0, (cut - leave) / span)) : 1;
      spots.set(engineer.id, {
        ...common,
        kind: 'ride',
        share,
        left: Math.max(0, Math.ceil(stop.arrive - cut))
      });
      continue;
    }

    /* На месте: работает или ждёт, пока откроется окно заявки. Разницы для
       карты нет — точка стоит на самой заявке, — а словами она сказана в
       подсказке. */
    spots.set(engineer.id, {
      ...common,
      kind: 'site',
      share: 1,
      left: Math.max(0, Math.ceil(stop.finish - cut))
    });
  }

  return spots;
}

/* ─── меры по ломаной ────────────────────────────────────────────────────
   Доля перегона считается по времени, а лечь должна на длину: инженер,
   проехавший половину минут, проехал половину улиц, а не половину вершин —
   их маршрутизатор ставит где придётся, густо на поворотах и редко на
   прямых. Поэтому карте нужны накопленные длины и точка на расстоянии.

   Длины считаем плоско, с поправкой широты на долготу: город — сотня
   километров, и разница с настоящей геодезией здесь меньше доли процента, а
   нужна она для пропорции, не для пробега. */

const M_PER_DEG_LAT = 111320;

/** Накопленная длина ломаной по вершинам, метры. */
export function spanOf(points: [number, number][]): number[] {
  const cum = [0];
  if (points.length === 0) return cum;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((points[0][0] * Math.PI) / 180);
  for (let i = 1; i < points.length; i += 1) {
    const dy = (points[i][0] - points[i - 1][0]) * M_PER_DEG_LAT;
    const dx = (points[i][1] - points[i - 1][1]) * mPerDegLon;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

/** Точка на расстоянии `d` метров от начала ломаной и номер вершины перед
    ней: карте нужны обе — по первой она ставит живую точку, по второй режет
    пройденную часть пути. */
export function pointAt(
  points: [number, number][],
  cum: number[],
  d: number
): { point: [number, number]; index: number } {
  const last = cum.length - 1;
  if (last < 0) return { point: [0, 0], index: 0 };
  if (d <= 0) return { point: points[0], index: 0 };
  if (d >= cum[last]) return { point: points[last], index: last };

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const step = cum[hi] - cum[lo];
  const t = step > 0 ? (d - cum[lo]) / step : 0;
  return {
    point: [
      points[lo][0] + (points[hi][0] - points[lo][0]) * t,
      points[lo][1] + (points[hi][1] - points[lo][1]) * t
    ],
    index: lo
  };
}
