import { useEffect, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm } from '../data/derive.ts';
import type { IncidentKind, IncidentSpec, ReplanResult } from '../data/api.ts';

interface Props {
  open: boolean;
  view: DayView;
  runCode: string;
  /** День у движка. Без него пересчитывать нечего: расчёт на фикстурах
      живого дня за собой не имеет. */
  day: number | null;
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
}

/* Внести правку: день пошёл не так, как посчитали.

   Событий три, и это не удобство, а вывод из замеров. Выбытие инженера
   стоит дню 5,2 визита, и пересчёт возвращает 4,4 — жать обязательно.
   Задержка на сорок минут стоит 0,4–0,5, и пересчёт возвращает 0,1–0,7:
   буферы съедают её сами. Система, которая перетасовывает бригаду из-за
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
  }
];

const DELAYS = [20, 30, 40, 60, 90, 120];

export function IncidentDialog({
  open,
  view,
  runCode,
  day,
  cut,
  busy,
  failed,
  result,
  onClose,
  onRun,
  onKeep
}: Props) {
  const [kind, setKind] = useState<IncidentKind>('disabled');
  const [engineerId, setEngineerId] = useState('');
  /* У кого на участке авария. Пусто — «по городу»: так считалось раньше,
     и как ответ на вопрос «а вообще?» это по-прежнему законно. */
  const [nearId, setNearId] = useState('');
  const [minutes, setMinutes] = useState(40);
  const [urgent, setUrgent] = useState(2);
  const [at, setAt] = useState(cut);

  /* Момент открытия окна — момент, на котором стоит доска. Диспетчер
     подвинул ползунок к 13:40 и жмёт «внести правку»: пересчитывать надо
     оттуда, а не с начала смены. */
  useEffect(() => {
    if (open) setAt(cut);
  }, [open, cut]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const crew = view.loads.filter((load) => load.route && load.route.stops.length > 0);
  const chosen = engineerId || crew[0]?.engineer.id || '';
  const needsEngineer = kind === 'disabled' || kind === 'delayed';
  const ready = day !== null && (!needsEngineer || Boolean(chosen));

  const spec: IncidentSpec = {
    day: day ?? 1,
    at,
    kind,
    urgent,
    urgentNear: kind === 'urgent' && nearId ? nearId : undefined,
    engineerId: needsEngineer ? chosen : undefined,
    minutes
  };

  const replan = result?.meta.replan;
  const gain = replan ? replan.assigned_now - replan.assigned_as_is : 0;

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

      <div className="modal__card incident__card">
        <div className="modal__head">
          <h3 className="engine__title">
            {result ? 'Что дал пересчёт' : 'Внести правку'} · {runCode}
          </h3>
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
              Ниже — чего это стоило. Пересчёт пока нигде не сохранён: он живёт на экране, пока
              вы не нажмёте «Сохранить».
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
                    ? ' визитов сохранили исполнителя — по тем, кого ЧП не касалось'
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
            {replan.incident && (
              <div className="incident__fates">
                {(
                  [
                    ['rescued', 'Подхватили другие', 'ok'],
                    ['kept', 'Остались за ним', 'calm'],
                    ['lost', 'Не влезли никуда', 'bad']
                  ] as const
                ).map(([key, label, tone]) => {
                  const ids = replan.incident![key];
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
                Из {replan.incident?.pending_was.length ?? 0} визитов, что были у него впереди.
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
                    options={crew.map((load) => ({
                      value: load.engineer.id,
                      label: `${load.engineer.name} · ${load.visits} визитов`
                    }))}
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

            {day === null && (
              <div className="solvefail">
                <Icon name="alert-triangle" size={16} />
                <span>
                  <b>Этот расчёт пересчитать нельзя.</b> Он открыт из записанных дней, а не
                  посчитан движком: пересобирать нечего. Заведите расчёт кнопкой «Создать
                  расчёт» — его пересчитать можно.
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
