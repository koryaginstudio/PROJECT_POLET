import { useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineParams } from '../data/engine.ts';
import { engineDefaults, ENGINE_DEFAULTS } from '../data/engine.ts';
import { EngineParamsForm } from '../app/EngineParamsForm.tsx';
import { SourcePicker } from '../app/SourcePicker.tsx';
import type { SourceChoice } from '../app/SourcePicker.tsx';
import type { DayView } from '../data/derive.ts';

interface Props {
  onCancel: () => void;
  onCreate: (params: EngineParams) => void;
  /** Состав дня: по нему собирается список инженеров и их навыков. */
  view: DayView | null;
  /** Движок сейчас считает. Восемь секунд — это его работа, а не задержка
      сети, поэтому кнопка не просто блокируется, а говорит, что происходит. */
  solving?: boolean;
  /** Чем кончился неудавшийся расчёт. `null` — всё в порядке. */
  failed?: string | null;
}

/* Создание расчёта. Переменные движка — это его вход, а не настройка
   интерфейса: они меняют то, как солвер взвешивает варианты. Поэтому наружу
   выходят не сырые числа, а то, что от них меняется; само число стоит рядом
   мелким, потому что инженеру движка оно всё-таки нужно. */
export function CreateRunScreen({
  onCancel,
  onCreate,
  view,
  solving = false,
  failed = null
}: Props) {
  /* Форма открывается тем, что стоит в настройках, а не заводскими числами:
     настройки для того и заведены. Сравниваем всё равно с заводскими — это
     единственная неподвижная точка отсчёта. */
  const [params, setParams] = useState<EngineParams>(engineDefaults());
  /* Состав дня: по умолчанию в смене все, кто есть. Снимают тех, кто
     сегодня не вышел, — это решение, а не настройка по умолчанию. */
  const [source, setSource] = useState<SourceChoice>(() => ({
    from: 'manual',
    engineers: view ? view.loads.map((load) => load.engineer.id) : [],
    skillsOff: {},
    extra: []
  }));
  const touched = JSON.stringify(params) !== JSON.stringify(ENGINE_DEFAULTS);

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Новый расчёт</h2>
          {/* Крестик, а не «Назад»: форма — это открытая вещь, и закрывают её
              так же, как открытый расчёт на пульте. «Назад» обещало бы шаг
              в истории, а возвращает оно к тому же выбору, с которого
              диспетчерская начинается. */}
          <button
            type="button"
            className="calc__close"
            onClick={onCancel}
            title="Закрыть форму и вернуться к выбору"
            aria-label="Закрыть форму"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <p className="clients__lede">
          Движок разложит все заявки дня по инженерам. Ниже — то, чем можно повлиять на его
          решение: насколько держаться за уже объявленный план, сколько времени закладывать на
          работу и дорогу и насколько ровно распределять нагрузку. Значения по умолчанию — те,
          что стоят в движке; менять их на каждый расчёт не обязательно.
        </p>
      </section>

      {/* Откуда данные — первым: сначала решают, что считать, и только
          потом, как считать. Обратный порядок заставлял бы крутить рычаги,
          не зная ещё, к чему они применятся. */}
      {view && <SourcePicker view={view} value={source} onChange={setSource} />}

      {/* Сами переменные — общей вёрсткой с настройками: вопрос один и тот
          же, значит и подписи, и пресеты, и замеры одни и те же. */}
      <EngineParamsForm params={params} onChange={setParams} />

      {/* Отказ движка показываем на форме, а не уводим с неё: переменные
          остались набранными, и повторить расчёт — это один щелчок. */}
      {failed && (
        <section className="panel">
          <div className="solvefail">
            <Icon name="alert-triangle" size={16} />
            <span>
              <b>Расчёт не пошёл.</b> {failed}
            </span>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="createbar">
          <span className="createbar__note">
            {solving ? (
              /* Пока солвер думает, подпись занята делом, а не состоянием
                 формы: восемь секунд молчания — это то, за что на защите
                 спрашивают «оно зависло?». */
              <span className="createbar__busy">
                <span className="createbar__spin" aria-hidden="true" />
                Движок раскладывает заявки по инженерам. Это около восьми секунд —
                столько работает планировщик.
              </span>
            ) : (
              <>
                {touched
                  ? 'Переменные изменены — расчёт пойдёт с ними.'
                  : 'Все переменные по умолчанию.'}
                {touched && (
                  <button
                    type="button"
                    className="createbar__reset"
                    onClick={() => setParams({ ...ENGINE_DEFAULTS })}
                  >
                    Вернуть значения движка
                  </button>
                )}
              </>
            )}
          </span>
          <div className="createbar__actions">
            <Button variant="secondary" size="sm" onClick={onCancel} disabled={solving}>
              Отмена
            </Button>
            <Button
              variant="accent"
              size="sm"
              className="engine__cta"
              onClick={() => onCreate(params)}
              disabled={solving}
              iconLeft={<Icon name="shuffle" size={14} />}
            >
              {solving ? 'Считаю…' : 'Рассчитать'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
