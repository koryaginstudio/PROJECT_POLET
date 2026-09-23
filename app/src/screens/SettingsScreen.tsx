import { useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineParams } from '../data/engine.ts';
import {
  DISPATCH_KNOBS,
  ENGINE_DEFAULTS,
  engineDefaults,
  resetEngineDefaults,
  setEngineDefaults
} from '../data/engine.ts';
import { sources, zoneTitle } from '../data/load.ts';
import { clearHistory, clearRunEdits, engineReady, RUNS, runCount, runEditCount } from '../data/load.ts';
import { SCHEMA } from '../data/contract.ts';
import { plural } from '../data/derive.ts';
import type { Registry } from '../data/registry.ts';
import { skillIcon, skillName } from '../data/dictionary.ts';
import { EngineParamsForm } from '../app/EngineParamsForm.tsx';
import { KnobsForm } from '../app/KnobsForm.tsx';
import { Lede } from '../app/Lede.tsx';
import { ServiceForm } from '../app/ServiceForm.tsx';
import {
  changedKnobs,
  KNOBS,
  knobValues,
  resetKnobs,
  setKnob,
  TOTAL_COUNT,
  WIRED_COUNT
} from '../data/knobs.ts';

interface Props {
  /** Вкладка подшапки: движок, сервис или данные. */
  mode: string;
  /** Справочники. Пусто, пока не загружены: раздел живёт над расчётом. */
  registry: Registry | null;
  /** Правки истории сняли — экраны, читающие её, надо пересобрать. */
  onEditsCleared: () => void;
  /** Историю стёрли целиком. Открытого расчёта больше нет, и оболочка обязана
      увести экран туда, где он не нужен, — иначе она покажет план записи,
      которой не существует. */
  onHistoryCleared: () => void;
}

/* Настройки.

   Здесь лежит то, что диспетчер задаёт один раз и надолго, — в отличие от
   формы нового расчёта, где переменные задают на один расчёт. Разделено по
   этому признаку, а не по разделам интерфейса.

   «Движок» — значения, с которых открывается форма нового расчёта. Заводские
   при этом остаются нетронутыми: вернуться к ним можно одним щелчком, и
   пометка «По умолчанию» в самой форме всегда показывает на них, а не на то,
   что здесь выставлено.

   «Данные» отвечает на вопрос «откуда всё это взялось» и показывает, что
   именно наша сторона держит у себя. Читать здесь можно всё, править —
   только то, что завели мы сами: справочники приходят из источника, и
   переписывать их в интерфейсе значило бы разойтись с ним. */
export function SettingsScreen({ mode, registry, onEditsCleared, onHistoryCleared }: Props) {
  const [params, setParams] = useState<EngineParams>(engineDefaults());
  /* Счётчики читаются из хранилища, а не из состояния: снять правки можно и
     на этом же экране, и число под кнопкой должно после этого меняться. */
  const [stamp, setStamp] = useState(0);
  const saved = JSON.stringify(params) === JSON.stringify(engineDefaults());
  const factory = JSON.stringify(params) === JSON.stringify(ENGINE_DEFAULTS);
  const edits = runEditCount();
  const history = runCount();
  /* Стирание истории спрашивает подтверждение в самой кнопке, вторым щелчком:
     отдельного окна это не стоит, а щелчок мимо — стоит всей истории. Приём
     тот же, что у удаления расчёта и у удаления инженера. */
  const [wiping, setWiping] = useState(false);
  /* Запущен ли движок и сколько записей пришло из его архива. Читается из
     загрузчика, а не из состояния: ответ известен с запуска и не меняется. */
  const live = engineReady();
  const remote = RUNS.filter((run) => run.source === null).length;
  /* Значения каталога держим в состоянии: форма из пятнадцати полей должна
     перерисовываться от правки, а хранилище отвечает только за то, чтобы
     они пережили перезагрузку. */
  const [knobs, setKnobs] = useState(knobValues);
  const changed = changedKnobs();
  const changeKnob = (key: string, value: number) => {
    setKnob(key, value);
    setKnobs(knobValues());
  };

  const save = () => {
    setEngineDefaults(params);
    setStamp((n) => n + 1);
  };

  const toFactory = () => {
    resetEngineDefaults();
    resetKnobs();
    setParams(engineDefaults());
    setKnobs(knobValues());
    setStamp((n) => n + 1);
  };

  /* Настройки сервиса стоят отдельной вкладкой, а не отдельным разделом:
     «настройки» должны быть одним местом, иначе их ищут в двух. Шестерёнка в
     шапке — быстрый доступ к паре переключателей и дорога сюда. */
  if (mode === 'service') return <div className="dash enter"><ServiceForm /></div>;

  if (mode === 'data') {
    return (
      <div className="dash enter" key={stamp}>
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Откуда берутся данные</h2>
          </div>
          <Lede first="План, смены и прогноз дня приходят по одному контракту из двух мест.">
            Записанные дни лежат файлами на диске — на них интерфейс открывается всегда, даже когда
            программа расчёта не запущена. Живая программа считает день по-настоящему и хранит свои
            расчёты у себя; найденные у неё записи дописываются в конец истории, а не заменяют её.
          </Lede>

          <div className="setrow">
            <span className="setrow__key">Программа расчёта</span>
            <span className="setrow__val">
              {live ? (
                <>
                  запущен, {plural(remote, 'расчёт', 'расчёта', 'расчётов')} в его архиве
                </>
              ) : (
                'не запущен — работаем на записанных днях'
              )}
            </span>
          </div>
          <div className="setrow">
            <span className="setrow__key">Записанные дни</span>
            <span className="setrow__val">{sources().map(zoneTitle).join(' · ')}</span>
          </div>
          <div className="setrow">
            <span className="setrow__key">Записей в истории</span>
            <span className="setrow__val">
              {RUNS.length}
              {live && remote > 0 && (
                <span className="setrow__note"> из них настоящих: {remote}</span>
              )}
            </span>
          </div>
          <div className="setrow">
            <span className="setrow__key">Схема контракта</span>
            <span className="setrow__val">{SCHEMA}</span>
          </div>
        </section>

        {/* Как запустить движок — здесь, а не в переписке: на защите это
            первое, что спросят, если экран открылся на записанных днях.
            Свёрнуто под «Для администратора»: команды для установки
            диспетчеру не нужны, а на виду читались бы как поручение. */}
        {!live && (
          <section className="panel">
            <div className="dash__section-head">
              <h2 className="dash__section-title">Как включить живой расчёт</h2>
            </div>
            <p className="clients__lede">
              Программа расчёта сейчас не запущена, и расчёты считаются в браузере. Включает её
              администратор: интерфейс найдёт её сам при следующем запуске, настраивать ничего не нужно.
            </p>
            <details className="fold">
              <summary className="fold__summary">
                <Icon name="chevron-right" size={13} />
                Для администратора
              </summary>
              <div className="fold__body">
                <p className="clients__lede">
                  Интерфейс ищет программу расчёта сначала по своему же адресу, потом на localhost:8000.
                  Запуск на машине с Python:
                </p>
                <pre className="setcode">
                  pip install numpy scipy{'\n'}
                  python3 -m vrptw.server
                </pre>
              </div>
            </details>
          </section>
        )}

        {/* Правки истории — единственное, что наша сторона держит у себя.
            Сказать об этом надо прямо: правка, которая молча живёт в одном
            браузере, хуже, чем правка, про которую известно, где она. */}
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Правки записей</h2>
          </div>
          <Lede first="Правки номера, времени и заметки хранятся в этом браузере — на другом компьютере их не будет.">
            Номер, время создания и заметку у расчёта заводит человек, программа расчёта их не считает.
            Исключение — заметка к настоящему расчёту: её программа расчёта кладёт к себе рядом с планом,
            поэтому она переживает и смену браузера.
          </Lede>

          <div className="setrow">
            <span className="setrow__key">Правленых записей</span>
            <span className="setrow__val">
              {edits === 0 ? 'ни одной' : `${edits} из ${history}`}
            </span>
          </div>

          <div className="setbar">
            <Button
              variant="secondary"
              size="sm"
              disabled={edits === 0}
              onClick={() => {
                clearRunEdits();
                setStamp((n) => n + 1);
                onEditsCleared();
              }}
              iconLeft={<Icon name="arrow-left" size={14} />}
            >
              Снять все правки
            </Button>
            <span className="setbar__note">
              Номер, время и заметка вернутся к тому, что посчитала программа расчёта. Сами расчёты остаются
              на месте — снимаются правки, а не история.
            </span>
          </div>
        </section>

        {/* Стирание истории стоит отдельной панелью, а не второй кнопкой рядом
            со снятием правок. Это разные по цене действия: одно откатывает
            подпись, другое уносит всё посчитанное, и стоять им рядом — значит
            звать промахнуться. */}
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">История расчётов</h2>
            <span className="dash__section-note">хранится в этом браузере</span>
          </div>
          <p className="clients__lede">
            Все расчёты, посчитанные здесь, лежат в хранилище этого браузера. Данные зон это не
            затрагивает: они лежат файлами, и посчитать день заново можно всегда.
          </p>

          <div className="setrow">
            <span className="setrow__key">Расчётов в истории</span>
            <span className="setrow__val">{history}</span>
          </div>

          <div className="setbar">
            <Button
              variant={wiping ? 'primary' : 'secondary'}
              size="sm"
              disabled={history === 0}
              onClick={() => {
                if (!wiping) {
                  setWiping(true);
                  return;
                }
                clearHistory();
                setWiping(false);
                setStamp((n) => n + 1);
                onHistoryCleared();
              }}
              iconLeft={<Icon name="trash" size={14} />}
            >
              {wiping ? 'Да, стереть всё' : 'Стереть историю расчётов'}
            </Button>
            {wiping && (
              <Button variant="ghost" size="sm" onClick={() => setWiping(false)}>
                Отмена
              </Button>
            )}
            <span className="setbar__note">
              {wiping
                ? `Будет стёрто ${plural(history, 'расчёт', 'расчёта', 'расчётов')}. Вернуть их нельзя — только посчитать заново.`
                : 'Удалит все посчитанные расчёты разом. Отменить это нельзя.'}
            </span>
          </div>
        </section>

        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Навыки инженеров</h2>
            <span className="dash__section-note">приходят из источника</span>
          </div>
          <p className="clients__lede">
            Список не заводится в интерфейсе: навыки приходят вместе с инженерами, и незнакомый
            код показывается как есть. Править его здесь значило бы разойтись с источником.
          </p>

          {registry ? (
            <div className="skillgrid">
              {registry.stats.bySkill.map((item) => (
                <div key={item.key} className="skillcard">
                  <Icon name={skillIcon(item.key)} size={16} />
                  <span className="skillcard__name">{skillName(item.key)}</span>
                  <span className="skillcard__code">{item.key}</span>
                  <span className="skillcard__count">{item.count} инж.</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="hourlist__line">Справочники ещё не загружены — зайдите в любую базу.</p>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Правила расчёта</h2>
          <span className="dash__section-note">{factory ? 'заводские' : 'изменены'}</span>
        </div>
        <Lede first="Семь настроек расчёта — весь список, который есть смысл менять.">
          У каждой есть смысл на языке диспетчера: насколько завышать оценку времени работ,
          сколько запаса закладывать, как ровно делить нагрузку, при каком остатке предупреждать.
          Остальные параметры расчёта — внутренние параметры поиска, откалиброванные на замерах:
          неудачное значение любой из них тихо ухудшает план, и узнать об этом из интерфейса
          неоткуда.
        </Lede>
        <div className="setrow">
          <span className="setrow__key">Изменено настроек</span>
          <span className="setrow__val">
            {changed === 0 ? 'ничего' : `${changed} из ${TOTAL_COUNT}`}
          </span>
        </div>
        {/* Прежде здесь стояло «Учитываются в расчёте — 2 из 7», и это читалось
            так, будто пять настроек ни на что не влияют. Влияют: расчёт берёт
            их из формы нового расчёта. Разница не в том, учитываются ли они,
            а в том, где их задают. */}
        <div className="setrow">
          <span className="setrow__key">Меняются на этом экране</span>
          <span className="setrow__val">
            {WIRED_COUNT === TOTAL_COUNT ? 'все семь' : `${WIRED_COUNT} из ${TOTAL_COUNT}`}
            {WIRED_COUNT !== TOTAL_COUNT && (
              <span className="setrow__note"> остальные задаются при создании расчёта</span>
            )}
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Графики смен инженеров</span>
          <span className="setrow__val">
            не настройка, а данные
            <span className="setrow__note"> приходят готовым файлом и загружаются сами</span>
          </span>
        </div>
      </section>

      {KNOBS.map((group) => (
        <KnobsForm key={group.id} group={group} values={knobs} onChange={changeKnob} />
      ))}

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">С чего открывается новый расчёт</h2>
          <span className="dash__section-note">те же значения, но словами</span>
        </div>
        <Lede first="Три настройки, которые трогают чаще всего, — так, как они выглядят при создании расчёта.">
          Словами и готовыми вариантами, потому что решение принимается по смыслу, а не по
          числу. Это те же самые значения — вид разный, значение одно.
        </Lede>
      </section>

      <EngineParamsForm params={params} onChange={setParams} only={DISPATCH_KNOBS} />

      <section className="panel">
        <div className="createbar">
          <span className="createbar__note">
            {saved
              ? factory
                ? 'Стоят заводские значения.'
                : 'Сохранено. Форма нового расчёта откроется с этими значениями.'
              : 'Изменения не сохранены.'}
          </span>
          <div className="createbar__actions">
            <Button variant="secondary" size="sm" disabled={factory} onClick={toFactory}>
              Вернуть заводские
            </Button>
            <Button variant="primary" size="sm" disabled={saved} onClick={save}>
              Сохранить
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
