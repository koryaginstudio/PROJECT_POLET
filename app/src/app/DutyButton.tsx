import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunId } from '../data/load.ts';
import { runCode } from '../data/load.ts';
import { dayLabel, dropDuty, holderOf, onDuty, takeDuty, useDuty } from '../data/duty.ts';

/* Кнопка «В работу» вместе с вопросом перед необратимым.

   Стоит в двух местах — в подшапке открытого плана и в карточке расчёта в
   базе, — и вести себя должна одинаково: одно и то же действие, которое в
   одном месте спрашивает, а в другом срабатывает с одного щелчка, учит
   диспетчера не читать вопросы вовсе. Поэтому логика вопроса живёт здесь, а
   места отличаются только обёрткой.

   Спрашиваем всегда, и вопрос называет день, на который берут: «Восток ·
   17.08.2026». Прежде свободный день брался с одного щелчка молча — и это
   была не экономия движения, а умолчание в самом важном месте: расчётов на
   экране несколько, дней участка три, и по кнопке было не видно, к какому из
   них привязывают этот план. Теперь связь названа вслух до того, как
   случится. */

interface Props {
  run: RunId;
  /** ISO-дата дня, на который берут расчёт. Пусто — брать не на что. */
  date: string;
  /** Где стоит: в подшапке вопрос держится одной-двумя строками в ряду,
      в карточке — переносится под кнопки во всю ширину. */
  place: 'bar' | 'card';
}

export function DutyButton({ run, date, place }: Props) {
  /* Подписка ради перерисовки: хозяина дня спрашивают у слоя данных. */
  useDuty();
  const working = onDuty(run, date);
  const heldBy = holderOf(run, date);
  const held = heldBy && heldBy !== run ? runCode(heldBy) : null;
  const code = runCode(run);
  const day = date ? dayLabel(run, date) : '';

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

  const onClick = () => setAsking({ kind: working ? 'drop' : 'take', run });
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
    ask === 'drop'
      ? `Снять ${code} с работы? На ${day} не останется рабочего расчёта.`
      : held
        ? `День ${day} сейчас ведёт ${held}. Передать его ${code}?`
        : `Взять ${code} в работу на ${day}? Остальные расчёты этого дня станут черновиками.`;
  const textId = `duty-ask-${run}`;

  /* Объяснение того, что делает кнопка, — в подсказке у обёртки: Button
     дизайн-системы title не принимает. */
  const hint = working
    ? `Снять ${code} с работы: на ${day} не останется рабочего расчёта`
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
              {ask === 'drop' ? 'Снять' : held ? 'Передать' : 'Взять в работу'}
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
            /* Зелёная тихая обводка — только у самого действия «В работу».
               «В работе» её не получает: там уже акцентная заливка, и это
               не действие, а состояние — красить его в тот же зелёный
               значило бы путать «нажми» с «уже сделано». */
            className={working ? undefined : 'duty__take'}
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
