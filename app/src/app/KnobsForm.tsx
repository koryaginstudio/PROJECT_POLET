import { Icon } from '../ds/components/core/Icon.jsx';
import { Lede } from './Lede.tsx';
import type { Knob, KnobGroup } from '../data/knobs.ts';

interface Props {
  group: KnobGroup;
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
  /** Разделять ли правила на рабочие и справочные. Там, где форма и так
      показывает только рабочие (настройки нового расчёта), делить нечего. */
  showWiring?: boolean;
}

/* Переменные движка числами.

   Одна вёрстка на обе группы: вопрос у них один — «какое здесь число», — и
   разводить их по разным формам значило бы объяснять одно и то же дважды.
   Отличаются они не видом поля, а предупреждением: у откалиброванных рядом
   стоит строка о том, почему их лучше не трогать.

   Каждое поле подписано именем из движка. Это не отладочная мелочь: тот,
   кто сюда пришёл, читал документацию движка и ищет глазами `buffer_step`,
   а не «прирост запаса». Слова для того, кто не читал; имя для того, кто
   читал; одно другому не мешает. */

function Field({
  knob,
  value,
  onChange,
  locked
}: {
  knob: Knob;
  value: number;
  onChange: (value: number) => void;
  /** Правило показано только для справки: менять его здесь нельзя, потому
      что расчёт берёт значение не отсюда. Поле остаётся видимым и читаемым,
      но не притворяется рабочим. */
  locked: boolean;
}) {
  const factory = knob.factory;
  const changed = JSON.stringify(value) !== JSON.stringify(factory);

  return (
    <div className={'rule' + (locked ? ' rule--locked' : '')}>
      <div className="rule__head">
        <span className="rule__label">{knob.label}</span>
        <code className="rule__name">{knob.key}</code>
      </div>
      <p className="rule__what">{knob.what}</p>

      <div className="rule__row">
          <span className="rule__field">
            <input
              className="rule__input"
              type="number"
              inputMode="decimal"
              value={value}
              min={knob.min}
              max={knob.max}
              step={knob.step}
              readOnly={locked}
              tabIndex={locked ? -1 : undefined}
              aria-readonly={locked || undefined}
              onChange={(e) => {
                if (locked) return;
                const next = Number(e.currentTarget.value);
                if (!Number.isFinite(next)) return;
                const low = knob.min ?? -Infinity;
                const high = knob.max ?? Infinity;
                onChange(Math.min(high, Math.max(low, next)));
              }}
            />
            {knob.unit && <span className="rule__unit">{knob.unit}</span>}
          </span>
          <span className="rule__limits">
            от {knob.min} до {knob.max}
          </span>
          {locked ? (
            <span className="rule__factory">задаётся при создании расчёта</span>
          ) : changed ? (
            <button
              type="button"
              className="rule__factory rule__factory--on"
              onClick={() => onChange(factory)}
            >
              <Icon name="arrow-left" size={12} />вернуть {String(factory)}
            </button>
          ) : (
            <span className="rule__factory">заводское значение</span>
          )}
      </div>

    </div>
  );
}

export function KnobsForm({ group, values, onChange, showWiring = true }: Props) {
  /* Рабочие правила отдельно от справочных. Раньше они шли одним списком, и
     подпись над ним обещала, что учитываются все, а у пяти из семи рядом
     стояла пометка «не подключено» — экран спорил сам с собой. Значение,
     которое нельзя изменить здесь, стоит ниже, отдельной группой и без
     видимости рабочего поля. */
  const live = showWiring ? group.knobs.filter((knob) => knob.wired) : group.knobs;
  const shown = showWiring ? group.knobs.filter((knob) => !knob.wired) : [];

  const field = (knob: Knob, locked: boolean) => (
    <Field
      key={knob.key}
      knob={knob}
      value={values[knob.key] ?? knob.factory}
      onChange={(next) => onChange(knob.key, next)}
      locked={locked}
    />
  );

  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">{group.title}</h2>
        <span className="dash__section-note">
          {live.length === group.knobs.length
            ? `${group.knobs.length} настроек, все учитываются в расчёте`
            : `${live.length} из ${group.knobs.length} меняются здесь`}
        </span>
      </div>
      <Lede text={group.lede} />

      <div className="rules">{live.map((knob) => field(knob, false))}</div>

      {shown.length > 0 && (
        <div className="rules__aside">
          <h3 className="rules__aside-title">Задаются при создании расчёта</h3>
          <p className="rules__aside-note">
            Эти значения расчёт берёт из формы нового расчёта — там же, где выбирают участок и
            дату. Здесь они показаны, чтобы было видно, с чем считали, но менять их отсюда нельзя.
          </p>
          <div className="rules">{shown.map((knob) => field(knob, true))}</div>
        </div>
      )}
    </section>
  );
}
