/* Дорожная сеть города — для границ участков.

   Границу между районами люди читают не как линию наименьших расстояний, а
   как улицу: «до Каширского шоссе — наш, дальше — соседний». Поэтому межа,
   посчитанная по заявкам, притягивается к настоящим дорогам: сеть лежит
   рядом с данными расчёта и приходит из OpenStreetMap — крупные дороги
   области, от автомагистралей до второстепенных.

   Файл собран один раз и лежит в выгрузке: стенд офлайновый, и ходить за
   дорогами на чужой сервер во время работы он не должен. Пересобрать —
   `dataset/roadnet.py`.

   Сеть нужна только рисованию границ. Маршруты по-прежнему идут по своим
   геометриям от маршрутизатора: тут дороги грубее и годятся, чтобы
   провести межу, но не чтобы проложить путь. */

/** Ломаная дороги: пары «широта, долгота». */
export type RoadLine = [number, number][];

let cache: Promise<RoadLine[]> | null = null;

/** Участки выгрузки: у каждого свой файл дорог. Список короткий и
    постоянный — это три зоны, на которые посчитан день. */
const ZONES = ['east', 'southeast', 'center'];

/** Дороги перегонов: `roads.json` хранит их словарём «откуда-куда», и у
    каждой записи лежит ломаная по улицам. */
interface RoadsFile {
  legs?: Record<string, { line?: [number, number][] }>;
}

/** Прореживание: в ломаной от маршрутизатора точки стоят через десятки
    метров. Границе такая частота не нужна — она чертится на километрах, —
    а каждая точка стоит памяти и времени поиска. Берём каждую третью,
    концы оставляем всегда. */
const thin = (line: [number, number][]): RoadLine => {
  if (line.length < 4) return line;
  const out = line.filter((_one, i) => i % 3 === 0);
  const last = line[line.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
};

/** Сеть дорог для границ участков.

    Сперва смотрим отдельный файл сети — его собирает `dataset/roadnet.py`
    из OpenStreetMap, и он покрывает всю область, включая поля между
    городами. Нет его — берём дороги, по которым ездят сами маршруты: они
    приходят с выгрузкой, лежат в `roads.json` каждой зоны и покрывают как
    раз те улицы, по которым работают участки. Это и есть те улицы, на
    которых один район сменяется другим.

    Читается один раз на запуск: тысячи ломаных, и перечитывать их на
    каждый пересчёт границ незачем. */
export function loadRoadNet(): Promise<RoadLine[]> {
  if (!cache) {
    cache = fetch('data/roads-net.json')
      .then((resp) => (resp.ok ? resp.json() : null))
      .then((rows: unknown) => (Array.isArray(rows) && rows.length > 0 ? (rows as RoadLine[]) : null))
      .catch(() => null)
      .then((ready) => (ready ? ready : fromPlans()))
      .catch(() => []);
  }
  return cache;
}

/** Дороги из выгрузки: перегоны всех трёх участков одной кучей. */
async function fromPlans(): Promise<RoadLine[]> {
  const parts = await Promise.all(
    ZONES.map((zone) =>
      fetch(`data/${zone}/roads.json`)
        .then((resp) => (resp.ok ? (resp.json() as Promise<RoadsFile>) : null))
        .catch(() => null)
    )
  );
  const lines: RoadLine[] = [];
  /* Одни и те же улицы приходят в десятке перегонов: маршруты ездят по
     общим дорогам. Повторы выбрасываем по концам ломаной — искать
     ближайшую дорогу среди пяти копий одной и той же незачем. */
  const seen = new Set<string>();
  for (const part of parts) {
    for (const leg of Object.values(part?.legs ?? {})) {
      const line = leg?.line;
      if (!Array.isArray(line) || line.length < 2) continue;
      const first = line[0];
      const last = line[line.length - 1];
      const key = `${first[0].toFixed(4)}:${first[1].toFixed(4)}>${last[0].toFixed(4)}:${last[1].toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(thin(line));
    }
  }
  return lines;
}

/** Ближайшая точка сети к заданной: на каком отрезке какой дороги она
    лежит и где именно. Дальше порога — пусто: тянуть межу за три
    километра к единственной трассе значит рисовать границу там, где её
    нет. */
export interface Snap {
  way: number;
  seg: number;
  at: [number, number];
  gap: number;
}

/** Сетка отрезков: искать ближайшую дорогу перебором всех — это сотни
    тысяч отрезков на каждую вершину межи. Раскладываем их по клеткам
    примерно километр на километр и смотрим только соседние. */
export class RoadIndex {
  private cells = new Map<string, { way: number; seg: number }[]>();
  private step = 0.01;
  private kx: number;

  constructor(private lines: RoadLine[], lat: number) {
    this.kx = Math.cos((lat * Math.PI) / 180) || 1;
    lines.forEach((line, way) => {
      for (let seg = 0; seg < line.length - 1; seg += 1) {
        const [ay, ax] = line[seg];
        const [by, bx] = line[seg + 1];
        /* Отрезок кладём во все клетки, которые он пересекает по краям:
           длинные перегоны за городом иначе теряются между клетками. */
        const steps = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(by - ay), Math.abs(bx - ax) * this.kx) / this.step)
        );
        for (let i = 0; i <= steps; i += 1) {
          const lat2 = ay + ((by - ay) * i) / steps;
          const lon2 = ax + ((bx - ax) * i) / steps;
          const key = this.key(lat2, lon2);
          const list = this.cells.get(key);
          if (list) list.push({ way, seg });
          else this.cells.set(key, [{ way, seg }]);
        }
      }
    });
  }

  private key(lat: number, lon: number) {
    return `${Math.floor(lat / this.step)}:${Math.floor((lon * this.kx) / this.step)}`;
  }

  /** Ближайшая точка сети к заданной, не дальше `reach` градусов широты. */
  nearest(lat: number, lon: number, reach: number): Snap | null {
    const span = Math.max(1, Math.ceil(reach / this.step));
    let best: Snap | null = null;
    const row = Math.floor(lat / this.step);
    const col = Math.floor((lon * this.kx) / this.step);
    const seen = new Set<string>();
    for (let dr = -span; dr <= span; dr += 1) {
      for (let dc = -span; dc <= span; dc += 1) {
        const list = this.cells.get(`${row + dr}:${col + dc}`);
        if (!list) continue;
        for (const { way, seg } of list) {
          const tag = `${way}:${seg}`;
          if (seen.has(tag)) continue;
          seen.add(tag);
          const line = this.lines[way];
          const [ay, ax] = line[seg];
          const [by, bx] = line[seg + 1];
          const vy = by - ay;
          const vx = (bx - ax) * this.kx;
          const wy = lat - ay;
          const wx = (lon - ax) * this.kx;
          const len = vy * vy + vx * vx;
          const t = len > 0 ? Math.max(0, Math.min(1, (wy * vy + wx * vx) / len)) : 0;
          const py = ay + vy * t;
          const px = ax + (bx - ax) * t;
          const gap = Math.hypot(lat - py, (lon - px) * this.kx);
          if (gap <= reach && (!best || gap < best.gap)) {
            best = { way, seg, at: [py, px], gap };
          }
        }
      }
    }
    return best;
  }

  /** Кусок дороги между двумя её точками — тем же путём, каким идёт сама
      дорога. Точки должны лежать на одной дороге, иначе пусто: соединять
      две разные улицы напрямую здесь нечем. */
  between(from: Snap, to: Snap): [number, number][] | null {
    if (from.way !== to.way) return null;
    const line = this.lines[from.way];
    const forward = from.seg <= to.seg;
    const a = forward ? from : to;
    const b = forward ? to : from;
    const middle = line.slice(a.seg + 1, b.seg + 1);
    const path = [a.at, ...middle, b.at];
    return forward ? path : path.reverse();
  }
}
