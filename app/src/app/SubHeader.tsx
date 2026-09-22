import { useState } from 'react';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { RunTabs } from './RunTabs.tsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { runCode, runDate } from '../data/load.ts';
import { dropDuty, holderOf, onDuty, takeDuty, useDuty } from '../data/duty.ts';
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
  /* Расчёт выбирают там, где он есть. Разделы, которые читают все расчёты
     сразу, вместо переключателя получают прямую подпись: показывать
     неработающий выбор хуже, чем не показывать его вовсе. */
  const runScoped = isRunScoped(section) && !planPending;
  const crossRun = isCrossRun(section);
  /* В «Сравнении» та же лента делает другую работу: не переключает открытый
     расчёт, а набирает их несколько. Место у неё одно и то же — подшапка, —
     и это правильно: там её ищут глазами в любом разделе. */
  const picking = section === 'compare';
  /* Взят ли открытый расчёт в работу на свой день. Кнопка стоит там же, где
     диспетчер с планом и работает, — решение «этот и берём» принимают,
     глядя на план, а не на карточку в справочнике. Обе кнопки правят одно и
     то же хранилище, поэтому нажатая здесь тут же видна и в базе. */
  /* Подписка нужна ради перерисовки: кто держит день, спрашивают у слоя
     данных по расчёту и дате — день считается по участку, а не по календарю. */
  useDuty();
  const date = onCloseRun ? runDate(activeRun) : '';
  const working = onDuty(activeRun, date);
  const heldBy = holderOf(activeRun, date);
  const held = heldBy && heldBy !== activeRun ? runCode(heldBy) : null;
  const dayText = date.split('-').reverse().join('.');
  /* Что спрашиваем прямо у кнопки. Необратимое без вопроса не делается:
     снять расчёт с работы — день останется без рабочего плана, взять чужой
     день — прежний расчёт молча станет черновиком. Раньше обо всём этом
     говорила только всплывающая подсказка, а её за секунду не прочтёшь.
     Вопрос помнит, про какой расчёт задан: переключились на другой в
     ленте — старый вопрос к нему не относится и пропадает сам. */
  const [asking, setAsking] = useState<{ kind: 'drop' | 'take'; run: RunId } | null>(null);
  const ask = asking && asking.run === activeRun ? asking.kind : null;
  const onDutyClick = () => {
    if (working) setAsking({ kind: 'drop', run: activeRun });
    else if (held) setAsking({ kind: 'take', run: activeRun });
    else takeDuty(activeRun, date);
  };
  const confirmDuty = () => {
    if (ask === 'drop') dropDuty(activeRun, date);
    else if (ask === 'take') takeDuty(activeRun, date);
    setAsking(null);
  };
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
      {/* «В работу» — про открытый расчёт: с этой минуты день принадлежит ему,
          а прочие расчёты того же дня остаются черновиками. Стоит в конце
          строки, за лентой расчётов: лента отвечает на «какой смотрим», а
          кнопка — на «какой берём», и это разные вопросы.

          Подпись меняется с «В работу» на «В работе»: первое — что кнопка
          сделает, второе — что уже сделано. Оранжевый в этой системе значит
          «вот этот, с ним сейчас работают», и здесь он ровно об этом. */}
      {onCloseRun && date && ask && (
        <span className="subhdr__ask" role="alertdialog" aria-live="polite">
          <span className="subhdr__ask-text">
            {ask === 'take'
              ? `День ${dayText} сейчас ведёт ${held}. Передать его ${runCode(activeRun)}?`
              : `Снять ${runCode(activeRun)} с работы? У ${dayText} не останется рабочего расчёта.`}
          </span>
          <Button variant="primary" size="sm" onClick={confirmDuty}>
            {ask === 'take' ? 'Передать' : 'Снять'}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setAsking(null)}>
            Отмена
          </Button>
        </span>
      )}
      {/* Главное действие дня — поэтому кнопка обычного размера дизайн-системы
          (32px), а не служебная пилюля: до взятия — с рамкой, после — в
          акцентной заливке с галочкой, чтобы «этот в работе» читалось издалека. */}
      {onCloseRun && date && !ask && (
        <Button
          variant={working ? 'accent' : 'secondary'}
          size="sm"
          className="subhdr__duty"
          onClick={onDutyClick}
          iconLeft={<Icon name={working ? 'check-circle' : 'calendar'} size={16} />}
        >
          {working ? 'В работе' : 'В работу'}
        </Button>
      )}

      {/* Крестик закрывает расчёт и возвращает диспетчерскую к выбору
          действия. Стоит в конце строки, за лентой: это не работа с планом, а
          выход из него, и мешаться с вкладками ему незачем. Отодвинут от
          «В работу» и подписан словом: вплотную к главной кнопке крестик
          26px ловил промахи. */}
      {onCloseRun && (
        <Button
          variant="ghost"
          size="sm"
          className="subhdr__close"
          onClick={onCloseRun}
          iconLeft={<Icon name="x" size={16} />}
        >
          Закрыть
        </Button>
      )}
    </div>
  );
}
