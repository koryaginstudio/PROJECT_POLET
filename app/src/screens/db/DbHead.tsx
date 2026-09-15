import type { ReactNode } from 'react';

interface Stat {
  label: string;
  value: ReactNode;
}

interface Props {
  title: string;
  /** Действие раздела — справа от заголовка, на месте снятой пометки. Не у
      всех: в большинстве баз заводить нечего, они собраны из расчётов. */
  action?: ReactNode;
  /** Одна строка о разделе. Не у всех: там, где раздел говорит сам за себя,
      абзац только отодвигает содержимое вниз. */
  lede?: ReactNode;
  /** Числа раздела строкой. Там, где база отдала этот ряд доске виджетов,
      его нет вовсе: два ряда чисел об одном и том же спорили бы друг с другом. */
  stats?: Stat[];
  /** Доска виджетов на месте чисел: тот же ряд, но набирает его диспетчер. */
  board?: ReactNode;
}

/* Общая шапка баз данных. Одинаковая у всех: заголовок, строка о разделе и
   цифры.

   Плашки «Все расчёты» здесь нет: она повторяла то, что и так сказано в
   строке о разделе, и делала это в каждой базе. Перечня расчётов, из которых
   раздел собран, тоже нет — два десятка одинаковых плашек с номером и датой
   занимали половину экрана и ничего к разделу не добавляли; какие расчёты
   есть, видно в самой базе расчётов. */
export function DbHead({ title, action, lede, stats, board }: Props) {
  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">{title}</h2>
        {action}
      </div>

      {lede && <p className="clients__lede">{lede}</p>}

      {/* Либо ряд чисел, выбранный за диспетчера, либо доска, которую он
          набрал сам. Вместе они не встают: это одно и то же место экрана и
          один и тот же вопрос — «что тут вообще есть». */}
      {board ?? (
        stats &&
        stats.length > 0 && (
          <div className="dbstats">
            {stats.map((stat) => (
              <div key={stat.label} className="dbstat">
                <span className="dbstat__value">{stat.value}</span>
                <span className="dbstat__label">{stat.label}</span>
              </div>
            ))}
          </div>
        )
      )}
    </section>
  );
}
