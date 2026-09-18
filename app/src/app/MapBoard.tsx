import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Icon, iconPath } from '../ds/components/core/Icon.jsx';
import { PersonName } from './PersonName.tsx';
import type { DayView } from '../data/derive.ts';
import { hhmm, homeOf, placeOf, roadPath, visits } from '../data/derive.ts';
import type { Lane } from './lanes.ts';
import { laneLayout } from './lanes.ts';
import { transportIcon, transportName } from '../data/dictionary.ts';
import { routeLabel, routeNumber } from '../data/routeIds.ts';

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
  /** Карта занимает всё отведённое ей место, а не свои 560 пикселей высоты.
      Так она стоит в обзоре: там карта — не блок на странице, а сам экран. */
  fill?: boolean;
  /** Расчёт, чей план на карте: вместе с инженером он опознаёт маршрут, а
      значит, даёт его собственный номер. */
  runId: string;
  /** Колонка поверх правого края карты. Карта в обзоре занимает оба поля, и
      числа расчёта ложиться им некуда, кроме как на неё саму. Держит её
      карта, а не экран вокруг: у карты уже есть свои слои поверх подложки —
      масштаб слева, карточка выбранного маршрута, — и разводить их по углам
      должен тот, кто знает про все три сразу. */
  aside?: ReactNode;
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

/* Значок строкой — для подписей, которые собирает Leaflet, а не React.
   Берётся из того же набора, что и все остальные значки программы. */
const glyph = (name: string, size = 11) => {
  const d = iconPath(name);
  return d
    ? `<svg class="gtip__ico" viewBox="0 0 256 256" width="${size}" height="${size}" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`
    : '';
};

/* Однострочная подпись с цветной точкой: чей это маршрут, читается прямо
   на карте, а цвет точки повторяет цвет линии. */
const tag = (tone: string, text: string, icon?: string) =>
  `<span class="gtip gtip--mini gtip--tag"><i class="gtip__dot" style="background:${tone}"></i>` +
  (icon ? glyph(icon) : '') +
  `${text}</span>`;

/* Толщина маршрута по масштабу — и она убывает с приближением.

   На обзоре области линию держит только ширина: улиц под ней не видно, и
   тонкая нитка пропадает на тёмной подложке. Во дворе всё наоборот — там
   видна сама улица, и линия должна её обводить, а не закрывать: чем ближе
   карта, тем важнее видеть, по какой полосе едет инженер, а не какого цвета
   его маршрут. Разброс небольшой, от 1,8 до 1,2 пикселя: это не смена облика,
   а поправка на то, что под линией. */
const weightAt = (zoom: number) =>
  1.2 + (0.6 * (16 - Math.min(16, Math.max(9, zoom)))) / 7;

/* Сколько слоёв различает раскладка. Толщина от слоя больше не зависит, но
   порядок — да: слой решает, кто лежит поверх кого на общей дороге. */
const LAYERS = 3;

/* Толщина у всех маршрутов одна.

   Сперва нижние слои делались шире верхних: из-под верхнего цвета выступала
   кайма, и было видно, что по дороге едут двое. Беда в том, что толщина у
   маршрута одна на весь путь, а общая дорога — только его часть: кайма
   тянулась и там, где инженер едет один. На карте рядом оказывались пути
   заметно разной толщины, и разница читалась не как «здесь едут вместе», а
   как сбой отрисовки. Заказчик прочитал её именно так, сравнив два маршрута
   в разных концах города, — и это решающий довод: подсказка, которую
   понимают неверно, хуже, чем её отсутствие.

   Цена решения названа прямо: там, где двое идут по одной улице, виден
   только верхний цвет. Кто там ещё — отвечают наведение и список справа.

   Раскладка по слоям при этом осталась и работает: она решает, кто лежит
   поверх кого, и решает одинаково от отрисовки к отрисовке — иначе на общей
   дороге цвет менялся бы сам собой при каждом обновлении.

   Наведённый маршрут прибавляет пиксель с небольшим: множитель от тонкой
   линии почти не виден, а от толстой даёт вдвое больше, чем нужно. */
const bandWeight = (base: number, live: boolean) => base + (live ? 1.2 : 0);

/* Виды подложки. Три — по числу вопросов, ради которых карту переключают.

   Тёмная отвечает на «где идут маршруты»: она обесцвечена нарочно, цвет на
   ней принадлежит данным, и дюжина линий читается сразу. Обычная отвечает на
   «что это за место»: улицы подписаны, дома и кварталы на своих местах —
   по ней узнают адрес. Спутник отвечает на «что там на самом деле»: частный
   сектор, промзона, стройка — то, чего не скажет ни одна схема.

   Все три — Esri, тем же ключом и тем же порядком частей пути (z/y/x).
   Подписи у тёмной и у спутника идут вторым слоем: без них город
   безымянный. У обычной подписи уже внутри. */
type Base = 'dark' | 'plain' | 'sat';

const ESRI = 'https://services.arcgisonline.com/ArcGIS/rest/services';

const BASEMAPS: {
  key: Base;
  label: string;
  icon: string;
  url: string;
  labels?: string;
  credit: string;
  /* Тёмная ли подложка: от этого зависит, чем закрашены прорехи между
     плитками и каким цветом идут наши собственные метки. */
  night: boolean;
  /* Нужна ли линиям тёмная обводка. Палитра маршрутов светлая — её подбирали
     под тёмную схему, где работает только то, что светлее фона. На улицах и
     на снимке те же цвета тонут: дюжина светлых ниток по пёстрому фону
     читается как каша. Обводка возвращает им контраст, не трогая сам цвет —
     а цвет у маршрута один на всю программу, и менять его от подложки
     нельзя. */
  casing: boolean;
}[] = [
  {
    key: 'dark',
    label: 'Тёмная',
    icon: 'moon',
    url: `${ESRI}/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}`,
    credit: 'Esri · © OpenStreetMap',
    night: true,
    casing: false
  },
  {
    key: 'plain',
    label: 'Обычная',
    icon: 'map-trifold',
    url: `${ESRI}/World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
    credit: 'Esri · © OpenStreetMap',
    night: false,
    casing: true
  },
  {
    key: 'sat',
    label: 'Спутник',
    icon: 'globe',
    url: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
    labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
    credit: 'Esri · Maxar · Earthstar Geographics',
    night: true,
    casing: true
  }
];

/* Ключ места выезда — целые стотысячные доли градуса, около метра: адрес
   один и тот же, а координаты у разных записей могут разойтись в последнем
   знаке. */
const nestKey = (lat: number, lon: number) => `${Math.round(lat * 1e5)}:${Math.round(lon * 1e5)}`;

const card = (tone: string, head: string, lines: string[]) =>
  `<span class="gtip"><span class="gtip__head"><i class="gtip__dot" style="background:${tone}"></i>${head}</span>` +
  lines.map((line) => `<span class="gtip__line">${line}</span>`).join('') +
  '</span>';

/** Средство передвижения словами. Поле необязательное: движок 1.1 его не
    отдаёт, и тогда о транспорте сказать нечего. */
const rideOf = (transport: string | null | undefined) =>
  transport ? transportName(transport) : 'Транспорт не указан';

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
  runId,
  live,
  onLive,
  pinned,
  onPin,
  focus,
  onSelectOrder,
  onSelectEngineer,
  selectedOrder = null,
  fill = false,
  aside = null
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
  /* Подписи маршрутов — свой слой и своя ссылка. Они не пересобираются от
     наведения: подпись под курсором нельзя снимать и ставить заново, иначе
     курсор теряет цель и подсветка мигает. Меняется только содержимое. */
  const tagLayer = useRef<L.LayerGroup | null>(null);
  const labels = useRef<Map<string, L.Tooltip>>(new Map());
  const lines = useRef<Map<string, L.Polyline>>(new Map());
  /* Линии вместе с их толщиной. Нужны затем, что порядок отрисовки — это и
     есть порядок слоёв: широкое кладём вниз, узкое сверху, и после каждой
     подсветки порядок восстанавливаем. */
  const stack = useRef<{ id: string; rank: number; line: L.Polyline }[]>([]);
  /* Тёмная обводка под линиями. Живёт отдельно от них: линии собираются от
     данных, а обводка — от подложки, и пересобирать из-за смены картинки под
     картой весь день незачем. */
  const casings = useRef<{ id: string; line: L.Polyline }[]>([]);
  /* Раскладка путей по слоям. Считается от данных, а толщина из неё — от
     масштаба, поэтому она живёт отдельно от самих линий. */
  const lanes = useRef<Map<string, Lane>>(new Map());
  /* Невидимая широкая копия линии: попасть курсором в трёхпиксельный путь
     невозможно, поэтому события ловит она, а рисует — тонкая. */
  const grips = useRef<Map<string, L.Polyline>>(new Map());
  const pins = useRef<Map<string, L.CircleMarker>>(new Map());
  /* Значки «под угрозой» держим отдельно от точек: они гаснут и прячутся
     вместе со своей точкой, но это не она. */
  const alarms = useRef<Map<string, L.Marker>>(new Map());
  const bases = useRef<Map<string, L.Marker>>(new Map());
  /* Общие гнёзда выезда: одно место — один квадрат, сколько бы инженеров
     отсюда ни выезжало. */
  const nestMarks = useRef<Map<string, L.Marker>>(new Map());
  /* Подробная подсказка базы: у выбранного маршрута её место занимает
     постоянная подпись, а при наведении она возвращается. */
  const baseTip = useRef<Map<string, string>>(new Map());
  /* Подсказка общего гнезда: та же роль, что и у подсказки личного квадрата
     выезда, — у выбранного маршрута её место занимает постоянная подпись. */
  const nestTip = useRef<Map<string, string>>(new Map());
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

  /* Порядок отрисовки — это и есть порядок слоёв: широкие вниз, узкие сверху.
     Восстанавливать его приходится после каждой подсветки, потому что
     наведённый маршрут всплывает наверх и остаётся там. */
  const layerOrder = (front?: string | null) => {
    const sorted = [...stack.current].sort((a, b) => b.rank - a.rank);
    for (const item of sorted) if (item.id !== front) item.line.bringToFront();
    if (front) for (const item of sorted) if (item.id === front) item.line.bringToFront();
  };

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
  /* Вид подложки. Держится в браузере: это настройка рабочего места, а не
     свойство расчёта, и переспрашивать её на каждом заходе незачем. */
  const [base, setBase] = useState<Base>(() => {
    try {
      const saved = localStorage.getItem('polet.basemap');
      return saved === 'plain' || saved === 'sat' ? saved : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [routesOn, setRoutesOn] = useState(true);
  /* Точки переключаются все разом: взятые, невзятые и квадраты выезда. Три
     тумблера на три слоя отвечали на вопрос, которого никто не задаёт, —
     «показать точки, но без невзятых»; спрашивают другое: «убери точки, я
     смотрю на пути». */
  const [pinsOn, setPinsOn] = useState(true);
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
    /* Сами слои подложки ставит отдельное действие ниже: их меняют на ходу,
       переключая вид карты, и держать их здесь значило бы пересоздавать всю
       карту на каждое переключение. */
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
    tagLayer.current = L.layerGroup().addTo(instance);
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
        instance.fitBounds(span.current, { padding: [24, 24], animate: false });
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

  /* Подложка. Меняется переключателем вида, поэтому живёт отдельно от самой
     карты: пересоздавать карту ради смены картинки под ней незачем.

     Плитки этой подложки — JPEG 256 точек, и на плотном экране они мылятся:
     браузер растягивает их вдвое. С `detectRetina` Leaflet берёт плитки на
     ступень глубже и кладёт в тот же квадрат — картинка становится резкой.

     Дальше шестнадцатой ступени плиток нет ни у одной из трёх: Leaflet
     растягивает последнюю. Мягче, зато во дворе видно дом, а не квартал.

     Плитки тянем на ходу, а не после остановки: с `updateWhenIdle` резкая
     прокрутка колесом уводила карту туда, где плиток ещё нет, и пол-экрана
     на миг становилось серым. Запас по краю — шесть плиток. */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const chosen = BASEMAPS.find((one) => one.key === base) ?? BASEMAPS[0];
    const common = {
      maxZoom: 19,
      minZoom: 7,
      detectRetina: true,
      maxNativeZoom: 16,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 6
    } as const;

    const layers = [L.tileLayer(chosen.url, common)];
    if (chosen.labels) layers.push(L.tileLayer(chosen.labels, { ...common, pane: 'tilePane' }));
    for (const layer of layers) layer.addTo(instance);

    try {
      localStorage.setItem('polet.basemap', base);
    } catch {
      /* Приватное окно: вид подложки просто не запомнится. */
    }

    return () => {
      for (const layer of layers) layer.remove();
    };
  }, [base]);

  /* Слои дня: линии маршрутов, точки заявок, квадраты выезда. */
  useEffect(() => {
    const instance = map.current;
    const routes = routeLayer.current;
    const marks = pinLayer.current;
    const orphans = freeLayer.current;
    if (!instance || !routes || !marks || !orphans) return;
    /* Сперва вид, потом слои — и это не вкусовщина.

       Пока у карты нет ни центра, ни масштаба, Leaflet откладывает добавление
       слоя до первого вида, а разметку пути считает ровно в тот миг — по
       рамке, которой ещё нет. Путь целиком оказывается «за экраном», в
       разметке остаётся пустое «M0 0», и сам собой он не пересчитывается. На
       экране это выглядело так: точки есть, линий нет, а стоит тронуть
       масштаб — появляются все разом. Вписав границы до сборки, мы кладём
       линии на карту, которая уже знает, где стоит.

       Без анимации: анимированное вписывание страница гасит своей же
       перерисовкой — тем же, чем гасила подлёт к выбранному маршруту. */
    const bounds = L.latLngBounds([...view.orderById.values()].map((o) => [o.lat, o.lon]));
    for (const load of view.loads) bounds.extend([load.engineer.home_lat, load.engineer.home_lon]);
    span.current = bounds;
    if (bounds.isValid() && instance.getSize().y > 0) {
      instance.fitBounds(bounds, { padding: [24, 24], animate: false });
      fitted.current = true;
    }

    routes.clearLayers();
    marks.clearLayers();
    orphans.clearLayers();
    lines.current.clear();
    stack.current = [];
    grips.current.clear();
    pins.current.clear();
    alarms.current.clear();
    bases.current.clear();
    nestMarks.current.clear();
    nestTip.current.clear();

    const problems = new Set(
      [...view.stopByOrder.entries()]
        .filter(([, placement]) => placement.slaBreached || placement.stop.risk !== 'low')
        .map(([id]) => id)
    );

    /* Пути собираем до отрисовки: слой на общей дороге зависит от соседей,
       и в одиночку, внутри цикла по маршрутам, его не определить. Старшинство
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
        })),
      LAYERS + 1
    );

    const thick = weightAt(instance.getZoom());

    /* Где несколько инженеров выезжают из одной точки.

       В выгрузке заказчика у бригады один адрес выезда на всех, и на карте
       в этом месте лежала стопка из дюжины квадратов: наведение показывало
       один маршрут, случайный — тот, что оказался сверху, — а остальные под
       ним молчали. Место общее, и отмечать его надо один раз: серый квадрат
       и перечень тех, кто отсюда выезжает.

       Точку берём из самих данных: адрес выезда приходит у каждого инженера
       в выгрузке, и общее гнездо — это просто одинаковые координаты. Никакого
       отдельного файла для этого не нужно: он повторял бы то, что уже есть.

       Ключ места — общий с подсветкой, поэтому объявлен выше. */
    const nests = new Map<string, typeof view.loads>();
    for (const load of view.loads) {
      const key = nestKey(load.engineer.home_lat, load.engineer.home_lon);
      const list = nests.get(key) ?? [];
      list.push(load);
      nests.set(key, list);
    }

    view.loads.forEach((load, index) => {
      const color = routeColor(index);
      const lane = lanes.current.get(load.engineer.id);
      if (lane) {
        /* Ловушка курсора — одна на весь маршрут и по его оси: попасть в
           линию в три пикселя нельзя, а слои для этого не при чём. */
        const grip = L.polyline(lane.points, { color, weight: 16, opacity: 0, noClip: true });
        grip.on('mouseover', () => pick.current.onLive(load.engineer.id));
        grip.on('mouseout', () => pick.current.onLive(null));
        grip.on('click', () => pick.current.onPin(load.engineer.id));
        grip.addTo(routes);
        grips.current.set(load.engineer.id, grip);

        /* Отсечение по краю экрана выключено: в дне дюжина путей по сотне
           точек, и рисовать их целиком дешевле, чем считать, что из них видно
           сейчас. Заодно одним поводом для пустой разметки меньше. */
        const line = L.polyline(lane.points, {
          color,
          weight: bandWeight(thick, false),
          opacity: 0.95,
          interactive: false,
          noClip: true
        });
        line.addTo(routes);
        lines.current.set(load.engineer.id, line);
        stack.current.push({ id: load.engineer.id, rank: lane.rank, line });
      }

      /* Выезжающие из общего гнезда своего квадрата не получают: за них
         отвечает один серый, поставленный ниже. */
      if ((nests.get(nestKey(load.engineer.home_lat, load.engineer.home_lon))?.length ?? 1) > 1) {
        return;
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
        `Средство передвижения: ${rideOf(load.engineer.transport)}`,
        `${visits(load.visits)} · загрузка ${Math.round(load.occupancy * 100)}%`
      ]);
      baseTip.current.set(load.engineer.id, baseCard);
      base.bindTooltip(baseCard, { direction: 'top', className: 'geo__tt' });
      base.on('mouseover', () => pick.current.onLive(load.engineer.id));
      base.on('mouseout', () => pick.current.onLive(null));
      base.on('click', () => pick.current.onPin(load.engineer.id));
      /* Квадрат выезда — точка, а не путь: гаснет вместе с остальными
         точками, а не вместе с линиями. */
      base.addTo(marks);
      bases.current.set(load.engineer.id, base);
    });

    /* Общие гнёзда выезда — по одному серому квадрату на место, а не по
       квадрату на инженера. Серый нарочно: цвет на карте принадлежит
       маршрутам, а гнездо — ничьё, оно общее. */
    for (const [key, list] of nests) {
      if (list.length < 2) continue;
      const [first] = list;
      const mark = L.marker([first.engineer.home_lat, first.engineer.home_lon], {
        icon: L.divIcon({
          className: 'geo__basebox',
          html: '<span class="geo__nest"></span>',
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        }),
        /* Нажатие выбрало бы один маршрут из дюжины — наугад. Гнездо только
           рассказывает о себе. */
        interactive: true,
        keyboard: false
      });
      const nestCard = card('#8A8A8A', 'Общий выезд', [
        homeOf(first.engineer),
        `Отсюда выезжают ${list.length}: ` +
          list.map((one) => one.engineer.name.split(' ')[0]).join(', ')
      ]);
      nestTip.current.set(key, nestCard);
      mark.bindTooltip(nestCard, { direction: 'top', className: 'geo__tt' });
      mark.addTo(marks);
      nestMarks.current.set(key, mark);
    }

    /* Кладём пути от нижнего слоя к верхнему: широкий — первым, узкий —
       поверх него. Так на общей дороге из-под верхнего цвета ровной каймой
       выступает каждый следующий, и дорога остаётся одна. */
    layerOrder();

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
        radius: placement ? 5 : 6,
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

  }, [view]);

  /* Подпись у каждого маршрута: номер и средство передвижения.

     Раньше карта молчала о путях, пока на них не наведёшь, — а вопрос «какой
     это маршрут и на чём человек едет» задают, ещё не трогая мышь. Подпись
     стоит на середине линии и повторяет её цвет.

     Наведение на саму подпись подсвечивает маршрут — так же, как наведение
     на линию: подпись и есть самое крупное, во что можно попасть курсором, и
     не отвечать на это странно. Содержимое при этом подменяется на месте, а
     не пересобирается: снять подпись из-под курсора значит потерять
     наведение и получить мигание. */
  const labelOf = (id: string, wide: boolean) => {
    const one = view.loads.find((item) => item.engineer.id === id);
    if (!one) return '';
    const ride = one.engineer.transport ? transportIcon(one.engineer.transport) : undefined;
    const number = routeLabel(routeNumber(runId, id));
    return wide
      ? tag(
          colorOf(id),
          `${number} · ${one.engineer.name} · ${rideOf(one.engineer.transport)} · ` +
            `${visits(one.visits)} · ${Math.round(one.occupancy * 100)}%`,
          ride
        )
      : tag(colorOf(id), number, ride);
  };

  useEffect(() => {
    const layer = tagLayer.current;
    if (!layer) return;
    layer.clearLayers();
    labels.current.clear();
    if (!routesOn) return;

    for (const one of view.loads) {
      const id = one.engineer.id;
      const points = lanes.current.get(id)?.points;
      if (!points || points.length === 0) continue;
      const label = L.tooltip({
        permanent: true,
        direction: 'top',
        offset: [0, -2],
        className: 'geo__tt geo__tt--quiet',
        interactive: true
      })
        .setLatLng(points[Math.floor(points.length / 2)])
        .setContent(labelOf(id, false));
      label.on('mouseover', () => pick.current.onLive(id));
      label.on('mouseout', () => pick.current.onLive(null));
      label.on('click', () => pick.current.onPin(id));
      label.addTo(layer);
      labels.current.set(id, label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, routesOn, runId]);

  /* Наведение и выбор: подпись наведённого раскрывается, чужие прячутся. */
  useEffect(() => {
    for (const [id, label] of labels.current) {
      const on = live === id;
      const hidden = pinned !== null && pinned !== id;
      label.setContent(labelOf(id, on));
      const node = label.getElement();
      if (node) node.style.display = hidden ? 'none' : '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, pinned, view]);

  /* Подсветка: живой маршрут чернеет и получает номера визитов, чужие точки
     гаснут. Номера — ответ на «в каком порядке он их объезжает». */
  useEffect(() => {
    const layer = seqLayer.current;
    if (!layer) return;
    layer.clearLayers();


    /* Выбранный маршрут остаётся на карте один: остальные пути, точки и
       квадраты выезда не гаснут, а полностью исчезают — иначе на двенадцати
       путях через один город выбранный всё равно теряется. */
    const thick = weightAt(map.current?.getZoom() ?? zoom);
    for (const item of stack.current) {
      const on = live === item.id;
      const hidden = pinned !== null && pinned !== item.id;
      item.line.getElement()?.classList.toggle('geo__live', pinned === item.id);
      item.line.setStyle({
        color: colorOf(item.id),
        weight: bandWeight(thick, on),
        opacity: hidden ? 0 : live && !on ? 0.2 : 0.95
      });
    }
    for (const [id, grip] of grips.current) {
      grip.getElement()?.classList.toggle('geo__live', pinned === id);
    }

    /* Обводка гаснет вместе со своей линией. Без этого на светлой подложке
       выбор маршрута оставлял на карте дюжину тёмных ниток: линии исчезали,
       а их обводки — нет, и чужие пути продолжали спорить с выбранным. */
    for (const one of casings.current) {
      const on = live === one.id;
      const hidden = pinned !== null && pinned !== one.id;
      one.line.setStyle({ opacity: hidden ? 0 : live && !on ? 0.12 : 0.5 });
    }
    /* Наведённый маршрут поднимаем наверх, остальные возвращаем в порядок
       слоёв: без этого прошлое наведение оставляло бы широкий кусок поверх
       узкого, и на общей дороге пропадал бы верхний цвет. */
    layerOrder(live);

    /* Выбранный маршрут: его начало и его визиты подписываются сами, без
       наведения. */
    const load = pinned ? view.loads.find((item) => item.engineer.id === pinned) : undefined;

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
        base.bindTooltip(mini(`Выезд${load?.route ? ` · ${hhmm(load.route.totals.start)}` : ''}`), {
          permanent: true,
          direction: 'top',
          offset: [0, -6],
          className: 'geo__tt'
        });
        base.off('mouseover').off('mouseout');
        base.on('mouseover', () => base.setTooltipContent(rich));
        base.on('mouseout', () =>
          base.setTooltipContent(mini(`Выезд${load?.route ? ` · ${hhmm(load.route.totals.start)}` : ''}`))
        );
      } else {
        base.bindTooltip(rich, { direction: 'top', className: 'geo__tt' });
      }
    }

    /* Место выезда выбранного маршрута подписано так же, как его визиты:
       «Выезд · 10:00». Раньше подпись висела только на личном квадрате, а в
       выгрузке заказчика вся бригада выезжает из одного гнезда — личных
       квадратов там нет вовсе, и у выбранного маршрута начало оставалось
       безымянным, хотя все его визиты подписаны. */
    for (const [key, mark] of nestMarks.current) {
      const rich = nestTip.current.get(key) ?? '';
      mark.unbindTooltip();
      const mine = load && nestKey(load.engineer.home_lat, load.engineer.home_lon) === key;
      if (mine) {
        const start = load?.route?.totals.start;
        mark.bindTooltip(mini(start === undefined ? 'Выезд' : `Выезд · ${hhmm(start)}`), {
          permanent: true,
          direction: 'top',
          offset: [0, -7],
          className: 'geo__tt'
        });
        mark.off('mouseover').off('mouseout');
        mark.on('mouseover', () => mark.setTooltipContent(rich));
        mark.on('mouseout', () =>
          mark.setTooltipContent(mini(start === undefined ? 'Выезд' : `Выезд · ${hhmm(start)}`))
        );
      } else {
        mark.bindTooltip(rich, { direction: 'top', className: 'geo__tt' });
      }
    }

    /* Нумерованные кружки принадлежат выбранному маршруту и не зависят от
       того, где сейчас курсор. При простом наведении подмена точки под
       курсором гасила её же, курсор терял цель, подсветка снималась — и всё
       мигало по кругу, поэтому на наведение мы их не ставим вовсе. */
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
  }, [live, pinned, view, routesOn, runId]);

  /* Тёмная обводка под маршрутами — на светлой схеме и на снимке.

     Палитра маршрутов светлая: её подбирали под тёмную подложку, где
     работает только то, что светлее фона. На улицах и на спутнике те же
     цвета тонут — дюжина светлых ниток по пёстрому фону читается как каша.
     Выбранный маршрут при этом виден: он один, и глазу есть за что
     зацепиться, — а вот все разом пропадают.

     Обводка возвращает линиям контраст, не трогая сам цвет: цвет маршрута
     один на всю программу — он же у точек, у метки в списке и в сводке, — и
     менять его от подложки нельзя. Толщина у обводки одна на всех, как и у
     самих линий. */
  useEffect(() => {
    const instance = map.current;
    const routes = routeLayer.current;
    if (!instance || !routes) return;
    const chosen = BASEMAPS.find((one) => one.key === base) ?? BASEMAPS[0];
    if (!chosen.casing) return;

    const thick = weightAt(instance.getZoom()) + 2.4;
    const made = stack.current.map((item) => {
      const casing = L.polyline(item.line.getLatLngs() as L.LatLng[], {
        color: '#0A0A0A',
        weight: thick,
        opacity: 0.5,
        interactive: false,
        noClip: true
      });
      casing.addTo(routes);
      casing.bringToBack();
      return { id: item.id, line: casing };
    });
    casings.current = made;

    return () => {
      for (const one of made) one.line.remove();
      casings.current = [];
    };
  }, [base, view]);

  /* Толщина держится в пикселях экрана, а не в метрах: и кайма соседнего
     слоя, и сама линия должны читаться одинаково и на обзоре области, и во
     дворе. Геометрия при этом не трогается — все едут по оси своей дороги на
     любом масштабе. */
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const thick = weightAt(instance.getZoom());
    for (const item of stack.current) {
      item.line.setStyle({ weight: bandWeight(thick, live === item.id) });
    }
    for (const one of casings.current) one.line.setStyle({ weight: thick + 2.4 });
  }, [zoom, live]);

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

  /* Щелчок по списку справа: подлетаем к маршруту целиком. Рамку берём у
     ловушки курсора: она одна на весь путь, а рисованные куски — по слоям. */
  useEffect(() => {
    const instance = map.current;
    if (!instance || !live || focus === 0) return;
    const grip = grips.current.get(live);
    if (grip && instance.getSize().y > 0) {
      /* Без анимации — как и всё остальное в этой карте. Анимированный
         подлёт Leaflet отменяет сам, стоит странице перерисоваться в тот же
         миг, а она перерисовывается: щелчок по маршруту меняет и выбранный
         путь, и список справа. Поэтому щелчок по строке молча не делал
         ничего — карта оставалась там же, где была. */
      instance.fitBounds(grip.getBounds(), { padding: [40, 40], animate: false });
    }
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
    show(freeLayer.current, pinsOn);

    /* Вернули слой на карту — заново раскладываем куски по толщине. Снятый
       слой рисует свои линии в том порядке, в каком их добавляли, а порядок
       отрисовки у нас и есть порядок слоёв: без этого после выключения и
       включения маршрутов широкие куски ложились поверх узких и на общей
       дороге пропадал верхний цвет. */
    if (routesOn) layerOrder(live);
  }, [routesOn, pinsOn]);

  /* Границы масштаба берём у самой карты, а не зашиваем: подложка задаёт
     их своими maxZoom/minZoom, и продублированное число однажды разойдётся
     с настоящим. */
  /* Границы масштаба. Раньше упирались в ступени подложки — девятую и
     шестнадцатую, — но упираться в них незачем: ниже седьмой видно область
     целиком, выше шестнадцатой Leaflet растягивает последнюю плитку, и во
     дворе становится видно дом, а не квартал. */
  const ZOOM_MIN = 7;
  const ZOOM_MAX = 19;

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

  /* Пришли ли ломаные по улицам. У настоящего перегона точек много; отрезок
     ровно из двух — это запасная ветка сборщика пути, когда дорожной сети не
     нашлось. Считаем по всем маршрутам сразу: один перегон в том же доме
     ничего не значит, а вот когда длиннее двух точек нет нигде — дорог нет. */
  const flat = useMemo(() => {
    let routed = 0;
    let curved = 0;
    for (const load of view.loads) {
      for (const stop of load.route?.stops ?? []) {
        routed += 1;
        if ((stop.geometry?.length ?? 0) > 2) curved += 1;
      }
    }
    return routed > 0 && curved === 0;
  }, [view]);

  const km = spanKm(zoom);
  /* До десяти километров дробь имеет смысл, дальше — нет: «23,7 км» на
     обзоре в пол-области это точность, которой там неоткуда взяться. */
  const kmLabel = km < 10 ? `${km.toFixed(1).replace('.', ',')} км` : `${Math.round(km)} км`;

  return (
    <div className={'geo' + (fill ? ' geo--fill' : '') + (aside ? ' geo--aside' : '')}>
      <div
        className={
          'geo__plot' +
          (pinnedLoad ? ' geo__plot--locked' : '') +
          (full ? ' geo__plot--full' : '') +
          /* Светлая подложка меняет не только картинку под линиями: от неё
             зависит, чем закрашены прорехи между плитками и каким цветом
             идёт сноска об источнике. */
          (BASEMAPS.find((one) => one.key === base)?.night === false ? ' geo__plot--day' : '')
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
        <div className="geo__side">
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
            <Icon name={full ? 'arrows-in' : 'arrows-out'} size={16} />
          </button>
        </div>

        {/* Пульт карты — под кластером масштаба, слева.

            Раньше слои переключались полосой во всю ширину под картой, а
            рядом с ними лежала легенда «что есть что». Легенда ушла совсем:
            она объясняла цвета, которые и так подписаны на самих подсказках,
            а места занимала больше, чем объясняла. Тумблеры переехали к
            масштабу: и то и другое — про то, как смотреть на карту, и стоять
            им врозь незачем.

            Вид подложки — здесь же, тремя кнопками. Тёмная отвечает на «где
            идут маршруты», обычная — на «что это за место», спутник — на
            «что там на самом деле». */}
        <div className="geo__deck">
          <div className="geo__deck-group" role="group" aria-label="Что показывать на карте">
            <button
              type="button"
              className={'geo__view' + (routesOn ? ' geo__view--on' : '')}
              onClick={() => setRoutesOn((v) => !v)}
              aria-pressed={routesOn}
              aria-label="Маршруты на карте"
              title={routesOn ? 'Убрать маршруты' : 'Показать маршруты'}
            >
              <Icon name="route" size={15} />
            </button>
            <button
              type="button"
              className={'geo__view' + (pinsOn ? ' geo__view--on' : '')}
              onClick={() => setPinsOn((v) => !v)}
              aria-pressed={pinsOn}
              aria-label="Точки заявок и выезда"
              title={pinsOn ? 'Убрать точки' : 'Показать точки'}
            >
              <Icon name="map-pin" size={15} />
            </button>
          </div>

          <div className="geo__views" role="group" aria-label="Вид карты">
            {BASEMAPS.map((one) => (
              <button
                key={one.key}
                type="button"
                className={'geo__view' + (one.key === base ? ' geo__view--on' : '')}
                onClick={() => setBase(one.key)}
                aria-pressed={one.key === base}
                aria-label={`Подложка: ${one.label}`}
                title={`Подложка: ${one.label}`}
              >
                <Icon name={one.icon} size={15} />
              </button>
            ))}
          </div>

          {/* Молчать об этом нельзя. Когда ломаных по улицам нет, перегоны
              рисуются отрезками — через кварталы и реку наискось, — и на
              экране это читается не как «нет данных о дорогах», а как «карта
              врёт про маршруты». Строка появляется только в этом случае. */}
          {flat && (
            <span
              className="geo__flat"
              title="Ломаных по улицам для этого набора нет: перегоны показаны прямыми, и длина пути на них не похожа на настоящую. Для встроенных зон дороги лежат файлом рядом с заявками; для набора, загруженного со стороны, их взять неоткуда."
            >
              <Icon name="alert-triangle" size={12} />
              Дороги неизвестны
            </span>
          )}
        </div>
        </div>

        {/* Источник подложки — мелкой строкой в углу самой карты, без белой
            плашки: указание обязательно, но это сноска, а не орган
            управления. */}
        <span className="geo__credit">
          {BASEMAPS.find((one) => one.key === base)?.credit}
        </span>

        {/* Выход из полноэкранной карты — там, где его ищут: крестиком в
            правом верхнем углу. Кнопка сворачивания в кластере масштаба
            слева остаётся, но найти её, не зная о ней, нельзя: значок в
            углу среди органов управления масштабом читается как ещё один
            масштаб, а не как «закрыть». */}
        {full && (
          <button
            type="button"
            className="geo__close"
            onClick={() => setFull(false)}
            title="Свернуть карту · Esc"
            aria-label="Свернуть карту"
          >
            <Icon name="x" size={16} />
          </button>
        )}

        {/* Пока маршрут выбран, карта не отвлекает: остальные пути и точки
            не нажимаются, а сверху висит короткая справка о выбранном.

            Там, где экран держит свою колонку (обзор с итогами расчёта),
            справку рисует она — и карточка молчит: одна и та же фамилия в
            двух углах экрана читается как сбой, а не как подсказка. */}
        {pinnedLoad && !aside && (
          <div className="geo__card">
            <div className="geo__card-top">
              <span
                className="geo__card-mark"
                style={{ background: colorOf(pinnedLoad.engineer.id) }}
              />
              {/* Фамилия оранжевым — тем же цветом, что и в базе инженеров:
                  человека называют фамилией, и на карте она должна читаться
                  так же, как в справочнике. */}
              <button
                type="button"
                className="geo__card-name"
                onClick={() => onSelectEngineer(pinnedLoad.engineer.id)}
              >
                <PersonName name={pinnedLoad.engineer.name} stacked={false} />
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
              {/* Средство передвижения первым: от него зависит и скорость
                  перегона, и то, возьмётся ли инженер за дальнюю заявку, —
                  а спрашивают о нём, уже глядя на выбранный путь. */}
              <span className="geo__card-ride">
                <Icon name={transportIcon(pinnedLoad.engineer.transport ?? '')} size={13} />
                {rideOf(pinnedLoad.engineer.transport)}
              </span>
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

        {/* Числа расчёта поверх правого края. Ставит их сюда экран обзора, а
            не карта: карта отвечает за то, где они лежат и что при этом
            уступает им место, но не за то, что в них написано. */}
        {aside && <div className="geo__aside">{aside}</div>}
      </div>

    </div>
  );
}
