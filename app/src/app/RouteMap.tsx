import { routeColor } from './MapBoard.tsx';
import { frameOf, miniMap, trace } from './minimap.ts';

interface Props {
  /** Ломаная этого маршрута по улицам. */
  path: [number, number][];
  /** Точки визитов по порядку объезда. */
  stops: [number, number][];
  /** Остальные маршруты того же расчёта — тихой подложкой под этим. */
  others?: [number, number][][];
  /** Место маршрута в ряду линий расчёта: им он и красится. Пусто у
      маршрута, которого в наброске расчёта нет, — тогда линия рисуется
      нейтральным тоном, а не занимает чужой цвет. */
  lane: number | null;
  label: string;
  onOpen: () => void;
}

/* Маршрут картой — один, свой.

   В карточке расчёта на этом месте стоит день целиком: десяток разноцветных
   линий по всему городу, и это правильно — расчёт и есть весь день. Маршруту
   такая карта не годится. Она отвечает на вопрос соседней базы: рамка взята
   по всему расчёту, своя линия в ней — одна из двенадцати, и чем этот
   маршрут отличается от маршрута в строке ниже, по ней не видно вовсе.
   Записи в базе маршрутов различаются как раз тем, где человек ездил, а
   двадцать одинаковых картинок подряд об этом молчали.

   Поэтому рамка здесь по самой линии: маршрут занимает плитку целиком, и
   видно, как он лёг — петля по одному кварталу, гребёнка вдоль магистрали,
   вылет в один дальний адрес и обратно.

   Чего плитка при такой рамке не говорит, так это масштаба: и петля по
   двору, и объезд половины области растянуты до одной ширины. Масштаб
   говорят числа рядом — «в дороге» и районы внизу карточки, — и это
   правильное разделение труда: картинка отвечает на «как», числа на
   «сколько».

   Остальные маршруты расчёта остаются под ним тихой серой подложкой. Без них
   линия висела бы в пустоте: «выделенный» имеет смысл только там, где есть,
   из чего выделять, — и заодно видно, много ли рядом ездили соседи. Рамку
   они не расширяют и в глаза не лезут: обрезаются краем плитки как есть. */

export function RouteMap({ path, stops, others = [], lane, label, onOpen }: Props) {
  /* Маршрута без линии в выгрузке не бывает, но план приходит не только от
     нашего планировщика: в архиве движка лежат прогоны, посчитанные чем
     угодно, и маршрут без геометрии — обычное дело. Тёмная плитка с
     подложкой обещала бы карту и не показывала ничего, поэтому на её месте
     стоит пустое поле с объяснением — но кнопкой: карточка без карты иначе
     осталась бы и без дороги с клавиатуры, а на большой карте расчёта этот
     маршрут всё равно опознается инженером и списком визитов. */
  if (path.length < 2) {
    return (
      <button
        type="button"
        className="rmap rmap--blank"
        onClick={onOpen}
        title={label}
        aria-label={label}
      >
        <span className="rmap__blank">Линии маршрута нет</span>
      </button>
    );
  }

  const map = miniMap(frameOf(path));
  /* Маршрута нет в наброске — красить его номером полосы нечем, и брать
     первый цвет ряда нельзя: он уже занят чужим маршрутом, и два разных
     пути на соседних карточках оказались бы одного цвета. */
  const color = lane === null ? 'var(--ink-500)' : routeColor(lane);
  /* Своя линия рисуется дважды — подбоем и цветом, — но считается один раз:
     в ломаной сотни точек, а таких плиток на экране шесть десятков. */
  const line = trace(path, map.at);

  return (
    <button
      type="button"
      className="rmap"
      onClick={onOpen}
      title={label}
      aria-label={label}
    >
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
        {/* Соседи по расчёту — серым и тоньше. Рисуются первыми, чтобы своя
            линия шла поверх, а не ныряла под чужую. */}
        {others.map((one, index) => (
          <path
            key={index}
            className="rmap__rest"
            d={trace(one, map.at)}
            fill="none"
            strokeWidth={map.width / 320}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Своя линия в две краски: тёмный подбой под цветом. На светлом
            участке подложки цветная линия сама по себе теряется, а обводка
            держит её читаемой на любом куске карты. */}
        <path
          d={line}
          className="rmap__under"
          fill="none"
          strokeWidth={map.width / 120}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth={map.width / 180}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Визиты точками: линия говорит, куда ездили, точки — где
            останавливались. Кучка точек в одном месте и цепочка вдоль всей
            линии — это разные смены, а в числе «12 визитов» они одинаковы. */}
        {stops.map(([lat, lon], index) => {
          const [x, y] = map.at(lat, lon);
          return (
            <circle
              key={index}
              className="rmap__stop"
              cx={x}
              cy={y}
              r={map.width / 200}
              style={{ fill: color }}
              strokeWidth={map.width / 700}
            />
          );
        })}

        {/* Откуда выехал: место выезда инженера — не визит, и помечено
            иначе, кольцом. Без него непонятно, с какого конца линию
            читать. */}
        <circle
          className="rmap__home"
          cx={map.at(path[0][0], path[0][1])[0]}
          cy={map.at(path[0][0], path[0][1])[1]}
          r={map.width / 130}
          style={{ stroke: color }}
          strokeWidth={map.width / 420}
        />
      </svg>

      <span className="rmap__hint">Открыть на карте</span>
    </button>
  );
}
