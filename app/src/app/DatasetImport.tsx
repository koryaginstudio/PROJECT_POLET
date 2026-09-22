import { useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Input } from '../ds/components/forms/Input.jsx';
import { readDataset, saveDataset } from '../data/datasets.ts';
import type { ReadResult } from '../data/datasets.ts';
import { pluralWord } from '../data/derive.ts';
import { humanLine } from '../data/errors.ts';

interface Props {
  /** Набор загружен и сохранён: ключ нового источника. */
  onLoaded: (key: string) => void;
}

/* Загрузка набора данных.

   ТЗ требует этого первым же пунктом: решение должно загружать готовые
   тестовые данные из CSV или JSON либо работать на встроенном наборе.

   Принимаем две формы контракта — заявки и инженеров. Можно принести их
   двумя файлами сразу или одним, где обе лежат вместе: как их разложит
   чужая сборка, мы не знаем, и заставлять человека угадывать наш способ
   незачем.

   Чего не принимаем — сырую выгрузку нарядов. И это не лень: в ней нет ни
   координат, ни длительности работ, ни самих инженеров. Превратить её в
   набор можно только геокодером и таблицей допущений, и делает это
   `dataset/build.py`. Сказать об этом честно полезнее, чем принять файл и
   молча разложить пустой день. */
export function DatasetImport({ onLoaded }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [read, setRead] = useState<ReadResult | null>(null);
  const [title, setTitle] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setFailed(null);
    try {
      const result = await readDataset([...files]);
      setRead(result);
      setTitle(result.title);
    } catch (error) {
      /* Разбор сам складывает свои находки в список; сюда падает только
         то, чего он не ждал, — и вместо «NotReadableError: …» человек
         читает, что делать. */
      setFailed(
        humanLine(error, {
          title: 'Файл не прочитался',
          hint: 'Выберите его ещё раз; если повторится — сохраните файл заново.'
        })
      );
    } finally {
      setBusy(false);
      /* Сбрасываем поле: иначе повторный выбор того же файла не даст события
         и человек решит, что кнопка сломалась. */
      if (input.current) input.current.value = '';
    }
  };

  const keep = () => {
    if (!read || read.orders.length === 0 || read.engineers.length === 0) return;
    try {
      const saved = saveDataset(read, title);
      setRead(null);
      setTitle('');
      onLoaded(saved.key);
    } catch (error) {
      setFailed(humanLine(error, { title: 'Набор не сохранился', hint: 'Повторите ещё раз.' }));
    }
  };

  const usable = read && read.orders.length > 0 && read.engineers.length > 0;

  return (
    <div className="dsimport">
      <input
        ref={input}
        type="file"
        accept=".json,application/json"
        multiple
        hidden
        onChange={(event) => pick(event.currentTarget.files)}
      />

      {!read && (
        <>
          <p className="clients__lede">
            Набор — это две формы контракта: заявки и инженеры. Принесите их двумя файлами
            (<code>orders.json</code> и <code>engineers.json</code>) или одним, где обе лежат
            вместе. Загруженный набор встанет в ряд со встроенными зонами и попадёт во все базы
            данных.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => input.current?.click()}
            disabled={busy}
            iconLeft={<Icon name="upload" size={14} />}
          >
            {busy ? 'Читаю файлы…' : 'Выбрать файлы'}
          </Button>
        </>
      )}

      {read && (
        <div className="dsimport__found">
          <div className="dsimport__counts">
            <span className="dsimport__count">
              <b>{read.orders.length}</b> {pluralWord(read.orders.length, 'заявка', 'заявки', 'заявок')}
            </span>
            <span className="dsimport__count">
              <b>{read.engineers.length}</b>{' '}
              {pluralWord(read.engineers.length, 'инженер', 'инженера', 'инженеров')}
            </span>
            <span className="dsimport__count dsimport__count--muted">на {read.date}</span>
          </div>

          {read.problems.length > 0 && (
            <ul className="dsimport__problems">
              {read.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}

          {usable && (
            <Input
              label="Название набора"
              placeholder="Как называть его в списке"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          )}

          <div className="dsimport__actions">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setRead(null);
                setFailed(null);
              }}
            >
              Отмена
            </Button>
            <Button variant="primary" size="sm" onClick={keep} disabled={!usable}>
              {usable ? 'Добавить набор' : 'Набор неполон'}
            </Button>
          </div>
        </div>
      )}

      {failed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>{failed}</span>
        </div>
      )}
    </div>
  );
}
