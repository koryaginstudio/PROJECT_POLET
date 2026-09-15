import { useEffect, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineParams } from '../data/engine.ts';
import { engineDefaults, ENGINE_DEFAULTS } from '../data/engine.ts';
import { EngineParamsForm } from '../app/EngineParamsForm.tsx';
import { SourcePicker } from '../app/SourcePicker.tsx';
import type { SourceChoice } from '../app/SourcePicker.tsx';
import type { DayView } from '../data/derive.ts';
import type { SourceId } from '../data/load.ts';
import { BUILT_IN, isBuiltIn, loadZone, sources, zoneTitle } from '../data/load.ts';
import { DatasetImport } from '../app/DatasetImport.tsx';
import { plural } from '../data/derive.ts';

interface Props {
  onCancel: () => void;
  onCreate: (params: EngineParams, zone: SourceId) => void;
  /** Состав дня: по нему собирается список инженеров и их навыков. */
  view: DayView | null;
  /** Движок сейчас считает. Восемь секунд — это его работа, а не задержка
      сети, поэтому кнопка не просто блокируется, а говорит, что происходит. */
  solving?: boolean;
  /** Чем кончился неудавшийся расчёт. `null` — всё в порядке. */
  failed?: string | null;
  /** Первый расчёт в программе: истории ещё нет, и уходить с формы некуда. */
  first?: boolean;
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
  failed = null,
  first = false
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

  /* Какую зону считаем. Зоны — это три самостоятельных рабочих дня из
     выгрузки: свой офис, свои бригады, свой район. Общий день из всех трёх
     собрать можно, но это будет уже нагрузочный тест, а не работа
     диспетчера. */
  const [zone, setZone] = useState<SourceId>(BUILT_IN[0]);
  const [sizes, setSizes] = useState<Record<string, { orders: number; engineers: number }>>({});
  /* Список источников меняется прямо на этом экране: загрузили набор — он
     встал в тот же ряд. Поэтому он в состоянии, а не считается на лету. */
  const [list, setList] = useState<SourceId[]>(() => sources());

  useEffect(() => {
    let cancelled = false;
    Promise.all(list.map((key) => loadZone(key).catch(() => null)))
      .then((zones) => {
        if (cancelled) return;
        const next: Record<string, { orders: number; engineers: number }> = {};
        for (const data of zones) {
          if (data) next[data.zone] = { orders: data.orders.length, engineers: data.engineers.length };
        }
        setSizes((was) => ({ ...was, ...next }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [list]);

  /* Загруженный набор сразу становится выбранным: человек принёс его, чтобы
     посчитать, а не чтобы он лежал в списке. */
  const onLoaded = (key: SourceId) => {
    setList(sources());
    setZone(key);
  };

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">{first ? 'Первый расчёт' : 'Новый расчёт'}</h2>
          {/* Крестик, а не «Назад»: форма — это открытая вещь, и закрывают её
              так же, как открытый расчёт на пульте. «Назад» обещало бы шаг
              в истории, а возвращает оно к тому же выбору, с которого
              диспетчерская начинается. На первом расчёте закрывать не во
              что: истории ещё нет. */}
          {!first && (
            <button
              type="button"
              className="calc__close"
              onClick={onCancel}
              title="Закрыть форму и вернуться к выбору"
              aria-label="Закрыть форму"
            >
              <Icon name="x" size={14} />
            </button>
          )}
        </div>
        <p className="clients__lede">
          {first
            ? 'Расчётов пока нет. Выберите зону обслуживания и разложите её день по инженерам — ' +
              'план, маршруты и карта появятся после расчёта.'
            : 'Движок разложит все заявки дня по инженерам. Ниже — то, чем можно повлиять на его ' +
              'решение: насколько держаться за уже объявленный план, сколько времени закладывать ' +
              'на работу и дорогу и насколько ровно распределять нагрузку.'}
        </p>
      </section>

      {/* Зона — первым вопросом: сначала решают, какой день считать, и
          только потом, как его считать. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Какой день считаем</h2>
          <span className="dash__section-note">
            {plural(list.length, 'источник', 'источника', 'источников')}
          </span>
        </div>
        <p className="clients__lede">
          Встроенные зоны — это дни выгрузки «Билайн Бизнес»: свой офис, свои бригады и свой
          район города у каждой. Расчёт идёт по одному дню. Свой набор можно загрузить файлом —
          он встанет в этот же ряд.
        </p>

        <div className="srcgrid">
          {list.map((key) => {
            const size = sizes[key];
            return (
              <button
                key={key}
                type="button"
                className={'srccard' + (zone === key ? ' srccard--on' : '')}
                onClick={() => setZone(key)}
              >
                <span className="srccard__top">
                  <Icon name="map-pin" size={16} />
                  <span className="srccard__title">{zoneTitle(key)}</span>
                </span>
                <span className="srccard__what">
                  {size
                    ? `${plural(size.orders, 'заявка', 'заявки', 'заявок')}, ` +
                      `${plural(size.engineers, 'инженер', 'инженера', 'инженеров')}`
                    : 'Читаем данные…'}
                </span>
                {!isBuiltIn(key) && <span className="srccard__mark">загружен</span>}
              </button>
            );
          })}
        </div>

        {/* Загрузка своего набора стоит здесь же, под рядом источников: это
            тот же вопрос — что считать, — а не отдельная настройка. */}
        <div className="srcblock">
          <div className="dash__section-head">
            <h3 className="srcblock__title">Загрузить свой набор</h3>
          </div>
          <DatasetImport onLoaded={onLoaded} />
        </div>
      </section>

      {/* Состав смены и заявки поверх выгрузки — только когда есть от чего
          отталкиваться: на первом расчёте открытого дня ещё нет. */}
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
            {!first && (
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={solving}>
                Отмена
              </Button>
            )}
            <Button
              variant="accent"
              size="sm"
              className="engine__cta"
              onClick={() => onCreate(params, zone)}
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
