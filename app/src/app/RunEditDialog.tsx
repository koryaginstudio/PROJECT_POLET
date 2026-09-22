import { useEffect, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { RunPatch } from '../data/load.ts';
import { RUNS } from '../data/load.ts';
import type { RunRef } from '../data/registry.ts';
import { useModalFocus } from './modal.ts';

interface Props {
  /** Запись, которую правят. Пусто — окна нет. */
  run: RunRef | null;
  onClose: () => void;
  onSave: (patch: RunPatch) => void;
  onDelete: () => void;
}

/* Правка записи расчёта.

   Править можно только то, что завёл человек: номер, время создания и
   заметку. Цифры плана — покрытие, визиты, маршруты — сюда не выведены и
   выведены не будут: их посчитал движок, и переписать их значило бы соврать
   про расчёт. Про это в окне сказано прямо, а не оставлено на догадку.

   Удаление стоит здесь же и в два шага: первый щелчок только спрашивает.
   Отдельной кнопки «удалить» в карточке нет — иначе она стояла бы рядом с
   «Открыть» и ловила бы промахи. */
/* Номера расчётов в истории заводятся как «R» и число: буква — часть
   обозначения, а не часть номера, и менять её незачем. Поэтому в поле она
   стоит отдельно и не редактируется, а правится только то, что после неё.

   Вставленный из буфера «R031» не должен превращаться в «RR031»: ведущую
   букву снимаем и в латинице, и в кириллице — на глаз они неотличимы. */
const PREFIX = 'R';

/* Ведущую букву снимаем любую из тех, что могли оказаться в буфере: своя
   латинская «R», кириллическая «Р», неотличимая от неё на глаз, и прежняя
   «M» — номера расчётов раньше писались через неё, и вставленный из старой
   переписки «M031» обязан прочитаться как 31. */
const tailOf = (code: string) => code.replace(/^[RРрrMМмm]\s*/u, '');

/* Номер дополняется до трёх цифр, как их выдаёт история: набранное «2»
   становится «R002», а не «R2», и в списках стоит вровень с соседями. Не
   число — оставляем как набрали: буквы в номере не наше дело. */
const padTail = (tail: string) => (/^\d{1,2}$/.test(tail) ? tail.padStart(3, '0') : tail);

export function RunEditDialog({ run, onClose, onSave, onDelete }: Props) {
  const [tail, setTail] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(run !== null, card);

  /* Поля наполняются при каждом открытии: окно одно на все записи, и
     оставшийся в нём чужой номер был бы худшим из возможных обманов. */
  useEffect(() => {
    if (!run) return;
    const [day, clock = '00:00'] = run.created.split('T');
    setTail(tailOf(run.code));
    setDate(day);
    setTime(clock);
    setNote(run.note ?? '');
    setConfirming(false);
  }, [run]);

  useEffect(() => {
    if (!run) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [run, onClose]);

  if (!run) return null;

  const trimmed = padTail(tail.trim());
  const code = PREFIX + trimmed;
  /* Номер обязан быть единственным: им расчёты различают вслух и им же
     находят в поиске, и два R031 в истории — это один потерянный. Свой
     прежний номер записи оставить можно. */
  const taken = trimmed.length > 0 && RUNS.some((one) => one.id !== run.id && one.code === code);
  /* Пустой номер и пустая дата не сохраняются: по ним запись находят в
     истории, и без них она перестаёт быть записью. Одна буква номером тоже
     не считается. */
  const valid = trimmed.length > 0 && date.length > 0 && !taken;

  const save = () => {
    if (!valid) return;
    onSave({
      code,
      created: `${date}T${time || '00:00'}`,
      note: note.trim() || undefined
    });
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Правка расчёта ${run.code}`}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card runedit" ref={card}>
        <div className="modal__head">
          <h3 className="runedit__title">Расчёт {run.code}</h3>
          <span className="modal__esc">
            <kbd>Esc</kbd> — закрыть
          </span>
          <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="runedit__lede">
          Правится то, что завели вы: номер, время создания и заметка. Цифры плана правке не
          подлежат — их посчитал движок.
        </p>

        <label className="runedit__field">
          <span className="runedit__label">Номер расчёта</span>
          <span className="runedit__input runedit__prefixed">
            <span className="runedit__prefix" aria-hidden="true">
              {PREFIX}
            </span>
            <input
              className="runedit__bare"
              value={tail}
              onChange={(event) => setTail(tailOf(event.currentTarget.value))}
              placeholder="024"
              aria-label="Номер расчёта после буквы R"
            />
          </span>
          {taken && (
            <span className="runedit__wrong">
              Номер {code} уже есть в истории — выберите другой
            </span>
          )}
          {!taken && trimmed !== tail.trim() && trimmed.length > 0 && (
            <span className="runedit__hint">Сохранится как {code}</span>
          )}
        </label>

        <div className="runedit__pair">
          <label className="runedit__field">
            <span className="runedit__label">Дата создания</span>
            <input
              className="runedit__input"
              type="date"
              value={date}
              onChange={(event) => setDate(event.currentTarget.value)}
            />
          </label>

          <label className="runedit__field">
            <span className="runedit__label">Время</span>
            <input
              className="runedit__input"
              type="time"
              value={time}
              onChange={(event) => setTime(event.currentTarget.value)}
            />
          </label>
        </div>

        <label className="runedit__field">
          <span className="runedit__label">Заметка</span>
          <textarea
            className="runedit__input runedit__area"
            value={note}
            rows={2}
            onChange={(event) => setNote(event.currentTarget.value)}
            placeholder="Зачем считали и чем кончилось"
          />
        </label>

        <p className="runedit__note">
          Правки хранятся в этом браузере: сервера у нас пока нет. Снять их разом можно в
          настройках, на вкладке «Данные».
        </p>

        <div className="runedit__actions">
          <Button variant="primary" size="sm" onClick={save} disabled={!valid}>
            Сохранить
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Отмена
          </Button>

          <span className="runedit__spacer" />

          {confirming ? (
            <>
              <span className="runedit__ask">Удалить запись?</span>
              <button type="button" className="runedit__danger" onClick={onDelete}>
                <Icon name="trash" size={13} />
                Удалить
              </button>
              <button
                type="button"
                className="runedit__cancel"
                onClick={() => setConfirming(false)}
              >
                Нет
              </button>
            </>
          ) : (
            <button
              type="button"
              className="runedit__danger runedit__danger--quiet"
              onClick={() => setConfirming(true)}
            >
              <Icon name="trash" size={13} />
              Удалить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
