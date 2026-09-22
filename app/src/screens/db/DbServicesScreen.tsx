import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry, ServiceRecord } from '../../data/registry.ts';
import { dec, plural } from '../../data/derive.ts';
import {
  equipmentName,
  isUrgent,
  orderClassName,
  requiredTransportName,
  skillIcon,
  skillName
} from '../../data/dictionary.ts';
import { ServiceCard } from '../../app/ServiceCard.tsx';
import { ServiceProfile } from '../../app/ServiceProfile.tsx';
import { OrderProfile } from '../../app/OrderProfile.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { service } from '../../data/service.ts';
import { DbHead } from './DbHead.tsx';
import { DbList } from './DbList.tsx';
import { DbBar, ChipKey, DbEmpty } from './DbBar.tsx';
import type { DbChip } from './DbBar.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Уйти в расчёт, в котором встречалась услуга. */
  onOpenRun: (id: string) => void;
}

/* Плотность ряда — та же настройка, что в базах расчётов, инженеров и заявок.
   По две и по четыре карточка живёт целиком: цифры, поля выгрузки, признаки.
   По шесть она сжимается до строки справочника — что за услуга, чей навык и
   сколько занимает. */
const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* По чему упорядочены услуги. Первым — число заявок: это ответ на «чем мы
   вообще занимаемся». Остальные правила отвечают на «что дольше всего»,
   «что горит» и «где искать по названию». */
type Sort = 'orders' | 'minutes' | 'urgent' | 'loose' | 'name';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'orders',
    label: 'По числу заявок',
    note: 'Чем мы занимаемся чаще всего',
    desc: true,
    up: 'Сначала редкие',
    down: 'Сначала частые'
  },
  {
    value: 'minutes',
    label: 'По длительности',
    note: 'Сколько занимает работа на объекте',
    desc: true,
    up: 'Сначала короткие',
    down: 'Сначала долгие'
  },
  {
    value: 'urgent',
    label: 'По срочности',
    note: 'Где чаще всего горит',
    desc: true,
    up: 'Сначала спокойные',
    down: 'Сначала срочные'
  },
  {
    value: 'loose',
    label: 'По нераспределённым',
    note: 'Какие заявки чаще остаются лежать',
    desc: true,
    up: 'Сначала разложенные',
    down: 'Сначала с хвостом'
  },
  {
    value: 'name',
    label: 'По алфавиту',
    note: 'Где искать по названию',
    desc: false,
    up: 'От А до Я',
    down: 'От Я до А'
  }
];

/* Отбор по тому, чего услуга требует от плана: нужна ли под неё машина, надо
   ли везти оборудование и пускают ли внутрь. Это и есть то, чем услуга
   связывает движку руки. */
type Filter = 'all' | 'car' | 'gear' | 'access' | 'urgent' | 'loose';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'car', label: 'Нужна машина' },
  { value: 'gear', label: 'Везти оборудование' },
  { value: 'access', label: 'Нужен доступ' },
  { value: 'urgent', label: 'Есть срочные' },
  { value: 'loose', label: 'Есть нераспределённые' }
];

const minutesLabel = (row: ServiceRecord) =>
  row.minutes === row.minutesTo ? `${row.minutes} мин` : `${row.minutes}–${row.minutesTo} мин`;

/** Числа услуги за выбранный срок. Считаются в одном месте на все три вида:
    карточка, таблица и группы по навыку обязаны говорить об одном сроке одно
    и то же. */
interface Slice {
  orders: number;
  assigned: number;
  urgent: number;
  access: number;
  /** Сколько раз услуга попадала в расчёты: «заявок» и «в расчётах» — разные
      числа, полный каталог шире того, что дошло до движка. */
  planned: number;
}

const EMPTY: Slice = { orders: 0, assigned: 0, urgent: 0, access: 0, planned: 0 };

/* База услуг: что именно делают на объекте.

   Услуга — это вид работ, и с навыком она не совпадает. Навыков по ТЗ ровно
   три, они отвечают на «кто может взять заявку». Услуг восемнадцать, и они
   отвечают на «что он там будет делать»: «Конвергенция абонента», «Нет
   линка», «Замена приставки». Один навык покрывает несколько услуг, и путать
   их нельзя — отсюда и отдельный справочник.

   Устроена как базы расчётов, инженеров и заявок — доска виджетов со сроком
   сверху, полоса отбора, карточки или таблица, — и это осознанное повторение:
   справочники об одном хозяйстве, и переучивать диспетчера на четвёртом
   незачем. */
export function DbServicesScreen({ registry, mode, onOpenRun }: Props) {
  /* Какая услуга открыта карточкой. До сих пор в этой базе не открывалась ни
     одна: восемнадцать карточек только показывали числа, и вопрос «покажи
     все заявки по замене роутера» из базы услуг не решался. */
  const [opened, setOpened] = useState<ServiceRecord | null>(null);
  const [openedOrder, setOpenedOrder] = useState<OrderRecord | null>(null);
  const [perRow, setPerRow] = useState(() => service().perRow as string);
  const [sort, setSort] = useState<Sort>('orders');
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  /* Отмеченные навыки. Их несколько, и они складываются по «или»: навык у
     услуги один, и «то и это» через «и» дало бы пустой список. Пусто —
     показаны все. */
  const [picks, setPicks] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const dense = perRow === '6';

  const all = registry.services;

  const skills = useMemo(() => {
    const set = new Set<string>();
    for (const row of all) set.add(row.skill);
    return [...set].sort((a, b) => skillName(a).localeCompare(skillName(b)));
  }, [all]);

  /* Срок, за который считает доска и по которому берутся числа карточки.
     Отдельно от отбора списка: список отвечает на «какие услуги показать»,
     срок — на «за какой период считать». Общим переключателем поиск по
     названию менял бы диаграммы, а смена срока — прятала бы услуги из
     справочника, которые никуда не делись. */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const runsIn = (key: PeriodKey) => registry.runs.filter((ref) => withinPeriod(ref.created, key));

  /* Числа услуг за срок. Запись услуги хранит итоги по всем данным сразу —
     её так и собирают, из каталога заявок, — а срок выбирают наверху.
     Считаются они по заявкам расчётов, попавших в срок: это единственное
     место, где у услуги есть привязка ко времени. */
  const sliceBy = useMemo(() => {
    const map = new Map<string, Slice>();
    for (const order of registry.orders) {
      if (!withinPeriod(order.run.created, period)) continue;
      const cell = map.get(order.workType) ?? { ...EMPTY };
      cell.orders += 1;
      /* За срок «в расчётах» и «заявок» — одно и то же число: реестр заявок
         и собран из расчётов. Разойтись они могут только на «всём времени»,
         где заявки берутся из полного каталога. */
      cell.planned += 1;
      if (order.engineerId) cell.assigned += 1;
      if (isUrgent(order.priorityClass, order.priority)) cell.urgent += 1;
      if (order.needsAccess) cell.access += 1;
      map.set(order.workType, cell);
    }
    return map;
  }, [registry, period]);

  /* За всё время числа берутся из самой записи: каталог услуг собран по всем
     данным, а не только по тому, что попало в расчёты, и подменять его
     подсчётом по заявкам значило бы потерять услуги, которых в расчётах не
     было. */
  const sliceOf = (row: ServiceRecord): Slice =>
    period === 'all'
      ? {
          orders: row.orders,
          assigned: row.assigned,
          urgent: row.urgent,
          access: row.access,
          planned: row.planned
        }
      : (sliceBy.get(row.key) ?? EMPTY);

  /* Отбор и порядок считаются по тем же числам, которые карточка и таблица
     показывают, — то есть по сроку, а не по итогам записи. Иначе «Есть
     срочные» оставляло бы услуги с нулём в колонке «Срочных», а «По числу
     заявок» ставило бы первой ту, у которой в колонке «Заявок» меньше всех:
     отбор говорил бы об одном множестве, а список — о другом.

     Требования к транспорту и оборудованию от срока не зависят: они
     свойство самой услуги, а не заявок по ней. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = all.filter((row) => {
      const slice = sliceOf(row);
      if (picks.length > 0 && !picks.includes(row.skill)) return false;
      if (filter === 'car' && !row.requiredTransport) return false;
      if (filter === 'gear' && row.equipment.length === 0) return false;
      if (filter === 'access' && slice.access === 0) return false;
      if (filter === 'urgent' && slice.urgent === 0) return false;
      if (filter === 'loose' && (slice.planned === 0 || slice.assigned >= slice.planned)) {
        return false;
      }
      if (!needle) return true;
      return (
        row.title.toLowerCase().includes(needle) ||
        row.key.toLowerCase().includes(needle) ||
        skillName(row.skill).toLowerCase().includes(needle) ||
        row.equipment.some((item) => equipmentName(item).toLowerCase().includes(needle))
      );
    });

    const rank = (row: ServiceRecord) => {
      const slice = sliceOf(row);
      switch (sort) {
        case 'minutes':
          return row.minutesTo;
        case 'urgent':
          return slice.urgent;
        case 'loose':
          return slice.planned - slice.assigned;
        case 'name':
          /* Алфавит числом не меряется: у него своё сравнение, а ранг нужен
             только затем, чтобы обе стороны переворачивались одинаково. */
          return 0;
        default:
          return slice.orders;
      }
    };
    const side = desc ? -1 : 1;
    return [...picked].sort((a, b) => {
      const diff = rank(a) - rank(b);
      return side * (diff !== 0 ? diff : a.title.localeCompare(b.title, 'ru'));
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [all, desc, filter, picks, query, sort, period, sliceBy]);

  /* Повторный щелчок по выбранному правилу переворачивает порядок — так же,
     как в остальных пяти базах. Раньше он молча возвращался, и один и тот же
     жест давал разный итог в соседних разделах. */
  const pickSort = (value: Sort) => {
    if (value === sort) {
      setDesc((prev) => !prev);
      return;
    }
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? true);
  };

  const reset = () => {
    setFilter('all');
    setPicks([]);
    setQuery('');
  };

  /* Группировка по навыку: она и есть ответ на вопрос, как услуги ложатся на
     три навыка ТЗ. Ради этого вида справочник и заводился. */
  const groups = useMemo(() => {
    const map = new Map<string, ServiceRecord[]>();
    for (const row of rows) {
      const list = map.get(row.skill) ?? [];
      list.push(row);
      map.set(row.skill, list);
    }
    return [...map.entries()].sort((a, b) => skillName(a[0]).localeCompare(skillName(b[0])));
  }, [rows]);

  /* Величины базы для доски виджетов. Считаются по заявкам среза, а не по
     сводным числам записей: сводные посчитаны по всем данным и на срок не
     отзываются. */
  const widgets = useMemo<WidgetDef[]>(() => {
    const runs = [...registry.runs]
      .filter((ref) => withinPeriod(ref.created, period))
      .sort((a, b) => a.created.localeCompare(b.created));
    const ids = new Set(runs.map((ref) => ref.id));
    const orders = registry.orders.filter((order) => ids.has(order.run.id));

    const assigned = orders.filter((order) => order.engineerId).length;
    const loose = orders.length - assigned;
    const urgent = orders.filter((order) => isUrgent(order.priorityClass, order.priority)).length;
    const access = orders.filter((order) => order.needsAccess).length;
    const minutes = orders.reduce((sum, order) => sum + order.estMinutes, 0);
    const needCar = all.filter((row) => row.requiredTransport);
    const withGear = all.filter((row) => row.equipment.length > 0);

    const top = <T,>(list: T[], size = 4) => list.slice(0, size);
    const titleOf = (key: string) => registry.workTypeTitle[key] ?? key;

    /* Заявки по услугам среза: из этой раскладки считаются и «самые частые»,
       и «самые долгие», и ряд по расчётам. */
    const byService = new Map<string, { orders: number; minutes: number; loose: number }>();
    for (const order of orders) {
      const cell = byService.get(order.workType) ?? { orders: 0, minutes: 0, loose: 0 };
      cell.orders += 1;
      cell.minutes += order.estMinutes;
      if (!order.engineerId) cell.loose += 1;
      byService.set(order.workType, cell);
    }
    const kinds = [...byService.entries()];
    const byCount = top([...kinds].sort((a, b) => b[1].orders - a[1].orders), 6);
    const byLoose = top(
      [...kinds].sort((a, b) => b[1].loose - a[1].loose).filter(([, cell]) => cell.loose > 0)
    );
    const byLong = top(
      [...all].sort((a, b) => b.minutesTo - a.minutesTo || b.orders - a.orders),
      6
    );

    /* Услуги по навыкам: сколько видов работ покрывает каждый из трёх навыков
       ТЗ. Считается по справочнику, срок на него не влияет — какой навык
       нужен услуге, от периода не зависит. */
    const bySkill = new Map<string, number>();
    for (const row of all) bySkill.set(row.skill, (bySkill.get(row.skill) ?? 0) + 1);

    /* Ряд по прогонам: заявки разложены по расчётам, чтобы «сколько всего» и
       «как менялось» считались из одного места. */
    const cells = new Map<string, { orders: number; minutes: number; urgent: number }>();
    for (const order of orders) {
      const cell = cells.get(order.run.id) ?? { orders: 0, minutes: 0, urgent: 0 };
      cell.orders += 1;
      cell.minutes += order.estMinutes;
      if (isUrgent(order.priorityClass, order.priority)) cell.urgent += 1;
      cells.set(order.run.id, cell);
    }
    const series = (pick: (cell: { orders: number; minutes: number; urgent: number }) => number) =>
      runs.map((ref) => ({
        label: ref.code,
        value: pick(cells.get(ref.id) ?? { orders: 0, minutes: 0, urgent: 0 })
      }));

    return [
      {
        key: 'services',
        title: 'Услуг',
        note: 'Сколько видов работ в справочнике и сколько из них встречалось за срок',
        shape: 'number',
        data: {
          value: String(all.length),
          caption: 'в справочнике',
          facts: [
            `${kinds.length} встречались за срок`,
            `${all.length - kinds.length} не встречались`
          ],
          whole: true,
          parts: [
            { key: 'seen', label: 'Встречались', value: kinds.length, tone: 'ok' },
            {
              key: 'unseen',
              label: 'Не встречались',
              value: Math.max(0, all.length - kinds.length),
              tone: 'warn'
            }
          ],
          legend: 'услуг'
        }
      },
      {
        key: 'orders',
        title: 'Заявок по услугам',
        note: 'Сколько работы заказали за срок и что с ней стало',
        shape: 'number',
        data: {
          value: String(orders.length),
          caption: 'заявок за срок',
          facts: [`${percent(assigned / Math.max(orders.length, 1))} разложено`],
          whole: true,
          parts: [
            { key: 'assigned', label: 'Разложено', value: assigned, tone: 'ok' },
            { key: 'loose', label: 'Без инженера', value: loose, tone: 'bad' }
          ],
          series: series((cell) => cell.orders),
          legend: 'заявок'
        }
      },
      {
        key: 'work',
        title: 'Работы по услугам',
        note: 'Сколько часов работы на объектах заказано — по длительностям услуг',
        shape: 'number',
        data: {
          value: dec(minutes / 60),
          unit: 'ч',
          caption: 'работы на объектах',
          facts: [
            `${Math.round(minutes / Math.max(orders.length, 1))} мин на заявку`,
            `${dec(minutes / 60 / Math.max(runs.length, 1))} ч на расчёт`
          ],
          series: series((cell) => Math.round(cell.minutes / 6) / 10),
          legend: 'часов работы'
        }
      },
      {
        key: 'urgent',
        title: 'Срочных',
        note: 'Сколько заказанной работы горит',
        shape: 'number',
        data: {
          value: String(urgent),
          caption: 'срочных заявок',
          tone: urgent > 0 ? 'bad' : 'ok',
          facts: [`${percent(urgent / Math.max(orders.length, 1))} от всех заявок`],
          series: series((cell) => cell.urgent),
          legend: 'срочных заявок'
        }
      },
      {
        key: 'access',
        title: 'Нужен доступ',
        note: 'Сколько работы не сделать, если внутрь не пустят',
        shape: 'number',
        data: {
          value: String(access),
          caption: 'заявок с доступом в помещение',
          facts: [`${percent(access / Math.max(orders.length, 1))} от всех заявок`],
          legend: 'заявок'
        }
      },
      {
        key: 'popular',
        title: 'Самые частые услуги',
        note: 'Чем занята смена: какие работы заказывают чаще всего',
        shape: 'bars',
        data: {
          value: String(byCount[0]?.[1].orders ?? 0),
          caption: 'заявок у самой частой',
          whole: true,
          parts: byCount.map(([key, cell]) => ({
            key,
            label: titleOf(key),
            value: cell.orders
          })),
          legend: 'заявок по услуге'
        }
      },
      {
        key: 'longest',
        title: 'Самые долгие услуги',
        note: 'Что дольше всего держит инженера на объекте',
        shape: 'bars',
        data: {
          value: `${byLong[0]?.minutesTo ?? 0}`,
          unit: 'мин',
          caption: 'у самой долгой',
          parts: byLong.map((row) => ({
            key: row.key,
            label: row.title,
            value: row.minutesTo,
            text: minutesLabel(row)
          })),
          legend: 'минут работы на объекте'
        }
      },
      {
        key: 'loose',
        title: 'Чаще всех без инженера',
        note: 'Заявки по каким услугам остаются лежать',
        shape: 'bars',
        data: {
          value: String(byLoose[0]?.[1].loose ?? 0),
          caption: 'заявок у худшей услуги',
          tone: 'bad',
          parts: byLoose.map(([key, cell]) => ({
            key,
            label: titleOf(key),
            value: cell.loose,
            tone: 'bad' as const
          })),
          legend: byLoose.length > 0 ? 'заявок осталось' : 'таких услуг нет'
        }
      },
      {
        key: 'skills',
        title: 'Услуги по навыкам',
        note: 'Как услуги справочника ложатся на навыки ТЗ: ради этого ответа справочник и заводился. Считается по справочнику, срок на него не влияет',
        shape: 'donut',
        data: {
          value: String(all.length),
          caption: 'услуг',
          whole: true,
          parts: [...bySkill.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([key, count]) => ({ key, label: skillName(key), value: count })),
          legend: 'услуг у навыка'
        }
      },
      {
        key: 'transport',
        title: 'Требуют автомобиль',
        note: 'Сколько услуг связывает движку руки: их возьмёт только инженер с машиной',
        shape: 'number',
        data: {
          value: String(needCar.length),
          caption: 'услуг из справочника',
          whole: true,
          parts: [
            { key: 'car', label: 'Нужна машина', value: needCar.length, tone: 'warn' },
            {
              key: 'free',
              label: 'Без ограничения',
              value: all.length - needCar.length,
              tone: 'ok'
            }
          ],
          facts: [
            `${percent(needCar.length / Math.max(all.length, 1))} справочника`,
            `${withGear.length} требуют оборудование`
          ],
          legend: 'услуг'
        }
      },
      {
        key: 'gear',
        title: 'Требуют оборудование',
        note: 'Что инженеру надо везти с собой — и по скольким услугам',
        shape: 'number',
        data: {
          value: String(withGear.length),
          caption: 'услуг с оборудованием',
          whole: true,
          parts: [
            { key: 'gear', label: 'Везти с собой', value: withGear.length, tone: 'warn' },
            { key: 'bare', label: 'Ничего не везти', value: all.length - withGear.length, tone: 'ok' }
          ],
          legend: 'услуг'
        }
      }
    ];
  }, [all, registry, period]);

  const board = useWidgetBoard({
    storeKey: 'db-services',
    catalogue: widgets,
    fallback: ['services', 'orders', 'work', 'urgent', 'popular'],
    filter: (
      <WidgetPeriod value={period} onChange={setPeriod} countOf={(key) => runsIn(key).length} />
    )
  });

  const cards = (list: ServiceRecord[]) => (
    <div
      className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
      style={{ '--per-row': perRow } as React.CSSProperties}
    >
      {list.map((row, index) => (
        <ServiceCard
          key={row.key}
          row={row}
          seat={index + 1}
          slice={sliceOf(row)}
          dense={dense}
          skills={picks}
          onOpen={() => setOpened(row)}
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
      onRemove: () => setFilter('all')
    });
  }
  for (const key of picks) {
    chips.push({
      key: 'skill-' + key,
      label: (
        <>
          <ChipKey>Навык</ChipKey>
          {skillName(key)}
        </>
      ),
      onRemove: () => setPicks((was) => was.filter((one) => one !== key))
    });
  }

  /* Итог выборки — над списком: это ответ на «что дал отбор», и внизу, за
     прокруткой, его никто не читает. */
  const summary = (
    <>
      <b>{plural(rows.length, 'услуга', 'услуги', 'услуг')}</b> в выборке
      {rows.length !== all.length && ` из ${all.length}`}
      {rows.length > 0 && (
        <>
          {` · ${plural(
            rows.reduce((sum, row) => sum + sliceOf(row).orders, 0),
            'заявка',
            'заявки',
            'заявок'
          )} по ним`}
          {` · ${dec(
            rows.reduce((sum, row) => sum + sliceOf(row).orders * row.minutesTo, 0) / 60
          )} ч работы`}
          {` · разложено ${percent(
            rows.reduce((sum, row) => sum + sliceOf(row).assigned, 0) /
              Math.max(rows.reduce((sum, row) => sum + sliceOf(row).planned, 0), 1)
          )}`}
        </>
      )}
    </>
  );

  return (
    <div className="dash enter">
      {/* Полоса управления выборкой стоит в шапке базы, под её заголовком, и
          разложена столбиком «подпись — орган» — так же, как в базах расчётов,
          заявок и инженеров. Наверху — поиск и плотность: это не отбор, а то,
          с какой стороны на список смотрят. */}
      <DbHead title="База услуг" board={board.node}>
        <DbBar
          query={query}
          onQuery={setQuery}
          placeholder="Название услуги, код вида работ, навык или оборудование"
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

            {/* Навыков три, и отметки складываются по «или»: навык у услуги
                один, и «то и это» через «и» дало бы пустой список. Отбор
                здесь тот же, что подсвечен чипом в карточке. */}
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
                        : `Оставить услуги навыка «${skillName(key)}»`
                    }
                  >
                    <Icon name={skillIcon(key)} size={12} />
                    {skillName(key)}
                    {picks.includes(key) && <Icon name="x" size={12} />}
                  </button>
                ))}
              </span>
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
          miss="Под этот отбор не подошла ни одна услуга."
          blank="Услуг в справочнике пока нет: они собираются из видов работ, пришедших с заявками."
          query={query.trim() !== ''}
          filtered={filter !== 'all' || picks.length > 0}
          onReset={reset}
        />
      ) : mode === 'skills' ? (
        groups.map(([key, list]) => (
          <section className="panel" key={key}>
            <div className="dash__section-head">
              <h2 className="dash__section-title">
                <Icon name={skillIcon(key)} size={15} /> {skillName(key)}
              </h2>
              <span className="dash__section-note">
                {plural(list.length, 'услуга', 'услуги', 'услуг')} ·{' '}
                {plural(
                  list.reduce((sum, row) => sum + sliceOf(row).orders, 0),
                  'заявка',
                  'заявки',
                  'заявок'
                )}
              </span>
            </div>
            {cards(list)}
          </section>
        ))
      ) : mode === 'list' ? (
        /* Список: услуга — строка, навык иконкой слева. Это тот же вопрос,
           что и у вида «По навыкам», только заданный по-другому: там навык
           собирает услуги в группы, здесь он стоит у каждой строки, и
           восемнадцать услуг читаются подряд, в выбранном порядке. */
        <DbList
          lead="Услуга"
          rows={rows.map((row) => {
            const slice = sliceOf(row);
            return {
              key: row.key,
              lead: <Icon name={skillIcon(row.skill)} size={15} />,
              /* Код вида работ — только когда он и название разные строки: в
                 нынешней выгрузке они совпадают, и номер повторял бы имя. */
              code: row.key !== row.title ? row.key : undefined,
              title: row.title,
              sub: (
                <>
                  {skillName(row.skill)}
                  {row.orderClass ? ` · ${orderClassName(row.orderClass)}` : ''}
                  {row.equipment.length > 0
                    ? ` · ${row.equipment.map((item) => equipmentName(item)).join(' · ')}`
                    : ' · без оборудования'}
                  {row.requiredTransport ? ` · ${requiredTransportName(row.requiredTransport)}` : ''}
                </>
              ),
              cells: [
                { label: 'Длительность', value: minutesLabel(row), wide: true },
                { label: 'Заявок', value: slice.orders },
                {
                  label: 'Срочных',
                  value: slice.urgent > 0 ? slice.urgent : '—',
                  tone: slice.urgent > 0 ? ('warn' as const) : ('muted' as const)
                },
                {
                  label: 'Нужен доступ',
                  value: slice.access > 0 ? slice.access : '—',
                  tone: slice.access > 0 ? undefined : ('muted' as const)
                },
                {
                  label: 'Разложено',
                  value: slice.planned > 0 ? `${slice.assigned}/${slice.planned}` : '—',
                  tone: slice.planned > 0 ? undefined : ('muted' as const)
                }
              ],
              onOpen: () => setOpened(row)
            };
          })}
        />
      ) : mode === 'table' ? (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Услуга</th>
                  <th>Навык</th>
                  <th>Класс заявки</th>
                  <th>Длительность</th>
                  <th>Оборудование</th>
                  <th>Транспорт</th>
                  <th>Заявок</th>
                  <th>Срочных</th>
                  <th>Нужен доступ</th>
                  <th>Разложено</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const slice = sliceOf(row);
                  return (
                    <tr
                      key={row.key}
                      className="tbl__row"
                      tabIndex={0}
                      role="button"
                      onClick={() => setOpened(row)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpened(row);
                        }
                      }}
                    >
                      <td>
                        <span className="tbl__strong">{row.title}</span>
                        {/* Код вида работ — только когда он и название разные
                            строки: в нынешней выгрузке они совпадают, и
                            подстрочник повторял бы саму ячейку. */}
                        {row.key !== row.title && <span className="tbl__sub">{row.key}</span>}
                      </td>
                      <td>
                        <span className="tbl__inline">
                          <Icon name={skillIcon(row.skill)} size={13} />
                          {skillName(row.skill)}
                        </span>
                      </td>
                      <td>
                        {row.orderClass ? (
                          orderClassName(row.orderClass)
                        ) : (
                          <span className="tbl__muted">—</span>
                        )}
                      </td>
                      <td className="tbl__num">{minutesLabel(row)}</td>
                      <td>
                        {row.equipment.length > 0 ? (
                          <span className="tbl__tags">
                            {row.equipment.map((item) => (
                              <span key={item} className="tbl__inline">
                                {equipmentName(item)}
                              </span>
                            ))}
                          </span>
                        ) : (
                          <span className="tbl__muted">не требуется</span>
                        )}
                      </td>
                      <td>
                        {row.requiredTransport ? (
                          requiredTransportName(row.requiredTransport)
                        ) : (
                          <span className="tbl__muted">без ограничения</span>
                        )}
                      </td>
                      <td className="tbl__num">{slice.orders}</td>
                      <td className="tbl__num">
                        {slice.urgent > 0 ? slice.urgent : <span className="tbl__muted">—</span>}
                      </td>
                      <td className="tbl__num">{slice.access}</td>
                      <td className="tbl__num">
                        {slice.planned > 0 ? (
                          `${slice.assigned} из ${slice.planned}`
                        ) : (
                          <span className="tbl__muted">не считалась</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        cards(rows)
      )}


      <ServiceProfile
        service={opened}
        registry={registry}
        onClose={() => setOpened(null)}
        onOpenOrder={(order) => {
          setOpened(null);
          setOpenedOrder(order);
        }}
        onOpenRun={(id) => {
          setOpened(null);
          onOpenRun(id);
        }}
      />

      <OrderProfile
        order={openedOrder}
        registry={registry}
        onClose={() => setOpenedOrder(null)}
        onOpenRun={(id) => {
          setOpenedOrder(null);
          onOpenRun(id);
        }}
        onOpenMap={(id) => {
          setOpenedOrder(null);
          onOpenRun(id);
        }}
      />
    </div>
  );
}
