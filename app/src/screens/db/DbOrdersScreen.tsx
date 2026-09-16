import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { OrderRecord, Registry } from '../../data/registry.ts';
import { dec, deadline, hhmm, hoursText, plural } from '../../data/derive.ts';
import {
  isUrgent,
  orderClassName,
  priorityClassName,
  statusName,
  techName,
  workTypeIcon
} from '../../data/dictionary.ts';
import { OrderCard } from '../../app/OrderCard.tsx';
import { OrderProfile } from '../../app/OrderProfile.tsx';
import { useWidgetBoard, WidgetPeriod, withinPeriod } from '../../app/DbWidgets.tsx';
import type { PeriodKey, WidgetDef } from '../../app/DbWidgets.tsx';
import { service } from '../../data/service.ts';
import { DbHead } from './DbHead.tsx';

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

/* Плотность ряда — та же настройка, что в базе инженеров: «разглядеть» или
   «охватить». По две и по четыре карточка живёт целиком, по шесть сжимается
   до строки справочника. */
const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

/* По чему упорядочены заявки. Первым — крайний срок: это ответ на «что горит».
   Повторный щелчок по выбранному правилу переворачивает порядок. */
type Sort = 'deadline' | 'window' | 'duration' | 'district' | 'run';

const SORTS: { value: Sort; label: string; desc: boolean }[] = [
  { value: 'deadline', label: 'По сроку', desc: false },
  { value: 'window', label: 'По окну приёма', desc: false },
  { value: 'duration', label: 'По длительности', desc: true },
  { value: 'district', label: 'По району', desc: false },
  { value: 'run', label: 'По расчёту', desc: false }
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

/* База заявок: все заявки, прошедшие через расчёты. Строка — заявка в одном
   расчёте: номера в прогонах повторяются, но стоят за ними разные точки, окна
   и инженеры, поэтому расчёт указан у каждой записи.

   Устроена как база инженеров — доска виджетов со сроком сверху, полоса
   отбора, карточки или таблица, — и это осознанное повторение: два справочника
   об одном хозяйстве, и переучивать диспетчера на втором незачем. */
export function DbOrdersScreen({ registry, mode, onOpenRun, onOpenMap }: Props) {
  const [perRow, setPerRow] = useState(() => service().perRow as string);
  const [sort, setSort] = useState<Sort>('deadline');
  const [desc, setDesc] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [type, setType] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  /* Какая заявка открыта. Карточка одна на всю базу: двух сразу не читают. */
  const [opened, setOpened] = useState<OrderRecord | null>(null);
  const dense = perRow === '6';

  const all = registry.orders;

  const types = useMemo(() => {
    const map = new Map<string, number>();
    for (const order of all) map.set(order.workType, (map.get(order.workType) ?? 0) + 1);
    return [...map.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
  }, [all]);

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

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = all.filter((order) => {
      if (run && order.run.id !== run) return false;
      if (type && order.workType !== type) return false;
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
        (order.engineerName ?? '').toLowerCase().includes(needle) ||
        (order.contactName ?? '').toLowerCase().includes(needle)
      );
    });

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
  }, [all, desc, filter, query, run, sort, type]);

  const pickSort = (value: Sort) => {
    if (value === sort) {
      setDesc((prev) => !prev);
      return;
    }
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? false);
    setLimit(PAGE);
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
        title: 'Покрытие',
        note: 'Какая доля заявок досталась инженерам',
        shape: 'number',
        data: {
          value: String(Math.round((assigned.length / Math.max(list.length, 1)) * 100)),
          unit: '%',
          caption: 'заявок в маршрутах',
          tone: free > 0 ? 'warn' : 'ok',
          facts: [`${free} ${plural(free, 'заявка', 'заявки', 'заявок').replace(/^\d+\s/, '')} без инженера`],
          series: series((cell) => Math.round((cell.assigned / Math.max(cell.total, 1)) * 100)),
          legend: 'покрытие расчёта, %'
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
        title: 'Состояние визитов',
        note: 'Что говорит о заявках учётная система: статус визита из выгрузки',
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
          whole: true,
          parts: top(byClass).map(([key, value]) => ({
            key,
            label: orderClassName(key),
            value
          })),
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

  /* Разбивка по видам работ считается по той же выборке, что и список: иначе
     отбор менял бы список, но не картину над ним. */
  const breakdown = useMemo(() => {
    const map = new Map<string, { key: string; total: number; assigned: number; minutes: number }>();
    for (const order of rows) {
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
  }, [rows]);

  const shown = rows.slice(0, limit);
  const hidden = rows.length - shown.length;

  /* Сменили отбор — счётчик показанного начинается заново: иначе после
     сужения выборки кнопка обещала бы строки, которых уже нет. */
  const narrow = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setLimit(PAGE);
  };

  return (
    <div className="dash enter">
      <DbHead title="База заявок" board={board.node} />

      {/* Полоса управления выборкой — та же, что в базе инженеров: сверху что
          попадает в выборку, ниже как она показана, последними строками —
          расчёты и виды работ, потому что их много и они занимают ширину
          целиком. */}
      <section className="panel">
        <div className="filters filters--runs">
          <label className="dbsearch">
            <Icon name="search" size={14} />
            <input
              className="dbsearch__input"
              value={query}
              placeholder="Найти заявку: номер, адрес, район, работа, инженер, клиент"
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

          <div className="filters__group">
            <span className="filters__label">Отбор</span>
            <SegmentedControl
              size="sm"
              items={FILTERS}
              value={filter}
              onChange={narrow((value: string) => setFilter(value as Filter))}
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

          {mode === 'cards' && (
            <div className="filters__group">
              <span className="filters__label">Карточек в строке</span>
              <SegmentedControl size="sm" items={DENSITY} value={perRow} onChange={setPerRow} />
            </div>
          )}

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

          <div className="filters__group filters__group--wide">
            <span className="filters__label">Вид работ</span>
            <span className="filters__types">
              {types.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  className={'chip' + (type === entry.key ? ' chip--on' : '')}
                  onClick={() => {
                    setType(type === entry.key ? null : entry.key);
                    setLimit(PAGE);
                  }}
                  aria-pressed={type === entry.key}
                >
                  <Icon name={workTypeIcon(entry.key)} size={12} />
                  {registry.workTypeTitle[entry.key] ?? entry.key}
                  <span className="chip__count">{entry.count}</span>
                </button>
              ))}
            </span>
          </div>
        </div>
      </section>

      {rows.length === 0 ? (
        <section className="panel">
          <p className="clients__lede">
            Под этот отбор не подошла ни одна заявка. Снимите фильтр, сбросьте вид работ или
            очистите поиск.
          </p>
        </section>
      ) : mode === 'types' ? (
        <div className="cboard">
          {breakdown.map((entry) => (
            <button
              key={entry.key}
              type="button"
              className={'ccard' + (type === entry.key ? ' ccard--selected' : '')}
              onClick={() => setType(type === entry.key ? null : entry.key)}
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
                    onClick={() => setOpened(order)}
                  >
                    <td>
                      <span className="tbl__strong">{order.id}</span>
                      {order.seq !== null && <span className="tbl__sub">Визит № {order.seq + 1}</span>}
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
                      <span className="tbl__sub">{order.workType}</span>
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
                      {order.contactName ? (
                        <>
                          <span className="tbl__strong">{order.contactName}</span>
                          {order.contactPhone && (
                            <span className="tbl__sub">{order.contactPhone}</span>
                          )}
                        </>
                      ) : (
                        <span className="tbl__muted">—</span>
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
            {shown.map((order, index) => (
              <OrderCard
                key={order.key}
                row={order}
                seat={index + 1}
                onOpen={() => setOpened(order)}
                dense={dense}
                workType={type}
                runs={runsById.get(order.id) ?? []}
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

      <p className="filters__note filters__note--under">
        {plural(rows.length, 'заявка', 'заявки', 'заявок')} в выборке
        {rows.length !== all.length && ` из ${all.length}`}
        {rows.length > 0 && ` · ${dec(rows.reduce((sum, one) => sum + one.estMinutes, 0) / 60)} ч работы`}
      </p>

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
