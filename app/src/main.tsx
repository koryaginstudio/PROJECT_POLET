import React from 'react';
import { createRoot } from 'react-dom/client';
import './ds/styles.css';
import './styles/app.css';
import { attachEngine, engineDayTitle, seedRuns } from './data/load.ts';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';
import { engineWarming } from './data/api.ts';
import { humanLine } from './data/errors.ts';

/* Заставка до первой отрисовки: класс `.boot` из index.html, как у
   «Загружаем…». Заголовок и строка под ним, а не одна длинная фраза: главное
   — «сколько готово» — должно читаться с первого взгляда. */
function showBoot(title: string, line: string) {
  const root = document.getElementById('root');
  if (!root) return;
  const box = document.createElement('div');
  box.className = 'boot';
  const text = document.createElement('div');
  text.className = 'boot__text';
  const head = document.createElement('p');
  head.className = 'boot__title';
  head.textContent = title;
  const body = document.createElement('p');
  body.textContent = line;
  text.append(head, body);
  box.append(text);
  root.replaceChildren(box);
}

/* Сколько ждать прогрева, прежде чем открыть страницу всё равно. На новой
   машине он около трёх минут; вдесятеро дольше — значит, что-то не так, и
   держать человека перед заставкой без конца хуже, чем открыть интерфейс,
   который сам скажет, что программа расчёта не отвечает. */
const WARMUP_LIMIT = 10 * 60_000;

/* Движок открывает порт сразу, а дни считает в фоне: на новой машине
   первый запуск — около трёх минут, дальше — секунды. Пока он считает,
   страница говорит это словами и ждёт, а не висит пустой и не сеет
   расчёты в полусчитанный движок. Слова — диспетчерские: «движок» и
   секунды ему ни к чему, ему важно, сколько планов готово. */
async function waitForWarmup() {
  const started = Date.now();
  for (;;) {
    const warming = await engineWarming();
    if (!warming || Date.now() - started > WARMUP_LIMIT) return;
    const всего = warming.ready.length + warming.pending.length;
    showBoot(
      `Готовим планы на сегодня: готово ${warming.ready.length} из ${всего}` +
        (warming.current ? `, сейчас — ${engineDayTitle(warming.current)}` : '') +
        '…',
      'Первый запуск на новом компьютере занимает около трёх минут. Страница откроется сама.'
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/* Движок ищем до первой отрисовки, а не после.

   История расчётов читается из адресной строки при первом же рендере, и
   если архив движка приедет позже, ссылка на расчёт откроет не тот
   расчёт. Проверка стоит секунду в худшем случае — движок либо рядом,
   либо его нет, — и это дешевле, чем экран, который моргает списком.

   Не нашёлся — считаем сами. Это обычный режим работы, а не поломка.

   Первые расчёты заводит `seedRuns` (load.ts) — одна затравка на всё
   приложение: с движком она подтягивает его архив и сеет, только если архив
   прочитан и пуст; без движка — считает по расчёту на зону, если история
   пуста. */

/* Пока всё это идёт, на странице стоит заглушка из `index.html` —
   «Загружаем…». Первая отрисовка её и снимает: белого экрана между
   запуском и планом больше нет. Само приложение обёрнуто в защиту: ошибка
   в любом экране скажет, что случилось, а не оставит пустую страницу. */
attachEngine()
  .catch(() => false)
  .then(waitForWarmup)
  .then(seedRuns)
  .then(async () => {
    const { App } = await import('./app/App.tsx');
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  })
  /* Сюда доходит только то, что не поймали выше: сломанная сборка, не
     загрузившийся модуль. Заставка «Загружаем…» без конца хуже, чем слова. */
  .catch((failure: unknown) => {
    console.error('Интерфейс не запустился', failure);
    showBoot('Интерфейс не запустился', humanLine(failure));
  });
