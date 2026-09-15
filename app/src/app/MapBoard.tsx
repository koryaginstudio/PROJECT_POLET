import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Switch } from '../ds/components/forms/Switch.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm, homeOf, placeOf, roadPath, visits } from '../data/derive.ts';
import type { Lane } from './lanes.ts';
import { laneLayout, laneShift } from './lanes.ts';

interface Props {
  view: DayView;
  /** Подсвеченный маршрут: тем же значением его подсвечивает список справа. */
  live: string | null;
  onLive: (engineerId: string | null) => void;
  /** Выбранный маршрут: пока он выбран, остальные на карте не нажимаются. */
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  /** Счётчик «приблизить»: меняется — карта подлетает к живому маршруту. */
  focus: number;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
  /** Выбранная заявка: её выбирают и в списке справа, и щелчком по точке.
      Карта на это отвечает — обводит точку и подъезжает к ней. */
  selectedOrder?: string | null;
}

/* Цвета повторяют токены системы: карта — не отдельный мир, а тот же день
   в другом представлении. Leaflet рисует их через JS, поэтому значения
   продублированы здесь; менять их надо парой с --success-500 и соседями. */
const TONE = {
  done: '#2FD97D',
  risk: '#FF5B52',
  free: '#8A8A8A'
};

/* У каждого маршрута свой цвет: на двенадцати путях через один город серая
   линия отличается от серой линии только тем, что её подсветили. Оттенки
   разведены по кругу.

   Палитра осветлена под тёмную подложку. Прежняя была притемнена — её
   подбирали под пёструю светлую OSM, где бледное не читалось. На тёмно-серой
   карте всё наоборот: тёмное сливается с фоном, и работает только то, что
   светлее подложки. Держим светлоту около 65–72 % и высокую насыщенность —
   тогда линия не спорит с дорогами, а лежит поверх них.

   Цвет заявки (зелёная, красная, белая) от маршрутных отличается формой:
   точка против линии. */
export const ROUTE_COLORS = [
  '#2BD69F',
  '#FF8A3D',
  '#A79CF0',
  '#FF5FA8',
  '#5FB3F5',
  '#E5B44F',
  '#35D6C6',
  '#FF6B64',
  '#C08BF5',
  '#A8DC52',
  '#FF9E5E',
  '#B6C6DC'
];

export const routeColor = (index: number) => ROUTE_COLORS[index % ROUTE_COLORS.length];

/* Подсказка — светлая карточка, а не чёрная плашка: на карте она читается
   как часть интерфейса, а цветная точка сразу говорит, о чём речь. */
const mini = (text: string) => `<span class="gtip gtip--mini">${text}</span>`;

/* Однострочная подпись с цветной точкой: чей это маршрут, читается прямо
   на карте, а цвет точки повторяет цвет линии. */
const tag = (tone: string, text: string) =>
  `<span class="gtip gtip--mini gtip--tag"><i class="gtip__dot" style="background:${tone}"></i>${text}</span>`;

const card = (tone: string, head: string, lines: string[]) =>
  `<span class="gtip"><span class="gtip__head"><i class="gtip__dot" style="background:${tone}"></i>${head}</span>` +
  lines.map((line) => `<span class="gtip__line">${line}</span>`).join('') +
  '</span>';

/** Минуты словами: «3 ч 40 мин». */
const spell = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} ч ${m} мин` : `${m} мин`;
};

/* Дорожная геометрия приходит с планом: в каждой остановке лежит перегон до
   неё ломаной по настоящим улицам, посчитанный маршрутизатором на стороне
   движка. Раньше её тянули из открытого OSRM прямо из браузера — линия
   появлялась через секунду после карты, а без интернета не появлялась вовсе.
   Теперь она часть контракта: рисуется сразу и работает на защите с чужим
   ноутбуком без сети. Сборка линии — `roadPath` в derive. */

export function MapBoard({
  view,
  live,
  onLive,
  pinned,
  onPin,
  focus,
  onSelectOrder,
  onSelectEngineer,
  selectedOrder = null
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  /* Слои разведены по тому, что диспетчер включает и выключает: пути с
     началами маршрутов, точки взятых заявок и точки тех, которые никто не
     взял. Нумерация выбранного маршрута живёт отдельно и не выключается. */
  const routeLayer = useRef<L.LayerGroup | null>(null);
  const pinLayer = useRef<L.LayerGroup | null>(null);
  const freeLayer = useRef<L.LayerGroup | null>(null);
  const seqLayer = useRef<L.LayerGroup | null>(null);
  const lines = useRef<Map<string, L.Polyline>>(new Map());
  /* Раскладка путей по полосам. Считается от данных, а линии из неё —
     от масштаба, поэтому она живёт отдельно от самих линий. */
  const lanes = useRef<Map<string, Lane>>(new Map());
  /* Невидимая широкая копия линии: попасть курсором в трёхпиксельный путь
     невозможно, поэтому события ловит она, а рисует — тонкая. */
  const grips = useRef<Map<string, L.Polyline>>(new Map());
  const pins = useRef<Map<string, L.CircleMarker>>(new Map());
  /* Значки «под угрозой» держим отдельно от точек: они гаснут и прячутся
     вместе со своей точкой, но это не она. */
  const alarms = useRef<Map<string, L.Marker>>(new Map());
  const bases = useRef<Map<string, L.Marker>>(new Map());
  /* Подробная подсказка базы: у выбранного маршрута её место занимает
     постоянная подпись, а при наведении она возвращается. */
  const baseTip = useRef<Map<string, string>>(new Map());
  /* Границы дня и отметка «уже вписали»: карту создают раньше, чем контейнер
     получает высоту, и первый fitBounds по нулевой коробке даёт бессмысленный
     зум. Настоящее вписывание делаем, когда размер появился. */
  const span = useRef<L.LatLngBounds | null>(null);
  const fitted = useRef(false);
  /* Обработчики держим в ссылке: слои пересобираются от данных, а не от
     того, что React заново создал функцию. */
  const pick = useRef({ onSelectOrder, onSelectEngineer, onLive, onPin });
  pick.current = { onSelectOrder, onSelectEngineer, onLive, onPin };

  const colorOf = (engineerId: string) =>
    routeColor(view.loads.findIndex((load) => load.engineer.id === engineerId));

  /* Где карта стоит сейчас. Нужно и кнопкам, и ползунку: оба показывают
     одно и то же значение, и разойтись им нельзя. Дробное — зум у нас
     непрерывный, без привязки к ступеням. */
  const [zoom, setZoom] = useState(10);
  /* Карта на весь экран. Сделана классом на своём же контейнере, а не
     штатным Fullscreen API: тот вырывает элемент из потока документа, и
     подсказки Leaflet с нашими всплывающими карточками начинают жить в
     другом слое — часть просто перестаёт показываться. Класс же оставляет
     всё на месте, только растягивает.

     Выходов два: кнопка и Esc. Один выход из полноэкранного режима — это
     ловушка: если кнопка уехала за край или её закрыло подсказкой, вернуться
     нечем. */
  const [full, setFull] = useState(false);
  const [routesOn, setRoutesOn] = useState(true);
  const [pinsOn, setPinsOn] = useState(true);
  const [freeOn, setFreeOn] = useState(true);
  const pinnedLoad = pinned ? view.loads.find((load) => load.engineer.id === pinned) : undefined;

  useEffect(() => {
    if (map.current || !host.current) return;
    /* Зум дробный: без привязки к целым ступеням жест идёт непрерывно. */
    const instance = L.map(host.current, {
      /* Штатные кнопки масштаба выключены: они приходят со своим шрифтом,
         своими размерами и своей рамкой и на фоне остального интерфейса
         читаются как чужая деталь. Свои — в `geo__zoom` ниже. */
      zoomControl: false,
      /* Атрибуция тоже своя. Leaflet рисует её белой плашкой в нижнем углу
         поверх карты, и карта из-за неё заканчивается не картой. Указание
         источника при этом обязательно, поэтому оно не убрано, а переехало
         в строку над картой — там его видно и оно ничего не перекрывает. */
      attributionControl: false,
      scrollWheelZoom: false,
      zoomSnap: 0,
      zoomDelta: 1,
      /* Плитки появляются сразу, без проявления: на дробном зуме половина
         кадров уходила на проявление, и карта казалась мутной. */
      fadeAnimation: false
    });
    /* Тайлы перерисовываются, когда жест кончился, а не на каждое движение:
       иначе при непрерывном зуме слой сносит и грузит плитки по десятку раз
       в секунду — картинка мигает и остаётся серой. Пока жест идёт, старые
       плитки просто масштабируются, поэтому запас вокруг экрана побольше. */
    /* Подложка чёрно-белая и тёмная.

       На цветной OSM двенадцать маршрутов спорили с картой: зелёные парки
       и жёлтые магистрали лезли в тот же диапазон, что и линии, и путь
       терялся среди дорог, по которым он идёт. Вопрос не в насыщенности
       линий, а в том, что цвет на карте должен принадлежать данным, а не
       подложке.

       Обесцветить саму OSM фильтром не выходит: у неё дороги светлее фона,
       и инверсия кладёт их в один тон с ним — дорожная сеть исчезает.
       Поэтому подложка взята уже монохромной и уже тёмной: фон тёмно-серый,
       дороги светлее его, всё остальное убрано. Поверх такой карты цветная
       линия читается с первого взгляда.

       Подписи идут вторым слоем, иначе на тёмном фоне город безымянный. */
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 16,
        minZoom: 9,
        /* Плитки этой подложки — JPEG 256 точек, и на плотном экране они
           мылятся: браузер растягивает их вдвое. С detectRetina Leaflet
           берёт плитки на ступень глубже и кладёт их в тот же квадрат —
           разрешение удваивается, картинка становится резкой. */
        detectRetina: true,
        maxNativeZoom: 16,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 4
      }
    ).addTo(instance);

    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 16,
        minZoom: 9,
        detectRetina: true,
        maxNativeZoom: 16,
        updateWhenIdle: true,
        updateWhenZooming: false,
        keepBuffer: 4,
        pane: 'tilePane'
      }
    ).addTo(instance);
    /* Точки живут в своём слое поверх линий.

       Leaflet кладёт всё нарисованное в один слой в порядке добавления, и
       подсветка маршрута вызывает bringToFront — линия всплывала над
       точками, которые к ней же и относятся. Читалось это как ошибка
       отрисовки: навёл на маршрут, и его же заявки скрылись под ним.

       Отдельная панель с большим z-index решает это раз и навсегда: линия
       может всплывать сколько угодно внутри своей панели, выше точек она
       не окажется. 450 — между обычными фигурами (400) и маркерами (600). */
    instance.createPane('points').style.zIndex = '450';
    routeLayer.current = L.layerGroup().addTo(instance);
    pinLayer.current = L.layerGroup().addTo(instance);
    freeLayer.current = L.layerGroup().addTo(instance);
    seqLayer.current = L.layerGroup().addTo(instance);
    map.current = instance;

    /* Карта считает свой размер один раз при создании: если контейнер потом
       вырос — а он вырастает, пока грузятся данные, — тайлы остаются от
       старого размера. Пересчитываем на каждое изменение. */
    /* Своё колесо вместо штатного. Родное копит прокрутку за окно времени и
       потом проигрывает анимированный прыжок — на тачпаде, где события идут
       непрерывным потоком, это и читается как рывки. Здесь каждое событие
       сразу двигает зум на свою долю ступени, без анимации и накопления:
       картинка едет ровно за пальцами. Точка под курсором остаётся на месте. */
    /* Зум колесом и тачпадом делаем в два такта. Пока жест идёт, карта просто
       масштабируется трансформом — плитки не перестраиваются, поэтому нет ни
       мерцания, ни серых провалов; когда жест кончился, один раз применяем
       настоящий зум и подгружаем плитки. Так же устроен зум в больших картах. */
    const pane = instance.getPane('mapPane') as HTMLElement;
    let target = instance.getZoom();
    let anchor: L.Point | null = null;
    let baseTransform = '';
    let gesture = false;
    let settle: ReturnType<typeof setTimeout> | null = null;

    const commit = () => {
      settle = null;
      if (!gesture) return;
      gesture = false;
      pane.style.transform = baseTransform;
      pane.style.transformOrigin = '';
      if (anchor && Math.abs(target - instance.getZoom()) > 0.001) {
        instance.setZoomAround(anchor, target, { animate: false });
      }
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? 380 : 1;
      /* Щипок на тачпаде приходит тем же событием с ctrl и мелкой дельтой —
         ему нужен размах побольше, иначе жест почти ничего не меняет. */
      const gain = event.ctrlKey ? 0.028 : 0.0075;

      if (!gesture) {
        gesture = true;
        target = instance.getZoom();
        anchor = instance.mouseEventToContainerPoint(event);
        baseTransform = pane.style.transform;
        const layerPoint = instance.containerPointToLayerPoint(anchor);
        pane.style.transformOrigin = `${layerPoint.x}px ${layerPoint.y}px`;
      }

      target = Math.max(
        instance.getMinZoom(),
        Math.min(instance.getMaxZoom(), target + -event.deltaY * unit * gain)
      );
      pane.style.transform = `${baseTransform} scale(${Math.pow(2, target - instance.getZoom())})`;

      if (settle) clearTimeout(settle);
      settle = setTimeout(commit, 140);
    };

    host.current.addEventListener('wheel', onWheel, { passive: false });

    /* Зум меняют четырьмя способами: кнопками, ползунком, колесом и
       вписыванием в границы. Состояние слушает саму карту, а не каждый из
       них по отдельности, — иначе один из четырёх однажды забудут. */
    const follow = () => setZoom(instance.getZoom());
    instance.on('zoom zoomend', follow);
    follow();

    const watch = new ResizeObserver(() => {
      instance.invalidateSize();
      const box = instance.getSize();
      if (!fitted.current && box.y > 0 && span.current?.isValid()) {
        instance.fitBounds(span.current, { padding: [24, 24] });
        fitted.current = true;
      }
    });
    watch.observe(host.current);

    const node = host.current;
    return () => {
      if (settle) clearTimeout(settle);
      node.removeEventListener('wheel', onWheel);
      instance.off('zoom zoomend', follow);
      watch.disconnect();
      instance.remove();
      map.current = null;
    };
  }, []);

  /* Слои дня: линии маршрутов, точки заявок, квадраты выезда. */
  useEffect(() => {
    const instance = map.current;
    const routes = routeLayer.current;
    const marks = pinLayer.current;
    const orphans = freeLayer.current;
    if (!instance || !routes || !marks || !orphans) return;
    routes.clearLayers();
    marks.clearLayers();
    orphans.clearLayers();
    lines.current.clear();
    grips.current.clear();
    pins.current.clear();
    alarms.current.clear();
    bases.current.clear();

    const problems = new Set(
      [...view.stopByOrder.entries()]
        .filter(([, placement]) => placement.slaBreached || placement.stop.risk !== 'low')
        .map(([id]) => id)
    );

    /* Пути собираем до отрисовки: полоса на общей дороге зависит от соседей,
       и в одиночку, внутри цикла по маршрутам, её не определить. Старшинство
       — порядок `view.loads`: он же задаёт цвета, и две разные очереди на
       одни и те же маршруты только путали бы. */
    lanes.current = laneLayout(
      view.loads
        .filter((load) => load.route && load.route.stops.length > 0)
        .map((load) => ({
          id: load.engineer.id,
          points: roadPath(
            load.route!,
            [load.engineer.home_lat, load.engineer.home_lon],
            (orderId) => {
              const order = view.orderById.get(orderId);
              return order ? [order.lat, order.lon] : undefined;
            }
          )
        }))
    );

    view.loads.forEach((load, index) => {
      const color = routeColor(index);
      const lane = lanes.current.get(load.engineer.id);
      if (lane) {
        const points = laneShift(instance, lane, instance.getZoom());
        const grip = L.polyline(points, { color, weight: 16, opacity: 0 });
        grip.on('mouseover', () => pick.current.onLive(load.engineer.id));
        grip.on('mouseout', () => pick.current.onLive(null));
        grip.on('click', () => pick.current.onPin(load.engineer.id));
        grip.addTo(routes);
        grips.current.set(load.engineer.id, grip);

        const line = L.polyline(points, { color, weight: 3.5, opacity: 0.95, interactive: false });
        line.addTo(routes);
        lines.current.set(load.engineer.id, line);
      }

      const base = L.marker([load.engineer.home_lat, load.engineer.home_lon], {
        icon: L.divIcon({
          className: 'geo__basebox',
          html: `<span class="geo__base" style="background:${color}"></span>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6]
        })
      });
      const baseCard = card(color, load.engineer.name, [
        `Выезжает из: ${homeOf(load.engineer)}`,
        `${visits(load.visits)} · загрузка ${Math.round(load.occupancy * 100)}%`
      ]);
      baseTip.current.set(load.engineer.id, baseCard);
      base.bindTooltip(baseCard, { direction: 'top', className: 'geo__tt' });
      base.on('mouseover', () => pick.current.onLive(load.engineer.id));
      base.on('mouseout', () => pick.current.onLive(null));
      base.on('click', () => pick.current.onPin(load.engineer.id));
      base.addTo(routes);
      bases.current.set(load.engineer.id, base);
    });

    for (const order of view.orderById.values()) {
      const placement = view.stopByOrder.get(order.id);
      const engineer = placement ? view.engineerById.get(placement.engineerId) : undefined;

      /* Цвет точки — цвет её маршрута.

         Раньше было три цвета на все восемьдесят точек: зелёная, красная,
         белая. На общем виде это отвечало на вопрос, который и так виден
         («всё ли в порядке»), и не отвечало на тот, из-за которого на карту
         смотрят: чья это точка. Двенадцать путей шли цветными, а их же
         заявки — одинаково зелёными, и связь между линией и точкой
         приходилось искать глазами по расстоянию.
         
         Теперь точка того же цвета, что и линия, которая в неё приходит.
         Белая остаётся белой: у невзятой заявки маршрута нет, и красить её
         не во что. А статус ушёл туда, где он нужнее — значком на проблемных
         и цветом у выбранной. */
      const mine = placement ? colorOf(placement.engineerId) : null;
      const marker = L.circleMarker([order.lat, order.lon], {
        pane: 'points',
        radius: placement ? 6 : 7,
        weight: 2,
        color: placement ? '#FFFFFF' : TONE.free,
        fillColor: mine ?? '#FFFFFF',
        fillOpacity: 1
      });
      marker.bindTooltip(
        card(mine ?? TONE.free, `${order.id} · ${order.work_title}`, [
          placeOf(order),
          `${order.district} · окно ${hhmm(order.window_start)}–${hhmm(order.window_end)}`,
          engineer ? engineer.name : 'Инженер не назначен'
        ]),
        { direction: 'top', className: 'geo__tt' }
      );
      marker.on('click', () => pick.current.onSelectOrder(order.id));
      if (placement) {
        marker.on('mouseover', () => pick.current.onLive(placement.engineerId));
        marker.on('mouseout', () => pick.current.onLive(null));
      }
      marker.addTo(placement ? marks : orphans);
      pins.current.set(order.id, marker);

      /* Проблемная точка помечена значком, а не цветом.

         Цвет точки занят маршрутом, и перекрашивать её в красный значило бы
         терять ответ на «чья она». Значок стоит поверх и говорит своё: тут
         нарушен срок или нет запаса. Он маленький и красный — на общем виде
         взгляд цепляется именно за него, а не за перебор восьмидесяти
         цветных точек. */
      if (placement && problems.has(order.id)) {
        const badge = L.marker([order.lat, order.lon], {
          pane: 'points',
          icon: L.divIcon({
            className: 'geo__alarmbox',
            html: '<span class="geo__alarm">!</span>',
            iconSize: [12, 12],
            iconAnchor: [-2, 10]
          }),
          interactive: false
        });
        badge.addTo(marks);
        alarms.current.set(order.id, badge);
      }
    }

    const bounds = L.latLngBounds([...view.orderById.values()].map((o) => [o.lat, o.lon]));
    for (const load of view.loads) bounds.extend([load.engineer.home_lat, load.engineer.home_lon]);
    span.current = bounds;
    if (bounds.isValid() && instance.getSize().y > 0) {
      instance.fitBounds(bounds, { padding: [24, 24] });
      fitted.current = true;
    }
  }, [view]);

  /* Подсветка: живой маршрут чернеет и получает номера визитов, чужие точки
     гаснут. Номера — ответ на «в каком порядке он их объезжает». */
  useEffect(() => {
    const layer = seqLayer.current;
    if (!layer) return;
    layer.clearLayers();

    /* Наведённый маршрут подписывается прямо на карте. Раньше он только чуть
       толстел, а чей это путь, писали в списке справа: чтобы прочитать имя,
       приходилось уводить взгляд с карты — и терять из виду сам маршрут.
       Подпись стоит на середине линии и повторяет её цвет. */
    if (routesOn && live && live !== pinned) {
      const hot = view.loads.find((item) => item.engineer.id === live);
      const points = lines.current.get(live)?.getLatLngs() as L.LatLng[] | undefined;
      if (hot && points && points.length > 0) {
        L.tooltip({
          permanent: true,
          direction: 'top',
          offset: [0, -2],
          className: 'geo__tt',
          interactive: false
        })
          .setLatLng(points[Math.floor(points.length / 2)])
          .setContent(
            tag(
              colorOf(live),
              `${hot.engineer.name} · ${visits(hot.visits)} · ${Math.round(hot.occupancy * 100)}%`
            )
          )
          .addTo(layer);
      }
    }

    /* Выбранный маршрут остаётся на карте один: остальные пути, точки и
       квадраты выезда не гаснут, а полностью исчезают — иначе на двенадцати
       путях через один город выбранный всё равно теряется. */
    for (const [id, line] of lines.current) {
      const on = live === id;
      const hidden = pinned !== null && pinned !== id;
      line.getElement()?.classList.toggle('geo__live', pinned === id);
      grips.current.get(id)?.getElement()?.classList.toggle('geo__live', pinned === id);
      line.setStyle({
        color: colorOf(id),
        weight: on ? 6 : 3.5,
        opacity: hidden ? 0 : live && !on ? 0.2 : 0.95
      });
      if (on) line.bringToFront();
    }

    for (const [id, base] of bases.current) {
      const hidden = pinned !== null && pinned !== id;
      /* Начала чужих маршрутов гаснут вместе с их точками. Раньше они
         реагировали только на выбор щелчком, а при наведении оставались в
         полную силу: подсвечиваешь один маршрут, а на карте по-прежнему
         горят двенадцать квадратов чужих выездов. */
      const dim = live !== null && live !== id;
      base.setOpacity(hidden ? 0 : dim ? 0.2 : 1);
      base.getElement()?.classList.toggle('geo__live', pinned === id);

      /* У выбранного маршрута точки подписаны сами, без наведения: коротко —
         что это за точка. Подробности возвращаются, пока курсор на ней. */
      base.unbindTooltip();
      const rich = baseTip.current.get(id) ?? '';
      if (pinned === id) {
        base.bindTooltip(mini('Начало маршрута'), {
          permanent: true,
          direction: 'top',
          offset: [0, -6],
          className: 'geo__tt'
        });
        base.off('mouseover').off('mouseout');
        base.on('mouseover', () => base.setTooltipContent(rich));
        base.on('mouseout', () => base.setTooltipContent(mini('Начало маршрута')));
      } else {
        base.bindTooltip(rich, { direction: 'top', className: 'geo__tt' });
      }
    }

    /* Нумерованные кружки принадлежат выбранному маршруту и не зависят от
       того, где сейчас курсор. При простом наведении подмена точки под
       курсором гасила её же, курсор терял цель, подсветка снималась — и всё
       мигало по кругу, поэтому на наведение мы их не ставим вовсе. */
    const load = pinned ? view.loads.find((item) => item.engineer.id === pinned) : undefined;
    const numbered = new Map<string, number>();
    load?.route?.stops.forEach((stop, index) => numbered.set(stop.order_id, index + 1));

    for (const [orderId, marker] of pins.current) {
      const mine = view.stopByOrder.get(orderId)?.engineerId;
      const dim = live !== null && mine !== live;
      const hidden = pinned !== null && mine !== pinned;
      /* Точку подсвеченного маршрута прячем: на её месте встанет кружок с
         номером — ровно на тех же координатах, а не рядом. */
      const replaced = numbered.has(orderId);
      const opacity = replaced || hidden ? 0 : dim ? 0.2 : 1;
      marker.setStyle({ opacity, fillOpacity: opacity });

      /* Восклицательный знак живёт с точкой одной жизнью. Отдельным слоем он
         оставался на карте всегда: выбираешь один маршрут — и над ним висят
         значки чужих заявок, которые читаются как его собственные; а на самих
         его точках знак торчал из-под кружка с номером, хотя номер уже красный
         и про угрозу сказал. Здесь угроза либо в номере, либо в знаке, но не
         в двух местах сразу. */
      alarms.current.get(orderId)?.setOpacity(opacity);
    }

    if (!load?.route || numbered.size === 0) return;
    const problems = new Set(
      [...view.stopByOrder.entries()]
        .filter(([, placement]) => placement.slaBreached || placement.stop.risk !== 'low')
        .map(([id]) => id)
    );
    load.route.stops.forEach((stop, index) => {
      const order = view.orderById.get(stop.order_id);
      if (!order) return;
      const tone = problems.has(order.id) ? 'risk' : 'done';
      /* Всё оформление держит вложенный span: Leaflet оставляет от
         className только последний класс, и составное имя до стилей
         не доезжает. */
      const mark = L.marker([order.lat, order.lon], {
        icon: L.divIcon({
          className: 'geo__seqbox',
          html: `<span class="geo__seq geo__seq--${tone}">${index + 1}</span>`,
          iconSize: [20, 20],
          iconAnchor: [10, 10]
        }),
        /* Точки выбранного маршрута остаются живыми: на них наводятся и
           щёлкают, даже когда всё остальное на карте выключено. */
        interactive: true
      });
      const rich = card(TONE[tone], `${index + 1}. ${order.id} · ${order.work_title}`, [
        placeOf(order),
        `${order.district} · окно ${hhmm(order.window_start)}–${hhmm(order.window_end)}`,
        `визит ${hhmm(stop.start)}–${hhmm(stop.finish)} · запас ${stop.slack_minutes} мин`
      ]);
      const label = mini(`Заявка ${order.id} · ${hhmm(stop.start)}`);
      mark.bindTooltip(label, {
        permanent: true,
        direction: 'top',
        offset: [0, -6],
        className: 'geo__tt'
      });
      mark.on('mouseover', () => mark.setTooltipContent(rich));
      mark.on('mouseout', () => mark.setTooltipContent(label));
      mark.on('click', () => pick.current.onSelectOrder(order.id));
      mark.addTo(layer);
      mark.getElement()?.classList.add('geo__live');
    });
  }, [live, pinned, view, routesOn]);

  /* Полосы держатся в пикселях экрана, а не в метрах: просвет между двумя
     путями по одной дороге должен быть одинаковым и на обзоре города, и во
     дворе. Значит, при смене масштаба линии надо пересобрать — иначе сдвиг
     либо схлопывается в основную линию, либо уезжает от неё на квартал.

     Пересчитываем только сдвинутые: маршрут, который нигде ни с кем не
     совпал, лежит по своей дороге при любом масштабе. */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    for (const [id, lane] of lanes.current) {
      if (!lane.shifted) continue;
      const points = laneShift(instance, lane, instance.getZoom());
      lines.current.get(id)?.setLatLngs(points);
      grips.current.get(id)?.setLatLngs(points);
    }
  }, [zoom]);

  /* Развернули или свернули — карта пересчитывает свой размер. Leaflet
     считает его один раз и сам про изменение не узнает: без этого половина
     плиток остаётся от прежней ширины. */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    /* Через кадр: класс уже навешен, но браузер ещё не пересчитал раскладку,
       и размер в этот момент прежний. */
    const id = requestAnimationFrame(() => instance.invalidateSize());
    return () => cancelAnimationFrame(id);
  }, [full]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    document.addEventListener('keydown', onKey);
    /* Страница под развёрнутой картой не должна прокручиваться: колесо на
       карте меняет масштаб, а промах по ней уводил бы экран из-под неё. */
    const was = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = was;
    };
  }, [full]);

  /* Выбранная заявка: её точка растёт, меняет цвет на статусный и всплывает
     наверх. Карта подъезжает только если точка за краем.

     Подъезжаем не всегда намеренно. Выбрал заявку, которая и так на экране, —
     карта не должна дёргаться: диспетчер смотрит на неё же и потеряет из
     вида то, с чем сравнивал. */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    /* Сначала возвращаем всем точкам их собственный цвет и размер. Без этого
       статусная окраска накапливалась бы: выбрал одну, потом другую — и
       первая осталась бы зелёной, притворяясь выбранной. */
    for (const [id, spot] of pins.current) {
      const place = view.stopByOrder.get(id);
      spot.setStyle({
        fillColor: place ? colorOf(place.engineerId) : '#FFFFFF',
        color: place ? '#FFFFFF' : TONE.free,
        weight: 2,
        radius: place ? 6 : 7
      });
    }

    if (!selectedOrder) return;

    const order = view.orderById.get(selectedOrder);
    if (!order) return;

    /* Выбранная точка меняет цвет на статусный: зелёная — всё в порядке,
       красная — срок под угрозой. Это единственное место, где статус стоит
       цветом: на общем виде цвет принадлежит маршруту, а тут выбрана одна
       точка, её маршрут и так подсвечен, и цвет освобождается под ответ на
       «а с ней-то что». Невзятая остаётся белой: статуса у неё нет, есть
       только отсутствие исполнителя. */
    const placement = view.stopByOrder.get(order.id);
    const risky = placement
      ? placement.slaBreached || placement.stop.risk !== 'low'
      : false;
    /* Выбранная точка крупнее остальных и обведена белым.

       Сначала здесь было кольцо пунктиром. На радиусе в десяток пикселей
       пунктир распадается на неровные штрихи — рисунок зависит от того, как
       окружность легла в сетку экрана, и одна и та же обводка выглядит
       по-разному на разных точках. Выглядит это не как обводка, а как сбой
       отрисовки.

       Размер и толстая белая обводка тем же не страдают: они читаются на
       любом фоне и на любом из трёх статусных цветов, а рядом ещё стоит
       постоянная подпись с номером. Больше ничего и не нужно. */
    const spot = pins.current.get(order.id);
    if (spot) {
      spot.setStyle({
        fillColor: placement ? (risky ? TONE.risk : TONE.done) : '#FFFFFF',
        color: '#FFFFFF',
        weight: 3.5,
        radius: 10
      });
      spot.bringToFront();
    }

    const at = L.latLng(order.lat, order.lon);

    if (instance.getSize().y > 0 && !instance.getBounds().pad(-0.12).contains(at)) {
      instance.panTo(at, { animate: true });
    }
  }, [selectedOrder, view]);

  /* Щелчок по списку справа: подлетаем к маршруту целиком. */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !live || focus === 0) return;
    const line = lines.current.get(live);
    if (line && instance.getSize().y > 0) instance.fitBounds(line.getBounds(), { padding: [40, 40] });
  }, [focus]);

  /* Тумблеры снимают и возвращают слой целиком: выключенное не гаснет, а
     уходит с карты, иначе бледные линии всё равно спорят с тем, ради чего
     их выключали. */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const show = (layer: L.LayerGroup | null, on: boolean) => {
      if (!layer) return;
      if (on) layer.addTo(instance);
      else layer.remove();
    };
    show(routeLayer.current, routesOn);
    show(pinLayer.current, pinsOn);
    show(freeLayer.current, freeOn);
  }, [routesOn, pinsOn, freeOn]);

  /* Границы масштаба берём у самой карты, а не зашиваем: подложка задаёт
     их своими maxZoom/minZoom, и продублированное число однажды разойдётся
     с настоящим. */
  const ZOOM_MIN = 9;
  const ZOOM_MAX = 16;

  /* Обзор в километрах — то, чем ползунок подписан.

     «Зум 13» не значит ничего никому, кроме того, кто работал с картами.
     А вот «обзор 12 км» — значит: это ширина того, что сейчас на экране.
     Считается по настоящей формуле проекции, а не выдумывается: на широте φ
     один пиксель при зуме z равен 156543,03 · cos φ / 2^z метрам. */
  const spanKm = (atZoom: number) => {
    const instance = map.current;
    const width = instance?.getSize().x ?? 900;
    const lat = instance?.getCenter().lat ?? 55.75;
    const metersPerPixel = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** atZoom;
    return (metersPerPixel * width) / 1000;
  };

  const setZoomTo = (next: number) => {
    const instance = map.current;
    if (!instance) return;
    const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    /* Без анимации — как и всё остальное в этой карте.

       Анимированный зум Leaflet отказывается проигрывать, если прыжок
       большой: он рассчитан на шаг, а не на перелёт с обзора области на
       обзор двора, и на таком скачке просто ничего не делает. Ползунок же
       ровно для перелётов и нужен. Заодно совпадает с колесом и с
       вписыванием в границы — они тут тоже без анимации, чтобы плитки не
       перестраивались по десятку раз за жест. */
    instance.setZoom(target, { animate: false });
  };

  const km = spanKm(zoom);
  /* До десяти километров дробь имеет смысл, дальше — нет: «23,7 км» на
     обзоре в пол-области это точность, которой там неоткуда взяться. */
  const kmLabel = km < 10 ? `${km.toFixed(1).replace('.', ',')} км` : `${Math.round(km)} км`;

  return (
    <div className="geo">
      <div className="geo__bar">
        <div className="geo__legend">
          <span className="geo__key">
            <span className="geo__dot geo__dot--done" />
            Активные заявки
          </span>
          <span className="geo__key">
            <span className="geo__dot geo__dot--risk" />
            Заявка под угрозой
          </span>
          <span className="geo__key">
            <span className="geo__dot geo__dot--free" />
            Заявка без инженера
          </span>
          <span className="geo__key">
            <span className="geo__home" />
            Начало маршрута
          </span>
          <span className="geo__key">
            <span className="geo__line" />
            Маршрут
          </span>
        </div>

        {/* Три тумблера вместо одной кнопки: карта складывается из трёх
            слоёв, и каждый выключается отдельно. Пути мешают, когда смотрят
            на плотность точек; взятые заявки мешают, когда ищут, где
            остались невзятые. Тумблер, а не кнопка, потому что это состояние
            слоя, а не действие.

            Группа обведена и прижата вправо. Раньше тумблеры стояли строкой
            под легендой, прижатые влево, и справа зияла пустая половина.
            Дело не в выравнивании: легенда отвечает на «что значит этот
            цвет», а слои — на «что вообще рисовать», и это разные вопросы. */}
        <div className="geo__controls">
          <div className="geo__layers">
            <span className="geo__layers-title">Показывать</span>
            <Switch
              size="sm"
              label="Маршруты"
              checked={routesOn}
              onChange={() => setRoutesOn((v) => !v)}
            />
            <Switch size="sm" label="Точки" checked={pinsOn} onChange={() => setPinsOn((v) => !v)} />
            <Switch
              size="sm"
              label="Без инженера"
              checked={freeOn}
              onChange={() => setFreeOn((v) => !v)}
            />
          </div>

          {/* Источник подложки. Не плашкой в углу карты — из-за неё карта
              заканчивалась не картой, — а у правого края той же строки, где
              стоят слои. Указание обязательно, места оно не отнимает, и
              строка вместо половинчатой становится полной. */}
          <span className="geo__credit">Подложка: Esri · © OpenStreetMap</span>
        </div>
      </div>

      <div
        className={
          'geo__plot' +
          (pinnedLoad ? ' geo__plot--locked' : '') +
          (full ? ' geo__plot--full' : '')
        }
      >
        <div className="geo__map" ref={host} />

        {/* Свой масштаб: две кнопки и ползунок обзора.

            Кнопки — то же действие, что у штатных, но в наших размерах,
            шрифте и радиусе. Ползунок отвечает на другой вопрос: не «на шаг
            ближе», а «покажи мне весь город» или «покажи мне двор». Это
            разные способы думать о карте, и оба нужны — кнопками уточняют,
            ползунком перескакивают. Подписан он километрами, а не ступенями
            зума: «обзор 12 км» понятно всем, «зум 13» — только картографу. */}
        <div className="geo__zoom">
          <button
            type="button"
            className="geo__zoombtn"
            onClick={() => setZoomTo(zoom + 1)}
            disabled={zoom >= ZOOM_MAX}
            aria-label="Приблизить"
            title="Приблизить"
          >
            <Icon name="plus" size={14} />
          </button>

          <span className="geo__zoomscale">
            <input
              className="geo__zoomrange"
              type="range"
              min={ZOOM_MIN}
              max={ZOOM_MAX}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoomTo(Number(e.currentTarget.value))}
              aria-label="Обзор карты"
              aria-valuetext={`обзор ${kmLabel}`}
            />
          </span>

          <button
            type="button"
            className="geo__zoombtn"
            onClick={() => setZoomTo(zoom - 1)}
            disabled={zoom <= ZOOM_MIN}
            aria-label="Отдалить"
            title="Отдалить"
          >
            <Icon name="minus" size={14} />
          </button>

          <span className="geo__zoomvalue" aria-hidden="true">
            {kmLabel}
          </span>

          {/* Разворот стоит в том же кластере, что и масштаб: и то и другое
              про то, сколько карты видно, и искать их в разных углах
              незачем. */}
          <button
            type="button"
            className="geo__zoombtn geo__zoombtn--full"
            onClick={() => setFull((v) => !v)}
            aria-pressed={full}
            aria-label={full ? 'Свернуть карту' : 'Развернуть карту на весь экран'}
            title={full ? 'Свернуть · Esc' : 'Развернуть на весь экран'}
          >
            <Icon name={full ? 'corners-in' : 'corners-out'} size={14} />
          </button>
        </div>

        {/* Пока маршрут выбран, карта не отвлекает: остальные пути и точки
            не нажимаются, а сверху висит короткая справка о выбранном. */}
        {pinnedLoad && (
          <div className="geo__card">
            <div className="geo__card-top">
              <span
                className="geo__card-mark"
                style={{ background: colorOf(pinnedLoad.engineer.id) }}
              />
              <button
                type="button"
                className="geo__card-name"
                onClick={() => onSelectEngineer(pinnedLoad.engineer.id)}
              >
                {pinnedLoad.engineer.name}
              </button>
              <button
                type="button"
                className="rpanel__x"
                onClick={() => onPin(null)}
                aria-label="Снять выбор маршрута"
              >
                <Icon name="x" size={14} />
              </button>
            </div>

            <div className="geo__card-facts">
              <span>
                <b>{pinnedLoad.visits}</b> визитов
              </span>
              <span>
                загрузка <b>{Math.round(pinnedLoad.occupancy * 100)}%</b>
              </span>
              {pinnedLoad.route && (
                <>
                  <span>
                    в пути <b>{spell(pinnedLoad.route.totals.travel_minutes)}</b>
                  </span>
                  <span>
                    работа <b>{spell(pinnedLoad.route.totals.work_minutes)}</b>
                  </span>
                  <span>
                    {hhmm(pinnedLoad.route.totals.start)}–{hhmm(pinnedLoad.route.totals.end)}
                  </span>
                </>
              )}
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
