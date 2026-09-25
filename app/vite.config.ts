import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react({ include: /\.(jsx|tsx|js|ts)$/ })],
  server: {
    port: 5180,
    /* Пробки в Москве берутся у Яндекса, а он не разрешает читать себя из
       чужой страницы: браузер гасит такой запрос до разбора. Поэтому фронт
       ходит к себе, а наружу выпускает сервер — здесь это сборщик.

       В собранном стенде этого пути нет, и экран останется без строки о
       пробках: стенд офлайновый по замыслу, и город за окном для него
       сведение, а не условие работы. Чтобы пробки появились и там, такой же
       путь должен отдавать тот, кто раздаёт сборку. См. data/traffic.ts. */
    proxy: {
      '/traffic/moscow': {
        target: 'https://export.yandex.ru',
        changeOrigin: true,
        rewrite: () => '/bar/reginfo.xml?region=213'
      }
    }
  }
});
