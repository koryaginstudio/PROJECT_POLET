/* Переменные движка, которые задают при создании расчёта.

   Это не настройки интерфейса, а входные данные солвера: они меняют то, как
   он взвешивает варианты, а не то, как мы их показываем. Дефолты — те, что
   стоят в движке; замеры в подписях — те, что мы получили на прогонах, и
   написаны они только там, где действительно измерены.

   Диспетчер не мыслит в единицах штрафа, поэтому наружу выходят не сырые
   числа, а то, что от них меняется: «держаться за объявленный план» вместо
   «churn_penalty = 120». Число под подписью остаётся — инженеру движка оно
   нужно, — но решение принимается по словам. */

export interface EngineParams {
  /** Штраф за то, что визит из уже объявленного плана переехал к другому
      инженеру или выпал. 0 — план свободно перетасовывается. */
  churn_penalty: number;
  /** Множитель длительности работ при планировании. Не меняет реальную
      длительность визита — меняет то, сколько солвер под неё закладывает. */
  duration_factor: number;
  /** Зазор перед каждым следующим визитом: base + step × √(номер визита). */
  buffer_step: number;
  buffer_base: number;
  /** Вес равномерности загрузки. Штраф растёт как квадрат загруженности
      инженера, поэтому догружать самого занятого становится невыгодно. */
  balance_weight: number;
}

/** Заводские значения — те, что стоят в самом движке. Точка отсчёта: они не
    меняются, и именно с ними сравнивается всё, что задал человек.

    Сверено с движком: `BUFFER_STEP` и `BALANCE_WEIGHT` в `solvers/improved.py`,
    `CHURN_PENALTY` в `server.py`, остальные — умолчания `Params`. Раньше здесь
    стояла консервативность 7 при шестнадцати в движке, и форма называла
    заводским то, чего в движке нет. Со штрафом за смену исполнителя вышло так
    же: здесь стоял ноль, в каталоге настроек сорок, и «по умолчанию» на двух
    экранах значило разное. Сорок — то, что стоит в самом движке и на чём
    снят замер стабильности; каталог берёт число отсюда. */
export const ENGINE_DEFAULTS: EngineParams = {
  churn_penalty: 40,
  duration_factor: 1.0,
  buffer_step: 16,
  buffer_base: 0,
  balance_weight: 8.0
};

/* ─── две природы переменных ─────────────────────────────────────────────

   Пять рычагов движка делятся не по важности, а по тому, кто и как часто их
   трогает. Смешивать их в одной форме нельзя: диспетчер, который каждый день
   подбирает запас времени, не должен на том же экране случайно поменять
   правило, действующее на все расчёты сразу.

   **Диспетчерские** меняют от расчёта к расчёту на одних и тех же данных:
   получить другой план того же дня — плотнее или осторожнее, ровнее или
   с большим покрытием. Живут в форме нового расчёта и в ручном управлении,
   показаны словами и ползунками: решение принимается по смыслу, а не по
   величине штрафа.

   **Правила движка** — то, как он вообще устроен. Живут в настройках сырыми
   числами и применяются ко всем следующим расчётам. Числами, а не ползунками,
   намеренно: сюда заходит тот, кто знает, что такое `churn_penalty`, и ему
   нужна точная величина, а не «примерно посередине». */

export const DISPATCH_KNOBS = ['duration_factor', 'buffer_step', 'balance_weight'] as const;
export const ENGINE_RULES = ['churn_penalty', 'buffer_base'] as const;

export type DispatchKnob = (typeof DISPATCH_KNOBS)[number];
export type EngineRule = (typeof ENGINE_RULES)[number];

/** Границы, которые принимает движок. Он же отвечает 400 на выход за них,
    поэтому числа здесь те же самые — расходиться им нельзя. */
export const LIMITS: Record<keyof EngineParams, { min: number; max: number; step: number }> = {
  churn_penalty: { min: 0, max: 1000, step: 1 },
  duration_factor: { min: 0.5, max: 2, step: 0.05 },
  buffer_step: { min: 0, max: 120, step: 1 },
  buffer_base: { min: 0, max: 240, step: 1 },
  balance_weight: { min: 0, max: 100, step: 0.5 }
};

/** Как переменная называется на языке диспетчера и что она значит. */
export const RULE_TITLES: Record<EngineRule, { label: string; what: string }> = {
  churn_penalty: {
    label: 'Штраф за смену исполнителя',
    what: 'Насколько движок сохраняет объявленный план при пересчёте. Ноль — план перестраивается свободно.'
  },
  buffer_base: {
    label: 'Зазор до первого визита, мин',
    what: 'Запас перед первым визитом маршрута. Как правило, не требуется.'
  }
};

/* ─── значения по умолчанию для новых расчётов ───────────────────────────

   Форма нового расчёта открывается не заводскими числами, а теми, что задал
   диспетчер в настройках: если смена из месяца в месяц требует запаса
   побольше, выставлять его на каждый расчёт руками — работа впустую.

   Хранит их браузер: сервера у нас пока нет. Заводские при этом остаются
   нетронутыми, и вернуться к ним можно одним щелчком. */

/* v2: заводской штраф за смену исполнителя стал 40 — сохранённый у людей 0
   из v1 иначе пережил бы правку. */
const DEFAULTS_KEY = 'polet.engine-defaults.v2';

function readDefaults(): EngineParams {
  if (typeof localStorage === 'undefined') return { ...ENGINE_DEFAULTS };
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (!raw) return { ...ENGINE_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<EngineParams>;
    /* Читаем по одному полю: в записи из прошлой версии может не быть
       какого-то рычага, и подставить туда undefined — сломать движок. */
    return {
      churn_penalty: Number.isFinite(parsed.churn_penalty)
        ? (parsed.churn_penalty as number)
        : ENGINE_DEFAULTS.churn_penalty,
      duration_factor: Number.isFinite(parsed.duration_factor)
        ? (parsed.duration_factor as number)
        : ENGINE_DEFAULTS.duration_factor,
      buffer_step: Number.isFinite(parsed.buffer_step)
        ? (parsed.buffer_step as number)
        : ENGINE_DEFAULTS.buffer_step,
      buffer_base: Number.isFinite(parsed.buffer_base)
        ? (parsed.buffer_base as number)
        : ENGINE_DEFAULTS.buffer_base,
      balance_weight: Number.isFinite(parsed.balance_weight)
        ? (parsed.balance_weight as number)
        : ENGINE_DEFAULTS.balance_weight
    };
  } catch {
    return { ...ENGINE_DEFAULTS };
  }
}

let defaults: EngineParams = readDefaults();

/** С чего открывается форма нового расчёта. */
export const engineDefaults = (): EngineParams => ({ ...defaults });

export function setEngineDefaults(next: EngineParams): void {
  defaults = { ...next };
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults));
  } catch {
    /* Хранилище может быть закрыто настройками браузера: значения тогда
       живут до перезагрузки. */
  }
}

export function resetEngineDefaults(): void {
  defaults = { ...ENGINE_DEFAULTS };
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(DEFAULTS_KEY);
  } catch {
    /* см. выше */
  }
}

/** Стоят ли сейчас заводские значения. */
export const isFactoryDefaults = () =>
  JSON.stringify(defaults) === JSON.stringify(ENGINE_DEFAULTS);

export interface ChurnPreset {
  value: string;
  label: string;
  penalty: number;
  what: string;
  /** Замер показываем только там, где он есть: сочинять проценты для
      остальных пресетов нельзя — настоящий приходит полем stability в
      ответе движка, уже после пересчёта. */
  measured?: string;
}

export const CHURN_PRESETS: ChurnPreset[] = [
  {
    value: 'stable',
    label: 'Максимально стабильно',
    penalty: 120,
    what: 'План сохраняется максимально полно, даже в ущерб небольшому выигрышу по покрытию.'
  },
  {
    value: 'balanced',
    label: 'Сбалансированно',
    penalty: ENGINE_DEFAULTS.churn_penalty,
    what: 'Аварийные заявки размещаются, остальной план по возможности сохраняется.',
    measured: '86–89% визитов сохраняют исполнителя'
  },
  {
    value: 'rebuild',
    label: 'Пересобрать заново',
    penalty: 0,
    what: 'План остатка дня перестраивается свободно ради максимального покрытия.'
  }
];

export const churnPreset = (penalty: number): ChurnPreset =>
  CHURN_PRESETS.find((preset) => preset.penalty === penalty) ?? CHURN_PRESETS[1];

/** Подпись под ползунком запаса по времени. Замер есть только про 1.25 —
    остальное описываем направлением, а не выдуманными цифрами. */
export function durationHint(factor: number): string {
  if (factor < 0.95) return 'Планирование плотнее оценки: визитов больше, риск опозданий выше.';
  if (factor < 1.05) return 'Планирование строго по оценке длительности работ.';
  if (factor < 1.35) return 'Рекомендуемый диапазон: покрытие сохраняется, срывов окна втрое меньше.';
  return 'Значительный запас времени: покрытие снижается.';
}

/** Консервативность маршрута выражена одним числом — шагом запаса. База
    остаётся нулём: перед первым визитом накапливаться ещё нечему. */
export function bufferHint(step: number): string {
  if (step === 0) return 'Зазор отсутствует: опоздание переносится на следующий визит целиком.';
  if (step <= 4) return 'Небольшой зазор: маршрут плотный, отклонения компенсируются слабо.';
  if (step <= 10) return `Умеренный зазор: к пятому визиту — ${Math.round(step * Math.sqrt(5))} мин.`;
  return `Осторожный маршрут: к пятому визиту — ${Math.round(step * Math.sqrt(5))} мин, визитов в день меньше.`;
}

export function balanceHint(weight: number): string {
  if (weight === 0) return 'Выравнивание отключено: приоритет у покрытия, часть инженеров может простаивать.';
  if (weight < 5) return 'Слабое выравнивание: разброс загрузки остаётся заметным.';
  if (weight <= 12) return 'Рекомендуемый диапазон: загрузка выравнивается, покрытие сохраняется.';
  return 'Жёсткое выравнивание: загрузка ровная, часть заявок может не разместиться.';
}
