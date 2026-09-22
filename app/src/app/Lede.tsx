import type { ReactNode } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';

/* Пояснение над рабочим экраном: первая фраза видна всегда, остальное — под
   «Подробнее».

   Пояснения писались и для жюри, и для диспетчера сразу, и на рабочих
   экранах они разрослись до абзаца. Диспетчеру нужна одна строка «что здесь
   делают»; почему устроено именно так, прочтёт тот, кто спросит, — одним
   нажатием. Раскрытие — родной <details>: клавиатура, чтение с экрана и
   состояние «открыто» у него уже есть, своё писать незачем.

   Текст подают либо строкой (`text`) — тогда первая фраза отрезается по
   первой точке, — либо явно: `first` и остальное детьми, когда в тексте есть
   разметка или первая точка стоит не там, где кончается мысль. */

interface Props {
  /** Пояснение одной строкой: первая фраза видна, остальное свёрнуто. */
  text?: string;
  /** Видимая фраза, если остальное подано детьми. */
  first?: ReactNode;
  children?: ReactNode;
  className?: string;
}

/** Первая фраза и остаток. Точку ищем перед пробелом и заглавной буквой:
    «07:00–21:00» и «т. е.» пополам не режутся. */
function split(text: string): [string, string] {
  const at = text.search(/[.!?…](?=\s+[А-ЯЁA-Z«])/);
  if (at < 0) return [text, ''];
  return [text.slice(0, at + 1), text.slice(at + 1).trim()];
}

export function Lede({ text, first, children, className = 'clients__lede' }: Props) {
  const [head, rest] = text !== undefined ? split(text) : [first, children];
  const more = typeof rest === 'string' ? rest.length > 0 : Boolean(rest);
  return (
    <div className={className + ' lede'}>
      <p className="lede__first">{head}</p>
      {more && (
        <details className="lede__more">
          <summary className="lede__toggle">
            <span className="lede__toggle-word">Подробнее</span>
            <Icon name="chevron-down" size={14} />
          </summary>
          <p className="lede__rest">{rest}</p>
        </details>
      )}
    </div>
  );
}
