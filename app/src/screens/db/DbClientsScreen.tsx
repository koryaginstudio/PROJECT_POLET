import { useMemo, useState } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import { SegmentedControl } from '../../ds/components/forms/SegmentedControl.jsx';
import type { ClientRecord, OrderRecord, Registry } from '../../data/registry.ts';
import { dec, hhmm, plural } from '../../data/derive.ts';
import { workTypeIcon } from '../../data/dictionary.ts';
import { ClientCard } from '../../app/ClientCard.tsx';
import { ClientProfile } from '../../app/ClientProfile.tsx';
import { OrderProfile } from '../../app/OrderProfile.tsx';
import { useWidgetBoard } from '../../app/DbWidgets.tsx';
import type { WidgetDef } from '../../app/DbWidgets.tsx';
import { service } from '../../data/service.ts';
import { DbHead } from './DbHead.tsx';
import { DbList } from './DbList.tsx';

interface Props {
  registry: Registry;
  mode: string;
  /** Уйти в расчёт, в котором встречался адрес. */
  onOpenRun: (id: string) => void;
}

/* Плотность строки — тот же выбор, что и в базах расчётов и инженеров:
   «разглядеть» или «охватить». По две и по четыре карточка живёт целиком:
   знак клиента, цифры, виды работ. По шесть она сжимается до строки
   справочника — адрес, сколько заявок и сколько из них обслужено; знак в
   такой ширине не читается, и его там нет. */
const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

/* По чему упорядочены адреса. Первым идёт порядок по числу заявок — это ответ
   на «куда мы ездим чаще всего»; остальные правила отвечают на «куда не
   доезжаем», «где горит» и «где искать по улице».

   Все правила, кроме алфавитного, открываются «от большего». Покрытие —
   наоборот: там интересен хвост, а не отличники, и «от меньшего» ставит
   сверху адреса, до которых доезжают реже всего. Повторный щелчок по
   выбранному правилу переворачивает порядок. */
type Sort = 'orders' | 'coverage' | 'urgent' | 'access' | 'name';

const SORTS: { value: Sort; label: string; desc: boolean }[] = [
  { value: 'orders', label: 'По числу заявок', desc: true },
  { value: 'coverage', label: 'По покрытию', desc: false },
  { value: 'urgent', label: 'По срочным', desc: true },
  { value: 'access', label: 'По доступу', desc: true },
  { value: 'name', label: 'По алфавиту', desc: false }
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
   Устроена как базы расчётов и инженеров — поиск, отбор, порядок, плотность
   и доска виджетов сверху, — и это осознанное повторение: три справочника об
   одном хозяйстве, и переучивать диспетчера на каждом незачем. */
export function DbClientsScreen({ registry, mode, onOpenRun }: Props) {
  /* Какой адрес открыт карточкой. До сих пор в этой базе не открывался ни
     один: карточка была картинкой, строка — не кнопкой, и вопрос «что мы
     делали по этому адресу» из базы клиентов не решался вовсе. */
  const [opened, setOpened] = useState<ClientRecord | null>(null);
  const [openedOrder, setOpenedOrder] = useState<OrderRecord | null>(null);
  /* С какой плотности открывается база — настройка сервиса, общая с базами
     расчётов и инженеров: одному важно разглядеть, другому охватить. */
  const [perRow, setPerRow] = useState(() => service().perRow as string);
  const [sort, setSort] = useState<Sort>('orders');
  const [desc, setDesc] = useState(true);
  const [filter, setFilter] = useState<Filter>('all');
  const [workType, setWorkType] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const dense = perRow === '6';

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

  /* Отбор и порядок считаем один раз на оба вида: карточки и таблица должны
     показывать одну и ту же выборку, иначе переключение вида молча меняет
     набор. */
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

  /* Что база умеет показать. Считается по всем адресам, а не по выборке:
     доска отвечает на «что у нас за хозяйство», а список — на «покажи мне
     вот эти». Срока здесь нет и быть не может: у точки обслуживания нет
     даты, она живёт по адресу, а не по дню. */
  const widgets = useMemo<WidgetDef[]>(() => {
    const orders = all.reduce((sum, c) => sum + c.orders, 0);
    const assigned = all.reduce((sum, c) => sum + c.assigned, 0);
    const access = all.reduce((sum, c) => sum + c.access, 0);
    const urgent = all.reduce((sum, c) => sum + c.urgent, 0);

    const full = all.filter((c) => c.assigned === c.orders).length;
    const part = all.filter((c) => c.assigned > 0 && c.assigned < c.orders).length;
    const none = all.filter((c) => c.assigned === 0).length;
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
            `${full} обслужены целиком`,
            `${none} не обслужены ни разу`
          ],
          whole: true,
          parts: [
            { key: 'full', label: 'Целиком', value: full, tone: 'ok' },
            { key: 'part', label: 'Частично', value: part, tone: 'warn' },
            { key: 'none', label: 'Ни разу', value: none, tone: 'bad' }
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
          tone: assigned / Math.max(orders, 1) < 0.8 ? 'warn' : 'ok',
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
          whole: true,
          parts: top(
            [...byDistrict.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([district, count]) => ({ key: district, label: district, value: count }))
          ),
          legend: 'заявок'
        }
      }
    ];
  }, [all, registry.workTypeTitle]);

  const board = useWidgetBoard({
    storeKey: 'db-clients',
    catalogue: widgets,
    fallback: ['points', 'orders', 'coverage', 'access', 'urgent']
  });

  return (
    <div className="dash enter">
      {/* Числа шапки и есть доска: отдельным блоком «что иллюстрируем» они
          спорили бы сами с собой — два ряда об одном и том же. */}
      <DbHead title="База клиентов" board={board.node} />

      <section className="panel">
        <div className="filters filters--runs">
          <label className="dbsearch">
            <Icon name="search" size={14} />
            <input
              className="dbsearch__input"
              value={query}
              placeholder="Найти клиента: номер, адрес, район, вид работ"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
            {query && (
              <button type="button" className="dbsearch__clear" onClick={() => setQuery('')}>
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

          {/* Плотность строки — только у карточек: в таблице и в списке
              строка одна и в строке она одна. */}
          {mode !== 'table' && mode !== 'list' && (
            <div className="filters__group">
              <span className="filters__label">Карточек в строке</span>
              <SegmentedControl size="sm" items={DENSITY} value={perRow} onChange={setPerRow} />
            </div>
          )}

          {/* Виды работ — отдельной строкой во всю ширину: их полтора десятка,
              и рядом с переключателями они сминали бы полосу. */}
          <div className="filters__group filters__group--wide">
            <span className="filters__label">Вид работ</span>
            <span className="filters__types">
              {types.map((type) => (
                <button
                  key={type}
                  type="button"
                  className={'chip' + (workType === type ? ' chip--on' : '')}
                  onClick={() => setWorkType(workType === type ? null : type)}
                  aria-pressed={workType === type}
                >
                  <Icon name={workTypeIcon(type)} size={12} />
                  {registry.workTypeTitle[type] ?? type}
                  {workType === type && <Icon name="x" size={12} />}
                </button>
              ))}
            </span>
          </div>

        </div>
      </section>

      {rows.length === 0 ? (
        <section className="panel">
          <p className="clients__lede">
            Под этот отбор не подошёл ни один адрес. Снимите фильтр, сбросьте вид работ или
            очистите поиск.
          </p>
        </section>
      ) : mode === 'list' ? (
        /* Список: адрес — строка. Названием стоит адрес, а не компания: сюда
           приходят с вопросом «куда мы ездим» и «куда не доезжаем», и оба
           вопроса об адресе. Компания и район ушли в подпись — по ним
           уточняют, а не ищут. Строка открывает карточку адреса: его историю,
           тех, кто сюда ездил, и расчёты, в которых он встречался. */
        <DbList
          rows={rows.map((client) => {
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
                { label: 'Покрытие', value: percent(rate), tone: rate < 0.8 ? ('warn' as const) : undefined },
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
                {rows.map((client) => {
                  const rate = coverage(client);
                  return (
                    <tr
                      key={client.key}
                      className="tbl__row"
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
                        <span className={'pill pill--' + (rate < 0.8 ? 'danger' : 'success')}>
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
        </section>
      ) : (
        <div
          className={'runs__grid' + (dense ? ' runs__grid--dense' : '')}
          style={{ '--per-row': perRow } as React.CSSProperties}
        >
          {rows.map((client) => (
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
      )}

      {/* Итог выборки под списком — тот же приём, что во всех справочниках:
          сверху доска отвечает на «как дела вообще», здесь строка отвечает на
          «а что сейчас на экране». Числа выбраны по вопросу самой базы: кто
          это, сколько для него сделали и сколько не доехало. */}
      {rows.length > 0 && (
        <p className="filters__note filters__note--under">
          {plural(rows.length, 'адрес', 'адреса', 'адресов')} в выборке
          {rows.length !== all.length && ` из ${all.length}`}
          {` · ${plural(
            new Set(rows.map((one) => one.company)).size,
            'компания',
            'компании',
            'компаний'
          )}`}
          {` · ${plural(
            rows.reduce((sum, one) => sum + one.orders, 0),
            'заявка',
            'заявки',
            'заявок'
          )}`}
          {` · покрытие ${Math.round(
            (rows.reduce((sum, one) => sum + one.assigned, 0) /
              Math.max(rows.reduce((sum, one) => sum + one.orders, 0), 1)) *
              100
          )}%`}
        </p>
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
