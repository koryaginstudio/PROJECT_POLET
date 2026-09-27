import { useMemo, useState } from 'react';
import type { PeriodKey } from '../app/DbWidgets.tsx';
import { WidgetPeriod, withinPeriod } from '../app/DbWidgets.tsx';
import type { Registry } from '../data/registry.ts';
import type { DaySummary, RunId } from '../data/load.ts';
import { CompareScreen } from './CompareScreen.tsx';
import { StatsBlank } from './stats/parts.tsx';
import { scopeOf } from './stats/scope.ts';
import type { DimProps } from './stats/dims.ts';
import { StatsDigest } from './stats/StatsDigest.tsx';
import { StatsRuns } from './stats/StatsRuns.tsx';
import { StatsOrders } from './stats/StatsOrders.tsx';
import { StatsServices } from './stats/StatsServices.tsx';
import { StatsEngineers } from './stats/StatsEngineers.tsx';
import { StatsClients } from './stats/StatsClients.tsx';
import { StatsRoutes } from './stats/StatsRoutes.tsx';

/* Статистика.

   Раздел смотрит на всю историю расчётов и отвечает на «сколько и куда идёт».
   Разрезов восемь, и они лежат вкладками в подшапке: сводка, шесть хозяйств —
   теми же и в том же порядке, что базы данных, — и сравнение.

   Разница между вкладкой статистики и одноимённой базой в вопросе. База
   отвечает на «что у нас есть»: перечень записей, который листают и в котором
   ищут. Статистика — на «сколько»: то же хозяйство, сложенное в числа, доли и
   ряды по расчётам.

   Сравнение прежде было отдельным разделом рядом в меню. Это та же статистика,
   только по двум-четырём отобранным расчётам вместо всей истории, и держать
   под неё отдельный пункт значило делить один разговор на два меню. Экран
   сравнения переехал сюда целиком, ничего не потеряв: лента отбора в подшапке
   работает на этой вкладке так же, как работала в разделе.

   Срок — один на весь раздел, и это нарочно. Переключил «неделю» на заявках,
   ушёл к инженерам — там та же неделя: иначе каждая вкладка отвечала бы про
   свой отрезок времени, а сравнивать их между собой пришлось бы на память.
   Сравнение сроку не подчиняется: там срез задаёт не календарь, а отбор. */

interface Props {
  registry: Registry;
  /** Вкладка из подшапки. */
  mode: string;
  /** Расчёт, открытый в диспетчерской. */
  active: string | null;
  onOpenRun: (id: RunId) => void;

  /* ─── то, что нужно только вкладке сравнения ─────────────────────────── */
  picks: RunId[];
  runs: DaySummary[] | null;
  onToggle: (id: RunId) => void;
  onClear: () => void;
  onRestore: (ids: RunId[]) => void;
  onGoRuns: () => void;
  onOpenMap: (id: RunId) => void;
  onGo: (id: RunId) => void;
  compareReset?: number;
}

export function StatsScreen({
  registry,
  mode,
  active,
  onOpenRun,
  picks,
  runs,
  onToggle,
  onClear,
  onRestore,
  onGoRuns,
  onOpenMap,
  onGo,
  compareReset
}: Props) {
  /* «Всё время» по умолчанию: в раздел приходят за картиной целиком, а не за
     сегодняшним днём — его видно в диспетчерской и в мониторинге. */
  const [period, setPeriod] = useState<PeriodKey>('all');

  const all = registry.stats.byRun;
  const scope = useMemo(() => scopeOf(registry, period), [registry, period]);
  const countOf = (key: PeriodKey) => all.filter((row) => withinPeriod(row.run.created, key)).length;

  /* Сравнение стоит до проверок на пустоту: набор собирают лентой в подшапке,
     и пустая история — не причина запирать экран. Он сам умеет сказать, что
     отбирать пока нечего. */
  if (mode === 'compare') {
    return (
      <CompareScreen
        picks={picks}
        registry={registry}
        runs={runs}
        resetToken={compareReset}
        active={active}
        onToggle={onToggle}
        onClear={onClear}
        onRestore={onRestore}
        onGoRuns={onGoRuns}
        onOpen={onOpenRun}
        onOpenMap={onOpenMap}
        onGo={onGo}
      />
    );
  }

  if (all.length === 0) {
    return (
      <div className="dash enter">
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Статистика</h2>
          </div>
          <div className="emptynote">
            <p className="emptynote__title">Считать пока нечего</p>
            <span>
              Статистика собирается по посчитанным расчётам — заведите первый в диспетчерской.
            </span>
          </div>
        </section>
      </div>
    );
  }

  const props: DimProps = {
    registry,
    scope,
    period,
    onPeriod: setPeriod,
    countOf,
    onOpenRun,
    active
  };

  /* В срок не попал ни один расчёт — считать нечего, и говорить об этом должен
     сам раздел, а не шесть пустых диаграмм. Доска при этом не рисуется вовсе:
     ряд нулей с подписями «в среднем» читался бы как ответ. */
  if (scope.runs.length === 0) {
    return (
      <div className="dash enter">
        <StatsBlank
          filter={<WidgetPeriod value={period} onChange={setPeriod} countOf={countOf} />}
          onAll={() => setPeriod('all')}
        />
      </div>
    );
  }

  return (
    <div className="dash enter">
      {mode === 'runs' ? (
        <StatsRuns {...props} />
      ) : mode === 'orders' ? (
        <StatsOrders {...props} />
      ) : mode === 'services' ? (
        <StatsServices {...props} />
      ) : mode === 'engineers' ? (
        <StatsEngineers {...props} />
      ) : mode === 'clients' ? (
        <StatsClients {...props} />
      ) : mode === 'routes' ? (
        <StatsRoutes {...props} />
      ) : (
        <StatsDigest {...props} />
      )}
    </div>
  );
}
