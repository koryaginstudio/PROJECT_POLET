import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { noteOf, setNote, watchNotes } from '../data/notes.ts';
import type { NoteKind } from '../data/notes.ts';

interface Props {
  kind: NoteKind;
  id: string;
  /** Что подсказать, пока заметки нет. У инженера и у адреса поводы разные. */
  placeholder?: string;
}

/* Заметка к записи: то, что знает о ней диспетчер и не знают ни выгрузка, ни
   расчёт.

   Пока заметки нет, поле не занимает место формой — стоит тихая строка
   «Добавить заметку». Справочник читают десятками карточек подряд, и пустое
   поле ввода в каждой превратило бы список записей в список анкет.

   Правка заканчивается сама: по уходу фокуса и по Enter. Кнопки «сохранить»
   нет намеренно — заметка не документ, её дописывают на ходу, и лишний шаг
   между «написал» и «сохранилось» её бы и погубил: на второй карточке
   забываешь нажать, на третьей перестаёшь писать. Escape отменяет — и
   останавливается на самом поле, не доходя до карточки, иначе одно нажатие
   закрывало бы заодно и профиль. */
export function NoteField({ kind, id, placeholder = 'Добавить заметку' }: Props) {
  const [text, setText] = useState(() => noteOf(kind, id));
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  /* Заметку могли поправить в другом месте — в карточке, пока открыт
     профиль, или наоборот. Показываем всегда то, что в хранилище. */
  useEffect(() => {
    setText(noteOf(kind, id));
    setEditing(false);
    return watchNotes(() => setText(noteOf(kind, id)));
  }, [kind, id]);

  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);

  const open = () => {
    setDraft(noteOf(kind, id));
    setEditing(true);
  };

  const save = () => {
    setNote(kind, id, draft);
    setText(draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="note note--editing" onClick={(event) => event.stopPropagation()}>
        <textarea
          ref={field}
          className="note__input"
          value={draft}
          rows={2}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={save}
          onKeyDown={(event) => {
            /* Enter сохраняет, Shift+Enter переводит строку: заметка обычно в
               одну строку, и тянуться к мыши ради неё незачем. */
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              save();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      className={'note' + (text ? ' note--filled' : '')}
      onClick={(event) => {
        /* Карточка целиком открывает запись — заметка внутри неё живёт своей
           жизнью, иначе щелчок по ней открывал бы заодно и профиль. */
        event.stopPropagation();
        open();
      }}
      title={text ? 'Править заметку' : placeholder}
    >
      <Icon name={text ? 'pencil' : 'plus'} size={12} />
      <span className="note__text">{text || placeholder}</span>
    </button>
  );
}
