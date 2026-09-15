# Импорт дизайн-системы PROJECT POLET

Источник: проект Claude Design `7cc18dd2-465f-4526-8dc6-64d2335e6279`, забран через
DesignSync 5 сентября 2026. В проекте 190 файлов; сюда перенесено то, что нужно для сборки.

## Перенесено

| Что | Файлы |
|---|---|
| Токены | `tokens/` – colors, typography, spacing, elevation, motion, base, fonts |
| Точка входа CSS | `styles.css` |
| Компоненты core | Logo, Icon, Button, IconButton, Badge, Card, BentoTile |
| Компоненты forms | Input, Select, Checkbox, Switch, SegmentedControl |
| Компоненты navigation | TopBar, SidebarNav, Tabs |
| Компоненты data | StatTile, ComplexityBadge, TimeWindowBar, RouteStopCard |
| Шрифты | Onest, 9 весов, woff2, кириллица + латиница |
| Логотип | `assets/logo/mark.svg`, `assets/logo/SOURCE.md` |
| Правила | `SKILL.md` |
| Баррель | `index.js` |

Icon.jsx содержит все 46 глифов Phosphor Bold – проверено пересчётом.

## Отклонения от оригинала

**Шрифты.** В исходном проекте лежат девять TTF, поставленных клиентом, и `tokens/fonts.css`
ссылается на них. TTF – бинарные файлы, тянуть их через этот канал нерационально, поэтому
взяты woff2-сборки Onest того же семейства (`@fontsource/onest`, лицензия SIL OFL) с
разбивкой на кириллический и латинский поднаборы. Метрики те же, вес страницы меньше.
Исходное объявление сохранено в `tokens/fonts.ttf-reference.css`.

**mark.svg.** Записан без встроенного блока метаданных C2PA. Контуры, `viewBox` и
`class="cls-1"` не тронуты – отличается только служебный блок provenance.

## Не перенесено

- Десять из одиннадцати файлов логотипа. Каталогизированы в `assets/logo/SOURCE.md`,
  забираются по требованию.
- `guidelines/` – 22 HTML-карточки спецификаций. Это витрина дизайн-системы, для сборки
  приложения не нужна; правила из них изложены в `readme.md` исходного проекта.
- `ui_kits/planner` и `ui_kits/website` – примеры экранов. Структура приложения строится
  по BRIEF.md, а не по ним.
- `assets/raw/`, `uploads/` – 44 исходных SVG, дубликаты набора `assets/logo/`.
- `_ds_bundle.js`, `_ds_manifest.json`, `templates/presentation/` – инфраструктура
  витрины Claude Design.

## Известная проблема

Шесть градиентных файлов логотипа рендерятся плоским чёрным: при выгрузке потерялся блок
`<style>`, определявший классы `cls-N`, ссылок `url(#linear-gradient)` в путях нет.
Нужен ре-экспорт с цветом, залитым в атрибуты путей. Подробности в `assets/logo/SOURCE.md`.
Пока используются чёрные варианты.
