import { useEffect, useMemo, useRef } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Registry, RunRef } from '../data/registry.ts';
import type { RunId } from '../data/load.ts';
import { runCode } from '../data/load.ts';
import { RunCard } from './RunCard.tsx';
import { useModalFocus } from './modal.ts';

interface Props {
  /** Расчёт, который разбирают. Пусто — окна нет. */
  run: RunId | null;
  /** Справочники: карточку собирает база, и здесь она собирается из того же.
      Пока не собрались — окно говорит об этом словами. */
  registry: Registry | null;
  /** Этот расчёт открыт в диспетчерской: открывать его нечего, ему нужна
      дорога к себе. */
  active: RunId | null;
  onClose: () => void;
  onOpen: (id: RunId) => void;
  onOpenMap: (id: RunId) => void;
  onGo: (id: RunId) => void;
  onOpenRoute: (id: RunId, engineerId: string) => void;
  /** Карточка инженера поверх: карточка расчёта знает номер внутри своего
      дня, а справочник различает людей парой «участок — номер», и собрать
      ключ может только тот, кто знает расчёт. */
  onOpenEngineer: (runId: RunId, engineerId: string) => void;
  /** Правка записи: номер, время, заметка. Кнопка стоит в углу карточки —
      той же, что в базе, — и молчать она не должна. */
  onEdit: (run: RunRef) => void;
  /** Уйти в базу расчётов — к остальным записям. */
  onGoRuns: () => void;
}

/* Разбор расчёта — окном поверх экрана.

   Карточка расчёта живёт в базе и в «Сравнении»; сюда она приходит третьим
   местом — с Главной и из разбора смены, где номер расчёта стоит в каждой
   второй строке. Заводить для этого свой вид карточки нельзя: расчёт
   обязан объясняться одинаково, где бы его ни раскрыли, — поэтому внутри
   стоит тот же `RunCard`, что и в базе, со своей картой, числами и
   дорогами к плану.

   Окно закрывается, когда из него уходят в диспетчерскую или на карту:
   экран за ним меняется целиком, и окно поверх нового экрана читалось бы
   как несработавший переход. */
export function RunWindow({
  run,
  registry,
  active,
  onClose,
  onOpen,
  onOpenMap,
  onGo,
  onOpenRoute,
  onOpenEngineer,
  onEdit,
  onGoRuns
}: Props) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(run !== null, card);

  useEffect(() => {
    if (!run) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [run, onClose]);

  const row = useMemo(
    () => (run && registry ? registry.stats.byRun.find((one) => one.run.id === run) ?? null : null),
    [run, registry]
  );
  const routes = useMemo(
    () => (run && registry ? registry.routes.filter((one) => one.run.id === run) : []),
    [run, registry]
  );

  if (!run) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Расчёт ${runCode(run)}`}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card runwin" ref={card}>
        <button type="button" className="shiftwin__close runwin__close" onClick={onClose} title="Закрыть">
          <Icon name="x" size={14} />
        </button>

        {!registry ? (
          <p className="shiftwin__empty">Собираем справочники…</p>
        ) : !row ? (
          /* Записи нет в справочниках: расчёт удалили, пока окно было
             открыто, либо его формы не прочитались. Пустое окно молчало бы
             об этом — говорим словами и даём дорогу в базу. */
          <div className="shiftwin__gone">
            <p className="emptynote__title">Расчёт {runCode(run) || run} не читается</p>
            <span>
              Запись могли удалить, или программа расчёта не отдала её формы. Остальные расчёты на
              месте — они в базе расчётов.
            </span>
            <button type="button" className="runcard__go" onClick={onGoRuns}>
              <Icon name="stack" size={13} />
              Открыть базу расчётов
            </button>
          </div>
        ) : (
          <RunCard
            row={row}
            bounds={registry.bounds}
            routes={routes}
            isActive={row.run.id === active}
            picked={false}
            /* Отбор к сравнению из окна закрыт: набор собирают в базе
               расчётов, где видно, что уже отобрано. */
            showCompare={false}
            showOpen
            onOpen={(id) => {
              onClose();
              onOpen(id);
            }}
            onOpenMap={(id) => {
              onClose();
              onOpenMap(id);
            }}
            onGo={(id) => {
              onClose();
              onGo(id);
            }}
            onCompare={() => undefined}
            onEdit={(one) => {
              onClose();
              onEdit(one);
            }}
            onOpenEngineer={(engineerId) => onOpenEngineer(row.run.id as RunId, engineerId)}
            onOpenRoute={(id, engineerId) => {
              onClose();
              onOpenRoute(id, engineerId);
            }}
          />
        )}
      </div>
    </div>
  );
}
