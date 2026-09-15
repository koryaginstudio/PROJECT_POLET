import { Icon } from '../ds/components/core/Icon.jsx';
import type { Knob, KnobGroup } from '../data/knobs.ts';

interface Props {
  group: KnobGroup;
  values: Record<string, number>;
  onChange: (key: string, value: number) => void;
  /** Показывать ли пометку «движок пока не принимает». Сейчас таких нет,
      но механику оставляем: поле, которое молча ничего не делает, хуже
      отсутствующего, и сказать об этом надо сразу, а не потом. */
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
  showWiring
}: {
  knob: Knob;
  value: number;
  onChange: (value: number) => void;
  showWiring: boolean;
}) {
  const factory = knob.factory;
  const changed = JSON.stringify(value) !== JSON.stringify(factory);

  return (
    <div className="rule">
      <div className="rule__head">
        <span className="rule__label">{knob.label}</span>
        <code className="rule__name">{knob.key}</code>
        {showWiring && !knob.wired && (
          <span className="rule__pending" title="Значение записано, но движок его пока не принимает">
            не подключено
          </span>
        )}
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
              onChange={(e) => {
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
          {changed ? (
            <button
              type="button"
              className="rule__factory rule__factory--on"
              onClick={() => onChange(factory)}
            >
              <Icon name="arrow-left" size={12} />в движке {String(factory)}
            </button>
          ) : (
            <span className="rule__factory">как в движке</span>
          )}
      </div>

    </div>
  );
}

export function KnobsForm({ group, values, onChange, showWiring = true }: Props) {
  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">{group.title}</h2>
        <span className="dash__section-note">
          {group.knobs.length} настроек, все доезжают до движка
        </span>
      </div>
      <p className="clients__lede">{group.lede}</p>

      <div className="rules">
        {group.knobs.map((knob) => (
          <Field
            key={knob.key}
            knob={knob}
            value={values[knob.key] ?? knob.factory}
            onChange={(next) => onChange(knob.key, next)}
            showWiring={showWiring}
          />
        ))}
      </div>
    </section>
  );
}
