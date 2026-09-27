/* Что нужно любому разрезу статистики.

   Разрезы отличаются предметом — расчёты, заявки, услуги, — но живут в одних
   и тех же условиях: общий срок на весь раздел, готовый срез по нему,
   справочники под рукой и одна дорога наружу — открыть расчёт. Один набор
   свойств на все семь держит эту договорённость в одном месте. */

import type { PeriodKey } from '../../app/DbWidgets.tsx';
import type { Registry } from '../../data/registry.ts';
import type { StatsScope } from './scope.ts';

export interface DimProps {
  registry: Registry;
  /** Срез истории по выбранному сроку — считается разделом, один на все разрезы. */
  scope: StatsScope;
  period: PeriodKey;
  onPeriod: (value: PeriodKey) => void;
  /** Сколько расчётов попадает в срок: пустые сроки видно до нажатия. */
  countOf: (value: PeriodKey) => number;
  onOpenRun: (id: string) => void;
  /** Расчёт, открытый в диспетчерской: метка «открыт» та же, что в базах. */
  active: string | null;
}
