import { useMemo, useState } from 'react';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { DayView, Segment } from '../data/derive.ts';
import { dec, engineerTimeline, hhmm, visits as pluralVisits } from '../data/derive.ts';
import { skillIcon, skillName } from '../data/dictionary.ts';
import type { Selection } from '../app/selection.ts';

interface Props {
  view: DayView;
  mode: string;
  cut: number;
  selection: Selection;
  onSelectEngineer: (id: string) => void;
}

type Sort = 'load' | 'visits' | 'name';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'load', label: 'По загрузке' },
  { value: 'visits', label: 'По визитам' },
  { value: 'name', label: 'По алфавиту' }
];

const KIND_LABEL: Record<Segment['kind'], string> = {
  travel: 'Дорога',
  wait: 'Ждёт открытия окна',
  work: 'Работа',
  idle: 'Простой',
  lunch: 'Окно под обед'
};

export function EngineersScreen({ view, mode, cut, selection, onSelectEngineer }: Props) {
  const [sort, setSort] = useState<Sort>('load');
  const [skill, setSkill] = useState<string | null>(null);

  const selected = selection.kind === 'engineer' ? selection.id : null;

  const breached = useMemo(
    () => new Set([...view.stopByOrder.values()].filter((p) => p.slaBreached).map((p) => p.engineerId)),
    [view]
  );

  const skills = useMemo(() => {
    const map = new Map<string, number>();
    for (const load of view.loads) {
      for (const key of load.engineer.skills) map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [view]);

  const rows = useMemo(() => {
    const list = view.loads.filter((l) => !skill || l.engineer.skills.includes(skill));
    return [...list].sort((a, b) => {
      if (sort === 'visits') return b.visits - a.visits;
      if (sort === 'name') return a.engineer.name.localeCompare(b.engineer.name);
      return b.occupancy - a.occupancy;
    });
  }, [view, sort, skill]);

  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Бригада дня</h2>
        </div>

        <div className="filters">
          <SegmentedControl
            size="sm"
            items={SORTS}
            value={sort}
            onChange={(v: string) => setSort(v as Sort)}
          />
          <div className="filters__types">
            <button
              type="button"
              className={'chip' + (skill === null ? ' chip--on' : '')}
              onClick={() => setSkill(null)}
            >
              Все навыки
            </button>
            {skills.map(([key, count]) => (
              <button
                key={key}
                type="button"
                className={'chip' + (skill === key ? ' chip--on' : '')}
                onClick={() => setSkill(skill === key ? null : key)}
              >
                <Icon name={skillIcon(key)} size={13} />
                {skillName(key)}
                <span className="chip__count">{count}</span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {mode === 'cards' && (
        <div className="ecards">
          {rows.map(({ engineer, route, visits, occupancy, idle }) => {
            const segments = engineerTimeline(route, engineer, view.stopByOrder);
            const from = engineer.shift_start;
            const span = Math.max(1, engineer.shift_end - from);
            const pct = (m: number) => ((m - from) / span) * 100;
            const inShift = cut >= from && cut <= engineer.shift_end;

            return (
              <button
                key={engineer.id}
                type="button"
                className={'ecard' + (selected === engineer.id ? ' ecard--selected' : '')}
                onClick={() => onSelectEngineer(engineer.id)}
              >
                <span className="ecard__top">
                  <span className="ecard__name">{engineer.name}</span>
                  <span className="ecard__badges">
                    {breached.has(engineer.id) && <Badge tone="danger">Срыв срока</Badge>}
                    {occupancy >= 0.75 && <Badge tone="danger">Перегруз</Badge>}
                    {idle && <Badge tone="outline">Без заявок</Badge>}
                  </span>
                </span>

                <span className="ecard__meta">
                  {hhmm(engineer.shift_start)}–{hhmm(engineer.shift_end)} · разряд {engineer.grade} ·{' '}
                  {pluralVisits(visits)}
                </span>

                <span className="ecard__skills">
                  {engineer.skills.map((key) => (
                    <span key={key} className="chip chip--static">
                      <Icon name={skillIcon(key)} size={12} />
                      {skillName(key)}
                    </span>
                  ))}
                </span>

                <span className="ecard__load">
                  <span className="ecard__load-track">
                    <span
                      className={'ecard__load-fill' + (occupancy >= 0.75 ? ' ecard__load-fill--hot' : '')}
                      style={{ width: `${Math.min(occupancy * 100, 100)}%` }}
                    />
                  </span>
                  <span className="ecard__load-value">{Math.round(occupancy * 100)}%</span>
                </span>

                <span className="ecard__track">
                  {segments.map((segment, i) => {
                    const width = pct(segment.to) - pct(segment.from);
                    if (width <= 0) return null;
                    return (
                      <span
                        key={i}
                        className={'tl__seg tl__seg--' + segment.kind}
                        style={{ left: `${pct(segment.from)}%`, width: `${width}%` }}
                        title={`${hhmm(segment.from)}–${hhmm(segment.to)} · ${KIND_LABEL[segment.kind]}`}
                      />
                    );
                  })}
                  {inShift && <span className="ecard__now" style={{ left: `${pct(cut)}%` }} />}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {mode === 'table' && (
        <section className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Инженер</th>
                  <th>Навыки</th>
                  <th>Смена</th>
                  <th>Визиты</th>
                  <th>Загрузка</th>
                  <th>Работа</th>
                  <th>Дорога</th>
                  <th>Простой</th>
                  <th>Переработка</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ engineer, route, visits, occupancy }) => (
                  <tr
                    key={engineer.id}
                    className={'tbl__row' + (selected === engineer.id ? ' tbl__row--selected' : '')}
                    onClick={() => onSelectEngineer(engineer.id)}
                  >
                    <td>
                      <span className="tbl__strong">{engineer.name}</span>
                      <span className="tbl__sub">
                        {engineer.id} · разряд {engineer.grade}
                      </span>
                    </td>
                    <td>{engineer.skills.map(skillName).join(', ')}</td>
                    <td className="tbl__num">
                      {hhmm(engineer.shift_start)}–{hhmm(engineer.shift_end)}
                    </td>
                    <td className="tbl__num">{visits}</td>
                    <td className="tbl__num">{Math.round(occupancy * 100)}%</td>
                    <td className="tbl__num">{route ? `${route.totals.work_minutes} мин` : '—'}</td>
                    <td className="tbl__num">{route ? `${route.totals.travel_minutes} мин` : '—'}</td>
                    <td className="tbl__num">{route ? `${route.totals.idle_minutes} мин` : '—'}</td>
                    <td className="tbl__num">
                      {route && route.totals.overtime_minutes > 0 ? (
                        <span className="tbl__warn">{route.totals.overtime_minutes} мин</span>
                      ) : (
                        '0 мин'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="dash__section-note" style={{ marginTop: 'var(--sp-3)' }}>
            Средняя загрузка инженеров {dec(view.loads.reduce((a, l) => a + l.occupancy, 0) / Math.max(view.loads.length, 1) * 100)}%
          </p>
        </section>
      )}
    </div>
  );
}
