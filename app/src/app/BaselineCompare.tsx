import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';
import { WhyMark } from './WhyMark.tsx';
import type { Day } from '../data/contract.ts';
import { dec, engineersUsed, kmTotal } from '../data/derive.ts';

interface Props {
  day: Day;
}

const WHY_TEXT =
  'Способ, которым движок раскладывает заявки по инженерам в этом расчёте. Чтобы показать его пользу, движок для того же дня и того же списка заявок и инженеров отдельно считает ещё один вариант — простую раскладку без оптимизации. Насколько оптимизатор обошёл этот простой вариант, показано ниже.';

/* Оптимизатор против базового варианта — обязательное сравнение ТЗ,
   не сравнение между собой двух посчитанных дней. У «Сравнения расчётов»
   разные дни расходятся числом заявок, зоной, датой — и который лучше
   разложил по абсолютным числам, вопрос без ответа: R003 на 56 заявках
   не сравнить с R002 на 83. Здесь сравнение по построению на одном и том
   же наборе: `plan.meta.baseline` — тот же день, тот же список заявок и
   инженеров, посчитанный движком второй раз, простым способом вместо
   оптимизатора.

   Показывается только у плана дня целиком: у пересчёта своего базового нет
   — контракт зовёт его на весь день, а не на остаток (см. `derive.ts`,
   комментарий у `basePerVisit`). */
export function BaselineCompare({ day }: Props) {
  const { plan } = day;
  const base = plan.meta.baseline;
  if (!base) return null;

  const total = plan.meta.orders_total;
  const optAssigned = plan.meta.orders_assigned;
  const baseAssigned = base.orders_assigned;
  const optShare = total > 0 ? (optAssigned / total) * 100 : 0;
  const baseShare = total > 0 ? (baseAssigned / total) * 100 : 0;

  const optEngineers = engineersUsed(plan);
  const baseEngineers = base.engineers_used;

  const optKm = kmTotal(plan);
  const baseKm = base.distance_km_total;

  const optPerOrder = optKm !== null && optAssigned > 0 ? optKm / optAssigned : null;
  const basePerOrder = baseKm !== null && baseAssigned > 0 ? baseKm / baseAssigned : null;

  const assignedDelta = optAssigned - baseAssigned;
  const assignedDeltaPct = baseAssigned > 0 ? (assignedDelta / baseAssigned) * 100 : null;
  const kmDelta = optKm !== null && baseKm !== null ? optKm - baseKm : null;
  const kmDeltaPct = kmDelta !== null && baseKm !== null && baseKm > 0 ? (kmDelta / baseKm) * 100 : null;

  /* Вывод — одной короткой фразой, по тому же числу, ради которого сюда и
     смотрят: сколько заявок разложил оптимизатор сверх простого варианта на
     этом же дне. Проценты и километры уже разложены в таблице ниже —
     повторять их здесь означало бы читать сводку в самой первой строке. */
  const verdict =
    assignedDelta > 0
      ? `Оптимизатор разложил на ${assignedDelta} ${plural(assignedDelta, 'заявку', 'заявки', 'заявок')} больше, чем базовый вариант в этот день`
      : assignedDelta === 0
        ? 'Оптимизатор и базовый вариант разложили в этот день поровну заявок'
        : `В этот день базовый вариант разложил на ${-assignedDelta} ${plural(-assignedDelta, 'заявку', 'заявки', 'заявок')} больше – стоит разобрать почему`;

  return (
    <section className="panel basecmp">
      <div className="dash__section-head">
        <h2 className="dash__section-title">
          Оптимизатор
          <WhyMark text={WHY_TEXT} />
        </h2>
      </div>

      <p className="basecmp__verdict">
        <Icon name={assignedDelta >= 0 ? 'check-circle' : 'warning'} size={16} />
        {verdict}
      </p>

      <div className="basecmp__table">
        <div className="basecmp__row basecmp__row--head">
          <span />
          <span>Оптимизатор</span>
          <span>Базовый</span>
          <span>Разница</span>
        </div>
        <div className="basecmp__row">
          <span className="basecmp__key">Покрытие</span>
          <span className="basecmp__val">
            {optAssigned} · {dec(optShare)}%
          </span>
          <span className="basecmp__val">
            {baseAssigned} · {dec(baseShare)}%
          </span>
          <span className="basecmp__delta">
            {fmtDelta(assignedDelta, 0)} {assignedDeltaPct !== null && `(${fmtDelta(assignedDeltaPct)}%)`}
          </span>
        </div>
        <div className="basecmp__row">
          <span className="basecmp__key">Исполнителей</span>
          <span className="basecmp__val">{optEngineers}</span>
          <span className="basecmp__val">{baseEngineers}</span>
          <span className="basecmp__delta">{fmtDelta(optEngineers - baseEngineers, 0)}</span>
        </div>
        <div className="basecmp__row">
          <span className="basecmp__key">Общий пробег</span>
          <span className="basecmp__val">{optKm !== null ? `${dec(optKm)} км` : '—'}</span>
          <span className="basecmp__val">{baseKm !== null ? `${dec(baseKm)} км` : '—'}</span>
          <span className="basecmp__delta">
            {kmDelta !== null ? `${fmtDelta(kmDelta)} км ${kmDeltaPct !== null ? `(${fmtDelta(kmDeltaPct)}%)` : ''}` : '—'}
          </span>
        </div>
        <div className="basecmp__row">
          <span className="basecmp__key">Средний пробег на заявку</span>
          <span className="basecmp__val">{optPerOrder !== null ? `${dec(optPerOrder, 2)} км` : '—'}</span>
          <span className="basecmp__val">{basePerOrder !== null ? `${dec(basePerOrder, 2)} км` : '—'}</span>
          <span className="basecmp__delta">
            {optPerOrder !== null && basePerOrder !== null ? `${fmtDelta(optPerOrder - basePerOrder, 2)} км` : '—'}
          </span>
        </div>
      </div>

      {/* Базовый вариант — не альтернативный план, который можно взять
          вместо текущего: это контрольная раскладка тем же движком, но без
          оптимизации, нужная только затем, чтобы было с чем сравнить. Кнопки
          здесь не подтверждают расчёт и не пересчитывают его — они дают
          посмотреть на контрольный вариант и унести доказательство наружу.
          Пока никуда не ведут: куда именно — решим отдельно. */}
      <div className="basecmp__actions">
        <Button variant="secondary" size="sm" iconLeft={<Icon name="eye" size={14} />}>
          Открыть базовый вариант
        </Button>
        <Button variant="ghost" size="sm" iconLeft={<Icon name="arrow-up-right" size={14} />}>
          Выгрузить сравнение
        </Button>
      </div>
    </section>
  );
}

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
};

const fmtDelta = (n: number, digits = 1) => {
  const v = dec(Math.abs(n), digits);
  return n > 0 ? `+${v}` : n < 0 ? `−${v}` : v;
};
