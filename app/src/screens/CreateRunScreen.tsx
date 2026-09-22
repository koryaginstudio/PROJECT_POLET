import { useEffect, useRef, useState } from 'react';
import { Lede } from '../app/Lede.tsx';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineParams } from '../data/engine.ts';
import { engineDefaults, ENGINE_DEFAULTS } from '../data/engine.ts';
import { EngineParamsForm } from '../app/EngineParamsForm.tsx';
import { EngineSourceNote, SourcePicker } from '../app/SourcePicker.tsx';
import type { SourceChoice } from '../app/SourcePicker.tsx';
import type { ShiftInput } from '../data/shift.ts';
import { shiftSummary } from '../data/shift.ts';
import type { SourceId } from '../data/load.ts';
import {
  BUILT_IN,
  engineReady,
  engineUploads,
  forgetUpload,
  isBuiltIn,
  loadZone,
  pullUploads,
  rememberUploads,
  sources,
  zoneSize,
  zoneTitle
} from '../data/load.ts';
import type { Engineer } from '../data/contract.ts';
import { DatasetImport } from '../app/DatasetImport.tsx';
import { DayUploadButton, DayUploadPreview } from '../app/DayUpload.tsx';
import type { EngineUpload } from '../data/api.ts';
import { prepareUpload, uploadState } from '../data/api.ts';
import { humanLine } from '../data/errors.ts';
import { plural } from '../data/derive.ts';

interface Props {
  onCancel: () => void;
  onCreate: (params: EngineParams, zone: SourceId, shift: ShiftInput) => void;
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
  solving = false,
  failed = null,
  first = false
}: Props) {
  /* Форма открывается тем, что стоит в настройках, а не заводскими числами:
     настройки для того и заведены. Сравниваем всё равно с заводскими — это
     единственная неподвижная точка отсчёта. */
  const [params, setParams] = useState<EngineParams>(engineDefaults());
  /* Состав дня: по умолчанию в смене все, кто есть. Снимают тех, кто
     сегодня не вышел, — это решение, а не настройка по умолчанию.

     Список пустой до тех пор, пока не прочитана зона: заполнить его
     табельными открытого расчёта нельзя — считать могут соседнюю зону, и
     её инженеры зовутся иначе. */
  const [source, setSource] = useState<SourceChoice>(() => ({
    from: 'manual',
    engineers: [],
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
  /* Участки, чей размер узнать не удалось, — с технической причиной. Без
     этого карточка навсегда оставалась на «Читаем данные…». */
  const [sizeFails, setSizeFails] = useState<Record<string, string>>({});
  /* Список источников меняется прямо на этом экране: загрузили набор — он
     встал в тот же ряд. Поэтому он в состоянии, а не считается на лету. */
  /* Программа расчёта считает только три участка выгрузки: загруженный
     набор она не примет, и карточка его в ряду обещала бы расчёт, который
     упадёт с ошибкой. */
  const engine = engineReady();
  /* Выгрузки дня, которые принесли кнопкой: при программе расчёта они стоят
     в ряду рядом с участками. Состояние, а не чтение реестра на лету: после
     загрузки, подготовки и удаления экран должен перерисоваться. */
  const [uploads, setUploads] = useState<EngineUpload[]>(() => (engine ? engineUploads() : []));
  const engineList = (list: EngineUpload[]): SourceId[] => [...BUILT_IN, ...list.map((one) => one.day)];
  const [list, setList] = useState<SourceId[]>(() => (engine ? engineList(engineUploads()) : sources()));

  /* Выгрузку могли принести или убрать из другого окна — перечитываем при
     открытии формы. Не прочиталось — остаётся то, что было. */
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    pullUploads()
      .then((fresh) => {
        if (cancelled) return;
        setUploads(fresh);
        setList(engineList(fresh));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [engine]);

  const refreshUploads = (changed?: EngineUpload) => {
    if (changed) rememberUploads([changed]);
    const fresh = engineUploads();
    setUploads(fresh);
    setList(engineList(fresh));
    if (changed) {
      setSizes((was) => ({ ...was, [changed.day]: { orders: changed.to_plan, engineers: changed.engineers } }));
    }
  };

  /* Размеры участков — от того, кто будет считать: при программе расчёта
     по её плану (своя бригада, 14 человек на участок), без неё — по файлам. */
  useEffect(() => {
    let cancelled = false;
    Promise.all(
      list.map((key) =>
        zoneSize(key)
          .then((size) => ({ key, size, fail: null }))
          .catch((error: unknown) => ({
            key,
            size: null,
            fail: error instanceof Error ? error.message : String(error)
          }))
      )
    )
      .then((zones) => {
        if (cancelled) return;
        const next: Record<string, { orders: number; engineers: number }> = {};
        const fails: Record<string, string> = {};
        for (const one of zones) {
          if (one.size) next[one.key] = one.size;
          else if (one.fail !== null) fails[one.key] = one.fail;
        }
        setSizes((was) => ({ ...was, ...next }));
        setSizeFails(fails);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [list]);

  /* Состав выбранной зоны. Меняется вместе с зоной: снятые с одной зоны
     табельные к соседней отношения не имеют, и переносить их туда значило бы
     снять с работы людей, которых диспетчер не трогал. */
  const [crew, setCrew] = useState<Engineer[]>([]);
  useEffect(() => {
    /* При программе расчёта состава смены на форме нет — вводные она не
       принимает (см. EngineSourceNote), и читать файлы незачем. */
    if (engine) return;
    let cancelled = false;
    loadZone(zone)
      .then((data) => {
        if (cancelled) return;
        setCrew(data.engineers);
        setSource((was) => ({
          ...was,
          engineers: data.engineers.map((one) => one.id),
          skillsOff: {},
          extra: []
        }));
      })
      .catch(() => {
        if (!cancelled) setCrew([]);
      });
    return () => {
      cancelled = true;
    };
  }, [zone, engine]);

  /* Что из вводных доедет до расчёта. Полный состав смены — это не вводная,
     а отсутствие вводных: «в смене все» и «я никого не снимал» — одно и то
     же, и писать это в запись расчёта незачем. */
  const shift: ShiftInput = {
    ...(crew.length > 0 && source.engineers.length < crew.length
      ? { engineers: source.engineers }
      : {}),
    ...(Object.keys(source.skillsOff).length > 0 ? { skillsOff: source.skillsOff } : {}),
    ...(source.extra.length > 0 ? { extra: source.extra } : {})
  };
  const shiftNote = shiftSummary(shift, crew.length);

  /* Загруженный набор сразу становится выбранным: человек принёс его, чтобы
     посчитать, а не чтобы он лежал в списке. */
  const onLoaded = (key: SourceId) => {
    setList(sources());
    setZone(key);
  };

  const selectedUpload = engine ? uploads.find((one) => one.day === zone) : undefined;

  /* «Рассчитать» по выгрузке, которая ещё не готова: сперва подготовка —
     адреса, сеть дорог, план, — потом обычный расчёт. Подготовка идёт у
     программы расчёта в фоне и может занять минуты (новый адрес ищется
     1,4 с), поэтому здесь не один долгий запрос, а опрос хода раз в
     секунду: запрос, ждущий минуты, оборвался бы по сроку. */
  const [preparing, setPreparing] = useState(false);
  const [prepareFailed, setPrepareFailed] = useState<string | null>(null);
  /* Флаг ставится при каждом монтировании, а не только начальным значением:
     StrictMode монтирует эффект дважды, и после первой уборки флаг навсегда
     оставался бы ложным — опрос хода не начинался, кнопка висела на
     «Готовлю…». */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const create = async () => {
    const upload = engine ? uploads.find((one) => one.day === zone) : undefined;
    if (upload && upload.status !== 'готова') {
      setPreparing(true);
      setPrepareFailed(null);
      try {
        let state = await prepareUpload(upload.day);
        while (alive.current && state.status === 'готовится') {
          refreshUploads(state);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          state = await uploadState(upload.day);
        }
        if (!alive.current) return;
        refreshUploads(state);
        if (state.status !== 'готова') {
          setPrepareFailed(state.error ?? 'Выгрузка не подготовилась.');
          return;
        }
      } catch (error) {
        if (alive.current) {
          setPrepareFailed(
            humanLine(error, { title: 'Выгрузка не подготовилась', hint: 'Нажмите «Рассчитать» ещё раз.' })
          );
        }
        return;
      } finally {
        if (alive.current) setPreparing(false);
      }
    }
    onCreate(params, zone, shift);
  };
  const busy = solving || preparing;
  const preparingText = (() => {
    if (!preparing || !selectedUpload) return null;
    const step = selectedUpload.stage ?? 'готовлю выгрузку';
    const done = selectedUpload.progress
      ? `: ${selectedUpload.progress.done} из ${selectedUpload.progress.total}`
      : '';
    return `Готовлю выгрузку — ${step}${done}…`;
  })();

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
        {/* Первая фраза — что делать; почему и как — под «Подробнее». В
            пустом состоянии видимая фраза и есть указание, поэтому она
            собрана целиком, а не отрезана по первой точке. */}
        {first ? (
          <Lede first="Расчётов пока нет — выберите зону обслуживания и разложите её день по инженерам.">
            План, маршруты и карта появятся после расчёта.
          </Lede>
        ) : (
          <Lede
            text={
              'Программа расчёта разложит все заявки дня по инженерам. Ниже — то, чем можно повлиять на её ' +
              'решение: насколько держаться за уже объявленный план, сколько времени закладывать ' +
              'на работу и дорогу и насколько ровно распределять нагрузку.'
            }
          />
        )}
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
        <Lede
          first={engine ? 'Расчёт идёт по одному участку.' : 'Расчёт идёт по одному дню одной зоны.'}
        >
          {engine
            ? 'Участки — это дни выгрузки «Билайн Бизнес»: свой офис, своя бригада и свой ' +
              'район города у каждого. Выгрузку своего дня можно загрузить файлом — она встанет ' +
              'в этот же ряд.'
            : 'Встроенные зоны — это дни выгрузки «Билайн Бизнес»: свой офис, свои бригады и ' +
              'свой район города у каждой. Свой набор можно загрузить файлом — он встанет в ' +
              'этот же ряд.'}
        </Lede>

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
                    : sizeFails[key] !== undefined
                      ? 'Не удалось узнать размер участка'
                      : 'Читаем данные…'}
                </span>
                {!isBuiltIn(key) && <span className="srccard__mark">загружен</span>}
              </button>
            );
          })}
        </div>

        {/* Загрузка своего набора стоит здесь же, под рядом источников: это
            тот же вопрос — что считать, — а не отдельная настройка. */}
        {!engine && (
          <div className="srcblock">
            <div className="dash__section-head">
              <h3 className="srcblock__title">Загрузить свой набор</h3>
            </div>
            <DatasetImport onLoaded={onLoaded} />
          </div>
        )}
        {/* При программе расчёта загрузка одна — выгрузка дня файлом. Она
            идёт программе как есть: разбор, адреса и сеть — её работа. */}
        {engine && (
          <div className="srcblock">
            <div className="dash__section-head">
              <h3 className="srcblock__title">Загрузить выгрузку дня</h3>
            </div>
            <DayUploadButton
              current={selectedUpload}
              onUploaded={(upload) => {
                refreshUploads(upload);
                setZone(upload.day);
                setPrepareFailed(null);
              }}
            />
          </div>
        )}
      </section>

      {engine && selectedUpload && (
        <DayUploadPreview
          upload={selectedUpload}
          onDeleted={(day) => {
            forgetUpload(day);
            refreshUploads();
            if (zone === day) setZone(BUILT_IN[0]);
            setPrepareFailed(null);
          }}
        />
      )}

      {engine && !selectedUpload && (
        <EngineSourceNote
          orders={sizes[zone]?.orders}
          engineers={sizes[zone]?.engineers}
          fail={sizeFails[zone]}
        />
      )}

      {/* Состав смены и заявки поверх выгрузки. Отталкиваемся от выбранной
          зоны, а не от открытого расчёта: считают то, что выбрано здесь. */}
      {!engine && crew.length > 0 && (
        <SourcePicker
          crew={crew}
          orderCount={sizes[zone]?.orders ?? 0}
          value={source}
          onChange={setSource}
        />
      )}

      {/* Сами переменные — общей вёрсткой с настройками: вопрос один и тот
          же, значит и подписи, и пресеты, и замеры одни и те же. */}
      <EngineParamsForm params={params} onChange={setParams} />

      {/* Отказ движка показываем на форме, а не уводим с неё: переменные
          остались набранными, и повторить расчёт — это один щелчок. */}
      {(failed || prepareFailed) && (
        <section className="panel">
          <div className="solvefail">
            <Icon name="alert-triangle" size={16} />
            <span>
              <b>Расчёт не пошёл.</b> {prepareFailed ?? failed}
            </span>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="createbar">
          <span className="createbar__note">
            {preparingText ? (
              <span className="createbar__busy">
                <span className="createbar__spin" aria-hidden="true" />
                {preparingText}
              </span>
            ) : solving ? (
              /* Пока солвер думает, подпись занята делом, а не состоянием
                 формы: восемь секунд молчания — это то, за что на защите
                 спрашивают «оно зависло?». */
              <span className="createbar__busy">
                <span className="createbar__spin" aria-hidden="true" />
                Идёт расчёт: заявки раскладываются по инженерам. Это около восьми секунд —
                столько работает планировщик.
              </span>
            ) : (
              <>
                {touched
                  ? 'Настройки изменены — расчёт пойдёт с ними.'
                  : 'Все настройки по умолчанию.'}
                {touched && (
                  <button
                    type="button"
                    className="createbar__reset"
                    onClick={() => setParams({ ...ENGINE_DEFAULTS })}
                  >
                    Вернуть заводские значения
                  </button>
                )}
                {/* Вводные смены называем здесь же, у кнопки. Их задают
                    на панели выше и к моменту запуска уже не видят, а
                    расчёт пойдёт именно с ними — и это последнее место,
                    где ошибку ещё можно заметить до восьми секунд счёта. */}
                {shiftNote.length > 0 && (
                  <span className="createbar__shift">Вводные смены: {shiftNote.join(' · ')}.</span>
                )}
              </>
            )}
          </span>
          <div className="createbar__actions">
            {!first && (
              <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
                Отмена
              </Button>
            )}
            <Button
              variant="accent"
              size="sm"
              className="engine__cta"
              onClick={() => void create()}
              disabled={busy}
              iconLeft={<Icon name="shuffle" size={14} />}
            >
              {preparing ? 'Готовлю…' : solving ? 'Считаю…' : 'Рассчитать'}
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
