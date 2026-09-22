import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunId } from '../data/load.ts';
import { runCode } from '../data/load.ts';
import { dropDuty, holderOf, onDuty, takeDuty, useDuty } from '../data/duty.ts';

/* Кнопка «В работу» вместе с вопросом перед необратимым.

   Стоит в двух местах — в подшапке открытого плана и в карточке расчёта в
   базе, — и вести себя должна одинаково: одно и то же действие, которое в
   одном месте спрашивает, а в другом срабатывает с одного щелчка, учит
   диспетчера не читать вопросы вовсе. Поэтому логика вопроса живёт здесь, а
   места отличаются только обёрткой.

   Спрашиваем про два случая. Снять расчёт с работы — день останется без
   рабочего плана. Взять чужой день — прежний расчёт молча станет черновиком.
   Просто взять свободный день ничего не ломает и делается сразу. */

interface Props {
  run: RunId;
  /** ISO-дата дня, на который берут расчёт. Пусто — брать не на что. */
  date: string;
  /** Где стоит: в подшапке вопрос держится одной-двумя строками в ряду,
      в карточке — переносится под кнопки во всю ширину. */
  place: 'bar' | 'card';
}

const dayText = (date: string) => date.split('-').reverse().join('.');

export function DutyButton({ run, date, place }: Props) {
  /* Подписка ради перерисовки: хозяина дня спрашивают у слоя данных. */
  useDuty();
  const working = onDuty(run, date);
  const heldBy = holderOf(run, date);
  const held = heldBy && heldBy !== run ? runCode(heldBy) : null;
  const code = runCode(run);
  const day = dayText(date);

  /* Вопрос помнит, про какой расчёт задан: переключились на другой в ленте —
     старый вопрос к нему не относится и пропадает сам. */
  const [asking, setAsking] = useState<{ kind: 'drop' | 'take'; run: RunId } | null>(null);
  const ask = asking && asking.run === run ? asking.kind : null;

  /* Фокус. Кнопка «В работу» на время вопроса исчезает, и без присмотра фокус
     падал бы на body — с клавиатуры пришлось бы искать место заново. Поэтому
     при вопросе он встаёт на «Отмена» (безопасный ответ по Enter), а после
     ответа возвращается на кнопку. Button дизайн-системы ref не пробрасывает,
     поэтому ищем кнопки внутри своей обёртки. */
  const box = useRef<HTMLSpanElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    const buttons = box.current?.querySelectorAll('button');
    if (ask) buttons?.[buttons.length - 1]?.focus();
    else if (wasAsking.current) buttons?.[0]?.focus();
    wasAsking.current = Boolean(ask);
  }, [ask]);

  const onClick = () => {
    if (working) setAsking({ kind: 'drop', run });
    else if (held) setAsking({ kind: 'take', run });
    else takeDuty(run, date);
  };
  const confirm = () => {
    if (ask === 'drop') dropDuty(run, date);
    else if (ask === 'take') takeDuty(run, date);
    setAsking(null);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setAsking(null);
    }
  };

  const question =
    ask === 'take'
      ? `День ${day} сейчас ведёт ${held}. Передать его ${code}?`
      : `Снять ${code} с работы? У ${day} не останется рабочего расчёта.`;
  const textId = `duty-ask-${run}`;

  /* Объяснение того, что делает кнопка, — в подсказке у обёртки: Button
     дизайн-системы title не принимает. */
  const hint = working
    ? `Снять ${code} с работы: у ${day} не останется рабочего расчёта`
    : held
      ? `Взять ${code} в работу на ${day}: сейчас на этом дне работает ${held}`
      : `Взять ${code} в работу на ${day}: остальные расчёты дня станут черновиками`;

  return (
    <span ref={box} className={`duty duty--${place}`}>
      {ask ? (
        /* Вопрос — не окно поверх экрана, а группа у кнопки: он про одно
           действие, и отвечают на него тут же, не теряя из виду план. */
        <span className="duty__ask" role="group" aria-labelledby={textId} onKeyDown={onKeyDown}>
          <span id={textId} className="duty__ask-text">
            {question}
          </span>
          <span className="duty__ask-btns">
            <Button variant="primary" size="sm" onClick={confirm}>
              {ask === 'take' ? 'Передать' : 'Снять'}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setAsking(null)}>
              Отмена
            </Button>
          </span>
        </span>
      ) : (
        /* До взятия — с рамкой, после — в акцентной заливке с галочкой:
           «этот в работе» должно читаться издалека. */
        <span className="duty__main" title={date ? hint : 'У расчёта нет даты — брать не на что'}>
          <Button
            variant={working ? 'accent' : 'secondary'}
            size="sm"
            disabled={!date}
            onClick={onClick}
            iconLeft={<Icon name={working ? 'check-circle' : 'calendar'} size={16} />}
          >
            {working ? 'В работе' : 'В работу'}
          </Button>
        </span>
      )}
    </span>
  );
}
