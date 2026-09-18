/* Дороги: ломаная по улицам между двумя точками набора.

   Расчёт в интерфейсе раскладывает заявки сам, но дорожной сети у него нет
   и быть не может — граф улиц живёт в движке. Поэтому линия на карте шла
   прямой: через дома, через реку, наискось сквозь кварталы. Для карты дня
   это плохо не тем, что некрасиво, а тем, что неправдиво — по такому пути
   никто не едет, и длина перегона на карточке маршрута ему не отвечала.

   Ломаные посчитаны заранее и лежат файлом рядом с заявками: `roads.json` в
   папке зоны, собирает его `dataset/roads.py` у того же маршрутизатора OSRM,
   которым пользуется движок. В сеть интерфейс не ходит вовсе — ни при
   открытии, ни при пересчёте: на защите интернета может не быть, а карта —
   это первое, что видно.

   Считаны все пары точек зоны, а не только те, что попали в сегодняшний
   план: план меняется от каждого сдвига переменных, и любая пара может
   понадобиться.

   Набора, загруженного диспетчером со стороны, это не касается: дорог для
   чужих адресов взять неоткуда, и перегон там остаётся прямым — как было у
   всех до появления этого файла. */

export interface RoadLeg {
  /** Ломаная от первой точки ко второй, уже упрощённая до двух десятков метров. */
  line: [number, number][];
  /** Длина пути по дорогам, километры. Не расстояние по прямой. */
  km: number;
}

export interface Roads {
  /** Точка набора → её номер. Ключ — координата в микроградусах. */
  at: Map<string, number>;
  /** Перегон «меньший номер — больший». Направление снимается разворотом. */
  legs: Map<string, RoadLeg>;
}

interface RoadsForm {
  schema: string;
  kind: string;
  points: [number, number][];
  legs: Record<string, { line: [number, number][]; km: number }>;
}

/* Ключ точки — целые микроградусы. Строка с дробью подвела бы: «55.70032» и
   «55.700320» — одно место и два разных ключа, а округление до пятого знака
   в питоне и в браузере расходится на половине последнего разряда. */
const spot = (lat: number, lon: number) =>
  `${Math.round(lat * 1e6)},${Math.round(lon * 1e6)}`;

export function readRoads(body: unknown): Roads | null {
  const form = body as RoadsForm;
  if (!form || !Array.isArray(form.points) || !form.legs) return null;

  const at = new Map<string, number>();
  form.points.forEach((point, index) => {
    at.set(spot(point[0], point[1]), index);
  });

  const legs = new Map<string, RoadLeg>();
  for (const [key, leg] of Object.entries(form.legs)) {
    if (leg && Array.isArray(leg.line) && typeof leg.km === 'number') {
      legs.set(key, { line: leg.line, km: leg.km });
    }
  }

  return { at, legs };
}

/** Перегон между двумя точками. `null` — такой пары в наборе нет, и путь
    придётся считать по прямой. */
export function roadLeg(
  roads: Roads | null,
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number
): RoadLeg | null {
  if (!roads) return null;

  const from = roads.at.get(spot(fromLat, fromLon));
  const to = roads.at.get(spot(toLat, toLon));
  if (from === undefined || to === undefined) return null;

  /* Две заявки в одном доме: ехать некуда. Линия всё равно из двух точек —
     так велит контракт (`Stop.geometry`: «точек всегда минимум две; две
     совпадающие — это следующий визит в том же доме, и такой перегон просто
     ничего не рисует»). С одной точкой сборщик пути считал перегон пустым и
     уходил в запасную ветку — к прямой, — хотя рисовать там нечего вовсе. */
  if (from === to) {
    return { line: [[fromLat, fromLon], [fromLat, fromLon]], km: 0 };
  }

  const leg = roads.legs.get(from < to ? `${from}-${to}` : `${to}-${from}`);
  if (!leg) return null;

  /* Хранится одна ломаная на пару. Едем в обратную сторону — разворачиваем:
     односторонние улицы дадут при этом сдвиг в полквартала, и это дешевле,
     чем держать вдвое больше линий ради той же карты. */
  return from < to ? leg : { line: [...leg.line].reverse(), km: leg.km };
}

/** Сколько точек из переданных знает эта дорожная сеть. Нужно тому, кто
    подбирает готовые дороги к загруженному набору: набор той же выгрузки
    накрывается целиком, чужой — не накрывается вовсе. */
export function roadsCover(roads: Roads | null, points: [number, number][]): number {
  if (!roads) return 0;
  let known = 0;
  for (const point of points) {
    if (roads.at.has(spot(point[0], point[1]))) known += 1;
  }
  return known;
}
