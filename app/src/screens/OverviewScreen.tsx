import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Day } from '../data/contract.ts';
import type { DayView, Metric } from '../data/derive.ts';
import { hhmm } from '../data/derive.ts';
import type { Registry } from '../data/registry.ts';
import { engineerKey } from '../data/registry.ts';
import { editCrew, removeCrew } from '../data/crew.ts';
import { engineReady, loadPlaces } from '../data/load.ts';
import type { Place } from '../data/load.ts';
import { MapBoard } from '../app/MapBoard.tsx';
import { MapWindow } from '../app/MapWindow.tsx';
import { MapPick } from '../app/MapPick.tsx';
import { MetricTile } from '../app/CalcBoard.tsx';
import { CREW_ENGINE_LOCK, CrewProfile } from '../app/CrewProfile.tsx';
import { OrderProfile } from '../app/OrderProfile.tsx';
import type { Selection } from '../app/selection.ts';

interface Props {
  view: DayView;
  /** План расчёта целиком: из него окно числа собирает свой разбор — тот же,
      что показывает сводка. */
  day: Day;
  /** Номер открытого расчёта: R0001 и дальше. */
  /** Расчёт, чей план на карте: по нему у маршрутов их собственные номера. */
  runId: string;
  run: string;
  /** День программы расчёта у открытого плана («восток»). Пусто у расчёта
      браузера. Нужен точному ключу инженера в справочнике. */
  planDay?: string;
  /** Подсвеченный маршрут — общий с картой и списками. */
  live: string | null;
  onLive: (engineerId: string | null) => void;
  /** Выбранный маршрут: пока он выбран, остальные на карте не нажимаются. */
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  /** Показать маршрут, не переключая его. Щелчок по заявке оставляет на карте
      её путь: сколько бы раз по заявкам этого пути ни щёлкали, он остаётся.
      Переключатель здесь снимал бы маршрут на втором же щелчке. */
  onShowRoute: (engineerId: string | null) => void;
  focus: number;
  /** Выбранная заявка: карта обводит её точку. */
  selectedOrder: string | null;
  /** Щелчок по точке заявки. Обзор на него отвечает сводкой в правой
      колонке — на месте итогов расчёта; `null` закрывает её. */
  onSelectOrder: (id: string | null) => void;
  /** Уйти в сводку целиком — из окна числа, где разбор показан кратко. */
  onOpenMetric: (group: string) => void;
  /** Уйти в сводку целиком. */
  onOpenSummary: () => void;
  /** Несохранённый пересчёт: на карте показан он, а не то, что в архиве. */
  draft: { at: number; gain: number; what: string } | null;
  /** Момент, с которого пересобран остаток дня, если открыт сохранённый
      пересчёт; `null` — план дня целиком. */
  restFrom?: number | null;
  /** Справочники: из них берутся карточки инженера и заявки, которые
      открываются поверх карты. Пока не загрузились — подписи в сводке не
      нажимаются. */
  registry: Registry | null;
  /** Уйти в расчёт заявки и показать его на карте — из карточки справочника,
      теми же дорогами, что и из самих баз. */
  onOpenRun: (id: string) => void;
  onOpenMap: (id: string) => void;
  /** «Отследить» из карточки инженера. */
  onTrack: (id: string) => string | void;
  /** Правка штата из карточки: история и справочники пересобираются. */
  onChanged: () => void;
}

/* Обзор расчёта — то, чем диспетчерская встречает.

   Раньше открытый расчёт встречал сводкой: столбцом колец, квадратов и
   перечней. Всё это про день правду говорит, но отвечает на второй вопрос,
   а не на первый. Первый — «что вообще получилось»: куда движок развёл
   людей, где город густой, а где пусто, сошлись ли маршруты в одну кучу.
   На него отвечает карта, и отвечает мгновенно, до всякого чтения чисел.

   Поэтому карта здесь не блок на странице, а сам экран: она занимает оба
   поля, среднее и правое, от края до края. Итоги расчёта лежат колонкой
   поверх её правого края — те же пять чисел, что и на пульте сводки, и в
   том же виде. Они не спорят с картой за место: карта под ними цела, а
   колонку можно сложить и смотреть день целиком.

   Разбор остался там, где был. Сводка по-прежнему раскладывает день по
   кольцам и квадратам, «Карта» — по маршрутам со списком справа, и каждое
   число отсюда ведёт в свой разбор. Обзор ничего из этого не заменяет: он
   только стоит перед ними. */
export function OverviewScreen({
  view,
  day,
  runId,
  run,
  live,
  onLive,
  pinned,
  onPin,
  onShowRoute,
  focus,
  selectedOrder,
  onSelectOrder,
  onOpenMetric,
  onOpenSummary,
  draft,
  restFrom = null,
  registry,
  onOpenRun,
  onOpenMap,
  onTrack,
  onChanged,
  planDay
}: Props) {
  /* Колонку складывают, когда карта важнее чисел: под ней город, и
     разглядывать его сквозь неё нельзя. Сложенная, она оставляет от себя
     кнопку в том же углу — вернуть числа одним нажатием. */
  const [folded, setFolded] = useState(false);

  /* Что раскрыто окном поверх карты: число расчёта, заявка или инженер.
     Пусто — окна нет. */
  const [win, setWin] = useState<Selection | null>(null);

  /* Кого показывает сводка, когда нажали на общее гнездо выезда. */
  const [nest, setNest] = useState<string[] | null>(null);

  /* Место у полосы итогов постоянное, перетащить её нельзя.

     Перетаскивание было заведено, когда полоса стояла колонкой посреди
     карты и у каждого своё место, где она не мешает. Теперь она лежит
     внизу слева, вровень с краем карты, в углу, который ничем другим не
     занят, — двигать её оттуда некуда, а сохранённый сдвиг только уводил
     ответ на щелчок туда, где его не ждут. Заодно ушла и морока с
     границами: полоса не может уехать за край, потому что никуда не
     едет. */

  /* Карточка справочника поверх карты: чью открыли и какую. Открывается из
     сводки — по имени инженера или по номеру заявки. */
  const [card, setCard] = useState<{ kind: 'engineer' | 'order'; id: string } | null>(null);

  /* Участки нужны карточке инженера: из них выбирают при правке. Грузятся
     один раз и живут до ухода с экрана. */
  const [places, setPlaces] = useState<Place[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadPlaces()
      .then((list) => !cancelled && setPlaces(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* Карта знает инженера по номеру в плане, справочник — по своему ключу:
     у движка E00 есть на каждом участке, и это разные люди. Сначала — точный
     ключ по дню открытого плана: он находит человека, даже если расчёт
     заведён после сборки справочника. Потом — тот, кто с этим номером
     работал в открытом расчёте, и уж потом — ключ как есть. */
  const crewCard =
    card?.kind === 'engineer'
      ? (registry?.engineers.find((one) => one.id === engineerKey(planDay, card.id)) ??
        registry?.engineers.find(
          (one) => one.code === card.id && one.byRun.some((shift) => shift.code === run)
        ) ??
        registry?.engineers.find((one) => one.id === card.id) ??
        null)
      : null;
  /* Заявка ищется в своём расчёте: номера в расчётах повторяются, и без
     номера расчёта открылась бы чужая запись. */
  const orderCard =
    card?.kind === 'order'
      ? (registry?.orders.find((one) => one.id === card.id && one.run.code === run) ?? null)
      : null;

  /* Выбрали маршрут или заявку — колонка отвечает о них, а не о дне. */
  const picked = Boolean(pinned || selectedOrder || nest);

  /* Числа в полосе поверх карты — не весь пульт расчёта, а его начало.

     Полоса лежит на городе и платит за каждое число его куском, поэтому
     порядок в ней свой. Первыми тремя идёт то, с чего читают день: сколько
     заявок получили инженера, сколько их всего и сколько человек их везёт.
     За чертой — числа разбора: прогноз, хвост без инженера, простой и
     перекос нагрузки; они отвечают на «почему так», а не на «что вышло».

     Пробега здесь нет вовсе: километры дня разбирают в сводке, где рядом
     стоит базовый вариант, — в полосе это число ни с чем не сравнить. */
  const barLead = useMemo(() => {
    const by = new Map(view.metrics.map((metric) => [metric.key, metric]));
    return ['assigned', 'orders', 'engineers']
      .map((key) => by.get(key))
      .filter((metric): metric is Metric => Boolean(metric));
  }, [view]);

  const barRest = useMemo(
    () => view.metrics.filter((metric) => !['assigned', 'orders', 'engineers'].includes(metric.key)),
    [view]
  );

  const stats = folded ? (
    /* Сложенная колонка молчит обо всём, кроме одного: пока пересчёт не
       сохранён, на карте показан он, а не то, что лежит в архиве. Прятать
       это вместе с числами нельзя — складывают колонку как раз затем, чтобы
       подольше смотреть на город, и всё это время план был бы помечен
       ничем. Поэтому с несохранённым пересчётом таблетка меняет цвет и
       значок: она перестаёт быть кнопкой «вернуть числа» и становится
       отметкой «то, что видно, ещё не записано». */
    <button
      type="button"
      className={'mapstat__unfold' + (draft ? ' mapstat__unfold--draft' : '')}
      onClick={() => setFolded(false)}
      title={
        draft
          ? `Пересчёт не сохранён: на карте остаток дня от ${hhmm(draft.at)}. Вернуть итоги расчёта`
          : 'Вернуть итоги расчёта'
      }
    >
      {/* Значок тот же, что у раздела «Расчёты» в меню: свёрнутая плашка
          называет расчёт, а не статистику и не сравнение. */}
      <Icon name={draft ? 'alert-triangle' : 'stack'} size={14} />
      {draft ? 'Пересчёт не сохранён' : run}
    </button>
  ) : (
    <section className="mapstat" aria-label="Итоги расчёта">
      <div className="mapstat__head">
        <span className="mapstat__run" title="Открытый расчёт">
          {run}
        </span>
        <span className="mapstat__note">Итоги расчёта</span>
        <button
          type="button"
          className="mapstat__fold"
          onClick={() => setFolded(true)}
          title="Свернуть итоги и открыть карту целиком"
          aria-label="Свернуть итоги"
        >
          <Icon name="chevron-down" size={14} />
        </button>
      </div>

      {/* Полоса несохранённого. На карте показан пересчёт, а не то, что
          лежит в архиве, — молчать об этом нельзя и здесь. Сохраняют его в
          сводке, где стоит пульт со всеми действиями расчёта. */}
      {draft && (
        <button type="button" className="mapstat__draft" onClick={onOpenSummary}>
          <Icon name="alert-triangle" size={14} />
          <span>
            <b>Пересчёт не сохранён.</b> На карте остаток дня от {hhmm(draft.at)}. Сохранить — в
            сводке.
          </span>
        </button>
      )}

      {/* Сохранённый пересчёт. Пояснения под плитками в этой колонке
          скрыты ради места, и без этой строки числа остатка дня читались бы
          итогом дня. */}
      {!draft && restFrom !== null && (
        <p className="mapstat__replan">
          <Icon name="info" size={14} />
          <span>Пересчёт: числа за остаток дня с {hhmm(restFrom)}</span>
        </p>
      )}

      {/* Число раскрывается окном поверх карты, а не уводит в сводку.

          Прежде щелчок по плитке уносил в соседнюю вкладку: карта, на
          которую смотрели, исчезала, и возвращаться к ней приходилось
          руками — при том что спрашивают о числе, не отрываясь от города.
          Окно отвечает на месте: тот же разбор, что в сводке, а под ним
          дорога в саму сводку, если разбора мало. */}
      <div className="mapstat__metrics">
        {barLead.map((metric) => (
          <MetricTile
            key={metric.key}
            metric={metric}
            onOpen={() => setWin({ kind: 'group', id: metric.group })}
          />
        ))}
        {/* Черта между итогом дня и его разбором. Тихая: она делит ряд, а не
            объявляет новый раздел. */}
        <span className="mapstat__split" aria-hidden="true" />
        {barRest.map((metric) => (
          <MetricTile
            key={metric.key}
            metric={metric}
            onOpen={() => setWin({ kind: 'group', id: metric.group })}
          />
        ))}
      </div>
    </section>
  );

  /* Сводка выбранного стоит на месте итогов: две колонки поверх одной карты
     не помещаются, а спрашивают всегда об одном — либо про день, либо про то,
     на что нажали.

     Свёрнутые итоги на неё не влияют. Прежде влияли — и это была ловушка:
     свернув числа, диспетчер выбирал маршрут и получал карту без единой
     подписи о нём, а снять выбор было нечем — крестик живёт в самой этой
     сводке. Складывают итоги расчёта, а не ответ на щелчок; закрыв сводку
     выбранного, человек возвращается к тому, что свернул. */
  const asideBody =
    picked ? (
      <MapPick
        view={view}
        runId={runId}
        pinned={pinned}
        selectedOrder={selectedOrder}
        nest={nest}
        onPickRoute={(id) => {
          setNest(null);
          onLive(null);
          onPin(id);
        }}
        onHoverRoute={onLive}
        onClose={() => {
          onSelectOrder(null);
          setNest(null);
          onPin(null);
        }}
        onOpenEngineer={(id) => registry && setCard({ kind: 'engineer', id })}
        onOpenOrder={(id) => registry && setCard({ kind: 'order', id })}
        /* «Почему этот исполнитель» раскрывается окном поверх карты: там
           у заявки стоят кандидаты и объяснение движка. Прежде этот вопрос
           уводил в сводку — вместе с ним пропадала и карта. */
        onExplain={() => selectedOrder && setWin({ kind: 'order', id: selectedOrder })}
      />
    ) : (
      stats
    );

  /* Обёртка задаёт угол, от которого считается место полосы и карточек. */
  const aside = (
    <div
      /* Итоги расчёта лежат полосой внизу, а всё открытое — инженер,
         маршрут, заявка, общий выезд — встаёт в правый верхний угол.

         Так распорядился заказчик, и довод у этого простой: внизу слева
         тесно. Там полоса итогов, над нею столбик масштаба и пульт карты, и
         высокая карточка, поставленная туда же, непременно на что-нибудь
         наезжает. В правом верхнем углу под нею только город.

         Перетаскивание на карточку не распространяется: таскают полосу
         итогов, её угол и запоминается. Карточка выбранного живёт коротко и
         обязана вставать в одно и то же место — иначе ответ на щелчок
         каждый раз появляется там, где его не ждут. */
      className={'mapdrag' + (picked ? ' mapdrag--pick' : '')}
    >
      {asideBody}
    </div>
  );

  return (
    <div className="mapview enter">
      <MapBoard
        view={view}
        runId={runId}
        selectedOrder={selectedOrder}
        live={live}
        onLive={onLive}
        pinned={pinned}
        /* Выбрали маршрут — прежняя заявка снимается: сводка отвечает о том,
           на что нажали последним. Иначе щелчок по пути оставлял на месте
           открытую точку, и казалось, что он не сработал. */
        onPin={(id) => {
          if (id) {
            onSelectOrder(null);
            setNest(null);
          }
          onPin(id);
        }}
        focus={focus}
        /* Выбрали заявку — на карте остаётся её маршрут, остальные гаснут.

           Прежде щелчок по точке только обводил её: одиннадцать чужих путей
           оставались в полную силу, и разглядеть среди них тот, на который
           заявка легла, было нельзя. Теперь точка ведёт себя как её маршрут:
           показан он один. Сводка справа при этом отвечает о заявке —
           спрашивали про точку, а не про путь. */
        onSelectOrder={(id) => {
          setNest(null);
          onSelectOrder(id);
          /* Показываем, а не переключаем: повторный щелчок по той же заявке
             не должен снимать её маршрут с карты, а соседняя заявка того же
             пути — тем более. Пустое место снимает выбор само. */
          onShowRoute(id ? (view.stopByOrder.get(id)?.engineerId ?? null) : null);
        }}
        /* Щелчок по месту выезда открывает карточку инженера поверх карты,
           а не уводит в сводку: в этом виде экран не покидают. */
        onSelectEngineer={(id) => registry && setCard({ kind: 'engineer', id })}
        onSelectNest={setNest}
        nest={nest}
        fill
        aside={aside}
      />

      {/* Карточки справочника поверх карты — те же, что открываются в базах.
          Приносим разбор к месту, где о нём спросили, вместо того чтобы
          уводить с карты в другой раздел. */}
      <CrewProfile
        crew={crewCard}
        registry={registry!}
        places={places}
        onClose={() => setCard(null)}
        onOpenRun={(id) => {
          setCard(null);
          onOpenRun(id);
        }}
        onOpenMap={(id) => {
          setCard(null);
          onOpenMap(id);
        }}
        onTrack={(id) => {
          /* Следить некуда — карточка остаётся и объясняет почему. */
          const miss = onTrack(id);
          if (typeof miss !== 'string') setCard(null);
          return miss;
        }}
        locked={engineReady() ? CREW_ENGINE_LOCK : null}
        onSave={(patch) => {
          if (!crewCard) return;
          editCrew(crewCard.id, patch);
          onChanged();
        }}
        onDelete={() => {
          if (!crewCard) return;
          removeCrew(crewCard.id);
          setCard(null);
          onChanged();
        }}
      />

      <MapWindow
        day={day}
        view={view}
        open={win}
        onClose={() => setWin(null)}
        /* Переход вглубь остаётся в окне: «обзор» закрывает его, всё
           остальное меняет содержимое. Карта под окном при этом стоит на
           месте — за неё отвечает выбор на самой карте, а не окно. */
        onSelect={(next) => setWin(next.kind === 'overview' ? null : next)}
        onOpenSummary={() => {
          const open = win;
          setWin(null);
          if (open?.kind === 'group') onOpenMetric(open.id);
          else onOpenSummary();
        }}
      />

      <OrderProfile
        order={orderCard}
        registry={registry!}
        onClose={() => setCard(null)}
        onOpenRun={(id) => {
          setCard(null);
          onOpenRun(id);
        }}
        onOpenMap={(id) => {
          setCard(null);
          onOpenMap(id);
        }}
      />
    </div>
  );
}
