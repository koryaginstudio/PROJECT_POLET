/* Общие детали разрезов статистики.

   Разрезов семь, и в каждом одни и те же три движения: назвать блок, показать
   ранжированный перечень («кто больше всех») и приложить показатель к норме.
   Написанные в каждом разрезе по-своему, они читались бы как семь разных
   экранов одного раздела. */

import type { ReactNode } from 'react';
import { Icon } from '../../ds/components/core/Icon.jsx';
import type { Distribution } from '../../data/derive.ts';
import { dec } from '../../data/derive.ts';

/** Доля в процентах — одним правилом на весь раздел. Один знак после
    запятой: «74 %» и «74,3 %» в соседних блоках читались бы как разная
    точность счёта, а счёт один. */
export const percent = (share: number) => `${dec(share * 100)} %`;

/** Заголовок блока: имя слева, тихая строка-пояснение справа. Тот же приём,
    что в диспетчерской и в базах. */
export function StatsHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="dash__section-head">
      <h2 className="dash__section-title">{title}</h2>
      {note && <span className="dash__section-note">{note}</span>}
    </div>
  );
}

/* ─── ранжированный перечень ─────────────────────────────────────────────

   «Кто больше всех» — единственный вопрос, на который диаграмма не отвечает.
   Столбцы показывают, как разложено целое; перечень называет тех, кто это
   целое набрал: адрес, инженера, услугу — с именем, числом и полосой, по
   которой видно, насколько первый оторвался от третьего.

   Полоса мерится от первой строки, а не от суммы: доля от суммы у восьми
   строк из двухсот даёт восемь ниточек одинаковой длины, и перечень
   перестаёт отвечать на «насколько больше».

   Полоса и число в строке говорят об одном. Там, где перечень называет
   слабых, полоса меряет тот же показатель, что и число: короткая красная
   полоса и есть «мало». Считать её от недостачи значило бы рисовать самую
   длинную полосу у худшей строки и ставить рядом самое маленькое число. */

export interface RankRow {
  key: string;
  label: string;
  /** Тихая строка под именем: чем эта запись ещё отличается. */
  note?: ReactNode;
  value: number;
  /** Число, как его читают: «4,2 ч», «18 заявок», «74 %». */
  text: string;
  /** Красить полосу тревожно: строка не «больше всех», а «хуже всех». */
  bad?: boolean;
  onOpen?: () => void;
}

export function StatRank({
  title,
  note,
  rows,
  limit = 8,
  empty = 'Считать пока нечего.'
}: {
  title: string;
  note?: ReactNode;
  rows: RankRow[];
  limit?: number;
  empty?: string;
}) {
  const shown = rows.slice(0, limit);
  const top = Math.max(...shown.map((row) => Math.abs(row.value)), 1);

  return (
    <div className="srank">
      <div className="srank__head">
        <h3 className="srank__title">{title}</h3>
        {note && <span className="srank__note">{note}</span>}
      </div>

      {shown.length === 0 ? (
        <p className="srank__empty">{empty}</p>
      ) : (
        <ol className="srank__list">
          {shown.map((row, index) => (
            <li key={row.key} className="srank__row">
              <span className="srank__place">{index + 1}</span>
              <span className="srank__body">
                <span className="srank__label">
                  {row.onOpen ? (
                    <button type="button" className="dash__section-link" onClick={row.onOpen}>
                      {row.label}
                    </button>
                  ) : (
                    row.label
                  )}
                </span>
                <span className="srank__track">
                  <span
                    className={'srank__fill' + (row.bad ? ' srank__fill--bad' : '')}
                    style={{ width: `${Math.max(2, (Math.abs(row.value) / top) * 100)}%` }}
                  />
                </span>
                {row.note && <span className="srank__sub">{row.note}</span>}
              </span>
              <span className="srank__value">{row.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ─── показатель против нормы ────────────────────────────────────────────

   Число само по себе не говорит, хорошо это или плохо: «загрузка 82 %» читают
   как успех, пока не знают, что выше 75 % смена стоит на пределе и первая же
   пробка съедает запас. Поэтому полоса показывает не одно значение, а зоны —
   где норма, где стоит присмотреться, где плохо, — и метку, где мы сейчас.

   Границы зон берутся из настроек сервиса, а не пишутся здесь числами: порог,
   по которому интерфейс называет число проблемой, — настройка рабочего места,
   и она уже есть. */

export interface Band {
  /** Правая граница зоны в тех же единицах, что и значение. */
  to: number;
  tone: 'ok' | 'warn' | 'bad';
}

export function StatGauge({
  label,
  value,
  text,
  bands,
  scale,
  note
}: {
  label: string;
  value: number;
  text: string;
  bands: Band[];
  /** Чему равен конец полосы. Для долей — единица, для часов — своё. */
  scale: number;
  note?: ReactNode;
}) {
  const at = Math.max(0, Math.min(1, value / scale));
  let left = 0;
  const zones = bands.map((band) => {
    const width = Math.max(0, Math.min(1, band.to / scale) - left);
    const zone = { ...band, left, width };
    left += width;
    return zone;
  });
  /* В какой зоне оказались — тем и красим само число: полоса отвечает «где
     это на шкале», а число обязано сказать «и что это значит». */
  const tone = bands.find((band) => value <= band.to)?.tone ?? bands[bands.length - 1]?.tone ?? 'ok';

  return (
    <div className="sgauge">
      <div className="sgauge__head">
        <span className="sgauge__label">{label}</span>
        <span className={'sgauge__value sgauge__value--' + tone}>{text}</span>
      </div>
      <div className="sgauge__track">
        {zones.map((zone) => (
          <span
            key={zone.tone + zone.to}
            className={'sgauge__zone sgauge__zone--' + zone.tone}
            style={{ left: `${zone.left * 100}%`, width: `${zone.width * 100}%` }}
          />
        ))}
        <span className="sgauge__mark" style={{ left: `${at * 100}%` }} aria-hidden="true" />
      </div>
      {note && <span className="sgauge__note">{note}</span>}
    </div>
  );
}

/* ─── счётчики в распределение ───────────────────────────────────────────

   Итоги по видам работ, навыкам и районам приходят готовыми счётчиками, а
   полосы рисуются из распределения. Собираем распределение из счётчиков:
   каждая категория сама по себе, совмещений здесь нет, и полоса сплошная. */

export function tallyToDistribution(
  rows: { key: string; count: number }[],
  labelOf: (key: string) => string
): Distribution {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const ordered = [...rows].sort((a, b) => b.count - a.count);
  return {
    total,
    slices: ordered.map((row) => ({
      key: row.key,
      label: labelOf(row.key),
      count: row.count,
      ids: [],
      categoryKeys: [row.key]
    })),
    categories: ordered.map((row) => ({
      key: row.key,
      label: labelOf(row.key),
      count: row.count,
      ids: []
    })),
    overlapping: 0,
    categorySum: total
  };
}

/** Счётчики из списка по признаку: одна строка вместо шести одинаковых
    циклов «сложить по ключу» в шести разрезах. */
export function countBy<T>(rows: T[], keyOf: (row: T) => string | null | undefined) {
  const map = new Map<string, number>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

/* ─── за срок ничего не посчитано ────────────────────────────────────────

   Пустой разрез объясняет не «здесь ничего нет», а почему: срок выбран такой,
   что в него не попал ни один расчёт. Совет — вернуться на «Всё время», и
   это же кнопка: сказать, что делать, и не дать это сделать, — полработы. */

export function StatsBlank({ filter, onAll }: { filter?: ReactNode; onAll: () => void }) {
  return (
    <section className="panel">
      {/* Переключатель срока остаётся на месте: он же и вывел сюда, им же
          отсюда и выходят. Без него единственной дорогой назад была бы кнопка
          «за всё время», а промежуточные сроки — месяц, квартал — оказались бы
          недоступны, пока не пройдёшь через историю целиком. */}
      {filter && <div className="statsblank__bar">{filter}</div>}
      <div className="emptynote">
        <p className="emptynote__title">За этот срок расчётов нет</p>
        <span>
          Статистика считается по посчитанным расчётам, а в выбранный срок не попал ни один.
        </span>
        <button type="button" className="fdrop__btn statsblank__back" onClick={onAll}>
          <Icon name="clock" size={12} />
          Показать за всё время
        </button>
      </div>
    </section>
  );
}
