import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry } from '../../data/registry.ts';
import { deadline, hhmm, hoursText, plural, shortName } from '../../data/derive.ts';
import {
  isUrgent,
  orderClassName,
  orderClosed,
  priorityClassName,
  skillShort,
  statusName,
  techName,
  workTypeIcon
} from '../../data/dictionary.ts';
import { OrderCard } from '../../app/OrderCard.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { fitsWork, WorkTypeFilter } from '../../app/WorkTypeFilter.tsx';
import { OrderProfile } from '../../app/OrderProfile.tsx';
import { topWithRest, useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { DbHead, DENSITY, usePerRow } from './DbHead.tsx';
import { DbBar, ChipKey, DbEmpty, DbMore, usePaging } from './DbBar.tsx';
import type { DbChip } from './DbBar.tsx';
import { DbList } from './DbList.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Уйти в расчёт заявки — из открытой карточки. */
  onOpenRun: (runId: string) => void;
  /** Показать расчёт заявки на карте. */
  onOpenMap: (runId: string) => void;
}

/* Сколько карточек и строк отдаём в разметку за раз. В архиве из двух
   десятков расчётов заявок под две тысячи: браузер такую таблицу рисует
   целиком и потом на ней же спотыкается при прокрутке. */
const PAGE = 120;

/* По чему упорядочены заявки. Первым — крайний срок: это ответ на «что горит».

   У каждого правила названы обе стороны, и названы по-своему: «сначала
   ближний срок» диспетчер понимает сразу, а «по возрастанию» ему пришлось бы
   переводить на заявки. Повторное нажатие на выбранное правило
   переворачивает сторону. */
type Sort = 'deadline' | 'window' | 'duration' | 'district' | 'run';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'deadline',
    label: 'По сроку',
    note: 'Что горит',
    desc: false,
    up: 'Сначала ближайший срок',
    down: 'Сначала дальний срок'
  },
  {
    value: 'window',
    label: 'По окну приёма',
    note: 'Во сколько заявку ждут',
    desc: false,
    up: 'Сначала ранние окна',
    down: 'Сначала поздние окна'
  },
  {
    value: 'duration',
    label: 'По длительности',
    note: 'Сколько занимает работа',
    desc: true,
    up: 'Сначала короткие работы',
    down: 'Сначала долгие работы'
  },
  {
    value: 'district',
    label: 'По району',
    note: 'Заявки одного района подряд',
    desc: false,
    up: 'Районы от А до Я',
    down: 'Районы от Я до А'
  },
  {
    value: 'run',
    label: 'По расчёту',
    note: 'Заявки одного расчёта подряд',
    desc: false,
    up: 'От первого расчёта к последнему',
    down: 'От последнего расчёта к первому'
  }
];

/* Отбор по тому, как заявка отработана: кому не досталось инженера, что горит
   и куда без ключей не попасть. Это те вопросы, ради которых в базу заявок и
   заглядывают. */
type Filter = 'all' | 'free' | 'routed' | 'urgent' | 'access' | 'tight';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'free', label: 'Без инженера' },
  { value: 'routed', label: 'В маршруте' },
  { value: 'urgent', label: 'Срочные' },
  { value: 'access', label: 'Нужен доступ' },
  { value: 'tight', label: 'Без запаса' }
];

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* Отметка полосы видов работ словами — для чипа наверху. Ключ дозаказов
   устроен иначе, чем вид работ (см. `addonKey`), и подписывается по своему
   навыку. */
function pickLabel(key: string, titles: Record<string, string>): string {
  const addon = /^class:addon@(.+)$/.exec(key);
  if (addon) return `Дозаказы · ${skillShort(addon[1])}`;
  return titles[key] ?? key;
}

/* База заявок: все заявки, прошедшие через расчёты. Строка — заявка в одном
   расчёте: номера в прогонах повторяются, но стоят за ними разные точки, окна
   и инженеры, поэтому расчёт указан у каждой записи.

   Устроена как остальные базы — доска виджетов со сроком сверху, полоса
   отбора, список, карточки или таблица, — и это осознанное повторение: шесть
   справочников об одном хозяйстве, и переучивать диспетчера на каждом
   незачем. */
export function DbOrdersScreen({ registry, mode, onOpenRun, onOpenMap }: Props) {
  const [perRow, setPerRow] = usePerRow();
  const [sort, setSort] = useState<Sort>('deadline');
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  /* Отмеченные виды работ. Отметок может быть несколько, и они складываются:
     вид работ у заявки один, и «то и это» через «и» дало бы пустой список.
     Пусто — показаны все. */
  const [picks, setPicks] = useState<string[]>([]);
  const [run, setRun] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const paging = usePaging(PAGE);
  /* Какая заявка открыта. Карточка одна на всю базу: двух сразу не читают. */
  const [opened, setOpened] = useState<OrderRecord | null>(null);
  const dense = perRow === '6';

  const all = registry.orders;

  /* В каких расчётах встречается каждый номер. Считаем один раз на всю базу:
     карточка видит одну строку и о соседних прогонах не знает. */
  const runsById = useMemo(() => {
    const map = new Map<string, { runId: string; code: string }[]>();
    for (const order of all) {
      const list = map.get(order.id) ?? [];
      if (!list.some((ref) => ref.runId === order.run.id)) {
        list.push({ runId: order.run.id, code: order.run.code });
      }
      map.set(order.id, list);
    }
    return map;
  }, [all]);

  /* Выборка без учёта видов работ. По ней считается разбивка «По видам
     работ»: иначе доска сужала бы сама себя — отметив один вид, второй с
     неё стало бы нечем добавить. */
  const basis = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return all.filter((order) => {
      if (run && order.run.id !== run) return false;
      if (filter === 'free' && order.engineerId) return false;
      if (filter === 'routed' && !order.engineerId) return false;
      if (filter === 'urgent' && !isUrgent(order.priorityClass, order.priority)) return false;
      if (filter === 'access' && !order.needsAccess) return false;
      if (filter === 'tight' && order.slaDeadline - order.windowEnd > 0) return false;
      if (!needle) return true;
      return (
        order.id.toLowerCase().includes(needle) ||
        order.address.toLowerCase().includes(needle) ||
        order.district.toLowerCase().includes(needle) ||
        order.workTitle.toLowerCase().includes(needle) ||
        order.company.toLowerCase().includes(needle) ||
        (order.engineerName ?? '').toLowerCase().includes(needle) ||
        (order.contactName ?? '').toLowerCase().includes(needle)
      );
    });
  }, [all, filter, query, run]);

  const rows = useMemo(() => {
    const picked = basis.filter((order) => fitsWork(order, picks));

    const rank = (order: OrderRecord) => {
      switch (sort) {
        case 'window':
          return order.windowStart;
        case 'duration':
          return order.estMinutes;
        case 'district':
        case 'run':
          return 0;
        default:
          return order.slaDeadline;
      }
    };
    const side = desc ? -1 : 1;
    const tie = (a: OrderRecord, b: OrderRecord) =>
      sort === 'district'
        ? a.district.localeCompare(b.district, 'ru') || a.address.localeCompare(b.address, 'ru')
        : sort === 'run'
          ? a.run.code.localeCompare(b.run.code) || a.id.localeCompare(b.id)
          : a.id.localeCompare(b.id);

    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : tie(a, b));
    });
  }, [basis, desc, picks, sort]);

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

  /* Смена правила заодно ставит сторону, с которой его читают чаще: у срока
     это ближний, у длительности — долгие работы. Повторное нажатие на
     выбранное правило переворачивает сторону — это делает само меню. */
  const pickSort = (value: Sort) => {
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? false);
    paging.reset();
  };

  const reset = () => {
    setFilter('all');
    setPicks([]);
    setRun(null);
    setQuery('');
    paging.reset();
  };

  /* Срок, за который считает доска. Отдельно от отбора списка: список отвечает
     на «какие заявки показать», доска — на «за какой срок считать». */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const runsIn = (key: PeriodKey) =>
    registry.runs.filter((one) => withinPeriod(one.created, key));

  /* Срез: заявки расчётов, попавших в срок. */
  const scope = useMemo(() => {
    const list = all.filter((order) => withinPeriod(order.run.created, period));
    const runIds = new Set(list.map((order) => order.run.id));
    return { list, runs: runIds.size };
  }, [all, period]);

  const widgets = useMemo<WidgetDef[]>(() => {
    const list = scope.list;
    const assigned = list.filter((order) => order.engineerId);
    const free = list.length - assigned.length;
    const urgent = list.filter((order) => isUrgent(order.priorityClass, order.priority));
    const access = list.filter((order) => order.needsAccess);
    const tight = list.filter((order) => order.slaDeadline - order.windowEnd <= 0);
    const minutes = list.reduce((sum, order) => sum + order.estMinutes, 0);
    const perRun = (value: number) => value / Math.max(scope.runs, 1);
    const top = <T,>(items: T[], size = 6) => items.slice(0, size);

    /* Ряд по расчётам: заявки разложены по прогонам, чтобы «сколько всего» и
       «как менялось» считались из одного места. Ряд всегда хронологический. */
    const byRun = new Map<
      string,
      { code: string; created: string; total: number; assigned: number; minutes: number }
    >();
    for (const order of list) {
      const cell =
        byRun.get(order.run.id) ??
        { code: order.run.code, created: order.run.created, total: 0, assigned: 0, minutes: 0 };
      cell.total += 1;
      if (order.engineerId) cell.assigned += 1;
      cell.minutes += order.estMinutes;
      byRun.set(order.run.id, cell);
    }
    const runCells = [...byRun.values()].sort((a, b) => a.created.localeCompare(b.created));
    const series = (pick: (cell: (typeof runCells)[number]) => number) =>
      runCells.map((cell) => ({ label: cell.code, value: pick(cell) }));

    /* Разбивки по колонкам выгрузки. Считаются одинаково — «сколько заявок в
       каждом значении», — поэтому и собираются одной мерой. */
    const count = (of: (order: OrderRecord) => string | null) => {
      const map = new Map<string, number>();
      for (const order of list) {
        const key = of(order);
        if (!key) continue;
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return [...map.entries()].sort((a, b) => b[1] - a[1]);
    };

    const byType = count((order) => order.workType);
    const byDistrict = count((order) => order.district);
    const byStatus = count((order) => order.status);
    const byTech = count((order) => order.tech);
    const byClass = count((order) => order.orderClass);

    /* Окна приёма по частям дня: «во сколько её ждут» — вопрос не о часе, а о
       половине дня, и три полосы отвечают на него точнее, чем средняя. */
    const partsOfDay = [
      { key: 'morning', label: 'До 12:00', has: (m: number) => m < 12 * 60 },
      { key: 'day', label: '12:00–17:00', has: (m: number) => m >= 12 * 60 && m < 17 * 60 },
      { key: 'evening', label: 'После 17:00', has: (m: number) => m >= 17 * 60 }
    ];

    return [
      {
        key: 'orders',
        title: 'Заявок',
        note: 'Сколько заявок прошло через расчёты и скольким нашёлся инженер',
        shape: 'number',
        data: {
          value: String(list.length),
          caption: 'за срок',
          facts: [
            `${assigned.length} в маршруте`,
            `${free} без инженера`,
            `${Math.round(perRun(list.length))} на расчёт`
          ],
          whole: true,
          parts: [
            { key: 'assigned', label: 'В маршруте', value: assigned.length, tone: 'ok' },
            { key: 'free', label: 'Без инженера', value: free, tone: 'bad' }
          ],
          series: series((cell) => cell.total),
          legend: 'заявок в расчёте'
        }
      },
      {
        key: 'coverage',
        title: 'Прогноз выполнения',
        note: 'Какая доля заявок досталась инженерам',
        shape: 'number',
        data: {
          value: String(Math.round((assigned.length / Math.max(list.length, 1)) * 100)),
          unit: '%',
          caption: 'заявок в маршрутах',
          tone: free > 0 ? 'warn' : 'ok',
          facts: [`${free} ${plural(free, 'заявка', 'заявки', 'заявок').replace(/^\d+\s/, '')} без инженера`],
          series: series((cell) => Math.round((cell.assigned / Math.max(cell.total, 1)) * 100)),
          legend: 'прогноз расчёта, %'
        }
      },
      {
        key: 'work',
        title: 'Работы по заявкам',
        note: 'Сколько времени займут сами работы на объектах',
        shape: 'number',
        data: {
          value: hoursText(minutes),
          caption: 'работы на объектах',
          facts: [
            `${Math.round(minutes / Math.max(list.length, 1))} мин средняя заявка`,
            `${hoursText(perRun(minutes))} на расчёт`
          ],
          series: series((cell) => Math.round(cell.minutes / 6) / 10),
          legend: 'часов работы в расчёте'
        }
      },
      {
        key: 'free',
        title: 'Без инженера',
        note: 'Сколько заявок осталось никому и в каких видах работ',
        shape: 'number',
        data: {
          value: String(free),
          caption: 'заявок никому не досталось',
          tone: free > 0 ? 'bad' : 'ok',
          facts: [`${percent(free / Math.max(list.length, 1))} от всех заявок`],
          series: series((cell) => cell.total - cell.assigned),
          legend: 'заявок без инженера'
        }
      },
      {
        key: 'urgent',
        title: 'Срочных',
        note: 'Сколько заявок помечено срочными в выгрузке',
        shape: 'number',
        data: {
          value: String(urgent.length),
          caption: 'срочных заявок',
          tone: urgent.length > 0 ? 'warn' : 'neutral',
          facts: [
            `${percent(urgent.length / Math.max(list.length, 1))} от всех`,
            `${urgent.filter((order) => !order.engineerId).length} из них без инженера`
          ],
          whole: true,
          parts: [
            { key: 'urgent', label: 'Срочные', value: urgent.length, tone: 'bad' },
            {
              key: 'normal',
              label: 'Обычные',
              value: list.length - urgent.length,
              tone: 'ok'
            }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'access',
        title: 'Нужен доступ',
        note: 'Куда не попасть без хозяина или ключей от помещения',
        shape: 'number',
        data: {
          value: String(access.length),
          caption: 'заявок требуют доступа',
          facts: [`${percent(access.length / Math.max(list.length, 1))} от всех`],
          whole: true,
          parts: [
            { key: 'access', label: 'Нужен доступ', value: access.length, tone: 'warn' },
            {
              key: 'open',
              label: 'Не нужен',
              value: list.length - access.length,
              tone: 'ok'
            }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'tight',
        title: 'Без запаса',
        note: 'У скольких заявок крайний срок совпал с концом окна приёма — переносить их некуда',
        shape: 'number',
        data: {
          value: String(tight.length),
          caption: 'заявок без запаса',
          tone: tight.length > 0 ? 'bad' : 'ok',
          facts: [`${percent(tight.length / Math.max(list.length, 1))} от всех`],
          legend: 'заявок без запаса'
        }
      },
      {
        key: 'types',
        title: 'Виды работ',
        note: 'Чем вообще заняты инженеры: заявки по видам работ',
        shape: 'bars',
        data: {
          value: String(byType.length),
          caption: 'видов работ в базе',
          parts: top(byType).map(([key, value]) => ({
            key,
            label: registry.workTypeTitle[key] ?? key,
            value
          })),
          legend: 'заявок вида'
        }
      },
      {
        key: 'districts',
        title: 'Районы',
        note: 'Где заявок больше всего',
        shape: 'bars',
        data: {
          value: String(byDistrict.length),
          caption: 'районов в базе',
          parts: top(byDistrict).map(([key, value]) => ({ key, label: key, value })),
          legend: 'заявок в районе'
        }
      },
      {
        key: 'windows',
        title: 'Окна приёма',
        note: 'На какую половину дня заявки просятся',
        shape: 'bars',
        data: {
          value: String(list.length),
          caption: 'заявок разложено по дню',
          whole: true,
          parts: partsOfDay.map((part) => ({
            key: part.key,
            label: part.label,
            value: list.filter((order) => part.has(order.windowStart)).length
          })),
          legend: 'заявок в полосе дня'
        }
      },
      {
        key: 'status',
        title: 'Состояние заявок',
        note: 'Что говорит о заявках учётная система: статус заявки из выгрузки',
        shape: 'bars',
        data: {
          value: String(byStatus.length),
          caption: 'состояний в выгрузке',
          parts: top(byStatus).map(([key, value]) => ({ key, label: statusName(key), value })),
          legend: byStatus.length > 0 ? 'заявок в состоянии' : 'состояний в выгрузке нет'
        }
      },
      {
        key: 'classes',
        title: 'Классы заявок',
        note: 'Как заявку называет учётная система: подключение, дозаказ, инцидент, авария',
        shape: 'bars',
        data: {
          value: String(byClass.length),
          caption: 'классов в выгрузке',
          /* Классы складываются в целое, и кольцо у них честное только тогда,
             когда в нём все классы: верхушка списка дополняется сектором
             «прочее». */
          whole: true,
          parts: topWithRest(
            byClass.map(([key, value]) => ({ key, label: orderClassName(key), value })),
            6,
            'Другие классы'
          ),
          legend: byClass.length > 0 ? 'заявок класса' : 'классов в выгрузке нет'
        }
      },
      {
        key: 'tech',
        title: 'Технологии',
        note: 'По какой технологии подключён адрес: FMC, FTTB, GPON',
        shape: 'bars',
        data: {
          value: String(byTech.reduce((sum, [, value]) => sum + value, 0)),
          caption: 'заявок с указанной технологией',
          parts: top(byTech).map(([key, value]) => ({ key, label: techName(key), value })),
          legend: byTech.length > 0 ? 'заявок' : 'технология в выгрузке не указана'
        }
      }
    ];
  }, [scope, registry]);

  const board = useWidgetBoard({
    storeKey: 'db-orders',
    catalogue: widgets,
    fallback: ['orders', 'coverage', 'work', 'urgent', 'access'],
    filter: (
      <WidgetPeriod value={period} onChange={setPeriod} countOf={(key) => runsIn(key).length} />
    )
  });

  /* Разбивка по видам работ считается по выборке без учёта самих видов работ:
     отбор по расчёту, поиску и состоянию картину меняет — она об этой
     выборке, — а отметка вида работ оставила бы на доске одну плитку, и
     добавить с неё второй вид стало бы нечем. */
  const breakdown = useMemo(() => {
    const map = new Map<string, { key: string; total: number; assigned: number; minutes: number }>();
    for (const order of basis) {
      const entry = map.get(order.workType) ?? {
        key: order.workType,
        total: 0,
        assigned: 0,
        minutes: 0
      };
      entry.total += 1;
      if (order.engineerId) entry.assigned += 1;
      entry.minutes += order.estMinutes;
      map.set(order.workType, entry);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [basis]);

  const shown = rows.slice(0, paging.limit);
  const hidden = rows.length - shown.length;

  /* Разбивка по расчётам для вида «По расчётам». Раскладывается вся
     выборка, а не показанная её часть: заголовок секции «7 заявок · 3,2 ч»
     — это итог расчёта под этим отбором, и считать его по первой странице
     значило бы, что итог растёт от каждого «Показать ещё». Режется только
     отрисовка — см. `byRunShown`.

     Расчёт, из которого под отбор не подошло ничего, секцией не рисуется —
     пустой заголовок с нулём обещал бы, что там что-то есть. Внутри секции
     порядок тот, что выбран в полосе: заново упорядочивать значило бы, что
     переключатель сортировки в этом виде стоит и ничего не делает. */
  const byRun = useMemo(() => {
    const picked = new Map<string, OrderRecord[]>();
    for (const order of rows) {
      const list = picked.get(order.run.id);
      if (list) list.push(order);
      else picked.set(order.run.id, [order]);
    }
    return registry.runs
      .filter((ref) => picked.has(ref.id))
      .map((ref) => {
        const list = picked.get(ref.id) ?? [];
        return {
          ref,
          orders: list,
          assigned: list.filter((one) => one.engineerId).length,
          urgent: list.filter((one) => isUrgent(one.priorityClass, one.priority)).length,
          minutes: list.reduce((sum, one) => sum + one.estMinutes, 0)
        };
      });
  }, [registry, rows]);

  /* Что из разбивки рисуем сейчас: секции идут подряд, и первая страница —
     это первые PAGE заявок по всем секциям вместе. Счётчик показанного общий
     на всю выборку: «Показать ещё» отвечает на «сколько всего осталось». */
  const byRunShown = useMemo(() => {
    let left = paging.limit;
    const out: (typeof byRun[number] & { shown: OrderRecord[] })[] = [];
    for (const entry of byRun) {
      if (left <= 0) break;
      const list = entry.orders.slice(0, left);
      left -= list.length;
      out.push({ ...entry, shown: list });
    }
    return out;
  }, [byRun, paging.limit]);

  /* Та же заявка в другом расчёте — по чипу «Есть также в» на карточке. */
  const openIn = (order: OrderRecord, runId: string) => {
    const twin = all.find((one) => one.id === order.id && one.run.id === runId);
    if (twin) setOpened(twin);
  };

  const card = (order: OrderRecord, index: number) => (
    <OrderCard
      key={order.key}
      row={order}
      seat={index + 1}
      onOpen={() => setOpened(order)}
      dense={dense}
      workType={picks}
      runs={runsById.get(order.id) ?? []}
      onOpenIn={(runId) => openIn(order, runId)}
    />
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
  for (const key of picks) {
    chips.push({
      key: `pick:${key}`,
      label: (
        <>
          <ChipKey>Вид работ</ChipKey>
          {pickLabel(key, registry.workTypeTitle)}
        </>
      ),
      onRemove: clear(() => setPicks(picks.filter((one) => one !== key)))
    });
  }

  /* Итог выборки — над списком: ответ на «что дал отбор» должен стоять
     там, где на него смотрят, а не за пятнадцатью экранами прокрутки.

     Закрытые до расчёта называем отдельно. База заявок показывает всё, что
     заведено, — и выполненное, и отменённое: она отвечает на «что у нас
     есть», а не «что сегодня разложено». Но тогда её число расходится с
     числом в остальных базах, где считаются только открытые, и расхождение
     надо объяснить прямо в строке, а не оставлять диспетчеру гадать, почему
     здесь двести пять, а у клиентов семьдесят две. */
  const openRows = rows.filter((one) => !orderClosed({ status: one.status }));
  const closedRows = rows.length - openRows.length;
  const summary = (
    <>
      <b>{plural(rows.length, 'заявка', 'заявки', 'заявок')}</b> в выборке
      {rows.length !== all.length && ` из ${all.length}`}
      {closedRows > 0 && ` · ${openRows.length} ждут выезда · ${closedRows} закрыты до расчёта`}
      {openRows.length > 0 &&
        ` · ${hoursText(openRows.reduce((sum, one) => sum + one.estMinutes, 0))} работы впереди`}
    </>
  );

  return (
    <div className="dash enter">
      <DbHead title="База заявок" board={board.node}>
        <DbBar
          query={query}
          onQuery={narrow(setQuery)}
          placeholder="Найти заявку: номер, клиент, адрес, район, работа, инженер"
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
          {/* Под кнопкой «Отбор» — сетка «подпись — орган»: сперва всё, что
              сужает выборку, потом то, как её показать. */}
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

            {/* Виды работ — тремя списками по навыку, а не рядом плашек: их
                восемнадцать, и плашками они занимали три строки полосы. */}
            <div className="filters__group filters__group--wide" role="group" aria-label="Вид работ">
              <span className="filters__label">Вид работ</span>
              <WorkTypeFilter
                orders={all}
                titles={registry.workTypeTitle}
                picks={picks}
                onChange={narrow(setPicks)}
              />
            </div>

            {/* Плотность ряда — везде, где рисуются карточки: и в сплошном
                ряду, и в разбивке по расчётам. В таблице и списке её нет —
                там строка одна и в строке она одна. */}
            {(mode === 'cards' || mode === 'runs') && (
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
          miss="Под этот отбор не подошла ни одна заявка."
          blank="Заявок в базе пока нет: они собираются из сохранённых расчётов, и до первого расчёта база пуста."
          query={query.trim() !== ''}
          filtered={filter !== 'all' || picks.length > 0 || run !== null}
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
                  {plural(entry.orders.length, 'заявка', 'заявки', 'заявок')} ·{' '}
                  {entry.assigned} в маршрутах · {entry.orders.length - entry.assigned} без
                  инженера
                  {entry.urgent > 0 ? ` · ${entry.urgent} срочных` : ''} ·{' '}
                  {hoursText(entry.minutes)} работы
                  {entry.shown.length < entry.orders.length
                    ? ` · показано ${entry.shown.length}`
                    : ''}
                </span>
              </div>
              <div
                className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
                style={{ '--per-row': perRow } as React.CSSProperties}
              >
                {entry.shown.map(card)}
              </div>
            </section>
          ))}

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      ) : mode === 'types' ? (
        <div className="cboard">
          {breakdown.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={'ccard' + (picks.includes(entry.key) ? ' ccard--selected' : '')}
              onClick={() =>
                narrow(setPicks)(
                  picks.includes(entry.key)
                    ? picks.filter((one) => one !== entry.key)
                    : [...picks, entry.key]
                )
              }
              aria-pressed={picks.includes(entry.key)}
            >
              <span className="ccard__top">
                <span className="ccard__name">
                  <Icon name={workTypeIcon(entry.key)} size={13} />{' '}
                  {registry.workTypeTitle[entry.key] ?? entry.key}
                </span>
                <span className="ccard__count">{entry.total}</span>
              </span>
              <span className="ccard__rows">
                <span className="ccard__row">
                  <span>В маршруте</span>
                  <b>{entry.assigned}</b>
                </span>
                <span className="ccard__row">
                  <span>Без инженера</span>
                  <b className={entry.total - entry.assigned > 0 ? 'ccard__bad' : undefined}>
                    {entry.total - entry.assigned}
                  </b>
                </span>
                <span className="ccard__row">
                  <span>Средняя работа</span>
                  <b>{Math.round(entry.minutes / entry.total)} мин</b>
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : mode === 'table' ? (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Заявка</th>
                  <th>Расчёт</th>
                  <th>Что делаем</th>
                  <th>Адрес</th>
                  <th>Окно приёма</th>
                  <th>Крайний срок</th>
                  <th>Работа</th>
                  <th>Класс</th>
                  <th>Технология</th>
                  <th>Доступ</th>
                  <th>Приоритет</th>
                  <th>Состояние</th>
                  <th>Клиент</th>
                  <th>Инженер</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((order) => (
                  <tr
                    key={order.key}
                    className="tbl__row tbl__row--open"
                    tabIndex={0}
                    role="button"
                    onClick={() => setOpened(order)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setOpened(order);
                      }
                    }}
                  >
                    <td>
                      <span className="tbl__strong">{order.id}</span>
                      {order.seq !== null && <span className="tbl__sub">№ {order.seq + 1} в маршруте</span>}
                    </td>
                    <td>
                      <span className="tbl__strong">{order.run.code}</span>
                      <span className="tbl__sub">{order.run.date}</span>
                    </td>
                    <td>
                      <span className="tbl__inline">
                        <Icon name={workTypeIcon(order.workType)} size={13} />
                        {order.workTitle}
                      </span>
                      {/* Код вида работ — только когда он и название разные
                          строки: в выгрузке заказчика они совпадают у всех, и
                          подстрочник повторял бы саму ячейку. */}
                      {order.workType !== order.workTitle && (
                        <span className="tbl__sub">{order.workType}</span>
                      )}
                    </td>
                    <td>
                      <span className="tbl__strong">{order.address}</span>
                      <span className="tbl__sub">{order.district}</span>
                    </td>
                    <td className="tbl__num">
                      {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                    </td>
                    <td className="tbl__num">{deadline(order.slaDeadline)}</td>
                    <td className="tbl__num">{order.estMinutes} мин</td>
                    <td>
                      {order.orderClass ? (
                        orderClassName(order.orderClass)
                      ) : (
                        <span className="tbl__muted">—</span>
                      )}
                    </td>
                    <td>
                      {order.tech ? (
                        <>
                          {techName(order.tech)}
                          {order.gigabit && <span className="tbl__sub">гигабит</span>}
                        </>
                      ) : (
                        <span className="tbl__muted">—</span>
                      )}
                    </td>
                    <td>
                      {order.needsAccess ? (
                        <span className="pill pill--accent">Нужен</span>
                      ) : (
                        <span className="tbl__muted">Не нужен</span>
                      )}
                    </td>
                    <td>
                      {isUrgent(order.priorityClass, order.priority) ? (
                        <span className="tbl__warn">
                          {priorityClassName(order.priorityClass, order.priority)}
                        </span>
                      ) : (
                        priorityClassName(order.priorityClass, order.priority)
                      )}
                    </td>
                    <td>
                      {order.status ? statusName(order.status) : <span className="tbl__muted">—</span>}
                    </td>
                    <td>
                      <span className="tbl__strong">{order.company}</span>
                      {order.contactName && (
                        <span className="tbl__sub">
                          {order.contactName}
                          {order.contactPhone ? ` · ${order.contactPhone}` : ''}
                        </span>
                      )}
                    </td>
                    <td>
                      {order.engineerName ? (
                        <>
                          <span className="tbl__strong">{order.engineerName}</span>
                          <span className="tbl__sub">{order.engineerId}</span>
                        </>
                      ) : (
                        <span className="pill pill--danger">Без инженера</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </section>
      ) : mode === 'cards' ? (
        <>
          <div
            className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
            style={{ '--per-row': perRow } as React.CSSProperties}
          >
            {shown.map(card)}
          </div>

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      ) : (
        <>
          {/* Список — вид по умолчанию: заявка — строка. Названием стоит вид
              работ, а не номер: номером заявку ищут, но читают всё-таки
              «что там делать». Справа — окно приёма, крайний срок и кто
              поехал: три вопроса, с которыми к заявке и подходят. Инженер
              последним и колонкой пошире: «Без инженера» — это не число, а
              приговор строке, и именно его в этом виде высматривают. */}
          <DbList
          lead="Заявка"
            rows={shown.map((order) => ({
              key: order.key,
              lead: <Icon name={workTypeIcon(order.workType)} size={15} />,
              code: order.id,
              title: order.workTitle,
              sub: (
                <>
                  {order.address} · {order.district} · {order.company} · расчёт {order.run.code}
                  {order.needsAccess ? ' · нужен доступ' : ''}
                  {order.status ? ` · ${statusName(order.status)}` : ''}
                </>
              ),
              cells: [
                { label: 'Окно приёма', value: `${hhmm(order.windowStart)}–${hhmm(order.windowEnd)}`, wide: true },
                { label: 'Крайний срок', value: deadline(order.slaDeadline), wide: true },
                { label: 'Работа', value: `${order.estMinutes} мин` },
                {
                  label: 'Приоритет',
                  value: priorityClassName(order.priorityClass, order.priority),
                  tone: isUrgent(order.priorityClass, order.priority) ? ('warn' as const) : ('muted' as const)
                },
                {
                  label: 'Инженер',
                  value: order.engineerName ? (
                    <span title={order.engineerName}>{shortName(order.engineerName)}</span>
                  ) : (
                    'Без инженера'
                  ),
                  wide: true,
                  tone: order.engineerName ? undefined : ('warn' as const)
                }
              ],
              onOpen: () => setOpened(order)
            }))}
          />

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      )}

      <OrderProfile
        order={opened}
        registry={registry}
        onClose={() => setOpened(null)}
        onOpenRun={(id) => {
          setOpened(null);
          onOpenRun(id);
        }}
        onOpenMap={(id) => {
          setOpened(null);
          onOpenMap(id);
        }}
      />
    </div>
  );
}
