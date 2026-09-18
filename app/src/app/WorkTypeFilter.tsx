import { useMemo } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { OrderRecord } from '../data/registry.ts';
import { skillIcon, skillName, skillRank, skillShort } from '../data/dictionary.ts';
import { CheckRow, FilterDrop } from './FilterDrop.tsx';

/* Отбор по виду работ — три списка вместо ряда плашек.

   В выгрузке заказчика восемнадцать видов работ, и плашками они занимали в
   полосе отбора три строки: чтобы выбрать один, приходилось прочитать все.
   Предугадать их число нельзя — вид работ приходит свободным текстом колонки
   выгрузки, и следующий день может принести девятнадцатый.

   Поэтому виды работ разложены по навыку: `connect` — работы на подключение
   и дозаказы, `local` — локальные, `emergency` — аварийные. Это не наша
   выдумка и не украшение: навык приходит в данных у каждой заявки, по нему
   движок подбирает инженера, и по нему же отбирают в базе инженеров. Групп
   ровно столько, сколько навыков в данных; незнакомый навык заведёт свою
   группу и встанет в конец, а не потеряется в «прочем».

   Дозаказы вынесены в списке отдельной строкой под чертой. Дозаказ — не вид
   работ, а класс заявки: двенадцать дозаказов выгрузки размазаны по трём
   видам работ, и вид «Заказ подключения/Дозаказ оборудования» на три
   четверти состоит из подключений. Отбирать их по названию вида работ значило
   бы обещать одно, а показывать другое, поэтому строка отбирает по классу —
   так, как пометила заявку сама учётная система. Строка эта у каждой группы
   своя: сегодня все дозаказы приходят с навыком «подключение», но связка
   класса с навыком в контракте ничем не закреплена, и одна общая строка при
   первом же исключении привела бы в выборку чужую группу.

   Отметки складываются: заявка попадает в выборку, если подошла хотя бы под
   одну. Иначе и быть не может — вид работ у заявки один, и «то и это» через
   «и» дало бы пустой список. */

/** Ключ отметки «дозаказы» — свой на каждый навык. Не вид работ, а класс
    заявки, потому и не похож на остальные ключи. */
export const addonKey = (skill: string) => `class:addon@${skill}`;

/** Подходит ли заявка под отметки полосы. Пусто — подходит всё: пустой отбор
    означает «показать все», а не «не показывать ничего». */
export function fitsWork(
  order: { workType: string; orderClass: string | null; skill: string },
  picks: string[]
): boolean {
  if (picks.length === 0) return true;
  if (picks.includes(order.workType)) return true;
  return order.orderClass === 'addon' && picks.includes(addonKey(order.skill));
}

interface Line {
  key: string;
  label: string;
  count: number;
}

interface Group {
  key: string;
  /** Короткая подпись на кнопку и полная — шапкой в списке. */
  short: string;
  full: string;
  icon: string;
  total: number;
  lines: Line[];
  /** Сколько в группе заявок класса «Дозаказ». Ноль — строки в списке нет. */
  addon: number;
}

interface Props {
  /** Все заявки базы, а не отобранные: счётчики в списке отвечают на «сколько
      их всего», и меняться от собственного отбора им незачем. */
  orders: OrderRecord[];
  /** Названия видов работ из расчёта. */
  titles: Record<string, string>;
  picks: string[];
  onChange: (next: string[]) => void;
}

export function WorkTypeFilter({ orders, titles, picks, onChange }: Props) {
  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, { total: number; addon: number; types: Map<string, number> }>();
    for (const order of orders) {
      const cell = map.get(order.skill) ?? { total: 0, addon: 0, types: new Map<string, number>() };
      cell.total += 1;
      if (order.orderClass === 'addon') cell.addon += 1;
      cell.types.set(order.workType, (cell.types.get(order.workType) ?? 0) + 1);
      map.set(order.skill, cell);
    }

    return [...map.entries()]
      .map(([key, cell]) => ({
        key,
        short: skillShort(key),
        full: skillName(key),
        icon: skillIcon(key),
        total: cell.total,
        addon: cell.addon,
        lines: [...cell.types.entries()]
          .map(([type, count]) => ({ key: type, label: titles[type] ?? type, count }))
          .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'ru'))
      }))
      .sort((a, b) => skillRank(a.key) - skillRank(b.key));
  }, [orders, titles]);

  /* Сколько заявок группы прошло отметки. Считаем по самим заявкам, а не
     складываем числа строк: заявка-дозаказ стоит и в своей строке вида работ,
     и в строке под чертой, и при двух отметках была бы посчитана дважды. */
  const chosen = useMemo(() => {
    const map = new Map<string, number>();
    if (picks.length === 0) return map;
    for (const order of orders) {
      if (!fitsWork(order, picks)) continue;
      map.set(order.skill, (map.get(order.skill) ?? 0) + 1);
    }
    return map;
  }, [orders, picks]);

  /* Отметка снимается и ставится одним и тем же нажатием — и в списке, и на
     плитке разбивки. Набор всегда пересобирается заново: правка на месте не
     пересчитала бы ни список, ни разбивку под ним. */
  const toggle = (key: string) =>
    onChange(picks.includes(key) ? picks.filter((one) => one !== key) : [...picks, key]);

  return (
    <span className="filters__menus">
      {groups.map((group) => {
        const lineKeys = group.lines.map((line) => line.key);
        const mine = lineKeys.filter((key) => picks.includes(key));
        const all = mine.length === lineKeys.length;
        const addon = group.addon > 0 ? addonKey(group.key) : null;
        const any = mine.length > 0 || (addon !== null && picks.includes(addon));
        const taken = chosen.get(group.key) ?? 0;

        /* Отметить всю группу — и нажатием на саму кнопку, и строкой в списке:
           это одно и то же действие, и вести себя оно обязано одинаково. */
        const takeAll = () =>
          onChange(
            all
              ? picks.filter((key) => !lineKeys.includes(key))
              : [...picks.filter((key) => !lineKeys.includes(key)), ...lineKeys]
          );

        return (
          <FilterDrop
            key={group.key}
            label={group.short}
            count={any ? `${taken} из ${group.total}` : String(group.total)}
            picked={any}
            aria={group.full}
            title={`${group.full}: выбрать виды работ по одному`}
            toggle={{
              on: all,
              some: mine.length > 0,
              onPick: takeAll,
              title: all
                ? `Снять все виды работ: ${group.full}`
                : `Показать все заявки группы: ${group.full}, ${group.total} заявок`
            }}
          >
            {() => (
              <>
                <div className="fdrop__head">
                  <span className="fdrop__title">
                    <Icon name={group.icon} size={14} />
                    {group.full}
                  </span>
                  <span className="fdrop__lede">
                    Навык, по которому заявке подбирают инженера. Справа — сколько таких заявок
                    в базе.
                  </span>
                </div>

                <CheckRow
                  head
                  name="Все виды работ"
                  count={group.total}
                  on={all}
                  some={mine.length > 0}
                  onPick={takeAll}
                />

                {group.lines.map((line) => (
                  <CheckRow
                    key={line.key}
                    name={line.label}
                    count={line.count}
                    on={picks.includes(line.key)}
                    onPick={() => toggle(line.key)}
                  />
                ))}

                {addon !== null && (
                  <div className="fdrop__part" role="group" aria-label="Дозаказы">
                    <span className="fdrop__part-label">Дозаказы</span>
                    <CheckRow
                      name="Заявки класса «Дозаказ»"
                      note="Так их пометила учётная система"
                      count={group.addon}
                      on={picks.includes(addon)}
                      onPick={() => toggle(addon)}
                    />
                  </div>
                )}
              </>
            )}
          </FilterDrop>
        );
      })}

      {/* Сброс стоит в полосе, а не в списке: отметки копятся молча, и путь
          «вернуть всё как было» обязан быть виден, не раскрывая ничего. */}
      {picks.length > 0 && (
        <button
          type="button"
          className="filters__reset"
          onClick={() => onChange([])}
          title="Показать заявки всех видов работ"
        >
          <Icon name="x" size={12} />
          Сбросить виды работ
        </button>
      )}
    </span>
  );
}
