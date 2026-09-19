import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { ClientRecord, OrderRecord, Registry } from '../../data/registry.ts';
import { dec, hhmm, plural } from '../../data/derive.ts';
import { workTypeIcon } from '../../data/dictionary.ts';
import { ClientCard } from '../../app/ClientCard.tsx';
import { ClientProfile } from '../../app/ClientProfile.tsx';
import { OrderProfile } from '../../app/OrderProfile.tsx';
import { SortMenu } from '../../app/SortMenu.tsx';
import type { SortRule } from '../../app/SortMenu.tsx';
import { topWithRest, useWidgetBoard } from '../../app/DbWidgets.tsx';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { useService } from '../../data/service.ts';
import { DbHead, DENSITY, usePerRow } from './DbHead.tsx';
import { DbBar, ChipKey, DbEmpty, DbMore, usePaging } from './DbBar.tsx';
import type { DbChip } from './DbBar.tsx';
import { DbList } from './DbList.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Уйти в расчёт, в котором встречался адрес. */
  onOpenRun: (id: string) => void;
}

/* Сколько карточек и строк отдаём в разметку за раз. Адресов в базе под две
   сотни, и карточка каждого — полэкрана ростом: все разом это одиннадцать
   тысяч узлов разметки и двадцать пять тысяч пикселей прокрутки, которые
   браузер рисует целиком и потом на них же спотыкается. */
const PAGE = 60;

/* По чему упорядочены адреса. Первым идёт порядок по числу заявок — это ответ
   на «куда мы ездим чаще всего»; остальные правила отвечают на «куда не
   доезжаем», «где горит» и «где искать по улице».

   Все правила, кроме алфавитного, открываются «от большего». Покрытие —
   наоборот: там интересен хвост, а не отличники, и «от меньшего» ставит
   сверху адреса, до которых доезжают реже всего. Повторное нажатие на
   выбранное правило переворачивает порядок. */
type Sort = 'orders' | 'coverage' | 'urgent' | 'access' | 'name';

const SORTS: (SortRule & { value: Sort; desc: boolean })[] = [
  {
    value: 'orders',
    label: 'По числу заявок',
    note: 'Куда мы ездим чаще всего',
    desc: true,
    up: 'Сначала редкие адреса',
    down: 'Сначала частые адреса'
  },
  {
    value: 'coverage',
    label: 'По покрытию',
    note: 'Куда не доезжаем',
    desc: false,
    up: 'Сначала худшее покрытие',
    down: 'Сначала лучшее покрытие'
  },
  {
    value: 'urgent',
    label: 'По срочным',
    note: 'Где горит',
    desc: true,
    up: 'Сначала спокойные',
    down: 'Сначала со срочными'
  },
  {
    value: 'access',
    label: 'По доступу',
    note: 'Куда без абонента не попасть',
    desc: true,
    up: 'Сначала без доступа',
    down: 'Сначала с доступом'
  },
  {
    value: 'name',
    label: 'По алфавиту',
    note: 'Где искать по улице',
    desc: false,
    up: 'Адреса от А до Я',
    down: 'Адреса от Я до А'
  }
];

/* Отбор по тому, чем адрес хлопотен: куда не доехали, где горит и куда без
   абонента не попасть. Это три вопроса, ради которых в справочник и
   заглядывают. */
type Filter = 'all' | 'missed' | 'urgent' | 'access';

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'missed', label: 'Есть без инженера' },
  { value: 'urgent', label: 'Есть срочные' },
  { value: 'access', label: 'Нужен доступ' }
];

const coverage = (client: ClientRecord) =>
  client.orders === 0 ? 0 : client.assigned / client.orders;

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* База клиентов: все адреса обслуживания, а не заявки одного прогона.
   Устроена как остальные базы — поиск, отбор, порядок, плотность и доска
   виджетов сверху, — и это осознанное повторение: шесть справочников об одном
   хозяйстве, и переучивать диспетчера на каждом незачем. */
export function DbClientsScreen({ registry, mode, onOpenRun }: Props) {
  /* Какой адрес открыт карточкой. До сих пор в этой базе не открывался ни
     один: карточка была картинкой, строка — не кнопкой, и вопрос «что мы
     делали по этому адресу» из базы клиентов не решался вовсе. */
  const [opened, setOpened] = useState<ClientRecord | null>(null);
  const [openedOrder, setOpenedOrder] = useState<OrderRecord | null>(null);
  /* Плотность ряда — настройка сервиса, общая на все базы. */
  const [perRow, setPerRow] = usePerRow();
  const [sort, setSort] = useState<Sort>('orders');
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [workType, setWorkType] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const paging = usePaging(PAGE);
  const dense = perRow === '6';
  /* Граница «плохо» для покрытия — та же, что в настройках сервиса и в
     карточке: одно число не должно краснеть по разным правилам. */
  const poorRate = useService().thresholds.coverageBad / 100;

  const all = registry.clients;

  /* Виды работ для полосы отбора — только те, что в базе действительно
     встречались: справочник знает восемнадцать, а в конкретной выгрузке их
     может оказаться меньше. */
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const client of all) for (const type of client.workTypes) set.add(type);
    return [...set].sort((a, b) =>
      (registry.workTypeTitle[a] ?? a).localeCompare(registry.workTypeTitle[b] ?? b, 'ru')
    );
  }, [all, registry.workTypeTitle]);

  /* Отбор и порядок считаем один раз на все виды: карточки, список и таблица
     должны показывать одну и ту же выборку, иначе переключение вида молча
     меняет набор. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const picked = all.filter((client) => {
      if (workType && !client.workTypes.includes(workType)) return false;
      if (filter === 'missed' && client.assigned >= client.orders) return false;
      if (filter === 'urgent' && client.urgent === 0) return false;
      if (filter === 'access' && client.access === 0) return false;
      if (!needle) return true;
      /* Ищут и по улице, и по району: «Ленинский» — это и проспект, и округ,
         и заранее не известно, что из двух держал в голове диспетчер. Виды
         работ тоже здесь: «роутер» набирают чаще, чем ищут его в ряду чипов. */
      return (
        /* Номер точки — первым: им её и называют, когда адрес диктовать
           долго. */
        client.company.toLowerCase().includes(needle) ||
        client.code.toLowerCase().includes(needle) ||
        client.address.toLowerCase().includes(needle) ||
        client.district.toLowerCase().includes(needle) ||
        client.workTypes.some((type) =>
          (registry.workTypeTitle[type] ?? type).toLowerCase().includes(needle)
        )
      );
    });

    const sorted = [...picked].sort((a, b) => {
      if (sort === 'name') return a.address.localeCompare(b.address, 'ru');
      if (sort === 'coverage') return coverage(a) - coverage(b) || b.orders - a.orders;
      if (sort === 'urgent') return a.urgent - b.urgent || a.orders - b.orders;
      if (sort === 'access') return a.access - b.access || a.orders - b.orders;
      return a.orders - b.orders || a.address.localeCompare(b.address, 'ru');
    });
    return desc ? sorted.reverse() : sorted;
  }, [all, registry.workTypeTitle, sort, desc, filter, workType, query]);

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

  /* Смена правила заодно ставит сторону, с которой его читают чаще.
     Повторное нажатие на выбранное правило переворачивает сторону — это
     делает само меню. */
  const pickSort = (value: Sort) => {
    setSort(value);
    setDesc(SORTS.find((item) => item.value === value)?.desc ?? true);
    paging.reset();
  };

  const reset = () => {
    setFilter('all');
    setWorkType(null);
    setQuery('');
    paging.reset();
  };

  /* Что база умеет показать. Считается по всем адресам, а не по выборке:
     доска отвечает на «что у нас за хозяйство», а список — на «покажи мне
     вот эти». Срока здесь нет и быть не может: у точки обслуживания нет
     даты, она живёт по адресу, а не по дню. */
  const widgets = useMemo<WidgetDef[]>(() => {
    const orders = all.reduce((sum, c) => sum + c.orders, 0);
    const assigned = all.reduce((sum, c) => sum + c.assigned, 0);
    const access = all.reduce((sum, c) => sum + c.access, 0);
    const urgent = all.reduce((sum, c) => sum + c.urgent, 0);

    /* Доли считаем только по адресам, у которых есть открытые заявки. Дом,
       вся история которого закрыта до расчёта, ждать инженера не мог: без
       этой оговорки он попадал разом и в «обслужены целиком» (ноль из нуля),
       и в «не обслужены ни разу» (обслужено ноль), и сумма долей выходила
       больше числа адресов. Такие дома называем отдельной строкой — они не
       беда, а закрытая работа. */
    const live = all.filter((c) => c.orders > 0);
    const done = all.length - live.length;
    const full = live.filter((c) => c.assigned === c.orders).length;
    const part = live.filter((c) => c.assigned > 0 && c.assigned < c.orders).length;
    const none = live.filter((c) => c.assigned === 0).length;
    const repeat = all.filter((c) => c.orders > 1).length;

    const byType = new Map<string, number>();
    const byDistrict = new Map<string, number>();
    for (const client of all) {
      for (const type of client.workTypes) {
        byType.set(type, (byType.get(type) ?? 0) + 1);
      }
      byDistrict.set(client.district, (byDistrict.get(client.district) ?? 0) + client.orders);
    }
    const top = <T,>(list: T[], size = 6) => list.slice(0, size);

    return [
      {
        key: 'points',
        title: 'Адресов обслуживания',
        note: 'Сколько точек в базе и до скольких доезжают целиком',
        shape: 'number',
        data: {
          value: String(all.length),
          caption: 'домов по всем расчётам',
          facts: [
            `${live.length} ждут выезда`,
            `${full} обслужены целиком`,
            `${none} не обслужены ни разу`,
            ...(done > 0 ? [`${done} закрыты до расчёта`] : [])
          ],
          whole: true,
          parts: [
            { key: 'full', label: 'Целиком', value: full, tone: 'ok' },
            { key: 'part', label: 'Частично', value: part, tone: 'warn' },
            { key: 'none', label: 'Ни разу', value: none, tone: 'bad' },
            { key: 'done', label: 'Закрыты до расчёта', value: done, tone: 'neutral' }
          ],
          legend: 'адресов'
        }
      },
      {
        key: 'orders',
        title: 'Заявок за всё время',
        note: 'Сколько работы пришло с этих адресов и что с ней стало',
        shape: 'number',
        data: {
          value: String(orders),
          caption: 'по всем расчётам',
          facts: [`${dec(orders / Math.max(all.length, 1))} на адрес`],
          whole: true,
          parts: [
            { key: 'assigned', label: 'Обслужено', value: assigned, tone: 'ok' },
            { key: 'missed', label: 'Без инженера', value: orders - assigned, tone: 'bad' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'coverage',
        title: 'Покрытие',
        /* Числом, а не кольцом: в середине кольца этот интерфейс всегда
           показывает сумму долей, и «Покрытие» с цифрой 205 в центре
           отвечало бы не на свой вопрос. Кольцо у величины остаётся — его
           выбирают на самой плитке, и тогда оно честно говорит про заявки. */
        note: 'Какая доля заявок с этих адресов попала в маршруты',
        shape: 'number',
        data: {
          value: String(Math.round((orders === 0 ? 0 : assigned / orders) * 100)),
          unit: '%',
          caption: 'заявок в маршрутах',
          tone: assigned / Math.max(orders, 1) < poorRate ? 'warn' : 'ok',
          whole: true,
          parts: [
            { key: 'assigned', label: 'В маршруте', value: assigned, tone: 'ok' },
            { key: 'missed', label: 'Без инженера', value: orders - assigned, tone: 'bad' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'access',
        title: 'Нужен доступ',
        note: 'На скольких заявках без абонента в дом не попасть',
        shape: 'number',
        data: {
          value: String(access),
          caption: percent(orders === 0 ? 0 : access / orders) + ' от всех заявок',
          whole: true,
          parts: [
            { key: 'need', label: 'Нужен доступ', value: access, tone: 'warn' },
            { key: 'free', label: 'Не нужен', value: orders - access, tone: 'neutral' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'urgent',
        title: 'Срочных заявок',
        note: 'Сколько аварий и глобальных проблем пришло с этих адресов',
        shape: 'number',
        data: {
          value: String(urgent),
          caption: percent(orders === 0 ? 0 : urgent / orders) + ' от всех заявок',
          tone: urgent > 0 ? 'warn' : 'neutral',
          whole: true,
          parts: [
            { key: 'urgent', label: 'Срочные', value: urgent, tone: 'bad' },
            { key: 'normal', label: 'Обычные', value: orders - urgent, tone: 'neutral' }
          ],
          legend: 'заявок'
        }
      },
      {
        key: 'repeat',
        title: 'Повторные адреса',
        note: 'На сколько домов ездили больше одного раза',
        shape: 'number',
        data: {
          value: String(repeat),
          caption: percent(all.length === 0 ? 0 : repeat / all.length) + ' от всех адресов',
          whole: true,
          parts: [
            { key: 'repeat', label: 'Больше раза', value: repeat, tone: 'warn' },
            { key: 'once', label: 'Один раз', value: all.length - repeat, tone: 'neutral' }
          ],
          legend: 'адресов'
        }
      },
      {
        key: 'types',
        title: 'Виды работ',
        note: 'На скольких адресах какой вид работ заказывали',
        shape: 'bars',
        data: {
          value: String(byType.size),
          caption: 'видов работ на адресах',
          /* Доли здесь не складываются в целое: на одном доме заказывают и
             замену роутера, и работу с кабелем, и адрес считается в обеих.
             Кольцо обещало бы, что сумма секторов — это всё; полосам это
             безразлично. */
          whole: false,
          parts: top(
            [...byType.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => ({
                key: type,
                label: registry.workTypeTitle[type] ?? type,
                value: count
              }))
          ),
          legend: 'адресов'
        }
      },
      {
        key: 'districts',
        title: 'Районы',
        note: 'Откуда приходит работа — по районам обслуживания',
        shape: 'bars',
        data: {
          value: String(byDistrict.size),
          caption: 'районов в базе',
          /* Районы складываются в целое, но их больше, чем влезает в
             плитку: шесть первых показаны, остальные собраны в один сектор
             «прочее» — иначе кольцо обещало бы, что шесть районов и есть
             все заявки. */
          whole: true,
          parts: topWithRest(
            [...byDistrict.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([district, count]) => ({ key: district, label: district, value: count })),
            6,
            'Другие районы'
          ),
          legend: 'заявок'
        }
      }
    ];
  }, [all, registry.workTypeTitle, poorRate]);

  const board = useWidgetBoard({
    storeKey: 'db-clients',
    catalogue: widgets,
    fallback: ['points', 'orders', 'coverage', 'access', 'urgent']
  });

  /* Активные отборы — чипами наверху. Каждый снимается своим крестиком. */
  const chips: DbChip[] = [];
  if (filter !== 'all') {
    chips.push({
      key: 'filter',
      label: FILTERS.find((item) => item.value === filter)?.label ?? filter,
      onRemove: clear(() => setFilter('all'))
    });
  }
  if (workType) {
    chips.push({
      key: 'type',
      label: (
        <>
          <ChipKey>Вид работ</ChipKey>
          {registry.workTypeTitle[workType] ?? workType}
        </>
      ),
      onRemove: clear(() => setWorkType(null))
    });
  }

  const shown = rows.slice(0, paging.limit);
  const hidden = rows.length - shown.length;

  /* Итог выборки — над списком, а не под ним. Сверху доска отвечает на «как
     дела вообще», эта строка — на «а что сейчас на экране», и стоять она
     должна там, где на неё смотрят: под полосой отбора, перед первой
     записью. Числа выбраны по вопросу самой базы: кто это, сколько для него
     сделали и сколько не доехало. */
  const summary = rows.length > 0 && (
    <>
      <b>{plural(rows.length, 'адрес', 'адреса', 'адресов')}</b> в выборке
      {rows.length !== all.length && ` из ${all.length}`}
      {` · ${plural(new Set(rows.map((one) => one.company)).size, 'компания', 'компании', 'компаний')}`}
      {` · ${plural(rows.reduce((sum, one) => sum + one.orders, 0), 'заявка', 'заявки', 'заявок')}`}
      {` · покрытие ${Math.round(
        (rows.reduce((sum, one) => sum + one.assigned, 0) /
          Math.max(rows.reduce((sum, one) => sum + one.orders, 0), 1)) *
          100
      )}%`}
    </>
  );

  return (
    <div className="dash enter">
      {/* Числа шапки и есть доска: отдельным блоком «что иллюстрируем» они
          спорили бы сами с собой — два ряда об одном и том же. */}
      <DbHead title="База клиентов" board={board.node}>
        <DbBar
          query={query}
          onQuery={narrow(setQuery)}
          placeholder="Найти клиента: номер, адрес, район, вид работ"
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
          {/* Под кнопкой «Отбор» — та же сетка «подпись — орган», что и
              раньше: сперва то, что сужает выборку, потом то, как её
              показать. */}
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

            {/* Виды работ — отдельной строкой во всю ширину: их полтора
                десятка, и рядом с переключателями они сминали бы полосу. */}
            <div className="filters__group filters__group--wide">
              <span className="filters__label">Вид работ</span>
              <span className="filters__types">
                {types.map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={'chip' + (workType === type ? ' chip--on' : '')}
                    onClick={narrow(() => setWorkType(workType === type ? null : type))}
                    aria-pressed={workType === type}
                  >
                    <Icon name={workTypeIcon(type)} size={12} />
                    {registry.workTypeTitle[type] ?? type}
                    {workType === type && <Icon name="x" size={12} />}
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

      {rows.length === 0 ? (
        <DbEmpty
          miss="Под этот отбор не подошёл ни один адрес."
          blank="Адресов в базе пока нет: они собираются из заявок сохранённых расчётов, и до первого расчёта база пуста."
          query={query.trim() !== ''}
          filtered={filter !== 'all' || workType !== null}
          onReset={reset}
        />
      ) : mode === 'table' ? (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Номер</th>
                  <th>Клиент</th>
                  <th>Адрес обслуживания</th>
                  <th>Заявок</th>
                  <th>Обслужено</th>
                  <th>Покрытие</th>
                  <th>Виды работ</th>
                  <th>Доступ</th>
                  <th>Срочных</th>
                  <th>Средняя работа</th>
                  <th>Раннее окно</th>
                  <th>В расчётах</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((client) => {
                  const rate = coverage(client);
                  return (
                    <tr
                      key={client.key}
                      className="tbl__row tbl__row--open"
                      tabIndex={0}
                      role="button"
                      onClick={() => setOpened(client)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setOpened(client);
                        }
                      }}
                    >
                      <td>
                        <span className="tbl__strong">{client.code}</span>
                      </td>
                      <td>
                        <span className="tbl__strong">{client.company}</span>
                      </td>
                      <td>
                        <span>{client.address}</span>
                        <span className="tbl__sub">
                          {client.district} ·{' '}
                          {plural(client.workTypes.length, 'вид работ', 'вида работ', 'видов работ')}
                        </span>
                      </td>
                      <td className="tbl__num">{client.orders}</td>
                      <td className="tbl__num">{client.assigned}</td>
                      <td>
                        <span className={'pill pill--' + (rate < poorRate ? 'danger' : 'success')}>
                          {Math.round(rate * 100)}%
                        </span>
                      </td>
                      <td>
                        <span className="tbl__tags">
                          {client.workTypes.map((type) => (
                            <span key={type} className="tbl__inline">
                              <Icon name={workTypeIcon(type)} size={13} />
                              {registry.workTypeTitle[type] ?? type}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td className="tbl__num">{client.access}</td>
                      <td className="tbl__num">{client.urgent}</td>
                      <td className="tbl__num">{client.avgMinutes} мин</td>
                      <td className="tbl__num">{hhmm(client.firstWindow)}</td>
                      <td className="tbl__num">
                        {client.runs} / {registry.runs.length}
                      </td>
                    </tr>
                  );
                })}
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
            {shown.map((client) => (
              <ClientCard
                key={client.key}
                row={client}
                runsTotal={registry.runs.length}
                workTypeTitle={registry.workTypeTitle}
                dense={dense}
                workType={workType}
                onOpen={() => setOpened(client)}
              />
            ))}
          </div>

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      ) : (
        <>
          {/* Список — вид по умолчанию: адрес — строка. Названием стоит
              адрес, а не компания: сюда приходят с вопросом «куда мы ездим»
              и «куда не доезжаем», и оба вопроса об адресе. Компания и район
              ушли в подпись — по ним уточняют, а не ищут. Строка открывает
              карточку адреса: его историю, тех, кто сюда ездил, и расчёты,
              в которых он встречался. */}
          <DbList
            rows={shown.map((client) => {
              const rate = coverage(client);
              return {
                key: client.key,
                lead: <Icon name="house" size={15} />,
                code: client.code,
                title: client.address,
                sub: (
                  <>
                    {client.company} · {client.district} ·{' '}
                    {client.workTypes
                      .map((type) => registry.workTypeTitle[type] ?? type)
                      .join(' · ')}
                  </>
                ),
                cells: [
                  { label: 'Заявок', value: client.orders },
                  { label: 'Обслужено', value: client.assigned },
                  {
                    label: 'Покрытие',
                    value: percent(rate),
                    tone: rate < poorRate ? ('warn' as const) : undefined
                  },
                  {
                    label: 'Срочных',
                    value: client.urgent > 0 ? client.urgent : '—',
                    tone: client.urgent > 0 ? ('warn' as const) : ('muted' as const)
                  },
                  {
                    label: 'Нужен доступ',
                    value: client.access > 0 ? client.access : '—',
                    tone: client.access > 0 ? undefined : ('muted' as const)
                  },
                  { label: 'Средняя работа', value: `${client.avgMinutes} мин` }
                ],
                onOpen: () => setOpened(client)
              };
            })}
          />

          <DbMore hidden={hidden} page={PAGE} onMore={paging.more} />
        </>
      )}

      <ClientProfile
        client={opened}
        registry={registry}
        onClose={() => setOpened(null)}
        /* Заявка открывается поверх клиента и закрывает его: два окна друг на
           друге диспетчер закрывал бы дважды, не понимая, почему. Закрыв
           заявку, он возвращается на экран базы — туда, откуда пришёл. */
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
