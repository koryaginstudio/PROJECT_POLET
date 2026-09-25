import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { Registry, RouteRecord, RunRef } from '../../data/registry.ts';
import type { RunId } from '../../data/load.ts';
import { stampOf } from '../../data/load.ts';
import { dec, hoursText, plural } from '../../data/derive.ts';
import { skillName } from '../../data/dictionary.ts';
import { RunCard } from '../../app/RunCard.tsx';
import { COMPARE_MAX } from '../../app/compare.ts';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import { service } from '../../data/service.ts';
import { onDuty, useDuty } from '../../data/duty.ts';
import { DutyTag } from '../../app/DutyTag.tsx';
import type { PeriodKey } from '../../app/DbWidgets.tsx';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { DbHead } from './DbHead.tsx';
import { DbBar, DbEmpty, DbMore, usePaging } from './DbBar.tsx';
import type { DbChip } from './DbBar.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { DbList } from './DbList.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Расчёт, который сейчас открыт в диспетчерской, — его карточка помечена
      и открывать её незачем. Пусто, когда в диспетчерской не открыт никакой:
      выбранный в подшапке и открытый — не одно и то же, и пометка «открыт»
      на первом была бы обещанием плана, которого на экране нет. */
  active: string | null;
  /** Открыть расчёт: диспетчерская переходит на его план. */
  onOpen: (id: RunId) => void;
  /** Открыть расчёт сразу на карте: щелчок по карте в карточке. */
  onOpenMap: (id: RunId) => void;
  /** Перейти к уже открытому расчёту в диспетчерскую: открывать его заново
      нечего, а уйти к нему из базы должно быть чем. */
  onGo: (id: RunId) => void;
  /** Расчёты, отобранные к сравнению: карточка помечена, кнопка переключает. */
  compare: RunId[];
  onCompare: (id: RunId) => void;
  /** Открыть правку записи: номер, время создания, заметка. */
  onEdit: (run: RunRef) => void;
}

/* Плотность строки — это выбор между «разглядеть» и «охватить», а не просто
   размер. По две и по четыре карточка живёт целиком: карта дня, цифры,
   действия. По шесть она сжимается до строки истории — номер, когда считали
   и что вышло; карту в такой ширине всё равно не разобрать, и её там нет.

   Открывается всегда на четырёх: карта ещё читается, а история видна
   десятком карточек сразу. */
const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* День расчёта из ISO-даты выгрузки: «2026-08-17» → «17.08.2026». */
const dayOf = (date: string) => {
  const [year, month, day] = date.split('-');
  return day ? `${day}.${month}.${year}` : date;
};

/* По чему упорядочены расчёты. Первым идёт порядок по дате — свежий расчёт
   это то, с чем работают; остальные правила отвечают на «где вышло лучше» и
   «где осталось больше нераспределённого».

   У каждого правила своя сторона по умолчанию, и все три открываются «от
   большего»: свежие сверху, лучшие по покрытию сверху, самые хвостатые
   сверху. Повторный щелчок по выбранному правилу переворачивает порядок —
   привычка из таблиц, здесь она работает так же.

   Порядка по номеру в списке нет: номера в истории растут вместе с датой,
   и это было бы то же самое правило под другим именем. */
type Sort = 'date' | 'coverage' | 'loose';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'date',
    label: 'По дате',
    note: 'Когда расчёт завели',
    desc: true,
    up: 'Сначала давние',
    down: 'Сначала свежие'
  },
  {
    value: 'coverage',
    label: 'По покрытию',
    note: 'Насколько полно разложился день',
    desc: true,
    up: 'Сначала слабые',
    down: 'Сначала полные'
  },
  {
    value: 'loose',
    label: 'По нераспределённым',
    note: 'Сколько заявок осталось без инженера',
    desc: true,
    up: 'Сначала чистые',
    down: 'Сначала с остатком'
  }
];

/* Сколько расчётов показываем сразу. Расчётов в истории обычно единицы, но
   потолок нужен и здесь: база живёт над прогонами, и за месяц работы их
   набирается столько же, сколько рабочих дней. */
const PAGE = 24;

/* Отбор по итогу расчёта: осталось ли в нём что-то, чего движок никому не
   отдал. Это ровно тот вопрос, ради которого в историю и заглядывают. */
type Filter = 'all' | 'loose' | 'clean';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'loose', label: 'Есть нераспределённые' },
  { value: 'clean', label: 'Всё распределено' }
];

/* Отбор по состоянию: взят ли расчёт в работу.

   Кнопка «В работу» говорит, по какому из расчётов дня работают на самом
   деле; остальные прогоны того же дня — черновики к нему. До сих пор это
   знала только сама кнопка: в базе рабочий расчёт лежал вперемешку с
   черновиками, и найти «тот, по которому сегодня едут» можно было, только
   открыв каждый.

   Отбор делит базу надвое и работает во всех видах сразу — в списке, в
   карточках, в таблице и в разрезе по состоянию. */
type State = 'all' | 'duty' | 'draft';

const STATES: { value: State; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'duty', label: 'В работе' },
  { value: 'draft', label: 'Черновики' }
];

/* База расчётов. Здесь они лежат как история, а не как выбор на сегодня:
   переключаться между прогонами удобнее в подшапке диспетчерской, а сюда
   приходят посмотреть, что вообще считали и с каким результатом. */
export function DbRunsScreen({
  registry,
  mode,
  active,
  onOpen,
  onOpenMap,
  onGo,
  compare,
  onCompare,
  onEdit
}: Props) {
  /* С какой плотности открывается база — настройка сервиса: одному важно
     разглядеть карту дня, другому охватить историю строками. */
  const [perRow, setPerRow] = useState(() => service().perRow as string);
  const [sort, setSort] = useState<Sort>('date');
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [state, setState] = useState<State>('all');
  const [query, setQuery] = useState('');
  /* Список «день участка → рабочий расчёт». Подписка нужна затем, что
     «В работу» нажимают прямо здесь, на карточке, — и база обязана тут же
     переложить запись из черновиков в работу. */
  const duty = useDuty();
  const paging = usePaging(PAGE);

  /* Сменили отбор или порядок — счётчик показанного начинается заново. */
  const narrow = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    paging.reset();
  };

  /* Снятие чипа значения не выбирает — оно возвращает отбор к «всем». */
  const clear = (run: () => void) => () => {
    run();
    paging.reset();
  };

  const reset = () => {
    setFilter('all');
    setState('all');
    setQuery('');
    paging.reset();
  };

  /* Взят ли расчёт в работу на свой день. Считается через общий журнал, а не
     флажком на записи: у дня участка хозяин один, и знает об этом журнал. */
  const working = (row: (typeof all)[number]) => onDuty(row.run.id, row.run.date);
  const dense = perRow === '6';

  const all = registry.stats.byRun;

  /* Маршруты, разложенные по расчётам: карточке нужны её собственные — кем
     расчёт занял людей и какие номера маршрутов из него вышли. Считаем один
     раз на весь список, а не в каждой карточке: реестр маршрутов общий, и
     тридцать карточек просеивали бы его тридцать раз. */
  const routesByRun = useMemo(() => {
    const map = new Map<string, RouteRecord[]>();
    for (const route of registry.routes) {
      const list = map.get(route.run.id);
      if (list) list.push(route);
      else map.set(route.run.id, [route]);
    }
    /* По номеру маршрута: номера сквозные, и внутри расчёта они идут подряд —
       это и есть порядок, в котором их завёл движок. */
    for (const list of map.values()) list.sort((a, b) => a.number - b.number);
    return map;
  }, [registry]);

  /* Отбор и порядок считаем один раз на оба вида: карточки и таблица должны
     показывать одну и ту же выборку, иначе переключение вида молча меняет
     набор. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = all.filter((row) => {
      const left = row.orders - row.assigned;
      if (filter === 'loose' && left === 0) return false;
      if (filter === 'clean' && left > 0) return false;
      const live = onDuty(row.run.id, row.run.date);
      if (state === 'duty' && !live) return false;
      if (state === 'draft' && live) return false;
      if (!needle) return true;
      return (
        row.run.code.toLowerCase().includes(needle) || row.run.created.toLowerCase().includes(needle)
      );
    });

    const rank = (row: (typeof all)[number]) => {
      switch (sort) {
        case 'coverage':
          return row.coverage;
        case 'loose':
          return row.orders - row.assigned;
        default:
          /* Место в истории: она сложена от старого к свежему, поэтому
             индекс — это и есть дата расчёта в виде числа. */
          return all.indexOf(row);
      }
    };
    /* Сторона переворачивается целиком, вместе с разрешением ничьих: иначе
       расчёты с одинаковым покрытием стояли бы в одном и том же порядке при
       обеих сторонах, и переворот выглядел бы неполным. */
    const side = desc ? -1 : 1;
    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : a.run.code.localeCompare(b.run.code));
    });
  }, [all, desc, filter, state, duty, query, sort]);

  /* Повторный щелчок по выбранному правилу переворачивает порядок; щелчок по
     другому — переключает правило и берёт его сторону по умолчанию. */
  const pickSort = (value: Sort) => {
    if (value === sort) {
      setDesc((prev) => !prev);
      paging.reset();
      return;
    }
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? true);
    paging.reset();
  };

  /* Срок, за который считает доска. Отдельно от отбора списка: список
     отвечает на «какие расчёты показать», доска — на «за какой срок считать».
     Общим переключателем поиск по номеру менял бы диаграммы, а смена срока —
     прятала бы строки. */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const runsIn = (key: PeriodKey) => all.filter((row) => withinPeriod(row.run.created, key));

  /* Всё, что доска считает, берётся из этого среза — и расчёты, и их маршруты
     с заявками. Считать числа за срок, а доли за всю историю значило бы
     показать в одной плитке два разных множества. */
  const scope = useMemo(() => {
    const runs = runsIn(period);
    const ids = new Set(runs.map((row) => row.run.id));
    return {
      runs,
      routes: registry.routes.filter((route) => ids.has(route.run.id)),
      orders: registry.orders.filter((order) => ids.has(order.run.id))
    };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [all, registry, period]);

  /* Величины базы для доски виджетов. Каждая отдаёт итог, доли этого итога и
     ряд по расчётам — какой из них показать, решает сама плитка. Ряд всегда
     хронологический: линия отвечает на «как менялось», и сортировка списка на
     неё не влияет. */
  const widgets = useMemo<WidgetDef[]>(() => {
    const runs = scope.runs;
    const routes = scope.routes;
    const left = (row: (typeof all)[number]) => row.orders - row.assigned;

    const orders = runs.reduce((sum, row) => sum + row.orders, 0);
    const assigned = runs.reduce((sum, row) => sum + row.assigned, 0);
    const loose = orders - assigned;
    const clean = runs.filter((row) => left(row) === 0).length;
    const travel = routes.reduce((sum, route) => sum + route.travelMinutes, 0);
    const visits = routes.reduce((sum, route) => sum + route.visits, 0);
    const occupancy =
      routes.reduce((sum, route) => sum + route.occupancy, 0) / Math.max(routes.length, 1);

    const perRun = (value: number) => value / Math.max(runs.length, 1);
    const top = <T,>(list: T[], size = 4) => list.slice(0, size);
    const series = (pick: (row: (typeof all)[number]) => number) =>
      runs.map((row) => ({ label: row.run.code, value: pick(row) }));

    /* Маршруты и визиты лежат по расчётам, а не по одному числу на всё: ряд
       для линии собираем здесь же, чтобы «сколько всего» и «как менялось»
       считались из одного места. */
    const routesOf = new Map<string, { routes: number; visits: number; travel: number }>();
    for (const route of routes) {
      const cell = routesOf.get(route.run.id) ?? { routes: 0, visits: 0, travel: 0 };
      cell.routes += 1;
      cell.visits += route.visits;
      cell.travel += route.travelMinutes;
      routesOf.set(route.run.id, cell);
    }
    const runSeries = (pick: (cell: { routes: number; visits: number; travel: number }) => number) =>
      runs.map((row) => ({
        label: row.run.code,
        value: pick(routesOf.get(row.run.id) ?? { routes: 0, visits: 0, travel: 0 })
      }));

    const byCoverage = top([...runs].sort((a, b) => b.coverage - a.coverage));
    const byLoose = top([...runs].sort((a, b) => left(b) - left(a)).filter((row) => left(row) > 0));

    /* Виды работ считаем по заявкам среза, а не по общему своду реестра: свод
       собран по всей истории и на срок не отзывается. */
    const typeCount = new Map<string, number>();
    for (const order of scope.orders) {
      typeCount.set(order.workType, (typeCount.get(order.workType) ?? 0) + 1);
    }
    const types = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);

    const skills = top([...registry.stats.bySkill].sort((a, b) => b.count - a.count), 6);
    const crewed = new Set(routes.map((route) => route.engineerKey)).size;

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
        key: 'runs-count',
        title: 'Расчётов',
        note: 'Сколько расчётов сделано и скольким хватило инженеров',
        shape: 'number',
        data: {
          value: String(runs.length),
          caption: 'за выбранный срок',
          facts: [`${clean} закрыли смену целиком`, `${runs.length - clean} с хвостом`],
          whole: true,
          parts: [
            { key: 'clean', label: 'Без хвоста', value: clean, tone: 'ok' },
            { key: 'loose', label: 'С хвостом', value: runs.length - clean, tone: 'bad' }
          ],
          legend: 'расчётов'
        }
      },
      {
        key: 'orders',
        title: 'Заявок обработано',
        note: 'Сколько заявок прошло через расчёт и что с ними стало',
        shape: 'number',
        data: {
          value: String(orders),
          caption: 'прошло через расчёт',
          facts: [`${Math.round(perRun(orders))} на расчёт`],
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          series: series((row) => row.orders),
          legend: 'заявок'
        }
      },
      {
        key: 'assigned',
        title: 'Из них разложено',
        note: 'Скольким заявкам расчёт нашёл инженера',
        shape: 'number',
        data: {
          value: String(assigned),
          caption: 'получили инженера',
          tone: 'ok',
          facts: [`${percent(assigned / Math.max(orders, 1))} от всех заявок`],
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          series: series((row) => row.assigned),
          legend: 'заявок'
        }
      },
      {
        key: 'routes',
        title: 'Маршрутов',
        note: 'Сколько маршрутов построено и сколько выходит на расчёт',
        shape: 'number',
        data: {
          value: String(routes.length),
          caption: 'построено',
          facts: [`${dec(perRun(routes.length))} на расчёт`],
          series: runSeries((cell) => cell.routes),
          legend: 'маршрутов'
        }
      },
      {
        key: 'travel',
        title: 'В дороге',
        note: 'Сколько всего наездили и сколько приходится на маршрут',
        shape: 'number',
        data: {
          value: dec(travel / 60),
          unit: 'ч',
          caption: 'по всем маршрутам',
          facts: [
            `${dec(travel / 60 / Math.max(routes.length, 1))} ч на маршрут`,
            `${dec(perRun(travel / 60))} ч на расчёт`
          ],
          series: runSeries((cell) => Math.round(cell.travel / 6) / 10),
          legend: 'часов в дороге'
        }
      },
      {
        key: 'visits',
        title: 'Заявок',
        note: 'Сколько заявок расчёт расставил и как это менялось',
        shape: 'number',
        data: {
          value: String(visits),
          caption: 'расставлено',
          facts: [`${dec(visits / Math.max(routes.length, 1))} на маршрут`],
          series: runSeries((cell) => cell.visits),
          legend: 'заявок'
        }
      },
      {
        key: 'coverage-trend',
        title: 'Прогноз по расчётам',
        note: 'Как менялась доля закрытых заявок от расчёта к расчёту',
        shape: 'line',
        data: {
          value: dec(runs[runs.length - 1]?.coverage * 100 || 0),
          unit: '%',
          caption: 'в последнем расчёте',
          tone: (runs[runs.length - 1]?.coverage ?? 1) < 0.8 ? 'bad' : 'ok',
          series: series((row) => Math.round(row.coverage * 1000) / 10),
          legend: 'прогноз выполнения, %'
        }
      },
      {
        key: 'assigned-split',
        title: 'Разложено и без инженера',
        note: 'Что расчёт разобрал и что осталось лежать',
        shape: 'donut',
        data: {
          value: String(orders),
          caption: 'заявок',
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          facts: [`${percent(assigned / Math.max(orders, 1))} разложено`],
          legend: 'заявок'
        }
      },
      {
        key: 'best-runs',
        title: 'Лучшие по покрытию',
        note: 'Расчёты, где по прогнозу дня закрыто больше всего заявок',
        shape: 'bars',
        data: {
          value: percent(byCoverage[0]?.coverage ?? 0),
          caption: 'у лучшего расчёта',
          tone: 'ok',
          parts: byCoverage.map((row) => ({
            key: row.run.id,
            label: row.run.code,
            value: Math.round(row.coverage * 1000) / 10,
            text: percent(row.coverage),
            tone: 'ok' as const
          })),
          legend: 'доля закрытых заявок'
        }
      },
      {
        key: 'loose-runs',
        title: 'Больше всего без инженера',
        note: 'Расчёты с самым длинным хвостом нераспределённого',
        shape: 'bars',
        data: {
          value: String(byLoose[0] ? left(byLoose[0]) : 0),
          caption: 'в худшем расчёте',
          tone: 'bad',
          parts: byLoose.map((row) => ({
            key: row.run.id,
            label: row.run.code,
            value: left(row),
            tone: 'bad' as const
          })),
          legend: byLoose.length > 0 ? 'заявок осталось' : 'таких расчётов нет'
        }
      },
      {
        key: 'work-types',
        title: 'Заявки по видам работ',
        note: 'Чем занята смена — какие работы заказывают чаще',
        shape: 'bars',
        data: {
          value: String(types.length),
          caption: 'видов работ в заявках',
          whole: true,
          parts: types.map(([key, count]) => ({
            key,
            label: registry.workTypeTitle[key] ?? key,
            value: count
          })),
          legend: 'заявок'
        }
      },
      {
        key: 'skills',
        title: 'Инженеры по навыкам',
        note: 'Кем мы располагаем: сколько людей владеет каждым навыком. Считается по штату, срок на него не влияет. Кольца нет: инженер с тремя навыками попадает в три строки, и в целое они не складываются',
        shape: 'bars',
        data: {
          value: String(registry.engineers.length),
          caption: 'инженеров в штате',
          parts: skills.map((item) => ({
            key: item.key,
            label: skillName(item.key),
            value: item.count
          })),
          legend: 'человек владеет навыком'
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
      }
    ];
  }, [scope, registry, all]);

  /* Пять плиток по умолчанию — ровно те числа, что раньше стояли в шапке
     строкой. Шестое место в ряду остаётся под плюс: доска сразу показывает,
     что набор можно менять, и не заставляет искать, чем. */
  const board = useWidgetBoard({
    storeKey: 'db-runs',
    catalogue: widgets,
    fallback: ['runs-count', 'orders', 'assigned', 'routes', 'travel'],
    filter: (
      <WidgetPeriod
        value={period}
        onChange={setPeriod}
        countOf={(key) => runsIn(key).length}
      />
    )
  });

  /* Карточки расчётов. Вынесены в одно место: ими рисует и обычный вид, и
     разрез по состоянию, и расходиться этим двум нельзя. */
  const cards = (list: typeof shown) => (
    <div
      className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
      style={{ '--per-row': perRow } as React.CSSProperties}
    >
      {list.map((row) => (
        <RunCard
          key={row.run.id}
          row={row}
          bounds={registry.bounds}
          routes={routesByRun.get(row.run.id) ?? []}
          /* Кнопки «Открыть» в базе нет: карточка открывает расчёт целиком,
             щелчком в любое своё место, и кнопка внизу была второй дорогой
             туда же. Внизу осталось одно — отбор к сравнению и «В работу»:
             они никуда не уводят, и сами собой карточка их не сделает. */
          showOpen={false}
          isActive={row.run.id === active}
          picked={compare.includes(row.run.id)}
          pickBlocked={compare.length >= COMPARE_MAX}
          dense={dense}
          onOpen={onOpen}
          onOpenMap={onOpenMap}
          onGo={onGo}
          onCompare={onCompare}
          onEdit={onEdit}
        />
      ))}
    </div>
  );

  /* Активные отборы — чипами наверху. Каждый снимается своим крестиком. */
  const chips: DbChip[] = [];
  if (filter !== 'all') {
    chips.push({
      key: 'filter',
      label: FILTERS.find((item) => item.value === filter)?.label ?? filter,
      onRemove: clear(() => setFilter('all'))
    });
  }

  if (state !== 'all') {
    chips.push({
      key: 'state',
      label: STATES.find((item) => item.value === state)?.label ?? state,
      onRemove: clear(() => setState('all'))
    });
  }

  const shown = rows.slice(0, paging.limit);
  const hidden = rows.length - shown.length;

  /* Разрез по состоянию: рабочие расчёты и черновики — двумя перечнями.

     Считается по всей выборке, а не по показанному куску: рабочий расчёт
     дня один на десяток прогонов, и в первую страницу он попадает не
     всегда — раздел «В работе» оказывался бы пуст при взятом в работу
     расчёте. Каждый перечень обрезан своей страницей. */
  const working_ = rows.filter(working).slice(0, paging.limit);
  const drafts = rows.filter((row) => !working(row)).slice(0, paging.limit);

  /* Итог выборки — над списком, а не под ним: это ответ на «что дал отбор»,
     и внизу, за прокруткой, его никто не читает. Числа выбраны по вопросу
     самой базы: что считали, сколько заявок прошло и что от них осталось. */
  const summary = (
    <>
      <b>{plural(rows.length, 'расчёт', 'расчёта', 'расчётов')}</b> в выборке
      {rows.length !== all.length && ` из ${all.length}`}
      {rows.length > 0 && (
        <>
          {` · ${plural(
            rows.reduce((sum, one) => sum + one.orders, 0),
            'заявка',
            'заявки',
            'заявок'
          )}`}
          {` · ${rows.reduce((sum, one) => sum + (one.orders - one.assigned), 0)} без инженера`}
          {` · ${plural(
            rows.reduce((sum, one) => sum + one.routes, 0),
            'маршрут',
            'маршрута',
            'маршрутов'
          )}`}
        </>
      )}
    </>
  );

  return (
    <div className="dash enter">
      {/* Заводить расчёт отсюда нечем и незачем: база — это история того, что
          уже посчитано, а новый расчёт начинается с формы переменных в
          диспетчерской. Кнопка здесь обещала короткую дорогу, а уводила в
          другой раздел — и стояла ровно там, где читают итог, а не заказывают
          новый. Вход в расчёт остался один: диспетчерская и боковое меню. */}
      {/* Числа шапки и есть доска: отдельным блоком «что иллюстрируем» они
          спорили бы сами с собой — два ряда об одном и том же, один выбран за
          диспетчера, другой им самим. Кнопка набора стоит в строке заголовка,
          плитки — там же, где прежде стояла строка чисел. */}
      {/* Полоса управления выборкой стоит в шапке базы, под её заголовком:
          это органы управления тем самым списком, который заголовок называет,
          и отдельной панелью следом они читались как ещё один раздел.

          Разложена столбиком «подпись — орган»: подписи выстроены в колонку,
          переключатели начинаются от одной черты. Раньше строки цеплялись то
          к левому краю, то к правому, и полоса читалась россыпью — три ряда,
          у каждого своё выравнивание, посередине дыра. Наверху — поиск и
          плотность: это не отбор, а то, с какой стороны на список смотрят. */}
      <DbHead title="База расчётов" board={board.node}>
        <DbBar
          query={query}
          onQuery={narrow(setQuery)}
          placeholder="Номер расчёта, дата или заметка"
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

            {/* Состояние — второй отбор, рядом с первым: «что вышло» и «по
                какому из них работают» — разные вопросы, и складываются они
                по «и». */}
            <div className="filters__group">
              <span className="filters__label">Состояние</span>
              <SegmentedControl
                size="sm"
                items={STATES}
                value={state}
                onChange={narrow((value: string) => setState(value as State))}
              />
            </div>

            {/* Плотность строки — только у карточек: в таблице и в списке
                строка одна и в строке она одна. */}
            {mode !== 'table' && mode !== 'list' && (
              <div className="filters__group filters__group--tight">
                <span className="filters__label">Карточек в строке</span>
                <SegmentedControl size="sm" items={DENSITY} value={perRow} onChange={setPerRow} />
              </div>
            )}
          </div>
        </DbBar>
      </DbHead>

      {rows.length === 0 ? (
        <DbEmpty
          miss="Под этот отбор не подошёл ни один расчёт."
          blank="Расчётов в истории пока нет: первый появится, когда день разложат в диспетчерской."
          query={query.trim() !== ''}
          filtered={filter !== 'all' || state !== 'all'}
          onReset={reset}
        />
      ) : mode === 'duty' ? (
        <>
          <section className="panel">
            <div className="dash__section-head">
              <h2 className="dash__section-title">
                <Icon name="check-circle" size={15} /> В работе
              </h2>
              <span className="dash__section-note">
                {plural(working_.length, 'расчёт', 'расчёта', 'расчётов')}
              </span>
            </div>
            {working_.length === 0 ? (
              <p className="runmenu__empty">
                Ни один расчёт не взят в работу. Берут кнопкой «В работу» — в карточке расчёта или
                в подшапке диспетчерской.
              </p>
            ) : (
              cards(working_)
            )}
          </section>

          <section className="panel">
            <div className="dash__section-head">
              <h2 className="dash__section-title">
                <Icon name="stack" size={15} /> Не в работе
              </h2>
              <span className="dash__section-note">
                {plural(drafts.length, 'расчёт', 'расчёта', 'расчётов')}
              </span>
            </div>
            {drafts.length === 0 ? (
              <p className="runmenu__empty">Все расчёты выборки взяты в работу.</p>
            ) : (
              cards(drafts)
            )}
          </section>
        </>
      ) : mode === 'list' ? (
        /* Список: расчёт — строка, и в ней ровно то, ради чего в историю
           заходят. Покрытие первым: это ответ на «как посчиталось», всё
           остальное его объясняет. Кнопка перехода — в конце строки, как в
           таблице: из базы в расчёт ведёт одна дорога, и она везде на одном
           месте. */
        <DbList
          lead="Расчёт"
          rows={shown.map((row) => ({
            key: row.run.id,
            lead: <Icon name="stack" size={15} />,
            code: row.run.code,
            /* Названием — день, на который считали: номером расчёт ищут, а
               помнят его по дню. Когда завели — в подписи: два расчёта на
               один день различают именно временем записи, но это уже
               уточнение, а не имя. Заметка человека стоит перед числами: её
               писал не движок, и теряться среди них ей не следует. */
            title: (
              <>
                {row.run.date ? dayOf(row.run.date) : `Расчёт ${row.run.code}`}
                {working(row) && <DutyTag />}
              </>
            ),
            sub: (
              <>
                {row.run.note ? `${row.run.note} · ` : ''}
                заведён {stampOf(row.run.created)} ·{' '}
                {plural(row.routes, 'маршрут', 'маршрута', 'маршрутов')} · {row.engineersOnRoute} из{' '}
                {row.engineersTotal} инженеров с маршрутом
                {row.run.id === active ? ' · открыт в диспетчерской' : ''}
                {/* Запись посчитана не сегодняшним движком. В строке — три
                    слова, чтобы её было видно в ряду; вся фраза движка — в
                    подсказке: что именно устарело, план или числа на
                    карточке, он говорит сам и по-разному. */}
                {row.run.drift && (
                  <span className="runcard__drift" title={row.run.drift}>
                    считан другим движком
                  </span>
                )}
              </>
            ),
            cells: [
              { label: 'Прогноз', value: percent(row.coverage), tone: row.coverage < 0.8 ? ('warn' as const) : undefined },
              { label: 'Разложено', value: `${row.assigned}/${row.orders}` },
              {
                label: 'Без инженера',
                value: row.orders - row.assigned,
                tone: row.orders - row.assigned > 0 ? ('warn' as const) : ('muted' as const)
              },
              { label: 'Заявок', value: row.visits },
              { label: 'Занятость', value: percent(row.occupancy) },
              { label: 'В дороге', value: hoursText(row.travelMinutes) }
            ],
            action: (
              <>
                <button
                  type="button"
                  className="runcard__edit"
                  onClick={() => onEdit(row.run)}
                  title={`Изменить запись ${row.run.code}: номер, время, заметка`}
                  aria-label={`Изменить запись ${row.run.code}`}
                >
                  <Icon name="pencil" size={13} />
                </button>
                {row.run.id === active ? (
                  <button
                    type="button"
                    className="runcard__go runcard__go--open"
                    onClick={() => onGo(row.run.id)}
                  >
                    <Icon name="arrow-right" size={13} />
                    Перейти
                  </button>
                ) : (
                  <button type="button" className="runcard__go" onClick={() => onOpen(row.run.id)}>
                    <Icon name="arrow-right" size={13} />
                    Открыть
                  </button>
                )}
              </>
            )
          }))}
        />
      ) : mode === 'table' ? (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Расчёт</th>
                  <th>Прогноз</th>
                  <th>Разложено</th>
                  <th>Доля плана</th>
                  <th>Без инженера</th>
                  <th>Маршрутов</th>
                  <th>Заявок</th>
                  <th>Инженеров с маршрутом</th>
                  <th>Занятость</th>
                  <th>В дороге</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr key={row.run.id} className="tbl__row">
                    <td>
                      <span className="tbl__run">
                        <span>
                          <span className="tbl__strong">
                            {row.run.code}
                            {working(row) && <DutyTag />}
                          </span>
                          <span className="tbl__sub">{stampOf(row.run.created)}</span>
                        </span>
                        <button
                          type="button"
                          className="runcard__edit"
                          onClick={() => onEdit(row.run)}
                          title={`Изменить запись ${row.run.code}: номер, время, заметка`}
                          aria-label={`Изменить запись ${row.run.code}`}
                        >
                          <Icon name="pencil" size={13} />
                        </button>
                      </span>
                    </td>
                    <td>
                      <span className={'pill pill--' + (row.coverage < 0.8 ? 'danger' : 'success')}>
                        {percent(row.coverage)}
                      </span>
                    </td>
                    <td className="tbl__num">
                      {row.assigned} из {row.orders}
                    </td>
                    <td className="tbl__num">{percent(row.assignedShare)}</td>
                    <td className={row.orders - row.assigned > 0 ? 'tbl__num tbl__warn' : 'tbl__num'}>
                      {row.orders - row.assigned}
                    </td>
                    <td className="tbl__num">{row.routes}</td>
                    <td className="tbl__num">{row.visits}</td>
                    <td className="tbl__num">
                      {row.engineersOnRoute} из {row.engineersTotal}
                    </td>
                    <td className="tbl__num">{percent(row.occupancy)}</td>
                    <td className="tbl__num">{hoursText(row.travelMinutes)}</td>
                    <td>
                      {row.run.id === active ? (
                        <button
                          type="button"
                          className="runcard__go runcard__go--open"
                          onClick={() => onGo(row.run.id)}
                        >
                          <Icon name="arrow-right" size={13} />
                          Перейти
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="runcard__go"
                          onClick={() => onOpen(row.run.id)}
                        >
                          <Icon name="arrow-right" size={13} />
                          Открыть
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        cards(shown)
      )}

      {/* «Показать ещё» — одна на все три вида: обрезается отрисовка, а
          выборка и её итог считаются целиком, и кнопка не меняет ни одного
          числа над списком. */}
      {rows.length > 0 && <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />}
    </div>
  );
}
