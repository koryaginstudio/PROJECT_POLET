import { useEffect, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm } from '../data/derive.ts';
import type { IncidentKind, IncidentSpec, ReplanResult } from '../data/api.ts';
import { loadEngineSettings } from '../data/api.ts';
import { useModalFocus } from './modal.ts';

interface Props {
  open: boolean;
  view: DayView;
  runCode: string;
  /** День у движка. Без него пересчитывать нечего: расчёт, посчитанный
      здесь, в браузере, дня у движка за собой не имеет. */
  day: string | null;
  /** Запущен ли движок. Пересчёт по событию делает он, и без него окно
      честно говорит, что кнопка не сработает. */
  live: boolean;
  /** Момент, с которого пересобирается остаток. */
  cut: number;
  busy: boolean;
  failed: string | null;
  /** Что вернул пересчёт. Пока пусто — окно показывает форму события. */
  result: ReplanResult | null;
  onClose: () => void;
  onRun: (spec: IncidentSpec) => void;
  /** Оставить пересчёт: он станет несохранённым состоянием на экране. */
  onKeep: () => void;
  /** Каким событием открыть окно. Экран «Воздействия» открывает его уже
      на выбранном событии: диспетчер нажал «Инженер выбыл» — окно про
      выбытие, а не про то, что было выбрано в прошлый раз. */
  initialKind?: IncidentKind;
}

/* Внести правку: день пошёл не так, как посчитали.

   Событий четыре, и это не удобство, а вывод из замеров на зонах
   (`замеры-21-09/`). Выбытие инженера утром стоит дню 4,6 визита, и
   пересчёт возвращает 3,2 — жать обязательно. Задержка на сорок минут
   стоит 0,2–0,3, и пересчёт из неё не возвращает ничего: буферы съедают
   её сами. Система, которая перетасовывает бригаду из-за
   прокола колеса, хуже той, что не делает ничего — людям уже позвонили и
   сказали ехать.

   Поэтому у каждого события стоит вердикт, а после пересчёта показывается
   его настоящая цена: сколько визитов выиграли против «поехали как ехали»,
   скольких не тронули, и куда делись визиты выбывшего. Кнопка «пересчитать»
   есть всегда, но решение принимается по этим числам, а не по тому, что она
   доступна.

   Окно живёт в двух состояниях: до пересчёта — выбор события, после —
   его разбор. Разводить это на два окна незачем: вопрос один и тот же,
   просто на него уже ответили. */

const KINDS: {
  value: IncidentKind;
  icon: string;
  title: string;
  what: string;
  verdict: 'press' | 'skip';
  verdictText: string;
}[] = [
  {
    value: 'urgent',
    icon: 'alert-triangle',
    title: 'Авария',
    what: 'Пришли срочные заявки, которых не было в плане. Можно указать, на чьём участке.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    value: 'disabled',
    icon: 'user',
    title: 'Инженер выбыл',
    what: 'Сегодня его не будет: заболел, отозвали, машина не поехала.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    value: 'delayed',
    icon: 'clock',
    title: 'Инженер задержится',
    what: 'Прокол, пробка, затянувшийся визит — выйдет на маршрут позже.',
    verdict: 'skip',
    verdictText: 'Чаще не стоит'
  },
  {
    /* Третье событие пересчёта из ТЗ. Тип в вёрстке был, а кнопки не было:
       отмена не попадала в запрос вовсе. */
    value: 'cancel',
    icon: 'x-circle',
    title: 'Абонент отказался',
    what: 'Заявку сняли: освободилось время, и в него может влезть то, что не влезало.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  }
];

const DELAYS = [20, 30, 40, 60, 90, 120];

export function IncidentDialog({
  open,
  view,
  runCode,
  day,
  live,
  cut,
  busy,
  failed,
  result,
  onClose,
  onRun,
  onKeep,
  initialKind
}: Props) {
  const [kind, setKind] = useState<IncidentKind>('disabled');
  /* Какую заявку сняли. Пусто — `auto`: движок снимет ту, отказ от которой
     освободит больше всего времени. */
  const [orderId, setOrderId] = useState('');
  /* Штраф за смену исполнителя — живой контрол окна правки. Встаёт туда, где
     стоит настройка компании у движка; `null`, пока не прочитали, — тогда
     в запрос не уходит, и движок берёт свою. */
  const [churn, setChurn] = useState<number | null>(null);
  const [churnMax, setChurnMax] = useState(200);
  const [engineerId, setEngineerId] = useState('');
  /* У кого на участке авария. Пусто — «по городу»: так считалось раньше,
     и как ответ на вопрос «а вообще?» это по-прежнему законно. */
  const [nearId, setNearId] = useState('');
  const [minutes, setMinutes] = useState(40);
  const [urgent, setUrgent] = useState(2);
  const [at, setAt] = useState(cut);
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(open, card);

  /* Момент открытия окна — момент, на котором стоит доска. Диспетчер
     подвинул ползунок к 13:40 и жмёт «внести правку»: пересчитывать надо
     оттуда, а не с начала смены. */
  useEffect(() => {
    if (open) setAt(cut);
  }, [open, cut]);

  useEffect(() => {
    if (open && initialKind) setKind(initialKind);
  }, [open, initialKind]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    loadEngineSettings()
      .then(({ settings }) => {
        const setting = settings.churn_penalty;
        if (!alive || !setting) return;
        setChurn(setting.value);
        /* Верхний предел у движка — тысяча, но ползунку столько не нужно:
           различимая часть шкалы — первые пара сотен. */
        setChurnMax(Math.max(200, Math.min(setting.max, setting.value * 4)));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  /* Выбыть или задержаться может только тот, у кого после момента правки
     ещё есть работа. Не выбран никто — «самый занятой сейчас», `auto`:
     движок сам возьмёт того, у кого впереди больше всего. */
  const crew = view.loads.filter(
    (load) => load.route && load.route.stops.some((stop) => stop.start >= at)
  );
  const chosen = engineerId || 'auto';
  const needsEngineer = kind === 'disabled' || kind === 'delayed';
  const ready = live && day !== null && (!needsEngineer || Boolean(chosen));

  /* Что ещё можно снять: визиты, к которым по плану не выехали до момента
     правки. Начатое и сделанное отменять нечего, а к визиту, куда инженер
     уже едет, движок его и доигрывает («в пути») и на отмену отвечает 400. */
  const cancellable = view.loads
    .flatMap((load) => (load.route ? load.route.stops : []))
    .filter((stop) => stop.arrive - stop.travel_minutes >= at)
    .sort((a, b) => a.start - b.start);

  const spec: IncidentSpec = {
    /* Пустая строка, а не синтетический день 1: `ready` всё равно не даст
       отправить без дня, а подстановка чужого дня — это молчаливый чужой
       расчёт под видом нашего. */
    day: day ?? '',
    at,
    kind,
    urgent,
    urgentNear: kind === 'urgent' && nearId ? nearId : undefined,
    engineerId: needsEngineer ? chosen : undefined,
    minutes,
    orderId: kind === 'cancel' && orderId ? orderId : undefined,
    churnPenalty: churn ?? undefined
  };

  const replan = result?.meta.replan;
  const gain = replan ? replan.assigned_now - replan.assigned_as_is : 0;
  /* Разбор события: у ЧП с инженером — судьба его визитов, у отмены — что
     купила освободившаяся ёмкость. Формы разные, поэтому и ветки две. */
  const fates = replan?.incident && replan.incident.kind !== 'cancelled' ? replan.incident : null;
  const cancelled = replan?.incident && replan.incident.kind === 'cancelled' ? replan.incident : null;

  /* Чей участок накрыло — на экране именем, а не кодом: код инженера
     диспетчер держать в голове не обязан. */
  const nearName = replan?.urgent_near
    ? view.loads.find((load) => load.engineer.id === replan.urgent_near)?.engineer.name ??
      replan.urgent_near
    : null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Внести правку">
      <button
        type="button"
        className="modal__veil"
        onClick={() => !busy && onClose()}
        aria-label="Закрыть"
      />

      <div className="modal__card incident__card" ref={card}>
        <div className="modal__head">
          <h3 className="engine__title">
            {result ? 'Что дал пересчёт' : 'Внести правку'} · {runCode}
          </h3>
          {!busy && (
            <span className="modal__esc">
              <kbd>Esc</kbd> — закрыть
            </span>
          )}
          <button
            type="button"
            className="rpanel__x"
            onClick={onClose}
            disabled={busy}
            aria-label="Закрыть"
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        {result && replan ? (
          <>
            <p className="engine__lede">
              Движок пересобрал остаток дня от {hhmm(replan.at)} за {replan.solve_seconds} с.
              Ниже — чего это стоило.{' '}
              {replan.adopt_token
                ? 'Это пересчёт от событий дня: журнал не тронут, пока вы не нажмёте «Принять», — тогда он станет назначением дня. «Сохранить» потом положит его в архив.'
                : 'Пересчёт пока нигде не сохранён: он живёт на экране, пока вы не нажмёте «Сохранить».'}
            </p>

            {/* Цена воздействия. Первое число — то, ради чего сюда и
                заходят: пересчёт всегда можно сделать, вопрос был в том,
                нужно ли. */}
            <div className="incident__gain">
              <span className={'incident__gain-value' + (gain > 0 ? '' : ' incident__gain-value--flat')}>
                {gain > 0 ? `+${gain}` : gain}
              </span>
              <span className="incident__gain-label">
                {gain > 0 ? (
                  <>
                    визитов выиграли пересчётом: {replan.assigned_now} против{' '}
                    {replan.assigned_as_is}, если бы поехали как ехали
                  </>
                ) : (
                  <>
                    пересчёт ничего не добавил: {replan.assigned_now} визитов и так, и так.
                    Буферы в маршруте справились сами
                  </>
                )}
              </span>
            </div>

            <div className="setrow">
              <span className="setrow__key">Кого не тронули</span>
              <span className="setrow__val">
                {Math.round((replan.incident?.stability_others ?? replan.stability) * 100)}%
                <span className="setrow__note">
                  {replan.incident
                    ? ' визитов сохранили исполнителя — по тем, кого событие не касалось'
                    : ' визитов сохранили исполнителя'}
                </span>
              </span>
            </div>

            {replan.urgent_ids.length > 0 && (
              <div className="setrow">
                <span className="setrow__key">Аварии</span>
                <span className="setrow__val">
                  {replan.urgent_assigned} из {replan.urgent_ids.length} влезли в план
                  <span className="setrow__note">
                    {nearName
                      ? ` · на участке, где в ${hhmm(replan.at)} работал ${nearName};` +
                        ' кто поехал — решил движок'
                      : ' · пришли по городу, без привязки к участку'}
                  </span>
                </span>
              </div>
            )}

            {/* Судьба визитов выбывшего. Три исхода в сумме дают ровно то,
                что было у него впереди — ничего не теряется по дороге. */}
            {cancelled && (
              <>
                <div className="setrow">
                  <span className="setrow__key">Сняли</span>
                  <span className="setrow__val">
                    {cancelled.order_ids.join(', ')}
                    <span className="setrow__note">
                      {` · освободилось ${cancelled.freed_minutes} мин работы по нормативу`}
                    </span>
                  </span>
                </div>
                <div className="setrow">
                  <span className="setrow__key">Влезло взамен</span>
                  <span className="setrow__val">
                    {cancelled.picked_up_count > 0
                      ? `${cancelled.picked_up_count}: ${cancelled.picked_up.join(', ')}`
                      : 'ничего — освободившееся время заполнить нечем'}
                  </span>
                </div>
              </>
            )}

            {fates && (
              <div className="incident__fates">
                {(
                  [
                    ['rescued', 'Подхватили другие', 'ok'],
                    ['kept', 'Остались за ним', 'calm'],
                    ['lost', 'Не влезли никуда', 'bad']
                  ] as const
                ).map(([key, label, tone]) => {
                  const ids = fates[key];
                  return (
                    <div key={key} className={'incident__fate incident__fate--' + tone}>
                      <span className="incident__fate-value">{ids.length}</span>
                      <span className="incident__fate-label">{label}</span>
                      {ids.length > 0 && (
                        <span className="incident__fate-ids">{ids.join(', ')}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="manual__foot">
              <span className="manual__note">
                {fates
                  ? `Из ${fates.pending_was.length} визитов, что были у него впереди.`
                  : `Штраф за смену исполнителя — ${replan.churn_penalty ?? '—'}.`}
              </span>
              <span className="manual__actions">
                <Button variant="secondary" size="sm" onClick={onClose}>
                  Отменить правку
                </Button>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={onKeep}
                  iconLeft={<Icon name="check" size={14} />}
                >
                  Принять
                </Button>
              </span>
            </div>
          </>
        ) : (
          <>
            <h4 className="incident__subtitle">Причина</h4>

            <div className="incident__kinds">
              {KINDS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  className={'incident__kind' + (kind === item.value ? ' incident__kind--on' : '')}
                  onClick={() => setKind(item.value)}
                >
                  <span className="incident__kind-top">
                    <Icon name={item.icon} size={15} />
                    <span className="incident__kind-title">{item.title}</span>
                    <span
                      className={
                        'incident__verdict incident__verdict--' +
                        (item.verdict === 'press' ? 'press' : 'skip')
                      }
                    >
                      {item.verdictText}
                    </span>
                  </span>
                  <span className="incident__kind-what">{item.what}</span>
                </button>
              ))}
            </div>

            <div className="incident__params">
              <label className="incident__field">
                <span className="incident__field-label">Когда случилось</span>
                <input
                  className="rule__input"
                  type="time"
                  value={hhmm(at)}
                  onChange={(e) => {
                    const [h, m] = e.currentTarget.value.split(':').map(Number);
                    if (Number.isFinite(h) && Number.isFinite(m)) setAt(h * 60 + m);
                  }}
                />
              </label>

              {needsEngineer && (
                <label className="incident__field">
                  <span className="incident__field-label">Кто</span>
                  <Select
                    size="sm"
                    value={chosen}
                    onChange={(e) => setEngineerId(e.target.value)}
                    options={[
                      { value: 'auto', label: 'Самый занятой сейчас' },
                      ...crew.map((load) => ({
                        value: load.engineer.id,
                        label: `${load.engineer.name} · ${load.visits} визитов`
                      }))
                    ]}
                  />
                </label>
              )}

              {kind === 'delayed' && (
                <label className="incident__field">
                  <span className="incident__field-label">На сколько</span>
                  <Select
                    size="sm"
                    value={String(minutes)}
                    onChange={(e) => setMinutes(Number(e.target.value))}
                    options={DELAYS.map((d) => ({ value: String(d), label: `${d} мин` }))}
                  />
                </label>
              )}

              {kind === 'cancel' && (
                <label className="incident__field">
                  <span className="incident__field-label">Какую заявку</span>
                  <Select
                    size="sm"
                    value={orderId}
                    onChange={(e) => setOrderId(e.target.value)}
                    options={[
                      { value: '', label: 'Ту, что освободит больше всего времени' },
                      ...cancellable.map((stop) => ({
                        value: stop.order_id,
                        label: `${stop.order_id} · ${hhmm(stop.start)}`
                      }))
                    ]}
                  />
                </label>
              )}

              {kind === 'urgent' && (
                <>
                  <label className="incident__field">
                    <span className="incident__field-label">Сколько аварий</span>
                    <Select
                      size="sm"
                      value={String(urgent)}
                      onChange={(e) => setUrgent(Number(e.target.value))}
                      options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
                    />
                  </label>

                  {/* Чей участок. Диспетчер обычно знает не только время, но
                      и место: авария приходит на трассу, которую ведёт
                      конкретный инженер. Без этого пересчёт отвечал на другой
                      вопрос — про среднюю аварию в среднем районе. Самому
                      названному инженеру заявка не назначается: она идёт в
                      общий пул, и кто поедет, решает движок. */}
                  <label className="incident__field">
                    <span className="incident__field-label">У кого на участке</span>
                    <Select
                      size="sm"
                      value={nearId}
                      onChange={(e) => setNearId(e.target.value)}
                      options={[
                        { value: '', label: 'По городу — без привязки' },
                        ...crew.map((load) => ({
                          value: load.engineer.id,
                          label: `${load.engineer.name} · ${load.visits} визитов`
                        }))
                      ]}
                    />
                  </label>
                </>
              )}
            </div>

            {/* Живой контрол окна правки — одна из семи договорённых
                настроек: насколько пересчёт держится за то, кому уже сказали
                ехать. Ноль — перетасует свободно, больше — меньше перемен.
                Встаёт на настройку компании у движка. */}
            {churn !== null && (
              <label className="incident__field incident__field--wide">
                <span className="incident__field-label">
                  Держаться за назначенных: штраф за смену исполнителя {churn}
                </span>
                <input
                  className="incident__range"
                  type="range"
                  min={0}
                  max={churnMax}
                  step={10}
                  value={churn}
                  onChange={(e) => setChurn(Number(e.currentTarget.value))}
                />
              </label>
            )}

            {/* Правду, а не обещание: пересчёт по событию делает движок, и
                пока он не запущен, недоступен он у любого расчёта — новый,
                заведённый кнопкой, считается здесь же, в браузере, и дня у
                движка за собой не имеет. */}
            {(!live || day === null) && (
              <div className="solvefail">
                <Icon name="alert-triangle" size={16} />
                <span>
                  <b>Пересчёт по событию сейчас недоступен.</b>{' '}
                  {!live
                    ? 'Его делает движок, а он не запущен. Как включить — в настройках, на вкладке «Данные». Пока можно пересобрать день другими переменными через «Ручное управление».'
                    : 'Этот расчёт посчитан в браузере, а не движком, и дня у движка за собой не имеет — пересобирать ему нечего.'}
                </span>
              </div>
            )}

            {failed && (
              <div className="solvefail">
                <Icon name="alert-triangle" size={16} />
                <span>
                  <b>Пересчёт не пошёл.</b> {failed}
                </span>
              </div>
            )}

            <div className="manual__foot">
              <span className="manual__note">
                {busy ? (
                  <span className="createbar__busy">
                    <span className="createbar__spin" aria-hidden="true" />
                    Пересобираю маршруты — около полутора секунд.
                  </span>
                ) : (
                  'Пересчёт ничего не сохранит: результат появится на экране, и решать по нему.'
                )}
              </span>
              <span className="manual__actions">
                <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
                  Отмена
                </Button>
                <Button
                  variant="accent"
                  size="sm"
                  onClick={() => onRun(spec)}
                  disabled={busy || !ready}
                  iconLeft={<Icon name="lightning" size={14} />}
                >
                  {busy ? 'Считаю…' : 'Пересчитать'}
                </Button>
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
