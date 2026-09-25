import { useMemo } from 'react';
import type { Day } from '../data/contract.ts';
import type { DayView } from '../data/derive.ts';
import type { Selection } from '../app/selection.ts';
import {
  buildCrewBoard,
  buildDistribution,
  buildFunnel,
  buildOrdersBoard,
  crewStatus,
  ordersStatus,
  hhmm,
  replanAt,
  orders as pluralOrders,
  engineers as pluralEngineers
} from '../data/derive.ts';
import { Donut } from '../app/Donut.tsx';
import { BarChart } from '../app/BarChart.tsx';
import { skillName } from '../data/dictionary.ts';
import type { BoardValue } from '../data/derive.ts';
import { Icon } from '../ds/components/core/Icon.jsx';
import { skillIcon, workTypeIcon } from '../data/dictionary.ts';
import { FunnelBoard } from '../app/FunnelBoard.tsx';
import { CalcBoard } from '../app/CalcBoard.tsx';
import { BaselineCompare } from '../app/BaselineCompare.tsx';
import { GanttBoard } from '../app/GanttBoard.tsx';
import { KanbanBoard } from '../app/KanbanBoard.tsx';
import { MapBoard } from '../app/MapBoard.tsx';

interface Props {
  day: Day;
  view: DayView;
  /** Вкладка подшапки: сводка или гант. */
  mode: string;
  /** Номер открытого расчёта движка. */
  /** Расчёт, чей план на карте: по нему у маршрутов их собственные номера. */
  runId: string;
  run: string;
  /** Выбранная заявка: канбан подсвечивает её карточку. */
  selectedOrder: string | null;
  /** Час, на который навели в правой панели ганта: он подсвечен на ленте. */
  hotHour: number | null;
  /** Подсветка маршрута на карте — общая со списком в правой панели. */
  live: string | null;
  onLive: (engineerId: string | null) => void;
  /** Выбранный маршрут: пока он выбран, остальные на карте не нажимаются. */
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  /** Показать маршрут, не переключая: щелчок по заявке оставляет её путь на
      карте, сколько бы раз по заявкам этого пути ни щёлкали. */
  onShowRoute: (engineerId: string | null) => void;
  focus: number;
  cut: number;
  onCutChange: (cut: number | ((prev: number) => number)) => void;
  onSelectOrder: (id: string | null) => void;
  onSelectEngineer: (id: string) => void;
  onOpenGroup: (groupId: string) => void;
  /** Открывает в правой панели список — снимок набора на момент щелчка. */
  onOpenList: (selection: Selection) => void;
  /** Выгружает расчёт книгой Excel. */
  onExport: () => void;
  /** Открывает ручное управление переменными этого расчёта. */
  onManual: () => void;
  /** Закрывает расчёт: диспетчерская возвращается к выбору действия. */
  onClose: () => void;
  /** Открывает окно правки: ЧП и пересчёт остатка дня. */
  onEdit: () => void;
  /** Запущен ли движок: без него правка по событию недоступна, и пульт
      гасит кнопку сам. */
  engineLive: boolean;
  /** Несохранённый пересчёт, показанный на экране. */
  draft: { at: number; gain: number; what: string } | null;
  saving: boolean;
  saveFailed: { text: string; detail: string } | null;
  onSave: () => void;
  onDropDraft: () => void;
}

function BoardSquare({
  value,
  onOpen
}: {
  value: BoardValue;
  onOpen: (groupKey: string) => void;
}) {
  const interactive = Boolean(value.groupKey);
  const cls = 'bsq bsq--' + value.tone;
  const inner = (
    <>
      <span className="bsq__top">
        <span className="bsq__icon">
          <Icon name={value.icon} size={18} />
        </span>
        {interactive && (
          <span className="bsq__chev">
            <Icon name="chevron-right" size={14} />
          </span>
        )}
      </span>
      <span className="bsq__value">{value.value}</span>
      <span className="bsq__label">{value.label}</span>
    </>
  );
  if (!interactive) return <div className={cls}>{inner}</div>;
  return (
    <button type="button" className={cls} onClick={() => onOpen(value.groupKey!)}>
      {inner}
    </button>
  );
}

/* Разбивка по классам — строкой, а не плиткой.

   Плитками сетка раскладывала их по три в ряд и растягивала остаток на всю
   ширину: «Диагностика» и «Работы на линии» выходили вдвое шире соседей
   сверху, хотя стоят за ними числа меньше. Форма спорила с содержанием.

   Строки все одной ширины, а числа выстроены в столбец — сравнивать их
   можно и без полосы под каждым. */
function ClassRow({
  label,
  count,
  icon,
  onOpen
}: {
  label: string;
  count: number;
  icon: string;
  onOpen: () => void;
}) {
  return (
    <button type="button" className="crow" onClick={onOpen}>
      <span className="crow__icon">
        <Icon name={icon} size={14} />
      </span>
      <span className="crow__label">{label}</span>
      <span className="crow__value">{count}</span>
    </button>
  );
}

export function DashboardScreen({
  day,
  view,
  runId,
  mode,
  run,
  selectedOrder,
  hotHour,
  live,
  onLive,
  pinned,
  onPin,
  onShowRoute,
  focus,
  cut,
  onCutChange,
  onSelectOrder,
  onSelectEngineer,
  onOpenGroup,
  onOpenList,
  onExport,
  onManual,
  onClose,
  onEdit,
  engineLive,
  draft,
  saving,
  saveFailed,
  onSave,
  onDropDraft
}: Props) {
  const funnel = useMemo(
    () =>
      buildFunnel(
        day.plan.meta.orders_total,
        view.stopByOrder,
        view.unassigned,
        view.deferrable,
        view.fragile.map((f) => f.order.id),
        cut,
        (placement) => view.orderById.get(placement.stop.order_id)?.sla_deadline ?? null,
        view.hardEnd,
        view.reported
      ),
    [day, view, cut]
  );

  const ordersBoard = useMemo(() => buildOrdersBoard(view, cut), [view, cut]);
  const crewBoard = useMemo(() => buildCrewBoard(view), [view]);

  /* Виды работ и навыки строим одним и тем же способом: у заявки вид сегодня
     один, у инженера навыков бывает три — механика пересечений нужна обеим. */
  const typeTitle = useMemo(
    () => new Map(view.workTypes.map((type) => [type.key, type.title])),
    [view]
  );
  const byType = useMemo(
    () =>
      buildDistribution(
        [...view.orderById.values()],
        (order) => order.id,
        (order) => [order.work_type],
        (key) => typeTitle.get(key) ?? key
      ),
    [view, typeTitle]
  );
  const orderSplit = useMemo(() => ordersStatus(view), [view]);
  const crewSplit = useMemo(() => crewStatus(view), [view]);
  const bySkill = useMemo(
    () =>
      buildDistribution(
        view.loads.map((load) => load.engineer),
        (engineer) => engineer.id,
        (engineer) => engineer.skills,
        skillName
      ),
    [view]
  );

  return (
    <div className="dash enter">
      <CalcBoard
        run={run}
        metrics={view.metrics}
        onOpenGroup={onOpenGroup}
        onExport={onExport}
        onManual={onManual}
        onEdit={onEdit}
        engineLive={engineLive}
        draft={draft}
        restFrom={replanAt(day.plan)}
        saving={saving}
        saveFailed={saveFailed}
        onSave={onSave}
        onDropDraft={onDropDraft}
        onClose={onClose}
      />

      {/* Гант — тот же день, но по времени: пульт расчёта остаётся общим для
          обеих вкладок, а под ним меняется способ смотреть. */}
      {mode === 'kanban' ? (
        <KanbanBoard
          view={view}
          cut={cut}
          onCutChange={onCutChange}
          selected={selectedOrder}
          onSelectOrder={onSelectOrder}
          onSelectEngineer={onSelectEngineer}
        />
      ) : mode === 'map' ? (
        <section className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">Карта дня</h2>
          </div>
          <MapBoard
            view={view}
            runId={runId}
            selectedOrder={selectedOrder}
            live={live}
            onLive={onLive}
            pinned={pinned}
            onPin={onPin}
            focus={focus}
            /* Щелчок по точке оставляет на карте её маршрут — тот же ответ,
               что и в обзоре: спросили про заявку, показываем, на чей путь
               она легла. Показываем, а не переключаем: повторный щелчок по
               той же заявке ничего не меняет, а соседняя заявка того же
               пути его не снимает. */
            onSelectOrder={(id) => {
              onSelectOrder(id);
              onShowRoute(id ? (view.stopByOrder.get(id)?.engineerId ?? null) : null);
            }}
            onSelectEngineer={onSelectEngineer}
          />
        </section>
      ) : mode === 'timeline' ? (
        <GanttBoard
          view={view}
          hotHour={hotHour}
          onSelectOrder={onSelectOrder}
          onSelectEngineer={onSelectEngineer}
        />
      ) : (
        <>
      {/* Только у плана дня целиком: у пересчёта остатка своего базового
          варианта нет, движок его считает лишь на весь день. */}
      {replanAt(day.plan) === null && <BaselineCompare day={day} />}

      <FunnelBoard
        funnel={funnel}
        onCutChange={onCutChange}
        onPickStage={(stage) =>
          onOpenList({
            kind: 'list',
            of: 'orders',
            eyebrow: 'Этап смены',
            title: stage.label,
            note: `${stage.orderIds.length} заявок на этом этапе в момент ${hhmm(cut)}.`,
            ids: stage.orderIds
          })
        }
        problems={ordersBoard.problemIds.length}
        onOpenProblems={() => onOpenGroup('problems')}
      />

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Заявки</h2>
        </div>

        <div className="charts">
          <Donut
            title="Статус заявок"
            centerValue={day.plan.meta.orders_total}
            centerCaption="Всего"
            slices={orderSplit}
            onPick={(slice) =>
              onOpenList({
                kind: 'list',
                of: 'orders',
                eyebrow: 'Статус заявок',
                title: slice.label,
                note: `${slice.ids.length} заявок с этим статусом.`,
                ids: slice.ids
              })
            }
          />

          <BarChart
            title="Заявки по видам работ"
            distribution={byType}
            unit={pluralOrders}
            onPick={(category) =>
              onOpenList({
                kind: 'list',
                of: 'orders',
                eyebrow: 'Вид работ',
                title: category.label,
                note: `${category.ids.length} заявок этого вида в смене.`,
                ids: category.ids
              })
            }
          />
        </div>

        <div className="dash__subhead">По статусу</div>
        <div className="board">
          {ordersBoard.values.map((value) => (
            <BoardSquare key={value.key} value={value} onOpen={onOpenGroup} />
          ))}
        </div>

        <div className="dash__subhead">По видам работ</div>
        <div className="crows">
          {ordersBoard.byType.map((type) => (
            <ClassRow
              key={type.key}
              label={type.title}
              count={type.count}
              icon={workTypeIcon(type.key)}
              onOpen={() => onOpenGroup('type:' + type.key)}
            />
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Инженеры</h2>
        </div>

        <div className="charts">
          <Donut
            title="Статус инженеров"
            centerValue={view.loads.length}
            centerCaption="Всего"
            slices={crewSplit}
            onPick={(slice) =>
              onOpenList({
                kind: 'list',
                of: 'engineers',
                eyebrow: 'Статус инженеров',
                title: slice.label,
                note: `${slice.ids.length} инженеров с этим статусом.`,
                ids: slice.ids
              })
            }
          />

          <BarChart
            title="Инженеры по навыкам"
            distribution={bySkill}
            unit={pluralEngineers}
            onPick={(category) =>
              onOpenList({
                kind: 'list',
                of: 'engineers',
                eyebrow: 'Навык',
                title: category.label,
                note: `${category.ids.length} инженеров владеют этим навыком.`,
                ids: category.ids
              })
            }
          />
        </div>

        <div className="dash__subhead">По статусу</div>
        <div className="board">
          {crewBoard.values.map((value) => (
            <BoardSquare key={value.key} value={value} onOpen={onOpenGroup} />
          ))}
        </div>

        <div className="dash__subhead">По навыкам</div>
        <div className="crows">
          {crewBoard.bySkill.map((skill) => (
            <ClassRow
              key={skill.key}
              label={skill.label}
              count={skill.count}
              icon={skillIcon(skill.key)}
              onOpen={() => onOpenGroup('skill:' + skill.key)}
            />
          ))}
        </div>
      </section>
        </>
      )}
    </div>
  );
}
