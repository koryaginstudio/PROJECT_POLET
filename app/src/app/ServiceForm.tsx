import { Icon } from '../ds/components/core/Icon.jsx';
import { Lede } from './Lede.tsx';
import { Button } from '../ds/components/core/Button.jsx';
import { hhmm } from '../data/derive.ts';
import {
  resetService,
  SERVICE_DEFAULTS,
  servicePatched,
  setService,
  useService
} from '../data/service.ts';
import type { Thresholds } from '../data/service.ts';

/* Полный список настроек сервиса: границы смены и пороги, по которым интерфейс
   называет число проблемой.

   Про каждый порог сказано, где он виден. Иначе настройка превращается в
   угадайку: диспетчер двигает «неравномерность» и не знает, что именно на
   экране от этого изменится. Пороги при этом подсказка, а не оценка плана —
   движок про них не знает, и расчёт от них не меняется ни на заявку. */

interface Limit {
  key: keyof Thresholds;
  label: string;
  /** Где этот порог виден на экране. */
  where: string;
  unit: string;
  step: number;
  min: number;
  max: number;
  /** Порог сравнивается «меньше — хуже», а не «больше — хуже». */
  lower?: boolean;
}

const LIMITS: { title: string; note: string; rows: Limit[] }[] = [
  {
    title: 'Покрытие',
    note: 'Точка у числа «Покрытие» на пульте расчёта',
    rows: [
      { key: 'coverageBad', label: 'Ниже этого — плохо', where: 'красная точка', unit: '%', step: 1, min: 0, max: 100, lower: true },
      { key: 'coverageWatch', label: 'Ниже этого — присмотреться', where: 'жёлтая точка', unit: '%', step: 1, min: 0, max: 100, lower: true }
    ]
  },
  {
    title: 'Загрузка инженера',
    note: 'Квадрат «Проблемные» на доске инженеров, доля «Проблема» в кольце и разбор «Загрузка выше N %»',
    rows: [
      { key: 'occupancy', label: 'От этого — перегруз', where: 'инженер попадает в проблемные', unit: '%', step: 1, min: 10, max: 100 }
    ]
  },
  {
    title: 'Общий простой',
    note: 'Точка у числа «Общий простой». Считается долей от всего рабочего времени смены',
    rows: [
      { key: 'idleBad', label: 'Выше этого — плохо', where: 'красная точка', unit: '%', step: 1, min: 0, max: 100 },
      { key: 'idleWatch', label: 'Выше этого — присмотреться', where: 'жёлтая точка', unit: '%', step: 1, min: 0, max: 100 }
    ]
  },
  {
    title: 'Разрыв загрузки',
    note: 'Точка у числа «Разрыв загрузки»: во сколько раз самый загруженный инженер загружен сильнее самого свободного',
    rows: [
      { key: 'gapBad', label: 'От этого — плохо', where: 'красная точка', unit: '×', step: 0.1, min: 1, max: 20 },
      { key: 'gapWatch', label: 'От этого — присмотреться', where: 'жёлтая точка', unit: '×', step: 0.1, min: 1, max: 20 }
    ]
  },
  {
    title: 'Неравномерность',
    note: 'Точка у числа «Неравномерность»: насколько нагрузка разошлась между инженерами. Ноль — у всех поровну, единица — вся работа у одного',
    rows: [
      { key: 'giniBad', label: 'Выше этого — плохо', where: 'красная точка', unit: '', step: 0.01, min: 0, max: 1 },
      { key: 'giniWatch', label: 'Выше этого — присмотреться', where: 'жёлтая точка', unit: '', step: 0.01, min: 0, max: 1 }
    ]
  }
];

/** Минуты в «ЧЧ:ММ» для поля времени и обратно. */
const toField = (minutes: number) => hhmm(minutes);
const fromField = (value: string): number | null => {
  const parts = value.split(':');
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
};

export function ServiceForm() {
  const settings = useService();
  const patched = servicePatched();
  const limits = settings.thresholds;

  return (
    <>
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Настройки сервиса</h2>
          <span className="dash__section-note">
            {patched > 0 ? `${patched} уведено от заводских` : 'всё заводское'}
          </span>
        </div>
        <Lede first="Границы рабочего дня и пороги, по которым интерфейс называет число проблемой.">
          Это не правила расчёта: правила отвечают на вопрос «как раскладывать» и меняют план.
          Расчёт от этих настроек не меняется ни на заявку — меняется то, что мы считаем нормой.
          Хранится в браузере: это настройка рабочего места, программа расчёта про неё не знает.
        </Lede>
        {patched > 0 && (
          <div className="srvform__reset">
            <Button variant="secondary" size="sm" onClick={resetService}>
              Вернуть всё заводское
            </Button>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Рабочий день</h2>
          <span className="dash__section-note">
            смена {toField(settings.dayStart)}–{toField(settings.dayEnd)}
          </span>
        </div>
        <p className="clients__lede">
          На эти границы встают шкала времени, доска по этапам, воронка этапов и признак «окно уже открыто».
          Заводские 07:00–21:00 — из контракта стенда; смена с ночными бригадами в них не
          укладывается.
        </p>

        <div className="srvrow">
          <span className="srvrow__key">
            Начало смены
            <span className="srvrow__where">левый край всех шкал времени</span>
          </span>
          <input
            className="srvrow__time"
            type="time"
            value={toField(settings.dayStart)}
            onChange={(event) => {
              const minutes = fromField(event.currentTarget.value);
              if (minutes !== null) setService({ dayStart: minutes });
            }}
          />
        </div>

        <div className="srvrow">
          <span className="srvrow__key">
            Конец смены
            <span className="srvrow__where">правый край шкал; после него инженер не работает</span>
          </span>
          <input
            className="srvrow__time"
            type="time"
            value={toField(settings.dayEnd)}
            onChange={(event) => {
              const minutes = fromField(event.currentTarget.value);
              if (minutes !== null) setService({ dayEnd: minutes });
            }}
          />
        </div>

        <div className="srvform__hint">
          <Icon name="info" size={14} />
          <span>
            Конец держится минимум в двух часах от начала: смена короче — это не настройка, а
            опечатка. Данные при этом остаются как есть: если расчёт поставил заявку за пределами
            новых границ, шкала его прижмёт к краю, а не спрячет.
          </span>
        </div>
      </section>

      {LIMITS.map((group) => (
        <section key={group.title} className="panel">
          <div className="dash__section-head">
            <h2 className="dash__section-title">{group.title}</h2>
          </div>
          <p className="clients__lede">{group.note}</p>

          {group.rows.map((row) => {
            const value = limits[row.key];
            const base = SERVICE_DEFAULTS.thresholds[row.key];
            return (
              <div key={row.key} className="srvrow">
                <span className="srvrow__key">
                  {row.label}
                  <span className="srvrow__where">{row.where}</span>
                </span>
                <span className="srvrow__set">
                  {value !== base && (
                    <button
                      type="button"
                      className="srvrow__back"
                      onClick={() => setService({ thresholds: { ...limits, [row.key]: base } })}
                      title={`Вернуть заводское: ${base}${row.unit}`}
                    >
                      было {base}
                      {row.unit}
                    </button>
                  )}
                  <input
                    className="srvrow__num"
                    type="number"
                    value={value}
                    step={row.step}
                    min={row.min}
                    max={row.max}
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      if (!Number.isFinite(next)) return;
                      setService({
                        thresholds: {
                          ...limits,
                          [row.key]: Math.min(row.max, Math.max(row.min, next))
                        }
                      });
                    }}
                  />
                  {row.unit && <span className="srvrow__unit">{row.unit}</span>}
                </span>
              </div>
            );
          })}
        </section>
      ))}

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Как показывать</h2>
        </div>

        <div className="srvrow">
          <span className="srvrow__key">
            Часы
            <span className="srvrow__where">таблицы, карточки, виджеты баз</span>
          </span>
          <span className="srvform__pills">
            <button
              type="button"
              className={'svc__pill' + (settings.hours === 'decimal' ? ' svc__pill--on' : '')}
              onClick={() => setService({ hours: 'decimal' })}
            >
              4,9 ч
            </button>
            <button
              type="button"
              className={'svc__pill' + (settings.hours === 'words' ? ' svc__pill--on' : '')}
              onClick={() => setService({ hours: 'words' })}
            >
              4 ч 54 мин
            </button>
          </span>
        </div>

        <div className="srvrow">
          <span className="srvrow__key">
            Карточек в строке
            <span className="srvrow__where">с чего открывается база расчётов</span>
          </span>
          <span className="srvform__pills">
            {(['2', '4', '6'] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={'svc__pill' + (settings.perRow === value ? ' svc__pill--on' : '')}
                onClick={() => setService({ perRow: value })}
              >
                {value}
              </button>
            ))}
          </span>
        </div>

        <div className="srvrow">
          <span className="srvrow__key">
            Статистика над базой
            <span className="srvrow__where">с чем открываются базы данных</span>
          </span>
          {/* Не «показывать или нет», а «раскрыта или свёрнута»: доска на месте
              в обоих случаях, разница в том, ждёт она вопроса или отвечает
              сразу. Свёрнутая — заводское: в базу приходят за записями, а
              сводка над ними занимает полэкрана до первой карточки. */}
          <span className="srvform__pills">
            {(
              [
                { value: 'hidden', label: 'Свёрнута' },
                { value: 'open', label: 'Раскрыта' }
              ] as const
            ).map((item) => (
              <button
                key={item.value}
                type="button"
                className={'svc__pill' + (settings.dbStats === item.value ? ' svc__pill--on' : '')}
                onClick={() => setService({ dbStats: item.value })}
              >
                {item.label}
              </button>
            ))}
          </span>
        </div>

        <div className="srvrow">
          <span className="srvrow__key">
            Виджеты баз
            <span className="srvrow__where">наборы плиток над каждой базой</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              /* Снимаем только наборы плиток — остальные настройки рабочего
                 места не трогаем: «вернуть виджеты» и «вернуть всё» это разные
                 просьбы, и путать их нельзя. */
              if (typeof localStorage === 'undefined') return;
              for (const key of Object.keys(localStorage)) {
                if (key.startsWith('polet.widgets.')) localStorage.removeItem(key);
              }
              window.location.reload();
            }}
          >
            Вернуть стандартный набор
          </Button>
        </div>
      </section>
    </>
  );
}
