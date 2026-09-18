import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { EngineerRecord, Registry } from '../../data/registry.ts';
import { dec, hhmm, hoursText, plural, visits as pluralVisits } from '../../data/derive.ts';
import {
  skillIcon,
  skillName,
  teamName,
  transportIcon,
  transportName
} from '../../data/dictionary.ts';
import { photosFor } from '../../data/photos.ts';
import { EngineerCard } from '../../app/EngineerCard.tsx';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { service } from '../../data/service.ts';
import { DbHead } from './DbHead.tsx';
import { CrewProfile } from '../../app/CrewProfile.tsx';
import { editCrew, removeCrew } from '../../data/crew.ts';
import { loadPlaces } from '../../data/load.ts';
import type { RunId } from '../../data/load.ts';
import type { Place } from '../../data/load.ts';
import { transportWhy } from '../../data/rationale.ts';
import { WhyMark } from '../../app/WhyMark.tsx';
import { PersonName } from '../../app/PersonName.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Данные штата поправили: справочник надо собрать заново. */
  onChanged: () => void;
  /** «Отследить» из профиля: увести в мониторинг за конкретным инженером. */
  onTrack: (id: string) => void;
  /** Уйти в расчёт заявки, открытой из профиля, и показать её на карте. */
  onOpenRun: (id: RunId) => void;
  onOpenMap: (id: RunId) => void;
}

/* Плотность строки — тот же выбор, что и в базе расчётов: «разглядеть» или
   «охватить». По две и по четыре карточка живёт целиком: ряд смен, цифры,
   навыки. По шесть она сжимается до строки справочника — кто, насколько
   загружен и сколько смен отработал; ряд смен в такой ширине не читается, и
   его там нет. */
const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* По чему упорядочены инженеры. Первым идёт порядок по визитам — это ответ на
   «кто везёт смену»; остальные правила отвечают на «кто перегружен», «кто
   простаивает» и «где искать по фамилии».

   Все правила, кроме алфавитного, открываются «от большего»: самые загруженные
   сверху. Повторный щелчок по выбранному правилу переворачивает порядок —
   привычка из таблиц, здесь она работает так же. */
type Sort = 'visits' | 'occupancy' | 'idle' | 'overtime' | 'name';

const SORTS: { value: Sort; label: string; desc: boolean }[] = [
  { value: 'visits', label: 'По визитам', desc: true },
  { value: 'occupancy', label: 'По занятости', desc: true },
  { value: 'idle', label: 'По простоям', desc: true },
  { value: 'overtime', label: 'По переработке', desc: true },
  { value: 'name', label: 'По алфавиту', desc: false }
];

/* Отбор по тому, как инженер отработал: остался ли кто-то без работы и не
   перегружен ли кто-то сверх меры. Это два вопроса, ради которых в справочник
   и заглядывают — «кого недогрузили» и «кого пора разгрузить». */
type Filter = 'all' | 'idle' | 'busy' | 'loose';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'idle', label: 'Есть простои' },
  { value: 'busy', label: 'Занятость выше 75 %' },
  { value: 'loose', label: 'Занятость ниже 60 %' }
];

/* База инженеров: весь штат, а не смена одного прогона. Устроена как база
   расчётов — поиск, отбор, порядок, плотность и доска виджетов сверху, — и
   это осознанное повторение: два справочника об одном хозяйстве, и переучивать
   диспетчера на втором незачем. */
export function DbEngineersScreen({
  registry,
  mode,
  onChanged,
  onTrack,
  onOpenRun,
  onOpenMap
}: Props) {
  /* С какой плотности открывается база — настройка сервиса, общая с базой
     расчётов: одному важно разглядеть, другому охватить. */
  const [perRow, setPerRow] = useState(() => service().perRow as string);
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
  /* Чей профиль открыт. Правка живёт внутри того же окна — кнопка «Править»
     переключает часть профиля в форму, а не открывает второе окно поверх
     первого. */
  const [opened, setOpened] = useState<EngineerRecord | null>(null);
  /* Участки со своими офисами и рамками дня: из них выбирают в форме правки,
     и они же задают человеку адрес выезда и часы. */
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadPlaces()
      .then((list) => !cancelled && setPlaces(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const all = registry.engineers;

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
     полосе отбора отвечали бы на вопрос, который задают одной строкой. Номер
     сам говорит, что он такое: C — клиент, M — маршрут, R с четырьмя знаками
     — заявка, R с тремя — расчёт. Поэтому здесь одно поле, а разбор номера
     берёт на себя указатель.

     Строится он один раз на весь справочник и переживает набор строки по
     букве: перебирать двести заявок на каждое нажатие клавиши незачем. */
  const byNumber = useMemo(() => {
    const index = new Map<string, Set<string>>();
    const put = (key: string, engineerId: string | null) => {
      if (!key || !engineerId) return;
      const low = key.toLowerCase();
      const cell = index.get(low) ?? new Set<string>();
      cell.add(engineerId);
      index.set(low, cell);
    };

    /* Заявка и клиент опознают исполнителя через саму заявку: кто её вёз, тот
       и ездил по этому адресу. Заявка, оставшаяся без инженера, в указатель
       не попадает — по её номеру искать некого. */
    const clientCodeByKey = new Map(registry.clients.map((client) => [client.key, client.code]));
    for (const order of registry.orders) {
      put(order.id, order.engineerId);
      const clientKey = order.address ?? `${order.district} · ${order.lat},${order.lon}`;
      put(clientCodeByKey.get(clientKey) ?? '', order.engineerId);
    }
    for (const route of registry.routes) {
      put(route.code, route.engineerId);
      /* Расчёт — это все, кто получил в нём маршрут. Вышедшие на смену, но
         оставшиеся без работы, сюда не идут: по номеру расчёта ищут тех, кто
         в нём ездил. */
      put(route.run.code, route.engineerId);
    }
    return index;
  }, [registry]);

  /* Что за номер набрали — для строки-подсказки под полем. Разбирается по
     первой букве и длине: C — клиент, M — маршрут, R с четырьмя знаками —
     заявка, R с тремя — расчёт. Этого хватает: ни один из четырёх видов
     номеров не выглядит как другой. */
  const hit = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const found = byNumber.get(needle);
    if (!found) return null;

    const code = needle.toUpperCase();
    const digits = needle.length - 1;
    const what = needle.startsWith('c')
      ? { text: `клиент ${code}`, icon: 'user' }
      : needle.startsWith('m')
        ? { text: `маршрут ${code}`, icon: 'path' }
        : needle.startsWith('r') && digits >= 4
          ? { text: `заявка ${code}`, icon: 'clipboard-list' }
          : { text: `расчёт ${code}`, icon: 'stack' };

    return {
      icon: what.icon,
      text: `${what.text} — ${plural(found.size, 'инженер', 'инженера', 'инженеров')}`
    };
  }, [byNumber, query]);

  /* Отбор и порядок считаем один раз на оба вида: карточки и таблица должны
     показывать одну и ту же выборку, иначе переключение вида молча меняет
     набор. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    /* Набранное — номер из указателя? Тогда он и решает, кого показать: у
       номера один правильный ответ, и подмешивать к нему совпадения по
       фамилии значило бы прятать этот ответ среди чужих. */
    const byCode = needle ? byNumber.get(needle) : undefined;
    const picked = all.filter((row) => {
      if (picks.length > 0 && !picks.every((key) => row.skills.includes(key))) return false;
      if (filter === 'idle' && row.idleRuns === 0) return false;
      if (filter === 'busy' && row.occupancyMean < 0.75) return false;
      if (filter === 'loose' && row.occupancyMean >= 0.6) return false;
      if (!needle) return true;
      if (byCode) return byCode.has(row.id);
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
  }, [all, byNumber, desc, filter, picks, query, sort]);

  /* Повторный щелчок по выбранному правилу переворачивает порядок; щелчок по
     другому — переключает правило и берёт его сторону по умолчанию. */
  const pickSort = (value: Sort) => {
    if (value === sort) {
      setDesc((prev) => !prev);
      return;
    }
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? true);
  };

  /* Стрелка стоит только у выбранного правила: у остальных она обещала бы
     сторону, которой они сейчас не задают. */
  const sortItems = SORTS.map((item) => ({
    value: item.value,
    label:
      item.value === sort ? (
        <>
          {item.label}
          <Icon name={desc ? 'chevron-down' : 'chevron-up'} size={11} />
        </>
      ) : (
        item.label
      )
  }));

  /* Срок, за который считает доска. Отдельно от отбора списка: список отвечает
     на «кого показать», доска — на «за какой срок считать». Общим
     переключателем поиск по фамилии менял бы диаграммы, а смена срока — прятала
     бы людей из штата, которые никуда не делись. */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const runsIn = (key: PeriodKey) =>
    registry.runs.filter((run) => withinPeriod(run.created, key));

  /* Срез: смены, попавшие в срок. Инженеры остаются все — штат от срока не
     меняется, — а вот их выработка считается только по прогонам срока. */
  const scope = useMemo(() => {
    const shifts = all.flatMap((row) =>
      row.byRun
        .filter((shift) => withinPeriod(shift.created, period))
        .map((shift) => ({ engineer: row, shift }))
    );
    const runIds = new Set(shifts.map((item) => item.shift.runId));
    return { shifts, runs: runIds.size };
  }, [all, period]);

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

    /* Кто в срок выезжал хоть раз, а кто ни разу: «инженеров в штате» и
       «инженеров с маршрутом» — разные числа, и разница между ними и есть
       ответ на «кем мы не воспользовались». */
    const people = new Set(shifts.map((item) => item.engineer.id));
    const crewed = new Set(worked.map((item) => item.engineer.id));
    const idlePeople = [...people].filter((id) => !crewed.has(id)).length;

    const perRun = (value: number) => value / Math.max(scope.runs, 1);
    const top = <T,>(list: T[], size = 4) => list.slice(0, size);

    /* Ряд по прогонам: смены разложены по расчётам, чтобы «сколько всего» и
       «как менялось» считались из одного места. */
    const byRun = new Map<
      string,
      { code: string; created: string; visits: number; travel: number; idle: number; crew: number }
    >();
    for (const { shift } of shifts) {
      const cell =
        byRun.get(shift.runId) ??
        { code: shift.code, created: shift.created, visits: 0, travel: 0, idle: 0, crew: 0 };
      cell.visits += shift.visits;
      cell.travel += shift.travelMinutes;
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
    const byOvertime = top(
      [...persons].sort((a, b) => b.overtime - a.overtime).filter((one) => one.overtime > 0)
    );
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
        key: 'hours',
        title: 'Отработано часов',
        note: 'Время инженеров за выбранный срок: работа на объектах и дорога между ними',
        shape: 'number',
        data: {
          /* Отработанным считается и дорога тоже: инженер в пути занят так
             же, как инженер у щитка, и час езды через город из смены не
             вычитается. Разложено рядом, чтобы это читалось, а не
             предполагалось. */
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
          series: series((cell) => cell.travel),
          legend: 'минут в дороге'
        }
      },
      {
        key: 'people',
        title: 'Инженеров',
        note: 'Сколько человек выходило в смену и скольким досталась работа',
        shape: 'number',
        data: {
          value: String(all.length),
          caption: 'в штате',
          facts: [`${crewed.size} выезжали за срок`, `${idlePeople} ни разу`],
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
        title: 'Визитов',
        note: 'Сколько визитов инженеры отработали и как это менялось',
        shape: 'number',
        data: {
          value: String(visits),
          caption: 'отработано',
          facts: [
            `${dec(visits / Math.max(worked.length, 1))} на смену`,
            `${Math.round(perRun(visits))} на расчёт`
          ],
          series: series((cell) => cell.visits),
          legend: 'визитов'
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
          tone: occupancy >= 0.75 ? 'bad' : 'neutral',
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
        key: 'work',
        title: 'В работе',
        note: 'Сколько часов инженеры провели на объектах',
        shape: 'number',
        data: {
          value: dec(work / 60),
          unit: 'ч',
          caption: 'на объектах',
          facts: [`${dec(work / 60 / Math.max(worked.length, 1))} ч на смену`],
          legend: 'часов работы'
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
          caption: 'по всем сменам',
          facts: [
            `${dec(travel / 60 / Math.max(worked.length, 1))} ч на смену`,
            `${percent(travel / Math.max(travel + work, 1))} от времени в маршруте`
          ],
          whole: true,
          parts: [
            { key: 'work', label: 'На объектах', value: Math.round(work), tone: 'ok' },
            { key: 'travel', label: 'В дороге', value: Math.round(travel), tone: 'warn' }
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
          value: dec(overtime / 60),
          unit: 'ч',
          caption: 'сверх графика',
          tone: overtime > 0 ? 'bad' : 'ok',
          facts: [`${byOvertime.length > 0 ? byOvertime.length : 0} человек с переработкой`],
          parts: byOvertime.map((one) => ({
            key: one.row.id,
            label: one.row.name,
            value: Math.round(one.overtime),
            text: hoursText(one.overtime),
            tone: 'bad' as const
          })),
          legend: byOvertime.length > 0 ? 'минут сверх смены' : 'переработки нет'
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
        title: 'Больше всех визитов',
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
          legend: 'визитов за срок'
        }
      },
      {
        key: 'idle-people',
        title: 'Чаще всех без маршрута',
        note: 'Кого движок не берёт в план — и сколько раз',
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
  }, [scope, registry, all]);

  /* Пять плиток по умолчанию — ровно те числа, что раньше стояли в шапке
     строкой. Шестое место в ряду остаётся под плюс: доска сразу показывает,
     что набор можно менять, и не заставляет искать, чем. */
  const board = useWidgetBoard({
    storeKey: 'db-engineers',
    catalogue: widgets,
    fallback: ['hours', 'people', 'shifts', 'visits', 'occupancy'],
    filter: (
      <WidgetPeriod value={period} onChange={setPeriod} countOf={(key) => runsIn(key).length} />
    )
  });

  return (
    <div className="dash enter">
      {/* Числа шапки и есть доска: отдельным блоком «что иллюстрируем» они
          спорили бы сами с собой — два ряда об одном и том же, один выбран за
          диспетчера, другой им самим. */}
      {/* Полоса управления выборкой стоит в шапке базы, под её заголовком, и
          разложена столбиком «подпись — орган»: подписи выстроены в колонку,
          переключатели начинаются от одной черты. Порядок — по смыслу: сперва
          всё, что сужает выборку (отбор и навыки), потом то, как её показать.
          Наверху — поиск и плотность: это не отбор, а то, с какой стороны на
          список смотрят. */}
      <DbHead title="База инженеров" board={board.node}>
        <div className="filters filters--runs">
          <div className="filters__top">
            <label className="dbsearch">
              <Icon name="search" size={14} />
              <input
                className="dbsearch__input"
                value={query}
                placeholder="Фамилия, табельный, навык или номер: заявки, маршрута, расчёта, клиента"
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
              {query && (
                <button type="button" className="dbsearch__clear" onClick={() => setQuery('')}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </label>

            {/* Что распознали в набранном. Без этой строки поиск по номеру
                молчалив до неотличимости от поломки: набрал «M0010», список
                сузился до одного человека — и непонятно, нашёлся он по
                маршруту или случайно совпал с чем-то в имени. */}
            {hit && (
              <span className="dbsearch__hit">
                <Icon name={hit.icon} size={12} />
                {hit.text}
              </span>
            )}

            {/* Плотность строки — только у карточек: в таблице строка одна и в
                строке она одна. */}
            {mode !== 'table' && (
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
              onChange={(value: string) => setFilter(value as Filter)}
            />
          </div>

          <div
            className="filters__group"
            title="Щелчок по выбранному правилу переворачивает порядок"
          >
            <span className="filters__label">Сортировка</span>
            <SegmentedControl
              size="sm"
              items={sortItems}
              value={sort}
              onChange={(value: string) => pickSort(value as Sort)}
            />
          </div>

          {/* Навыки — отдельной строкой во всю ширину: их полтора десятка, и
              рядом с переключателями они сминали бы полосу. Отбор здесь тот
              же, что и по щелчку на навыке в карточке. */}
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
        </div>
      </DbHead>

      {rows.length === 0 ? (
        <section className="panel">
          <p className="clients__lede">
            Под этот отбор не подошёл ни один инженер. Снимите фильтр, сбросьте навык или очистите
            поиск.
          </p>
        </section>
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
                  <th>Визитов</th>
                  <th>В дороге</th>
                  <th>В работе</th>
                  <th>Сверх смены</th>
                  <th>Занятость</th>
                  <th>Без маршрута</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((engineer) => (
                  <tr key={engineer.id} className="tbl__row">
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
                          <span className="tbl__sub">{engineer.id}</span>
                        </span>
                      </span>
                    </td>
                    <td>{engineer.team ? teamName(engineer.team) : <span className="tbl__muted">—</span>}</td>
                    <td>
                      {engineer.posts.length > 0 ? (
                        engineer.posts.map((post) => post.zone).join(' · ')
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
                      {engineer.transport ? (
                        <span className="tbl__inline">
                          <Icon name={transportIcon(engineer.transport)} size={13} />
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
                        className={'pill pill--' + (engineer.occupancyMean < 0.6 ? 'idle' : 'success')}
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
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
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
      )}

      {/* Итог выборки под списком — тот же приём, что во всех справочниках:
          сверху доска отвечает на «как дела вообще», здесь строка отвечает на
          «а что сейчас на экране». Числа выбраны по вопросу самой базы: кто у
          нас есть, сколько они отработали и сколько раз выходили впустую. */}
      {rows.length > 0 && (
        <p className="filters__note filters__note--under">
          {plural(rows.length, 'инженер', 'инженера', 'инженеров')} в выборке
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
        </p>
      )}

      <CrewProfile
        crew={opened}
        registry={registry}
        places={places}
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
          setOpened(null);
          onTrack(id);
        }}
        onSave={(patch) => {
          if (!opened) return;
          editCrew(opened.id, patch);
          onChanged();
        }}
        onDelete={() => {
          if (!opened) return;
          removeCrew(opened.id);
          setOpened(null);
          onChanged();
        }}
      />
    </div>
  );
}
