import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView } from '../data/derive.ts';
import { deadline, hhmm, isDeferrable, placeOf } from '../data/derive.ts';
interface Props {
  view: DayView;
  /** Открыть заявку. Карточкой, а не выбором в правой панели: панели нет ни
      на форме нового расчёта, ни в базах, а уведомления висят в шапке и
      нажимаются отовсюду — прежде оттуда щелчок только закрывал меню. */
  onPick: (orderId: string) => void;
}

/* Что требует диспетчера прямо сейчас: заявки без инженера с сегодняшним сроком
   и визиты, которые чаще всего срывались в итерациях.

   Два рода тревоги разделены явно — срочные наверху, остальные под чертой —
   и каждая группа складывается по щелчку. Список не свежий: диспетчер держит
   колокольчик открытым и разбирает по одной, а разобранные прячет, не
   дожидаясь, пока они пропадут сами через пересчёт.

   Строка называет причину словами, а не числом. Прежде в ней стояли «до
   22:00» и «риск 34,7 %»: первое — срок, который виден и в карточке, второе —
   доля прогонов, из которой диспетчеру нечего делать. Ни то, ни другое не
   отвечало на вопрос «а что не так»: кто не назначен, сколько запаса, кто не
   успевает. Порядок чтения — объект, потом беда, потом где это: сначала
   узнают, о чём речь, потом что случилось, и только потом едут глазами по
   адресу. Дальше — открыть заявку и решать: назначить, позвонить, написать. */
export function Notifications({ view, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState({ urgent: false, fragile: false });
  const wrap = useRef<HTMLDivElement>(null);

  /* Разобранные щелчком уведомления. Список не берётся из движка заново при
     каждом рендере — пересчёт может и не убрать заявку из тревожных, если
     причина осталась, — поэтому «разобрано» помнит сам колокольчик, id
     заявки, пока не откроют её снова другим расчётом. */
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  /* Срочная — та, что не переносима на завтра: правило одно с воронкой. */
  const urgent = view.unassigned.filter((o) => !isDeferrable(o, view.hardEnd) && !dismissed.has(o.id));
  const fragile = view.fragile.filter(({ order }) => !dismissed.has(order.id)).slice(0, 5);
  const total = urgent.length + fragile.length;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  /* Убрать строку, не открывая заявку: смахиванием. */
  const hide = (id: string) => setDismissed((was) => new Set(was).add(id));

  /* Щелчок по строке — открыть заявку и убрать её из списка: диспетчер
     разбирает уведомления по одной, а не держит в них то, что уже посмотрел. */
  const pick = (id: string) => {
    hide(id);
    onPick(id);
    setOpen(false);
  };

  /* Чем плох этот визит — словами и числами, с которыми можно что-то делать:
     сколько запаса, кто едет, к какому часу ждут. Доля сорванных прогонов
     («риск 34,7 %») стояла здесь раньше и не отвечала ни на один вопрос
     диспетчера: звонить клиенту или переносить — из процента не следует. */
  const whyFragile = (order: DayView['fragile'][number]['order']): string => {
    const place = view.stopByOrder.get(order.id);
    if (!place) return 'Исполнитель не найден — заявка осталась без визита';
    const who = view.engineerById.get(place.engineerId)?.name ?? 'Инженер';
    const arrive = hhmm(place.stop.start);
    if (place.slaBreached) {
      /* Срок рвёт не приезд, а окончание работ: приехать до срока можно и
         всё равно не уложиться. Поэтому здесь конец визита, а не начало —
         иначе строка сама себе противоречила: «приедет в 13:22, крайний
         срок 14:00» читается как «успевает». */
      return `Не успевает: ${who} закончит в ${hhmm(place.stop.finish)}, а срок — ${deadline(order.sla_deadline)}`;
    }
    return (
      `Запас ${place.stop.slack_minutes} мин: ${who} приедет в ${arrive}, ` +
      `а принять могут до ${hhmm(order.window_end)}`
    );
  };

  const toggle = (key: 'urgent' | 'fragile') =>
    setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="notify" ref={wrap}>
      <button
        type="button"
        className={'notify__button' + (open ? ' notify__button--open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Требуют внимания: ${total}`}
        title={`Требуют внимания: ${total}`}
      >
        <Icon name="bell" size={20} />
        {total > 0 && <span className="notify__badge">{total}</span>}
      </button>

      {open && (
        <div className="notify__card" role="dialog" aria-label="Уведомления">
          <h3 className="notify__title">Уведомления</h3>

          <NotifyGroup
            label="Срочные"
            icon="warning"
            tone="urgent"
            count={urgent.length}
            open={!collapsed.urgent}
            onToggle={() => toggle('urgent')}
            emptyText="Все срочные заявки разобраны."
          >
            {urgent.slice(0, 5).map((o) => (
              <NotifyRow
                key={o.id}
                kind="Заявка"
                id={o.id}
                title={o.work_title}
                place={placeOf(o)}
                why={`Никто не назначен, а принять могут до ${deadline(o.sla_deadline)}`}
                tone="urgent"
                onClick={() => pick(o.id)}
                onDismiss={() => hide(o.id)}
              />
            ))}
          </NotifyGroup>

          <span className="notify__divider" aria-hidden="true" />

          <NotifyGroup
            label="Остальные"
            icon="clock"
            tone="watch"
            count={fragile.length}
            open={!collapsed.fragile}
            onToggle={() => toggle('fragile')}
            emptyText="По прогнозу дня ни одна заявка не срывается."
          >
            {fragile.map(({ order }) => (
              <NotifyRow
                key={order.id}
                kind="Заявка"
                id={order.id}
                title={order.work_title}
                place={placeOf(order)}
                why={whyFragile(order)}
                tone="watch"
                onClick={() => pick(order.id)}
                onDismiss={() => hide(order.id)}
              />
            ))}
          </NotifyGroup>
        </div>
      )}
    </div>
  );
}

/* Заголовок раздела — та же стрелка, что складывает разделы правой панели:
   поворачивается вместо смены значка, и это само объясняет, что раздел
   свернулся, а не закрылся насовсем. Значок перед названием — не украшение,
   а тон: красный треугольник у срочных читается раньше, чем текст.

   Пустая группа говорит словами, а не пустотой: иначе раскрытый заголовок
   без строк читался бы как «список не загрузился». */
function NotifyGroup({
  label,
  icon,
  tone,
  count,
  open,
  onToggle,
  emptyText,
  children
}: {
  label: string;
  icon: string;
  tone: 'urgent' | 'watch';
  count: number;
  open: boolean;
  onToggle: () => void;
  emptyText: string;
  children: ReactNode;
}) {
  return (
    <div className="notify__group">
      <button type="button" className="notify__group-head" onClick={onToggle} aria-expanded={open}>
        <Icon name={icon} size={14} className={'notify__group-icon notify__group-icon--' + tone} />
        <span className="notify__group-title">{label}</span>
        <span className="notify__group-count">{count}</span>
        <Icon
          name="chevron-down"
          size={14}
          className={'notify__group-chev' + (open ? ' notify__group-chev--open' : '')}
        />
      </button>

      {open &&
        (count === 0 ? (
          <p className="notify__empty">{emptyText}</p>
        ) : (
          <div className="notify__rows">{children}</div>
        ))}
    </div>
  );
}

/* Строка уведомления — не два обрывка текста, а разбор: что за запись (пока
   всегда заявка — маршруты и инженеры своих уведомлений ещё не шлют, но
   формат уже на них рассчитан), её номер отдельной плашкой, что по ней
   случилось и где, и справа — то самое число, ради которого её вообще
   показали: срок или риск срыва. */
function NotifyRow({
  kind,
  id,
  title,
  place,
  why,
  tone,
  onClick,
  onDismiss
}: {
  kind: string;
  id: string;
  title: string;
  place: string | null | undefined;
  /** Причина словами: что именно не так с этой заявкой. */
  why: string;
  tone: 'urgent' | 'watch';
  onClick: () => void;
  onDismiss: () => void;
}) {
  /* Смахивание влево убирает строку, как в списке уведомлений телефона.

     Два жеста, а не один: мышью строку тянут, прижав кнопку, на трекпаде —
     двумя пальцами вбок, и это разные события. Второе приходит колесом с
     горизонтальной составляющей, и конца у него нет — жест считается
     оконченным, когда события перестали идти.

     Порог в треть ширины: случайный сдвиг на десяток точек уведомление не
     снимает, а намеренное движение доводить до края не нужно. */
  const [shift, setShift] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const row = useRef<HTMLDivElement>(null);
  const drag = useRef<{ from: number; moved: boolean } | null>(null);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  const limit = () => Math.max(72, (row.current?.offsetWidth ?? 280) / 3);

  const finish = (value: number) => {
    if (value <= -limit()) {
      setLeaving(true);
      setShift(-(row.current?.offsetWidth ?? 320));
      /* Ждём уезд строки и только потом убираем её из списка: иначе она
         пропадала бы посреди движения, рывком. */
      setTimeout(onDismiss, 180);
      return;
    }
    setShift(0);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || leaving) return;
    drag.current = { from: e.clientX, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    if (!held) return;
    const dx = e.clientX - held.from;
    if (!held.moved && Math.abs(dx) < 4) return;
    held.moved = true;
    setShift(Math.min(0, dx));
    /* Ловим указатель на самой строке, чтобы движение не терялось, когда
       курсор ушёл за её край. Браузер отказывает, если указателя уже нет, —
       и отказ здесь ничего не ломает: без захвата жест просто кончится
       раньше, а вот брошенное исключение оборвало бы его посреди. */
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* Указатель уже отпущен — ловить нечего. */
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const held = drag.current;
    drag.current = null;
    if (!held?.moved) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* Захвата не было — отпускать нечего. */
    }
    finish(e.clientX - held.from);
  };

  const onWheel = (e: React.WheelEvent<HTMLElement>) => {
    if (leaving || Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const next = Math.min(0, shift - e.deltaX);
    setShift(next);
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(() => finish(next), 120);
  };

  return (
    <div className="notify__swipe" ref={row}>
      {/* Что будет, если довести жест до конца. Подложка не нажимается: она
          объясняет движение, а не предлагает второй способ убрать. */}
      <span className="notify__swipe-back" aria-hidden="true">
        <Icon name="x" size={13} />
        Скрыть
      </span>
      <button
        type="button"
        className={'notify__row notify__row--' + tone + (leaving ? ' notify__row--leaving' : '')}
        style={{
          transform: shift ? `translateX(${shift}px)` : undefined,
          transition: drag.current ? 'none' : undefined
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        /* Строку тянули, а не нажимали: открывать заявку после смахивания
           нельзя, иначе жест уводил бы с экрана вместо того, чтобы убрать
           уведомление. */
        onClick={(e) => {
          if (shift !== 0 || leaving) {
            e.preventDefault();
            return;
          }
          onClick();
        }}
      >
        <span className="notify__row-head">
          <Icon name="clipboard-list" size={12} className="notify__row-kind-icon" />
          <span className="notify__row-kind">{kind}</span>
          <span className="notify__row-id">{id}</span>
          <span className="notify__row-title">{title}</span>
        </span>
        <span className="notify__row-why">{why}</span>
        {place && <span className="notify__row-place">{place}</span>}
      </button>
    </div>
  );
}
