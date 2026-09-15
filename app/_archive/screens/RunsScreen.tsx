import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayId, DaySummary } from '../data/load.ts';
import { loadSummaries, runCode } from '../data/load.ts';
import { dec } from '../data/derive.ts';

interface Props {
  active: DayId;
  /** Вкладка подшапки: карточки расчётов или их сравнение. */
  mode: string;
  onOpen: (day: DayId) => void;
  onCompare: () => void;
}

/* Строки сравнения. `better` говорит, в какую сторону число лучше: по нему
   подсвечивается победитель столбца, иначе таблицу пришлось бы читать
   с калькулятором. */
interface Line {
  key: string;
  label: string;
  value: (run: DaySummary) => number;
  show: (run: DaySummary) => string;
  better: 'up' | 'down';
}

const LINES: Line[] = [
  {
    key: 'coverage',
    label: 'Покрытие',
    value: (run) => run.coverage,
    show: (run) => `${dec(run.coverage)} %`,
    better: 'up'
  },
  {
    key: 'assigned',
    label: 'Разложено заявок',
    value: (run) => run.ordersAssigned,
    show: (run) => `${run.ordersAssigned} из ${run.ordersTotal}`,
    better: 'up'
  },
  {
    key: 'unassigned',
    label: 'Без инженера',
    value: (run) => run.unassigned,
    show: (run) => String(run.unassigned),
    better: 'down'
  },
  {
    key: 'crew',
    label: 'Инженеров с маршрутом',
    value: (run) => run.engineersOnShift,
    show: (run) => `${run.engineersOnShift} из ${run.engineersTotal}`,
    better: 'up'
  },
  {
    key: 'gap',
    label: 'Разрыв загрузки',
    value: (run) => run.occupancyMax / Math.max(run.occupancyMin, 0.01),
    show: (run) => `${dec(run.occupancyMax / Math.max(run.occupancyMin, 0.01))} ×`,
    better: 'down'
  },
  {
    key: 'gini',
    label: 'Неравномерность',
    value: (run) => run.gini,
    show: (run) => dec(run.gini, 2),
    better: 'down'
  }
];

/* Расчёты движка. Каждый — самостоятельный расклад заявок по инженерам под
   своим номером; к календарю он не привязан, поэтому ни «дня 1», ни даты
   в карточке нет. Открытый расчёт питает диспетчерскую, гант и карту. */
export function RunsScreen({ active, mode, onOpen, onCompare }: Props) {
  const [runs, setRuns] = useState<DaySummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadSummaries()
      .then((list) => {
        if (cancelled) return;
        setRuns(list);
        setPicked(list.map((run) => run.id));
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const chosen = useMemo(
    () => (runs ?? []).filter((run) => picked.includes(run.id)),
    [runs, picked]
  );

  /* Сравнивать имеет смысл хотя бы два расчёта: один столбец не с чем
     сопоставлять, поэтому последний из выбранных снять нельзя. */
  const toggle = (id: string) =>
    setPicked((prev) =>
      prev.includes(id) ? (prev.length > 1 ? prev.filter((x) => x !== id) : prev) : [...prev, id]
    );

  const compareWith = (id: DayId) => {
    setPicked((prev) => (prev.includes(id) ? prev : [...prev, id]));
    onCompare();
  };

  if (failed) {
    return (
      <div className="stub enter">
        <h2 className="stub__title">Расчёты не загрузились</h2>
        <p className="stub__body">
          Источник данных не ответил. Обновите страницу или проверьте, что сервер поднят.
        </p>
      </div>
    );
  }

  if (!runs) {
    return (
      <div className="stub enter">
        <p className="stub__body">Собираем расчёты…</p>
      </div>
    );
  }

  if (mode === 'compare') {
    return (
      <div className="runs enter">
        <div className="runs__head">
          <p className="runs__lede">
            Одни и те же заявки и инженеры, разные раскладки движка. Лучшее число в строке
            отмечено — по нему и выбирают, какой расчёт отправлять в работу.
          </p>
          <div className="runs__picks">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={'runs__pick' + (picked.includes(run.id) ? ' runs__pick--on' : '')}
                onClick={() => toggle(run.id)}
                aria-pressed={picked.includes(run.id)}
              >
                {runCode(run.id)}
              </button>
            ))}
          </div>
        </div>

        <div className="cmp">
          <div className="cmp__row cmp__row--head">
            <span className="cmp__key" />
            {chosen.map((run) => (
              <span key={run.id} className="cmp__col">
                <span className="cmp__code">{runCode(run.id)}</span>
                {run.id === active ? (
                  <Badge tone="accent" dot>
                    открыт
                  </Badge>
                ) : (
                  <button type="button" className="cmp__open" onClick={() => onOpen(run.id)}>
                    открыть
                  </button>
                )}
              </span>
            ))}
          </div>

          {LINES.map((line) => {
            const values = chosen.map((run) => line.value(run));
            const best = line.better === 'up' ? Math.max(...values) : Math.min(...values);
            return (
              <div className="cmp__row" key={line.key}>
                <span className="cmp__key">{line.label}</span>
                {chosen.map((run, index) => (
                  <span
                    key={run.id}
                    className={'cmp__cell' + (values[index] === best ? ' cmp__cell--best' : '')}
                  >
                    {line.show(run)}
                    {values[index] === best && <Icon name="check" size={12} />}
                  </span>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="runs enter">
      <div className="runs__head">
        <p className="runs__lede">
          Каждый расчёт — отдельный разбор связей «заявка — инженер». Открытый питает
          диспетчерскую, гант и карту.
        </p>
        <button type="button" className="runs__compare" onClick={onCompare}>
          <Icon name="bar-chart-3" size={14} />
          Сравнить расчёты
        </button>
      </div>

      <div className="runs__grid">
        {runs.map((run) => {
          const isActive = run.id === active;
          return (
            <article key={run.id} className={'runcard' + (isActive ? ' runcard--active' : '')}>
              <div className="runcard__head">
                <span className="runcard__code">{runCode(run.id)}</span>
                {isActive && (
                  <Badge tone="accent" dot>
                    открыт
                  </Badge>
                )}
              </div>

              <span className="runcard__value">
                {dec(run.coverage)}
                <span className="runcard__unit">%</span>
              </span>
              <span className="runcard__label">Покрытие</span>

              <div className="runcard__facts">
                <span className="runcard__fact">
                  <b>{run.ordersAssigned}</b> из {run.ordersTotal} заявок разложено
                </span>
                <span className={'runcard__fact' + (run.unassigned > 0 ? ' runcard__fact--bad' : '')}>
                  <b>{run.unassigned}</b> без инженера
                </span>
                <span className="runcard__fact">
                  <b>{run.engineersOnShift}</b> из {run.engineersTotal} инженеров с маршрутом
                </span>
              </div>

              {/* Действия те же, что в пульте расчёта, — сохранить, сравнить,
                  выгрузить. Открыть можно только чужой расчёт. */}
              <div className="runcard__actions">
                {!isActive && (
                  <button type="button" className="runcard__go" onClick={() => onOpen(run.id)}>
                    <Icon name="arrow-right" size={13} />
                    Открыть
                  </button>
                )}
                <button
                  type="button"
                  className="runcard__act"
                  onClick={() => compareWith(run.id)}
                >
                  <Icon name="bar-chart-3" size={13} />
                  Сравнить
                </button>
                <button className="runcard__act" type="button" disabled title="Подключается к серверу">
                  <Icon name="check" size={13} />
                  Сохранить
                </button>
                <button className="runcard__act" type="button" disabled title="Подключается к серверу">
                  <Icon name="arrow-up-right" size={13} />
                  Экспорт
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
