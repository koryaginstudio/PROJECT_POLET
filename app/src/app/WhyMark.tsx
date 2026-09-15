import { Icon } from '../ds/components/core/Icon.jsx';

interface Props {
  /** Объяснение. Пусто — значка нет вовсе: поле пришло из выгрузки как есть. */
  text: string | null | undefined;
  /** Куда раскрывается подсказка. У правого края списка — влево. */
  side?: 'center' | 'right';
}

/* Значок «откуда это взялось».

   Стоит рядом с полем, которого в выгрузке не было и которое достроено при
   сборке набора. Молчащее допущение читается как факт из учётной системы —
   а на защите первым спросят именно про него.

   Кнопка, а не значок с `title`: подсказка должна открываться и с клавиатуры,
   и держаться столько, сколько её читают. Текст в ней длинный — это объяснение,
   а не подпись, — поэтому всплывающая браузерная подсказка не годится: она
   исчезает через несколько секунд и не переносится по словам.

   Нажатие ничего не делает: кнопка нужна ради фокуса. */
export function WhyMark({ text, side = 'center' }: Props) {
  if (!text) return null;
  return (
    <button
      type="button"
      className={'why' + (side === 'right' ? ' why--right' : '')}
      aria-label={text}
      onClick={(event) => event.preventDefault()}
    >
      <Icon name="info" size={12} />
      <span className="why__tip" role="tooltip">
        {text}
      </span>
    </button>
  );
}
