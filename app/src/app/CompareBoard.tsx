import { useMemo, useState } from 'react';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { runCode } from '../data/load.ts';
import { dec } from '../data/derive.ts';

interface Props {
  runs: DaySummary[] | null;
  active: RunId;
  onOpen: (id: RunId) => void;
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

/* Сравнение расчётов. Живёт вкладкой диспетчерской, а не отдельным разделом:
   выбор прогона стоит тут же в подшапке, и сравнение — это тот же вопрос
   «какой расчёт отправлять в работу», только в разрезе нескольких сразу. */
export function CompareBoard({ runs, active, onOpen }: Props) {
  const [dropped, setDropped] = useState<string[]>([]);

  const chosen = useMemo(
    () => (runs ?? []).filter((run) => !dropped.includes(run.id)),
    [runs, dropped]
  );

  /* Сравнивать имеет смысл хотя бы два расчёта: один столбец не с чем
     сопоставлять, поэтому последний снять нельзя. */
  const toggle = (id: string) =>
    setDropped((prev) =>
      prev.includes(id)
        ? prev.filter((x) => x !== id)
        : (runs ?? []).length - prev.length > 2
          ? [...prev, id]
          : prev
    );

  if (!runs) {
    return (
      <section className="panel">
        <p className="stub__body">Собираем расчёты…</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Сравнение расчётов</h2>
        <div className="runs__picks">
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              className={'runs__pick' + (!dropped.includes(run.id) ? ' runs__pick--on' : '')}
              onClick={() => toggle(run.id)}
              aria-pressed={!dropped.includes(run.id)}
            >
              {runCode(run.id)}
            </button>
          ))}
        </div>
      </div>

      <p className="clients__lede">
        Одни и те же заявки и инженеры, разные раскладки движка. Лучшее число в строке отмечено —
        по нему и выбирают, какой расчёт отправлять в работу.
      </p>

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
    </section>
  );
}
