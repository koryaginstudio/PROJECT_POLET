import type { ReactNode } from 'react';
import { service, setService, useService } from '../../data/service.ts';
import '../../styles/db.css';

interface Props {
  /** Имя базы. Видимого заголовка у панели больше нет — то же имя уже стоит
      в подшапке, и белая полоса с его повтором только отодвигала список
      вниз. Имя остаётся подписью панели для чтения с экрана. */
  title: string;
  /** Полоса управления выборкой — поиск, отбор, порядок, итог. Стоит своей
      панелью прямо над списком: это органы управления тем самым списком. */
  children?: ReactNode;
  /** Доска виджетов: сверху, своей панелью и под своим заголовком
      «Статистика». */
  board?: ReactNode;
}

/* Общая шапка баз данных: доска статистики и под ней полоса управления.

   Плашки «Все расчёты» здесь нет: она повторяла то, что и так сказано в
   подшапке, и делала это в каждой базе. Перечня расчётов, из которых раздел
   собран, тоже нет — два десятка одинаковых плашек с номером и датой занимали
   половину экрана и ничего к разделу не добавляли; какие расчёты есть, видно
   в самой базе расчётов.

   Заголовка «База клиентов» в панели тоже нет. Он повторял название раздела
   из подшапки строкой ниже, и на ноутбуке в 768 пикселей ростом это была ещё
   одна пустая белая полоса между названием и первой записью.

   Доска виджетов стоит своей панелью и под своим заголовком — «Статистика»,
   — а не внутри шапки базы: сверху сводка, под ней сама база со своими
   органами управления. */
export function DbHead({ title, children, board }: Props) {
  return (
    <>
      {board}

      <section className="panel" aria-label={title}>
        {children}
      </section>
    </>
  );
}

/* ─── общие настройки баз ───────────────────────────────────────────────── */

/** Плотность ряда карточек — настройка сервиса, общая на все базы. Раньше
    каждая база читала её один раз при открытии и держала у себя: выбранное в
    базе инженеров не доезжало до базы клиентов, а после перезагрузки
    возвращалось заводское. Теперь выбор пишется обратно в настройку, и все
    базы читают одно и то же. */
export function usePerRow(): [string, (value: string) => void] {
  const { perRow } = useService();
  const pick = (value: string) => {
    if (value === '2' || value === '4' || value === '6') setService({ perRow: value });
  };
  return [perRow, pick];
}

export const DENSITY = [
  { value: '2', label: '2' },
  { value: '4', label: '4' },
  { value: '6', label: '6' }
];

/** Порог недогруза, доля смены. В настройках сервиса есть только порог
    перегруза (`thresholds.occupancy`); порога недогруза там пока нет, и
    чтобы он не был зашит в шести файлах по-разному, он лежит здесь один.
    Когда в настройках появится своё поле, менять надо только это место. */
export const LOOSE_SHARE = 0.6;

/** Порог перегруза долей: в настройках он в процентах, а занятость в
    записях — доля 0…1. */
export const busyShare = () => service().thresholds.occupancy / 100;
export const looseShare = () => LOOSE_SHARE;

/** То же для компонентов: перерисовываются, когда порог подвинули. */
export function useShares(): { busy: number; loose: number } {
  const { thresholds } = useService();
  return { busy: thresholds.occupancy / 100, loose: LOOSE_SHARE };
}

const wholePercent = (share: number) => `${Math.round(share * 100)} %`;

/** Три ступени занятости для досок статистики. Подписи считаются от порогов,
    а не написаны руками: стоит подвинуть порог в настройках — и «Выше 75 %»
    на плитке начало бы врать. */
export function occupancyTiers(busy: number, loose: number) {
  return [
    {
      key: 'tight',
      label: `Выше ${wholePercent(busy)}`,
      tone: 'bad' as const,
      has: (o: number) => o >= busy
    },
    {
      key: 'even',
      label: `${wholePercent(loose)}–${wholePercent(busy)}`,
      tone: 'ok' as const,
      has: (o: number) => o >= loose && o < busy
    },
    {
      key: 'loose',
      label: `Ниже ${wholePercent(loose)}`,
      tone: 'warn' as const,
      has: (o: number) => o < loose
    }
  ];
}
