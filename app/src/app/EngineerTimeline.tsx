import { useState } from 'react';
import type { Engineer, Route } from '../data/contract.ts';
import type { DayView, Segment } from '../data/derive.ts';
import { dayEnd, dayStart, engineerTimeline, hhmm } from '../data/derive.ts';

const KIND_LABEL: Record<Segment['kind'], string> = {
  travel: 'Дорога',
  wait: 'Ожидание окна',
  work: 'Работа',
  idle: 'Простой',
  lunch: 'Окно под обед'
};

const LEGEND: { kind: Segment['kind']; label: string }[] = [
  { kind: 'work', label: 'Работа' },
  { kind: 'travel', label: 'Дорога' },
  { kind: 'wait', label: 'Ожидание окна' },
  { kind: 'lunch', label: 'Обед' }
];

import { pct } from './scale.ts';

/** Доля внутри смены инженера: куски ленты считаются от её начала. */
const inShift = (m: number, engineer: Engineer) => {
  const span = Math.max(1, engineer.shift_end - engineer.shift_start);
  return (
    ((Math.min(engineer.shift_end, Math.max(engineer.shift_start, m)) - engineer.shift_start) /
      span) *
    100
  );
};

interface Props {
  engineer: Engineer;
  route: Route | undefined;
  view: DayView;
  onPickOrder: (id: string) => void;
}

/* Лента дня инженера.

   Собрана из тех же частей и теми же классами, что строка ганта в
   диспетчерской: дорожка на весь день с гребёнкой часов, внутри — скруглённая
   лента смены, внутри неё — куски работы, дороги и ожидания. Один и тот же
   день не должен выглядеть в двух местах по-разному, поэтому оформление здесь
   не своё, а то же самое: правка ганта меняет и эту ленту.

   Отметки текущего времени нет: правая панель со временем не связана, и
   бегущая метка обещала бы связь, которой нет. */
export function EngineerTimeline({ engineer, route, view, onPickOrder }: Props) {
  /* Наведение на кусок ленты подсвечивает свою строку легенды, и наоборот:
     иначе цвет приходится расшифровывать глазами, бегая от ленты к подписям
     и обратно. */
  const [hot, setHot] = useState<Segment['kind'] | null>(null);
  const segments = engineerTimeline(route, engineer, view.stopByOrder);
  if (segments.length === 0) {
    return <p className="tl__empty">Маршрута на этот день нет — инженер не выезжал.</p>;
  }

  const lunch = segments.find((segment) => segment.kind === 'lunch');
  const hours: number[] = [];
  for (let h = Math.ceil(dayStart() / 60) * 60; h <= dayEnd(); h += 120) hours.push(h);

  return (
    <div className="tl">
      <div className="shiftplan__track tl__track">
        <span
          className="shiftplan__line"
          style={{
            left: `${pct(engineer.shift_start)}%`,
            width: `${pct(engineer.shift_end) - pct(engineer.shift_start)}%`
          }}
        >
          {segments.map((segment, index) => {
            const width = inShift(segment.to, engineer) - inShift(segment.from, engineer);
            if (width <= 0 || segment.kind === 'idle') return null;

            const placement = segment.orderId ? view.stopByOrder.get(segment.orderId) : undefined;
            const order = segment.orderId ? view.orderById.get(segment.orderId) : undefined;
            /* Тон тот же, что на ганте: сорванный срок или визит без запаса
               красит работу в красный, остальное идёт по типу куска. */
            const trouble =
              segment.kind === 'work' && placement
                ? placement.slaBreached || placement.stop.risk !== 'low'
                : false;
            const tone = trouble ? 'problem' : segment.kind;
            const title = [
              KIND_LABEL[segment.kind],
              order ? `${order.id} · ${order.work_title}` : null,
              `${hhmm(segment.from)}–${hhmm(segment.to)} · ${segment.to - segment.from} мин`
            ]
              .filter(Boolean)
              .join(' · ');
            const style = {
              left: `${inShift(segment.from, engineer)}%`,
              width: `${width}%`
            };
            const dim = hot !== null && hot !== segment.kind;
            const cls =
              'shiftplan__seg shiftplan__seg--' + tone + (dim ? ' shiftplan__seg--dim' : '');
            const watch = {
              onMouseEnter: () => setHot(segment.kind),
              onMouseLeave: () => setHot(null)
            };

            if (segment.kind === 'work' && segment.orderId) {
              return (
                <button
                  key={index}
                  type="button"
                  className={cls}
                  style={style}
                  title={title}
                  onClick={() => onPickOrder(segment.orderId!)}
                  {...watch}
                />
              );
            }

            return <span key={index} className={cls} style={style} title={title} {...watch} />;
          })}
        </span>
      </div>

      <div className="tl__scale">
        {hours.map((h) => {
          /* Крайние подписи прижаты к краям шкалы: по центру своей отметки они
             наполовину уезжали за пределы ленты. */
          const at = pct(h);
          const edge = at <= 0.5 ? 'start' : at >= 99.5 ? 'end' : null;
          return (
            <span
              key={h}
              className={'tl__tick' + (edge ? ' tl__tick--' + edge : '')}
              style={edge === 'end' ? undefined : { left: `${at}%` }}
            >
              {hhmm(h)}
            </span>
          );
        })}
      </div>

      <ul className="tl__legend">
        {LEGEND.map((item) => (
          <li
            key={item.kind}
            className={'tl__key' + (hot === item.kind ? ' tl__key--on' : '')}
            onMouseEnter={() => setHot(item.kind)}
            onMouseLeave={() => setHot(null)}
          >
            <span className={'tl__dot tl__dot--' + item.kind} />
            {item.label}
          </li>
        ))}
      </ul>

      <p className="tl__note">
        {lunch
          ? `Окно под обед ${hhmm(lunch.from)}–${hhmm(lunch.to)} выведено из простоя: поля перерыва в контракте пока нет.`
          : 'Свободного часа под обед в этом дне не нашлось: поля перерыва в контракте пока нет.'}
      </p>
    </div>
  );
}
