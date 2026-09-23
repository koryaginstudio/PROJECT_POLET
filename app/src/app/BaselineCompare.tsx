import { Icon } from '../ds/components/core/Icon.jsx';
import type { Day } from '../data/contract.ts';
import { dec, engineersUsed, kmTotal } from '../data/derive.ts';

interface Props {
  day: Day;
}

/* Оптимизатор против базового варианта — обязательное сравнение ТЗ,
   не сравнение между собой двух посчитанных дней. У «Сравнения расчётов»
   разные дни расходятся числом заявок, зоной, датой — и который лучше
   разложил по абсолютным числам, вопрос без ответа: R003 на 56 заявках
   не сравнить с R002 на 83. Здесь сравнение по построению на одном и том
   же наборе: `plan.meta.baseline` — тот же день, тот же список заявок и
   инженеров, посчитанный движком второй раз, жадным способом вместо
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

  /* Вывод — одной фразой, по тому же числу, ради которого сюда и смотрят:
     сколько заявок разложил оптимизатор сверх того, что взял бы жадный
     перебор на этом же дне. */
  const verdict =
    assignedDelta > 0
      ? `Оптимизатор разложил на ${assignedDelta} ${plural(assignedDelta, 'заявку', 'заявки', 'заявок')} больше, чем жадный перебор на этом же дне` +
        (assignedDeltaPct !== null ? ` — на ${dec(assignedDeltaPct)}%` : '') +
        (kmDelta !== null
          ? kmDelta <= 0
            ? `, и пробег при этом не вырос`
            : `, ценой ${dec(kmDelta)} км пробега сверху`
          : '')
      : assignedDelta === 0
        ? 'Оптимизатор и жадный перебор разложили на этом дне поровну заявок' +
          (kmDelta !== null && kmDelta < 0 ? `, но оптимизатор проехал на ${dec(-kmDelta)} км меньше` : '')
        : `На этом дне жадный перебор разложил на ${-assignedDelta} ${plural(-assignedDelta, 'заявку', 'заявки', 'заявок')} больше — стоит разобрать почему`;

  return (
    <section className="panel basecmp">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Оптимизатор против базового варианта</h2>
        <span className="dash__section-note">
          тот же день, та же выгрузка — {base.solver === 'greedy' ? 'жадный перебор' : base.solver}
        </span>
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
          <span className="basecmp__key">Назначено</span>
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
