/* Дерево справочника — единственное описание того, что вообще можно открыть
   в правой панели. Ключ страницы здесь тот же, что у квадратов дашборда и у
   плиток расчёта, поэтому «Проблемные» из этапов, из расчёта и из справочника
   открывают одну и ту же страницу, а не три похожие. */

import type { DayView } from '../data/derive.ts';
import { buildCrewBoard, buildOrdersBoard } from '../data/derive.ts';

export interface CatalogNode {
  key: string;
  label: string;
  /** Число справа: сколько всего внутри. */
  note?: string;
  /** Точка «сюда стоит посмотреть» — та же отметка, что на плитках расчёта. */
  flag?: 'watch' | 'bad';
  icon?: string;
  /** Страница, которая откроется по щелчку. Есть у листьев, нет у папок. */
  page?: string;
  /** Ярлык: ведёт на чужую страницу. Дерево подсвечивает не его, а саму
      страницу там, где она живёт, — как проводник уводит по ярлыку к файлу. */
  alias?: boolean;
  children?: CatalogNode[];
}

const mark = (bad: boolean, watch: boolean): 'bad' | 'watch' | undefined =>
  bad ? 'bad' : watch ? 'watch' : undefined;

export function buildCatalogue(view: DayView, cut: number): CatalogNode[] {
  const orders = buildOrdersBoard(view, cut);
  const crew = buildCrewBoard(view);
  const tight = orders.problemBuckets.find((bucket) => bucket.key === 'tight');
  const onShift = view.loads.filter((load) => !load.idle);
  const crewProblems = [...new Set(crew.problemBuckets.flatMap((b) => b.engineerIds))];

  return [
    {
      key: 'calc',
      icon: 'gauge',
      label: 'Расчёт',
      note: String(view.metrics.length),
      /* Метрики — ярлыки: каждая ведёт в тот раздел, где её число разложено
         по строкам, и подсвечивается в дереве именно он. */
      children: view.metrics.map((metric) => ({
        key: 'calc:' + metric.key,
        label: metric.label,
        note: metric.value + (metric.unit ?? ''),
        flag: metric.flag === 'ok' ? undefined : metric.flag,
        page: metric.group,
        alias: true
      }))
    },
    {
      key: 'orders',
      icon: 'clipboard-list',
      label: 'Заявки',
      note: String(view.orderById.size),
      children: [
        { key: 'orders:all', label: 'Все заявки', note: String(view.orderById.size), page: 'all' },
        {
          key: 'orders:inwork',
          label: 'С инженером',
          note: String(orders.assignedIds.length),
          page: 'inwork'
        },
        {
          key: 'orders:unassigned',
          label: 'Без инженера',
          note: String(view.unassigned.length),
          flag: mark(view.unassigned.length > view.orderById.size * 0.1, view.unassigned.length > 0),
          page: 'unassigned'
        },
        {
          key: 'orders:problems',
          label: 'Проблемные',
          note: String(orders.problemIds.length),
          flag: mark(false, orders.problemIds.length > 0),
          page: 'problems'
        },
        {
          key: 'orders:tight',
          label: 'Стоят впритык',
          note: String(tight?.count ?? 0),
          page: 'tight'
        },
        {
          key: 'orders:types',
          icon: 'stack',
          label: 'По видам работ',
          note: String(orders.byType.length),
          children: orders.byType.map((type) => ({
            key: 'orders:type:' + type.key,
            label: type.title,
            note: String(type.count),
            page: 'type:' + type.key
          }))
        }
      ]
    },
    {
      key: 'crew',
      icon: 'users',
      label: 'Инженеры',
      note: String(view.loads.length),
      children: [
        { key: 'crew:all', label: 'Все инженеры', note: String(view.loads.length), page: 'crew-all' },
        {
          key: 'crew:onshift',
          label: 'С маршрутом',
          note: String(onShift.length),
          page: 'crew-onshift'
        },
        {
          key: 'crew:free',
          label: 'Свободны',
          note: String(crew.freeIds.length),
          flag: mark(false, crew.freeIds.length > 0),
          page: 'crew-free'
        },
        {
          key: 'crew:problems',
          label: 'Проблемные',
          note: String(crewProblems.length),
          flag: mark(false, crewProblems.length > 0),
          page: 'crew-problems'
        },
        {
          key: 'crew:skills',
          icon: 'stack',
          label: 'По навыкам',
          note: String(crew.bySkill.length),
          children: crew.bySkill.map((skill) => ({
            key: 'crew:skill:' + skill.key,
            label: skill.label,
            note: String(skill.count),
            page: 'skill:' + skill.key
          }))
        }
      ]
    },
    {
      key: 'sim',
      icon: 'shuffle',
      label: 'Действия',
      children: [
        {
          key: 'sim:fragile',
          label: 'Прозвонить на завтра',
          note: String(view.fragile.length),
          flag: mark(false, view.fragile.length > 0),
          page: 'fragile'
        },
        {
          key: 'sim:reasons',
          label: 'Причины срывов',
          note: String(view.reasons.length),
          page: 'reasons'
        }
      ]
    }
  ];
}

/** Путь к странице в дереве: и для хлебных крошек, и чтобы раскрыть папки,
    в которых она лежит. */
export function trailToPage(nodes: CatalogNode[], page: string): CatalogNode[] {
  for (const node of nodes) {
    if (node.page === page && !node.alias) return [node];
    if (node.children) {
      const deeper = trailToPage(node.children, page);
      if (deeper.length > 0) return [node, ...deeper];
    }
  }
  return [];
}
