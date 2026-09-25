import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import {
  buildDayView,
  buildLiveRoster,
  cutMinutes,
  dayEnd,
  dayStart,
  hhmm,
  LIVE_STATUS_ORDER,
  mergeDays,
  placeOf,
  pluralWord
} from '../data/derive.ts';
import type { LiveEngineer } from '../data/derive.ts';
import { loadDay, runCode, runDate } from '../data/load.ts';
import type { RunId } from '../data/load.ts';
import { dayLabel, useDuty } from '../data/duty.ts';
import { loadTraffic } from '../data/traffic.ts';
import type { Traffic } from '../data/traffic.ts';
import { MapBoard } from '../app/MapBoard.tsx';

interface Props {
  /** Открытый расчёт: его день уже загружен и приходит в `view` вместе с
      отметками журнала. */
  runId: string;
  /** Рабочие расчёты дней, за которыми смотрят. Их планы раздел догружает
      сам и кладёт на одну карту. Пусто — смотреть не за чем. */
  runs: RunId[];
  /** Вернуться к выбору дней. */
  onBack: () => void;
  /** Вид раздела: «обзор» — город во весь экран с полосой живых чисел,
      «сводка» — те же числа списком, опаздывающие и состав смены. */
  mode: string;
  view: DayView;
  live: string | null;
  onLive: (engineerId: string | null) => void;
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  /** Показать маршрут, не переключая: щелчок по заявке оставляет её путь на
      карте, сколько бы раз по заявкам этого пути ни щёлкали. */
  onShowRoute: (engineerId: string | null) => void;
  focus: number;
  onSelectOrder: (id: string | null) => void;
  onSelectEngineer: (id: string) => void;
}

const RANK: Record<string, number> = Object.fromEntries(
  LIVE_STATUS_ORDER.map((key, index) => [key, index])
);

/* Мониторинг. Диспетчерская отвечает на «каким должен быть план» и живёт от
   среза, который двигает диспетчер; мониторинг отвечает на «что происходит
   сейчас» и читает то же время, что на часах, — сам, без ручки. Здесь нет
   пересчёта и нет пульта: только то, что план обещал, и то, что видно на
   срезе прямо сейчас. */
export function MonitorScreen({
  view,
  runId,
  runs,
  onBack,
  mode,
  live,
  onLive,
  pinned,
  onPin,
  onShowRoute,
  focus,
  onSelectOrder,
  onSelectEngineer
}: Props) {
  const [now, setNow] = useState(() => new Date());

  /* Часы плана дискретны по минутам, поэтому раз в двадцать секунд достаточно:
     ничего чаще минуты в данных всё равно не изменится, а отметка «обновлено»
     живой оставаться должна. */
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);

  /* Дни участков, за которыми смотрят, кладутся на одну карту.

     План открытого расчёта уже загружен и приходит готовым видом — с
     отметками журнала. Остальные раздел догружает сам, и журнала у них нет:
     движок ведёт его от одного плана, и чужие факты в чужой день не
     переносятся. Поэтому у догруженных дней отметок пусто, а состояние людей
     считается по плану и часам — ровно то, что мониторинг и обещает. */
  const [others, setOthers] = useState<Map<RunId, DayView>>(new Map());
  const wanted = runs.filter((id) => id !== runId).join('|');
  useEffect(() => {
    let alive = true;
    const need = wanted ? wanted.split('|') : [];
    if (need.length === 0) {
      setOthers(new Map());
      return;
    }
    Promise.all(
      need.map((id) =>
        loadDay(id)
          .then((day) => [id, buildDayView(day, {})] as const)
          .catch(() => null)
      )
    ).then((pairs) => {
      if (!alive) return;
      setOthers(new Map(pairs.filter((pair): pair is readonly [string, DayView] => Boolean(pair))));
    });
    return () => {
      alive = false;
    };
  }, [wanted]);

  /* Что показываем: открытый день плюс догруженные, в том порядке, в каком
     их отметили. Пока чужой день грузится, на карте просто меньше участков —
     это честнее, чем держать её пустой до последнего ответа. */
  const merged = useMemo(() => {
    const parts = runs
      .map((id) => ({ runId: id, view: id === runId ? view : others.get(id) }))
      .filter((one): one is { runId: RunId; view: DayView } => Boolean(one.view));
    return mergeDays(parts.length > 0 ? parts : [{ runId, view }]);
  }, [runs, runId, view, others]);
  const shown = merged?.view ?? view;

  /* Чей маршрут, когда участков несколько: номер сквозной по базе и считается
     от пары «расчёт — инженер», а не от составного номера с общей карты. */
  const routeKeyOf = (engineerId: string) =>
    merged?.owner.get(engineerId) ?? { runId, engineerId };

  /* Обстановка в городе. Читается при открытии и раз в пять минут: баллы
     держатся дольше, а чаще спрашивать чужой источник незачем. Не ответил —
     строки о пробках на плашке просто нет. */
  const [traffic, setTraffic] = useState<Traffic | null>(null);
  useEffect(() => {
    let alive = true;
    const ask = () => {
      loadTraffic().then((next) => {
        if (alive) setTraffic(next);
      });
    };
    ask();
    const id = window.setInterval(ask, 300_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  /* Подписка на «взят в работу»: сам список не нужен — нужно, чтобы плашка
     перерисовалась, когда расчёт берут в работу или снимают с неё. */
  useDuty();

  /* Участки, за которыми смотрим, и их рабочие расчёты — строками для
     плашки. Имя участка берём у того же слоя, что собирает ключ дня: так
     подпись на карте и подпись на кнопке «В работу» не разойдутся. */
  const watchRows = runs.map((id) => ({
    id,
    code: runCode(id),
    place: dayLabel(id, runDate(id)).split(' · ')[0]
  }));

  const cut = cutMinutes(now);
  const wall = now.getHours() * 60 + now.getMinutes();
  const beforeShift = wall < dayStart();
  const afterShift = wall > dayEnd();
  /* Какой день разложен в плане. Часы идут настенные, а план — на день
     выгрузки, и без подписи «сейчас 14:20» на плане 17 августа читалось бы
     как сегодняшнее положение дел. */
  const planDay = runDate(runId).split('-').reverse().join('.');

  const roster = useMemo(() => buildLiveRoster(shown, cut), [shown, cut]);
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

  /* Ход работы числами. Одни и те же в обоих видах — в обзоре полосой поверх
     города, в сводке плитками над списком, — поэтому считаются один раз.

     Порядок не случаен: сперва те, кто сейчас в деле, потом беда, потом
     запас. Опаздывающие стоят третьими, а не первыми: читают полосу слева
     направо, и начинать день с чужой беды незачем — она никуда не денется
     и помечена цветом. */
  const tiles = [
    { key: 'working', label: 'На объекте', value: counts.get('working') ?? 0, caption: 'Работают прямо сейчас', bad: false },
    { key: 'enroute', label: 'В пути', value: counts.get('enroute') ?? 0, caption: 'Едут к следующей заявке', bad: false },
    { key: 'overdue', label: 'Опаздывают', value: counts.get('overdue') ?? 0, caption: 'Не успевают к сроку', bad: true },
    { key: 'done', label: 'Освободились', value: counts.get('done') ?? 0, caption: 'День закончен', bad: false },
    {
      key: 'before',
      label: 'Ещё не в работе',
      value: (counts.get('before') ?? 0) + (counts.get('no-route') ?? 0),
      caption: 'Смена не началась',
      bad: false
    }
  ];

  /* Часы настенные и не замирают: срез плана прижат к границам смены, и это
     сказано отдельной строкой, а не подменой времени — «21:00, обновлено
     21:30» читалось как поломка. */
  const clock = (
    <span className="livenow" title="Текущее время: раздел показывает состояние плана на эту минуту и обновляется сам">
      <span className="livenow__dot" />
      {hhmm(wall)}
      <span className="livenow__stamp">
        {planDay ? `план от ${planDay} · ` : ''}обновлено {hhmm(wall)}
      </span>
    </span>
  );

  const offShift =
    beforeShift || afterShift ? (
      <p className="clients__lede">
        {beforeShift
          ? `Смена по плану начинается в ${hhmm(dayStart())}: часы ещё вне рабочего окна, показано положение на её начало.`
          : `Смена по плану закончилась в ${hhmm(dayEnd())}: часы уже вне рабочего окна, показано положение на её конец.`}
      </p>
    ) : null;

  /* Обзор — город во весь экран, как в диспетчерской, а числа полосой поверх
     него. Мониторинг отвечает на «как идёт работа», и ответ этот прежде
     всего зрительный: где люди сейчас, кто куда едет. Таблица под картой на
     этот вопрос отвечала последней — до неё доезжали колесом. */
  if (mode === 'overview') {
    return (
      <div className="mapview enter">
        <MapBoard
          view={shown}
          runId={runId}
          routeKeyOf={routeKeyOf}
          live={live}
          onLive={onLive}
          pinned={pinned}
          onPin={onPin}
          focus={focus}
          onSelectOrder={(id) => {
            onSelectOrder(id);
            onShowRoute(id ? (shown.stopByOrder.get(id)?.engineerId ?? null) : null);
          }}
          onSelectEngineer={onSelectEngineer}
          fill
          routesTitle="Маршруты на сегодня"
          topRight={
            <section className="livecard" aria-label="Смена сейчас">
              <span className="livecard__now">
                <span className="livecard__dot" aria-hidden="true" />
                <span className="livecard__time">{hhmm(wall)}</span>
              </span>

              <span className="livecard__rows">
                {/* Строка на каждый участок, за которым смотрят: какой план
                    ведёт его день. Участков бывает три, и общая подпись
                    «расчёт R013» на три района была бы неправдой — у каждого
                    свой рабочий расчёт. */}
                {watchRows.map((row) => (
                  <span className="livecard__row" key={row.id}>
                    <span className="livecard__label">{row.place}</span>
                    <span className="livecard__value">{row.code}</span>
                  </span>
                ))}

                {/* Пробки в городе. Нет строки — нет и сведений: источник не
                    ответил, и выдумывать баллы нельзя, по ним судят о
                    причинах опозданий. */}
                {traffic && (
                  <span className="livecard__row">
                    <span className="livecard__label">Пробки в Москве</span>
                    <span className="livecard__value">
                      <span className={'livecard__jam livecard__jam--' + traffic.tone} />
                      {traffic.level} {pluralWord(traffic.level, 'балл', 'балла', 'баллов')}
                    </span>
                  </span>
                )}
              </span>

              {(beforeShift || afterShift) && (
                <span className="livecard__off">
                  {beforeShift
                    ? `Смена по плану с ${hhmm(dayStart())} — показано её начало.`
                    : `Смена по плану до ${hhmm(dayEnd())} — показан её конец.`}
                </span>
              )}

              <span className="livecard__foot">
                <span className="livecard__stamp">обновлено {hhmm(wall)}</span>
                {/* Дорога назад к выбору дней — здесь же, в плашке: она и
                    говорит, за чем смотрим, ей и менять. */}
                <button type="button" className="livecard__back" onClick={onBack}>
                  Сменить день
                </button>
              </span>
            </section>
          }
          /* Числа хода работы — полосой внизу, на том же месте, где в
             диспетчерской стоят итоги расчёта: там их и ищут глазами. Наверху
             справа — состояние смены, здесь — её счёт. */
          aside={
            <div className="mapdrag">
              <section className="mapstat" aria-label="Ход работы сейчас">
                <div className="mapstat__metrics">
                  {tiles.map((tile) => (
                    <span key={tile.key} className="cmetric cmetric--flat" title={tile.caption}>
                      <span className="cmetric__label">
                        {tile.bad && tile.value > 0 && (
                          <span className="cmetric__dot cmetric__dot--bad" />
                        )}
                        {tile.label}
                      </span>
                      <span className="cmetric__value">
                        {tile.value}
                        <span className="cmetric__unit">чел.</span>
                      </span>
                      <span className="cmetric__caption">{tile.caption}</span>
                    </span>
                  ))}
                </div>
              </section>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Ход работы</h2>
          {clock}
        </div>

        {offShift}

        <div className="dbstats">
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('working') ?? 0}</span>
            <span className="dbstat__label">На объекте</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('enroute') ?? 0}</span>
            <span className="dbstat__label">В пути</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('overdue') ?? 0}</span>
            <span className="dbstat__label">Опаздывают</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{counts.get('done') ?? 0}</span>
            <span className="dbstat__label">Освободились</span>
          </div>
          <div className="dbstat">
            <span className="dbstat__value">{(counts.get('before') ?? 0) + (counts.get('no-route') ?? 0)}</span>
            <span className="dbstat__label">Ещё не в работе</span>
          </div>
        </div>
      </section>

      {alerts.length > 0 && (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Требуют внимания</h2>
            <span className="dash__section-note">{alerts.length} опаздывают прямо сейчас</span>
          </div>
          <div className="alerts">
            {alerts.map((row) => (
              <button
                key={row.engineer.id}
                type="button"
                className="alert alert--danger"
                onClick={() => row.orderId && onSelectOrder(row.orderId)}
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

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Инженеры на смене</h2>
        </div>
        {/* Пустой состав — словами: в расчёте без инженеров пустой список
            читался бы как несработавший экран. */}
        {sorted.length === 0 ? (
          <p className="clients__lede">В этом расчёте на смене никого нет: план посчитан без инженеров.</p>
        ) : (
          <div className="roster">
            {sorted.map((row) => (
              <RosterRow
                key={row.engineer.id}
                row={row}
                view={shown}
                active={live === row.engineer.id || pinned === row.engineer.id}
                onLive={onLive}
                onPin={onPin}
                onSelectEngineer={onSelectEngineer}
              />
            ))}
          </div>
        )}
      </section>

      {/* Карты здесь нет: город живёт в «Обзоре», во весь экран. Вторая
          карта под списком повторяла бы ту же работу вполовину меньшего
          размера, и смотреть на движение людей было бы неудобно в обоих
          местах сразу. */}
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
