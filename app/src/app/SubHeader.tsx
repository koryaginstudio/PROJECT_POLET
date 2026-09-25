import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { RunTabs } from './RunTabs.tsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { runDate } from '../data/load.ts';
import { DutyButton } from './DutyButton.tsx';
import { isCrossRun, isRunScoped, showsRunTabs, SUBHEADER } from './nav.ts';
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
  /* Расчёт выбирают там, где он есть. Разделы, которые читают все расчёты
     сразу, вместо переключателя получают прямую подпись: показывать
     неработающий выбор хуже, чем не показывать его вовсе. */
  const runScoped = isRunScoped(section) && !planPending;
  /* Лента расчётов есть не у всех разделов с расчётом: в мониторинге её нет
     нарочно — см. `showsRunTabs`. */
  const withTabs = runScoped && showsRunTabs(section);
  const crossRun = isCrossRun(section);
  /* В «Сравнении» та же лента делает другую работу: не переключает открытый
     расчёт, а набирает их несколько. Место у неё одно и то же — подшапка, —
     и это правильно: там её ищут глазами в любом разделе. */
  const picking = section === 'compare';
  /* Дата открытого расчёта: кнопке «В работу» нужен день, на который его
     берут. Вопрос перед необратимым и сама логика — в DutyButton, общем с
     карточкой расчёта в базе. */
  const date = onCloseRun ? runDate(activeRun) : '';
  return (
    <div className="subhdr">
      <span className="subhdr__title">{config.title}</span>
      {config.views.length > 1 && !planPending && (
        <SegmentedControl size="sm" items={config.views} value={view} onChange={onViewChange} />
      )}
      {(withTabs || crossRun) && <span className="subhdr__divider" />}
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
      {withTabs && <RunTabs runs={runs} active={activeRun} onOpen={onOpenRun} />}
      {/* Ленты нет — её место занимает распорка, иначе кнопки справа
          съезжают к заголовку. */}
      {runScoped && !withTabs && <div className="subhdr__spacer" />}
      {/* Пометки «Все расчёты» здесь нет: раздел и так стоит в меню под
          своим именем, а лента расчётов в нём не показана — обещать нечего. */}
      {crossRun && !picking && <div className="subhdr__spacer" />}
      {/* Действия с расчётом — обособленная группа в конце строки, за
          разделителем: тем же приёмом, что отделяет ленту расчётов от
          заголовка слева. Врозь с лентой они не смешивались бы с «какой
          смотрим», но зазор между лентой и кнопками плыл вместе с длиной
          ленты — разделитель делает границу явной при любой длине. */}
      {onCloseRun && (
        <>
          <span className="subhdr__divider" />
          <div className="subhdr__actions">
            {/* «В работу» — про открытый расчёт: с этой минуты день
                принадлежит ему, а прочие расчёты того же дня остаются
                черновиками.

                Подпись меняется с «В работу» на «В работе»: первое — что
                кнопка сделает, второе — что уже сделано. Оранжевый в этой
                системе значит «вот этот, с ним сейчас работают», и здесь он
                ровно об этом. */}
            {date && <DutyButton run={activeRun} date={date} place="bar" />}

            {/* Крестик закрывает расчёт и возвращает диспетчерскую к выбору
                действия: это не работа с планом, а выход из него. Зазор до
                «В работу» держит сама группа — одним значением, а не
                сложением зазора строки с собственным отступом кнопки. */}
            <Button
              variant="ghost"
              size="sm"
              className="subhdr__close"
              onClick={onCloseRun}
              iconLeft={<Icon name="x" size={16} />}
            >
              Закрыть расчёт
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
