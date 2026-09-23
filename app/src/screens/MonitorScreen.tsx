import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { buildLiveRoster, cutMinutes, dayEnd, dayStart, hhmm, LIVE_STATUS_ORDER, placeOf } from '../data/derive.ts';
import type { LiveEngineer } from '../data/derive.ts';
import { runDate } from '../data/load.ts';
import { MapBoard } from '../app/MapBoard.tsx';

interface Props {
  /** Расчёт, чей план на карте: по нему у маршрутов их собственные номера. */
  runId: string;
  view: DayView;
  live: string | null;
  onLive: (engineerId: string | null) => void;
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
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
  live,
  onLive,
  pinned,
  onPin,
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

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Мониторинг</h2>
          {/* Часы настенные и не замирают: срез плана прижат к границам
              смены, и это сказано отдельной строкой ниже, а не подменой
              времени — «21:00, обновлено 21:30» читалось как поломка. */}
          <span className="livenow" title="Текущее время: раздел показывает состояние плана на эту минуту и обновляется сам">
            <span className="livenow__dot" />
            {hhmm(wall)}
            <span className="livenow__stamp">
              {planDay ? `план от ${planDay} · ` : ''}обновлено {hhmm(wall)}
            </span>
          </span>
        </div>

        {(beforeShift || afterShift) && (
          <p className="clients__lede">
            {beforeShift
              ? `Смена по плану начинается в ${hhmm(dayStart())}: часы ещё вне рабочего окна, ниже показан план на его начало.`
              : `Смена по плану закончилась в ${hhmm(dayEnd())}: часы уже вне рабочего окна, ниже показано положение на её конец.`}
          </p>
        )}

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

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Карта сейчас</h2>
        </div>
        <MapBoard
          view={view}
          runId={runId}
          live={live}
          onLive={onLive}
          pinned={pinned}
          onPin={onPin}
          focus={focus}
          onSelectOrder={onSelectOrder}
          onSelectEngineer={onSelectEngineer}
        />
      </section>
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
