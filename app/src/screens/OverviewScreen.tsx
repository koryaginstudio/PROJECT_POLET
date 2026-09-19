import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm } from '../data/derive.ts';
import type { Registry } from '../data/registry.ts';
import { editCrew, removeCrew } from '../data/crew.ts';
import { loadPlaces } from '../data/load.ts';
import type { Place } from '../data/load.ts';
import { MapBoard } from '../app/MapBoard.tsx';
import { MapPick } from '../app/MapPick.tsx';
import { MetricTile } from '../app/CalcBoard.tsx';
import { CrewProfile } from '../app/CrewProfile.tsx';
import { OrderProfile } from '../app/OrderProfile.tsx';

interface Props {
  view: DayView;
  /** Номер открытого расчёта: R0001 и дальше. */
  /** Расчёт, чей план на карте: по нему у маршрутов их собственные номера. */
  runId: string;
  run: string;
  /** Подсвеченный маршрут — общий с картой и списками. */
  live: string | null;
  onLive: (engineerId: string | null) => void;
  /** Выбранный маршрут: пока он выбран, остальные на карте не нажимаются. */
  pinned: string | null;
  onPin: (engineerId: string | null) => void;
  focus: number;
  /** Выбранная заявка: карта обводит её точку. */
  selectedOrder: string | null;
  /** Щелчок по точке заявки. Обзор на него отвечает сводкой в правой
      колонке — на месте итогов расчёта; `null` закрывает её. */
  onSelectOrder: (id: string | null) => void;
  onSelectEngineer: (id: string) => void;
  /** Число раскрывается в сводке: там под ним разбор по строкам. */
  onOpenMetric: (group: string) => void;
  /** Уйти в сводку целиком. */
  onOpenSummary: () => void;
  /** Несохранённый пересчёт: на карте показан он, а не то, что в архиве. */
  draft: { at: number; gain: number; what: string } | null;
  /** Справочники: из них берутся карточки инженера и заявки, которые
      открываются поверх карты. Пока не загрузились — подписи в сводке не
      нажимаются. */
  registry: Registry | null;
  /** Уйти в расчёт заявки и показать его на карте — из карточки справочника,
      теми же дорогами, что и из самих баз. */
  onOpenRun: (id: string) => void;
  onOpenMap: (id: string) => void;
  /** «Отследить» из карточки инженера. */
  onTrack: (id: string) => void;
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
  runId,
  run,
  live,
  onLive,
  pinned,
  onPin,
  focus,
  selectedOrder,
  onSelectOrder,
  onSelectEngineer,
  onOpenMetric,
  onOpenSummary,
  draft,
  registry,
  onOpenRun,
  onOpenMap,
  onTrack,
  onChanged
}: Props) {
  /* Колонку складывают, когда карта важнее чисел: под ней город, и
     разглядывать его сквозь неё нельзя. Сложенная, она оставляет от себя
     кнопку в том же углу — вернуть числа одним нажатием. */
  const [folded, setFolded] = useState(false);

  /* Куда колонку перетащили. Хранится в браузере: это настройка рабочего
     места — у одного город тянется вправо, у другого влево, и место, где
     колонка не мешает, у каждого своё.

     Тащат за любое место колонки, кроме кнопок: своей полоски-ручки у неё
     нет, а заводить её ради одного жеста значит отнять строку у чисел.
     Порог в три точки отделяет перетаскивание от щелчка — без него каждое
     нажатие на плитку считалось бы попыткой сдвинуть. */
  const [shift, setShift] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('polet.mapstat') ?? 'null');
      return saved && typeof saved.x === 'number' && typeof saved.y === 'number'
        ? (saved as { x: number; y: number })
        : { x: 0, y: 0 };
    } catch {
      return { x: 0, y: 0 };
    }
  });
  /* Кого показывает сводка, когда нажали на общее гнездо выезда. */
  const [nest, setNest] = useState<string[] | null>(null);
  const [held, setHeld] = useState(false);
  const grab = useRef<{ x: number; y: number; from: { x: number; y: number }; moved: boolean } | null>(
    null
  );
  const wrap = useRef<HTMLDivElement>(null);

  /* Колонку держим в рамке карты: вынести её за край нельзя ни рукой, ни
     сохранённым сдвигом с прежнего, более широкого окна. */
  const inside = (next: { x: number; y: number }) => {
    const node = wrap.current;
    const area = node?.closest('.geo__plot')?.getBoundingClientRect();
    if (!node || !area) return next;
    const box = node.getBoundingClientRect();
    const pad = 12;
    /* Где колонка стояла бы без сдвига: рамка уже сдвинута, поэтому вычитаем
       то, что к ней применено сейчас. */
    const left = box.left - shift.x;
    const top = box.top - shift.y;
    const min = { x: area.left + pad - left, y: area.top + pad - top };
    const max = {
      x: area.right - pad - (left + box.width),
      y: area.bottom - pad - (top + box.height)
    };
    return {
      x: Math.min(Math.max(next.x, Math.min(min.x, max.x)), Math.max(min.x, max.x)),
      y: Math.min(Math.max(next.y, Math.min(min.y, max.y)), Math.max(min.y, max.y))
    };
  };

  /* Окно сузилось — колонка возвращается в рамку сама. */
  useEffect(() => {
    const fit = () => setShift((was) => inside(was));
    const id = requestAnimationFrame(fit);
    window.addEventListener('resize', fit);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', fit);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onGrab = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('button, a, input')) return;
    grab.current = { x: event.clientX, y: event.clientY, from: shift, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = grab.current;
    if (!from) return;
    const dx = event.clientX - from.x;
    const dy = event.clientY - from.y;
    if (!from.moved && Math.hypot(dx, dy) < 3) return;
    from.moved = true;
    setHeld(true);
    setShift(inside({ x: from.from.x + dx, y: from.from.y + dy }));
  };

  const onDrop = (event: React.PointerEvent<HTMLDivElement>) => {
    const from = grab.current;
    grab.current = null;
    setHeld(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!from?.moved) return;
    try {
      localStorage.setItem('polet.mapstat', JSON.stringify(shift));
    } catch {
      /* Приватное окно: место колонки просто не запомнится. */
    }
  };

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

  const crewCard =
    card?.kind === 'engineer'
      ? (registry?.engineers.find((one) => one.id === card.id) ?? null)
      : null;
  /* Заявка ищется в своём расчёте: номера в расчётах повторяются, и без
     номера расчёта открылась бы чужая запись. */
  const orderCard =
    card?.kind === 'order'
      ? (registry?.orders.find((one) => one.id === card.id && one.run.code === run) ?? null)
      : null;

  /* Выбрали маршрут или заявку — колонка отвечает о них, а не о дне. */
  const picked = Boolean(pinned || selectedOrder || nest);

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
        <span className="mapstat__run" title="Открытый расчёт движка">
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
          <Icon name="chevron-right" size={14} />
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

      <div className="mapstat__metrics">
        {view.metrics.map((metric) => (
          <MetricTile key={metric.key} metric={metric} onOpen={() => onOpenMetric(metric.group)} />
        ))}
      </div>

      {/* Тихая строка вместо кнопки: уход в сводку — не действие над
          расчётом, а соседняя вкладка, и звучать он должен тише чисел. */}
      {/* Уход в сводку — стрелкой: в полосе поверх карты слова «Разобрать в
          сводке» занимали больше места, чем иное число, а куда она ведёт,
          говорит подсказка. */}
      <button
        type="button"
        className="mapstat__go"
        onClick={onOpenSummary}
        title="Разобрать расчёт в сводке"
        aria-label="Разобрать расчёт в сводке"
      >
        <Icon name="arrow-right" size={14} />
      </button>
    </section>
  );

  /* Сводка выбранного стоит на месте итогов: две колонки поверх одной карты
     не помещаются, а спрашивают всегда об одном — либо про день, либо про то,
     на что нажали. */
  const held_ = held;
  const asideBody =
    picked && !folded ? (
      <MapPick
        view={view}
        pinned={pinned}
        selectedOrder={selectedOrder}
        nest={nest}
        onPickRoute={(id) => {
          setNest(null);
          onPin(id);
        }}
        onClose={() => {
          onSelectOrder(null);
          setNest(null);
          onPin(null);
        }}
        onOpenEngineer={(id) => registry && setCard({ kind: 'engineer', id })}
        onOpenOrder={(id) => registry && setCard({ kind: 'order', id })}
      />
    ) : (
      stats
    );

  /* Перетаскивание висит на самой колонке: обёртка ловит жест и отдаёт сдвиг
     переменными, а угол, от которого он считается, задан вёрсткой. */
  const aside = (
    <div
      ref={wrap}
      className={'mapdrag' + (held_ ? ' mapdrag--held' : '')}
      style={{ '--stat-x': `${shift.x}px`, '--stat-y': `${shift.y}px` } as React.CSSProperties}
      onPointerDown={onGrab}
      onPointerMove={onDrag}
      onPointerUp={onDrop}
      onPointerCancel={onDrop}
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
        onSelectOrder={(id) => {
          setNest(null);
          onSelectOrder(id);
        }}
        onSelectEngineer={onSelectEngineer}
        onSelectNest={setNest}
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
          setCard(null);
          onTrack(id);
        }}
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
