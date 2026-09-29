import { useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { Lede } from '../app/Lede.tsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { whenLabel } from '../data/load.ts';
import { dec } from '../data/derive.ts';
import { RunStateTag } from '../app/RunStateTag.tsx';
import { useRunStates } from '../data/runState.ts';

interface Props {
  runs: DaySummary[] | null;
  activeRun: RunId;
  onCreate: () => void;
  onOpen: (id: RunId) => void;
}

/* Вход в диспетчерскую. Раздел не открывает последний расчёт сам, но и лишнего
   вопроса не задаёт: сверху одно действие — посчитать новый день, — а всё уже
   посчитанное лежит списком под ним и открывается прямо оттуда.

   Прежде здесь стояли две равные карточки, и вторая, «Открыть существующий»,
   вела к тому же списку, что и так открыт ниже: щелчок ради того, чтобы
   увидеть уже видимое. */
/* Сколько расчётов показываем сразу. Дальше — по кнопке: в архиве их
   десятки, и вываливать всё списком значит заставить искать глазами. */
const SHORT = 5;

export function DispatchGate({ runs, activeRun, onCreate, onOpen }: Props) {
  /* Состояния строк: их же читает база расчётов. */
  const stateOf = useRunStates();
  const [expanded, setExpanded] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');

  const found = useMemo(() => {
    const all = runs ? [...runs].reverse() : [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    /* Ищут именно по номеру, и обычно по хвосту: «25» должно находить R025.
       Дату сюда не подмешиваем: «17» тогда вытаскивало и R017, и всё, что
       посчитано семнадцатого числа, — ответ переставал совпадать с вопросом. */
    return all.filter((run) => run.code.toLowerCase().includes(needle));
  }, [runs, query]);

  /* В поиске лимит не нужен: найденных и так единицы, а прятать их за
     кнопкой «раскрыть» после того, как человек уже сузил список, — значит
     заставить его нажимать дважды за один и тот же ответ. */
  /* Сколько расчётов лежит без дня и ведёт ли день хоть один.

     Взятие на день — решение диспетчера, и делать его за него сервис не
     станет. Но молчать о нём нельзя: расчёт, не взятый ни на какой день,
     в мониторинг не попадает, и день участка остаётся без плана. Прежде
     об этом не говорилось нигде, и посчитанный день просто ложился в
     архив, а мониторинг встречал пустым списком районов. */
  const idle = runs ? runs.filter((run) => stateOf(run.id, run.date) === 'idle').length : 0;
  const working = runs ? runs.some((run) => stateOf(run.id, run.date) === 'working') : false;

  const searchOn = searching && query.trim() !== '';
  const shown = searchOn || expanded ? found : found.slice(0, SHORT);
  const hidden = found.length - shown.length;

  return (
    <div className="dash enter">
      <section className="panel gateview">
        <div className="dash__section-head gatehero__head">
          <h2 className="dash__section-title">Диспетчерская</h2>
        </div>

        <Lede first="Создайте новый расчёт или продолжите работу с одним из предыдущих." />

        {/* Одно действие вместо двух карточек: «открыть посчитанное» — это
            строка списка под воротами, а не отдельная кнопка к нему. */}
        <div className="gatehero__actions">
          <Button
            variant="primary"
            className="gatehero__cta"
            iconLeft={<Icon name="plus" size={14} />}
            onClick={onCreate}
          >
            Создать новый расчёт
          </Button>
        </div>
      </section>

      <section className="panel gateview">
          <div className="dash__section-head gatehero__head">
            <h2 className="dash__section-title">Посчитанные расчёты</h2>

            <span className="gatetools">
              {searching ? (
                <label className="dbsearch">
                  <Icon name="search" size={14} />
                  <input
                    className="dbsearch__input"
                    value={query}
                    placeholder="Номер расчёта"
                    autoFocus
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setQuery('');
                        setSearching(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="dbsearch__clear"
                    title="Закрыть поиск"
                    onClick={() => {
                      setQuery('');
                      setSearching(false);
                    }}
                  >
                    <Icon name="x" size={12} />
                  </button>
                </label>
              ) : (
                <>
                  {/* Счётчик стоит над самим списком, а не в воротах: это
                      мера этого списка, и читается она рядом с ним. */}
                  <span className="dash__section-note">
                    {runs ? `${runs.length} расчётов в истории` : 'Собираем историю…'}
                  </span>
                  <button
                    type="button"
                    className="gatetools__find"
                    title="Найти расчёт по номеру"
                    onClick={() => setSearching(true)}
                  >
                    <Icon name="search" size={14} />
                    <span>Найти</span>
                  </button>
                </>
              )}
            </span>
          </div>

          {/* Призыв взять день — над списком, а не у каждой строки: дело
              одно на весь список, и повторять его девять раз незачем.
              Пропадает сам, как только хоть один расчёт повёл свой день. */}
          {runs && idle > 0 && !working && (
            <p className="gatecall">
              <Icon name="calendar" size={13} />
              {idle === runs.length
                ? 'Ни один расчёт не взят на свой день'
                : `${idle} из ${runs.length} расчётов не взяты на свой день`}
              : мониторинг по такому дню не открыть. Откройте расчёт и нажмите «В работу»
              над планом.
            </p>
          )}

          {!runs ? (
            <p className="stub__body">Собираем расчёты…</p>
          ) : (
            <div className="gatelist">
              {/* Пусто по двум разным причинам, и говорить надо разное:
                  поиск ничего не нашёл — одно, истории нет вовсе — другое. */}
              {shown.length === 0 &&
                (runs.length === 0 ? (
                  <div className="emptynote">
                    <p className="emptynote__title">Посчитанных расчётов пока нет</p>
                    <span>Начните с «Создать новый расчёт» — первый и появится здесь.</span>
                    <button type="button" className="runcard__go" onClick={onCreate}>
                      <Icon name="plus" size={13} />
                      Создать новый расчёт
                    </button>
                  </div>
                ) : (
                  <p className="runmenu__empty">
                    Расчёта с таким номером нет. Проверьте номер или очистите поиск.
                  </p>
                ))}
              {shown.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={'gaterow' + (run.id === activeRun ? ' gaterow--active' : '')}
                  title={`Открыть расчёт ${run.code}`}
                  onClick={() => onOpen(run.id)}
                >
                  <span className="gaterow__code">{run.code}</span>
                  {/* Взят ли расчёт на день — теми же словами и тем же
                      цветом, что в базе расчётов. */}
                  <RunStateTag run={run.id} date={run.date} />
                  <span className="gaterow__when">{whenLabel(run.created)}</span>
                  <span className="gaterow__facts">
                    прогноз {dec(run.coverage)} % · назначено {run.ordersAssigned} из{' '}
                    {run.ordersTotal} · без инженера {run.unassigned}
                  </span>
                  {run.id === activeRun ? (
                    <Badge tone="accent" dot>
                      последний открытый
                    </Badge>
                  ) : (
                    <Icon name="arrow-right" size={14} />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Список растёт на месте: ворота стали на одну кнопку, и от
              раскрытия истории им уже не тесно. */}
          {!searchOn && hidden > 0 && (
            <button type="button" className="tblmore" onClick={() => setExpanded(true)}>
              Показать все {found.length}
            </button>
          )}

          {!searchOn && expanded && found.length > SHORT && (
            <button type="button" className="tblmore" onClick={() => setExpanded(false)}>
              Свернуть до {SHORT}
            </button>
          )}
      </section>
    </div>
  );
}
