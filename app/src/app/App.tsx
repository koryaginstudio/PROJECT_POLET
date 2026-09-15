import { useEffect, useMemo, useRef, useState } from 'react';
import type { Day } from '../data/contract.ts';
import {
  ContractError,
  createRun,
  deleteRun,
  updateRun,
  latestRun,
  loadDay,
  loadSummaries,
  engineReady,
  runCode,
  runEntry
} from '../data/load.ts';
import type { EngineParams } from '../data/engine.ts';
import type { RunId, DaySummary, SourceId } from '../data/load.ts';
import { exportRun } from '../data/report.ts';
import { replanDay, saveReplan } from '../data/api.ts';
import type { IncidentSpec, ReplanResult } from '../data/api.ts';
import { loadRegistry } from '../data/registry.ts';
import type { Registry, RunRef } from '../data/registry.ts';
import { buildDayView, dayStart, plural } from '../data/derive.ts';
import { useService } from '../data/service.ts';
import { Header } from './Header.tsx';
import { SubHeader } from './SubHeader.tsx';
import { Sidebar } from './Sidebar.tsx';
import { DetailPanel } from './DetailPanel.tsx';
import { EngineDialog } from './EngineDialog.tsx';
import { HomeScreen } from '../screens/HomeScreen.tsx';
import { DispatchGate } from '../screens/DispatchGate.tsx';
import { CreateRunScreen } from '../screens/CreateRunScreen.tsx';
import { DashboardScreen } from '../screens/DashboardScreen.tsx';
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
import { Stub } from '../screens/Stub.tsx';
import { CompareScreen } from '../screens/CompareScreen.tsx';
import { SettingsScreen } from '../screens/SettingsScreen.tsx';
import { RunEditDialog } from './RunEditDialog.tsx';
import { ManualDialog } from './ManualDialog.tsx';
import { IncidentDialog } from './IncidentDialog.tsx';
import { isDbSection, needsRegistry, SUBHEADER } from './nav.ts';
import type { SectionId } from './nav.ts';
import { firstView, readRoute, sameRoute, writeRoute } from './route.ts';
import type { Route } from './route.ts';
import { COMPARE_MAX } from './compare.ts';
import { OVERVIEW } from './selection.ts';
import type { Selection } from './selection.ts';

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
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(OVERVIEW);
  /* Настройки сервиса нужны здесь целиком: от них зависят и границы смены, и
     пороги, по которым считается день, — а значит, перерисоваться должно всё
     дерево, а не только экран настроек. */
  const settings = useService();
  const [navCollapsed, setNavCollapsed] = useState(settings.navCollapsed);
  /* Список прогонов нужен переключателю в подшапке и сравнению — грузим один
     раз на сессию, он не зависит от открытого расчёта. */
  const [runs, setRuns] = useState<DaySummary[] | null>(null);
  /* Базы данных и статистика живут над прогоном: свой источник, своя загрузка
     и только тогда, когда в них впервые заходят. */
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [registryError, setRegistryError] = useState<string | null>(null);
  /* День всегда открывается с его начала: диспетчер сам ведёт момент
     вперёд и смотрит, как движок перестраивает остаток смены. */
  const [cut, setCut] = useState(dayStart);
  /* Пересчёт запускается из любого раздела, поэтому окно живёт здесь, а не
     внутри блока «Расчёт». */
  const [rebuilding, setRebuilding] = useState(false);
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
     каждое событие давало бы новый объект и лишнюю перерисовку. */
  useEffect(() => {
    const sync = () =>
      setRoute((prev) => {
        const next = readRoute(window.location.hash);
        return sameRoute(prev, next) ? prev : next;
      });
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
       два расчёта в один экран. Уйти, не заметив, нельзя: переход спросит. */
    setDraft(null);
    setReplan(null);
    setSaveFailed(null);
  }, [runId]);

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
        setSelection(OVERVIEW);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof ContractError ? e.message : 'Расчёт не загрузился');
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useEffect(() => {
    let cancelled = false;
    loadSummaries()
      .then((list) => !cancelled && setRuns(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  /* Заходим в раздел поверх прогонов — подтягиваем справочники один раз:
     они общие для баз и статистики и от выбранного расчёта не зависят. */
  const crossRun = needsRegistry(section);
  const onDb = isDbSection(section);
  useEffect(() => {
    if (!crossRun || registry) return;
    let cancelled = false;
    setRegistryError(null);
    loadRegistry()
      .then((loaded) => {
        if (!cancelled) setRegistry(loaded);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setRegistryError(e instanceof ContractError ? e.message : 'Базы данных не загрузились');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [crossRun, registry]);

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
    deleteRun(gone);
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
  const [incidentBusy, setIncidentBusy] = useState(false);
  const [incidentFailed, setIncidentFailed] = useState<string | null>(null);
  const [replan, setReplan] = useState<ReplanResult | null>(null);
  /* Принятый, но не сохранённый пересчёт. Пока он здесь — экран показывает
     его план, а не тот, что лежит в архиве. */
  const [draft, setDraft] = useState<{ spec: IncidentSpec; result: ReplanResult } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState<string | null>(null);

  const runIncident = async (spec: IncidentSpec) => {
    if (incidentBusy) return;
    setIncidentBusy(true);
    setIncidentFailed(null);
    try {
      setReplan(await replanDay(spec));
      setLastSpec(spec);
    } catch (failure) {
      setIncidentFailed(failure instanceof Error ? failure.message : 'Пересчёт не удался');
    } finally {
      setIncidentBusy(false);
    }
  };

  const [lastSpec, setLastSpec] = useState<IncidentSpec | null>(null);

  /* Принять пересчёт: он становится тем, что показано на экране. В архив
     при этом ничего не уходит — для этого есть «Сохранить». */
  const keepReplan = () => {
    if (!replan || !lastSpec) return;
    setDraft({ spec: lastSpec, result: replan });
    setIncidentOpen(false);
    setReplan(null);
    /* Момент переезжает к тому, с которого пересобрали: экран теперь
       показывает остаток дня, и стоять на утре ему незачем. */
    setCut(replan.meta.replan.at);
  };

  const dropDraft = () => {
    setDraft(null);
    setSaveFailed(null);
  };

  /* Сохранить: пересчёт ложится в архив отдельной записью, помеченной как
     правка, со ссылкой на расчёт, от которого он отпочковался. */
  const saveDraft = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setSaveFailed(null);
    try {
      const entry = await saveReplan(draft.spec, runId);
      setDraft(null);
      loadSummaries().then(setRuns).catch(() => undefined);
      openRun(entry.id);
    } catch (failure) {
      setSaveFailed(failure instanceof Error ? failure.message : 'Сохранить не удалось');
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
  const dayView = useMemo(
    () => (shownDay ? buildDayView(shownDay) : null),
    [shownDay, settings.thresholds, settings.dayStart, settings.dayEnd]
  );
  /* Правая панель показывает список маршрутов вместо справочника там, где
     карта — основной способ смотреть на день: на вкладке «Карта» в
     диспетчерской и на всём мониторинге, который сам почти целиком карта. */
  const onPlan = section === 'dispatch' && stage === 'plan';
  const onMap = (onPlan && view === 'map') || section === 'monitor';

  const goSection = (id: SectionId) => {
    /* Шаг диспетчерской переход между разделами не трогает: открытый расчёт
       остаётся открытым. Раньше возврат в диспетчерскую снова начинался с
       вопроса «создать или выбрать» — и расчёт, помеченный в базе открытым,
       открытым не оказывался. Вопрос теперь задаётся один раз, пока не
       открыт ни один; дальше расчёты переключают лентой в подшапке и базой,
       а завести новый можно кнопкой в меню. */
    nav({ section: id, view: firstView(id) });
  };

  const openRun = (id: RunId) => {
    setCut(dayStart());
    /* Выбор расчёта — где угодно: в ленте подшапки, в базе расчётов, на
       дашборде — и есть открытие плана. */
    nav({ runId: id, stage: 'plan' });
  };

  /* Щелчок по карте в карточке расчёта: открыть его и сразу показать карту —
     плитка обещает карту, значит, к ней и ведёт. */
  const openRunMap = (id: RunId) => {
    setCut(dayStart());
    nav({ runId: id, stage: 'plan', section: 'dispatch', view: 'map' });
  };

  /* «Перейти» у открытого расчёта: ведёт к нему в диспетчерскую, ничего в
     нём не переоткрывая — момент и выбранный объект остаются как были. */
  const goToRun = (id: RunId) =>
    nav({ runId: id, stage: 'plan', section: 'dispatch', view: firstView('dispatch') });

  /* «Открыть» в базе расчётов открывает его по-настоящему — с переходом к
     плану. Раньше кнопка только помечала карточку, а диспетчерская всё равно
     встречала вопросом «создать или выбрать»: расчёт числился открытым и
     открытым не был. */
  const openRunFromDb = (id: RunId) => {
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
    if (draft && !window.confirm('Пересчёт не сохранён — закрыть расчёт и потерять его?')) return;
    setDraft(null);
    setReplan(null);
    setSaveFailed(null);
    nav({ section: 'dispatch', view: firstView('dispatch'), stage: 'gate' });
  };

  /* Завести расчёт можно из любого раздела — кнопка в меню ведёт к той же
     форме, что и «Создать расчёт» в диспетчерской. Форма одна: два входа в
     две разные формы разошлись бы при первой же правке. */
  const createRunForm = () => nav({ section: 'dispatch', stage: 'create' });

  /* Выгрузка расчёта книгой Excel. Собирается из того, что уже загружено:
     формы открытого дня лежат в памяти, и ходить за ними второй раз незачем. */
  const exportDay = () => {
    if (!day) return;
    exportRun(day, runEntry(runId));
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
    const who = incident
      ? day?.plan.engineers.find((e) => e.id === incident.engineer_id)?.name
      : null;
    const what = incident
      ? incident.kind === 'disabled'
        ? `${who ?? incident.engineer_id} выбыл до конца дня`
        : `${who ?? incident.engineer_id} задержался на ${incident.minutes} мин`
      : `${plural(meta.urgent_ids.length, 'авария', 'аварии', 'аварий')} в плане`;
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
      loadSummaries().then(setRuns).catch(() => undefined);
      setManual(false);
      openRun(entry.id);
    } catch (failure) {
      setManualFailed(failure instanceof Error ? failure.message : 'Пересчёт не удался');
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

  const runEngine = async (params: EngineParams, zone?: SourceId) => {
    if (solving) return;
    setSolving(true);
    setSolveFailed(null);
    try {
      const entry = await createRun(params, zone);
      loadSummaries().then(setRuns).catch(() => undefined);
      openRun(entry.id);
      setRebuilding(true);
    } catch (failure) {
      /* Движок не ответил или отказал — остаёмся на форме и говорим, что
         случилось. Уводить на пустой расчёт, которого нет, нельзя. */
      setSolveFailed(failure instanceof Error ? failure.message : 'Расчёт не удался');
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
        view={null}
        solving={solving}
        failed={solveFailed}
        first
      />
    );
  }

  if (error) {
    return (
      <div style={{ padding: 48, maxWidth: 560 }}>
        <h1 style={{ fontSize: 28 }}>Расчёт не загрузился</h1>
        <p style={{ marginTop: 12, color: 'var(--text-secondary)' }}>{error}</p>
        <p style={{ marginTop: 12, color: 'var(--text-secondary)' }}>
          Интерфейс собран под схему 1.0. Проверьте, что отдаёт источник данных.
        </p>
      </div>
    );
  }

  if (!day || !dayView) {
    return <div style={{ padding: 48, color: 'var(--text-secondary)' }}>Загружаем расчёт…</div>;
  }

  const counts = {
    orders: day.plan.meta.orders_total,
    unassigned: dayView.unassigned.length,
    routes: day.plan.routes.length,
    engineers: day.plan.meta.engineers_total,
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

  /* Правая панель всегда про объект открытого прогона. Там, где прогона нет,
     её не показываем — и колонку под неё тоже, иначе справа остаётся пустая
     полоса, которая читается как несработавший экран. Дашборд обзорный и
     объекта не выбирает, поэтому тоже идёт без неё. */
  const withDetail = onPlan || section === 'monitor';

  const registryPending = registryError ? (
    <div className="stub enter">
      <h2 className="stub__title">Данные не загрузились</h2>
      <p className="stub__body">{registryError}</p>
    </div>
  ) : (
    <div className="stub enter">
      <h2 className="stub__title">Собираем данные</h2>
      <p className="stub__body">
        Читаем планы всех расчётов — раздел строится по ним сразу, а не по открытому прогону.
      </p>
    </div>
  );

  return (
    <div
      className={
        'shell' +
        (navCollapsed ? ' shell--nav-collapsed' : '') +
        (withDetail ? '' : ' shell--wide')
      }
    >
      <Header
        collapsed={navCollapsed}
        onToggleNav={() => setNavCollapsed((v) => !v)}
        view={dayView}
        onSelect={setSelection}
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
          {section === 'home' && (
            <HomeScreen
              day={day}
              view={dayView}
              runs={runs}
              activeRun={runId}
              onGoSection={goSection}
              onOpenRun={openRun}
            />
          )}

          {section === 'monitor' && (
            <MonitorScreen
              view={dayView}
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
            <ControlScreen runCode={runCode(runId)} cut={cut} live={engineReady()} />
          )}

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
              view={dayView}
              solving={solving}
              failed={solveFailed}
            />
          )}

          {section === 'dispatch' && stage === 'plan' && (
            <DashboardScreen
              day={day}
              view={dayView}
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

          {/* Статистика снята под новую сборку: прежнее наполнение считалось
              по всем расчётам сразу и с отбором расчётов не связано. */}
          {section === 'stats' && (
            <Stub title={SUBHEADER[section].title} onBack={() => goSection('dispatch')} />
          )}

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
              <DbServicesScreen registry={registry} mode={view} />
            ) : section === 'db-orders' ? (
              <DbOrdersScreen registry={registry} mode={view} />
            ) : section === 'db-clients' ? (
              <DbClientsScreen registry={registry} mode={view} />
            ) : section === 'db-routes' ? (
              <DbRoutesScreen registry={registry} mode={view} />
            ) : (
              <DbEngineersScreen
                registry={registry}
                mode={view}
                /* Правка штата меняет данные, а не только карточку: справочник
                   и открытый расчёт пересобираются с нуля. */
                onChanged={() => {
                  setRegistry(null);
                  loadDay(runId).then(setDay).catch(() => undefined);
                  loadSummaries().then(setRuns).catch(() => undefined);
                }}
                /* «Отследить» из профиля: пока своего экрана слежения нет,
                   ведём в мониторинг — он и отвечает на «где инженер сейчас
                   и что делает». Если человек в открытом сегодня расчёте, тут
                   же закрепляем на нём маршрут и открываем его карточку;
                   если нет — просто открываем мониторинг, показывать там
                   нечего, но раздел тот. */
                onTrack={(id) => {
                  nav({ section: 'monitor' });
                  if (dayView?.loads.some((load) => load.engineer.id === id)) {
                    pinRoute(id);
                    setSelection({ kind: 'engineer', id });
                  }
                }}
              />
            ))}

          {section === 'engine' && (
            <SettingsScreen mode={view} registry={registry} onEditsCleared={refreshRuns} />
          )}
        </main>

        {withDetail && (
          <aside className="shell__detail">
            {/* У каждой вкладки плана правая панель своя: она договаривает
                то, чего не говорит сама вкладка. Карта — «во сколько и что»
                по маршрутам, гант — где в дне свободные руки сошлись с
                невзятыми окнами, канбан — кто сколько успел закрыть к
                этому моменту. Сводке договаривать нечего, у неё справочник. */}
            {onMap ? (
              <RoutePanel
                view={dayView}
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
                view={dayView}
                onHoverHour={setHotHour}
                onSelectOrder={(id) => setSelection({ kind: 'order', id })}
                onSelectEngineer={(id) => setSelection({ kind: 'engineer', id })}
              />
            ) : onPlan && view === 'kanban' ? (
              <CrewPanel
                view={dayView}
                cut={cut}
                onCutChange={setCut}
                selected={selection.kind === 'order' ? selection.id : null}
                onSelectOrder={(id) => setSelection({ kind: 'order', id })}
                onSelectEngineer={(id) => setSelection({ kind: 'engineer', id })}
              />
            ) : (
              <DetailPanel
                day={day}
                view={dayView}
                selection={selection}
                onSelect={setSelection}
              />
            )}
          </aside>
        )}
      </div>

      <EngineDialog cut={cut} open={rebuilding} onClose={() => setRebuilding(false)} />

      <IncidentDialog
        open={incidentOpen}
        view={dayView}
        runCode={runCode(runId)}
        day={runEntry(runId).day ?? null}
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
      />

      <ManualDialog
        open={manual}
        runCode={runCode(runId)}
        params={runEntry(runId).params}
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
    </div>
  );
}
