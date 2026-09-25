import { useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { Lede } from '../app/Lede.tsx';
import type { RunId } from '../data/load.ts';
import { runCode } from '../data/load.ts';
import type { WorkDay } from '../data/duty.ts';
import { takeDuty, useDuty, workDays } from '../data/duty.ts';
import { monthName, weekdayName } from '../data/derive.ts';

interface Props {
  /** Дни участков, отмеченные к наблюдению. */
  watched: string[];
  onWatch: (keys: string[]) => void;
  /** Открыть живой вид по отмеченным дням. */
  onEnter: () => void;
}


/* Вход в мониторинг: какой сегодня день и по каким расчётам его ведут.

   Раздел начинается не с расчёта, а с дня — в этом вся разница между ним и
   диспетчерской. Диспетчерская спрашивает «какой план строим», мониторинг —
   «за каким днём смотрим»; расчёт для него не предмет выбора, а следствие:
   день ведёт тот план, который на него взяли в работу.

   Участков несколько, и смотреть за ними приходится разом: три района
   посчитаны порознь, а смена у диспетчера одна. Поэтому дни отмечают
   галочками, а не выбирают по одному, — живой вид покажет отмеченные вместе
   на одной карте.

   День без рабочего расчёта не прячем и не гасим: это не поломка, а обычное
   утро — расчёты посчитаны, какой брать, ещё не решили. Такой день говорит
   об этом словами и даёт выбрать прямо здесь. */
export function MonitorGate({ watched, onWatch, onEnter }: Props) {
  /* Подписка на «взят в работу»: список дней читается заново, когда рабочий
     расчёт меняют прямо на этом экране. */
  useDuty();
  const days = workDays();
  const now = new Date();
  const today = `${weekdayName(now)}, ${now.getDate()} ${monthName(now)}`;

  const ready = days.filter((day) => day.holder);
  const toggle = (key: string) =>
    onWatch(watched.includes(key) ? watched.filter((one) => one !== key) : [...watched, key]);

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head gatehero__head">
          <h2 className="dash__section-title">Мониторинг</h2>
          <span className="dash__section-note">Сегодня {today}</span>
        </div>

        <Lede first="Выберите дни, за которыми смотрите: раздел покажет их вместе, на одной карте.">
          День ведёт тот расчёт, который на него взяли в работу. Пока рабочего расчёта нет,
          смотреть не за чем — выберите его прямо здесь или посчитайте новый в диспетчерской.
        </Lede>

        <div className="gatehero__actions">
          <Button
            variant="primary"
            className="gatehero__cta"
            iconLeft={<Icon name="play" size={14} />}
            onClick={onEnter}
            disabled={watched.length === 0}
          >
            {watched.length === 0
              ? 'Отметьте хотя бы один день'
              : `Смотреть · ${watched.length} из ${ready.length}`}
          </Button>
        </div>
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Дни участков</h2>
          <span className="dash__section-note">
            {ready.length} из {days.length} с рабочим расчётом
          </span>
        </div>

        {days.length === 0 ? (
          <p className="clients__lede">
            Расчётов пока нет — считать нечего и смотреть не за чем. Начните с диспетчерской.
          </p>
        ) : (
          <div className="mday__list">
            {days.map((day) => (
              <DayRow
                key={day.key}
                day={day}
                watched={watched.includes(day.key)}
                onToggle={() => toggle(day.key)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* Строка дня участка. Слева — за чем смотрим, справа — кто ведёт.

   Выбор рабочего расчёта раскрывается здесь же, а не уводит в базу: вопрос
   «каким планом ведём этот день» задают в мониторинге, и отвечать на него
   надо в мониторинге. */
function DayRow({
  day,
  watched,
  onToggle
}: {
  day: WorkDay;
  watched: boolean;
  onToggle: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const holder = day.holder;

  return (
    <article className={'mday' + (watched ? ' mday--on' : '')}>
      <label className="mday__pick">
        <input
          type="checkbox"
          className="mday__box"
          checked={watched}
          onChange={onToggle}
          disabled={!holder}
        />
        <span className="mday__place">{day.place}</span>
        <span className="mday__date">{day.date.split('-').reverse().join('.')}</span>
      </label>

      <span className="mday__holder">
        {holder ? (
          <>
            <Icon name="check-circle" size={13} className="mday__holder-icon" />
            <b>{runCode(holder)}</b>
            <span className="mday__holder-note">ведёт этот день</span>
          </>
        ) : (
          <span className="mday__none">Рабочий расчёт не выбран</span>
        )}
      </span>

      <button
        type="button"
        className="mday__more"
        onClick={() => setPicking((was) => !was)}
        aria-expanded={picking}
      >
        {holder ? 'Сменить' : 'Выбрать'}
        <Icon name={picking ? 'chevron-up' : 'chevron-down'} size={13} />
      </button>

      {picking && (
        <div className="mday__runs">
          {day.runs.map((id) => (
            <RunPick key={id} id={id} day={day} onDone={() => setPicking(false)} />
          ))}
        </div>
      )}
    </article>
  );
}

/* Один расчёт дня в раскрытом списке: номер, когда посчитан, и что с ним
   сделать. Рабочий помечен и не предлагает взять себя ещё раз. */
function RunPick({ id, day, onDone }: { id: RunId; day: WorkDay; onDone: () => void }) {
  const working = day.holder === id;
  return (
    <button
      type="button"
      className={'mday__run' + (working ? ' mday__run--on' : '')}
      disabled={working}
      onClick={() => {
        takeDuty(id, day.date);
        onDone();
      }}
      title={working ? `${runCode(id)} уже ведёт этот день` : `Взять ${runCode(id)} в работу на ${day.label}`}
    >
      <span className="mday__run-code">{runCode(id)}</span>
      {working ? (
        <span className="mday__run-note">в работе</span>
      ) : (
        <span className="mday__run-note">взять в работу</span>
      )}
    </button>
  );
}
