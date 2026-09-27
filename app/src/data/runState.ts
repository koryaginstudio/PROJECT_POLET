import { useEffect, useState } from 'react';
import type { RunId } from './load.ts';
import { onDuty, useDuty } from './duty.ts';
import { useMonitors, monitors } from './monitor.ts';

/* Что стало с расчётом: ведёт день, уже отработал или лежит без дела.

   До сих пор у расчёта было одно состояние на всю базу — «в работе», — и оно
   означало «взят на свой день». Но день кончается. В десять вечера смены
   закрыты, заявки либо выполнены, либо нет, и план, по которому работали,
   перестаёт быть рабочим: менять в нём нечего, сравнивать с ним — можно.
   Такой расчёт и называется здесь отработавшим.

   Третье состояние — «не назначен»: расчёт посчитан, но ни на какой день его
   не брали и ни в одном мониторинге он не участвовал. Это не брак и не
   черновик, это именно «лежит»: в архиве таких большинство, и молчать о них
   значило бы показывать ряд одинаковых карточек, где одна отличается
   зелёной пометкой, а прочие — ничем. */

/** Во сколько кончаются смены инженеров. После этого часа сегодняшняя работа
    закрыта: рабочий расчёт становится отработавшим, и трогать его больше
    незачем. */
export const SHIFT_END_HOUR = 22;

export type RunState =
  /** Ведёт свой день прямо сейчас. */
  | 'working'
  /** Свой день отработал: он прошёл или смены на нём уже кончились. */
  | 'served'
  /** Ни на какой день не назначен. */
  | 'idle';

const pad = (value: number) => String(value).padStart(2, '0');

const isoOf = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** Закрыт ли день записи мониторинга: он прошёл или смены на нём кончились. */
function closed(date: string, now: Date): boolean {
  const today = isoOf(now);
  if (date < today) return true;
  return date === today && now.getHours() >= SHIFT_END_HOUR;
}

/** Расчёты, отработавшие на закрытых мониторингах.

    День записи закрыт — значит, всё, что в нём работало, отработало. Свежий
    сегодняшний мониторинг сюда не попадает: по нему прямо сейчас и
    работают. */
export function servedRuns(now: Date = new Date()): Set<RunId> {
  const out = new Set<RunId>();
  for (const row of monitors()) {
    if (!closed(row.date, now)) continue;
    for (const id of row.runs) out.add(id);
    for (const part of row.parts) out.add(part.run);
  }
  return out;
}

/** Состояние расчёта.

    Отработавшее старше рабочего: расчёт, который вёл вчерашний день и с
    работы не снят, вчера свою работу сделал, и звать его рабочим сегодня —
    обещать, что по нему ещё поедут. */
export function runState(id: RunId, date: string, now: Date = new Date()): RunState {
  if (servedRuns(now).has(id)) return 'served';
  if (date && onDuty(id, date)) {
    return now.getHours() >= SHIFT_END_HOUR ? 'served' : 'working';
  }
  return 'idle';
}

/** Состояния для видов базы: одна подписка на все строки списка.

    Возвращает готовый ответчик, а не карту: расчётов в базе сотни, а
    спрашивают о тех, что показаны на экране.

    Час пересчитывается сам: в десять вечера рабочие расчёты становятся
    отработавшими, и ждать перезагрузки страницы ради этого не надо. */
export function useRunStates(): (id: RunId, date: string) => RunState {
  useDuty();
  useMonitors();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const served = servedRuns(now);
  return (id, date) => {
    if (served.has(id)) return 'served';
    if (date && onDuty(id, date)) {
      return now.getHours() >= SHIFT_END_HOUR ? 'served' : 'working';
    }
    return 'idle';
  };
}
