import bitrix from '../assets/brands/bitrix24.svg';
import excel from '../assets/brands/excel.svg';

/* Знаки чужих систем.

   Значки системы одинаково серые и говорят про действие: слои, буфер, стопка.
   Для источника данных это неверно — там вопрос не «что делаем», а «откуда
   берём», и ответ на него узнают по фирменному знаку быстрее, чем прочитывают
   подпись.

   Знаки настоящие и лежат файлами: провенанс и лицензия — в
   `assets/brands/SOURCE.md`. Нарисованный от руки знак — это похожий знак, а
   не тот самый, и на карточке источника похожесть читается как подделка.
   Из сети при показе они не тянутся: стенд обязан работать на чужом ноутбуке
   без интернета.

   Картинкой, а не встроенным SVG: у чужих файлов внутри свои градиенты с
   именами вроде `radial0`, и два таких знака на одной странице перебили бы
   идентификаторы друг другу. Заодно их не достанет наша палитра — чужие цвета
   не должны ехать вслед за нашими. */

/** Квадратный знак Битрикс24. */
export function BitrixMark({ size = 18 }: { size?: number }) {
  return (
    <img
      className="brandmark"
      src={bitrix}
      alt="Битрикс24"
      width={size}
      height={size}
      draggable={false}
    />
  );
}

/** Значок Microsoft Excel. */
export function ExcelMark({ size = 18 }: { size?: number }) {
  return (
    <img
      className="brandmark"
      src={excel}
      alt="Microsoft Excel"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
