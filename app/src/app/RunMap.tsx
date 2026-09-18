import type { Bounds, RunSketch } from '../data/registry.ts';
import { routeColor } from './MapBoard.tsx';
import { frameOf, miniMap, trace } from './minimap.ts';

interface Props {
  sketch: RunSketch;
  /** Рамка на случай пустого расчёта: показывать в карточке нечего, но и
      подложке надо где-то встать. Обычная рамка считается по самому
      расчёту — см. `frameOf`. */
  bounds: Bounds;
  /** Что откроется по щелчку — попадает в подпись для чтения с экрана. */
  label: string;
  onOpen: () => void;
}

/* Итог расчёта картой: тёмная монохромная подложка, поверх — маршруты по
   порядку объезда и точки заявок, которые никто не взял.

   Проекцию, рамку и подложку считает `minimap`: та же плитка, что и у
   карточки маршрута, и разного в них ровно то, что рисуют поверх. */

export function RunMap({ sketch, bounds, label, onOpen }: Props) {
  const points = function* (): Generator<[number, number]> {
    for (const route of sketch.routes) yield* route;
    yield* sketch.loose;
  };
  const map = miniMap(frameOf(points(), bounds));

  return (
    <button type="button" className="rmap" onClick={onOpen} title={label} aria-label={label}>
      <span className="rmap__tiles" aria-hidden="true">
        {map.tiles.map((tile) => (
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
              width: `${map.tileWidth}%`,
              height: `${map.tileHeight}%`
            }}
          />
        ))}
      </span>

      <svg
        className="rmap__lines"
        viewBox={`${map.originX} ${map.originY} ${map.width} ${map.height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {sketch.routes.map((route, index) => (
          <path
            key={index}
            d={trace(route, map.at)}
            fill="none"
            stroke={routeColor(index)}
            strokeWidth={map.width / 220}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {sketch.loose.map(([lat, lon], index) => {
          const [x, y] = map.at(lat, lon);
          return (
            <circle
              key={index}
              className="rmap__loose"
              cx={x}
              cy={y}
              r={map.width / 190}
              strokeWidth={map.width / 700}
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
