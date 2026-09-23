import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { EngineerRecord, OrderRecord, Registry, RouteRecord } from '../../data/registry.ts';
import type { RunId } from '../../data/load.ts';
import { dec, hhmm, hoursText, plural, visits as pluralVisits } from '../../data/derive.ts';
import { RouteCard } from '../../app/RouteCard.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { OrderProfile } from '../../app/OrderProfile.tsx';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { DbHead, DENSITY, occupancyTiers, usePerRow, useShares } from './DbHead.tsx';
import { DbBar, ChipKey, DbEmpty, DbMore, usePaging } from './DbBar.tsx';
import type { DbChip } from './DbBar.tsx';
import { DbCrewProfile } from './DbCrew.tsx';
import { DbList } from './DbList.tsx';

/* День из ISO-даты выгрузки: «2026-08-17» → «17.08.2026». Тот же вид, что в
   базе расчётов: одна дата в двух базах не должна выглядеть по-разному. */
const dayOf = (date: string) => {
  const [year, month, day] = date.split('-');
  return day ? `${day}.${month}.${year}` : date;
};

interface Props {
  registry: Registry;
  mode: string;
  /** Открыть маршрут на большой карте его расчёта и закрепить там. Своего
      экрана у маршрута нет, и место, где его смотрят целиком, — карта дня. */
  onOpenRoute: (runId: RunId, engineerId: string) => void;
  /** Дороги из карточки заявки, открытой с карточки маршрута: в расчёт и на
      карту. Пока их не дали, обе ведут на карту расчёта с закреплённым
      маршрутом — туда же, куда ведёт сама карточка. */
  onOpenRun?: (runId: RunId) => void;
  onOpenMap?: (runId: RunId) => void;
  /** «Отследить» из профиля инженера, открытого с карточки маршрута. */
  onTrack?: (id: string) => string | void;
  /** Данные штата поправили в профиле — справочник надо собрать заново. */
  onChanged?: () => void;
}

/* Сколько карточек отдаём в разметку за раз. Маршрутов в архиве из двух
   десятков расчётов под три сотни, и у каждой карточки своя карта: подложка
   тянется картинками, линия — своим `<svg>`. Триста таких плиток браузер
   собирает целиком и потом на них же спотыкается при прокрутке. */
const PAGE = 60;

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* По чему упорядочены маршруты. Первым — номер: он сквозной на всю базу, и
   по нему маршрут находят, когда пришли с ним на руках.

   Правил восемь, и рядом переключателей они заняли бы две строки полосы,
   хотя действует всегда одно. Поэтому здесь список под кнопкой, как во всех
   базах: на полосе стоит то, что и вправду действует, — правило и сторона,
   — а выбор раскрывается по нажатию. Стороны названы по-своему у каждого
   правила: «сначала с переработкой» диспетчер понимает сразу, а «по
   убыванию» ему пришлось бы переводить на маршруты. */
type Sort = 'number' | 'visits' | 'occupancy' | 'travel' | 'idle' | 'overtime' | 'risky' | 'run';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'number',
    label: 'По номеру',
    note: 'В порядке, в котором их завёл расчёт',
    desc: false,
    up: 'От первого к последнему',
    down: 'От последнего к первому'
  },
  {
    value: 'visits',
    label: 'По заявкам',
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
   которых в базу маршрутов и заглядывают. Подписи порогов считаются от
   настроек сервиса, а не написаны руками. */
type Filter = 'all' | 'overtime' | 'risky' | 'busy' | 'loose' | 'idle';

const filtersFor = (busy: number, loose: number): { value: Filter; label: string }[] => [
  { value: 'all', label: 'Все' },
  { value: 'overtime', label: 'С переработкой' },
  { value: 'risky', label: 'С риском' },
  { value: 'busy', label: `Занятость выше ${Math.round(busy * 100)} %` },
  { value: 'loose', label: `Занятость ниже ${Math.round(loose * 100)} %` },
  { value: 'idle', label: 'С простоем' }
];

/* База маршрутов: каждый маршрут каждого прогона отдельной записью. Раздел
   отвечает на «как мы вообще ездим», поэтому запись всегда подписана номером
   расчёта — без него маршруты разных прогонов слиплись бы в один.

   Устроена как остальные базы — доска виджетов со сроком сверху, полоса
   отбора, список, карточки или таблица, — и это осознанное повторение:
   справочники об одном хозяйстве, и переучивать диспетчера на каждом
   незачем. */
export function DbRoutesScreen({
  registry,
  mode,
  onOpenRoute,
  onOpenRun,
  onOpenMap,
  onTrack,
  onChanged
}: Props) {
  const [perRow, setPerRow] = usePerRow();
  const [sort, setSort] = useState<Sort>('number');
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [run, setRun] = useState<string | null>(null);
  /* День, на который считали, — тот же, что стоит у расчёта. Не день, когда
     расчёт завели: маршрут принадлежит рабочему дню, а не минуте, в которую
     его посчитали, и оператор спрашивает «что у нас на сегодня», а не «что
     мы считали вчера вечером».

     Пусто — все дни. По умолчанию именно так: в нынешних данных разложен
     один день выгрузки, и открывать базу на «сегодня» значило бы встречать
     оператора пустым экраном. */
  const [day, setDay] = useState<string | null>(null);

  /* Сегодняшний день в том же виде, в каком дата стоит у расчёта: «2026-09-23».
     Считается от часов машины, поэтому живёт в useMemo — не пересчитывать же
     его на каждую отрисовку списка. */
  const today = useMemo(() => {
    const now = new Date();
    const два = (value: number) => String(value).padStart(2, '0');
    return `${now.getFullYear()}-${два(now.getMonth() + 1)}-${два(now.getDate())}`;
  }, []);

  const [query, setQuery] = useState('');
  const paging = usePaging(PAGE);
  const dense = perRow === '6';
  /* Пороги перегруза и недогруза — из настроек сервиса, одни на все базы. */
  const { busy, loose } = useShares();
  const FILTERS = filtersFor(busy, loose);

  /* Что открыто поверх базы с карточки маршрута: профиль инженера — по его
     имени, заявка — по чипу с её номером. Окно одно на всю базу: двух сразу
     не читают. Заявка помнит, с какого маршрута её открыли: дороги «в
     расчёт» и «на карту» без своих переходов ведут на карту этого
     маршрута. */
  const [opened, setOpened] = useState<EngineerRecord | null>(null);
  const [openedOrder, setOpenedOrder] = useState<{ order: OrderRecord; engineerId: string } | null>(
    null
  );

  const all = registry.routes;

  /* Дни, которые вообще есть в базе. Нужны двум местам: кнопке «Сегодня» —
     чтобы сказать, есть ли на сегодня хоть что-нибудь, — и пустому экрану,
     который иначе молчал бы о том, где маршруты всё-таки лежат. */
  const days = useMemo(() => {
    const set = new Set<string>();
    for (const route of all) if (route.run.date) set.add(route.run.date);
    return [...set].sort();
  }, [all]);

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
      if (day && route.run.date !== day) return false;
      if (filter === 'overtime' && route.overtimeMinutes === 0) return false;
      if (filter === 'risky' && route.risky === 0) return false;
      if (filter === 'busy' && route.occupancy < busy) return false;
      if (filter === 'loose' && route.occupancy >= loose) return false;
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
  }, [all, day, busy, desc, filter, loose, query, run, sort]);

  /* Сменили отбор или порядок — счётчик показанного начинается заново. */
  const narrow = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    paging.reset();
  };

  /* Снятие чипа значения не выбирает — оно возвращает отбор к «всем», и
     потому берёт действие целиком, а не значение. Счётчик показанного при
     этом начинается заново, как и при обычной смене отбора. */
  const clear = (run: () => void) => () => {
    run();
    paging.reset();
  };

  /* Смена правила заодно ставит сторону, с которой его читают чаще: у номера
     это начало истории, у переработки — те, кто вылез за смену. Повторное
     нажатие на выбранное правило переворачивает сторону — это делает само
     меню. */
  const pickSort = (value: Sort) => {
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? false);
    paging.reset();
  };

  const reset = () => {
    setFilter('all');
    setRun(null);
    setDay(null);
    setQuery('');
    paging.reset();
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
    const crewed = new Set(routes.map((route) => route.engineerKey)).size;
    /* Время в маршруте — одно целое на всю доску: работа на объектах, дорога
       между ними и ожидание открытия окна. Две плитки говорят «от времени в
       маршруте», и считать это от разных целых нельзя — доли перестали бы
       складываться. Той же базой считает и база инженеров. */
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
       же среднюю, что два ровных. Границы ступеней — пороги из настроек. */
    const tiers = occupancyTiers(busy, loose);

    return [
      {
        key: 'routes-count',
        title: 'Маршрутов',
        note: 'Сколько маршрутов построено и сколько выходит на расчёт',
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
        title: 'Заявок',
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
          legend: 'заявок'
        }
      },
      {
        key: 'travel',
        title: 'В дороге',
        note: 'Сколько наездили и какая доля смены ушла на переезды',
        shape: 'number',
        data: {
          /* Часы — через `hoursText`: формат часов выбран в настройках
             сервиса, и плитка обязана его слушать. */
          value: hoursText(travel),
          caption: 'по всем маршрутам',
          facts: [
            `${hoursText(travel / Math.max(routes.length, 1))} на маршрут`,
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
          value: hoursText(work),
          caption: 'на объектах',
          facts: [`${hoursText(work / Math.max(routes.length, 1))} на маршрут`],
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
          tone: occupancy >= busy ? 'bad' : 'neutral',
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
          value: hoursText(overtime),
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
          /* Ряд — в часах, как и итог плитки: наведение на столбец
             подставляет его величину на место итога, и минуты вместо часов
             читались бы как рост в шестьдесят раз. */
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
          value: hoursText(idle),
          caption: 'ожидания в маршрутах',
          tone: idle > 0 ? 'warn' : 'ok',
          facts: [`${percent(idle / inRoute)} от времени в маршруте`],
          legend: 'часов простоя'
        }
      },
      {
        key: 'risky',
        title: 'Рискованные остановки',
        note: 'Заявки, к которым инженер по плану не успевает',
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
          caption: 'заявок у самого длинного',
          tone: 'ok',
          parts: byVisits.map((route) => ({
            key: route.key,
            label: `${route.code} · ${route.engineerName.split(' ')[0]}`,
            value: route.visits,
            tone: 'ok' as const
          })),
          legend: 'заявок в маршруте'
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
        note: 'Кому расчёт дал работу, а кто ни разу не выехал',
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
  }, [scope, registry, busy, loose]);

  const board = useWidgetBoard({
    storeKey: 'db-routes',
    catalogue: widgets,
    fallback: ['routes-count', 'visits', 'travel', 'occupancy', 'overtime'],
    filter: (
      <WidgetPeriod value={period} onChange={setPeriod} countOf={(key) => runsIn(key).length} />
    )
  });

  /* Разбивка по расчётам для вида «По расчётам»: там расчёт — заголовок
     секции, и сводка под ним отвечает на «каким вышел этот день целиком».

     Раскладывается вся выборка, а не показанная её часть: итоги в заголовке
     секции — это итоги расчёта под этим отбором, и считать их по первой
     странице значило бы, что они растут от каждого «Показать ещё». Режется
     только отрисовка — см. `byRunShown`; правило то же, что и в базе
     заявок. Расчёт, из которого под отбор не подошло ничего, секцией не
     рисуется — пустой заголовок с нулём обещал бы, что там что-то есть. */
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

  /* Что из разбивки рисуем сейчас: секции идут подряд, первая страница —
     первые PAGE маршрутов по всем секциям вместе. */
  const byRunShown = useMemo(() => {
    let left = paging.limit;
    const out: (typeof byRun[number] & { shown: RouteRecord[] })[] = [];
    for (const entry of byRun) {
      if (left <= 0) break;
      const list = entry.routes.slice(0, left);
      left -= list.length;
      out.push({ ...entry, shown: list });
    }
    return out;
  }, [byRun, paging.limit]);

  /* Заявка по номеру — для перехода с чипа на карточке маршрута. */
  const orderOf = (route: RouteRecord, orderId: string) =>
    registry.orders.find((one) => one.id === orderId && one.run.id === route.run.id) ?? null;

  const engineerOf = (id: string) => registry.engineers.find((one) => one.id === id) ?? null;

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
            <th>Заявок</th>
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
              tabIndex={0}
              role="button"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('button, textarea')) return;
                onOpenRoute(route.run.id, route.engineerId);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onOpenRoute(route.run.id, route.engineerId);
                }
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
                <span className={'pill pill--' + (route.occupancy < loose ? 'idle' : 'success')}>
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

  const shown = rows.slice(0, paging.limit);
  const hidden = rows.length - shown.length;

  /* Активные отборы — чипами наверху. */
  const chips: DbChip[] = [];
  if (filter !== 'all') {
    chips.push({
      key: 'filter',
      label: FILTERS.find((item) => item.value === filter)?.label ?? filter,
      onRemove: clear(() => setFilter('all'))
    });
  }
  if (day) {
    chips.push({
      key: 'day',
      label: (
        <>
          <ChipKey>День</ChipKey>
          {dayOf(day)}
        </>
      ),
      onRemove: clear(() => setDay(null))
    });
  }
  if (run) {
    chips.push({
      key: 'run',
      label: (
        <>
          <ChipKey>Расчёт</ChipKey>
          {registry.runs.find((ref) => ref.id === run)?.code ?? run}
        </>
      ),
      onRemove: clear(() => setRun(null))
    });
  }

  /* Итог выборки — над списком, во всех видах: и в разбивке по расчётам
     тоже, там он отвечает на «сколько всего под этим отбором», чего
     заголовки секций по одному не скажут. */
  const summary = (
    <>
      <b>{plural(rows.length, 'маршрут', 'маршрута', 'маршрутов')}</b> в выборке
      {rows.length !== all.length && ` из ${all.length}`}
      {rows.length > 0 &&
        ` · ${pluralVisits(rows.reduce((sum, one) => sum + one.visits, 0))} · ${hoursText(
          rows.reduce((sum, one) => sum + one.travelMinutes, 0)
        )} в дороге`}
    </>
  );

  return (
    <div className="dash enter">
      <DbHead title="База маршрутов" board={board.node}>
        <DbBar
          query={query}
          onQuery={narrow(setQuery)}
          placeholder="Номер маршрута или заявки, инженер, табельный, расчёт, район"
          chips={chips}
          onReset={reset}
          sort={
            <SortMenu
              rules={SORTS}
              value={sort}
              desc={desc}
              onPick={(value: string) => pickSort(value as Sort)}
              onOrder={narrow(setDesc)}
            />
          }
          summary={summary}
        >
          <div className="filters filters--runs">
            <div className="filters__group">
              <span className="filters__label">Отбор</span>
              <SegmentedControl
                size="sm"
                items={FILTERS}
                value={filter}
                onChange={narrow((value: string) => setFilter(value as Filter))}
              />
            </div>

            {/* День — первым в полосе: «что у нас на сегодня» спрашивают
                чаще, чем «какие маршруты вышли перегруженными».

                Кнопка и календарь рядом, а не вместо друг друга: «сегодня»
                нажимают не глядя, а любой другой день выбирают в календаре,
                и заставлять искать сегодняшнее число в сетке — лишний шаг к
                тому, что делают чаще всего. */}
            <div className="filters__group">
              <span className="filters__label">День</span>
              <span className="filters__types">
                <button
                  type="button"
                  className={'chip' + (day === today ? ' chip--on' : '')}
                  onClick={narrow(() => setDay(day === today ? null : today))}
                  aria-pressed={day === today}
                  title={
                    days.includes(today)
                      ? 'Маршруты, посчитанные на сегодняшний день'
                      : 'На сегодня в базе маршрутов нет: разложены другие дни'
                  }
                >
                  Сегодня
                  {day === today && <Icon name="x" size={12} />}
                </button>
                <input
                  type="date"
                  className="filters__date"
                  value={day ?? ''}
                  onChange={(event) => narrow(setDay)(event.target.value || null)}
                  aria-label="День, за который показывать маршруты"
                />
                {day && (
                  <button
                    type="button"
                    className="chip"
                    onClick={narrow(() => setDay(null))}
                  >
                    Все дни
                  </button>
                )}
              </span>
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
                      onClick={narrow(() => setRun(run === ref.id ? null : ref.id))}
                      aria-pressed={run === ref.id}
                    >
                      {ref.code}
                      {run === ref.id && <Icon name="x" size={12} />}
                    </button>
                  ))}
                </span>
              </div>
            )}

            {/* Плотность ряда — только у карточек: в таблице и списке строка
                одна и в строке она одна. */}
            {mode === 'cards' && (
              <div className="filters__group">
                <span className="filters__label">Карточек в строке</span>
                <SegmentedControl size="sm" items={DENSITY} value={perRow} onChange={setPerRow} />
              </div>
            )}
          </div>
        </DbBar>
      </DbHead>

      {rows.length === 0 ? (
        <DbEmpty
          miss={
            day
              ? `За ${dayOf(day)} маршрутов нет.` +
                (days.length > 0
                  ? ` В базе разложены другие дни: ${days.map(dayOf).join(', ')}.`
                  : '')
              : 'Под этот отбор не подошёл ни один маршрут.'
          }
          blank="Маршрутов в базе пока нет: их строит программа расчёта, и до первого сохранённого расчёта база пуста."
          query={query.trim() !== ''}
          filtered={filter !== 'all' || run !== null || day !== null}
          onReset={reset}
        />
      ) : mode === 'runs' ? (
        <>
          {byRunShown.map((entry) => (
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
                  {entry.shown.length < entry.routes.length
                    ? ` · показано ${entry.shown.length}`
                    : ''}
                </span>
              </div>
              {table(entry.shown, false)}
            </section>
          ))}

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      ) : mode === 'table' ? (
        <section className="panel">
          {table(shown)}

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </section>
      ) : mode === 'cards' ? (
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
                onOpenEngineer={() => setOpened(engineerOf(route.engineerKey))}
                onOpenOrder={(orderId) => {
                  const order = orderOf(route, orderId);
                  if (order) setOpenedOrder({ order, engineerId: route.engineerId });
                }}
              />
            ))}
          </div>

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      ) : (
        <>
          {/* Список — вид по умолчанию: маршрут — строка, названием стоит
              инженер. Маршрут без человека — это набор чисел, неотличимый
              от соседнего; «чей он» и есть то, по чему его узнают. Карты в
              строке нет — за ней идут к карточке или на большую карту, куда
              строка и уводит. */}
          <DbList
          lead="Маршрут"
            rows={shown.map((route) => ({
              key: route.key,
              lead: <Icon name="path" size={15} />,
              code: route.code,
              title: route.engineerName,
              sub: (
                <>
                  Расчёт {route.run.code} · {route.run.date} ·{' '}
                  {hhmm(route.start)}–{hhmm(route.end)}
                  {route.districts.length > 0 ? ` · ${route.districts.join(' · ')}` : ''}
                </>
              ),
              cells: [
                { label: 'Заявок', value: route.visits },
                { label: 'В работе', value: hoursText(route.workMinutes) },
                { label: 'В дороге', value: hoursText(route.travelMinutes) },
                {
                  label: 'Занятость',
                  value: percent(route.occupancy),
                  tone: route.occupancy < loose ? ('warn' as const) : undefined
                },
                {
                  label: 'Сверх смены',
                  value: route.overtimeMinutes > 0 ? hoursText(route.overtimeMinutes) : '—',
                  tone: route.overtimeMinutes > 0 ? ('warn' as const) : ('muted' as const)
                },
                {
                  label: 'Риск опоздать',
                  value: route.risky > 0 ? route.risky : '—',
                  tone: route.risky > 0 ? ('warn' as const) : ('muted' as const)
                }
              ],
              onOpen: () => onOpenRoute(route.run.id, route.engineerId)
            }))}
          />

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      )}

      {/* Профиль инженера — по имени на карточке маршрута. То же окно, что
          в базе инженеров: заводить второе ради другой двери незачем. */}
      <DbCrewProfile
        crew={opened}
        registry={registry}
        onClose={() => setOpened(null)}
        onOpenRun={(id) => {
          setOpened(null);
          if (onOpenRun) onOpenRun(id as RunId);
          else if (opened) onOpenRoute(id as RunId, opened.code);
        }}
        onOpenMap={(id) => {
          setOpened(null);
          if (onOpenMap) onOpenMap(id as RunId);
          else if (opened) onOpenRoute(id as RunId, opened.code);
        }}
        onTrack={onTrack}
        onChanged={onChanged}
      />

      {/* Заявка — по чипу с её номером на карточке маршрута. */}
      <OrderProfile
        order={openedOrder?.order ?? null}
        registry={registry}
        onClose={() => setOpenedOrder(null)}
        onOpenRun={(id) => {
          const from = openedOrder;
          setOpenedOrder(null);
          if (onOpenRun) onOpenRun(id as RunId);
          else if (from) onOpenRoute(id as RunId, from.engineerId);
        }}
        onOpenMap={(id) => {
          const from = openedOrder;
          setOpenedOrder(null);
          if (onOpenMap) onOpenMap(id as RunId);
          else if (from) onOpenRoute(id as RunId, from.engineerId);
        }}
      />
    </div>
  );
}
