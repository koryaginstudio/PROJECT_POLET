import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { RunTabs } from './RunTabs.tsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { isCrossRun, isRunScoped, SUBHEADER } from './nav.ts';
import type { SectionId } from './nav.ts';
import { COMPARE_MAX } from './compare.ts';

interface Props {
  section: SectionId;
  view: string;
  onViewChange: (view: string) => void;
  runs: DaySummary[] | null;
  activeRun: RunId;
  onOpenRun: (id: RunId) => void;
  /* Пока план не открыт, подшапке нечего показывать: ни вкладок, ни ленты
     расчётов. Выделенный в ленте номер означал бы, что расчёт уже открыт, —
     а диспетчер ещё только выбирает, создавать новый или взять готовый. */
  planPending?: boolean;
  /** Расчёты, отобранные к сравнению. */
  compare: RunId[];
  onCompare: (id: RunId) => void;
  /** Закрыть открытый расчёт. Передаётся только там, где есть что закрывать:
      на открытом плане диспетчерской. */
  onCloseRun?: () => void;
}

export function SubHeader({
  section,
  view,
  onViewChange,
  runs,
  activeRun,
  onOpenRun,
  planPending = false,
  compare,
  onCompare,
  onCloseRun
}: Props) {
  const config = SUBHEADER[section];
  /* Прогон выбирают там, где он есть. Разделы, которые читают все прогоны
     сразу, вместо переключателя получают прямую подпись: показывать
     неработающий выбор хуже, чем не показывать его вовсе. */
  const runScoped = isRunScoped(section) && !planPending;
  const crossRun = isCrossRun(section);
  /* В «Сравнении» та же лента делает другую работу: не переключает открытый
     расчёт, а набирает их несколько. Место у неё одно и то же — подшапка, —
     и это правильно: там её ищут глазами в любом разделе. */
  const picking = section === 'compare';
  return (
    <div className="subhdr">
      <span className="subhdr__title">{config.title}</span>
      {config.views.length > 1 && !planPending && (
        <SegmentedControl size="sm" items={config.views} value={view} onChange={onViewChange} />
      )}
      {(runScoped || crossRun) && <span className="subhdr__divider" />}
      {picking && (
        <RunTabs
          runs={runs}
          active={compare}
          onOpen={onCompare}
          full={compare.length >= COMPARE_MAX}
          markLabel="В сравнении"
          fullHint={`В сравнении уже ${COMPARE_MAX} расчёта — сначала снимите лишний`}
        />
      )}
      {/* Лента расчётов занимает всю оставшуюся ширину сама, поэтому распорки
          после неё нет: пустота справа была бы ровно тем, что лента и должна
          собой закрыть. */}
      {runScoped && <RunTabs runs={runs} active={activeRun} onOpen={onOpenRun} />}
      {/* Пометки «Все расчёты» здесь нет: раздел и так стоит в меню под
          своим именем, а лента расчётов в нём не показана — обещать нечего. */}
      {crossRun && !picking && <div className="subhdr__spacer" />}
      {/* Крестик закрывает расчёт и возвращает диспетчерскую к выбору
          действия. Стоит в конце строки, за лентой: это не работа с планом, а
          выход из него, и мешаться с вкладками ему незачем. */}
      {onCloseRun && (
        <button
          type="button"
          className="subhdr__close"
          title="Закрыть расчёт и вернуться к выбору действия"
          aria-label="Закрыть расчёт"
          onClick={onCloseRun}
        >
          <Icon name="x" size={13} />
        </button>
      )}
    </div>
  );
}
