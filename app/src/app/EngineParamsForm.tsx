import type { EngineParams } from '../data/engine.ts';
import {
  balanceHint,
  bufferHint,
  CHURN_PRESETS,
  durationHint,
  ENGINE_DEFAULTS
} from '../data/engine.ts';
import { dec } from '../data/derive.ts';

/* Переменные движка одной вёрсткой на два экрана.

   Их задают в двух местах: в настройках — те, с которых открывается форма
   нового расчёта, и в самой форме — те, с которыми пойдёт вот этот расчёт.
   Вопрос один и тот же, значит и подписи, и пресеты, и замеры должны быть
   одни и те же: разойдись они, диспетчер читал бы про один и тот же рычаг
   два разных объяснения.

   Пометка «По умолчанию» всегда указывает на заводское значение движка, а не
   на то, что кто-то поставил в настройках: иначе она перестаёт быть точкой
   отсчёта и начинает подтверждать саму себя. */

function Slider({
  label,
  unit,
  value,
  min,
  max,
  step,
  ends,
  hint,
  onChange
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max: number;
  step: number;
  ends: [string, string];
  hint: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="knob">
      <div className="knob__head">
        <span className="knob__label">{label}</span>
        <span className="knob__value">{unit}</span>
      </div>
      <input
        className="knob__range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      <div className="knob__ends">
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </div>
      <p className="knob__hint">{hint}</p>
    </div>
  );
}

interface Props {
  params: EngineParams;
  onChange: (params: EngineParams) => void;
  /** Какие рычаги показывать. Пусто — все. Ручное управление показывает
      только диспетчерские: правила движка живут в настройках и меняются на
      все расчёты сразу, а не на один. */
  only?: readonly (keyof EngineParams)[];
}

export function EngineParamsForm({ params, onChange, only }: Props) {
  const set = <K extends keyof EngineParams>(key: K, value: EngineParams[K]) =>
    onChange({ ...params, [key]: value });

  const shown = (key: keyof EngineParams) => !only || only.includes(key);

  return (
    <>
      {/* Стабильность стоит первой: она отвечает на вопрос, который возникает
          в течение дня чаще всего — можно ли трогать уже объявленный план. */}
      {shown('churn_penalty') && (
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Стабильность плана</h2>
        </div>
        <p className="clients__lede">
          Определяет, насколько движок сохраняет уже объявленный план при пересчёте в течение дня.
        </p>

        <div className="presets">
          {CHURN_PRESETS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={'preset' + (item.penalty === params.churn_penalty ? ' preset--on' : '')}
              onClick={() => set('churn_penalty', item.penalty)}
            >
              <span className="preset__top">
                <span className="preset__label">{item.label}</span>
                {item.penalty === ENGINE_DEFAULTS.churn_penalty && (
                  <span className="preset__default">По умолчанию</span>
                )}
              </span>
              <span className="preset__what">{item.what}</span>
              {item.measured && <span className="preset__measured">{item.measured}</span>}
            </button>
          ))}
        </div>

        <p className="knob__hint">
          Фактическую долю визитов, сохранивших исполнителя, движок возвращает после пересчёта.
        </p>
      </section>
      )}

      {(shown('duration_factor') || shown('buffer_step')) && (
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Время и запас</h2>
        </div>

        <div className="knobs">
          <Slider
            label="Запас по времени работ"
            unit={`× ${dec(params.duration_factor, 2)}`}
            value={params.duration_factor}
            min={0.8}
            max={1.5}
            step={0.05}
            ends={['плотно', 'с запасом']}
            hint={durationHint(params.duration_factor)}
            onChange={(v) => set('duration_factor', v)}
          />

          <Slider
            label="Консервативность маршрута"
            unit={`${params.buffer_step} мин`}
            value={params.buffer_step}
            min={0}
            max={15}
            step={1}
            ends={['без зазора', 'осторожно']}
            hint={bufferHint(params.buffer_step)}
            onChange={(v) => set('buffer_step', v)}
          />
        </div>

        <p className="knob__hint">
          Первый параметр задаёт время, закладываемое на работу, второй — зазор между визитами.
        </p>
      </section>
      )}

      {shown('balance_weight') && (
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Равномерность загрузки</h2>
        </div>

        <div className="knobs">
          <Slider
            label="Насколько ровно делить нагрузку"
            unit={dec(params.balance_weight)}
            value={params.balance_weight}
            min={0}
            max={20}
            step={0.5}
            ends={['неважно', 'максимально ровно']}
            hint={balanceHint(params.balance_weight)}
            onChange={(v) => set('balance_weight', v)}
          />
        </div>

        <p className="knob__hint">
          Чем выше загрузка инженера, тем менее выгодно назначать ему следующую заявку.
        </p>
      </section>
      )}
    </>
  );
}
