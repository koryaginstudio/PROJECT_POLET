import type { Bounds } from '../data/registry.ts';

/* Плитка-карта: проекция, рамка, масштаб и подложка.

   Таких плиток в базах две — набросок расчёта в карточке расчёта и линия
   маршрута в карточке маршрута, — и устроены они одинаково: тёмная
   монохромная подложка картинками, поверх один `<svg>` с линиями. Разное в
   них только то, что рисуют поверх.

   Поэтому счёт здесь один на обе. Дело не в экономии строк: разойдись два
   счёта хоть на ступень масштаба, и один и тот же город в двух соседних
   карточках встанет по-разному — а карточка маршрута и карточка его расчёта
   обещают одно и то же место.

   Настоящей карты здесь нет и быть не должно: два десятка Leaflet'ов на
   одном экране, каждый со своими жестами и обработчиками, — это не карточки,
   а два десятка чужих приложений. */

const TILE = 256;

const lonToX = (lon: number, zoom: number) => ((lon + 180) / 360) * TILE * 2 ** zoom;

const latToY = (lat: number, zoom: number) => {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE * 2 ** zoom;
};

/* Плитка широкая и невысокая, а город почти квадратный: рамку расширяем до
   пропорций плитки, чтобы подложка легла без полей. */
const RATIO = 16 / 9;

/* Ступень масштаба под размер плитки: берём самую подробную, при которой
   показанное ещё помещается в такой ширине. Запас над шириной самой плитки
   нужен: в карточке она пикселей триста, и подложка, снятая ровно по размеру,
   на плотном экране размывается. */
const TARGET = 900;

/* Минимальная сторона рамки, градусы широты — около километра. Маршрут из
   одной точки дал бы рамку нулевого размера, а делить на неё нечем. */
const MIN_SPAN = 0.01;

/* Поля вокруг рамки: точки на самом краю иначе упираются в срез плитки. */
const PAD = 0.06;

/** Рамка по показанным точкам — по ним самим, а не по всей базе.

    Раньше карточки расчётов строились по общей рамке всех расчётов: так город
    стоял в них на одном месте, и два расчёта было видно как два плана одного
    города. С выгрузкой заказчика это перестало работать: зон три, и одна из
    них тянется от Люблина до Ступина. Общая рамка растянулась на полтораста
    километров, и маршруты любого расчёта съёживались в пятнышко величиной с
    ноготь — карточка показывала, что расчёт где-то есть, и больше ничего.

    Теперь каждая плитка показывает своё во всю ширину. Сравнимость при этом
    не теряется: расчёты одной зоны считаются по одним и тем же адресам, и
    рамки у них совпадают до сотых долей градуса.

    Запасная рамка нужна тому, у кого показываемое бывает пустым, — набросок
    пустого расчёта рисовать не из чего, а подложке всё равно надо где-то
    встать. Там, где точка есть всегда, запасную не передают. */
export function frameOf(points: Iterable<[number, number]>, fallback?: Bounds): Bounds {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const [lat, lon] of points) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  if (!Number.isFinite(minLat)) return fallback ?? { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };

  /* Всё в одной точке — не ошибка: так выглядит день, где все заявки в одном
     дворе. Разводим рамку вокруг него. */
  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
  const half = MIN_SPAN / 2;
  /* По долготе тот же километр занимает больше градусов: на широте Москвы
     примерно вдвое. */
  const wide = half / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  return {
    minLat: Math.min(minLat, lat - half),
    maxLat: Math.max(maxLat, lat + half),
    minLon: Math.min(minLon, lon - wide),
    maxLon: Math.max(maxLon, lon + wide)
  };
}

function zoomFor(bounds: Bounds) {
  for (let zoom = 15; zoom > 8; zoom -= 1) {
    const width = lonToX(bounds.maxLon, zoom) - lonToX(bounds.minLon, zoom);
    const height = latToY(bounds.minLat, zoom) - latToY(bounds.maxLat, zoom);
    if (Math.max(width, height * RATIO) <= TARGET) return zoom;
  }
  return 9;
}

export interface MiniTile {
  key: string;
  url: string;
  left: number;
  top: number;
}

export interface MiniMap {
  /** Градусы в координаты плитки. */
  at: (lat: number, lon: number) => readonly [number, number];
  /** Окно `<svg>`: `viewBox` из этих четырёх чисел. */
  originX: number;
  originY: number;
  width: number;
  height: number;
  tiles: MiniTile[];
  /** Размер одного тайла в долях окна, проценты. */
  tileWidth: number;
  tileHeight: number;
}

/** Собирает плитку: считает проекцию по тому, что в неё должно влезть, и
    подбирает тайлы подложки. */
export function miniMap(frame: Bounds): MiniMap {
  const zoom = zoomFor(frame);
  const at = (lat: number, lon: number) => [lonToX(lon, zoom), latToY(lat, zoom)] as const;

  const [left, top] = at(frame.maxLat, frame.minLon);
  const [right, bottom] = at(frame.minLat, frame.maxLon);
  let width = (right - left) * (1 + PAD * 2);
  let height = (bottom - top) * (1 + PAD * 2);
  if (width / height < RATIO) width = height * RATIO;
  else height = width / RATIO;
  const originX = (left + right) / 2 - width / 2;
  const originY = (top + bottom) / 2 - height / 2;

  /* Какие тайлы попадают в окно. У расчётов одной зоны рамка совпадает,
     поэтому и тайлы у них одни и те же — браузер тянет их один раз на всех. */
  const span = 2 ** zoom;
  const tiles: MiniTile[] = [];
  for (let x = Math.floor(originX / TILE); x <= Math.floor((originX + width) / TILE); x += 1) {
    for (let y = Math.floor(originY / TILE); y <= Math.floor((originY + height) / TILE); y += 1) {
      if (y < 0 || y >= span) continue;
      const wrapped = ((x % span) + span) % span;
      tiles.push({
        key: `${x}:${y}`,
        /* Тёмная монохромная подложка — та же, что на большой карте. Цвет на
           ней принадлежит маршрутам: на пёстрой светлой карте двенадцать
           цветных линий в плитке размером с ладонь не читаются вовсе.
           Порядок частей пути у этого источника — z/y/x, не z/x/y. */
        url:
          'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/' +
          `World_Dark_Gray_Base/MapServer/tile/${zoom}/${y}/${wrapped}`,
        left: ((x * TILE - originX) / width) * 100,
        top: ((y * TILE - originY) / height) * 100
      });
    }
  }

  return {
    at,
    originX,
    originY,
    width,
    height,
    tiles,
    tileWidth: (TILE / width) * 100,
    tileHeight: (TILE / height) * 100
  };
}

/** Путь в координатах плитки.

    Маршрут приходит ломаной по улицам — сотня точек на перегонах через весь
    город; в плитке шириной с ладонь соседние из них ложатся в один и тот же
    пиксель. Повторы выбрасываем: сама линия от этого не меняется, а строка
    пути становится короче в разы — и это заметно, потому что таких плиток на
    экране два десятка. */
export function trace(
  points: [number, number][],
  at: (lat: number, lon: number) => readonly [number, number]
): string {
  const parts: string[] = [];
  let prev = '';
  for (const [lat, lon] of points) {
    const [x, y] = at(lat, lon);
    const spot = `${x.toFixed(1)} ${y.toFixed(1)}`;
    if (spot === prev) continue;
    parts.push((parts.length === 0 ? 'M' : 'L') + spot);
    prev = spot;
  }
  return parts.join(' ');
}
