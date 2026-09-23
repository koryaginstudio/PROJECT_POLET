import { useState } from "react";
import { Icon } from "../ds/components/core/Icon.jsx";
import type { Bounds, RouteRecord, RunStat, RunRef } from "../data/registry.ts";
import type { RunId } from "../data/load.ts";
import { shortStamp, stampOf } from "../data/load.ts";
import { dec, hoursText } from "../data/derive.ts";
import { RunMap } from "./RunMap.tsx";
import { WhyMark } from "./WhyMark.tsx";
import { service } from "../data/service.ts";
import { DutyButton } from "./DutyButton.tsx";

interface Props {
  row: RunStat;
  /** Общая рамка всех расчётов: город в соседних карточках стоит на одном
      месте, поэтому рамка приходит снаружи, а не считается по карточке. */
  bounds: Bounds;
  /** Маршруты этого расчёта, по порядку номеров. Считает база: карточка видит
      одну строку свода и о маршрутах сама не знает. Пусто — строки «Инженеры»
      и «Маршруты» не рисуются. */
  routes?: RouteRecord[];
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
      там все карточки отобраны по определению, и кнопка «Сравнить» на
      каждой была бы подписью к очевидному. Снять расчёт оттуда есть чем —
      крестиком в углу. */
  showCompare?: boolean;
  /** Показывать ли кнопку «Открыть». В базе расчётов её нет: карточка и так
      открывает расчёт целиком, по щелчку в любое место, и кнопка внизу была
      второй дорогой туда же — самой заметной вещью в карточке ради того, что
      и без неё делается само. В «Сравнении» она остаётся: там щелчок по
      карточке тоже уводит в диспетчерскую, но набор разбирают глазами, и
      выход к плану должен быть назван словом. */
  showOpen?: boolean;
  onOpen: (id: RunId) => void;
  onOpenMap: (id: RunId) => void;
  onGo: (id: RunId) => void;
  onCompare: (id: RunId) => void;
  onEdit?: (run: RunRef) => void;
  /** Открыть профиль инженера из чипа в списке занятых. Нет — чипы не
      нажимаются. */
  onOpenEngineer?: (engineerId: string) => void;
  /** Открыть маршрут на карте расчёта, закрепив его там. Нет — чип
      маршрута ведёт на карту расчёта без закрепления, через `onOpenMap`. */
  onOpenRoute?: (runId: RunId, engineerId: string) => void;
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/* Фамилия из полного имени: в чипе шириной в два слова помещается только она,
   а узнают человека всё равно по ней. Полное имя остаётся в подсказке. */
const surnameOf = (name: string) => name.trim().split(/\s+/)[0] || name;

/* День, за который считали, из ISO-даты выгрузки. */
const dayOf = (date: string) => {
  const [year, month, day] = date.split("-");
  return year && month && day ? `${day}.${month}.${year}` : date;
};

/* Карточка расчёта. Живёт отдельно от базы расчётов, потому что показывается
   в двух местах: в самой базе и в «Сравнении», где стоят отобранные. Это одна
   и та же вещь — расчёт с его картой, цифрами и дорогой к плану, — и
   расходиться в двух экранах она не должна: диспетчер узнаёт отобранное по
   тому же виду, по которому его отбирал.

   Собрана на языке карточки справочника — том же, на котором говорят базы
   инженеров и заявок: метка записи под номером, картинка в середине, три
   главных числа в строку, список «подпись — значение», поля записи и ряды
   чипов внизу. Три базы отвечают на один и тот же вопрос — «что у нас есть
   и каково оно», — и одно и то же место в карточке обязано значить одно и
   то же, в какую бы из них диспетчер ни зашёл.

   Своё здесь только то, чего нет у инженера с заявкой: карта дня вместо лица
   и ряд действий внизу — расчёт единственная запись во всех базах, которую
   можно открыть и с которой можно работать дальше. */
export function RunCard({
  row,
  bounds,
  routes = [],
  isActive,
  picked,
  pickBlocked = false,
  dense = false,
  headAction = "edit",
  showCompare = true,
  showOpen = true,
  onOpen,
  onOpenMap,
  onGo,
  onCompare,
  onEdit,
  onOpenEngineer,
  onOpenRoute,
}: Props) {
  /* Свёрнуты оба списка, пока их не открыли. Развёрнутый список инженеров
     это шесть строк чипов, маршрутов — четыре, и в свёрнутом виде карточка
     вдвое короче: ряд читается охватом, а кто там занят — по запросу, на той
     карточке, о которой спросили. Память о раскрытии живёт в самой карточке:
     это взгляд на одну запись, а не настройка списка. */
  const [crewOpen, setCrewOpen] = useState(false);
  const [routesOpen, setRoutesOpen] = useState(false);

  const loose = row.orders - row.assigned;
  /* Граница «плохо» — та же, что у покрытия в настройках сервиса: два числа
     об одном и том же не должны краснеть по разным правилам. */
  const poor = row.assignedShare * 100 < service().thresholds.coverageBad;
  /* Инженеры, которых расчёт поставил в дело: по одному маршруту на человека,
     поэтому список маршрутов и список занятых людей — одна и та же выборка с
     двух сторон. Вышедшие на смену, но оставшиеся без маршрута, сюда не
     попадают: строка отвечает на «кто работал», а не «кто числился», и
     ответ на второй вопрос стоит цифрой в «Инженерах» выше. */
  const crew = routes.filter(
    (route, index) => routes.findIndex((other) => other.engineerId === route.engineerId) === index,
  );

  return (
    /* Вся карточка ведёт в диспетчерскую: щелчок по номеру, по цифрам, по
       пустому месту — всё это «покажи мне этот расчёт». Кнопки внутри
       отвечают за себя сами, поэтому щелчок по ним сюда не доходит: карта
       ведёт на карту, «В сравнение» отбирает и никуда не уводит.

       Клавиатуре карточка целиком не нужна — у неё есть та же дорога кнопкой
       «Открыть»; лишняя точка фокуса вокруг всего содержимого только
       удлиняла бы обход табом. */
    <article
      className="runcard"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button")) return;
        if (isActive) onGo(row.run.id);
        else onOpen(row.run.id);
      }}
    >
      <div className="runcard__head">
        {/* Только номер. Метки «открыт в диспетчерской» рядом с ним больше
            нет: база отвечает на «что мы считали и с каким результатом», а
            в каком из расчётов диспетчер сейчас стоит — вопрос другого
            экрана, и ответ на него в справочнике помечал одну карточку из
            ряда без всякой пользы для чтения самого ряда. Где он стоит,
            видно в подшапке диспетчерской, где расчёт и выбирают. */}
        <span className="runcard__ident">
          {/* Подпись «id:» перед номером — та же, что у табельного в карточке
              инженера и у номера в карточке заявки. Номер расчёта стоит на
              месте имени, а не на месте табельного, но вещь это та же самая:
              то, чем запись называют и по чему её находят. Раз уж в двух
              базах номер подписан, в третьей он подписан так же. */}
          <span className="runcard__id">
            <span className="engcard__idlabel">id:</span>
            <span className="runcard__code">{row.run.code}</span>
          </span>
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
            className="runcard__edit runcard__edit--word"
            onClick={() => onEdit?.(row.run)}
            title={`Изменить запись ${row.run.code}: номер, время, заметка`}
            aria-label={`Изменить запись ${row.run.code}`}
          >
            {/* В карточке место есть — значок со словом: карандаш без
                подписи читался только по всплывающей подсказке. */}
            <Icon name="pencil" size={14} />
            <span>Изменить</span>
          </button>
        )}
      </div>

      {/* Когда расчёт завели — под номером: то же место, где у инженера
          табельный со сменой, а у заявки номер с окном приёма. Это метка
          записи, а не её итог, и расчёты отличаются друг от друга прежде
          всего временем, а не цифрами внутри.

          Заметка человека стоит тут же, хвостом к времени: обе вещи — про
          запись, а не про то, что посчитал движок. Отдельной строкой она
          жила плохо: заметок у расчётов почти не бывает, а место под неё
          держалось всегда, и между временем и картой зияла пустая строка —
          в каждой карточке базы. Хвостом она не занимает ничего, пока её
          нет, и ряд карточек от неё больше не расходится. Длинная
          обрезается — целиком её показывает подсказка: карточка сравнивает
          расчёты, а не пересказывает, что человек о них написал. */}
      <span className="runcard__stamp" title={stampOf(row.run.created)}>
        <span className="engcard__shift">
          <Icon name="clock" size={12} />
          {dense ? shortStamp(row.run.created) : stampOf(row.run.created)}
        </span>
        {row.run.note && (
          <span className="runcard__note" title={row.run.note}>
            {row.run.note}
          </span>
        )}
      </span>

      {!dense && (
        <RunMap
          sketch={row.sketch}
          bounds={bounds}
          label={`Открыть расчёт ${row.run.code} на карте`}
          onOpen={() => onOpenMap(row.run.id)}
        />
      )}

      {dense ? (
        <>
          <span className="runcard__value">
            {dec(row.coverage * 100)}
            <span className="runcard__unit">%</span>
          </span>
          <span className="runcard__label">Прогноз</span>
        </>
      ) : (
        /* Три числа в строке, как у инженера и у заявки, — но не итоги
           расчёта, а его состав: сколько заявок принесли, сколькими людьми
           их разбирали и какая доля дошла до инженера. Из этих трёх и
           складывается ответ «что это был за расчёт», а как именно он лёг —
           покрытие, визиты, часы — договаривает список ниже.

           Доля последней: первые два числа это условие задачи, третье — её
           итог, и читается строка слева направо как фраза. */
        <div className="engquick">
          <div className="engquick__tile engquick__tile--main">
            <span className="engquick__value">{row.orders}</span>
            <span className="engquick__label">Заявок</span>
          </div>
          <div className="engquick__tile" title="Инженеров, получивших маршрут в этом расчёте">
            <span className="engquick__value">{row.engineersOnRoute}</span>
            <span className="engquick__label">Инженеров</span>
          </div>
          {/* Тревожно красится не всякая недостача, а только та, которую в
              настройках сервиса назвали плохой: расчёт, где два десятка
              заявок из пятидесяти шести остались лежать, и расчёт, где
              осталось две, — разные новости, а по «не сто процентов» они
              неотличимы. Сколько именно осталось, говорит красная строка
              «Без инженера» в списке ниже — там это видно при любой доле. */}
          <div
            className={"engquick__tile" + (poor ? " engquick__tile--bad" : "")}
            title="Доля заявок, которым нашёлся инженер"
          >
            <span className="engquick__value">
              {percent(row.assignedShare)}
            </span>
            <span className="engquick__label">Разложено</span>
          </div>
        </div>
      )}

      {dense ? (
        /* В плотной строке остаётся одно число сверх покрытия — то, ради
           которого в историю и заглядывают. */
        <div className="runcard__facts">
          <span className={"runcard__fact" + (loose > 0 ? " runcard__fact--bad" : "")}>
            <b>{loose}</b> без инженера
          </span>
        </div>
      ) : (
        /* Как расчёт лёг: список «подпись слева, число справа», тот же, что у
           инженера и у заявки. Числа здесь разного рода — штуки, доли, часы, —
           и сплошным текстом взгляд цеплялся то за одно слово, то за другое;
           колонка чисел справа читается охватом сразу. */
        <dl className="engmetrics">
          <div className="engmetrics__row">
            <dt>Разложено</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>
              {row.assigned} из {row.orders}
            </dd>
          </div>
          {/* Место под подпись здесь своё, не третья доля строки, — и заявки
              без инженера названы полным именем, а не «остатком». */}
          <div className={"engmetrics__row" + (loose > 0 ? " engmetrics__row--bad" : "")}>
            <dt>Без инженера</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{loose}</dd>
          </div>
          {/* Прогноз и доля назначенных — не одно и то же: движок назначил,
              а симуляция говорит, сколько из этого доедет. */}
          <div className="engmetrics__row">
            <dt>Прогноз выполнения</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{dec(row.coverage * 100)} %</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Заявок</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.visits}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Маршрутов</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.routes}</dd>
          </div>
          {/* Сколько людей вышло на смену, но маршрута не получило. Наверху
              стоит число занятых, и без этой строки было бы не видно, из
              скольких оно набрано. */}
          <div
            className={
              "engmetrics__row" +
              (row.engineersOnRoute < row.engineersTotal ? " engmetrics__row--bad" : "")
            }
          >
            <dt>Без маршрута</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{row.engineersTotal - row.engineersOnRoute}</dd>
          </div>
          <div className="engmetrics__row">
            <dt>Занятость</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{dec(row.occupancy * 100)} %</dd>
          </div>
          {/* Часы на объектах, а не в дороге: дорога это цена плана, а не его
              содержание, и в карточке справочника она отвечала на вопрос,
              которого здесь не задают. Сколько наездили по всем маршрутам,
              считает плитка свода наверху базы и табличный вид. */}
          <div className="engmetrics__row">
            <dt>Работа</dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{hoursText(row.workMinutes)}</dd>
          </div>
        </dl>
      )}

      {/* Что о расчёте говорит сама запись, а не его итог: на какой день
          построен план. Одного слова «День» здесь не хватало — в карточке
          две даты, и рядом со временем записи она читалась как её повтор,
          хотя это разные вещи: расчёт завели вчера вечером, а план он строил
          на рабочий день выгрузки. Подпись теперь называет это прямо, а
          значок рядом договаривает остальное.

          Набрано тем же списком, что и цифры выше, а не полями выгрузки, как
          у инженера: поле здесь одно, и прижатая влево дата вставала посреди
          карточки — мимо колонки чисел, которая кончается у правого края.
          Одна запись, одна колонка справа. */}
      {!dense && row.run.date && (
        <dl className="engmetrics runcard__plan">
          <div className="engmetrics__row">
            <dt className="runcard__plan-label">
              План на
              <WhyMark text="День, на который расчёт построил маршруты: заявки и смены в нём взяты за этот день. Когда завели саму запись расчёта — в строке со временем под номером, и это другая дата." />
            </dt>
            <span className="engmetrics__leader" aria-hidden="true" />
            <dd>{dayOf(row.run.date)}</dd>
          </div>
        </dl>
      )}

      {/* Кого расчёт поставил в дело. Свёрнуто это одна тихая строка с числом —
          «Инженеры 11», — и в ряду карточек она читается как ещё одна цифра
          свода. Развёрнуто — фамилии чипами, а не полные имена: в чипе
          шириной в два слова помещается только фамилия, и узнают человека по
          ней же. Полное имя и номер его маршрута — в подсказке.

          Чип нажимается и открывает профиль человека: фамилия в списке — это
          ссылка, а не подпись, и искать её руками в базе инженеров — лишний
          ход. Щелчок по чипу до карточки не доходит: иначе открывался бы ещё
          и расчёт. */}
      {!dense && crew.length > 0 && (
        <div className="runcard__list">
          <button
            type="button"
            className="runcard__toggle"
            aria-expanded={crewOpen}
            onClick={() => setCrewOpen((open) => !open)}
            title={crewOpen ? "Свернуть список инженеров" : "Показать, кто занят в расчёте"}
          >
            Инженеры
            <span className="runcard__count">{crew.length}</span>
            <Icon name={crewOpen ? "chevron-up" : "chevron-down"} size={12} />
          </button>
          {crewOpen && (
            <div className="runcard__chips">
              {crew.map((route) =>
                onOpenEngineer ? (
                  <button
                    key={route.engineerId}
                    type="button"
                    className="chip chip--sm"
                    title={`${route.engineerName} — маршрут ${route.code}. Открыть профиль`}
                    onClick={() => onOpenEngineer(route.engineerId)}
                  >
                    {surnameOf(route.engineerName)}
                  </button>
                ) : (
                  <span
                    key={route.engineerId}
                    className="chip chip--sm"
                    title={`${route.engineerName} — маршрут ${route.code}`}
                  >
                    {surnameOf(route.engineerName)}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {/* Маршруты расчёта своими номерами: они сквозные на всю базу, и по
          номеру маршрут находят в базе маршрутов. Строка идёт второй, под
          инженерами: маршрут без человека не бывает, и порядок «кто — что»
          читается естественнее обратного.

          Чип ведёт на карту расчёта с закреплённым на ней маршрутом — туда
          же, куда ведёт карточка маршрута в его базе: своего экрана у
          маршрута нет, и смотрят его целиком на карте дня. */}
      {!dense && routes.length > 0 && (
        <div className="runcard__list">
          <button
            type="button"
            className="runcard__toggle"
            aria-expanded={routesOpen}
            onClick={() => setRoutesOpen((open) => !open)}
            title={routesOpen ? "Свернуть список маршрутов" : "Показать номера маршрутов расчёта"}
          >
            Маршруты
            <span className="runcard__count">{routes.length}</span>
            <Icon name={routesOpen ? "chevron-up" : "chevron-down"} size={12} />
          </button>
          {routesOpen && (
            <div className="runcard__chips">
              {routes.map((route) => (
                <button
                  key={route.key}
                  type="button"
                  className="chip chip--sm"
                  title={`${route.code} — ${route.engineerName}, ${route.visits} заявок. Показать на карте расчёта`}
                  onClick={() =>
                    onOpenRoute ? onOpenRoute(row.run.id, route.engineerId) : onOpenMap(row.run.id)
                  }
                >
                  {route.code}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Распорка добирает свободную высоту карточки: цифр и чипов над ней у
          соседних расчётов разное количество, а ряд действий обязан стоять на
          одной линии у всех карточек ряда. */}
      <span className="runcard__fill" aria-hidden="true" />

      {(showOpen || showCompare) && (
        /* Кнопки в карточке справочника короткие и стоят у левого края. Во всю
           ширину ходила пара «Открыть» и «В сравнение», когда обе были
           главными делами карточки; теперь главное дело — сам расчёт, а это
           служебные пометки на нём, и размер у них служебный. Не влезли в
           строку — переносятся, а не сжимаются до значков. */
        <div className="runcard__actions runcard__actions--solo">
          {/* У открытого расчёта открывать нечего — ему нужна дорога к себе:
              «Перейти» уводит в диспетчерскую, к плану. */}
          {showOpen && (
            <button
              type="button"
              className={"runcard__go" + (isActive ? " runcard__go--open" : "")}
              onClick={() => (isActive ? onGo(row.run.id) : onOpen(row.run.id))}
              title={isActive ? "Перейти в диспетчерскую" : "Открыть расчёт"}
            >
              <Icon name="arrow-right" size={13} />
              {isActive ? "Перейти" : "Открыть"}
            </button>
          )}
          {/* Отбор к сравнению — переключатель: повторный щелчок убирает
              расчёт из набора, а не заводит второй такой же. Подпись одна на
              оба состояния: слово называет, что кнопка делает, а отобран
              расчёт или нет, говорят галочка и светлая заливка. Когда набор
              полон, кнопка гаснет — но только у неотобранных: снять свой
              расчёт из полного набора нужно уметь всегда, иначе выйти из
              потолка можно будет лишь кнопкой «Снять все». */}
          {/* Взять расчёт в работу: с этой минуты день принадлежит ему, а
              прочие прогоны того же дня остаются черновиками. Кнопка стоит
              первой — это решение о расчёте, а отбор к сравнению рядом с ней
              всего лишь способ его рассмотреть.

              Фирменный оранжевый в этой системе значит «вот этот, с ним
              сейчас работают», и взятый расчёт красится им: другого такого же
              в ряду не будет — день у расчёта один, и хозяин у дня один. */}
          {/* Вопрос перед снятием с работы и перехватом дня — тот же, что в
              подшапке плана: одно действие ведёт себя одинаково везде. */}
          {showCompare && <DutyButton run={row.run.id} date={row.run.date} place="card" />}
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
              Сравнить
            </button>
          )}
        </div>
      )}
    </article>
  );
}
