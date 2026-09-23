import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { EngineerRecord, Registry } from '../../data/registry.ts';
import { mergeEngineers } from '../../data/registry.ts';
import { dec, hhmm, hoursText, plural, visits as pluralVisits } from '../../data/derive.ts';
import { skillIcon, skillName, transportName } from '../../data/dictionary.ts';
import { photosFor } from '../../data/photos.ts';
import { clashText, crewTeam, EngineerCard, listWords, postsClash } from '../../app/EngineerCard.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { DbHead, DENSITY, occupancyTiers, usePerRow, useShares } from './DbHead.tsx';
import { DbBar, ChipKey, DbEmpty } from './DbBar.tsx';
import type { DbChip } from './DbBar.tsx';
import { DbCrewProfile } from './DbCrew.tsx';
import { DbList } from './DbList.tsx';
import type { RunId } from '../../data/load.ts';
import { transportWhy } from '../../data/rationale.ts';
import { WhyMark } from '../../app/WhyMark.tsx';
import { PersonName } from '../../app/PersonName.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Данные штата поправили: справочник надо собрать заново. */
  onChanged: () => void;
  /** «Отследить» из профиля: увести в мониторинг за конкретным инженером. */
  onTrack: (id: string) => string | void;
  /** Уйти в расчёт заявки, открытой из профиля, и показать её на карте. */
  onOpenRun: (id: RunId) => void;
  onOpenMap: (id: RunId) => void;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* По чему упорядочены инженеры. Первым идёт порядок по визитам — это ответ на
   «кто везёт смену»; остальные правила отвечают на «кто перегружен», «кто
   простаивает» и «где искать по фамилии».

   Все правила, кроме алфавитного, открываются «от большего»: самые загруженные
   сверху. Повторное нажатие на выбранное правило переворачивает порядок —
   привычка из таблиц, здесь она работает так же. */
type Sort = 'visits' | 'occupancy' | 'idle' | 'overtime' | 'name';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'visits',
    label: 'По заявкам',
    note: 'Кто везёт смену',
    desc: true,
    up: 'Сначала с малым числом заявок',
    down: 'Сначала с большим числом заявок'
  },
  {
    value: 'occupancy',
    label: 'По занятости',
    note: 'Кто перегружен, а у кого запас',
    desc: true,
    up: 'Сначала свободные',
    down: 'Сначала загруженные'
  },
  {
    value: 'idle',
    label: 'По простоям',
    note: 'Кто чаще оставался без маршрута',
    desc: true,
    up: 'Сначала без простоев',
    down: 'Сначала с простоями'
  },
  {
    value: 'overtime',
    label: 'По переработке',
    note: 'Кто вылезает за границу смены',
    desc: true,
    up: 'Сначала без переработки',
    down: 'Сначала с переработкой'
  },
  {
    value: 'name',
    label: 'По алфавиту',
    note: 'Где искать по фамилии',
    desc: false,
    up: 'От А до Я',
    down: 'От Я до А'
  }
];

/* Отбор по тому, как инженер отработал: остался ли кто-то без работы и не
   перегружен ли кто-то сверх меры. Это два вопроса, ради которых в справочник
   и заглядывают — «кого недогрузили» и «кого пора разгрузить». Подписи
   порогов считаются от настроек сервиса, а не написаны руками. */
type Filter = 'all' | 'idle' | 'busy' | 'loose' | 'clash';

const filtersFor = (busy: number, loose: number): { value: Filter; label: string }[] => [
  { value: 'all', label: 'Все' },
  { value: 'idle', label: 'Есть простои' },
  { value: 'busy', label: `Занятость выше ${Math.round(busy * 100)} %` },
  { value: 'loose', label: `Занятость ниже ${Math.round(loose * 100)} %` },
  { value: 'clash', label: 'Конфликт штата' }
];

/* Что за номер — для строки-подсказки под полем поиска. */
type NumberKind = 'client' | 'route' | 'order' | 'run';

const KIND_TEXT: Record<NumberKind, { word: string; icon: string }> = {
  client: { word: 'клиент', icon: 'user' },
  route: { word: 'маршрут', icon: 'path' },
  order: { word: 'заявка', icon: 'clipboard-list' },
  run: { word: 'расчёт', icon: 'stack' }
};

/* База инженеров: весь штат, а не смена одного прогона. Устроена как
   остальные базы — поиск, отбор, порядок, плотность и доска виджетов сверху,
   — и это осознанное повторение: шесть справочников об одном хозяйстве, и
   переучивать диспетчера на каждом незачем. */
export function DbEngineersScreen({
  registry,
  mode,
  onChanged,
  onTrack,
  onOpenRun,
  onOpenMap
}: Props) {
  /* Плотность ряда — настройка сервиса, общая на все базы. */
  const [perRow, setPerRow] = usePerRow();
  const [sort, setSort] = useState<Sort>('visits');
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  /* Отмеченные навыки. Их несколько, и они сужают выборку вместе: отмечено
     два — остаются те, кто владеет обоими. Так чип и должен работать в отборе:
     каждый следующий сужает, а не расширяет. Складывать их по «или» смысла
     мало — навыков всего три, и отметить все значило бы вернуться к списку
     целиком. */
  const [picks, setPicks] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const dense = perRow === '6';
  /* Пороги перегруза и недогруза — из настроек сервиса, одни на все базы. */
  const { busy, loose } = useShares();
  const FILTERS = filtersFor(busy, loose);
  /* Чей профиль открыт. Правка живёт внутри того же окна — кнопка «Править»
     переключает часть профиля в форму, а не открывает второе окно поверх
     первого. */
  const [opened, setOpened] = useState<EngineerRecord | null>(null);

  /* Люди, а не записи справочника: человек, который числится на нескольких
     участках, приходит оттуда несколькими записями — с работой на своём
     участке и нулями на чужих. В базе он один, см. `mergeEngineers`. */
  const all = useMemo(() => mergeEngineers(registry.engineers), [registry]);

  /* Снимки раздаются на весь штат сразу, а не на выборку: иначе отбор по
     навыку менял бы людям лица. */
  const photos = useMemo(() => photosFor(all), [all]);

  const skills = useMemo(() => {
    const set = new Set<string>();
    for (const engineer of all) for (const key of engineer.skills) set.add(key);
    return [...set].sort((a, b) => skillName(a).localeCompare(skillName(b)));
  }, [all]);

  /* Указатель «номер → кто по нему работал».

     Диспетчер приходит сюда не только с фамилией. У него на руках номер — с
     заявки, с маршрута, из расчёта, от клиента, — и вопрос один: кто это
     вёз. Раньше ответа не было вовсе: поиск знал имя, табельный, адрес
     выезда и навык, а номера всех четырёх видов не находил ничего.

     Заводить под это четыре правила сортировки было бы неправильно: искать
     по номеру — не то же самое, что упорядочивать, и четыре лишних кнопки в
     полосе отбора отвечали бы на вопрос, который задают одной строкой.
     Поэтому здесь одно поле, а разбор номера берёт на себя указатель.

     Род номера указатель берёт из реестра, а не гадает по первой букве и
     длине: номера в выгрузке заказчика приходят такими, какими их завела
     учётная система, и правило «R с четырьмя знаками — заявка» на следующей
     выгрузке могло бы назвать расчёт заявкой.

     Строится он один раз на весь справочник и переживает набор строки по
     букве: перебирать двести заявок на каждое нажатие клавиши незачем. */
  const byNumber = useMemo(() => {
    const index = new Map<string, Set<string>>();
    const kinds = new Map<string, NumberKind>();
    const put = (key: string, kind: NumberKind, engineerId: string | null) => {
      if (!key) return;
      const low = key.toLowerCase();
      if (!kinds.has(low)) kinds.set(low, kind);
      if (!engineerId) return;
      const cell = index.get(low) ?? new Set<string>();
      cell.add(engineerId);
      index.set(low, cell);
    };

    /* Заявка и клиент опознают исполнителя через саму заявку: кто её вёз, тот
       и ездил по этому адресу. Заявка, оставшаяся без инженера, в указатель
       попадает только родом — по её номеру искать некого, но что это заявка,
       подсказка сказать обязана. */
    const clientCodeByKey = new Map(registry.clients.map((client) => [client.key, client.code]));
    for (const order of registry.orders) {
      put(order.id, 'order', order.engineerKey);
      const clientKey = order.address ?? `${order.district} · ${order.lat},${order.lon}`;
      put(clientCodeByKey.get(clientKey) ?? '', 'client', order.engineerKey);
    }
    for (const client of registry.clients) put(client.code, 'client', null);
    for (const route of registry.routes) {
      put(route.code, 'route', route.engineerKey);
      /* Расчёт — это все, кто получил в нём маршрут. Вышедшие на смену, но
         оставшиеся без работы, сюда не идут: по номеру расчёта ищут тех, кто
         в нём ездил. */
      put(route.run.code, 'run', route.engineerKey);
    }
    for (const run of registry.runs) put(run.code, 'run', null);
    return { index, kinds };
  }, [registry]);

  /* Что распознали в набранном — для строки-подсказки под полем. */
  const hit = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const kind = byNumber.kinds.get(needle);
    if (!kind) return null;
    const found = byNumber.index.get(needle);
    const what = KIND_TEXT[kind];
    return {
      icon: what.icon,
      text: `${what.word} ${needle.toUpperCase()} — ${
        found ? plural(found.size, 'инженер', 'инженера', 'инженеров') : 'инженера нет'
      }`
    };
  }, [byNumber, query]);

  /* Отбор и порядок считаем один раз на все виды: карточки, список и таблица
     должны показывать одну и ту же выборку, иначе переключение вида молча
     меняет набор. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    /* Набранное — номер из указателя? Тогда он и решает, кого показать: у
       номера один правильный ответ, и подмешивать к нему совпадения по
       фамилии значило бы прятать этот ответ среди чужих. */
    const byCode = needle && byNumber.kinds.has(needle) ? byNumber.index.get(needle) : undefined;
    const picked = all.filter((row) => {
      if (picks.length > 0 && !picks.every((key) => row.skills.includes(key))) return false;
      if (filter === 'idle' && row.idleRuns === 0) return false;
      if (filter === 'busy' && row.occupancyMean < busy) return false;
      if (filter === 'loose' && row.occupancyMean >= loose) return false;
      if (filter === 'clash' && !postsClash(row)) return false;
      if (!needle) return true;
      if (needle && byNumber.kinds.has(needle)) return byCode?.has(row.id) ?? false;
      /* Ищем и по навыку словом: «электрик» набирают чаще, чем ищут его в
         ряду значков. */
      return (
        row.name.toLowerCase().includes(needle) ||
        row.id.toLowerCase().includes(needle) ||
        (row.homeAddress ?? '').toLowerCase().includes(needle) ||
        row.skills.some((key) => skillName(key).toLowerCase().includes(needle))
      );
    });

    const rank = (row: EngineerRecord) => {
      switch (sort) {
        case 'occupancy':
          return row.occupancyMean;
        case 'idle':
          return row.idleRuns;
        case 'overtime':
          return row.overtimeMinutes;
        case 'name':
          /* Алфавит числом не меряется: у него своё сравнение, а ранг нужен
             только затем, чтобы обе стороны переворачивались одинаково. */
          return 0;
        default:
          return row.visits;
      }
    };
    /* Сторона переворачивается целиком, вместе с разрешением ничьих: иначе
       инженеры с одинаковой занятостью стояли бы в одном и том же порядке при
       обеих сторонах, и переворот выглядел бы неполным. */
    const side = desc ? -1 : 1;
    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : a.name.localeCompare(b.name));
    });
  }, [all, busy, byNumber, desc, filter, loose, picks, query, sort]);

  /* Смена правила заодно ставит сторону, с которой его читают чаще.
     Повторное нажатие на выбранное правило переворачивает сторону — это
     делает само меню. */
  const pickSort = (value: Sort) => {
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? true);
  };

  const reset = () => {
    setFilter('all');
    setPicks([]);
    setQuery('');
  };

  /* Срок, за который считает доска. Отдельно от отбора списка: список отвечает
     на «кого показать», доска — на «за какой срок считать». Общим
     переключателем поиск по фамилии менял бы диаграммы, а смена срока — прятала
     бы людей из штата, которые никуда не делись. */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const runsIn = (key: PeriodKey) =>
    registry.runs.filter((run) => withinPeriod(run.created, key));

  /* Срез: смены, попавшие в срок. Инженеры остаются все — штат от срока не
     меняется, — а вот их выработка считается только по прогонам срока.
     Простой в маршрутах — из реестра маршрутов: у смены инженера своего
     простоя нет, а доля дороги «от времени в маршруте» без него считалась бы
     от другого целого, чем в базе маршрутов. */
  const scope = useMemo(() => {
    const shifts = all.flatMap((row) =>
      row.byRun
        .filter((shift) => withinPeriod(shift.created, period))
        .map((shift) => ({ engineer: row, shift }))
    );
    const runIds = new Set(shifts.map((item) => item.shift.runId));
    const idle = registry.routes
      .filter((route) => runIds.has(route.run.id))
      .reduce((sum, route) => sum + route.idleMinutes, 0);
    return { shifts, runs: runIds.size, idle };
  }, [all, registry.routes, period]);

  /* Выработка каждого за выбранный срок. Карточка показывает её главным
     числом, и считать её приходится здесь: запись инженера хранит итоги по
     всей истории, а срок выбирают наверху. */
  const workedBy = useMemo(() => {
    const map = new Map<string, { work: number; travel: number }>();
    for (const { engineer, shift } of scope.shifts) {
      const cell = map.get(engineer.id) ?? { work: 0, travel: 0 };
      cell.work += shift.workMinutes;
      cell.travel += shift.travelMinutes;
      map.set(engineer.id, cell);
    }
    return map;
  }, [scope]);

  /* Величины базы для доски виджетов. Каждая отдаёт итог, доли этого итога и
     ряд по расчётам — какой из них показать, решает сама плитка. Ряд всегда
     хронологический: линия отвечает на «как менялось», и сортировка списка на
     неё не влияет. */
  const widgets = useMemo<WidgetDef[]>(() => {
    const shifts = scope.shifts;
    const worked = shifts.filter((item) => item.shift.routed);

    const visits = worked.reduce((sum, item) => sum + item.shift.visits, 0);
    const travel = worked.reduce((sum, item) => sum + item.shift.travelMinutes, 0);
    const work = worked.reduce((sum, item) => sum + item.shift.workMinutes, 0);
    const overtime = worked.reduce((sum, item) => sum + item.shift.overtimeMinutes, 0);
    const occupancy =
      worked.reduce((sum, item) => sum + item.shift.occupancy, 0) / Math.max(worked.length, 1);
    const idleShifts = shifts.length - worked.length;
    /* Время в маршруте — работа, дорога и ожидание, той же базой, что в базе
       маршрутов: две плитки в двух базах говорят «от времени в маршруте», и
       считать это от разных целых нельзя. */
    const inRoute = Math.max(work + travel + scope.idle, 1);

    /* Кто в срок выходил в смену, кто из них выезжал хоть раз, а кто ни разу.
       Все три числа считаются по одному срезу — по сменам срока: «в штате»
       по всему справочнику и «выезжали» по одному расчёту были бы числами
       из разных множеств в одной плитке. */
    const people = new Set(shifts.map((item) => item.engineer.id));
    const crewed = new Set(worked.map((item) => item.engineer.id));
    const idlePeople = [...people].filter((id) => !crewed.has(id)).length;

    const perRun = (value: number) => value / Math.max(scope.runs, 1);
    const top = <T,>(list: T[], size = 4) => list.slice(0, size);

    /* Ряд по прогонам: смены разложены по расчётам, чтобы «сколько всего» и
       «как менялось» считались из одного места. */
    const byRun = new Map<
      string,
      { code: string; created: string; visits: number; travel: number; work: number; idle: number; crew: number }
    >();
    for (const { shift } of shifts) {
      const cell =
        byRun.get(shift.runId) ??
        { code: shift.code, created: shift.created, visits: 0, travel: 0, work: 0, idle: 0, crew: 0 };
      cell.visits += shift.visits;
      cell.travel += shift.travelMinutes;
      cell.work += shift.workMinutes;
      if (shift.routed) cell.crew += 1;
      else cell.idle += 1;
      byRun.set(shift.runId, cell);
    }
    const runCells = [...byRun.values()].sort((a, b) => a.created.localeCompare(b.created));
    const series = (pick: (cell: (typeof runCells)[number]) => number) =>
      runCells.map((cell) => ({ label: cell.code, value: pick(cell) }));

    /* Итоги на человека — по срезу, а не по сводным числам записи: сводные
       посчитаны по всей истории и на срок не отзываются. */
    const byPerson = new Map<
      string,
      { row: EngineerRecord; visits: number; occupancies: number[]; idle: number; overtime: number }
    >();
    for (const { engineer, shift } of shifts) {
      const cell =
        byPerson.get(engineer.id) ??
        { row: engineer, visits: 0, occupancies: [] as number[], idle: 0, overtime: 0 };
      cell.visits += shift.visits;
      cell.overtime += shift.overtimeMinutes;
      if (shift.routed) cell.occupancies.push(shift.occupancy);
      else cell.idle += 1;
      byPerson.set(engineer.id, cell);
    }
    const persons = [...byPerson.values()].map((cell) => ({
      ...cell,
      occupancy: cell.occupancies.length
        ? cell.occupancies.reduce((a, b) => a + b, 0) / cell.occupancies.length
        : 0
    }));

    const byVisits = top([...persons].sort((a, b) => b.visits - a.visits));
    const byIdle = top([...persons].sort((a, b) => b.idle - a.idle).filter((one) => one.idle > 0));
    /* Сколько людей с переработкой — считаем до обрезки списка: в плитке
       стоят четыре строки, а подстрочник отвечает на «сколько их», и число
       по обрезанному списку никогда не сказало бы больше четырёх. */
    const overtimePeople = persons.filter((one) => one.overtime > 0);
    const byOvertime = top([...overtimePeople].sort((a, b) => b.overtime - a.overtime));
    const byLoose = top(
      [...persons]
        .filter((one) => one.occupancies.length > 0)
        .sort((a, b) => a.occupancy - b.occupancy)
    );

    /* Навыки считаем по штату, а не по срезу: чем инженер владеет, от срока не
       зависит. Кольца у этой величины нет — инженер с тремя навыками попадает
       в три строки, и в целое они не складываются. */
    const skillCount = top(
      [...registry.stats.bySkill].sort((a, b) => b.count - a.count),
      6
    );

    /* Конфликты штата — по справочнику, срок на них не влияет: человек
       числится в двух участках со сменами внахлёст независимо от того, за
       какой срок смотрят. */
    const clashes = all.filter((row) => postsClash(row));

    /* Занятость раскладываем на три ступени: «сколько в среднем» отвечает на
       вопрос наполовину — маршрут под завязку и маршрут вполпустого дают ту
       же среднюю, что два ровных. Границы ступеней — пороги из настроек. */
    const tiers = occupancyTiers(busy, loose);

    return [
      {
        key: 'hours',
        title: 'Отработано часов',
        note: 'Время инженеров за выбранный срок: работа на объектах и дорога между ними',
        shape: 'number',
        data: {
          /* Отработанным считается и дорога тоже: инженер в пути занят так
             же, как инженер у щитка, и час езды через город из смены не
             вычитается. Разложено рядом, чтобы это читалось, а не
             предполагалось. Ряд по расчётам — та же сумма, а не одна дорога:
             итог и линия под ним обязаны быть об одном. */
          value: hoursText(work + travel),
          caption: 'за срок',
          facts: [
            `${hoursText(work)} работа на объектах`,
            `${hoursText(travel)} дорога`,
            `${hoursText((work + travel) / Math.max(worked.length, 1))} на смену`
          ],
          parts: [
            { key: 'work', label: 'Работа', value: work, tone: 'ok' },
            { key: 'travel', label: 'Дорога', value: travel, tone: 'warn' }
          ],
          series: series((cell) => Math.round((cell.work + cell.travel) / 6) / 10),
          legend: 'часов работы и дороги'
        }
      },
      {
        key: 'people',
        title: 'Инженеров',
        note: 'Сколько человек выходило в смену за срок и скольким досталась работа',
        shape: 'number',
        data: {
          value: String(people.size),
          caption: 'выходили в смену за срок',
          facts: [
            `${crewed.size} выезжали`,
            `${idlePeople} ни разу`,
            `${all.length} в справочнике`
          ],
          whole: true,
          parts: [
            { key: 'crewed', label: 'С маршрутом', value: crewed.size, tone: 'ok' },
            { key: 'idle', label: 'Ни разу', value: idlePeople, tone: 'warn' }
          ],
          legend: 'инженеров'
        }
      },
      {
        key: 'shifts',
        title: 'Смен отработано',
        note: 'Сколько человеко-смен вышло и сколько из них прошло без маршрута',
        shape: 'number',
        data: {
          value: String(shifts.length),
          caption: 'человеко-смен',
          facts: [`${worked.length} с маршрутом`, `${idleShifts} без работы`],
          whole: true,
          parts: [
            { key: 'worked', label: 'С маршрутом', value: worked.length, tone: 'ok' },
            { key: 'idle', label: 'Без маршрута', value: idleShifts, tone: 'bad' }
          ],
          series: series((cell) => cell.crew),
          legend: 'смен с маршрутом'
        }
      },
      {
        key: 'visits',
        title: 'Заявок',
        note: 'Сколько заявок инженеры отработали и как это менялось',
        shape: 'number',
        data: {
          value: String(visits),
          caption: 'отработано',
          facts: [
            `${dec(visits / Math.max(worked.length, 1))} на смену`,
            `${Math.round(perRun(visits))} на расчёт`
          ],
          series: series((cell) => cell.visits),
          legend: 'заявок'
        }
      },
      {
        key: 'occupancy',
        title: 'Средняя занятость',
        note: 'Насколько плотно набиты смены и сколько из них под завязку',
        shape: 'number',
        data: {
          value: String(Math.round(occupancy * 100)),
          unit: '%',
          caption: 'рабочего времени в смене',
          tone: occupancy >= busy ? 'bad' : 'neutral',
          facts: [`по ${worked.length} сменам с маршрутом`],
          whole: true,
          parts: tiers.map((tier) => ({
            key: tier.key,
            label: tier.label,
            value: worked.filter((item) => tier.has(item.shift.occupancy)).length,
            tone: tier.tone
          })),
          legend: 'смен в полосе занятости'
        }
      },
      {
        key: 'clash',
        title: 'Конфликты штата',
        note: 'Сколько человек числится в двух участках со сменами, которые накладываются друг на друга',
        shape: 'number',
        data: {
          value: String(clashes.length),
          caption: 'человек числится на нескольких участках разом',
          tone: clashes.length > 0 ? 'bad' : 'ok',
          facts:
            clashes.length > 0
              ? clashes.slice(0, 3).map((row) => `${row.name} — ${listWords(row.posts.map((post) => post.zone))}`)
              : ['смены по участкам не пересекаются'],
          parts: clashes.map((row) => ({
            key: row.id,
            label: row.name,
            value: row.posts.length,
            text: row.posts.map((post) => `${post.zone} ${hhmm(post.shiftStart)}–${hhmm(post.shiftEnd)}`).join(', '),
            tone: 'bad' as const
          })),
          legend: clashes.length > 0 ? 'участков у человека' : 'конфликтов нет'
        }
      },
      {
        key: 'work',
        title: 'В работе',
        note: 'Сколько часов инженеры провели на объектах',
        shape: 'number',
        data: {
          /* Часы — через `hoursText`: формат часов выбран в настройках
             сервиса, и плитка обязана его слушать. */
          value: hoursText(work),
          caption: 'на объектах',
          facts: [`${hoursText(work / Math.max(worked.length, 1))} на смену`],
          legend: 'часов работы'
        }
      },
      {
        key: 'travel',
        title: 'В дороге',
        note: 'Сколько наездили и какая доля времени в маршруте ушла на переезды',
        shape: 'number',
        data: {
          value: hoursText(travel),
          caption: 'по всем сменам',
          facts: [
            `${hoursText(travel / Math.max(worked.length, 1))} на смену`,
            `${percent(travel / inRoute)} от времени в маршруте`
          ],
          whole: true,
          parts: [
            { key: 'work', label: 'На объектах', value: Math.round(work), tone: 'ok' },
            { key: 'travel', label: 'В дороге', value: Math.round(travel), tone: 'warn' },
            { key: 'idle', label: 'Ожидание', value: Math.round(scope.idle), tone: 'bad' }
          ],
          series: series((cell) => Math.round(cell.travel / 6) / 10),
          legend: 'минут в маршруте'
        }
      },
      {
        key: 'overtime',
        title: 'Сверх смены',
        note: 'Сколько наработали за границей смены и кто именно',
        shape: 'number',
        data: {
          value: hoursText(overtime),
          caption: 'сверх графика',
          tone: overtime > 0 ? 'bad' : 'ok',
          facts: [`${plural(overtimePeople.length, 'человек', 'человека', 'человек')} с переработкой`],
          parts: byOvertime.map((one) => ({
            key: one.row.id,
            label: one.row.name,
            value: Math.round(one.overtime),
            text: hoursText(one.overtime),
            tone: 'bad' as const
          })),
          legend: overtimePeople.length > 0 ? 'минут сверх смены' : 'переработки нет'
        }
      },
      {
        key: 'idle-shifts',
        title: 'Смен без маршрута',
        note: 'Сколько раз инженер вышел и остался без работы',
        shape: 'number',
        data: {
          value: String(idleShifts),
          caption: 'смен прошло впустую',
          tone: idleShifts > 0 ? 'bad' : 'ok',
          facts: [`${percent(idleShifts / Math.max(shifts.length, 1))} от всех смен`],
          series: series((cell) => cell.idle),
          legend: 'смен без маршрута'
        }
      },
      {
        key: 'busiest',
        title: 'Больше всех заявок',
        note: 'Кто везёт смену — инженеры с самой длинной выработкой',
        shape: 'bars',
        data: {
          value: String(byVisits[0]?.visits ?? 0),
          caption: 'у самого загруженного',
          tone: 'ok',
          parts: byVisits.map((one) => ({
            key: one.row.id,
            label: one.row.name,
            value: one.visits,
            tone: 'ok' as const
          })),
          legend: 'заявок за срок'
        }
      },
      {
        key: 'idle-people',
        title: 'Чаще всех без маршрута',
        note: 'Кого расчёт не берёт в план — и сколько раз',
        shape: 'bars',
        data: {
          value: String(byIdle[0]?.idle ?? 0),
          caption: 'смен у самого простаивающего',
          tone: 'bad',
          parts: byIdle.map((one) => ({
            key: one.row.id,
            label: one.row.name,
            value: one.idle,
            tone: 'bad' as const
          })),
          legend: byIdle.length > 0 ? 'смен без маршрута' : 'простоев нет'
        }
      },
      {
        key: 'loose-people',
        title: 'Самые пустые смены',
        note: 'У кого маршруты набиты слабее всех — там есть запас',
        shape: 'bars',
        data: {
          value: percent(byLoose[0]?.occupancy ?? 0),
          caption: 'у самой пустой смены',
          tone: 'warn',
          parts: byLoose.map((one) => ({
            key: one.row.id,
            label: one.row.name,
            value: Math.round(one.occupancy * 1000) / 10,
            text: percent(one.occupancy),
            tone: 'warn' as const
          })),
          legend: 'занятость, %'
        }
      },
      {
        key: 'skills',
        title: 'Инженеры по навыкам',
        note: 'Кем мы располагаем: сколько людей владеет каждым навыком. Считается по штату, срок на него не влияет. Кольца нет: инженер с тремя навыками попадает в три строки, и в целое они не складываются',
        shape: 'bars',
        data: {
          value: String(all.length),
          caption: 'инженеров в штате',
          parts: skillCount.map((item) => ({
            key: item.key,
            label: skillName(item.key),
            value: item.count
          })),
          legend: 'человек владеет навыком'
        }
      },
    ];
  }, [scope, registry, all, busy, loose]);

  /* Шесть плиток по умолчанию — пять чисел, что раньше стояли в шапке
     строкой, и конфликты штата. Последняя плитка стоит в наборе не ради
     числа, а ради тревоги: человек в двух участках разом — это ошибка
     данных, и о ней база обязана сказать до того, как её заметят по
     разъехавшемуся плану. Пока конфликтов нет, плитка тихая. */
  const board = useWidgetBoard({
    storeKey: 'db-engineers',
    catalogue: widgets,
    fallback: ['hours', 'people', 'shifts', 'visits', 'occupancy', 'clash'],
    filter: (
      <WidgetPeriod value={period} onChange={setPeriod} countOf={(key) => runsIn(key).length} />
    )
  });

  /* Активные отборы — чипами наверху. Каждый снимается своим крестиком. */
  const chips: DbChip[] = [];
  if (filter !== 'all') {
    chips.push({
      key: 'filter',
      label: FILTERS.find((item) => item.value === filter)?.label ?? filter,
      onRemove: () => setFilter('all')
    });
  }
  for (const key of picks) {
    chips.push({
      key: `skill:${key}`,
      label: (
        <>
          <ChipKey>Навык</ChipKey>
          {skillName(key)}
        </>
      ),
      onRemove: () => setPicks(picks.filter((one) => one !== key))
    });
  }

  /* Итог выборки — над списком: сверху доска отвечает на «как дела вообще»,
     эта строка — на «а что сейчас на экране». Числа выбраны по вопросу самой
     базы: кто у нас есть, сколько они отработали и сколько раз выходили
     впустую. */
  /* Участков несколько у всех до единого? Тогда метка конфликта никого не
     выделяет — см. `clashMark`. Считаем по всей базе, а не по выборке: отбор
     из одного человека не должен ни зажигать метку, ни гасить её. */
  const clashAll = all.length > 0 && all.every((one) => postsClash(one));

  const summary = rows.length > 0 && (
    <>
      <b>{plural(rows.length, 'инженер', 'инженера', 'инженеров')}</b> в выборке
      {rows.length !== all.length && ` из ${all.length}`}
      {` · ${pluralVisits(rows.reduce((sum, one) => sum + one.visits, 0))}`}
      {` · ${hoursText(
        rows.reduce((sum, one) => sum + one.workMinutes + one.travelMinutes, 0)
      )} отработано`}
      {` · ${plural(
        rows.reduce((sum, one) => sum + one.idleRuns, 0),
        'смена',
        'смены',
        'смен'
      )} без маршрута`}
      {clashAll && (
        <span className="crewpro__muted">
          {' · '}у всех участков несколько, смены в них совпадают — так приходит штат из
          программы расчёта
        </span>
      )}
    </>
  );

  /* Метка конфликта штата — одна на строку и таблицу.

     Метка молчит, когда участков несколько у всех до единого. Так приходит
     штат из программы расчёта: она кладёт в план каждого участка всех
     инженеров, приписав каждому офис этого участка, — и «числится в трёх
     местах разом» оказывается верно про каждого. Предупреждение, которое
     горит у всех, ничего не выделяет; общий случай сказан один раз строкой
     над базой. Различает кого-то из штата — метка на месте.

     Считаем по всей базе, а не по выборке: отбор из одного человека не
     должен ни зажигать метку, ни гасить её. */

  const clashMark = (engineer: EngineerRecord) =>
    !clashAll && postsClash(engineer) ? (
      <span className="ordcard__urgent" title={`${engineer.name}: ${clashText(engineer.posts.length)}`}>
        <Icon name="warning" size={11} />
        {clashText(engineer.posts.length)}
      </span>
    ) : null;

  return (
    <div className="dash enter">
      <DbHead title="База инженеров" board={board.node}>
        <DbBar
          query={query}
          onQuery={setQuery}
          placeholder="Фамилия, табельный, навык или номер: заявки, маршрута, расчёта, клиента"
          /* Что распознали в набранном. Без этой строки поиск по номеру
             молчалив до неотличимости от поломки: набрал «M0010», список
             сузился до одного человека — и непонятно, нашёлся он по
             маршруту или случайно совпал с чем-то в имени. */
          hit={
            hit && (
              <span className="dbsearch__hit">
                <Icon name={hit.icon} size={12} />
                {hit.text}
              </span>
            )
          }
          chips={chips}
          onReset={reset}
          sort={
            <SortMenu
              rules={SORTS}
              value={sort}
              desc={desc}
              onPick={(value: string) => pickSort(value as Sort)}
              onOrder={setDesc}
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
                onChange={(value: string) => setFilter(value as Filter)}
              />
            </div>

            {/* Навыки — отдельной строкой во всю ширину. Отбор здесь тот же,
                что подсвечен чипом в карточке. */}
            <div className="filters__group filters__group--wide">
              <span className="filters__label">Навык</span>
              <span className="filters__types">
                {skills.map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={'chip' + (picks.includes(key) ? ' chip--on' : '')}
                    onClick={() =>
                      setPicks((was) =>
                        was.includes(key) ? was.filter((one) => one !== key) : [...was, key]
                      )
                    }
                    aria-pressed={picks.includes(key)}
                    title={
                      picks.includes(key)
                        ? `Снять «${skillName(key)}»`
                        : picks.length > 0
                          ? `Оставить тех, кто умеет и это тоже`
                          : `Оставить тех, кто умеет «${skillName(key)}»`
                    }
                  >
                    <Icon name={skillIcon(key)} size={12} />
                    {skillName(key)}
                    {picks.includes(key) && <Icon name="x" size={12} />}
                  </button>
                ))}
              </span>
            </div>

            {/* Плотность ряда — только у карточек: в таблице и в списке
                строка одна и в строке она одна. */}
            {mode === 'cards' && (
              <div className="filters__group">
                <span className="filters__label">Карточек в строке</span>
                <SegmentedControl size="sm" items={DENSITY} value={perRow} onChange={setPerRow} />
              </div>
            )}
          </div>
        </DbBar>
      </DbHead>

      {/* План участка не пришёл от программы расчёта — его людей в базе нет.
          Молча показанный неполный штат читался бы как «людей стало меньше». */}
      {registry.missingZones.length > 0 && (
        <div className="srcengine" role="status">
          <Icon name="alert-triangle" size={16} />
          <div className="srcengine__text">
            <p>
              {registry.missingZones.length === 1
                ? `Штат участка ${registry.missingZones[0]} не загрузился`
                : `Штат участков ${registry.missingZones.join(', ')} не загрузился`}
              {' '}— его инженеров в списке нет. Обновите страницу.
            </p>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <DbEmpty
          miss="Под этот отбор не подошёл ни один инженер."
          blank="Инженеров в базе пока нет: штат приходит вместе с расчётом, и до первого сохранённого расчёта база пуста."
          query={query.trim() !== ''}
          filtered={filter !== 'all' || picks.length > 0}
          onReset={reset}
        />
      ) : mode === 'table' ? (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Инженер</th>
                  <th>Бригада</th>
                  <th>Участок</th>
                  <th>Выезжает из</th>
                  <th>Навыки</th>
                  <th>Транспорт</th>
                  <th>Смена</th>
                  <th>Телефон</th>
                  <th>В расчётах</th>
                  <th>Маршрутов</th>
                  <th>Заявок</th>
                  <th>В дороге</th>
                  <th>В работе</th>
                  <th>Сверх смены</th>
                  <th>Занятость</th>
                  <th>Без маршрута</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((engineer) => {
                  const team = crewTeam(engineer);
                  return (
                    /* Строка открывает профиль, как карточка и строка списка:
                       три вида одной базы не должны по-разному отвечать на
                       щелчок. */
                    <tr
                      key={engineer.id}
                      className="tbl__row tbl__row--open"
                      tabIndex={0}
                      role="button"
                      onClick={() => setOpened(engineer)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpened(engineer);
                        }
                      }}
                    >
                      <td>
                        {/* Лицо и в таблице: строка узкая, кружок мелкий, но
                            глаз находит человека по нему быстрее, чем прочтёт
                            фамилию. */}
                        <span className="tbl__face">
                          <img src={photos.get(engineer.id)} alt="" loading="lazy" />
                          <span>
                            <span className="tbl__strong">
                              <PersonName name={engineer.name} stacked={false} />
                            </span>
                            <span className="tbl__sub">{engineer.code}</span>
                          </span>
                        </span>
                      </td>
                      {/* Бригада — только когда она не сводится к самому
                          человеку: в выгрузке заказчика в этом поле у
                          большинства стоит их же имя, и колонка повторяла
                          соседнюю. */}
                      <td>{team ?? <span className="tbl__muted">—</span>}</td>
                      <td>
                        {engineer.posts.length > 0 ? (
                          <>
                            {engineer.posts.map((post) => post.zone).join(' · ')}
                            {postsClash(engineer) && (
                              <span className="tbl__sub">{clashMark(engineer)}</span>
                            )}
                          </>
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
                      </td>
                      <td>{engineer.homeAddress ?? <span className="tbl__muted">Не указан</span>}</td>
                      <td>
                        <span className="tbl__tags">
                          {engineer.skills.map((key) => (
                            <span key={key} className="tbl__inline">
                              <Icon name={skillIcon(key)} size={13} />
                              {skillName(key)}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td>
                        {/* Одно слово и знак «почему»: значок транспорта перед
                            словом говорил то же, что слово, и ячейка читалась
                            дважды. */}
                        {engineer.transport ? (
                          <span className="tbl__inline">
                            {transportName(engineer.transport)}
                            <WhyMark text={transportWhy(engineer.transport)} />
                          </span>
                        ) : (
                          <span className="tbl__muted">Не указан</span>
                        )}
                      </td>
                      <td className="tbl__num">
                        {hhmm(engineer.shiftStart)}–{hhmm(engineer.shiftEnd)}
                      </td>
                      <td>{engineer.phone ?? <span className="tbl__muted">—</span>}</td>
                      <td className="tbl__num">{engineer.runs}</td>
                      <td className="tbl__num">{engineer.routes}</td>
                      <td className="tbl__num">{engineer.visits}</td>
                      <td className="tbl__num">{hoursText(engineer.travelMinutes)}</td>
                      <td className="tbl__num">{hoursText(engineer.workMinutes)}</td>
                      <td className="tbl__num">
                        {engineer.overtimeMinutes > 0 ? (
                          <span className="tbl__warn">{hoursText(engineer.overtimeMinutes)}</span>
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={'pill pill--' + (engineer.occupancyMean < loose ? 'idle' : 'success')}
                        >
                          {percent(engineer.occupancyMean)}
                        </span>
                      </td>
                      <td className="tbl__num">
                        {engineer.idleRuns > 0 ? (
                          <span className="tbl__warn">{engineer.idleRuns}</span>
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : mode === 'cards' ? (
        <div
          className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
          style={{ '--per-row': perRow } as React.CSSProperties}
        >
          {rows.map((engineer, index) => {
            const worked = workedBy.get(engineer.id) ?? { work: 0, travel: 0 };
            return (
              <EngineerCard
                key={engineer.id}
                row={engineer}
                clashQuiet={clashAll}
                seat={index + 1}
                onOpen={() => setOpened(engineer)}
                photo={photos.get(engineer.id)}
                dense={dense}
                skills={picks}
                workedMinutes={worked.work + worked.travel}
                workMinutes={worked.work}
                travelMinutes={worked.travel}
              />
            );
          })}
        </div>
      ) : (
        /* Список — вид по умолчанию: инженер — строка, лицо слева. Числа те
           же, по которым его ищут в карточке, — сколько отработал и не
           выходил ли впустую; навыки и транспорт ушли в подпись, потому что
           это не числа и колонкой не читаются. Щелчок открывает профиль, как
           и карточка. */
        <DbList
          lead="Инженер"
          rows={rows.map((engineer) => {
            const team = crewTeam(engineer);
            return {
              key: engineer.id,
              lead: <img src={photos.get(engineer.id)} alt="" loading="lazy" />,
              code: engineer.code,
              title: (
                <>
                  <PersonName name={engineer.name} stacked={false} />
                  {clashMark(engineer)}
                </>
              ),
              sub: (
                <>
                  {engineer.skills.map((key) => skillName(key)).join(' · ') || 'без навыков'}
                  {engineer.transport ? ` · ${transportName(engineer.transport)}` : ''}
                  {team ? ` · бригада ${team}` : ''}
                  {engineer.posts.length > 0
                    ? ` · ${listWords(engineer.posts.map((post) => post.zone))}`
                    : ''}
                  {` · смена ${hhmm(engineer.shiftStart)}–${hhmm(engineer.shiftEnd)}`}
                </>
              ),
              cells: [
                { label: 'Смен', value: `${engineer.routes}/${engineer.runs}` },
                { label: 'Заявок', value: engineer.visits },
                { label: 'В работе', value: hoursText(engineer.workMinutes) },
                { label: 'В дороге', value: hoursText(engineer.travelMinutes) },
                {
                  label: 'Занятость',
                  value: percent(engineer.occupancyMean),
                  tone: engineer.occupancyMean < loose ? ('warn' as const) : undefined
                },
                {
                  label: 'Без маршрута',
                  value: engineer.idleRuns > 0 ? engineer.idleRuns : '—',
                  tone: engineer.idleRuns > 0 ? ('warn' as const) : ('muted' as const)
                }
              ],
              onOpen: () => setOpened(engineer)
            };
          })}
        />
      )}

      <DbCrewProfile
        crew={opened}
        registry={registry}
        onClose={() => setOpened(null)}
        onOpenRun={(id) => {
          setOpened(null);
          onOpenRun(id as RunId);
        }}
        onOpenMap={(id) => {
          setOpened(null);
          onOpenMap(id as RunId);
        }}
        onTrack={(id) => {
          /* Следить некуда — карточка остаётся и объясняет почему. */
          const miss = onTrack(id);
          if (typeof miss !== 'string') setOpened(null);
          return miss;
        }}
        onChanged={onChanged}
      />
    </div>
  );
}
