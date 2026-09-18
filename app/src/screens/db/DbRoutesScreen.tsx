import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { Registry, RouteRecord } from '../../data/registry.ts';
import type { RunId } from '../../data/load.ts';
import { dec, hhmm, hoursText, plural, visits as pluralVisits } from '../../data/derive.ts';
import { RouteCard } from '../../app/RouteCard.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { service } from '../../data/service.ts';
import { DbHead } from './DbHead.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Открыть маршрут на большой карте его расчёта и закрепить там. Своего
      экрана у маршрута нет, и место, где его смотрят целиком, — карта дня. */
  onOpenRoute: (runId: RunId, engineerId: string) => void;
}

/* Сколько карточек отдаём в разметку за раз. Маршрутов в архиве из двух
   десятков расчётов под три сотни, и у каждой карточки своя карта: подложка
   тянется картинками, линия — своим `<svg>`. Триста таких плиток браузер
   собирает целиком и потом на них же спотыкается при прокрутке. */
const PAGE = 60;

/* Плотность ряда — та же настройка, что в базах расчётов и инженеров:
   «разглядеть» или «охватить». По две и по четыре карточка живёт целиком: с
   картой, цифрами и номерами заявок. По шесть она сжимается до строки справочника —
   чей маршрут, сколько визитов и сколько наездили; карту в такой ширине всё
   равно не разобрать, и её там нет. */
const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* По чему упорядочены маршруты. Первым — номер: он сквозной на всю базу, и
   по нему маршрут находят, когда пришли с ним на руках.

   Правил восемь, и рядом переключателей они заняли бы две строки полосы,
   хотя действует всегда одно. Поэтому здесь тот же список под кнопкой, что
   и в базе заявок: на полосе стоит то, что и вправду действует, — правило и
   сторона, — а выбор раскрывается по нажатию. Стороны названы по-своему у
   каждого правила: «сначала с переработкой» диспетчер понимает сразу, а
   «по убыванию» ему пришлось бы переводить на маршруты. */
type Sort = 'number' | 'visits' | 'occupancy' | 'travel' | 'idle' | 'overtime' | 'risky' | 'run';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'number',
    label: 'По номеру',
    note: 'В порядке, в котором их завёл движок',
    desc: false,
    up: 'От первого к последнему',
    down: 'От последнего к первому'
  },
  {
    value: 'visits',
    label: 'По визитам',
    note: 'Сколько адресов в смене',
    desc: true,
    up: 'Сначала короткие маршруты',
    down: 'Сначала длинные маршруты'
  },
  {
    value: 'occupancy',
    label: 'По занятости',
    note: 'Насколько плотно набита смена',
    desc: true,
    up: 'Сначала пустые смены',
    down: 'Сначала плотные смены'
  },
  {
    value: 'travel',
    label: 'По дороге',
    note: 'Сколько наездили между адресами',
    desc: true,
    up: 'Сначала ближние',
    down: 'Сначала дальние'
  },
  {
    value: 'idle',
    label: 'По простою',
    note: 'Сколько ждали открытия окна',
    desc: true,
    up: 'Сначала без простоя',
    down: 'Сначала с простоем'
  },
  {
    value: 'overtime',
    label: 'По переработке',
    note: 'Кто вылез за границу смены',
    desc: true,
    up: 'Сначала без переработки',
    down: 'Сначала с переработкой'
  },
  {
    value: 'risky',
    label: 'По риску',
    note: 'Где инженер не успевает к сроку',
    desc: true,
    up: 'Сначала спокойные',
    down: 'Сначала рискованные'
  },
  {
    value: 'run',
    label: 'По расчёту',
    note: 'Маршруты одного расчёта подряд',
    desc: false,
    up: 'От первого расчёта к последнему',
    down: 'От последнего расчёта к первому'
  }
];

/* Отбор по тому, как маршрут сложился: не вылез ли он за смену, успевает ли
   инженер и не гоняем ли мы человека вполпустого. Это те вопросы, ради
   которых в базу маршрутов и заглядывают. */
type Filter = 'all' | 'overtime' | 'risky' | 'busy' | 'loose' | 'idle';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'overtime', label: 'С переработкой' },
  { value: 'risky', label: 'С риском' },
  { value: 'busy', label: 'Занятость выше 75 %' },
  { value: 'loose', label: 'Занятость ниже 60 %' },
  { value: 'idle', label: 'С простоем' }
];

/* База маршрутов: каждый маршрут каждого прогона отдельной записью. Раздел
   отвечает на «как мы вообще ездим», поэтому запись всегда подписана номером
   расчёта — без него маршруты разных прогонов слиплись бы в один.

   Устроена как базы расчётов и инженеров — доска виджетов со сроком сверху,
   полоса отбора, карточки или таблица, — и это осознанное повторение:
   справочники об одном хозяйстве, и переучивать диспетчера на четвёртом
   незачем. */
export function DbRoutesScreen({ registry, mode, onOpenRoute }: Props) {
  const [perRow, setPerRow] = useState(() => service().perRow as string);
  const [sort, setSort] = useState<Sort>('number');
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [run, setRun] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const dense = perRow === '6';

  const all = registry.routes;

  /* Маршруты, разложенные по расчётам. Нужны карте в карточке: линия соседей
     по расчёту рисуется под своей, а карточка видит одну запись и о соседях
     не знает. Считаем один раз на весь список: реестр общий, и триста
     карточек просеивали бы его триста раз. */
  const byRunId = useMemo(() => {
    const map = new Map<string, RouteRecord[]>();
    for (const route of all) {
      const list = map.get(route.run.id);
      if (list) list.push(route);
      else map.set(route.run.id, [route]);
    }
    for (const list of map.values()) list.sort((a, b) => a.number - b.number);
    return map;
  }, [all]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = all.filter((route) => {
      if (run && route.run.id !== run) return false;
      if (filter === 'overtime' && route.overtimeMinutes === 0) return false;
      if (filter === 'risky' && route.risky === 0) return false;
      if (filter === 'busy' && route.occupancy < 0.75) return false;
      if (filter === 'loose' && route.occupancy >= 0.6) return false;
      if (filter === 'idle' && route.idleMinutes === 0) return false;
      if (!needle) return true;
      /* Ищем и по району словом, и по номеру заявки: район набирают чаще,
         чем высматривают его в колонке, а номер заявки — то, с чем в базу
         приходят с чужого экрана: «в каком маршруте ехала R0052». */
      return (
        route.code.toLowerCase().includes(needle) ||
        route.run.code.toLowerCase().includes(needle) ||
        route.engineerName.toLowerCase().includes(needle) ||
        route.engineerId.toLowerCase().includes(needle) ||
        route.districts.some((district) => district.toLowerCase().includes(needle)) ||
        route.orderIds.some((id) => id.toLowerCase().includes(needle))
      );
    });

    const rank = (route: RouteRecord) => {
      switch (sort) {
        case 'visits':
          return route.visits;
        case 'occupancy':
          return route.occupancy;
        case 'travel':
          return route.travelMinutes;
        case 'idle':
          return route.idleMinutes;
        case 'overtime':
          return route.overtimeMinutes;
        case 'risky':
          return route.risky;
        case 'run':
          return 0;
        default:
          return route.number;
      }
    };
    /* Сторона переворачивается целиком, вместе с разрешением ничьих: иначе
       маршруты с одинаковой занятостью стояли бы в одном и том же порядке
       при обеих сторонах, и переворот выглядел бы неполным. */
    const side = desc ? -1 : 1;
    const tie = (a: RouteRecord, b: RouteRecord) =>
      sort === 'run'
        ? a.run.code.localeCompare(b.run.code) || a.number - b.number
        : a.number - b.number;

    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : tie(a, b));
    });
  }, [all, desc, filter, query, run, sort]);

  /* Смена правила заодно ставит сторону, с которой его читают чаще: у номера
     это начало истории, у переработки — те, кто вылез за смену. */
  const pickSort = (value: Sort) => {
    if (value === sort) return;
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? false);
    setLimit(PAGE);
  };

  /* Сменили отбор или порядок — счётчик показанного начинается заново: иначе
     после сужения выборки кнопка обещала бы карточки, которых уже нет. */
  const narrow = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setLimit(PAGE);
  };

  /* Срок, за который считает доска. Отдельно от отбора списка: список
     отвечает на «какие маршруты показать», доска — на «за какой срок
     считать». Общим переключателем поиск по инженеру менял бы диаграммы, а
     смена срока — прятала бы маршруты, которые никуда не делись. */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const runsIn = (key: PeriodKey) => registry.runs.filter((ref) => withinPeriod(ref.created, key));

  /* Срез: маршруты расчётов, попавших в срок, и сами эти расчёты — ряд для
     линии собирается по ним, а не по всей истории. */
  const scope = useMemo(() => {
    const runs = [...registry.runs]
      .filter((ref) => withinPeriod(ref.created, period))
      .sort((a, b) => a.created.localeCompare(b.created));
    const ids = new Set(runs.map((ref) => ref.id));
    return { runs, routes: all.filter((route) => ids.has(route.run.id)) };
  }, [all, registry, period]);

  /* Величины базы для доски виджетов. Каждая отдаёт итог, доли этого итога и
     ряд по расчётам — какой из них показать, решает сама плитка. Ряд всегда
     хронологический: линия отвечает на «как менялось», и сортировка списка на
     неё не влияет. */
  const widgets = useMemo<WidgetDef[]>(() => {
    const routes = scope.routes;
    const runs = scope.runs;

    const visits = routes.reduce((sum, route) => sum + route.visits, 0);
    const travel = routes.reduce((sum, route) => sum + route.travelMinutes, 0);
    const work = routes.reduce((sum, route) => sum + route.workMinutes, 0);
    const idle = routes.reduce((sum, route) => sum + route.idleMinutes, 0);
    const overtime = routes.reduce((sum, route) => sum + route.overtimeMinutes, 0);
    const risky = routes.reduce((sum, route) => sum + route.risky, 0);
    const occupancy =
      routes.reduce((sum, route) => sum + route.occupancy, 0) / Math.max(routes.length, 1);
    const crewed = new Set(routes.map((route) => route.engineerId)).size;
    /* Время в маршруте — одно целое на всю доску: работа на объектах, дорога
       между ними и ожидание открытия окна. Две плитки говорят «от времени в
       маршруте», и считать это от разных целых нельзя — доли перестали бы
       складываться. */
    const inRoute = Math.max(work + travel + idle, 1);

    const perRun = (value: number) => value / Math.max(runs.length, 1);
    const top = <T,>(list: T[], size = 4) => list.slice(0, size);

    /* Ряд по прогонам: маршруты разложены по расчётам, чтобы «сколько всего»
       и «как менялось» считались из одного места. */
    const cells = new Map<string, { routes: number; visits: number; travel: number; overtime: number }>();
    for (const route of routes) {
      const cell = cells.get(route.run.id) ?? { routes: 0, visits: 0, travel: 0, overtime: 0 };
      cell.routes += 1;
      cell.visits += route.visits;
      cell.travel += route.travelMinutes;
      cell.overtime += route.overtimeMinutes;
      cells.set(route.run.id, cell);
    }
    const series = (pick: (cell: { routes: number; visits: number; travel: number; overtime: number }) => number) =>
      runs.map((ref) => ({
        label: ref.code,
        value: pick(cells.get(ref.id) ?? { routes: 0, visits: 0, travel: 0, overtime: 0 })
      }));

    const byVisits = top([...routes].sort((a, b) => b.visits - a.visits));
    /* Сколько таких маршрутов всего — считаем до обрезки списка: в плитке
       стоят четыре строки, а подстрочник отвечает на «сколько их»,
       и число по обрезанному списку всегда говорило бы «четыре». */
    const overtimeRoutes = routes.filter((one) => one.overtimeMinutes > 0);
    const riskyRoutes = routes.filter((one) => one.risky > 0);
    const byOvertime = top(
      [...overtimeRoutes].sort((a, b) => b.overtimeMinutes - a.overtimeMinutes)
    );
    const byRisky = top([...riskyRoutes].sort((a, b) => b.risky - a.risky));
    const byLoose = top([...routes].filter((one) => one.occupancy > 0).sort((a, b) => a.occupancy - b.occupancy));

    /* Районы считаем по маршрутам, а не по заявкам: вопрос здесь другой —
       «куда мы ездим», а не «откуда к нам приходят». Маршрут, прошедший три
       района, попадает в три строки, и в целое они не складываются: кольца
       у этой величины нет. */
    const districts = new Map<string, number>();
    for (const route of routes) {
      for (const district of route.districts) {
        districts.set(district, (districts.get(district) ?? 0) + 1);
      }
    }
    const byDistrict = top([...districts.entries()].sort((a, b) => b[1] - a[1]), 6);

    /* Занятость раскладываем на три ступени: «сколько в среднем» отвечает на
       вопрос наполовину — маршрут под завязку и маршрут вполпустого дают ту
       же среднюю, что два ровных. */
    const tiers = [
      { key: 'tight', label: 'Выше 75 %', tone: 'bad' as const, has: (o: number) => o >= 0.75 },
      { key: 'even', label: '60–75 %', tone: 'ok' as const, has: (o: number) => o >= 0.6 && o < 0.75 },
      { key: 'loose', label: 'Ниже 60 %', tone: 'warn' as const, has: (o: number) => o < 0.6 }
    ];

    return [
      {
        key: 'routes-count',
        title: 'Маршрутов',
        note: 'Сколько маршрутов движок построил и сколько выходит на расчёт',
        shape: 'number',
        data: {
          value: String(routes.length),
          caption: 'построено',
          facts: [
            `${dec(perRun(routes.length))} на расчёт`,
            `${crewed} инженеров с маршрутом`
          ],
          series: series((cell) => cell.routes),
          legend: 'маршрутов'
        }
      },
      {
        key: 'visits',
        title: 'Визитов',
        note: 'Сколько адресов объехали и как это менялось',
        shape: 'number',
        data: {
          value: String(visits),
          caption: 'расставлено по маршрутам',
          facts: [
            `${dec(visits / Math.max(routes.length, 1))} на маршрут`,
            `${Math.round(perRun(visits))} на расчёт`
          ],
          series: series((cell) => cell.visits),
          legend: 'визитов'
        }
      },
      {
        key: 'travel',
        title: 'В дороге',
        note: 'Сколько наездили и какая доля смены ушла на переезды',
        shape: 'number',
        data: {
          value: dec(travel / 60),
          unit: 'ч',
          caption: 'по всем маршрутам',
          facts: [
            `${dec(travel / 60 / Math.max(routes.length, 1))} ч на маршрут`,
            `${percent(travel / inRoute)} от времени в маршруте`
          ],
          /* Время в маршруте — это все три его части, а не работа с дорогой:
             ожидание открытия окна инженер тоже проводит в смене, и доля
             дороги, посчитанная без него, вышла бы завышенной. Кольцо здесь
             из трёх секторов ровно поэтому. */
          whole: true,
          parts: [
            { key: 'work', label: 'На объектах', value: Math.round(work), tone: 'ok' },
            { key: 'travel', label: 'В дороге', value: Math.round(travel), tone: 'warn' },
            { key: 'idle', label: 'Ожидание', value: Math.round(idle), tone: 'bad' }
          ],
          series: series((cell) => Math.round(cell.travel / 6) / 10),
          legend: 'минут в маршруте'
        }
      },
      {
        key: 'work',
        title: 'В работе',
        note: 'Сколько часов инженеры провели на объектах',
        shape: 'number',
        data: {
          value: dec(work / 60),
          unit: 'ч',
          caption: 'на объектах',
          facts: [`${dec(work / 60 / Math.max(routes.length, 1))} ч на маршрут`],
          legend: 'часов работы'
        }
      },
      {
        key: 'occupancy',
        title: 'Средняя занятость',
        note: 'Насколько плотно набиты маршруты и сколько из них под завязку',
        shape: 'number',
        data: {
          value: String(Math.round(occupancy * 100)),
          unit: '%',
          caption: 'рабочего времени в маршруте',
          tone: occupancy >= 0.75 ? 'bad' : 'neutral',
          facts: [`по ${routes.length} маршрутам`],
          whole: true,
          parts: tiers.map((tier) => ({
            key: tier.key,
            label: tier.label,
            value: routes.filter((route) => tier.has(route.occupancy)).length,
            tone: tier.tone
          })),
          legend: 'маршрутов в полосе занятости'
        }
      },
      {
        key: 'overtime',
        title: 'Сверх смены',
        note: 'Сколько наработали за границей смены и на каких маршрутах',
        shape: 'number',
        data: {
          value: dec(overtime / 60),
          unit: 'ч',
          caption: 'сверх графика',
          tone: overtime > 0 ? 'bad' : 'ok',
          facts: [`${plural(overtimeRoutes.length, 'маршрут', 'маршрута', 'маршрутов')} с переработкой`],
          parts: byOvertime.map((route) => ({
            key: route.key,
            label: `${route.code} · ${route.engineerName.split(' ')[0]}`,
            value: route.overtimeMinutes,
            text: `${route.overtimeMinutes} мин`,
            tone: 'bad' as const
          })),
          /* Ряд — в тех же часах, что и итог плитки: наведение на столбец
             подставляет его величину на место итога, вместе с единицей «ч»,
             и минуты вместо часов читались бы как рост в шестьдесят раз. */
          series: series((cell) => Math.round(cell.overtime / 6) / 10),
          legend: overtimeRoutes.length > 0 ? 'минут сверх смены' : 'переработки нет'
        }
      },
      {
        key: 'idle',
        title: 'Простой',
        note: 'Сколько прождали открытия окна: приехали, а принимать ещё некому',
        shape: 'number',
        data: {
          value: dec(idle / 60),
          unit: 'ч',
          caption: 'ожидания в маршрутах',
          tone: idle > 0 ? 'warn' : 'ok',
          facts: [`${percent(idle / inRoute)} от времени в маршруте`],
          legend: 'часов простоя'
        }
      },
      {
        key: 'risky',
        title: 'Рискованные остановки',
        note: 'Визиты, к которым инженер по плану не успевает',
        shape: 'number',
        data: {
          value: String(risky),
          caption: 'остановок с высоким риском',
          tone: risky > 0 ? 'bad' : 'ok',
          facts: [`на ${plural(riskyRoutes.length, 'маршруте', 'маршрутах', 'маршрутах')}`],
          parts: byRisky.map((route) => ({
            key: route.key,
            label: `${route.code} · ${route.engineerName.split(' ')[0]}`,
            value: route.risky,
            tone: 'bad' as const
          })),
          legend: riskyRoutes.length > 0 ? 'рискованных остановок' : 'таких остановок нет'
        }
      },
      {
        key: 'longest',
        title: 'Самые длинные маршруты',
        note: 'Кто везёт смену — маршруты с самым длинным объездом',
        shape: 'bars',
        data: {
          value: String(byVisits[0]?.visits ?? 0),
          caption: 'визитов у самого длинного',
          tone: 'ok',
          parts: byVisits.map((route) => ({
            key: route.key,
            label: `${route.code} · ${route.engineerName.split(' ')[0]}`,
            value: route.visits,
            tone: 'ok' as const
          })),
          legend: 'визитов в маршруте'
        }
      },
      {
        key: 'loosest',
        title: 'Самые пустые маршруты',
        note: 'Где смена набита слабее всего — там есть запас',
        shape: 'bars',
        data: {
          value: percent(byLoose[0]?.occupancy ?? 0),
          caption: 'у самого пустого',
          tone: 'warn',
          parts: byLoose.map((route) => ({
            key: route.key,
            label: `${route.code} · ${route.engineerName.split(' ')[0]}`,
            value: Math.round(route.occupancy * 1000) / 10,
            text: percent(route.occupancy),
            tone: 'warn' as const
          })),
          legend: 'занятость, %'
        }
      },
      {
        key: 'districts',
        title: 'Районы в маршрутах',
        note: 'Куда мы ездим: в скольких маршрутах встречается район. Кольца нет: маршрут, прошедший три района, попадает в три строки, и в целое они не складываются',
        shape: 'bars',
        data: {
          value: String(districts.size),
          caption: 'районов в маршрутах',
          parts: byDistrict.map(([key, count]) => ({ key, label: key, value: count })),
          legend: 'маршрутов через район'
        }
      },
      {
        key: 'crew',
        title: 'Инженеры с маршрутом',
        note: 'Кому движок дал работу, а кто ни разу не выехал',
        shape: 'donut',
        data: {
          value: String(registry.engineers.length),
          caption: 'инженеров',
          whole: true,
          parts: [
            { key: 'crewed', label: 'Получали маршрут', value: crewed, tone: 'ok' },
            {
              key: 'idle',
              label: 'Ни разу',
              value: Math.max(0, registry.engineers.length - crewed),
              tone: 'warn'
            }
          ],
          facts: [`${crewed} выезжали за срок`],
          legend: 'инженеров'
        }
      }
    ];
  }, [scope, registry]);

  const board = useWidgetBoard({
    storeKey: 'db-routes',
    catalogue: widgets,
    fallback: ['routes-count', 'visits', 'travel', 'occupancy', 'overtime'],
    filter: (
      <WidgetPeriod value={period} onChange={setPeriod} countOf={(key) => runsIn(key).length} />
    )
  });

  /* Разбивка по расчётам для вкладки «По расчётам»: там расчёт — заголовок
     секции, и сводка под ним отвечает на «каким вышел этот день целиком».

     Раскладывается та же выборка, что и в двух других видах, а не весь
     реестр: полоса отбора стоит в шапке базы и над этим видом тоже, и
     список, который её не слушается, читался бы как поломка. Расчёт, из
     которого под отбор не подошло ничего, секцией не рисуется — пустой
     заголовок с нулём обещал бы, что там что-то есть. */
  const byRun = useMemo(() => {
    const picked = new Map<string, RouteRecord[]>();
    for (const route of rows) {
      const list = picked.get(route.run.id);
      if (list) list.push(route);
      else picked.set(route.run.id, [route]);
    }
    return registry.runs
      .filter((ref) => picked.has(ref.id))
      .map((ref) => {
        /* Внутри секции порядок тот, что выбран в полосе: заново
           упорядочивать по номеру значило бы, что переключатель сортировки
           в этом виде стоит и ничего не делает. */
        const list = picked.get(ref.id) ?? [];
        return {
          ref,
          routes: list,
          visits: list.reduce((sum, r) => sum + r.visits, 0),
          travel: list.reduce((sum, r) => sum + r.travelMinutes, 0),
          risky: list.reduce((sum, r) => sum + r.risky, 0),
          occupancy: list.reduce((sum, r) => sum + r.occupancy, 0) / (list.length || 1)
        };
      });
  }, [registry, rows]);

  /* В разбивке по расчётам номер расчёта уже стоит в заголовке секции, и
     колонка с ним повторяла бы его в каждой строке. Собственный номер
     маршрута остаётся везде: он и есть то, чем маршрут называют. */
  const table = (list: RouteRecord[], withRun = true) => (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Маршрут</th>
            {withRun && <th>Расчёт</th>}
            <th>Инженер</th>
            <th>Визитов</th>
            <th>Окно маршрута</th>
            <th>В дороге</th>
            <th>В работе</th>
            <th>Простой</th>
            <th>Занятость</th>
            <th>Переработка</th>
            <th>Риск</th>
            <th>Районы</th>
          </tr>
        </thead>
        <tbody>
          {list.map((route) => (
            <tr
              key={route.key}
              className="tbl__row tbl__row--open"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button, textarea')) return;
                onOpenRoute(route.run.id, route.engineerId);
              }}
            >
              <td>
                <span className="tbl__strong">{route.code}</span>
              </td>
              {withRun && (
                <td>
                  <span className="tbl__strong">{route.run.code}</span>
                  <span className="tbl__sub">{route.run.date}</span>
                </td>
              )}
              <td>
                <span className="tbl__strong">{route.engineerName}</span>
                <span className="tbl__sub">{route.engineerId}</span>
              </td>
              <td className="tbl__num">{route.visits}</td>
              <td className="tbl__num">
                {hhmm(route.start)}–{hhmm(route.end)}
              </td>
              <td className="tbl__num">{hoursText(route.travelMinutes)}</td>
              <td className="tbl__num">{hoursText(route.workMinutes)}</td>
              <td className="tbl__num">{hoursText(route.idleMinutes)}</td>
              <td>
                <span className={'pill pill--' + (route.occupancy < 0.6 ? 'idle' : 'success')}>
                  {percent(route.occupancy)}
                </span>
              </td>
              <td className={route.overtimeMinutes > 0 ? 'tbl__num tbl__warn' : 'tbl__num'}>
                {route.overtimeMinutes > 0 ? `${route.overtimeMinutes} мин` : '—'}
              </td>
              <td className="tbl__num">
                {route.risky > 0 ? (
                  <span className="pill pill--danger">{route.risky}</span>
                ) : (
                  <span className="tbl__muted">—</span>
                )}
              </td>
              <td>
                <span className="tbl__sub">{route.districts.join(', ')}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;

  return (
    <div className="dash enter">
      {/* Полоса управления выборкой стоит в шапке базы, под её заголовком, и
          разложена столбиком «подпись — орган» — так же, как в базах расчётов,
          заявок и инженеров. Порядок по смыслу: сперва всё, что сужает выборку,
          потом то, как её показать. Наверху — поиск и плотность: это не отбор,
          а то, с какой стороны на список смотрят. */}
      <DbHead title="База маршрутов" board={board.node}>
        <div className="filters filters--runs">
          <div className="filters__top">
            <label className="dbsearch">
              <Icon name="search" size={14} />
              <input
                className="dbsearch__input"
                value={query}
                placeholder="Номер маршрута или заявки, инженер, табельный, расчёт, район"
                onChange={(event) => {
                  setQuery(event.currentTarget.value);
                  setLimit(PAGE);
                }}
              />
              {query && (
                <button
                  type="button"
                  className="dbsearch__clear"
                  onClick={() => {
                    setQuery('');
                    setLimit(PAGE);
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </label>

            {/* Плотность строки — только у карточек: в таблице строка одна и в
                строке она одна. */}
            {mode === 'cards' && (
              <div className="filters__group filters__group--tight">
                <span className="filters__label">Карточек в строке</span>
                <SegmentedControl size="sm" items={DENSITY} value={perRow} onChange={setPerRow} />
              </div>
            )}
          </div>

          <div className="filters__group">
            <span className="filters__label">Отбор</span>
            <SegmentedControl
              size="sm"
              items={FILTERS}
              value={filter}
              onChange={narrow((value: string) => setFilter(value as Filter))}
            />
          </div>

          {registry.runs.length > 1 && (
            <div className="filters__group filters__group--wide">
              <span className="filters__label">Расчёт</span>
              <span className="filters__types">
                {registry.runs.map((ref) => (
                  <button
                    key={ref.id}
                    type="button"
                    className={'chip' + (run === ref.id ? ' chip--on' : '')}
                    onClick={() => {
                      setRun(run === ref.id ? null : ref.id);
                      setLimit(PAGE);
                    }}
                    aria-pressed={run === ref.id}
                  >
                    {ref.code}
                    {run === ref.id && <Icon name="x" size={12} />}
                  </button>
                ))}
              </span>
            </div>
          )}

          <div className="filters__group" role="group" aria-label="Сортировка">
            <span className="filters__label">Сортировка</span>
            <SortMenu
              rules={SORTS}
              value={sort}
              desc={desc}
              onPick={(value: string) => pickSort(value as Sort)}
              onOrder={narrow(setDesc)}
            />
          </div>
        </div>
      </DbHead>

      {rows.length === 0 ? (
        <section className="panel">
          <p className="clients__lede">
            Под этот отбор не подошёл ни один маршрут. Снимите отбор, сбросьте расчёт или очистите
            поиск.
          </p>
        </section>
      ) : mode === 'runs' ? (
        <>
          {byRun.map((entry) => (
            <section key={entry.ref.id} className="panel">
              <div className="dash__section-head">
                <h2 className="dash__section-title">
                  Расчёт {entry.ref.code}
                  <span className="dbrun__date">{entry.ref.date}</span>
                </h2>
                <span className="dbrun__facts">
                  {plural(entry.routes.length, 'маршрут', 'маршрута', 'маршрутов')} ·{' '}
                  {pluralVisits(entry.visits)} · {hoursText(entry.travel)} в дороге · занятость{' '}
                  {percent(entry.occupancy)}
                  {entry.risky > 0
                    ? ` · ${plural(entry.risky, 'рискованная остановка', 'рискованные остановки', 'рискованных остановок')}`
                    : ''}
                </span>
              </div>
              {table(entry.routes, false)}
            </section>
          ))}
        </>
      ) : mode === 'table' ? (
        <section className="panel">
          {table(shown)}

          {hidden > 0 && (
            <button type="button" className="tblmore" onClick={() => setLimit((n) => n + PAGE)}>
              Показать ещё {Math.min(PAGE, hidden)}
              <span className="tblmore__rest">осталось {hidden}</span>
            </button>
          )}
        </section>
      ) : (
        <>
          <div
            className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
            style={{ '--per-row': perRow } as React.CSSProperties}
          >
            {shown.map((route, index) => (
              <RouteCard
                key={route.key}
                row={route}
                seat={index + 1}
                /* Соседи по расчёту — тихой подложкой под своей линией: без
                   них «выделенный» маршрут не из чего выделять. */
                others={(byRunId.get(route.run.id) ?? [])
                  .filter((one) => one.key !== route.key)
                  .map((one) => one.path)}
                dense={dense}
                day={route.run.date}
                onOpen={() => onOpenRoute(route.run.id, route.engineerId)}
              />
            ))}
          </div>

          {hidden > 0 && (
            <button type="button" className="tblmore" onClick={() => setLimit((n) => n + PAGE)}>
              Показать ещё {Math.min(PAGE, hidden)}
              <span className="tblmore__rest">осталось {hidden}</span>
            </button>
          )}
        </>
      )}

      {mode !== 'runs' && (
        <p className="filters__note filters__note--under">
          {plural(rows.length, 'маршрут', 'маршрута', 'маршрутов')} в выборке
          {rows.length !== all.length && ` из ${all.length}`}
          {rows.length > 0 &&
            ` · ${pluralVisits(rows.reduce((sum, one) => sum + one.visits, 0))} · ${hoursText(
              rows.reduce((sum, one) => sum + one.travelMinutes, 0)
            )} в дороге`}
        </p>
      )}
    </div>
  );
}
