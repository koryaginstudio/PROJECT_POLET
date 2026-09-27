import type { Bounds, RunSketch } from '../data/registry.ts';
import { frameOf, miniMap } from './minimap.ts';

interface Props {
  /** Набросок плана района: по его точкам и обводится земля участка. */
  sketch: RunSketch;
  /** Рамка всех расчётов сразу: город в трёх карточках стоит на одном и том
      же месте, и районы на них сравнивают глазами, как на большой карте. */
  bounds: Bounds;
  /** Цвет участка — тот же, каким он покрашен на карте мониторинга: цвет
      берётся от названия района, а не от места в списке. */
  tint: string;
  label: string;
  onOpen: () => void;
}

/* Плитка района: город подложкой, поверх — одно пятно с кантом по краю
   участка.

   Маршрутов здесь нет нарочно. Вопрос карточки — «где этот район», а не
   «как в нём разложен день»: дюжина цветных ниток в плитке с ладонь на этот
   вопрос не отвечает, она отвечает на другой и занимает собой всё место.
   Разбирать маршруты есть где — в живом виде и в базе расчётов.

   Граница считается по точкам плана — выездам и заявкам, — как и подложка
   участков на большой карте: границ районов в выгрузке нет, а точки и есть
   то, где район работает. Здесь она грубее: выпуклая оболочка вокруг точек,
   без межей с соседями и без посадки на дороги. Для плитки этого довольно —
   она показывает, где земля участка, а не где проходит межа. */
export function ZoneMap({ sketch, bounds, tint, label, onOpen }: Props) {
  const spots: [number, number][] = [];
  for (const route of sketch.routes) for (const point of route) spots.push(point);
  for (const point of sketch.loose) spots.push(point);

  /* Рамка — по земле самого района, с запасом рамки всех расчётов на
     случай пустого плана.

     Общая рамка на три карточки была бы честнее по географии, но нечитаема
     по делу: участки города вытянуты с севера на юг, плитка — широкая, и
     все три района сжимались в ленточки шириной в палец с пустыми полями по
     бокам. Здесь важнее, какой формы участок и что в нём, а где он в городе,
     говорят имя и цвет — тот же, что на большой карте. */
  const map = miniMap(frameOf(spots, bounds));

  const ring = hull(spots.map(([lat, lon]) => map.at(lat, lon) as readonly [number, number]));
  const path =
    ring.length >= 3
      ? ring.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + ' Z'
      : '';

  return (
    <button type="button" className="rmap zmap" onClick={onOpen} title={label} aria-label={label}>
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

      {path && (
        <svg
          className="rmap__lines"
          viewBox={`${map.originX} ${map.originY} ${map.width} ${map.height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <path
            d={path}
            fill={tint}
            fillOpacity={0.22}
            stroke={tint}
            strokeWidth={map.width / 190}
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

/* Выпуклая оболочка набора точек — обход Эндрю. Точки приходят уже в
   координатах плитки, поэтому считать её можно на плоскости: искажение
   проекции внутри одного города меньше толщины канта. */
function hull(points: readonly (readonly [number, number])[]): [number, number][] {
  if (points.length < 3) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const turn = (
    o: readonly [number, number],
    a: readonly [number, number],
    b: readonly [number, number]
  ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const half = (list: readonly (readonly [number, number])[]): [number, number][] => {
    const out: [number, number][] = [];
    for (const point of list) {
      while (out.length >= 2 && turn(out[out.length - 2], out[out.length - 1], point) <= 0) {
        out.pop();
      }
      out.push([point[0], point[1]]);
    }
    out.pop();
    return out;
  };

  return [...half(sorted), ...half([...sorted].reverse())];
}
