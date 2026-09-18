import { Fragment, useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunId, DaySummary } from '../data/load.ts';
import { whenLabel } from '../data/load.ts';
import { dec } from '../data/derive.ts';
import { RunMenu } from './RunMenu.tsx';

interface Props {
  runs: DaySummary[] | null;
  /** Отмеченные в ленте. В подшапке это один открытый расчёт, в
      «Сравнении» — весь отобранный набор: лента там не переключает, а
      набирает, и отмеченных в ней столько, сколько отобрали. */
  active: RunId | RunId[];
  onOpen: (id: RunId) => void;
  /** Набор полон — неотмеченные гаснут. Пусто в подшапке: открытый расчёт
      всегда один, и «полного набора» там не бывает. */
  full?: boolean;
  /** Чем подписано отмеченное в списке «все расчёты». */
  markLabel?: string;
  /** Что говорит подсказка на погашенном расчёте. */
  fullHint?: string;
}

/* Сколько расчётов держим в ленте. Остальные — в списке: лента отвечает за
   «вернуться к недавнему», список — за «найти нужный». */
const STRIP = 15;

/* Выбор расчёта в подшапке.

   Раньше здесь стоял период — «Сегодня, Вчера, Неделя». Но контракт не знает
   ни дней, ни календаря: он отдаёт расчёты движка под своими номерами, и
   диспетчер переключается между ними, а не между датами.

   Лента занимает всю свободную ширину и прокручивается: расчётов со временем
   станет много, и строка не должна ни расти вместе с ними, ни оставлять
   справа пустоту. Что не поместилось — достаётся из списка, и там же поиск:
   когда расчётов сотня, нужный ищут по дате, а не глазами по ленте. */
export function RunTabs({
  runs,
  active,
  onOpen,
  full = false,
  markLabel = 'Открыт',
  fullHint = 'Набор полон'
}: Props) {
  /* Один отмеченный или несколько — для ленты разницы нет: дальше она
     работает со списком. */
  const marked = Array.isArray(active) ? active : [active];
  const isOn = (id: RunId) => marked.includes(id);
  const lead = marked[0];
  /* Лента набирает, а не переключает: отмеченных в ней несколько, и они
     собираются слева. */
  const picking = Array.isArray(active);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const activeChip = useRef<HTMLButtonElement>(null);

  /* Выбранный расчёт всегда на виду: открыли его из списка — лента сама
     подъезжает к нему, искать его в прокрутке руками незачем.

     Когда лента набирает, подъезжать некуда: набор стоит в самом её
     начале, и смотреть надо туда. Поэтому вместо подвода к чипу лента
     отматывается к левому краю — иначе отобранный уезжал бы в середину
     экрана, а собранный набор оставался бы за кадром слева. */
  useEffect(() => {
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (picking) {
      strip.current?.scrollTo({ left: 0, behavior: calm ? 'auto' : 'smooth' });
      return;
    }
    const chip = activeChip.current;
    if (!chip) return;
    chip.scrollIntoView({
      behavior: calm ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center'
    });
  }, [picking, lead, marked.length, runs]);

  if (!runs) {
    return (
      <div className="runtabs">
        <span className="runtabs__loading">Собираем расчёты…</span>
      </div>
    );
  }

  /* В ленте свежие идут первыми: к последнему расчёту возвращаются чаще, чем
     к первому в архиве. Показываем последние — весь архив в строку не лезет
     и лезть не должен. */
  const ordered = [...runs].reverse();
  const visible = ordered.slice(0, STRIP);
  /* Отмеченный расчёт виден всегда, даже если он старый и в последние не
     попал: иначе лента показывала бы выбор, которого в ней нет. */
  for (const id of marked) {
    if (visible.some((run) => run.id === id)) continue;
    const current = ordered.find((run) => run.id === id);
    if (current) visible.push(current);
  }
  const rest = runs.length - visible.length;

  /* Набор — слева, остальной архив за ним.

     Отобранное перестаёт быть разбросанным по ленте: четыре расчёта,
     выбранные из тридцати, стояли вперемешку с невыбранными, и чтобы
     увидеть набор целиком, приходилось прокручивать строку глазами от
     края до края. Собранные слева, они читаются как то, что и есть, —
     один набор.

     Порядок внутри набора — порядок отбора: расчёт встаёт туда, куда его
     положили, а не туда, где он стоял в архиве. Снятый возвращается на
     своё место в ленте — она остаётся архивом по времени, а не списком
     того, что когда-то трогали. */
  const chosen = picking
    ? marked.map((id) => visible.find((run) => run.id === id)).filter(Boolean)
    : [];
  const others = picking ? visible.filter((run) => !isOn(run.id)) : visible;
  const shown = picking ? [...(chosen as typeof visible), ...others] : visible;
  /* Черта между набором и архивом. Её нет, пока набор пуст или пока в
     архиве не осталось чего добрать: разделять в этих случаях нечего. */
  const split = picking && chosen.length > 0 && others.length > 0 ? chosen.length : -1;

  return (
    <div className="runtabs" ref={box}>
      <div className="runtabs__strip" ref={strip} role="tablist" aria-label="Расчёт">
        {shown.map((run, index) => (
          <Fragment key={run.id}>
            {index === split && <span className="runtabs__split" aria-hidden="true" />}
          <button
            key={run.id}
            type="button"
            role="tab"
            ref={run.id === lead ? activeChip : undefined}
            aria-selected={isOn(run.id)}
            disabled={full && !isOn(run.id)}
            className={'runtabs__item' + (isOn(run.id) ? ' runtabs__item--active' : '')}
            onClick={() => onOpen(run.id)}
            title={
              full && !isOn(run.id)
                ? fullHint
                : `${whenLabel(run.created)} · заявок ${run.ordersTotal}` +
                  ` · инженеров на маршрутах ${run.engineersOnShift}` +
                  ` · покрытие ${dec(run.coverage)} %`
            }
          >
            <span className="runtabs__code">{run.code}</span>
            {/* Три числа рядом с номером: заявок, инженеров, покрытие. Номер
                сам по себе ничего не говорит — расчёты в ленте различают не
                по нему, а по тому, чем они кончились, и раньше за этим
                приходилось открывать каждый. Порядок тот же, что и в
                подсказке: сколько работы, сколько рук, что вышло. */}
            <span className="runtabs__meta">
              {run.ordersTotal}/{run.engineersOnShift}/{Math.round(run.coverage)}%
            </span>
          </button>
          </Fragment>
        ))}
      </div>

      <button
        type="button"
        className={'runtabs__more' + (open ? ' runtabs__more--on' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Все расчёты движка"
      >
        <Icon name="stack" size={14} />
        <span className="runtabs__more-label">{rest > 0 ? `Ещё ${rest}` : 'Все'}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
      </button>

      {open && (
        <RunMenu
          runs={runs}
          marked={marked}
          onPick={onOpen}
          onClose={() => setOpen(false)}
          boxRef={box}
          closeOnPick={!picking}
          full={full}
          markLabel={markLabel}
          fullHint={fullHint}
        />
      )}
    </div>
  );
}
