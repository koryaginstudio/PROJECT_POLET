import { useState } from 'react';
import type { Distribution } from '../data/derive.ts';

interface Props {
  title: string;
  distribution: Distribution;
  /** Слово для чисел в подсказке: «12 заявок» / «12 инженеров». */
  unit: (n: number) => string;
  /** Отдаёт категорию целиком: подпись для заголовка списка и номера. */
  onPick?: (category: { label: string; ids: string[] }) => void;
}

/* Виды работ и навыки пересекаются: инженер с тремя навыками попадает в три
   строки. Круг такое врать не умеет — доли обязаны складываться в целое, —
   поэтому здесь полосы: каждая меряется от общего числа независимо, и сумма
   строк больше сотни никого не обманывает.

   Но и молчать про совмещения нельзя, иначе «9 подключений» и «7 ремонтов»
   читаются как 16 разных инженеров. Поэтому полоса делится: сплошная часть —
   те, у кого только эта услуга, штриховка — те, кто попал ещё куда-то. */
export function BarChart({ title, distribution, unit, onPick }: Props) {
  const [hovered, setHovered] = useState<string | null>(null);
  const base = Math.max(distribution.total, 1);

  /* Разбор стыков берём из тех же непересекающихся сочетаний, из которых
     строится кольцо: одна арифметика на оба представления. */
  const soloOf = new Map<string, number>();
  const mixOf = new Map<string, { label: string; count: number }[]>();
  for (const slice of distribution.slices) {
    if (slice.categoryKeys.length === 1) {
      soloOf.set(slice.categoryKeys[0], slice.count);
      continue;
    }
    for (const key of slice.categoryKeys) {
      mixOf.set(key, [...(mixOf.get(key) ?? []), { label: slice.label, count: slice.count }]);
    }
  }

  return (
    <div className="bars">
      <div className="bars__head">
        <h3 className="bars__title">{title}</h3>
      </div>

      <ul className="bars__list">
        {distribution.categories.map((category, index) => {
          const share = (category.count / base) * 100;
          const solo = soloOf.get(category.key) ?? 0;
          const mixed = category.count - solo;
          const mixes = (mixOf.get(category.key) ?? []).sort((a, b) => b.count - a.count);
          const clickable = Boolean(onPick) && category.ids.length > 0;
          const inner = (
            <>
              <span className="bars__label">{category.label}</span>
              <span className="bars__track">
                {/* Только эта услуга — сплошным цветом. */}
                <span
                  className="bars__fill"
                  style={{
                    width: `${(solo / base) * 100}%`,
                    background: `var(--series-${(index % 8) + 1})`
                  }}
                />
                {/* Совмещения — штриховкой тем же цветом: длина полосы
                    по-прежнему равна всей категории, но видно, что её хвост
                    поделён с соседними строками. */}
                {mixed > 0 && (
                  <span
                    className="bars__fill bars__fill--mixed"
                    style={{
                      width: `${(mixed / base) * 100}%`,
                      color: `var(--series-${(index % 8) + 1})`
                    }}
                  />
                )}
              </span>
              <span className="bars__value">{category.count}</span>
              <span className="bars__pct">{Math.round(share)}%</span>
              {mixed > 0 && (
                <span className="bars__tip" role="tooltip">
                  <span className="bars__tip-line">
                    {unit(solo)} — только {category.label.toLowerCase()}
                  </span>
                  {mixes.map((mix) => (
                    <span className="bars__tip-line" key={mix.label}>
                      {mix.count} — вместе: {mix.label.toLowerCase()}
                    </span>
                  ))}
                </span>
              )}
            </>
          );
          return (
            <li
              key={category.key}
              className={'bars__row' + (hovered === category.key ? ' bars__row--on' : '')}
              onMouseEnter={() => setHovered(category.key)}
              onMouseLeave={() => setHovered(null)}
            >
              {clickable ? (
                <button type="button" className="bars__btn" onClick={() => onPick!(category)}>
                  {inner}
                </button>
              ) : (
                <span className="bars__btn bars__btn--static">{inner}</span>
              )}
            </li>
          );
        })}
      </ul>

    </div>
  );
}
