/* Снимки, которые завёл сам диспетчер.

   Своих карточек сотрудников у сервиса нет: инженеры приходят из выгрузки, а
   в ней имя, навыки и смена — фотографии там нет и не будет. Четырнадцать
   лиц штата закреплены в `photos.ts` таблицей; всё, что сверх них, заводит
   человек — кнопкой в карточке инженера.

   Хранит их браузер, рядом с правками штата: сервера у нас нет, а терять
   снимок при обновлении страницы незачем. Снимок лежит строкой `data:`,
   уменьшенный до аватарки: класть в хранилище браузера исходник с телефона
   на четыре мегабайта — значит забить его одним человеком.

   Ключ — табельный номер, тот же, каким человека знает справочник. */

/** Сторона аватарки в точках. Больше на экране она нигде не показывается:
    в профиле снимок раскрывается на 240, остальное — ряды по 40. */
const SIDE = 480;

const STORE_KEY = 'polet.faces.v1';

const read = (): Record<string, string> => {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(saved)) {
      if (typeof key === 'string' && typeof value === 'string' && key && value.startsWith('data:')) {
        clean[key] = value;
      }
    }
    return clean;
  } catch {
    return {};
  }
};

let own = read();

const watchers = new Set<() => void>();

function save(next: Record<string, string>): void {
  own = next;
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      /* Хранилище закрыто настройками браузера или переполнено: снимок
         живёт до перезагрузки, и это лучше, чем уронить карточку. */
    }
  }
  for (const watcher of watchers) watcher();
}

/** Свой снимок этого человека. Пусто — своего нет, лицо берётся из
    таблицы штата. */
export const ownFace = (tab: string): string | null => (tab && own[tab]) || null;

/** Есть ли у нас хоть один заведённый снимок — по нему карточки понимают,
    что список мог измениться. */
export const facesVersion = (): string => Object.keys(own).sort().join(',');

/** Уменьшает выбранный файл до аватарки и запоминает за человеком.

    Уменьшаем, а не кладём как есть: с телефона приходит снимок на четыре
    мегабайта, а на экране он не больше 240 точек. Хранилище браузера общее
    на весь сервис, и один такой файл съел бы его заметную часть.

    Кадрируем по центру в квадрат — карточка показывает лицо кругом, и
    вытянутый снимок она всё равно обрежет: пусть это случится один раз
    здесь, а не при каждой отрисовке. */
export async function setOwnFace(tab: string, file: File): Promise<void> {
  if (!tab || !file.type.startsWith('image/')) return;
  const picture = await load(file);
  const side = Math.min(picture.width, picture.height);
  const board = document.createElement('canvas');
  board.width = SIDE;
  board.height = SIDE;
  const ink = board.getContext('2d');
  if (!ink) return;
  ink.drawImage(
    picture,
    (picture.width - side) / 2,
    (picture.height - side) / 2,
    side,
    side,
    0,
    0,
    SIDE,
    SIDE
  );
  save({ ...own, [tab]: board.toDataURL('image/jpeg', 0.82) });
}

/** Снять свой снимок: человек снова показывается знаком с инициалами либо
    лицом из таблицы штата. */
export function dropOwnFace(tab: string): void {
  if (!(tab in own)) return;
  const next = { ...own };
  delete next[tab];
  save(next);
}

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((done, fail) => {
    const reader = new FileReader();
    reader.onerror = () => fail(new Error('файл не прочитался'));
    reader.onload = () => {
      const picture = new Image();
      picture.onload = () => done(picture);
      picture.onerror = () => fail(new Error('это не картинка'));
      picture.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

export function subscribeFaces(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}
