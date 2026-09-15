/* Шкала дня: одна на гант, на ленту инженера и на всё, что рисует день
   слева направо. Раньше каждый экран считал доли сам, и часовая гребёнка
   у них расходилась.

   Часы отмечены все, подписан каждый второй: четырнадцать подписей в ряд
   слипаются, а по отметкам между ними время читается и без цифры.

   Всё здесь — функции, а не заранее посчитанные величины. Границы смены
   стали настройкой сервиса, и гребёнка, вычисленная при загрузке модуля,
   осталась бы от прежней смены навсегда. */

import { clampDay, dayEnd, daySpan, dayStart } from '../data/service.ts';

export const span = () => daySpan();

/** Доля времени на шкале дня, в процентах. */
export const pct = (m: number) => ((clampDay(m) - dayStart()) / daySpan()) * 100;

const firstHour = () => Math.ceil(dayStart() / 60) * 60;

export function hours(): number[] {
  const list: number[] = [];
  for (let h = firstHour(); h <= dayEnd(); h += 60) list.push(h);
  return list;
}

/** Подписанные часы — через один: с них начинается отсчёт взглядом. */
export const labelled = () => hours().filter((h) => (h - firstHour()) % 120 === 0);

export const isLabelled = (h: number) => (h - firstHour()) % 120 === 0;

/** Время под курсором, округлённое до пяти минут: минута в минуту по
    пикселям всё равно не попасть, а пятиминутка — шаг, которым назначают
    визиты. */
export const timeAt = (ratio: number) =>
  Math.round((dayStart() + Math.min(1, Math.max(0, ratio)) * daySpan()) / 5) * 5;
