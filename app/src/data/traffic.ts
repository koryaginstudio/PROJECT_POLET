/* Пробки в Москве — то, что видит диспетчер за окном, а не в плане.

   План посчитан по оценке времени в пути, и она одна на весь день. Живая
   обстановка в городе к ней не привязана, но решение диспетчера меняет:
   девять баллов в час пик — это повод не удивляться опозданиям и не гнать
   пересчёт, а четыре — повод спросить, почему инженер стоит.

   Берём у Яндекса, из той же сводки, что кормит его «Пробки»: регион 213 —
   Москва, `level` — те самые баллы от нуля до десяти, `icon` — цвет, каким
   он сам их показывает (`green`, `yellow`, `red`).

   Напрямую из браузера это не прочитать: ответ приходит без разрешения на
   чужой источник, и запрос гаснет ещё до разбора. Поэтому ходим к себе, на
   `/traffic/moscow`, а наружу выпускает уже сервер: в разработке — прокси
   сборщика (vite.config.ts), в собранном стенде — тот, кто его раздаёт.
   Не ответил никто — пробок на экране просто нет: стенд офлайновый по
   замыслу, и город за окном для него сведение, а не условие работы. */

export interface Traffic {
  /** Баллы, 0–10. */
  level: number;
  /** Цвет обстановки глазами самого Яндекса. */
  tone: 'green' | 'yellow' | 'red';
}

const toneOf = (icon: string): Traffic['tone'] =>
  icon === 'red' ? 'red' : icon === 'yellow' ? 'yellow' : 'green';

/** Читает обстановку. `null` — источник недоступен, и говорить о пробках
    нечего: выдумывать число здесь нельзя, по нему принимают решения. */
export async function loadTraffic(): Promise<Traffic | null> {
  try {
    const answer = await fetch('/traffic/moscow', { headers: { Accept: 'application/xml' } });
    if (!answer.ok) return null;
    const text = await answer.text();
    /* Разбираем разметкой браузера, а не выражением: ответ — настоящий XML,
       и своя вырезка по строке сломалась бы на первой же перестановке
       полей. Чужой путь (собранный стенд без прокси отдаёт свою страницу)
       разбор переживает: нужного узла в ней нет, и мы вернём `null`. */
    const level = new DOMParser()
      .parseFromString(text, 'application/xml')
      .querySelector('traffic region level');
    if (!level) return null;
    const value = Number(level.textContent);
    if (!Number.isFinite(value)) return null;
    const icon =
      new DOMParser().parseFromString(text, 'application/xml').querySelector('traffic region icon')
        ?.textContent ?? 'green';
    return { level: Math.max(0, Math.min(10, Math.round(value))), tone: toneOf(icon.trim()) };
  } catch {
    /* Нет сети, нет прокси, чужой ответ — все три случая для экрана один и
       тот же: обстановки не знаем. */
    return null;
  }
}
