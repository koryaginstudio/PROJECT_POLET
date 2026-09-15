import type { DayView } from '../data/derive.ts';
import { MapBoard } from '../app/MapBoard.tsx';

interface Props {
  view: DayView;
  /** Подсвеченный маршрут — общий со списком в правой панели. */
  live: string | null;
  onLive: (engineerId: string | null) => void;
  /** Выбранный маршрут: пока он выбран, остальные на карте не нажимаются. */
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  focus: number;
  onSelectOrder: (id: string) => void;
  onSelectEngineer: (id: string) => void;
}

/* Раздел «Карта»: тот же расчёт, но в пространстве. Отвечает на вопрос,
   которого нет ни в этапах, ни на ганте, — где именно стоят заявки, которые
   некому взять, и как далеко к ним ехать. */
export function MapScreen({
  view,
  live,
  onLive,
  pinned,
  onPin,
  focus,
  onSelectOrder,
  onSelectEngineer
}: Props) {
  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Карта дня</h2>
        </div>
        <MapBoard
          view={view}
          live={live}
          onLive={onLive}
          pinned={pinned}
          onPin={onPin}
          focus={focus}
          onSelectOrder={onSelectOrder}
          onSelectEngineer={onSelectEngineer}
        />
      </section>
    </div>
  );
}
