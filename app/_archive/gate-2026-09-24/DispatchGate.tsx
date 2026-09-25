import { useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Lede } from '../app/Lede.tsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { whenLabel } from '../data/load.ts';
import { dec } from '../data/derive.ts';

interface Props {
  runs: DaySummary[] | null;
  activeRun: RunId;
  onCreate: () => void;
  onOpen: (id: RunId) => void;
}

/* Вход в диспетчерскую. Раздел не открывает последний расчёт сам: сначала
   вопрос — считать новый или открыть готовый, — и только потом экран плана.

   История расчётов открыта сразу, под карточками выбора: в большинстве
   случаев приходят именно за ней, и прятать её за нажатием значит добавлять
   шаг к самому частому действию. Карточка «Открыть существующий» переводит
   на полный список: там поиск по номеру и вся история, а карточки выбора
   уступают ему место. */
/* Сколько расчётов показываем сразу. Дальше — по кнопке: в архиве их
   десятки, и вываливать всё списком значит заставить искать глазами. */
const PAGE = 10;

/* В обзоре список короче: он стоит под карточками выбора и не должен
   отодвигать их с экрана. Полная история — в раскрытом виде. */
const SHORT = 5;

export function DispatchGate({ runs, activeRun, onCreate, onOpen }: Props) {
  /* Два вида одного экрана: обзор с карточками и раскрытая история. Второй
     не добавляет данных, он отдаёт списку всю ширину и внимание. */
  const [mode, setMode] = useState<'overview' | 'list'>('overview');
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
  const searchOn = searching && query.trim() !== '';
  const onList = mode === 'list';
  const shown = searchOn || expanded ? found : found.slice(0, onList ? PAGE : SHORT);
  const hidden = found.length - shown.length;

  return (
    <div className="dash enter">
      {!onList && (
        <section className="panel gateview">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Диспетчерская</h2>
            <span className="dash__section-note">
              {runs ? `${runs.length} расчётов в истории` : 'Собираем историю…'}
            </span>
          </div>

          <Lede first="Начните с нового расчёта или откройте один из посчитанных раньше.">
            Диспетчерская — это работа с планом: программа расчёта раскладывает заявки по
            инженерам, а вы смотрите, что получилось, и правите.
          </Lede>

          <div className="gate">
            <button type="button" className="gate__card gate__card--accent" onClick={onCreate}>
              <span className="gate__icon">
                <Icon name="shuffle" size={22} />
              </span>
              <span className="gate__title">Создать расчёт</span>
              <span className="gate__note">
                Задать правила расчёта и разложить заявки по инженерам заново.
              </span>
              <span className="gate__go">
                Дальше
                <Icon name="arrow-right" size={13} />
              </span>
            </button>

            {/* Одна кнопка вместо переключателя «показать/скрыть»: список и
                так открыт ниже, а эта карточка отдаёт ему весь экран. */}
            <button type="button" className="gate__card" onClick={() => setMode('list')}>
              <span className="gate__icon">
                <Icon name="stack" size={22} />
              </span>
              <span className="gate__title">Открыть существующий</span>
              <span className="gate__note">
                Вернуться к уже посчитанному плану — своему сегодняшнему или из архива.
              </span>
              <span className="gate__go">
                Дальше
                <Icon name="arrow-right" size={13} />
              </span>
            </button>
          </div>
        </section>
      )}

      <section className={'panel gateview' + (onList ? ' gateview--full' : '')}>
          <div className="dash__section-head">
            <h2 className="dash__section-title">
              {onList && (
                <button
                  type="button"
                  className="gateback"
                  onClick={() => {
                    setMode('overview');
                    setExpanded(false);
                    setSearching(false);
                    setQuery('');
                  }}
                  aria-label="Вернуться к выбору действия"
                >
                  <Icon name="arrow-left" size={14} />
                </button>
              )}
              Посчитанные расчёты
            </h2>

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
                  <span className="dash__section-note">Свежие сверху</span>
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
                    <span>Начните с «Создать расчёт» — первый и появится здесь.</span>
                    <button type="button" className="runcard__go" onClick={onCreate}>
                      <Icon name="shuffle" size={13} />
                      Создать расчёт
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
                  onClick={() => onOpen(run.id)}
                >
                  <span className="gaterow__code">{run.code}</span>
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

          {onList && !searchOn && hidden > 0 && (
            <button type="button" className="tblmore" onClick={() => setExpanded(true)}>
              Раскрыть ещё {hidden}
              <span className="tblmore__rest">всего {found.length}</span>
            </button>
          )}

          {!searchOn && expanded && found.length > PAGE && (
            <button type="button" className="tblmore" onClick={() => setExpanded(false)}>
              Свернуть до {PAGE}
            </button>
          )}

          {/* В обзоре список короткий и ведёт в полный, а не растёт на
              месте: иначе карточки выбора уезжают с экрана. */}
          {!onList && !searchOn && hidden > 0 && (
            <button type="button" className="tblmore" onClick={() => setMode('list')}>
              Показать все {found.length}
            </button>
          )}
      </section>
    </div>
  );
}
