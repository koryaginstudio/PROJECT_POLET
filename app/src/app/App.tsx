import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Day } from '../data/contract.ts';
import {
  adoptEngineRun,
  ContractError,
  createRun,
  deleteRun,
  updateRun,
  latestRun,
  loadDay,
  loadSummaries,
  engineReady,
  engineDayTitle,
  loadPlaces,
  runCode,
  runEntry,
  RUNS
} from '../data/load.ts';
import { engineDefaults } from '../data/engine.ts';
import type { EngineParams } from '../data/engine.ts';
import type { RunId, DaySummary, Place, SourceId } from '../data/load.ts';
import { exportRun } from '../data/report.ts';
import { adoptJournal, loadDayState, postEvent, replanDay, saveReplan } from '../data/api.ts';
import type { DayState, JournalEvent } from '../data/api.ts';
import type { DispatcherActions } from './DispatcherBlock.tsx';
import { изДвижка } from '../data/fromEngine.ts';
import type { IncidentKind, IncidentSpec, ReplanResult } from '../data/api.ts';
import { engineerInDay, loadRegistry } from '../data/registry.ts';
import type { ShiftInput } from '../data/shift.ts';
import type { Registry, RunRef } from '../data/registry.ts';
import { buildDayView, dayEnd, dayStart, planHorizon, plural, replanAt } from '../data/derive.ts';
import { setPlanHorizon, useService } from '../data/service.ts';
import { Header } from './Header.tsx';
import { SubHeader } from './SubHeader.tsx';
import { Sidebar } from './Sidebar.tsx';
import { DetailPanel } from './DetailPanel.tsx';
import { HomeScreen } from '../screens/HomeScreen.tsx';
import { DispatchGate } from '../screens/DispatchGate.tsx';
import { CreateRunScreen } from '../screens/CreateRunScreen.tsx';
import { DashboardScreen } from '../screens/DashboardScreen.tsx';
import { OverviewScreen } from '../screens/OverviewScreen.tsx';
import { MonitorScreen } from '../screens/MonitorScreen.tsx';
import { ControlScreen } from '../screens/ControlScreen.tsx';
import { RoutePanel } from './RoutePanel.tsx';
import { CrewPanel } from './CrewPanel.tsx';
import { HourPanel } from './HourPanel.tsx';
import { DbOrdersScreen } from '../screens/db/DbOrdersScreen.tsx';
import { DbClientsScreen } from '../screens/db/DbClientsScreen.tsx';
import { DbRoutesScreen } from '../screens/db/DbRoutesScreen.tsx';
import { DbEngineersScreen } from '../screens/db/DbEngineersScreen.tsx';
import { DbServicesScreen } from '../screens/db/DbServicesScreen.tsx';
import { DbRunsScreen } from '../screens/db/DbRunsScreen.tsx';
import { StatsScreen } from '../screens/StatsScreen.tsx';
import { CompareScreen } from '../screens/CompareScreen.tsx';
import { SettingsScreen } from '../screens/SettingsScreen.tsx';
import { OrderProfile } from './OrderProfile.tsx';
import { CREW_ENGINE_LOCK, CrewProfile } from './CrewProfile.tsx';
import { ClientProfile } from './ClientProfile.tsx';
import { ServiceProfile } from './ServiceProfile.tsx';
import type { Hit } from '../data/find.ts';
import { RunEditDialog } from './RunEditDialog.tsx';
import { ManualDialog } from './ManualDialog.tsx';
import { IncidentDialog } from './IncidentDialog.tsx';
import { isDbSection } from './nav.ts';
import type { SectionId } from './nav.ts';
import { firstView, readRoute, sameRoute, writeRoute } from './route.ts';
import type { Route } from './route.ts';
import { COMPARE_MAX } from './compare.ts';
import { dropDuty } from '../data/duty.ts';
import { OVERVIEW } from './selection.ts';
import type { Selection } from './selection.ts';
import { DayFail } from './DayFail.tsx';
import { humanAfter, humanError, humanLine, titleWithStop } from '../data/errors.ts';
import { urgentFrom } from '../data/impact.ts';
import type { HumanError } from '../data/errors.ts';
import type { DayView } from '../data/derive.ts';
import '../styles/screens.css';

/* Вопрос, который задаётся перед любым уходом с несохранённого пересчёта.
   Один на все дороги — ленту, базу, карту, кнопку «назад», — чтобы человек
   узнавал его, а не читал каждый раз заново. */
const LEAVE_QUESTION = 'Пересчёт не сохранён — уйти и потерять его?';

export function App() {
  /* Где мы находимся, написано в адресе: раздел, вкладка внутри него, шаг
     диспетчерской и открытый расчёт. Обновление страницы возвращает туда же,
     где закрыли, кнопки «назад» и «вперёд» ходят по разделам, а ссылкой на
     нужный экран можно поделиться.

     Расчёт по умолчанию — самый свежий: диспетчер приходит утром к тому, что
     движок посчитал последним, а не к первому в архиве. Диспетчерская при
     этом сама его не открывает — сперва спрашивает, считать новый или взять
     готовый; открытым он становится только по явному выбору. */
  const [route, setRoute] = useState<Route>(() => readRoute(window.location.hash));
  const { section, view, stage, runId } = route;
  const nav = (patch: Partial<Route>) => setRoute((prev) => ({ ...prev, ...patch }));
  const [day, setDay] = useState<Day | null>(null);
  const [error, setError] = useState<HumanError | null>(null);
  const [selection, setSelection] = useState<Selection>(OVERVIEW);
  /* Настройки сервиса нужны здесь целиком: от них зависят и границы смены, и
     пороги, по которым считается день, — а значит, перерисоваться должно всё
     дерево, а не только экран настроек. */
  const settings = useService();
  const [navCollapsed, setNavCollapsed] = useState(settings.navCollapsed);
  /* Список расчётов нужен переключателю в подшапке и сравнению — грузим один
     раз на сессию, он не зависит от открытого расчёта. */
  const [runs, setRuns] = useState<DaySummary[] | null>(null);
  /* Базы данных и статистика живут над расчётом: свой источник, своя загрузка
     и только тогда, когда в них впервые заходят. */
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  /* День всегда открывается с его начала: диспетчер сам ведёт момент
     вперёд и смотрит, как движок перестраивает остаток смены. */
  const [cut, setCut] = useState(dayStart);
  /* Наведение живёт отдельно от закрепления: мышь ушла — подсветка гаснет,
     а выбранный щелчком маршрут остаётся. */
  const [hoverRoute, setHoverRoute] = useState<string | null>(null);
  const [pinnedRoute, setPinnedRoute] = useState<string | null>(null);
  const [routeFocus, setRouteFocus] = useState(0);
  /* Час, на который навели в панели ганта: гант подсвечивает его полосой. */
  const [hotHour, setHotHour] = useState<number | null>(null);
  /* Расчёты, отобранные к сравнению. Набор живёт на сессию: его собирают в
     базе расчётов и смотрят в «Сравнении», а не хранят между заходами. */
  const [compare, setCompare] = useState<RunId[]>([]);
  /* Запись, которую правят. Окно живёт здесь, а не в базе: после правки надо
     пересобрать справочники, а держит их этот уровень. */
  const [editing, setEditing] = useState<RunRef | null>(null);
  /* Потолок набора держим здесь, а не только гашением кнопки: кнопку можно
     не увидеть, а набор обязан оставаться таким, какой сравнение умеет
     разобрать. Шестой расчёт просто не берётся. */
  const toggleCompare = (id: RunId) =>
    setCompare((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (prev.length >= COMPARE_MAX) return prev;
      return [...prev, id];
    });
  const liveRoute = hoverRoute ?? pinnedRoute;
  /* Выбор маршрута — переключатель: повторный щелчок по тому же снимает его,
     и карта снова слушает все пути. */
  const pinRoute = (id: string | null) => {
    setPinnedRoute((prev) => (prev === id ? null : id));
    if (id) setRouteFocus((n) => n + 1);
  };

  /* Адрес ведёт: «назад», «вперёд» и вручную набранная ссылка меняют его, а
     состояние читается из него заново. Сравниваем по значениям — иначе
     каждое событие давало бы новый объект и лишнюю перерисовку.

     Кнопка «назад» — такая же дорога с несохранённого пересчёта, как лента
     или база, и спрашивает так же. Отказался — адрес возвращается на
     прежний, и экран остаётся где был. Текущий адрес и черновик читаем
     через ссылки: слушатель заведён один раз, а состояние с тех пор
     сменилось. */
  const routeRef = useRef(route);
  routeRef.current = route;
  const draftRef = useRef<boolean>(false);
  useEffect(() => {
    const sync = () => {
      const prev = routeRef.current;
      const next = readRoute(window.location.hash);
      if (sameRoute(prev, next)) return;
      if (draftRef.current && next.runId !== prev.runId && !window.confirm(LEAVE_QUESTION)) {
        window.history.replaceState(null, '', writeRoute(prev));
        return;
      }
      setRoute(next);
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  /* И обратно: переход внутри интерфейса дописывает адрес. Первый заход
     подменяет запись в истории, а не добавляет новую, — иначе «назад» с
     первого же экрана возвращал бы на него же. */
  const landed = useRef(false);
  useEffect(() => {
    const next = writeRoute(route);
    if (next === window.location.hash) {
      landed.current = true;
      return;
    }
    if (!landed.current) {
      landed.current = true;
      window.history.replaceState(null, '', next);
      return;
    }
    window.location.hash = next;
  }, [route]);

  useEffect(() => {
    /* Открыли другой расчёт — черновик не переезжает: он был пересчётом
       другого дня, и показывать его поверх чужого плана значило бы смешать
       два расчёта в один экран. Уйти, не заметив, нельзя: каждая дорога к
       другому расчёту проходит через `leaveDraft` и спрашивает. */
    setDraft(null);
    setReplan(null);
    setSaveFailed(null);
    /* Пересчёт и событие, ушедшие к движку до смены, свои ответы уже не
       покажут: билет сменился (см. `runIncident`). Окно правки и занятость
       снимаем здесь же — иначе новый расчёт ждал бы, пока ответит старый. */
    replanTicket.current += 1;
    setIncidentOpen(false);
    setIncidentBusy(false);
    setIncidentFailed(null);
    setEventBusy(false);
    setEventFailed(null);
  }, [runId]);

  /* Что выбрать в правой колонке, когда расчёт загрузится. Обычно — итоги
     дня, но карточка заявки просит открыть карту на своей точке, а карточка
     маршрута — на своём маршруте: без этого выбор, сделанный до загрузки,
     стирался бы её окончанием. */
  const pendingSelection = useRef<Selection | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    /* Расчётов ещё нет — грузить нечего. Это не ошибка, а первое утро:
       диспетчерская встретит предложением посчитать день. */
    if (!runId) {
      setDay(null);
      return;
    }
    loadDay(runId)
      .then((loaded) => {
        if (cancelled) return;
        setDay(loaded);
        setSelection(pendingSelection.current ?? OVERVIEW);
        pendingSelection.current = null;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(
          humanError(e, {
            title: 'Данные расчёта не прочитались',
            hint: 'Откройте другой расчёт или обновите страницу.'
          })
        );
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  /* История расчётов: сводки.

     Затравки здесь больше нет: первые расчёты заводит `seedRuns` в main.tsx,
     до первой отрисовки, — и адрес, разобранный при первом рендере, уже
     видит их. Две затравки в двух местах расходились: одна сеяла при
     движке, другая нет. */
  useEffect(() => {
    let cancelled = false;
    loadSummaries()
      .then((list) => {
        if (list && !cancelled) setRuns(list);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* Справочники подтягиваем сразу при запуске, а не при заходе в базы.

     Раньше они ждали первого захода в раздел баз данных, и до него счётчики
     в меню — «Заявки 205», «Инженеры 34» — показывать было нечего: они
     считаются из справочников и стояли на нуле, а ноль в меню не рисуется
     вовсе. Меню обещало пустые базы, пока в них не зайдёшь.

     Стоит это немногого: к этому времени файлы уже прочитаны — сводки
     расчётов идут за теми же, — и остаётся сборка справочников в памяти,
     единицы миллисекунд. Экран её не ждёт: он и так стоит на «Загружаем
     расчёт…», а это тяжелее. */
  const onDb = isDbSection(section);
  useEffect(() => {
    if (registry) return;
    let cancelled = false;
    setRegistryError(null);
    loadRegistry()
      .then((loaded) => {
        if (!cancelled) setRegistry(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRegistryError(
            e instanceof ContractError
              ? e.message
              : 'Справочники не прочитались. Обновите страницу; если не поможет — проверьте, что файлы данных на месте.'
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [registry]);

  /* И справочники, и лента подшапки, и счётчик в меню собраны из истории
     расчётов — правка записи обесценивает их все сразу. Пересобираем оттуда
     же, откуда собирали в первый раз: иначе в меню остаётся вчерашнее число,
     а в ленте — удалённый расчёт. */
  const refreshRuns = () => {
    loadSummaries().then(setRuns).catch(() => undefined);
    if (registry) loadRegistry().then(setRegistry).catch(() => undefined);
  };

  const saveRun = (patch: Parameters<typeof updateRun>[1]) => {
    if (!editing) return;
    updateRun(editing.id, patch);
    setEditing(null);
    refreshRuns();
  };

  const dropRun = () => {
    if (!editing) return;
    const gone = editing.id;
    /* День, который держал удаляемый расчёт, освобождается вместе с ним:
       ссылка на несуществующую запись не мешала бы работать — карточки
       сверяются со своим номером и молча остались бы серыми, — но день после
       этого числился бы занятым, а хозяина у него не было. */
    /* Расчёт программы расчёта не удаляется (он в её архиве) — тогда и
       день за ним остаётся. Окно правки такую кнопку и не показывает. */
    if (!deleteRun(gone)) return;
    if (editing.date) dropDuty(gone, editing.date);
    setEditing(null);
    setCompare((prev) => prev.filter((id) => id !== gone));
    /* Удалили открытый расчёт — уходим на самый свежий из оставшихся: экран,
       который показывает несуществующую запись, хуже пустого. */
    if (runId === gone) nav({ runId: latestRun(), stage: 'gate' });
    refreshRuns();
  };

  /* ─── правка дня и несохранённое состояние ──────────────────────────

     День пошёл не так, как посчитали: авария, инженер выбыл, инженер
     задержался. Движок пересобирает остаток за полторы секунды — и вот
     здесь появляется состояние, которого в интерфейсе до сих пор не было:
     результат, которого ещё нет в архиве.

     Он живёт на экране до тех пор, пока его не сохранят или не отменят.
     Кнопка «Сохранить» горит, пока он висит, и уход со страницы
     спрашивает. Это не перестраховка: пересчёт стоит полторы секунды
     работы солвера и решения диспетчера, и потерять его по случайному
     переходу — потерять обе эти вещи. */
  const [incidentOpen, setIncidentOpen] = useState(false);
  /* Каким событием открыть окно правки. Задаёт его экран «Воздействия»:
     диспетчер нажал «Инженер выбыл» — окно открывается на выбытии. */
  const [incidentKind, setIncidentKind] = useState<IncidentKind | undefined>(undefined);
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [incidentFailed, setIncidentFailed] = useState<HumanError | null>(null);
  const [replan, setReplan] = useState<ReplanResult | null>(null);
  /* Принятый, но не сохранённый пересчёт. Пока он здесь — экран показывает
     его план, а не тот, что лежит в архиве. */
  const [draft, setDraft] = useState<{ spec: IncidentSpec; result: ReplanResult } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<{ text: string; detail: string } | null>(null);

  /* Билет пересчёта. Пересчёт идёт до минуты, и за это время диспетчер
     может открыть другой расчёт; ответ старого тогда лёг бы поверх нового
     дня — план одного расчёта на экране другого. Смена расчёта меняет билет,
     и ответ с чужим билетом выбрасывается. */
  const replanTicket = useRef(0);

  const runIncident = async (spec: IncidentSpec) => {
    if (incidentBusy) return;
    const ticket = replanTicket.current;
    setIncidentBusy(true);
    setIncidentFailed(null);
    try {
      /* Пересчёт приходит на языке движка — переводим на входе, как и
         формы расчёта: иначе на экране пересчёта пустели километры. */
      /* От открытого расчёта: его план и переменные, его журнал. */
      const withBase: IncidentSpec = { ...spec, base: spec.base ?? engineBase };
      const result = изДвижка(await replanDay(withBase));
      if (ticket !== replanTicket.current) return;
      setReplan(result);
      setLastSpec(withBase);
    } catch (failure) {
      if (ticket !== replanTicket.current) return;
      setIncidentFailed(
        humanError(failure, {
          title: 'Пересчёт не получился',
          hint: 'Нажмите «Пересчитать» ещё раз.'
        })
      );
    } finally {
      /* Занятость чужого билета уже снята сменой расчёта, и новый пересчёт
         мог её поставить снова — не трогаем. */
      if (ticket === replanTicket.current) setIncidentBusy(false);
    }
  };

  const [lastSpec, setLastSpec] = useState<IncidentSpec | null>(null);

  /* ─── журнал диспетчера ─────────────────────────────────────────────

     Что случилось на самом деле: наряд отправлен, исполнитель выехал,
     заявка выполнена или сорвалась, заявку закрепили за другим. Есть только
     у расчёта движка — у него есть день, и движок ведёт по этому дню
     журнал. Время события — момент, на котором стоит ползунок. */
  /* Основа — открытый расчёт дня: пересчёт, журнал, статусы и «сколько
     людей» идут от его плана и переменных. Прежде всё это шло от плана
     компании, и у расчёта с множителем длительности 2,0 «Воздействия»
     пересчитывали не тот план, что на экране. У сохранённого пересчёта
     (остаток дня, только план) основы нет: он снимок, события и пересчёт
     ведутся от расчёта дня. */
  const opened = engineReady() ? runEntry(runId) : undefined;
  const wholeDay =
    opened !== undefined &&
    opened.source === null &&
    (opened.forms === undefined || opened.forms.includes('simulation'));
  const engineDay = wholeDay ? opened.day ?? null : null;
  const engineBase = engineDay ? runId : undefined;
  /* Запись движка, у которой есть только план, — сохранённый пересчёт.
     Окну правки и «Воздействию» это отдельная причина недоступности: совет
     у неё другой. Старые записи без замысла (`forms: []`) сюда не попадают:
     «откройте расчёт дня» им не поможет. */
  const savedReplan =
    opened !== undefined &&
    opened.source === null &&
    opened.forms !== undefined &&
    opened.forms.includes('plan') &&
    !opened.forms.includes('simulation');
  const [dayState, setDayState] = useState<DayState | null>(null);
  const [eventBusy, setEventBusy] = useState(false);
  /* Ошибка помнит, к какой заявке относится: иначе отказ по одной заявке
     висел бы в карточке любой другой, открытой следом. */
  const [eventFailed, setEventFailed] = useState<{
    order: string;
    message: string;
    detail: string;
  } | null>(null);
  /* Порядковый номер запроса /state. Ползунок времени шлёт запрос на каждый
     шаг, ответы приходят вразнобой, и поздний ответ на 10:00 затирал бы уже
     показанное 14:00. Кладём только ответ на последний запрос — и только если
     открыт всё тот же день: обновление, заказанное событием старого расчёта,
     уходит уже после смены и иначе оказалось бы «последним». */
  const dayStateSeq = useRef(0);
  const dayKey = useRef('');
  dayKey.current = `${engineDay ?? ''}|${engineBase ?? ''}`;

  const refreshDayState = () => {
    dayStateSeq.current += 1;
    const seq = dayStateSeq.current;
    const key = `${engineDay ?? ''}|${engineBase ?? ''}`;
    if (!engineDay) {
      setDayState(null);
      return;
    }
    const current = () => seq === dayStateSeq.current && key === dayKey.current;
    loadDayState(engineDay, cut, engineBase)
      .then((state) => {
        if (current()) setDayState(state);
      })
      .catch(() => {
        if (current()) setDayState(null);
      });
  };

  /* Смена основы — другой журнал: состояние прежнего расчёта до ответа
     /api/state двигало бы канбан, воронку и мониторинг нового дня и давало
     ложное «По журналу заявка у …». Эффект стоит до запроса и срабатывает
     только на смену дня или базы, поэтому от ползунка статусы не мигают. */
  useEffect(() => setDayState(null), [engineDay, engineBase]);
  useEffect(refreshDayState, [engineDay, engineBase, cut]);

  const sendEvent = async (event: JournalEvent) => {
    if (!engineDay || eventBusy) return;
    const ticket = replanTicket.current;
    setEventBusy(true);
    setEventFailed(null);
    try {
      await postEvent(engineDay, cut, event, engineBase);
      /* Пока событие записывалось, открыли другой расчёт — его экран этим
         ответом не трогаем. */
      if (ticket !== replanTicket.current) return;
      refreshDayState();
      /* Закрепление — решение, после которого остаток дня надо пересобрать:
         движок пересчитывает от журнала, и окно правки показывает цену. */
      if (event.kind === 'assigned') {
        setIncidentKind(undefined);
        setReplan(null);
        setIncidentFailed(null);
        setIncidentOpen(true);
        await runIncident({
          day: engineDay,
          at: cut,
          kind: 'urgent',
          urgent: 0,
          source: 'journal',
          base: engineBase
        });
      }
    } catch (failure) {
      if (ticket !== replanTicket.current) return;
      /* Слова движка — отдельно от фразы для человека. Блок узнаёт по ним
         известные отказы («E00 уже в пути к 34366; …») и говорит их именем,
         а прежде сюда уходила только готовая фраза: слова движка терялись,
         разбор отказов не срабатывал ни разу, и на отказ блок советовал
         «проверьте статус и время», а под «Подробностями» стояло
         «причина — в „Подробностях“». */
      const human = humanError(failure, { title: '', hint: 'Повторите ещё раз.' });
      setEventFailed({
        order: 'order' in event ? event.order : '',
        /* Заголовок «Событие не записано» блок ставит сам; у незнакомой
           ошибки своего заголовка нет — остаётся один совет. */
        message: human.title ? `${titleWithStop(human.title)} ${human.hint}` : human.hint,
        detail: human.detail
      });
    } finally {
      if (ticket === replanTicket.current) setEventBusy(false);
    }
  };

  /* У кого заявка по журналу: впереди в чьём-то списке (pending) или к ней
     уже едут (underway). Без `underway` у заявок «в пути» держателя не
     нашлось бы, и погасли бы «Выполнено» и «Сорвалось». Пока состояние дня
     не пришло — null: «не знаем» не то же, что «ни у кого». */
  const holders = useMemo(() => {
    if (!dayState) return null;
    const map: Record<string, string> = {};
    for (const [engineer, ids] of Object.entries(dayState.pending ?? {})) {
      for (const id of ids) map[id] = engineer;
    }
    return { ...map, ...dayState.underway };
  }, [dayState]);

  const dispatcher: DispatcherActions | undefined = engineDay
    ? {
        statuses: dayState?.statuses ?? {},
        reasons: dayState?.failed ?? {},
        holders,
        cut,
        dayStart: dayStart(),
        busy: eventBusy,
        failed: eventFailed,
        onEvent: sendEvent
      }
    : undefined;

  /* Принять пересчёт: он становится тем, что показано на экране. В архив
     при этом ничего не уходит — для этого есть «Сохранить». */
  const keepReplan = async () => {
    if (!replan || !lastSpec) return;
    /* Пересчёт от журнала: «Принять» делает его назначением дня. До этого
       журнал не тронут — прежде движок усваивал план уже при показе, и
       «Отменить правку» ничего не отменяла. */
    const token = replan.meta.replan.adopt_token;
    if (token) {
      /* Принятие ждёт движок до минуты. Открыли за это время другой расчёт —
         черновик старого не должен лечь на его экран, а занятость, которую
         мог поставить уже новый пересчёт, снимать не нам. */
      const ticket = replanTicket.current;
      setIncidentBusy(true);
      setIncidentFailed(null);
      try {
        await adoptJournal(lastSpec.day, token, lastSpec.base);
      } catch (failure) {
        if (ticket !== replanTicket.current) return;
        setIncidentFailed(
          humanError(failure, { title: 'Принять не удалось', hint: 'Нажмите «Принять» ещё раз.' })
        );
        return;
      } finally {
        if (ticket === replanTicket.current) setIncidentBusy(false);
      }
      if (ticket !== replanTicket.current) return;
      refreshDayState();
    }
    setDraft({ spec: token ? { ...lastSpec, adoptToken: token } : lastSpec, result: replan });
    setIncidentOpen(false);
    setReplan(null);
    /* С экрана «Воздействия» уходим туда, где новый план видно: сам экран
       планов не рисует, а принятый пересчёт надо посмотреть до того, как
       сохранять. */
    if (section === 'control') nav({ section: 'dispatch', stage: 'plan', view: 'summary' });
    /* Момент переезжает к тому, с которого пересобрали: экран теперь
       показывает остаток дня, и стоять на утре ему незачем. */
    setCut(replan.meta.replan.at);
  };

  const dropDraft = () => {
    setDraft(null);
    setSaveFailed(null);
  };

  /* Есть ли что терять — для слушателя адреса, который заведён один раз и
     самого `draft` не видит. */
  draftRef.current = draft !== null;

  /* Охранник несохранённого пересчёта. Раньше спрашивал только крестик в
     подшапке, а лента, база расчётов, карта из карточки и «назад» в
     браузере меняли расчёт молча — и черновик исчезал вместе с полутора
     секундами работы движка и решением диспетчера. Теперь любая дорога к
     другому расчёту проходит здесь: нечего терять — пропускает молча,
     есть — спрашивает, и при отказе ничего не происходит. */
  const leaveDraft = (): boolean => {
    if (!draft) return true;
    if (!window.confirm(LEAVE_QUESTION)) return false;
    setDraft(null);
    setReplan(null);
    setSaveFailed(null);
    return true;
  };

  /* Сохранить: пересчёт ложится в архив отдельной записью, помеченной как
     правка, со ссылкой на расчёт, от которого он отпочковался. Открывается
     она без вопроса: черновик только что стал записью, терять уже нечего. */
  const saveDraft = async () => {
    if (!draft || saving) return;
    /* Сохранение ждёт движок до минуты. Если за это время диспетчер ушёл на
       другой расчёт (и бросил черновик), запись в архиве всё равно
       появится — список её подхватит, — но уводить его с нового расчёта
       или показывать там чужую ошибку нельзя. */
    const ticket = replanTicket.current;
    setSaving(true);
    setSaveFailed(null);
    try {
      const entry = adoptEngineRun(await saveReplan(draft.spec, `Правка расчёта ${runCode(runId)}`));
      refreshRuns();
      if (ticket !== replanTicket.current) return;
      setDraft(null);
      showRun(entry.id);
    } catch (failure) {
      if (ticket !== replanTicket.current) return;
      /* Заголовок «Сохранить не вышло» ставит сама плашка (CalcBoard):
         свой запасной заголовок здесь давал «Сохранить не вышло. Запись не
         сохранилась. …». */
      setSaveFailed(
        humanAfter(failure, 'Пересчёт остаётся на экране — повторите попытку.', {
          409: {
            title: 'План устарел: пересчитайте заново',
            hint: 'Пока пересчёт был на экране, в дне что-то изменилось. Пересчитайте и сохраните заново.'
          }
        })
      );
    } finally {
      setSaving(false);
    }
  };

  /* Уход со страницы с несохранённым пересчётом. Браузер спрашивает сам,
     своим окном: подменять его своим нельзя — оно не остановит ни закрытие
     вкладки, ни кнопку «назад». */
  useEffect(() => {
    if (!draft) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', ask);
    return () => window.removeEventListener('beforeunload', ask);
  }, [draft]);

  /* Что показано на экране. С принятым, но не сохранённым пересчётом это
     его план на остаток дня, а не тот, что лежит в архиве: смысл правки в
     том, чтобы посмотреть на новый расклад до того, как решишь его
     оставить. Остальные три формы остаются от исходного расчёта, и полоса
     над пультом говорит об этом прямо. */
  const shownDay = useMemo(
    () => (day && draft ? { ...day, plan: draft.result } : day),
    [day, draft]
  );
  /* Пороги входят в зависимости памятки: день считается теми же данными, но
     «плохо» и «присмотреться» в нём расставлены по настройке, и подвинутый
     порог обязан перекрасить пульт немедленно. */
  /* Ось времени обязана доходить до границы суток открытого плана: у
     выгрузки заказчика это 22:00, а настройка оси по умолчанию — 21:00,
     и визиты после девяти вечера выпадали с таймлайна.

     Горизонт ставится эффектом, а не посреди рендера: запись в модуль из
     useMemo — побочное действие, которое React вправе выполнить дважды или
     выбросить. Эффект — макетный: он срабатывает до отрисовки на экране, а
     `setHorizon` тут же перерисовывает дерево с новой осью, так что кадра
     со старой диспетчер не видит. Число в состоянии нужно ещё и памяткам
     ниже: `dayView` читает ось через `cutMinutes` и обязан пересчитаться. */
  const [horizon, setHorizon] = useState(0);
  const shownPlan = shownDay?.plan;
  useLayoutEffect(() => {
    const next = shownPlan ? planHorizon(shownPlan) : undefined;
    setPlanHorizon(next);
    setHorizon(next ?? 0);
  }, [shownPlan]);

  /* Сменился расчёт — и момент, выставленный на старом дне, мог оказаться
     вне нового: после дня до 22:00 ползунок в 21:30 на дне до 21:00 молча
     прижался бы к 21:00, и время на ползунке разошлось бы с выставленным.
     Такой момент возвращаем на начало дня. Это страховка: почти все пути
     открытия расчёта (showRun, openRunMap, openRouteMap, openRunFromDb) сами
     ставят момент на начало дня, а сюда остаются переход по адресу и
     «Перейти» (goToRun) — только они и приносят момент со старого дня.
     Момент внутри нового дня не трогаем: сбрасывать его без нужды незачем.
     Горизонт в зависимостях: границы нового дня известны, только когда он
     загружен. */
  useLayoutEffect(() => {
    setCut((at) => (at < dayStart() || at > dayEnd() ? dayStart() : at));
  }, [runId, horizon, settings.dayStart, settings.dayEnd]);

  /* Статусы журнала — на канбан, воронку и мониторинг. Состояние дня
     приходит заново на каждом шаге ползунка, и почти всегда с теми же
     статусами: сравниваем по содержимому, иначе весь день пересчитывался
     бы на каждый ответ сервера. */
  const reportedKey = JSON.stringify(dayState?.statuses ?? {});
  const reported = useMemo(() => JSON.parse(reportedKey) as Record<string, string>, [reportedKey]);
  const dayView = useMemo(
    () => (shownDay ? buildDayView(shownDay, reported) : null),
    [shownDay, reported, horizon, settings.thresholds, settings.dayStart, settings.dayEnd]
  );
  /* Правая панель показывает список маршрутов вместо справочника там, где
     карта — основной способ смотреть на день: на вкладке «Карта» в
     диспетчерской и на всём мониторинге, который сам почти целиком карта. */
  const onPlan = section === 'dispatch' && stage === 'plan';
  /* Обзор — карта на оба поля: правой панели у него нет, и колонку под неё
     он не оставляет. Числа расчёта лежат на самой карте. */
  const onOverview = onPlan && view === 'overview';
  const onMap = onPlan && view === 'map';

  const goSection = (id: SectionId) => {
    /* Шаг диспетчерской переход между разделами не трогает: открытый расчёт
       остаётся открытым. Раньше возврат в диспетчерскую снова начинался с
       вопроса «создать или выбрать» — и расчёт, помеченный в базе открытым,
       открытым не оказывался. Вопрос теперь задаётся один раз, пока не
       открыт ни один; дальше расчёты переключают лентой в подшапке и базой,
       а завести новый можно кнопкой в меню. */
    nav({ section: id, view: firstView(id) });
  };

  /* Открыть расчёт без вопросов — для тех мест, где терять уже нечего:
     только что сохранённая запись или только что посчитанный день. */
  const showRun = (id: RunId) => {
    setCut(dayStart());
    /* Выбор расчёта — где угодно: в ленте подшапки, в базе расчётов, на
       дашборде — и есть открытие плана.

       Открытый расчёт показывается обзором: к какой бы вкладке диспетчер ни
       пришёл до этого, новый расчёт он встречает картой дня, а не чужой
       сводкой, оставшейся от предыдущего. В других разделах вкладку не
       трогаем: лента подшапки работает и в мониторинге, и переключение
       расчёта не должно уводить оттуда. */
    nav({ runId: id, stage: 'plan', ...(section === 'dispatch' ? { view: firstView('dispatch') } : {}) });
  };

  const openRun = (id: RunId) => {
    if (id !== runId && !leaveDraft()) return;
    showRun(id);
  };

  /* Выбор в правой колонке к моменту, когда расчёт откроется. Тот же расчёт
     уже загружен — выбор ложится сразу; другой — ждёт загрузки. */
  const selectOnOpen = (id: RunId, choice: Selection) => {
    setSelection(choice);
    if (id !== runId) pendingSelection.current = choice;
  };

  /* Щелчок по карте в карточке расчёта или заявки: открыть его и сразу
     показать карту — плитка обещает карту, значит, к ней и ведёт. Из
     карточки заявки карта встречает этой заявкой, а не днём целиком: точку
     среди двухсот иначе искать глазами. */
  const openRunMap = (id: RunId, orderId?: string) => {
    if (id !== runId && !leaveDraft()) return;
    setCut(dayStart());
    if (orderId) selectOnOpen(id, { kind: 'order', id: orderId });
    nav({ runId: id, stage: 'plan', section: 'dispatch', view: 'map' });
  };

  /* Щелчок по карточке маршрута в базе: открыть карту его расчёта и
     закрепить на ней этот маршрут. Плитка в карточке показывает один
     маршрут — значит, и большая карта должна встретить им же, а не днём
     целиком, в котором свою линию потом ищи глазами. Своего экрана у
     маршрута нет, и это единственное место, где его смотрят как есть. */
  const openRouteMap = (id: RunId, engineerId: string) => {
    if (id !== runId && !leaveDraft()) return;
    setCut(dayStart());
    setPinnedRoute(engineerId);
    setRouteFocus((n) => n + 1);
    selectOnOpen(id, { kind: 'engineer', id: engineerId });
    nav({ runId: id, stage: 'plan', section: 'dispatch', view: 'map' });
  };

  /* «Отследить» инженера с другого участка. У программы расчёта номера
     E00…E13 повторяются на каждом участке, и ключ справочника «участок:номер»
     в открытом расчёте чужого участка не находит никого — прежде экран молча
     уходил в слежение за чужим днём без выбранного человека. Теперь ведём в
     последний расчёт его участка и закрепляем его маршрут. Расчёта его
     участка нет — никуда не уводим и отвечаем словами: строка уходит в
     карточку, и та показывает её у кнопки. */
  const trackElsewhere = (key: string): string | void => {
    const cut = key.indexOf(':');
    if (cut < 0) return;
    const home = key.slice(0, cut);
    const code = key.slice(cut + 1);
    const latest = RUNS.filter((run) => run.source === null && run.day === home).sort((a, b) =>
      b.created.localeCompare(a.created)
    )[0];
    if (!latest) {
      const open = day?.plan.meta.day;
      return (
        `Этот инженер работает на участке ${engineDayTitle(home)}, а открыт расчёт ` +
        (open ? `участка ${engineDayTitle(open)}` : 'другого участка') +
        '. Откройте или заведите расчёт его участка.'
      );
    }
    /* Отказался уходить с несохранённого пересчёта — остаёмся в карточке. */
    if (latest.id !== runId && !leaveDraft()) return '';
    setCut(dayStart());
    setPinnedRoute(code);
    setRouteFocus((n) => n + 1);
    selectOnOpen(latest.id, { kind: 'engineer', id: code });
    nav({ runId: latest.id, stage: 'plan', section: 'monitor', view: firstView('monitor') });
  };

  /* «Перейти» у открытого расчёта: ведёт к нему в диспетчерскую, ничего в
     нём не переоткрывая — момент и выбранный объект остаются как были. */
  const goToRun = (id: RunId) => {
    if (id !== runId && !leaveDraft()) return;
    nav({ runId: id, stage: 'plan', section: 'dispatch', view: firstView('dispatch') });
  };

  /* ─── карточка найденной записи ───────────────────────────────────────

     Карточка живёт здесь, а не в базе, по одной причине: поиск в шапке стоит
     на каждом экране, и открывать он обязан отовсюду. Раньше найденное клали
     в правую панель, а её нет ни в базах, ни на дашборде, ни в сравнении —
     диспетчер выбирал строку в подсказке и не получал ничего.

     Хранится не сама запись, а её род и ключ: справочники пересобираются
     после правок, и запись, взятая по ссылке, после этого указывала бы на
     прежний объект. Ключ переживает пересборку, объект — нет. */
  const [lookup, setLookup] = useState<{ kind: 'order' | 'client' | 'engineer' | 'service'; key: string } | null>(
    null
  );
  /* Участки нужны карточке инженера — она даёт менять участок, а список
     мест лежит рядом с данными. Читаем один раз: он не меняется. */
  const [places, setPlaces] = useState<Place[]>([]);
  useEffect(() => {
    loadPlaces()
      .then(setPlaces)
      .catch(() => undefined);
  }, []);

  const looked = useMemo(() => {
    if (!lookup || !registry) return null;
    if (lookup.kind === 'order') {
      return { kind: 'order' as const, row: registry.orders.find((one) => one.key === lookup.key) ?? null };
    }
    if (lookup.kind === 'client') {
      return { kind: 'client' as const, row: registry.clients.find((one) => one.key === lookup.key) ?? null };
    }
    if (lookup.kind === 'engineer') {
      return { kind: 'engineer' as const, row: registry.engineers.find((one) => one.id === lookup.key) ?? null };
    }
    return { kind: 'service' as const, row: registry.services.find((one) => one.key === lookup.key) ?? null };
  }, [lookup, registry]);

  /* Куда ведёт находка. Четыре рода записей открываются карточкой поверх
     экрана, два — переходом: у расчёта свой экран, а у маршрута своего нет,
     и смотрят его на карте того расчёта, которому он принадлежит. */
  const openHit = (hit: Hit) => {
    if (hit.kind === 'run') {
      goToRun(hit.key as RunId);
      return;
    }
    if (hit.kind === 'route') {
      const route = registry?.routes.find((one) => one.key === hit.key);
      if (route) openRouteMap(route.run.id as RunId, route.engineerId);
      return;
    }
    setLookup({ kind: hit.kind, key: hit.key });
  };

  /* «Открыть» в базе расчётов открывает его по-настоящему — с переходом к
     плану. Раньше кнопка только помечала карточку, а диспетчерская всё равно
     встречала вопросом «создать или выбрать»: расчёт числился открытым и
     открытым не был. */
  const openRunFromDb = (id: RunId) => {
    if (id !== runId && !leaveDraft()) return;
    setCut(dayStart());
    nav({ runId: id, stage: 'plan', section: 'dispatch', view: firstView('dispatch') });
  };

  /* Закрыть открытый расчёт и вернуться к выбору действия. Открыть план было
     чем, а закрыть — нечем: выйти из него получалось только сменой раздела или
     правкой адреса, и диспетчерская навсегда оставалась пультом одного
     расчёта. Крестик в подшапке возвращает её к вопросу «создать или взять
     готовый». Несохранённый пересчёт при этом спрашивает: он живёт только на
     экране, и закрытие плана его теряет. */
  const closeRun = () => {
    if (!leaveDraft()) return;
    nav({ section: 'dispatch', view: firstView('dispatch'), stage: 'gate' });
  };

  /* Две дороги с экрана ошибки: к выбору другого расчёта и на дашборд. */
  const pickAnotherRun = () => nav({ section: 'dispatch', view: firstView('dispatch'), stage: 'gate' });

  /* Завести расчёт можно из любого раздела — кнопка в меню ведёт к той же
     форме, что и «Создать расчёт» в диспетчерской. Форма одна: два входа в
     две разные формы разошлись бы при первой же правке. */
  const createRunForm = () => nav({ section: 'dispatch', stage: 'create' });

  /* Выгрузка расчёта книгой Excel. Собирается из того, что уже загружено:
     формы открытого дня лежат в памяти, и ходить за ними второй раз незачем. */
  const exportDay = () => {
    const entry = runEntry(runId);
    if (!day || !entry) return;
    exportRun(day, entry);
  };

  /* Короткая подпись под то, что показано: без неё полоса сообщала бы
     «пересчёт», не говоря какой. */
  const draftNote = useMemo(() => {
    if (!draft) return null;
    const meta = draft.result.meta.replan;
    const incident = meta.incident;
    /* Имя ищем в исходном расчёте, а не в том, что показано. Выбывшего в
       остатке дня уже нет — его для того и убрали, — и по показанному плану
       он бы не нашёлся вовсе. Читалось это как табельный номер вместо
       фамилии ровно в том событии, где фамилия важнее всего. */
    const who =
      incident && incident.kind !== 'cancelled'
        ? day?.plan.engineers.find((e) => e.id === incident.engineer_id)?.name
        : null;
    const what = !incident
      ? meta.urgent_ids.length > 0
        ? `${plural(meta.urgent_ids.length, 'авария', 'аварии', 'аварий')} в плане`
        : 'пересчёт от журнала диспетчера'
      : incident.kind === 'cancelled'
        ? `снята заявка ${incident.order_ids.join(', ')}`
        : incident.kind === 'disabled'
          ? `${who ?? incident.engineer_id} выбыл до конца дня`
          : `${who ?? incident.engineer_id} задержался на ${incident.minutes} мин`;
    return { at: meta.at, gain: meta.assigned_now - meta.assigned_as_is, what };
  }, [draft, day]);

  /* Ручное управление: те же рычаги, что и при создании расчёта, но
     применённые к открытому дню. Пересчёт заводит новый расчёт на том же
     дне — прошлый остаётся в архиве, и два варианта ложатся рядом. */
  const [manual, setManual] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualFailed, setManualFailed] = useState<string | null>(null);

  const runManual = async (params: EngineParams) => {
    if (manualBusy) return;
    setManualBusy(true);
    setManualFailed(null);
    try {
      /* День берём тот же, что у открытого расчёта: смысл ручного управления
         в том, чтобы сравнить два плана на одних данных. */
      const entry = await createRun(params, runEntry(runId)?.source ?? undefined, runEntry(runId)?.day);
      refreshRuns();
      setManual(false);
      openRun(entry.id);
    } catch (failure) {
      setManualFailed(
        humanLine(failure, {
          title: 'День не пересчитался',
          hint: 'Проверьте переменные и нажмите «Пересчитать» ещё раз.'
        })
      );
    } finally {
      setManualBusy(false);
    }
  };

  /* Счёт идёт, пока движок раскладывает день. С живым движком это около
     восьми секунд настоящей работы планировщика — ровно та цифра, которой
     мы хвалимся, и прятать её не нужно. Без движка расчёт заводится
     мгновенно и берёт данные следующего источника. */
  const [solving, setSolving] = useState(false);
  const [solveFailed, setSolveFailed] = useState<string | null>(null);

  const runEngine = async (params: EngineParams, zone?: SourceId, shift?: ShiftInput) => {
    if (solving) return;
    setSolving(true);
    setSolveFailed(null);
    try {
      const entry = await createRun(params, zone, undefined, shift);
      refreshRuns();
      /* Посчитанный день открывается сразу. Окно пересчёта после этого
         не показываем: раньше оно всплывало само с погашенными
         переключателями и читалось как «что-то не доделано», хотя расчёт
         уже готов и виден. */
      showRun(entry.id);
    } catch (failure) {
      /* Движок не ответил или отказал — остаёмся на форме и говорим, что
         случилось. Уводить на пустой расчёт, которого нет, нельзя. */
      setSolveFailed(
        humanLine(failure, {
          title: 'День не посчитался',
          hint: 'Проверьте вводные — зону, состав смены, заявки — и запустите расчёт ещё раз.'
        })
      );
    } finally {
      setSolving(false);
    }
  };

  /* Ни одного расчёта — первое утро программы. Показываем форму расчёта и
     ничего больше: пока день не посчитан, ни карте, ни базам данных, ни
     сравнению показывать нечего. */
  if (!runId) {
    return (
      <CreateRunScreen
        onCancel={() => undefined}
        onCreate={runEngine}
        solving={solving}
        failed={solveFailed}
        first
      />
    );
  }

  /* День нужен не всем разделам. Базы, сравнение, статистика и настройки
     читают справочники и историю, а не открытый расчёт, — и обязаны работать
     даже тогда, когда расчёт не загрузился. Поэтому ошибка и «загружаем»
     встают не вместо оболочки, а на место тех экранов, которым без дня
     показывать нечего: шапка, меню и лента остаются, и уйти с ошибки есть
     куда. */
  const ready = day && dayView ? { day, view: dayView } : null;
  const dayNeeded = section === 'home' || section === 'monitor' || section === 'control' || onPlan;
  const dayPending = error ? (
    <DayFail
      runCode={runCode(runId)}
      failure={error}
      onPickRun={pickAnotherRun}
      onHome={() => goSection('home')}
    />
  ) : (
    <div className="stub enter">
      <p className="stub__body">Загружаем расчёт…</p>
    </div>
  );

  const counts = {
    orders: ready?.day.plan.meta.orders_total ?? 0,
    unassigned: ready?.view.unassigned.length ?? 0,
    routes: ready?.day.plan.routes.length ?? 0,
    engineers: ready?.day.plan.meta.engineers_total ?? 0,
    runs: runs?.length ?? 0,
    /* Сколько расчётов отобрано к сравнению. Цифра у пункта меню — то же
       число, что в заголовке экрана: набор собирают в базе расчётов, а
       видеть, сколько набралось, нужно не выходя из неё. */
    compare: compare.length,
    /* Цифры баз — из справочников, а не из открытого дня: база отвечает на
       «сколько записей в ней», и число не должно меняться от того, какой
       расчёт сейчас открыт. Пока справочники не загружены, здесь нули, и
       счётчики не рисуются. */
    dbOrders: registry?.orders.length ?? 0,
    dbServices: registry?.services.length ?? 0,
    dbEngineers: registry?.engineers.length ?? 0,
    dbClients: registry?.clients.length ?? 0,
    dbRoutes: registry?.routes.length ?? 0
  };

  /* Правая панель всегда про объект открытого расчёта. Там, где расчёта нет,
     её не показываем — и колонку под неё тоже, иначе справа остаётся пустая
     полоса, которая читается как несработавший экран. Дашборд обзорный и
     объекта не выбирает, поэтому тоже идёт без неё.

     Мониторинг тоже идёт без неё, и по той же причине, что обзор: карта там
     занимает весь экран, а числа, тревоги и люди стоят колонкой поверх неё.
     Правая полоса рисовала бы тех же инженеров второй раз. */
  const withDetail = onPlan && !onOverview;

  const registryPending = registryError ? (
    <div className="stub enter">
      <h2 className="stub__title">Данные не загрузились</h2>
      <p className="stub__body">{registryError}</p>
    </div>
  ) : (
    <div className="stub enter">
      <h2 className="stub__title">Собираем данные</h2>
      <p className="stub__body">
        Читаем планы всех расчётов — раздел строится по ним сразу, а не по открытому расчёту.
      </p>
    </div>
  );

  /* Экраны, которым нужен открытый день. Собраны в одну функцию, чтобы
     показывать их только тогда, когда день на месте, а на его месте — ошибку
     или «загружаем», не трогая остальную оболочку. Имена `day` и `dayView`
     здесь уже не пустые: это те же значения, но проверенные. */
  const dayScreens = (day: Day, dayView: DayView) => (
    <>
      {section === 'home' && (
        <HomeScreen
          day={day}
          plan={shownDay?.plan ?? day.plan}
          view={dayView}
          runs={runs}
          activeRun={runId}
          onGoSection={goSection}
          onOpenRun={openRun}
          onCreate={createRunForm}
        />
      )}

      {section === 'monitor' && (
        <MonitorScreen
          view={dayView}
          runId={runId}
          live={liveRoute}
          onLive={setHoverRoute}
          pinned={pinnedRoute}
          onPin={pinRoute}
          focus={routeFocus}
          onSelectOrder={(id) => setSelection({ kind: 'order', id })}
          onSelectEngineer={(id) => setSelection({ kind: 'engineer', id })}
        />
      )}

      {/* Управление воздействием — третий этап процесса. Привязано к
          расчёту так же, как диспетчерская и мониторинг: воздействие
          применяют к конкретному плану, а не вообще. */}
      {section === 'control' && (
        <ControlScreen
          runCode={runCode(runId)}
          cut={cut}
          live={engineReady()}
          canReplan={Boolean(engineDay)}
          savedReplan={savedReplan}
          onPick={(kind) => {
            setIncidentKind(kind);
            setReplan(null);
            setIncidentFailed(null);
            setIncidentOpen(true);
          }}
          day={engineDay}
          base={engineBase}
          onJournalReset={refreshDayState}
          urgentStart={ready ? urgentFrom(ready.view.engineerById.values()) : null}
          orderLabel={(id) => {
            const order = ready?.view.orderById.get(id);
            return order ? order.address ?? `${order.work_title}, ${order.id}` : id;
          }}
        />
      )}

      {/* Обзор стоит перед сводкой: расчёт открывают картой дня, а
          числа читают на ней же. Остальные вкладки — тот же расчёт
          другими способами, и держит их общий экран плана. */}
      {onOverview && (
        <OverviewScreen
          view={dayView}
          restFrom={replanAt(day.plan)}
          runId={runId}
          run={runCode(runId)}
          planDay={day?.plan.meta.day}
          live={liveRoute}
          onLive={setHoverRoute}
          pinned={pinnedRoute}
          onPin={pinRoute}
          focus={routeFocus}
          selectedOrder={selection.kind === 'order' ? selection.id : null}
          /* Щелчок по точке остаётся на карте: обзор отвечает сводкой в
             правой колонке, на месте итогов расчёта. Раньше он уводил в
             «Карту», и человек терял и карту, и место, на которое
             смотрел. Пусто — выбор сняли, колонка возвращает итоги. */
          onSelectOrder={(id) => setSelection(id ? { kind: 'order', id } : OVERVIEW)}
          /* Инженера показывает справочник в сводке — туда и ведём:
             список маршрутов карточки человека не открывает. */
          onSelectEngineer={(id) => {
            setSelection({ kind: 'engineer', id });
            nav({ view: 'summary' });
          }}
          onOpenMetric={(group) => {
            setSelection({ kind: 'group', id: group });
            nav({ view: 'summary' });
          }}
          onOpenSummary={() => nav({ view: 'summary' })}
          registry={registry}
          onOpenRun={(id) => openRun(id as RunId)}
          onOpenMap={(id) => openRunMap(id as RunId)}
          onTrack={(id) => {
            /* Карточка отдаёт ключ справочника («восток:E00»), план знает
               номер: человек с тем же номером на другом участке — не он. */
            const local = engineerInDay(id, day?.plan.meta.day);
            if (local === null) return trackElsewhere(id);
            nav({ section: 'monitor' });
            if (local && dayView?.loads.some((load) => load.engineer.id === local)) {
              pinRoute(local);
              setSelection({ kind: 'engineer', id: local });
            }
          }}
          onChanged={refreshRuns}
          draft={draftNote}
        />
      )}

      {section === 'dispatch' && stage === 'plan' && !onOverview && (
        <DashboardScreen
          day={day}
          view={dayView}
          runId={runId}
          mode={view}
          run={runCode(runId)}
          selectedOrder={selection.kind === 'order' ? selection.id : null}
          hotHour={hotHour}
          live={liveRoute}
          onLive={setHoverRoute}
          pinned={pinnedRoute}
          onPin={pinRoute}
          focus={routeFocus}
          cut={cut}
          onCutChange={setCut}
          onSelectOrder={(id) => setSelection({ kind: 'order', id })}
          onSelectEngineer={(id) => setSelection({ kind: 'engineer', id })}
          onOpenGroup={(id) => setSelection({ kind: 'group', id })}
          onOpenList={setSelection}
          onExport={exportDay}
          onManual={() => setManual(true)}
          engineLive={engineReady()}
          onClose={() => nav({ stage: 'gate' })}
          onEdit={() => {
            setReplan(null);
            setIncidentFailed(null);
            setIncidentOpen(true);
          }}
          draft={draftNote}
          saving={saving}
          saveFailed={saveFailed}
          onSave={saveDraft}
          onDropDraft={dropDraft}
        />
      )}
    </>
  );

  return (
    <div
      className={
        'shell' +
        (navCollapsed ? ' shell--nav-collapsed' : '') +
        (withDetail ? '' : ' shell--wide') +
        /* Обзор идёт без полей вокруг: карта в нём доходит до краёв, а
           рамка вокруг карты на весь экран — рамка вокруг пустоты. */
        (onOverview ? ' shell--flush' : '')
      }
    >
      <Header
        collapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((v) => !v)}
        view={ready?.view ?? null}
        onSelect={setSelection}
        registry={registry}
        onFind={openHit}
        onHome={() => goSection('home')}
        onOpenSettings={() => nav({ section: 'engine', view: 'service' })}
      />

      <SubHeader
        section={section}
        view={view}
        onViewChange={(next) => nav({ view: next })}
        planPending={section === 'dispatch' && stage !== 'plan'}
        onCloseRun={onPlan ? closeRun : undefined}
        runs={runs}
        activeRun={runId}
        onOpenRun={openRun}
        compare={compare}
        onCompare={toggleCompare}
      />

      <div className="shell__body">
        <div className="shell__nav">
          <Sidebar
            active={section}
            collapsed={navCollapsed}
            onSelect={goSection}
            counts={counts}
            alertKeys={['unassigned']}
            onCreateRun={createRunForm}
          />
        </div>

        <main className="shell__main">
          {dayNeeded && (ready ? dayScreens(ready.day, ready.view) : dayPending)}

          {section === 'dispatch' && stage === 'gate' && (
            <DispatchGate
              runs={runs}
              activeRun={runId}
              onCreate={() => nav({ stage: 'create' })}
              onOpen={openRun}
            />
          )}

          {section === 'dispatch' && stage === 'create' && (
            <CreateRunScreen
              onCancel={() => nav({ stage: 'gate' })}
              onCreate={runEngine}
              solving={solving}
              failed={solveFailed}
            />
          )}

          {section === 'compare' && (
            <CompareScreen
              picks={compare}
              registry={registry}
              runs={runs}
              active={stage === 'plan' ? runId : null}
              onToggle={toggleCompare}
              onClear={() => setCompare([])}
              onRestore={(ids) => setCompare(ids.slice(0, COMPARE_MAX))}
              onGoRuns={() => goSection('db-runs')}
              onOpen={openRunFromDb}
              onOpenMap={openRunMap}
              onGo={goToRun}
            />
          )}

          {/* Статистика стоит над расчётами и читает справочники: те же
              итоги, что в базе расчётов, но сведённые в один экран. */}
          {section === 'stats' &&
            (!registry ? (
              registryPending
            ) : (
              <StatsScreen
                registry={registry}
                active={stage === 'plan' ? runId : null}
                onOpenRun={openRunFromDb}
              />
            ))}

          {onDb &&
            (!registry ? (
              registryPending
            ) : section === 'db-runs' ? (
              <DbRunsScreen
                registry={registry}
                mode={view}
                active={stage === 'plan' ? runId : null}
                onOpen={openRunFromDb}
                onOpenMap={openRunMap}
                onGo={goToRun}
                compare={compare}
                onCompare={toggleCompare}
                onEdit={setEditing}
              />
            ) : section === 'db-services' ? (
              <DbServicesScreen registry={registry} mode={view} onOpenRun={openRunFromDb} />
            ) : section === 'db-orders' ? (
              <DbOrdersScreen
                registry={registry}
                mode={view}
                onOpenRun={openRunFromDb}
                onOpenMap={openRunMap}
              />
            ) : section === 'db-clients' ? (
              <DbClientsScreen registry={registry} mode={view} onOpenRun={openRunFromDb} />
            ) : section === 'db-routes' ? (
              <DbRoutesScreen registry={registry} mode={view} onOpenRoute={openRouteMap} />
            ) : (
              <DbEngineersScreen
                registry={registry}
                mode={view}
                /* Профиль инженера открывает заявки, которые он вёз, а из
                   заявки уходят в её расчёт и на карту — те же две дороги,
                   что и из базы заявок. */
                onOpenRun={openRunFromDb}
                onOpenMap={openRunMap}
                /* Правка штата меняет данные, а не только карточку: справочник
                   и открытый расчёт пересобираются с нуля. */
                onChanged={() => {
                  setRegistry(null);
                  /* Пока день перечитывается, расчёт могли переключить:
                     ответ тогда принадлежит уже не тому, что открыт, и
                     класть его на экран нельзя. */
                  const wanted = runId;
                  loadDay(wanted)
                    .then((loaded) => {
                      if (routeRef.current.runId === wanted) setDay(loaded);
                    })
                    .catch(() => undefined);
                  refreshRuns();
                }}
                /* «Отследить» из профиля: пока своего экрана слежения нет,
                   ведём в мониторинг — он и отвечает на «где инженер сейчас
                   и что делает». Если человек в открытом сегодня расчёте, тут
                   же закрепляем на нём маршрут и открываем его карточку;
                   если нет — просто открываем мониторинг, показывать там
                   нечего, но раздел тот. */
                onTrack={(id) => {
                  const local = engineerInDay(id, day?.plan.meta.day);
                  if (local === null) return trackElsewhere(id);
                  nav({ section: 'monitor' });
                  if (local && dayView?.loads.some((load) => load.engineer.id === local)) {
                    pinRoute(local);
                    setSelection({ kind: 'engineer', id: local });
                  }
                }}
              />
            ))}

          {section === 'engine' && (
            <SettingsScreen
              mode={view}
              registry={registry}
              onEditsCleared={refreshRuns}
              /* Истории больше нет — открытый расчёт ссылается в пустоту.
                 Уводим на дашборд и забываем день: остаться на настройках
                 можно, но всё, что читает открытый расчёт — шапка, лента,
                 правая панель, — читало бы стёртую запись. */
              onHistoryCleared={() => {
                setDay(null);
                setDraft(null);
                setReplan(null);
                refreshRuns();
                setRoute({ section: 'home', view: '', stage: 'gate', runId: latestRun() });
              }}
            />
          )}
        </main>

        {withDetail && ready && (
          <aside className="shell__detail">
            {/* У каждой вкладки плана правая панель своя: она договаривает
                то, чего не говорит сама вкладка. Карта — «во сколько и что»
                по маршрутам, гант — где в дне свободные руки сошлись с
                невзятыми окнами, канбан — кто сколько успел закрыть к
                этому моменту. Сводке договаривать нечего, у неё справочник. */}
            {onMap ? (
              <RoutePanel
                view={ready.view}
                runId={runId}
                live={liveRoute}
                pinned={pinnedRoute}
                onLive={setHoverRoute}
                onFocus={pinRoute}
                selectedOrder={selection.kind === 'order' ? selection.id : null}
                onSelectOrder={(id) => setSelection({ kind: 'order', id })}
              />
            ) : onPlan && view === 'timeline' ? (
              <HourPanel
                view={ready.view}
                onHoverHour={setHotHour}
                onSelectOrder={(id) => setSelection({ kind: 'order', id })}
                onSelectEngineer={(id) => setSelection({ kind: 'engineer', id })}
              />
            ) : onPlan && view === 'kanban' ? (
              <CrewPanel
                view={ready.view}
                cut={cut}
                onCutChange={setCut}
                selected={selection.kind === 'order' ? selection.id : null}
                onSelectOrder={(id) => setSelection({ kind: 'order', id })}
                onSelectEngineer={(id) => setSelection({ kind: 'engineer', id })}
              />
            ) : (
              <DetailPanel
                day={ready.day}
                view={ready.view}
                selection={selection}
                onSelect={setSelection}
                dispatcher={dispatcher}
              />
            )}
          </aside>
        )}
      </div>

      {ready && (
        <IncidentDialog
          open={incidentOpen}
          view={ready.view}
          live={engineReady()}
          savedReplan={savedReplan}
          runCode={runCode(runId)}
          /* День движка — только у расчёта целого дня: у сохранённого
             пересчёта (остатка дня) пересчитывать нечего. */
          day={engineDay}
          cut={cut}
          busy={incidentBusy}
          failed={incidentFailed}
          result={replan}
          onClose={() => {
            setIncidentOpen(false);
            setReplan(null);
          }}
          onRun={runIncident}
          onKeep={keepReplan}
          initialKind={incidentKind}
        />
      )}

      <ManualDialog
        open={manual}
        runCode={runCode(runId)}
        params={runEntry(runId)?.params ?? engineDefaults()}
        busy={manualBusy}
        failed={manualFailed}
        onClose={() => setManual(false)}
        onRun={runManual}
      />

      <RunEditDialog
        run={editing}
        onClose={() => setEditing(null)}
        onSave={saveRun}
        onDelete={dropRun}
      />

      {/* Карточка найденной записи — поверх любого экрана.

          Стоит в оболочке, а не в базах, потому что поиск стоит в шапке и
          работает отовсюду: из мониторинга, из сравнения, из настроек. База
          открывает те же карточки у себя — там они часть экрана, — а здесь
          они отвечают поиску, и одно другому не мешает: открыта всегда одна.

          Из карточки можно уйти вглубь: из клиента и услуги — в заявку, из
          заявки — в расчёт и на карту. Тогда прежняя карточка закрывается, а
          новая встаёт на её место: два окна друг поверх друга диспетчер
          закрывал бы дважды, не понимая, почему. */}
      {registry && looked?.kind === 'order' && (
        <OrderProfile
          order={looked.row}
          registry={registry}
          onClose={() => setLookup(null)}
          onOpenRun={(id) => {
            setLookup(null);
            goToRun(id as RunId);
          }}
          onOpenMap={(id, orderId) => {
            setLookup(null);
            openRunMap(id as RunId, orderId);
          }}
        />
      )}

      {registry && looked?.kind === 'client' && (
        <ClientProfile
          client={looked.row}
          registry={registry}
          onClose={() => setLookup(null)}
          onOpenOrder={(order) => setLookup({ kind: 'order', key: order.key })}
          onOpenRun={(id) => {
            setLookup(null);
            goToRun(id as RunId);
          }}
        />
      )}

      {registry && looked?.kind === 'service' && (
        <ServiceProfile
          service={looked.row}
          registry={registry}
          onClose={() => setLookup(null)}
          onOpenOrder={(order) => setLookup({ kind: 'order', key: order.key })}
          onOpenRun={(id) => {
            setLookup(null);
            goToRun(id as RunId);
          }}
        />
      )}

      {registry && looked?.kind === 'engineer' && (
        <CrewProfile
          crew={looked.row}
          registry={registry}
          places={places}
          onClose={() => setLookup(null)}
          onTrack={(id) => {
            const local = engineerInDay(id, day?.plan.meta.day);
            if (local === null) {
              const miss = trackElsewhere(id);
              if (typeof miss !== 'string') setLookup(null);
              return miss;
            }
            setLookup(null);
            if (local) setSelection({ kind: 'engineer', id: local });
            nav({ section: 'monitor', view: firstView('monitor') });
          }}
          onOpenRun={(id) => {
            setLookup(null);
            goToRun(id as RunId);
          }}
          onOpenMap={(id, orderId) => {
            setLookup(null);
            openRunMap(id as RunId, orderId);
          }}
          /* Правка и удаление отсюда закрыты: карточка открыта поиском, а не
             базой инженеров, и менять штат мимоходом — не то, за чем сюда
             пришли. Кадровые действия остаются в своей базе. */
          onSave={() => undefined}
          onDelete={() => undefined}
          locked={engineReady() ? CREW_ENGINE_LOCK : null}
        />
      )}
    </div>
  );
}
