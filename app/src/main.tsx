import React from 'react';
import { createRoot } from 'react-dom/client';
import './ds/styles.css';
import './styles/app.css';
import {
  attachEngine,
  BUILT_IN,
  createRun,
  engineReady,
  hideLocalRuns,
  pullArchive,
  RUNS
} from './data/load.ts';
import { engineDefaults } from './data/engine.ts';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';
import { engineWarming } from './data/api.ts';

/* Движок открывает порт сразу, а дни считает в фоне: на новой машине
   первый запуск — около трёх минут, дальше — секунды. Пока он считает,
   страница говорит это словами и ждёт, а не висит пустой и не сеет
   расчёты в полусчитанный движок. Вид — та же заставка `.boot`, что и
   «Загружаем…» в index.html. */
async function waitForWarmup() {
  for (;;) {
    const warming = await engineWarming();
    if (!warming) return;
    const всего = warming.ready.length + warming.pending.length;
    const root = document.getElementById('root');
    if (root) {
      const text = document.createElement('div');
      text.className = 'boot';
      text.textContent =
        `Идёт расчёт планов участков: готово ${warming.ready.length} из ${всего}` +
        (warming.current ? `, сейчас — ${warming.current}` : '') +
        `. При первом запуске на новой машине это около трёх минут, дальше — ` +
        'секунды. Страница откроется сама.';
      root.replaceChildren(text);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/* Движок ищем до первой отрисовки, а не после.

   История расчётов читается из адресной строки при первом же рендере, и
   если архив движка приедет позже, ссылка на расчёт откроет не тот
   расчёт. Проверка стоит секунду в худшем случае — движок либо рядом,
   либо его нет, — и это дешевле, чем экран, который моргает списком.

   Не нашёлся — считаем сами. Это обычный режим работы, а не поломка. */

/* Первый запуск: истории нет, и считать день некому, кроме нас.

   Считаются все три зоны выгрузки, по расчёту на каждую, и всё это до
   первой отрисовки. Иначе программа встречает пустой формой, за которой
   не видно ни карты, ни маршрутов, ни баз данных: базы собираются по всем
   расчётам сразу, и на одном расчёте половина разделов пуста.

   Это настоящие расчёты по настоящей выгрузке, а не записанные заранее
   планы: каждый занимает доли секунды и повторяется одинаковым, сколько
   его ни пересчитывай.

   Дальше история уже своя: расчёты копятся от кнопки и переживают
   перезагрузку. Второй раз сюда не заходят. */
async function seedFirstRuns() {
  /* С живым движком история приходит из его архива, а не считается заново:
     он свои расчёты хранит сам и переживает перезагрузку браузера. Считать
     поверх них свои значило бы выдать посчитанное здесь за посчитанное им —
     ровно та подмена, ради которой всё и затевалось.

     Архив подтягивается всегда, а не только на пустом списке. Прежде проверка
     «история не пуста» стояла первой, и браузер, в котором уже были свои
     расчёты, архива движка не видел вовсе: на экране оставались одни
     браузерные планы. Их при живом движке прячем — см. `hideLocalRuns`. */
  if (engineReady()) {
    hideLocalRuns();
    /* Архив не прочитался — не сеем: иначе каждый сбой `GET /runs`
       дописывал бы в архив движка ещё три расчёта. Сеем, только если он
       прочитан и пуст. */
    const прочитан = await pullArchive().then(() => true, () => false);
    if (!прочитан || RUNS.length > 0) return;
  } else if (RUNS.length > 0) {
    return;
  }

  for (const zone of BUILT_IN) {
    try {
      await createRun(engineDefaults(), zone);
    } catch {
      /* Данные зоны не прочитались — остальные от этого не страдают. */
    }
  }
}

/* Пока всё это идёт, на странице стоит заглушка из `index.html` —
   «Загружаем…». Первая отрисовка её и снимает: белого экрана между
   запуском и планом больше нет. Само приложение обёрнуто в защиту: ошибка
   в любом экране скажет, что случилось, а не оставит пустую страницу. */
attachEngine()
  .catch(() => false)
  .then(waitForWarmup)
  .then(seedFirstRuns)
  .then(async () => {
    const { App } = await import('./app/App.tsx');
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>
    );
  });
