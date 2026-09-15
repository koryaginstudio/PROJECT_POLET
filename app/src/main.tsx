import React from 'react';
import { createRoot } from 'react-dom/client';
import './ds/styles.css';
import './styles/app.css';
import { attachEngine } from './data/load.ts';

/* Движок ищем до первой отрисовки, а не после.

   История расчётов читается из адресной строки при первом же рендере, и
   если архив движка приедет позже, ссылка на расчёт откроет не тот
   расчёт. Проверка стоит секунду в худшем случае — движок либо рядом,
   либо его нет, — и это дешевле, чем экран, который моргает списком.

   Не нашёлся — открываемся на фикстурах. Это обычный режим работы, а не
   поломка: интерфейс верстают без движка, и он обязан открываться. */
attachEngine()
  .catch(() => false)
  .then(async () => {
    const { App } = await import('./app/App.tsx');
    createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );
  });
