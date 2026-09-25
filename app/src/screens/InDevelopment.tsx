import { Badge } from '../ds/components/core/Badge.jsx';

interface Props {
  /** Название раздела, каким его знает меню слева. */
  label: string;
}

/* Плашка вместо экрана — не «здесь пусто», а «раздел готов, но временно
   скрыт». Сами экраны (Главная, Мониторинг, Статистика) остаются в коде со
   всем наполнением и логикой — эта плашка просто встаёт на их место в
   App.tsx. Вернуть экран обратно — заменить вызов `InDevelopment` на сам
   экран там же, ничего здесь не трогая. */
export function InDevelopment({ label }: Props) {
  return (
    <div className="stub enter">
      <Badge>В разработке</Badge>
      <h2 className="stub__title">{label}</h2>
      <p className="stub__body">Раздел временно скрыт: наполнение и логика уже готовы, экран ещё дорабатывается.</p>
    </div>
  );
}
