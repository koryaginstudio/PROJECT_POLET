/* Диспетчер, который сейчас в интерфейсе. Пока константа — когда появится
   авторизация, сюда придёт ответ /api/me в этой же форме. */
export interface Dispatcher {
  name: string;
  role: string;
  shiftStart: string;
  shiftEnd: string;
  /** Файл фотографии в public/. Если его нет, кружок покажет инициалы. */
  photo?: string;
}

export const CURRENT_DISPATCHER: Dispatcher = {
  name: 'Корягин Антон Юрьевич',
  /* Не должность в чьём-то штате, а кто мы на этом проекте: команда
     «Белые воротнички», представляющая своё решение заказчику. */
  role: 'Представитель (Белые воротнички)',
  shiftStart: '08:00',
  shiftEnd: '20:00',
  photo: '/avatar.png'
};

export const initials = (name: string) =>
  name
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
