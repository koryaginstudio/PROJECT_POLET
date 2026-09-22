import { useEffect } from 'react';
import type { RefObject } from 'react';

/* Фокус в окнах поверх экрана.

   Окно открылось — а клавиатура осталась там, где была: на кнопке, которой
   его открыли, под тёмной вуалью. Tab с этого места уходил по экрану за
   окном, и человек, работающий без мыши, нажимал кнопки, которых не видит.
   Закрыл окно — фокус пропадал вовсе, и следующий Tab начинал страницу с
   начала.

   Здесь три правила на все окна сразу, чтобы каждое не заводило свои:
   при открытии фокус переходит на первый элемент внутри карточки (вуаль
   не в счёт — это не то, с чем работают), Tab ходит по кругу внутри окна,
   при закрытии фокус возвращается туда, откуда окно открыли.

   Окна бывают вложенными: из профиля инженера открывается окно визитов, из
   него — карточка заявки. Tab тогда держит верхнее, а не все разом — иначе
   два ловца тянули бы фокус каждый к себе. Порядок открытия и хранит
   стопка. */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const stack: HTMLElement[] = [];

const focusableIn = (node: HTMLElement) =>
  [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    /* Скрытые поля — например, спрятанный `<input type="file">` — в круг
       не входят: фокус на невидимом элементе теряется из виду. */
    (one) => one.offsetParent !== null || one === document.activeElement
  );

/**
 * Держит фокус в окне, пока оно открыто.
 *
 * @param open открыто ли окно сейчас
 * @param card карточка окна — то, внутри чего фокус ходит по кругу
 */
export function useModalFocus(open: boolean, card: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const node = card.current;
    if (!node) return;

    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    stack.push(node);

    /* Поле с `autoFocus` важнее первого по порядку: форма сама сказала, с
       чего начинать. Нет ни того ни другого — фокус берёт сама карточка,
       чтобы Esc и Tab всё равно попадали в окно. */
    const first = node.querySelector<HTMLElement>('[autofocus]') ?? focusableIn(node)[0] ?? node;
    if (first === node && !node.hasAttribute('tabindex')) node.tabIndex = -1;
    first.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || stack[stack.length - 1] !== node) return;
      const list = focusableIn(node);
      if (list.length === 0) {
        event.preventDefault();
        return;
      }
      const head = list[0];
      const tail = list[list.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !node.contains(active);
      if (event.shiftKey && (active === head || outside)) {
        event.preventDefault();
        tail.focus();
      } else if (!event.shiftKey && (active === tail || outside)) {
        event.preventDefault();
        head.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      const at = stack.lastIndexOf(node);
      if (at >= 0) stack.splice(at, 1);
      /* Вернуть фокус туда, откуда пришли. Кнопки могло уже не быть —
         экран сменился; тогда фокус просто не возвращается, и это не
         ошибка. */
      if (before && before.isConnected) before.focus();
    };
  }, [open, card]);
}
