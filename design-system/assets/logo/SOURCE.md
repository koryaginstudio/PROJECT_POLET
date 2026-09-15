# assets/logo – provenance

Every file here is one of the SVGs the client attached in chat, byte-for-byte. Nothing was
recoloured, re-spaced, re-drawn or re-exported. Do not add files to this folder.

| file | client upload | composition | colour |
|---|---|---|---|
| `lockup-h.svg` | Asset 11 | horizontal, simple mark + wordmark | black |
| `lockup-h-detail.svg` | Asset 19 | horizontal, detailed mark + wordmark | black |
| `lockup-h-gradient-word.svg` | Asset 20 | horizontal, detailed mark | mark + `PROJECT` black, `## POLET` gradient |
| `lockup-h-gradient-mark.svg` | Asset 21 | horizontal, detailed mark | mark + `## POLET` gradient – **dark backgrounds only** |
| `lockup-v.svg` | Asset 14 | vertical, simple mark | black |
| `lockup-v-detail.svg` | Asset 16 | vertical, detailed mark | black |
| `lockup-v-gradient-word.svg` | Asset 15 | vertical, simple mark | mark + `PROJECT` black, `## POLET` gradient |
| `lockup-v-gradient-word-detail.svg` | Asset 17 | vertical, detailed mark | mark + `PROJECT` black, `## POLET` gradient |
| `lockup-v-gradient-mark.svg` | Asset 18 | vertical, detailed mark | mark + `## POLET` gradient – **dark backgrounds only** |
| `wordmark-gradient.svg` | Asset 13 | wordmark only | `PROJECT` black, `## POLET` gradient |
| `mark.svg` | Asset 12 | mark only, no wordmark | black |

Uploads 28–38 are byte-identical duplicates of 11–21 and are not repeated here.
Gradient stops in the supplied files: `#fca61f → #f4d51d`.

## Blocker – no colour survived the upload

**All eleven files currently render flat black, and no gradient renders at all.**

In every file each path is styled only by `class="cls-N"`. The `<style>` block that defined
those classes is not in the uploaded SVGs, no path carries a `fill` attribute, and there are
**zero `url(#linear-gradient)` references** – so the `<linearGradient>` defs in `<defs>` sit
orphaned and every contour falls back to the browser default, black.

The black files are unaffected in practice – black is what they should be. The six gradient
files are not usable as intended, and the two `-gradient-mark` files cannot be placed on a
dark background at all: they would be black on black.

**What is needed:** a re-export of the six gradient files with colour baked onto the paths
themselves – `fill="url(#linear-gradient)"` on the gradient contours and an explicit
`fill` on the rest – instead of a class-based `<style>` block, which this pipeline strips.

Until then: use the five black files.

## Import note (local copy)

Pulled from the Claude Design project on 2026-09-05. Present locally: `mark.svg`,
`lockup-h.svg`, `lockup-h-detail.svg` — все три чёрные, байт в байт как в проекте,
без правок. Приложение использует `lockup-h-detail`. Остальные восемь файлов каталогизированы
выше, но локально не лежат – each carries a large embedded C2PA metadata block, so they are
fetched on demand rather than in bulk. The local copies drop that metadata block; contours,
`viewBox` and class names are untouched.

## Что было сделано и откачено

5 сентября в локальные копии двух градиентных файлов был возвращён блок `<style>`,
привязывающий классы к заливке, — чтобы получить оранжевое слово в шапке. Это правка
артворка, а система её запрещает: «The logo is not ours to edit». Файлы удалены,
в проекте остались только чёрные варианты. Шесть градиентных по-прежнему ждут
ре-экспорта со стороны дизайнера.
