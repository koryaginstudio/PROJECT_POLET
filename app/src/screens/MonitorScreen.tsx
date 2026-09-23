import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView, LiveEngineer, LiveStatus } from '../data/derive.ts';
import { buildLiveRoster, cutMinutes, dayEnd, dayStart, hhmm, LIVE_STATUS_ORDER, placeOf } from '../data/derive.ts';
import { runDate } from '../data/load.ts';
import { MapBoard } from '../app/MapBoard.tsx';
import { canGoBack, DemoDialog, demoPending, markDemoShown } from '../app/DemoDialog.tsx';
import { START, writeRoute } from '../app/route.ts';

interface Props {
  /** Расчёт, чей план на карте: по нему у маршрутов их собственные номера. */
  runId: string;
  view: DayView;
  live: string | null;
  onLive: (engineerId: string | null) => void;
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  focus: number;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

const RANK: Record<string, number> = Object.fromEntries(
  LIVE_STATUS_ORDER.map((key, index) => [key, index])
);

/* Пять чисел смены. «Ещё не в работе» — два состояния сразу: у одного смена
   не началась, у другого нет маршрута; оператору это одно и то же — человек,
   с которого сейчас нечего спросить. */
const TILES: { key: string; label: string; of: LiveStatus[] }[] = [
  { key: 'working', label: 'На объекте', of: ['working'] },
  { key: 'enroute', label: 'В пути', of: ['enroute'] },
  { key: 'overdue', label: 'Опаздывают', of: ['overdue'] },
  { key: 'done', label: 'Освободились', of: ['done'] },
  { key: 'idle', label: 'Ещё не в работе', of: ['before', 'no-route'] }
];

/* Мониторинг. Диспетчерская отвечает на «каким должен быть план» и живёт от
   среза, который двигает диспетчер; мониторинг отвечает на «что происходит
   сейчас» и читает то же время, что на часах, — сам, без ручки. Здесь нет
   пересчёта и нет пульта: только то, что план обещал, и то, что видно на
   срезе прямо сейчас.

   Раздел собран как «Обзор»: карта — не блок на странице, а сам экран, а
   числа, тревоги и люди стоят колонкой поверх неё. Лентой панелей он был
   длиной в два с половиной экрана, и карта начиналась на исходе второго —
   то есть в разделе про «где все сейчас» города не было видно вовсе, пока
   не долистаешь. Колонка ещё и снимает второй список тех же инженеров:
   правая полоса «Что на карте» на мониторинге больше не показывается. */
export function MonitorScreen({
  view,
  runId,
  live,
  onLive,
  pinned,
  onPin,
  focus,
  onSelectOrder,
  onSelectEngineer
}: Props) {
  const [now, setNow] = useState(() => new Date());

  /* Окно «это тестовый режим» — при первом входе в раздел за загрузку
     страницы. Почему так, а не строкой наверху и не памятью браузера, —
     у DemoDialog. */
  const [demo, setDemo] = useState(demoPending);
  const closeDemo = useCallback(() => {
    markDemoShown();
    setDemo(false);
  }, []);

  /* «Назад» — не согласие, а уход: окно показанным не помечаем, вернутся в
     раздел — предупредим снова. Возвращает туда, откуда пришли, а если
     программу открыли сразу на «Мониторинге» — на её начальный экран. */
  const backFromDemo = useCallback(() => {
    if (canGoBack()) window.history.back();
    else window.location.hash = writeRoute(START());
  }, []);

  /* Часы плана дискретны по минутам, поэтому раз в двадцать секунд достаточно:
     ничего чаще минуты в данных всё равно не изменится, а отметка «обновлено»
     живой оставаться должна. */
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  const cut = cutMinutes(now);
  const wall = now.getHours() * 60 + now.getMinutes();
  const beforeShift = wall < dayStart();
  const afterShift = wall > dayEnd();
  /* Какой день разложен в плане. Часы идут настенные, а план — на день
     выгрузки, и без подписи «сейчас 14:20» на плане 17 августа читалось бы
     как сегодняшнее положение дел. */
  const planDay = runDate(runId).split('-').reverse().join('.');

  const roster = useMemo(() => buildLiveRoster(view, cut), [view, cut]);
  const sorted = useMemo(
    () => [...roster].sort((a, b) => RANK[a.status] - RANK[b.status] || a.engineer.name.localeCompare(b.engineer.name)),
    [roster]
  );
  const alerts = useMemo(
    () => sorted.filter((row) => row.status === 'overdue'),
    [sorted]
  );
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of roster) map.set(row.status, (map.get(row.status) ?? 0) + 1);
    return map;
  }, [roster]);

  /* На что нажали последним. Раньше выбранную заявку показывала правая
     полоса — «Требуют внимания» вело в неё; полосы здесь больше нет, и без
     этого нажатие на тревогу не отвечало ничем. Отвечает сама карта: точку
     обводит и подъезжает к ней. Наверх выбор всё равно уходит — им живут
     поиск и карточки справочника. */
  const [atOrder, setAtOrder] = useState<string | null>(null);
  const chooseOrder = useCallback(
    (id: string) => {
      setAtOrder(id);
      onSelectOrder(id);
    },
    [onSelectOrder]
  );

  /* Выбранное число — оно же фильтр карты. Пять чисел отвечали на вопрос
     «сколько», но не на следующий за ним — «а где они»; за ответом
     приходилось водить глазами по списку и искать те же фамилии на карте. */
  const [picked, setPicked] = useState<string | null>(null);
  const tile = TILES.find((one) => one.key === picked) ?? null;
  const shown = useMemo(
    () => (tile ? sorted.filter((row) => tile.of.includes(row.status)) : sorted),
    [sorted, tile]
  );

  /* День, суженный до выбранных людей. Карта читает из него четыре вещи —
     loads, orderById, stopByOrder, engineerById, — и согласованно сузить их
     довольно, чтобы на карте остались только эти маршруты и только их точки.
     Сам день не трогаем: колонка, подсказки и карточки читают его целиком.

     Невзятые заявки при выбранном числе тоже уходят: вопрос «где те, кто
     опаздывает» — не про них. */
  const mapView = useMemo(() => {
    if (!tile) return view;
    const ids = new Set(shown.map((row) => row.engineer.id));
    const stopByOrder = new Map(
      [...view.stopByOrder].filter(([, placement]) => ids.has(placement.engineerId))
    );
    return {
      ...view,
      loads: view.loads.filter((load) => ids.has(load.engineer.id)),
      stopByOrder,
      orderById: new Map([...view.orderById].filter(([id]) => stopByOrder.has(id))),
      engineerById: new Map([...view.engineerById].filter(([id]) => ids.has(id)))
    };
  }, [view, tile, shown]);

  const panel = (
    <div className="monpanel">
      <div className="monpanel__head">
        {/* Часы настенные и не замирают: срез плана прижат к границам
            смены, и это сказано отдельной строкой ниже, а не подменой
            времени — «21:00, обновлено 21:30» читалось как поломка. */}
        <span
          className="livenow"
          title="Текущее время: раздел показывает состояние плана на эту минуту и обновляется сам"
        >
          <span className="livenow__dot" />
          {hhmm(wall)}
        </span>
        <span className="monpanel__plan">план от {planDay}</span>
      </div>

      {(beforeShift || afterShift) && (
        <p className="monpanel__lede">
          {beforeShift
            ? `Смена по плану начинается в ${hhmm(dayStart())}: часы ещё вне рабочего окна, показан план на её начало.`
            : `Смена по плану закончилась в ${hhmm(dayEnd())}: часы уже вне рабочего окна, показано положение на её конец.`}
        </p>
      )}

      <div className="monpanel__tiles">
        {TILES.map((one) => {
          const value = one.of.reduce((sum, key) => sum + (counts.get(key) ?? 0), 0);
          const on = picked === one.key;
          return (
            <button
              key={one.key}
              type="button"
              className={'montile' + (on ? ' montile--on' : '')}
              /* Пустое число нажимать незачем: фильтр по нему оставил бы
                 пустую карту и пустой список. */
              disabled={value === 0}
              aria-pressed={on}
              onClick={() => setPicked(on ? null : one.key)}
            >
              <span className="montile__value">{value}</span>
              <span className="montile__label">{one.label}</span>
            </button>
          );
        })}
      </div>

      {tile && (
        <p className="monpanel__filter">
          На карте только «{tile.label}»
          <button type="button" className="monpanel__reset" onClick={() => setPicked(null)}>
            Показать всех
          </button>
        </p>
      )}

      {/* Тревоги и люди прокручиваются, часы и числа — нет: смотреть на них
          оператор может в любую минуту, а искать их прокруткой незачем. */}
      <div className="monpanel__body">
        {alerts.length > 0 && (
          <section className="monpanel__block">
            <div className="monpanel__block-head">
              <h2 className="monpanel__block-title">Требуют внимания</h2>
              <span className="monpanel__block-note">{alerts.length}</span>
            </div>
            <div className="alerts">
              {alerts.map((row) => (
                <button
                  key={row.engineer.id}
                  type="button"
                  className="alert alert--danger"
                  onClick={() => row.orderId && chooseOrder(row.orderId)}
                  onMouseEnter={() => onLive(row.engineer.id)}
                  onMouseLeave={() => onLive(null)}
                >
                  <Icon name="alert-triangle" size={16} />
                  <span className="alert__body">
                    <span className="alert__title">{row.engineer.name}</span>
                    <span className="alert__note">
                      Опаздывает на {row.lateMinutes} мин
                      {row.orderId ? ` · заявка ${row.orderId}` : ''}
                    </span>
                  </span>
                  <Icon name="chevron-right" size={14} />
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="monpanel__block">
          <div className="monpanel__block-head">
            <h2 className="monpanel__block-title">Инженеры на смене</h2>
            <span className="monpanel__block-note">
              {tile ? `${shown.length} из ${sorted.length}` : sorted.length}
            </span>
          </div>
          {/* Пустой состав — словами: в расчёте без инженеров пустой список
              читался бы как несработавший экран. */}
          {shown.length === 0 ? (
            /* Пусто бывает по двум разным причинам, и путать их нельзя:
               в расчёте вовсе нет инженеров — или выбранное число обнулилось,
               пока фильтр держали (часы идут, состояния меняются). */
            <p className="monpanel__lede">
              {tile
                ? `Сейчас под «${tile.label}» никого: за то время, что фильтр держали, состояние сменилось.`
                : 'В этом расчёте на смене никого нет: план посчитан без инженеров.'}
            </p>
          ) : (
            <div className="roster">
              {shown.map((row) => (
                <RosterRow
                  key={row.engineer.id}
                  row={row}
                  view={view}
                  active={live === row.engineer.id || pinned === row.engineer.id}
                  onLive={onLive}
                  onPin={onPin}
                  onSelectEngineer={onSelectEngineer}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );

  return (
    <div className="mapview mapview--monitor enter">
      <DemoDialog open={demo} onClose={closeDemo} onBack={backFromDemo} />

      <MapBoard
        view={mapView}
        runId={runId}
        live={live}
        onLive={onLive}
        pinned={pinned}
        onPin={onPin}
        focus={focus}
        onSelectOrder={chooseOrder}
        onSelectEngineer={onSelectEngineer}
        selectedOrder={atOrder}
        fill
        aside={panel}
      />
    </div>
  );
}

function RosterRow({
  row,
  view,
  active,
  onLive,
  onPin,
  onSelectEngineer
}: {
  row: LiveEngineer;
  view: DayView;
  active: boolean;
  onLive: (id: string | null) => void;
  onPin: (id: string | null) => void;
  onSelectEngineer: (id: string) => void;
}) {
  /* Куда едет и что делает — адресом и видом работ, а не одним номером:
     «Едет к R0193» ничего не говорит тому, кто не держит номера в голове.
     Номер остаётся в подсказке. */
  const target = row.orderId ? view.orderById.get(row.orderId) : undefined;
  const where = target ? `${placeOf(target)} · ${target.work_title}` : row.orderId ?? '';
  return (
    <button
      type="button"
      className={'roster__row' + (active ? ' roster__row--active' : '')}
      onMouseEnter={() => onLive(row.engineer.id)}
      onMouseLeave={() => onLive(null)}
      onClick={() => {
        onPin(row.engineer.id);
        onSelectEngineer(row.engineer.id);
      }}
    >
      <span className="roster__name">{row.engineer.name}</span>
      <span className={'pill pill--' + row.tone}>{row.label}</span>
      <span className="roster__note" title={row.orderId ? `Заявка ${row.orderId}` : undefined}>
        {row.status === 'overdue' && `Опаздывает на ${row.lateMinutes} мин${where ? ` · ${where}` : ''}`}
        {row.status === 'working' && row.orderId && `Работает: ${where}`}
        {row.status === 'enroute' && row.orderId && `Едет: ${where}`}
        {(row.status === 'done' || row.status === 'before' || row.status === 'no-route') && '—'}
      </span>
      <span className="roster__visits">
        {row.visitsDone} из {row.visitsTotal}
      </span>
    </button>
  );
}
