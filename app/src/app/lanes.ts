import L from 'leaflet';

/* Полосы маршрутов на общей дороге.

   Два инженера, едущие по одной улице, — это две линии в одних и тех же
   пикселях: видно только ту, что нарисована последней. Читается это не как
   «они едут вместе», а как «второго маршрута здесь нет»; на карте дня, где
   путей дюжина, пропадали целые перегоны.

   Поэтому маршруты раскладываются по полосам, как линии на схеме метро: тот,
   кто пришёл на дорогу первым, идёт по её оси, следующий — чуть правее по
   ходу своего движения, третий — ещё правее. Сдвинуть оба от оси нельзя:
   тогда ни один не лежит на своей дороге, и карта врёт уже про обоих.

   Сдвиг считается в пикселях экрана, а не в метрах. В метрах он либо
   схлопывается в ноль на обзоре города, либо разносит линии на полквартала
   во дворе: одно и то же расстояние на разных масштабах значит разное.
   Расплата за это — пересчёт линий при смене масштаба, и его делает карта.

   Совпадение ищем по клеткам, а не по вершинам. Маршрутизатор отдаёт ломаную
   упрощённой с допуском в два десятка метров, и одна и та же улица у двух
   маршрутов описана разными точками — точного совпадения ждать нельзя. Путь
   разбивается шагом мельче клетки, каждый шаг метит клетку сетки, и клетка,
   помеченная дважды, говорит, что здесь двое едут рядом.

   Короткие совпадения отбрасываем: на перекрёстке общая клетка есть всегда,
   и без этого полоса дёргалась бы на каждом пересечении. */

/** Шаг разбивки пути, метры. Мельче клетки — иначе путь перешагивает клетки
    по диагонали и часть общей дороги остаётся неразмеченной. */
const STEP = 20;

/** Сторона клетки, метры. Примерно ширина перекрёстка: соседние полосы одной
    магистрали попадают в одну клетку, соседние улицы — уже в разные. */
const CELL = 40;

/** Короче этого совпадение считаем случайным пересечением, метры. */
const MIN_RUN = 200;

/** Сдвиг одной полосы, пиксели экрана. Линия рисуется в 3,5 пикселя, так что
    пяти хватает на просвет между путями и мало, чтобы увести их с дороги. */
const LANE = 5;

const M_PER_DEG_LAT = 111320;

export interface Lane {
  /** Ломаная маршрута: исходные вершины плюс точки на границах полос. */
  points: [number, number][];
  /** Полоса в каждой точке: 0 — по оси дороги, 1 — на шаг правее, и так далее. */
  ranks: number[];
  /** Есть ли сдвиг вообще: маршрут, который нигде ни с кем не пересёкся,
      при смене масштаба пересчитывать незачем. */
  shifted: boolean;
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

/* Короткие куски полосы затирает соседний: пересечение двух маршрутов даёт
   одну-две общие клетки, и без этого линия отскакивала бы вбок на каждом
   перекрёстке — рябь вместо пути. */
function settle(ranks: number[], minRun: number): void {
  let i = 0;
  while (i < ranks.length) {
    let j = i;
    while (j < ranks.length && ranks[j] === ranks[i]) j += 1;
    if (j - i < minRun) {
      const fill = i > 0 ? ranks[i - 1] : j < ranks.length ? ranks[j] : ranks[i];
      for (let k = i; k < j; k += 1) ranks[k] = fill;
    }
    i = j;
  }
}

/** Раскладывает маршруты по полосам. Порядок путей в списке задаёт старшинство:
    кто выше, тот и держит ось дороги. */
export function laneLayout(paths: RoutePath[]): Map<string, Lane> {
  const lanes = new Map<string, Lane>();
  const usable = paths.filter((path) => path.points.length >= 2);
  if (usable.length === 0) return lanes;

  /* Широта для перевода градусов в метры берётся одна на всю карту. Считать
     её в каждой точке нельзя: множитель для долготы тогда плывёт вместе с
     широтой, и сетка расползается на километры поперёк города. */
  const mPerDegLon =
    M_PER_DEG_LAT * Math.cos((usable[0].points[0][0] * Math.PI) / 180);

  /* Кто застолбил клетку. Порядок в списке — это и есть номер полосы. */
  const claims = new Map<string, string[]>();

  const walks = usable.map(({ id, points }) => {
    const cum = measure(points, mPerDegLon);
    const total = cum[cum.length - 1];
    const steps = Math.max(1, Math.ceil(total / STEP));
    const cells: string[] = [];
    const own = new Set<string>();

    for (let k = 0; k < steps; k += 1) {
      const [lat, lon] = at(points, cum, k * STEP);
      const key = `${Math.round((lon * mPerDegLon) / CELL)}:${Math.round(
        (lat * M_PER_DEG_LAT) / CELL
      )}`;
      cells.push(key);
      /* Клетку маршрут занимает один раз: путь, дважды прошедший по своей же
         улице, не должен уступать полосу самому себе. */
      if (own.has(key)) continue;
      own.add(key);
      const owners = claims.get(key);
      if (owners) owners.push(id);
      else claims.set(key, [id]);
    }

    return { id, points, cum, total, cells };
  });

  const minRun = Math.max(2, Math.round(MIN_RUN / STEP));

  for (const walk of walks) {
    const ranks = walk.cells.map((key) => {
      const owners = claims.get(key);
      const place = owners ? owners.indexOf(walk.id) : 0;
      return place < 0 ? 0 : place;
    });
    settle(ranks, minRun);

    const rankAt = (d: number) =>
      ranks[Math.min(ranks.length - 1, Math.max(0, Math.floor(d / STEP)))];

    /* Точки будущей линии: все исходные вершины плюс по паре на каждой
       границе полос. Пара нужна, чтобы переход был коротким: без неё линия
       сползала бы вбок через весь перегон, а это читается как крюк. */
    const marks: { d: number; rank: number }[] = walk.cum.map((d) => ({ d, rank: rankAt(d) }));
    for (let k = 1; k < ranks.length; k += 1) {
      if (ranks[k] === ranks[k - 1]) continue;
      marks.push({ d: Math.max(0, k * STEP - STEP / 2), rank: ranks[k - 1] });
      marks.push({ d: Math.min(walk.total, k * STEP), rank: ranks[k] });
    }
    marks.sort((a, b) => a.d - b.d);

    lanes.set(walk.id, {
      points: marks.map((mark) => at(walk.points, walk.cum, mark.d)),
      ranks: marks.map((mark) => mark.rank),
      shifted: ranks.some((rank) => rank > 0)
    });
  }

  return lanes;
}

/** Линия маршрута со сдвигом полос для текущего масштаба. */
export function laneShift(map: L.Map, lane: Lane, zoom: number): L.LatLngExpression[] {
  if (!lane.shifted) return lane.points;

  const flat = lane.points.map(([lat, lon]) => map.project(L.latLng(lat, lon), zoom));

  return lane.points.map(([lat, lon], i) => {
    const rank = lane.ranks[i];
    if (rank === 0) return L.latLng(lat, lon);

    /* Направление берём по соседям, а не по одному перегону: на изломе пути
       так обе половины сдвигаются согласованно и угол не расходится. */
    const prev = flat[i - 1] ?? flat[i];
    const next = flat[i + 1] ?? flat[i];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return L.latLng(lat, lon);

    /* Правый борт по ходу движения. У экрана ось Y смотрит вниз, поэтому
       поворот направо — это (x, y) → (−y, x). */
    const shift = rank * LANE;
    return map.unproject(
      L.point(flat[i].x + (-dy / len) * shift, flat[i].y + (dx / len) * shift),
      zoom
    );
  });
}
