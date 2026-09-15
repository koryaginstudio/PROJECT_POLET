/* Адрес страницы как состояние навигации.

   Раньше раздел, вкладка и открытый расчёт жили только в памяти компонента:
   обновление страницы возвращало диспетчера на дашборд, а ссылкой на нужный
   экран поделиться было нечем. Теперь то же самое написано в адресе, и он же
   источник истины — состояние идёт за ним, а не наоборот.

   Формат: #/раздел/вкладка?run=расчёт&plan=шаг. Хэш, а не путь, потому что
   сервер отдаёт один файл и про наши разделы ничего не знает.

   Шаг диспетчерской вынесен в параметр, а не в путь. Он переживает уход в
   другой раздел: открытый расчёт остаётся открытым, пока диспетчер ходит по
   базам, — иначе база помечает его открытым, а диспетчерская встречает
   вопросом «создать или выбрать», и одно противоречит другому. */

import { latestRun, RUNS } from '../data/load.ts';
import type { RunId } from '../data/load.ts';
import { SUBHEADER } from './nav.ts';
import { service } from '../data/service.ts';
import type { SectionId } from './nav.ts';

/** Шаг диспетчерской: спросить расчёт, завести новый или вести открытый. */
export type Stage = 'gate' | 'create' | 'plan';

export interface Route {
  section: SectionId;
  view: string;
  stage: Stage;
  runId: RunId;
}

const SECTIONS = new Set(Object.keys(SUBHEADER));
const isSection = (value: string): value is SectionId => SECTIONS.has(value);

/** Вкладка раздела по умолчанию — первая в подшапке. */
export const firstView = (id: SectionId) => SUBHEADER[id].views[0]?.value ?? '';

const hasView = (id: SectionId, value: string) =>
  SUBHEADER[id].views.some((item) => item.value === value);

/* Расчёты, заведённые кнопкой «Создать расчёт», живут только до перезагрузки:
   после неё в истории их нет, и адрес с таким номером открывает свежий. */
const knownRun = (id: string | null): RunId | null =>
  id && RUNS.some((run) => run.id === id) ? id : null;

/* Шаг в адресе назван по смыслу, а не по внутреннему имени: open — расчёт
   открыт, create — заводят новый. Пусто — диспетчерская спрашивает. */
const STAGE_PARAM: Record<Stage, string> = { gate: '', plan: 'open', create: 'create' };

/* Точка отсчёта навигации. Функция, а не константа: самый свежий расчёт
   становится известен только после того, как приедет архив движка.

   С чего открывается программа — настройка сервиса. Приходят сюда по-разному:
   один смотрит сводку, другой сразу идёт считать, третий возвращается к тому,
   что считал вчера; выбирать за всех троих незачем. */
export const START = (): Route => {
  const from = service().startAt;
  if (from === 'dispatch') {
    return { section: 'dispatch', view: firstView('dispatch'), stage: 'gate', runId: latestRun() };
  }
  if (from === 'last') {
    return { section: 'dispatch', view: firstView('dispatch'), stage: 'plan', runId: latestRun() };
  }
  return { section: 'home', view: '', stage: 'gate', runId: latestRun() };
};

export const sameRoute = (a: Route, b: Route) =>
  a.section === b.section && a.view === b.view && a.stage === b.stage && a.runId === b.runId;

/** Читает адрес. Всё, чего в нём нет или что в нём непонятно, берётся
    по умолчанию: сломанная ссылка открывает дашборд, а не пустой экран. */
export function readRoute(hash: string): Route {
  const [path, query] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  /* Адреса нет вовсе — значит, пришли на голый корень, и это тот случай, ради
     которого настроен стартовый экран. Ссылка с разделом в адресе всегда
     сильнее настройки: ею делятся, и открыться она обязана там, куда ведёт. */
  if (parts.length === 0 && !query) return START();
  const first = parts[0] ?? '';
  const section: SectionId = isSection(first) ? first : 'home';
  const slot = parts[1] ?? '';
  const params = new URLSearchParams(query ?? '');
  const plan = params.get('plan');

  return {
    section,
    view: hasView(section, slot) ? slot : firstView(section),
    stage: plan === 'create' ? 'create' : plan === 'open' ? 'plan' : 'gate',
    runId: knownRun(params.get('run')) ?? latestRun()
  };
}

/** Собирает адрес обратно. Расчёт пишем всегда: день, который читают шапка и
    правая панель, приходит из него в любом разделе. */
export function writeRoute(route: Route): string {
  const slot = route.view ? '/' + route.view : '';
  const stage = STAGE_PARAM[route.stage];
  return `#/${route.section}${slot}?run=${route.runId}` + (stage ? `&plan=${stage}` : '');
}
