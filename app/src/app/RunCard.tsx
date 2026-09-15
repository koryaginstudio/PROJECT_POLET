import { Icon } from "../ds/components/core/Icon.jsx";
import type { Bounds, RunStat, RunRef } from "../data/registry.ts";
import type { RunId } from "../data/load.ts";
import { shortStamp, stampOf } from "../data/load.ts";
import { dec, hoursText } from "../data/derive.ts";
import { RunMap } from "./RunMap.tsx";

interface Props {
  row: RunStat;
  /** Общая рамка всех расчётов: город в соседних карточках стоит на одном
      месте, поэтому рамка приходит снаружи, а не считается по карточке. */
  bounds: Bounds;
  /** Этот расчёт открыт в диспетчерской: открывать его нечего, ему нужна
      дорога к себе. */
  isActive: boolean;
  /** Отобран к сравнению. */
  picked: boolean;
  /** Отобрать нельзя — набор уже полон. Кнопка гаснет и объясняет почему. */
  pickBlocked?: boolean;
  /** Строка истории вместо карточки: без карты и с одним числом сверх
      покрытия. */
  dense?: boolean;
  /** Что делает кнопка в углу карточки. В базе расчётов — правку записи:
      номер, время, заметка. В «Сравнении» правке там не место — набор
      пришли разбирать, а не переименовывать, — и та же кнопка убирает
      расчёт из набора. Двух кнопок в углу не заводим: угол один, и рука
      идёт туда за одним и тем же — «убрать это отсюда». */
  headAction?: "edit" | "drop";
  /** Показывать ли кнопку отбора внизу карточки. В «Сравнении» её нет:
      там все карточки отобраны по определению, и кнопка «В сравнении» на
      каждой была бы подписью к очевидному. Снять расчёт оттуда есть чем —
      крестиком в углу. */
  showCompare?: boolean;
  onOpen: (id: RunId) => void;
  onOpenMap: (id: RunId) => void;
  onGo: (id: RunId) => void;
  onCompare: (id: RunId) => void;
  onEdit?: (run: RunRef) => void;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* Карточка расчёта. Живёт отдельно от базы расчётов, потому что показывается
   в двух местах: в самой базе и в «Сравнении», где стоят отобранные. Это одна
   и та же вещь — расчёт с его картой, цифрами и дорогой к плану, — и
   расходиться в двух экранах она не должна: диспетчер узнаёт отобранное по
   тому же виду, по которому его отбирал. */
export function RunCard({
  row,
  bounds,
  isActive,
  picked,
  pickBlocked = false,
  dense = false,
  headAction = "edit",
  showCompare = true,
  onOpen,
  onOpenMap,
  onGo,
  onCompare,
  onEdit,
}: Props) {
  return (
    /* Вся карточка ведёт в диспетчерскую: щелчок по номеру, по цифрам, по
       пустому месту — всё это «покажи мне этот расчёт». Кнопки внутри
       отвечают за себя сами, поэтому щелчок по ним сюда не доходит: карта
       ведёт на карту, «В сравнение» отбирает и никуда не уводит.

       Клавиатуре карточка целиком не нужна — у неё есть та же дорога кнопкой
       «Открыть»; лишняя точка фокуса вокруг всего содержимого только
       удлиняла бы обход табом. */
    <article
      className={"runcard" + (isActive ? " runcard--active" : "")}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (isActive) onGo(row.run.id);
        else onOpen(row.run.id);
      }}
    >
      <div className="runcard__head">
        {/* Номер и метка открытого — одной группой слева.

            Раньше шапка растягивала три вещи по краям, и метка оставалась
            висеть посередине: ни при номере, ни при правке. Читалась она
            из-за этого как отдельная сущность карточки, хотя говорит ровно
            про её номер — вот этот расчёт сейчас открыт.

            От слова «открыт» отказались: метка стоит вплотную к номеру,
            второй такой же в карточке нет, а значок диспетчерской того же
            фирменного цвета, что и кнопка «Перейти» внизу. Слово добавляло
            ширины, а не смысла. */}
        <span className="runcard__ident">
          <span className="runcard__code">{row.run.code}</span>
          {isActive && (
            <span
              className="runcard__open"
              title="Этот расчёт открыт в диспетчерской"
              aria-label="Открыт в диспетчерской"
            >
              <Icon name="gauge" size={12} />
            </span>
          )}
        </span>

        {/* Правка стоит в шапке, у номера и времени, — то есть ровно у того,
            что она правит. В ряду действий внизу она стояла среди «Открыть»
            и «В сравнение», хотя те про расчёт, а она про запись о нём.
            Удаление живёт в том же окне и спрашивает, а не ловит промах
            рядом с «Открыть».

            В «Сравнении» на этом месте крестик: он снимает расчёт с отбора.
            Запись расчёта оттуда не правят, а убрать лишний из набора —
            первое, что там делают, и крестик в углу карточки говорит это
            без слов. Сам расчёт крестик не трогает: он про набор. */}
        {headAction === "drop" ? (
          <button
            type="button"
            className="runcard__edit runcard__edit--drop"
            onClick={() => onCompare(row.run.id)}
            title={`Убрать ${row.run.code} из сравнения`}
            aria-label={`Убрать ${row.run.code} из сравнения`}
          >
            <Icon name="x" size={13} />
          </button>
        ) : (
          <button
            type="button"
            className="runcard__edit"
            onClick={() => onEdit?.(row.run)}
            title={`Изменить запись ${row.run.code}: номер, время, заметка`}
            aria-label={`Изменить запись ${row.run.code}`}
          >
            <Icon name="pencil" size={13} />
          </button>
        )}
      </div>

      {/* Когда расчёт завели — под номером: расчёты отличаются друг от друга
          прежде всего временем, а не цифрами внутри. */}
      <span className="runcard__stamp" title={stampOf(row.run.created)}>
        <Icon name="clock" size={12} />
        {dense ? shortStamp(row.run.created) : stampOf(row.run.created)}
      </span>

      {/* Заметка человека стоит рядом со временем: обе строки — про запись,
          а не про то, что посчитал движок.

          Место под неё держится всегда, даже когда её нет. Иначе карточка с
          заметкой съезжала вниз на строку, и в ряду расходилось всё сразу:
          карты, покрытие, цифры и кнопки вставали на разной высоте, а ряд
          читался как сбой вёрстки. Заметка при этом однострочная — длинную
          показываем целиком по наведению: карточка сравнивает расчёты, а не
          пересказывает, что человек о них написал. */}
      <p
        className="runcard__note"
        title={row.run.note || undefined}
        aria-hidden={!row.run.note}
      >
        {row.run.note}
      </p>

      {!dense && (
        <RunMap
          sketch={row.sketch}
          bounds={bounds}
          label={`Открыть расчёт ${row.run.code} на карте`}
          onOpen={() => onOpenMap(row.run.id)}
        />
      )}

      <span className="runcard__value">
        {dec(row.coverage * 100)}
        <span className="runcard__unit">%</span>
      </span>
      <span className="runcard__label">Покрытие</span>

      {/* В плотной строке остаётся одно число сверх покрытия — то, ради
          которого в историю и заглядывают. */}
      <div className="runcard__facts">
        {dense ? (
          <span
            className={
              "runcard__fact" +
              (row.orders - row.assigned > 0 ? " runcard__fact--bad" : "")
            }
          >
            <b>{row.orders - row.assigned}</b> без инженера
          </span>
        ) : (
          <>
            <span className="runcard__fact">
              <b>{row.assigned}</b> из {row.orders} заявок разложено (
              {percent(row.assignedShare)})
            </span>
            <span
              className={
                "runcard__fact" +
                (row.orders - row.assigned > 0 ? " runcard__fact--bad" : "")
              }
            >
              <b>{row.orders - row.assigned}</b> без инженера
            </span>
            <span className="runcard__fact">
              <b>{row.engineersOnRoute}</b> из {row.engineersTotal} инженеров с
              маршрутом
            </span>
            <span className="runcard__fact">
              <b>{row.visits}</b> визитов · {hoursText(row.travelMinutes)} в дороге
            </span>
          </>
        )}
      </div>

      <div className="runcard__actions">
        {/* У открытого расчёта открывать нечего — ему нужна дорога к себе:
            «Перейти» уводит в диспетчерскую, к плану. */}
        <button
          type="button"
          className={"runcard__go" + (isActive ? " runcard__go--open" : "")}
          onClick={() => (isActive ? onGo(row.run.id) : onOpen(row.run.id))}
          title={isActive ? "Перейти в диспетчерскую" : "Открыть расчёт"}
        >
          <Icon name="arrow-right" size={13} />
          {isActive ? "Перейти" : "Открыть"}
        </button>
        {/* Отбор к сравнению — переключатель: повторный щелчок убирает
            расчёт из набора, а не заводит второй такой же. Когда набор
            полон, кнопка гаснет — но только у неотобранных: снять свой
            расчёт из полного набора нужно уметь всегда, иначе выйти из
            потолка можно будет лишь кнопкой «Снять все». */}
        {showCompare && (
          <button
            type="button"
            className={"runcard__act" + (picked ? " runcard__act--on" : "")}
            onClick={() => onCompare(row.run.id)}
            aria-pressed={picked}
            disabled={pickBlocked && !picked}
            title={
              picked
                ? "Убрать из сравнения"
                : pickBlocked
                  ? "В сравнении уже пять расчётов — больше не влезет"
                  : "Добавить в сравнение"
            }
          >
            <Icon name={picked ? "check" : "shuffle"} size={13} />
            {dense ? null : picked ? "В сравнении" : "В сравнение"}
          </button>
        )}
      </div>
    </article>
  );
}
