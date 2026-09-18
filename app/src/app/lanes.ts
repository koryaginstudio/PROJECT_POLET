/* Слои маршрутов на общей дороге.

   Два инженера, едущие по одной улице, — это две линии в одних и тех же
   пикселях: видно только ту, что нарисована последней. Читается это не как
   «они едут вместе», а как «второго маршрута здесь нет»; на карте дня, где
   путей дюжина, пропадали целые перегоны.

   Сначала пути разводились вбок, полосами, как линии на схеме метро. Но пять
   инженеров на одном проспекте давали пять линий рядом — на карте это пять
   разных дорог, которых в городе нет, и ни одна из них не лежит на той, по
   которой едут.

   Поэтому теперь все едут по оси своей дороги, а различает их толщина: один
   маршрут рисуется поверх и тоньше, другой — под ним и шире ровно настолько,
   чтобы выступить из-под него узкой каймой с обеих сторон. Дорога остаётся
   одна, а цветов на ней видно столько, сколько по ней едет.

   Толщина у маршрута одна на весь путь. Считать её по кускам — где он один,
   тоньше, где вдвоём, шире — казалось бережливее, но на экране линия то
   толстела, то худела посреди улицы, и читалось это как сбой отрисовки, а не
   как «здесь он едет не один».

   Раз толщина одна, её назначают как цвета на карте: маршруту достаётся самая
   тонкая из тех, что не заняты теми, с кем он делит дорогу. Двое, которые
   нигде не встречаются, спокойно берут одну и ту же.

   Число толщин при этом ограничено сверху, и это сознательная уступка. В
   плотном центре одиннадцать путей делят дороги попарно все со всеми, и
   честная раскладка потребовала бы одиннадцати толщин — последняя вышла бы в
   восемнадцать пикселей, шире квартала, по которому идёт. Поэтому толщин
   немного, а тем, кому не хватило, достаётся самая редкая у соседей: на
   длинных общих улицах цвета по-прежнему расходятся, а на коротких двое
   могут совпасть — там верхний закроет нижнего.

   Совпадение ищем по клеткам, а не по вершинам. Маршрутизатор отдаёт ломаную
   упрощённой с допуском в два десятка метров, и одна и та же улица у двух
   маршрутов описана разными точками — точного совпадения ждать нельзя. Путь
   разбивается шагом мельче клетки, каждый шаг метит клетку сетки, и клетка,
   помеченная дважды, говорит, что здесь двое едут рядом.

   Короткие совпадения отбрасываем: на перекрёстке общая клетка есть всегда, и
   без этого соседями считались бы все со всеми. */

/** Шаг разбивки пути, метры. Мельче клетки — иначе путь перешагивает клетки
    по диагонали и часть общей дороги остаётся неразмеченной. */
const STEP = 20;

/** Сторона клетки, метры. Примерно ширина перекрёстка: соседние полосы одной
    магистрали попадают в одну клетку, соседние улицы — уже в разные. */
const CELL = 40;

/** Короче этого совпадение считаем случайным пересечением, метры. */
const MIN_RUN = 200;

const M_PER_DEG_LAT = 111320;

export interface Lane {
  /** Ломаная маршрута как есть: по оси своей дороги, без сдвигов. */
  points: [number, number][];
  /** Толщина: 0 — поверх всех и самый тонкий, дальше каждый следующий шире на
      кайму. Одна на весь путь. */
  rank: number;
  /** Делит ли маршрут дорогу хоть с кем-нибудь. */
  shared: boolean;
}

export interface RoutePath {
  id: string;
  points: [number, number][];
}

/** Накопленная длина пути по вершинам, метры. */
function measure(points: [number, number][], mPerDegLon: number): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    const dy = (points[i][0] - points[i - 1][0]) * M_PER_DEG_LAT;
    const dx = (points[i][1] - points[i - 1][1]) * mPerDegLon;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

/** Точка на расстоянии `d` метров от начала пути. */
function at(points: [number, number][], cum: number[], d: number): [number, number] {
  const last = cum.length - 1;
  if (d <= 0) return points[0];
  if (d >= cum[last]) return points[last];

  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid;
  }
  const span = cum[hi] - cum[lo];
  const t = span > 0 ? (d - cum[lo]) / span : 0;
  return [
    points[lo][0] + (points[hi][0] - points[lo][0]) * t,
    points[lo][1] + (points[hi][1] - points[lo][1]) * t
  ];
}

/** Раскладывает маршруты по толщинам. Порядок путей в списке задаёт
    старшинство: кто выше, тот и получает толщину потоньше, то есть рисуется
    поверх остальных. */
export function laneLayout(paths: RoutePath[], levels = 5): Map<string, Lane> {
  const lanes = new Map<string, Lane>();
  const usable = paths.filter((path) => path.points.length >= 2);
  if (usable.length === 0) return lanes;

  /* Широта для перевода градусов в метры берётся одна на всю карту. Считать
     её в каждой точке нельзя: множитель для долготы тогда плывёт вместе с
     широтой, и сетка расползается на километры поперёк города. */
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((usable[0].points[0][0] * Math.PI) / 180);

  /* Клетки, по которым прошёл каждый путь. */
  const cells = new Map<string, Set<string>>();
  for (const { id, points } of usable) {
    const cum = measure(points, mPerDegLon);
    const total = cum[cum.length - 1];
    const steps = Math.max(1, Math.ceil(total / STEP));
    const own = new Set<string>();
    for (let k = 0; k < steps; k += 1) {
      const [lat, lon] = at(points, cum, k * STEP);
      own.add(
        `${Math.round((lon * mPerDegLon) / CELL)}:${Math.round((lat * M_PER_DEG_LAT) / CELL)}`
      );
    }
    cells.set(id, own);
  }

  /* С кем каждый делит дорогу. Соседство считается общей длиной, а не фактом
     пересечения: на перекрёстке пути пересекаются все со всеми, и без порога
     толщин понадобилось бы столько, сколько маршрутов. */
  const minCells = Math.max(2, Math.round(MIN_RUN / CELL));
  const rivals = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    const set = rivals.get(a) ?? new Set<string>();
    set.add(b);
    rivals.set(a, set);
  };

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = cells.get(usable[i].id)!;
      const b = cells.get(usable[j].id)!;
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      let common = 0;
      for (const cell of small) {
        if (!big.has(cell)) continue;
        common += 1;
        if (common >= minCells) break;
      }
      if (common >= minCells) {
        link(usable[i].id, usable[j].id);
        link(usable[j].id, usable[i].id);
      }
    }
  }

  /* Раскраска по старшинству: каждому достаётся самая тонкая толщина из тех,
     что не заняты его соседями по дороге. Свободной не нашлось — берём ту,
     которую соседи заняли реже всего: совпадение неизбежно, но пусть оно
     придётся на одну пару, а не на половину карты. */
  for (const { id, points } of usable) {
    const neighbours = rivals.get(id) ?? new Set<string>();
    const taken = new Map<number, number>();
    for (const other of neighbours) {
      const lane = lanes.get(other);
      if (lane) taken.set(lane.rank, (taken.get(lane.rank) ?? 0) + 1);
    }

    let rank = 0;
    while (rank < levels && taken.has(rank)) rank += 1;
    if (rank === levels) {
      rank = 0;
      for (let one = 1; one < levels; one += 1) {
        if ((taken.get(one) ?? 0) < (taken.get(rank) ?? 0)) rank = one;
      }
    }

    lanes.set(id, { points, rank, shared: neighbours.size > 0 });
  }

  return lanes;
}
