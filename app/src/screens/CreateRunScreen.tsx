import { useEffect, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineParams } from '../data/engine.ts';
import { engineDefaults, ENGINE_DEFAULTS } from '../data/engine.ts';
import { EngineParamsForm } from '../app/EngineParamsForm.tsx';
import { SourcePicker } from '../app/SourcePicker.tsx';
import type { SourceChoice } from '../app/SourcePicker.tsx';
import type { ShiftInput } from '../data/shift.ts';
import type { SourceId } from '../data/load.ts';
import {
  BUILT_IN,
  engineReady,
  engineUploads,
  forgetUpload,
  loadZone,
  pullUploads,
  rememberUploads,
  zoneTitle
} from '../data/load.ts';
import type { Engineer } from '../data/contract.ts';
import { DayImport, DayUploadPreview } from '../app/DayUpload.tsx';
import type { EngineUpload } from '../data/api.ts';
import { prepareUpload, uploadState } from '../data/api.ts';
import { humanLine } from '../data/errors.ts';

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

  /* Какой день считаем. Ряда участков на форме больше нет — день приносят
     файлом, и выбранным становится он. Пока файла нет, считается участок
     выгрузки, с которого программа расчёта открывается сама: убрать выбор
     с экрана можно, а посчитать без дня — нет. */
  const [zone, setZone] = useState<SourceId>(BUILT_IN[0]);
  /* Программа расчёта считает только выгрузку заказчика: принесённый файл
     уходит ей и становится таким же днём, как участки. */
  const engine = engineReady();
  /* Выгрузки дня, которые принесли кнопкой. Состояние, а не чтение реестра
     на лету: после загрузки, подготовки и удаления экран должен
     перерисоваться. */
  const [uploads, setUploads] = useState<EngineUpload[]>(() => (engine ? engineUploads() : []));

  /* Выгрузку могли принести или убрать из другого окна — перечитываем при
     открытии формы. Не прочиталось — остаётся то, что было. */
  useEffect(() => {
    if (!engine) return;
    let cancelled = false;
    pullUploads()
      .then((fresh) => {
        if (cancelled) return;
        setUploads(fresh);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [engine]);

  const refreshUploads = (changed?: EngineUpload) => {
    if (changed) rememberUploads([changed]);
    setUploads(engineUploads());
  };

  /* Состав выбранной зоны. Меняется вместе с зоной: снятые с одной зоны
     табельные к соседней отношения не имеют, и переносить их туда значило бы
     снять с работы людей, которых диспетчер не трогал. */
  const [crew, setCrew] = useState<Engineer[]>([]);
  useEffect(() => {
    /* При программе расчёта состава смены на форме нет: бригаду она берёт
       из самой выгрузки, и читать файлы незачем. */
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

  const selectedUpload = engine ? uploads.find((one) => one.day === zone) : undefined;

  /* Что уйдёт в расчёт прямо сейчас. Ряда участков на форме нет, и без этой
     строки экран молчал о том, что при ненесённом файле считает участок по
     умолчанию: человек нажимал «Рассчитать», ничего не выбрав, и получал
     готовый план — будто из ниоткуда. */
  const dayNote = selectedUpload
    ? `Файл «${selectedUpload.name}»`
    : `Без файла посчитаем участок «${zoneTitle(zone)}»`;

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
      {/* Заголовок экрана — над карточками, а не в одной из них.

          Прежде он стоял в своей белой панели: полоса во всю ширину, два
          слова в ней и пустота под ними, а сразу следом — такая же полоса с
          настоящим содержимым. Панель обещает раздел с содержанием, и первая
          панель этого обещания не держала. Имя экрана — общее для всех
          карточек под ним, и стоять оно должно над ними. */}
      <header className="calc__head">
        <div className="calc__head-text">
          <h2 className="calc__title">{first ? 'Первый расчёт' : 'Новый расчёт'}</h2>
          <p className="calc__lede">
            {first
              ? 'Расчётов пока нет. Принесите день файлом и разложите его по инженерам.'
              : 'Программа разложит заявки дня по инженерам. Ниже — что считаем и по каким правилам.'}
          </p>
        </div>
        {/* Крестик, а не «Назад»: форма — это открытая вещь, и закрывают её
            так же, как открытый расчёт на пульте. «Назад» обещало бы шаг
            в истории, а возвращает оно к тому же выбору, с которого
            диспетчерская начинается. На первом расчёте закрывать не во
            что: истории ещё нет. */}
        {!first && (
          <button
            type="button"
            className="calc__close calc__close--head"
            onClick={onCancel}
            title="Закрыть форму и вернуться к выбору"
            aria-label="Закрыть форму"
          >
            <Icon name="x" size={14} />
          </button>
        )}
      </header>

      {/* Первый вопрос — что считаем. Раздел называется днём, а не «импортом
          файлов»: файл здесь не цель, а способ принести день. И сразу под
          заголовком сказано, что уйдёт в расчёт, если файл не приносить, —
          прежде участок по умолчанию выбирался молча, и расчёт заводился
          будто вовсе без вводных. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">День для расчёта</h2>
          <span className="dash__section-note">{dayNote}</span>
        </div>

        <DayImport
          offline={!engine}
          onUploaded={(upload) => {
            refreshUploads(upload);
            setZone(upload.day);
            setPrepareFailed(null);
          }}
        />
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

      {/* Состав смены и заявки поверх выгрузки. Отталкиваемся от выбранной
          зоны, а не от открытого расчёта: считают то, что выбрано здесь. */}
      {!engine && crew.length > 0 && (
        <SourcePicker crew={crew} orderCount={0} value={source} onChange={setSource} />
      )}

      {/* Второй вопрос — как считаем. Три карточки правил идут под общим
          именем: порознь они читались как три самостоятельных раздела, хотя
          отвечают на один вопрос и меняют одно и то же — решение программы.

          Сами переменные — общей вёрсткой с настройками: вопрос один и тот
          же, значит и подписи, и пресеты, и замеры одни и те же. */}
      <section className="calc__rules">
        <div className="calc__rules-head">
          <h2 className="dash__section-title">Правила расчёта</h2>
          <p className="calc__rules-note">
            Чем можно повлиять на решение программы: насколько держаться за уже объявленный план,
            сколько закладывать на работу и дорогу и насколько ровно делить нагрузку.
          </p>
        </div>
        <EngineParamsForm params={params} onChange={setParams} />
      </section>

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
              /* Пока настройки заводские, говорить нечего: строка «всё по
                 умолчанию» сообщала то, что и так видно по рычагам. Тронули —
                 остаётся одна дорога назад, и она сама себя называет. */
              touched && (
                <button
                  type="button"
                  className="createbar__reset"
                  onClick={() => setParams({ ...ENGINE_DEFAULTS })}
                >
                  <Icon name="arrow-left" size={13} />
                  Вернуть по умолчанию
                </button>
              )
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
