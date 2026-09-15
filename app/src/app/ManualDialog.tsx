import { useEffect, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineParams } from '../data/engine.ts';
import { DISPATCH_KNOBS, engineDefaults } from '../data/engine.ts';
import { EngineParamsForm } from './EngineParamsForm.tsx';

interface Props {
  open: boolean;
  /** Номер расчёта, который пересобирают. */
  runCode: string;
  /** С чем его посчитали. Форма открывается этим, а не заводскими: правят
      то, что стоит сейчас, а не начинают с нуля. */
  params: EngineParams;
  /** Идёт счёт. */
  busy: boolean;
  /** Чем кончилась неудача. */
  failed: string | null;
  onClose: () => void;
  onRun: (params: EngineParams) => void;
}

/* Ручное управление: пересобрать этот же день другими переменными.

   Главное здесь — что именно можно крутить. Переменных у движка пять, но они
   разной природы, и валить их в одну форму неверно.

   Три из них — диспетчерские: запас по времени работ, консервативность
   маршрута, равномерность загрузки. Их меняют от расчёта к расчёту на одних и
   тех же данных, чтобы посмотреть, что выйдет: плотнее или осторожнее, ровнее
   или плотнее по покрытию. Это работа диспетчера, и живут они здесь.

   Две другие — правила движка, а не решение на сегодня. Они стоят в
   настройках сырыми числами и применяются ко всем следующим расчётам. Их
   меняют редко и осознанно, и место им не в окне, которое открывают по
   десять раз за смену.

   Пересчёт заводит новый расчёт на том же дне, а не переписывает этот.
   Солвер детерминирован: те же данные и те же переменные дадут тот же план,
   поэтому терять прошлый вариант незачем — два варианта кладутся рядом и
   сравниваются. */
export function ManualDialog({ open, runCode, params, busy, failed, onClose, onRun }: Props) {
  const [draft, setDraft] = useState<EngineParams>(params);

  /* Окно открыли заново — форма снова показывает то, что стоит у расчёта.
     Иначе в ней остались бы позавчерашние правки от прошлого открытия. */
  useEffect(() => {
    if (open) setDraft(params);
  }, [open, params]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const touched = DISPATCH_KNOBS.some((key) => draft[key] !== params[key]);
  const saved = engineDefaults();

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Ручное управление">
      <button
        type="button"
        className="modal__veil"
        onClick={() => !busy && onClose()}
        aria-label="Закрыть"
      />

      <div className="modal__card manual__card">
        <div className="modal__head">
          <h3 className="engine__title">Ручное управление · {runCode}</h3>
          <button
            type="button"
            className="rpanel__x"
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="engine__lede">
          Тот же день, те же заявки и тот же штат — другие переменные. Движок разложит его заново и
          заведёт ещё один расчёт: этот останется в архиве, и два варианта можно положить рядом. На
          остальные расчёты правка не влияет.
        </p>

        <div className="manual__form">
          <EngineParamsForm params={draft} onChange={setDraft} only={DISPATCH_KNOBS} />
        </div>

        {failed && (
          <div className="solvefail">
            <Icon name="alert-triangle" size={16} />
            <span>
              <b>Пересчёт не пошёл.</b> {failed}
            </span>
          </div>
        )}

        <div className="manual__foot">
          <span className="manual__note">
            {busy ? (
              <span className="createbar__busy">
                <span className="createbar__spin" aria-hidden="true" />
                Движок раскладывает день заново — около восьми секунд.
              </span>
            ) : touched ? (
              <>
                Переменные изменены.
                <button type="button" className="createbar__reset" onClick={() => setDraft(params)}>
                  Вернуть как было
                </button>
              </>
            ) : (
              <>
                Переменные те же, что у {runCode}. Правила движка — в настройках, они общие для
                всех расчётов.
                <button
                  type="button"
                  className="createbar__reset"
                  onClick={() => setDraft({ ...draft, ...pick(saved) })}
                >
                  Взять из настроек
                </button>
              </>
            )}
          </span>
          <span className="manual__actions">
            <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
              Отмена
            </Button>
            <Button
              variant="accent"
              size="sm"
              onClick={() => onRun(draft)}
              disabled={busy || !touched}
              iconLeft={<Icon name="shuffle" size={14} />}
            >
              {busy ? 'Считаю…' : 'Пересчитать'}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

/** Только диспетчерские рычаги из набора: правила движка окно не трогает. */
function pick(params: EngineParams): Partial<EngineParams> {
  const out: Partial<EngineParams> = {};
  for (const key of DISPATCH_KNOBS) out[key] = params[key] as never;
  return out;
}
