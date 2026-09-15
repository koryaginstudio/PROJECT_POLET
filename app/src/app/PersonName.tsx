interface Props {
  name: string;
  /** Отчество отдельной строкой. В узком месте — в одну строку целиком. */
  stacked?: boolean;
}

/* Имя человека, разобранное на части.

   Фамилия — то, чем человека называют и ищут: в списке из тридцати четырёх
   глаз цепляется за неё, а не за имя. Поэтому она акцентная. Отчество, наоборот,
   в списке не нужно почти никогда — оно нужно, когда инженеру звонят, — и
   уходит второй строкой, где не мешает читать первую.

   Разбор держится того же правила, что и весь набор: показываем ровно то, что
   пришло. Одна фамилия — одна фамилия, фамилия с именем — без второй строки,
   полное ФИО — фамилия и имя сверху, отчество под ними. Набор, где отчеств нет
   вовсе, от этого не поедет. */
export function PersonName({ name, stacked = true }: Props) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const [surname, first, ...rest] = parts;
  const patronymic = rest.join(' ');

  if (!surname) return null;

  return (
    <span className="pname">
      <span className="pname__line">
        <span className="pname__surname">{surname}</span>
        {first && <span className="pname__first"> {first}</span>}
        {patronymic && !stacked && <span className="pname__first"> {patronymic}</span>}
      </span>
      {patronymic && stacked && <span className="pname__patronymic">{patronymic}</span>}
    </span>
  );
}
