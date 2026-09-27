import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunId } from '../data/load.ts';
import { useRunStates } from '../data/runState.ts';
import type { RunState } from '../data/runState.ts';

/* Пометка состояния расчёта — одна на все виды базы.

   Три состояния, три цвета, и цвет тут не украшение: зелёный — «по нему
   работают сейчас», фиолетовый — «свой день отработал», тихий серый — «ни на
   какой день не назначен». Первое требует внимания, второе рассказывает
   историю, третье просто объясняет, почему у карточки нет пометки поярче.

   Знак и слова везде одни и те же: список, таблица и карточка говорят об
   одном и том же одинаково. */
const LOOK: Record<RunState, { label: string; icon: string; hint: string }> = {
  working: {
    label: 'В работе',
    icon: 'check-circle',
    hint: 'Этот расчёт взят в работу на свой день'
  },
  served: {
    label: 'Отработал',
    icon: 'stack',
    hint: 'Этот расчёт вёл день в мониторинге, и день закрыт: смены кончились'
  },
  idle: {
    label: 'Не назначен',
    icon: 'calendar',
    hint: 'Этот расчёт ни на какой день не взят и ни в одном мониторинге не работал'
  }
};

export function RunStateTag({ run, date }: { run: RunId; date: string }) {
  const stateOf = useRunStates();
  const state = stateOf(run, date);
  const look = LOOK[state];
  return (
    <span className={`dutytag dutytag--${state}`} title={look.hint}>
      <Icon name={look.icon} size={11} />
      {look.label}
    </span>
  );
}
