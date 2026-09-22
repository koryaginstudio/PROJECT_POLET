import { Icon } from '../ds/components/core/Icon.jsx';
import { useState } from 'react';
import { TimeScrub } from './Timeline.tsx';
import type { Funnel, StageKey } from '../data/derive.ts';
import type { Stage } from '../data/derive.ts';
import { hhmm, plural, orders as pluralOrders, engineers as pluralEngineers } from '../data/derive.ts';

interface Props {
  funnel: Funnel;
  /** Та же шкала, что и на пульте: обе двигают один момент. */
  /** Принимает и значение, и функцию обновления: шаг шкалы считается от
      актуального среза, иначе быстрые нажатия теряются. */
  onCutChange: (cut: number | ((prev: number) => number)) => void;
  /** Отдаёт этап целиком: подпись идёт в заголовок списка. */
  onPickStage: (stage: Stage) => void;
  /** Сколько заявок требуют вмешательства. Считается там же, где квадрат
      «Проблемные», чтобы два места не показывали разные числа. */
  problems: number;
  onOpenProblems: () => void;
}

/* Число инженеров показываем там, где заявка кем-то занята прямо сейчас:
   в остальных этапах оно ничего не добавляет. */
const CREW_STAGES = new Set<Stage['key']>(['planned', 'enroute', 'working']);

/* Прирост за час одним словом. «+5» без расшифровки читается как «пять
   чего?», поэтому в плашке стоит короткое слово и значок этапа, а полная
   фраза ждёт в подсказке. */
const DELTA_WORD: Partial<Record<StageKey, string>> = {
  done: 'закрыто',
  overdue: 'могут сорваться',
  failed: 'сорвалось',
  enroute: 'выехали',
  working: 'начали'
};

const DELTA_ICON: Partial<Record<StageKey, string>> = {
  done: 'check-circle',
  overdue: 'x-circle',
  failed: 'x-circle',
  enroute: 'truck',
  working: 'wrench'
};

function deltaTitle(stage: Stage): string {
  const n = stage.delta ?? 0;
  switch (stage.key) {
    case 'done':
      return `За последний час ${plural(n, 'заявка закрыта', 'заявки закрыты', 'заявок закрыто')}`;
    case 'overdue':
      return `За последний час ${plural(
        n,
        'заявка перешла',
        'заявки перешли',
        'заявок перешло'
      )} в потенциальный срыв: план по ним выходит за крайний срок`;
    case 'enroute':
      return `За последний час инженеры выехали к ${plural(n, 'заявке', 'заявкам', 'заявкам')}`;
    case 'working':
      return `За последний час инженеры приступили к ${plural(n, 'заявке', 'заявкам', 'заявкам')}`;
    default:
      return `За последний час прибавилось ${pluralOrders(n)}`;
  }
}

/* Инженеры на этапе — не украшение числа, а ответ на «кем это делается
   прямо сейчас»: у каждого этапа он звучит по-своему. */
function crewTitle(stage: Stage): string {
  const crew = pluralEngineers(stage.crew);
  switch (stage.key) {
    case 'enroute':
      return `${crew} сейчас в пути к этим заявкам`;
    case 'working':
      return `${crew} сейчас работают на этих заявках`;
    default:
      return `Эти заявки закреплены за ${plural(stage.crew, 'инженером', 'инженерами', 'инженерами')}`;
  }
}

/* Плашка под числом. Подсказка своя, а не браузерная: системная всплывает
   через секунду, а на вложенном элементе кнопки её и вовсе перебивает
   подсказка самой кнопки. Крайние колонки открывают её от правого края,
   иначе она вылезает за карточку. */
function Tag({
  tone,
  icon,
  text,
  tip,
  onClick
}: {
  tone: 'muted' | 'success' | 'danger' | 'accent' | 'alarm' | 'attention';
  icon?: string;
  text: string;
  tip: string;
  onClick?: () => void;
}) {
  const cls = 'tag tag--' + tone + (onClick ? ' tag--action' : '');
  const inner = (
    <>
      {icon && (
        <span className="tag__icon">
          <Icon name={icon} size={10} />
        </span>
      )}
      <span className="tag__text">{text}</span>
      <span className="tag__tip" role="tooltip">
        {tip}
      </span>
    </>
  );
  if (!onClick) return <span className={cls}>{inner}</span>;
  return (
    <button type="button" className={cls} onClick={onClick} aria-label={tip}>
      {inner}
    </button>
  );
}

/* Порядок долей в общей шкале: серое — красное — жёлтое — зелёное.
   Слева нетронутое (без инженера и ещё не выехали), дальше то, что прогноз
   относит к срыву,
   потом то, что происходит прямо сейчас, и справа закрытые заявки.
   По мере смены зелёный хвост отъедает шкалу справа налево, пока не займёт её целиком. */
/* Плашки под числом, в порядке важности: то, что требует решения, идёт
   первым — лишнее отрезается с хвоста. */
function badges(stage: Stage, delta: number, crew: number) {
  const list: JSX.Element[] = [];

  if (stage.key === 'unassigned' && stage.atRisk > 0) {
    list.push(
      <Tag
        key="risk"
        tone="alarm"
        icon="alert-triangle"
        text={`${stage.atRisk} — окно уже открыто`}
        tip={`У ${plural(stage.atRisk, 'заявки', 'заявок', 'заявок')} без инженера окно приёма уже открыто: назначить их без потерь времени не получится`}
      />
    );
  }

  if (delta > 0) {
    list.push(
      <Tag
        key="delta"
        tone={stage.tone === 'idle' || stage.tone === 'planned' ? 'muted' : stage.tone}
        icon={DELTA_ICON[stage.key] ?? 'arrow-up-right'}
        text={`+${delta} ${DELTA_WORD[stage.key] ?? 'за час'}`}
        tip={deltaTitle(stage)}
      />
    );
  }

  if (crew > 0) {
    list.push(
      <Tag
        key="crew"
        tone="muted"
        icon="users"
        text={pluralEngineers(crew)}
        tip={crewTitle(stage)}
      />
    );
  }

  return list;
}

/* «Сорвалось» — рядом с прогнозом срыва: обе доли красные, и в полосе они
   читаются одним куском «плохо», факт первым. Этапа нет в воронке дня без
   журнала — тогда он просто не попадёт в полосу. */
const PROGRESS_ORDER: StageKey[] = ['unassigned', 'planned', 'failed', 'overdue', 'enroute', 'working', 'done'];

export function FunnelBoard({ funnel, onCutChange, onPickStage, problems, onOpenProblems }: Props) {
  const total = Math.max(1, funnel.total);
  /* Подсвеченный этап: полоса и легенда — две части одной картинки, и
     наводя на одну, диспетчер должен видеть, где это во второй. */
  const [hot, setHot] = useState<StageKey | null>(null);

  const byKey = new Map(funnel.stages.map((stage) => [stage.key, stage]));
  const segments = PROGRESS_ORDER.map((key) => byKey.get(key)).filter(
    (stage): stage is NonNullable<typeof stage> => Boolean(stage)
  );
  const done = byKey.get('done')?.count ?? 0;

  /* Ширина сегмента точная, а подпись — целое число процентов. Округлять каждую
     долю по отдельности нельзя: шесть округлений дают в сумме 101%. Раздаём
     остаток по наибольшим хвостам, чтобы подписи складывались ровно в 100. */
  const shares = (() => {
    const map = new Map<StageKey, number>();
    if (funnel.total === 0) {
      for (const stage of segments) map.set(stage.key, 0);
      return map;
    }
    const raw = segments.map((stage) => (stage.count / total) * 100);
    const whole = raw.map(Math.floor);
    const order = raw
      .map((value, index) => ({ rest: value - Math.floor(value), index }))
      .sort((a, b) => b.rest - a.rest);
    let left = 100 - whole.reduce((sum, value) => sum + value, 0);
    for (const { index } of order) {
      if (left <= 0) break;
      whole[index] += 1;
      left -= 1;
    }
    segments.forEach((stage, index) => map.set(stage.key, whole[index]));
    return map;
  })();
  const share = (stage: { key: StageKey }) => shares.get(stage.key) ?? 0;
  const donePct = shares.get('done') ?? 0;

  /* Крайние доли скруглены по концам полосы. Пустые этапы остаются в разметке
     с нулевой шириной — ради плавного перехода, когда момент двигают, — и
     поэтому «первый» и «последний» ищем по числу, а не по порядку в вёрстке:
     иначе скругление достаётся невидимому куску, а у видимого край срезан. */
  const filled = segments.map((stage) => stage.count > 0);
  const firstFilled = filled.indexOf(true);
  const lastFilled = filled.lastIndexOf(true);

  return (
    <section className="funnel" aria-label="Этапы смены">
      <header className="funnel__head">
        <h2 className="funnel__title">Этапы</h2>
      </header>

      {/* С журналом дня этапов на один больше — ряд из восьми клеток. */}
      <div className={'funnel__rail' + (funnel.stages.length > 6 ? ' funnel__rail--wide' : '')}>
        <div className="stage stage--total">
          <span className="stage__bar stage__bar--total">
            <span className="stage__bar-fill" style={{ width: '100%' }} />
          </span>
          <span className="stage__value">{funnel.total}</span>
          <span className="stage__label">Всего заявок</span>
          <span className="stage__meta">
            {problems > 0 && (
              <Tag
                tone="attention"
                icon="alert-triangle"
                text={`${problems} под угрозой`}
                tip={`${pluralOrders(problems)} назначены инженеру, но выполнение под угрозой: нарушен крайний срок, нет запаса времени или прогноз дня показывает срыв. Нажмите, чтобы посмотреть список`}
                onClick={onOpenProblems}
              />
            )}
          </span>
        </div>

        {funnel.stages.map((stage) => {
          const delta = stage.delta !== null && stage.delta > 0 ? stage.delta : 0;
          const crew = CREW_STAGES.has(stage.key) && stage.count > 0 ? stage.crew : 0;
          return (
            <button
              key={stage.key}
              type="button"
              className={'stage stage--' + stage.key}
              onClick={() => onPickStage(stage)}
              disabled={stage.count === 0}
              title={stage.hint}
              aria-label={`${stage.label}: ${stage.count} из ${funnel.total}${
                stage.hint ? '. ' + stage.hint : ''
              }${delta > 0 ? '. ' + deltaTitle(stage) : ''}${
                crew > 0 ? '. ' + crewTitle(stage) : ''
              }`}
            >
              {/* Доля этапа от всей смены — одна и та же мера для всех шести
                  полос, поэтому они сравнимы между собой и складываются в целое. */}
              <span className={'stage__bar stage__bar--' + stage.tone}>
                <span className="stage__bar-fill" style={{ width: `${(stage.count / total) * 100}%` }} />
              </span>
              <span className="stage__value">{stage.count}</span>
              <span className="stage__label">{stage.label}</span>
              {/* Всё, что уточняет число, стоит под ним: сверху ничего, кроме
                  самой полосы доли, иначе взгляд читает подпись раньше цифры.

                  Плашек показываем не больше двух — столько помещается в
                  квадрат клетки. Порядок важен: срочное впереди, потому что
                  отрезается хвост. */}
              <span className="stage__meta">{badges(stage, delta, crew).slice(0, 2)}</span>
            </button>
          );
        })}
      </div>

      {/* Время двигают прямо под числами, на которые смотрят: этапы меняются
          вместе с моментом, и ходить за этим в другой блок незачем. */}
      <TimeScrub
        cut={funnel.cut}
        onCutChange={onCutChange}
        label="Момент, на который показаны этапы"
      />

      {/* Состояние смены одной строкой: те же шесть чисел, но как доли целого. */}
      <div className="progress">
        <div className="progress__head">
          <span className="progress__title">Состояние смены на {hhmm(funnel.cut)}</span>
          <span className="progress__lead">
            <b>{donePct}%</b> выполнено · {done} из {funnel.total}
          </span>
        </div>

        <div
          className="progress__track"
          role="img"
          aria-label={segments
            .filter((stage) => stage.count > 0)
            .map((stage) => `${stage.label}: ${stage.count} (${share(stage)}%)`)
            .join(', ')}
        >
          {/* Полоса — картинка состояния, а не набор кнопок. Щелчок по ней
              открывал первую попавшуюся заявку из этапа, что выглядело как
              случайный переход. Теперь наведение подсвечивает нужную строку
              легенды, а открывает список сама легенда — там видно, что
              именно откроется. */}
          {segments.map((stage, index) => (
            <span
              key={stage.key}
              className={
                'progress__seg progress__seg--' +
                stage.key +
                (index === firstFilled ? ' progress__seg--first' : '') +
                (index === lastFilled ? ' progress__seg--last' : '') +
                (hot === stage.key ? ' progress__seg--hot' : '') +
                (hot && hot !== stage.key ? ' progress__seg--dim' : '')
              }
              style={{ width: `${(stage.count / total) * 100}%` }}
              onMouseEnter={() => stage.count > 0 && setHot(stage.key)}
              onMouseLeave={() => setHot(null)}
              title={
                `${stage.label}: ${pluralOrders(stage.count)} (${share(stage)}%)` +
                (stage.hint ? `. ${stage.hint}` : '')
              }
            />
          ))}
        </div>

        <div className="progress__legend">
          {segments.map((stage) => (
            <button
              key={stage.key}
              type="button"
              className={
                'progress__item' +
                (stage.count === 0 ? ' progress__item--empty' : '') +
                (hot === stage.key ? ' progress__item--hot' : '')
              }
              onClick={() => onPickStage(stage)}
              onMouseEnter={() => stage.count > 0 && setHot(stage.key)}
              onMouseLeave={() => setHot(null)}
              disabled={stage.count === 0}
            >
              <span className={'progress__dot progress__dot--' + stage.key} />
              <span className="progress__item-label">{stage.label}</span>
              <span className="progress__item-value">{stage.count}</span>
              <span className="progress__item-pct">{share(stage)}%</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
