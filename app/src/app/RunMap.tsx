import type { Bounds, RunSketch } from '../data/registry.ts';
import { routeColor } from './MapBoard.tsx';

interface Props {
  sketch: RunSketch;
  /** Общая рамка всех расчётов: город стоит в карточках на одном месте. */
  bounds: Bounds;
  /** Что откроется по щелчку — попадает в подпись для чтения с экрана. */
  label: string;
  onOpen: () => void;
}

/* Итог расчёта картой: тёмная монохромная подложка, поверх — маршруты по
   порядку объезда и точки заявок, которые никто не взял.

   Настоящей карты здесь нет и быть не должно: два десятка Leaflet'ов на одном
   экране, каждый со своими жестами и обработчиками, — это не карточки, а два
   десятка чужих приложений. Тайлы вставлены картинками, поверх лежит один
   `<svg>`, и вся плитка целиком — кнопка: щёлкнул, и открылась настоящая
   карта диспетчерской.

   Подложка монохромная и тёмная — та же, что на большой карте. Цвет на ней
   принадлежит маршрутам: на пёстрой светлой карте двенадцать цветных линий
   в плитке размером с ладонь не читаются вовсе. */

const TILE = 256;

const lonToX = (lon: number, zoom: number) => ((lon + 180) / 360) * TILE * 2 ** zoom;

const latToY = (lat: number, zoom: number) => {
  const sin = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * TILE * 2 ** zoom;
};

/* Плитка широкая и невысокая, а город почти квадратный: рамку расчётов
   расширяем до пропорций плитки, чтобы подложка легла без полей. */
const RATIO = 16 / 9;

/* Ступень масштаба под размер плитки: берём самую подробную, при которой
   город ещё помещается в такой ширине. Запас над шириной самой плитки нужен:
   в карточке она пикселей триста, и подложка, снятая ровно по размеру, на
   плотном экране размывается. */
const TARGET = 900;

function zoomFor(bounds: Bounds) {
  for (let zoom = 13; zoom > 8; zoom -= 1) {
    const width = lonToX(bounds.maxLon, zoom) - lonToX(bounds.minLon, zoom);
    const height = latToY(bounds.minLat, zoom) - latToY(bounds.maxLat, zoom);
    if (Math.max(width, height * RATIO) <= TARGET) return zoom;
  }
  return 9;
}

/* Путь маршрута в координатах плитки. Маршрут приходит ломаной по улицам —
   сотня точек на перегонах через весь город; в плитке шириной с ладонь
   соседние из них ложатся в один и тот же пиксель. Повторы выбрасываем: сама
   линия от этого не меняется, а строка пути становится короче в разы — и это
   заметно, потому что таких плиток на экране два десятка. */
function trace(
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

export function RunMap({ sketch, bounds, label, onOpen }: Props) {
  const zoom = zoomFor(bounds);
  const at = (lat: number, lon: number) => [lonToX(lon, zoom), latToY(lat, zoom)] as const;

  const [left, top] = at(bounds.maxLat, bounds.minLon);
  const [right, bottom] = at(bounds.minLat, bounds.maxLon);
  /* Поля вокруг рамки: точки на самом краю иначе упираются в срез плитки. */
  const pad = 0.06;
  let width = (right - left) * (1 + pad * 2);
  let height = (bottom - top) * (1 + pad * 2);
  if (width / height < RATIO) width = height * RATIO;
  else height = width / RATIO;
  const originX = (left + right) / 2 - width / 2;
  const originY = (top + bottom) / 2 - height / 2;

  /* Какие тайлы попадают в окно. Рамка у всех расчётов одна, поэтому и тайлы
     во всех карточках одни и те же — браузер тянет их один раз на всех. */
  const span = 2 ** zoom;
  const tiles: { key: string; url: string; left: number; top: number }[] = [];
  for (let x = Math.floor(originX / TILE); x <= Math.floor((originX + width) / TILE); x += 1) {
    for (let y = Math.floor(originY / TILE); y <= Math.floor((originY + height) / TILE); y += 1) {
      if (y < 0 || y >= span) continue;
      const wrapped = ((x % span) + span) % span;
      tiles.push({
        key: `${x}:${y}`,
        /* Та же тёмная монохромная подложка, что на большой карте. Держать
           здесь светлую цветную было бы разнобоем: карточка обещает тот же
           расчёт, что открывается по щелчку, и выглядеть должна так же.
           Порядок частей пути у этого источника — z/y/x, не z/x/y. */
        url:
          'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/' +
          `World_Dark_Gray_Base/MapServer/tile/${zoom}/${y}/${wrapped}`,
        left: ((x * TILE - originX) / width) * 100,
        top: ((y * TILE - originY) / height) * 100
      });
    }
  }
  const tileWidth = (TILE / width) * 100;
  const tileHeight = (TILE / height) * 100;

  return (
    <button type="button" className="rmap" onClick={onOpen} title={label} aria-label={label}>
      <span className="rmap__tiles" aria-hidden="true">
        {tiles.map((tile) => (
          <img
            key={tile.key}
            className="rmap__tile"
            src={tile.url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            style={{
              left: `${tile.left}%`,
              top: `${tile.top}%`,
              width: `${tileWidth}%`,
              height: `${tileHeight}%`
            }}
          />
        ))}
      </span>

      <svg
        className="rmap__lines"
        viewBox={`${originX} ${originY} ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {sketch.routes.map((points, index) => (
          <path
            key={index}
            d={trace(points, at)}
            fill="none"
            stroke={routeColor(index)}
            strokeWidth={width / 220}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {sketch.loose.map(([lat, lon], index) => {
          const [x, y] = at(lat, lon);
          return (
            <circle
              key={index}
              className="rmap__loose"
              cx={x}
              cy={y}
              r={width / 190}
              strokeWidth={width / 700}
            />
          );
        })}
      </svg>

      {/* Подписи подложки на миниатюре нет: карточка размером в ладонь, и
          восемь пикселей серым в её углу — шум, а не сведения. Полная
          подпись стоит там, где карту действительно смотрят, — на большой
          карте расчёта. */}
      <span className="rmap__hint">Открыть на карте</span>
    </button>
  );
}
