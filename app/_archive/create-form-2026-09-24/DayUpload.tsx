import { useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Input } from '../ds/components/forms/Input.jsx';
import type { EngineUpload } from '../data/api.ts';
import { deleteUpload, EngineError, sendUpload } from '../data/api.ts';
import { humanLine } from '../data/errors.ts';
import { plural, pluralWord } from '../data/derive.ts';

/* Выгрузка дня — файл, который диспетчер принёс из своей системы.

   ТЗ: «загружать готовые данные из CSV». При программе расчёта это одна
   кнопка: файл уходит программе как есть, она сама разбирает кодировку
   (cp1251 или UTF-8), дату и адрес офиса и говорит, что в файле нашлось и
   чего не хватает, — до расчёта, а не после минуты счёта. Прежде при
   программе расчёта загрузки на форме не было вовсе: загружали только
   наборы для счёта в браузере, а их программа не принимала. */

/** Отказ программы расчёта словами для диспетчера. У выгрузки её отказ и
    есть объяснение — «в файле нет строки «Адрес офиса»…», — и прятать его
    под «Подробности» значило бы оставить человека с «не приняла запрос». */
function refusalText(error: unknown, fallback: string): string {
  if (error instanceof EngineError && error.failure === 'refused' && error.status === 400) {
    const text = error.message.replace(/^плохой параметр:\s*/, '');
    return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
  }
  return humanLine(error, { title: fallback, hint: 'Повторите ещё раз.' });
}

const ENGINEERS_DEFAULT = 14;
const ENGINEERS_MIN = 1;
const ENGINEERS_MAX = 30;

interface UploadProps {
  /** Выгрузка принята: предпросмотр движка. */
  onUploaded: (upload: EngineUpload) => void;
  /** Выбранная сейчас выгрузка — чтобы предложить пересобрать её на другое
      число инженеров, пока файл ещё в руках. */
  current?: EngineUpload;
}

export function DayUploadButton({ onUploaded, current }: UploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const [engineers, setEngineers] = useState(String(ENGINEERS_DEFAULT));
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /* Последний выбранный файл: число инженеров — часть дня, и чтобы сменить
     его, файл надо прислать заново. Пока он здесь, это одна кнопка, а не
     повторный поиск файла на диске. */
  const [lastFile, setLastFile] = useState<{ file: File; day: string } | null>(null);

  const count = Number(engineers);
  const countOk = Number.isInteger(count) && count >= ENGINEERS_MIN && count <= ENGINEERS_MAX;

  const send = async (file: File) => {
    if (!countOk) return;
    setBusy(true);
    setFailed(null);
    try {
      const upload = await sendUpload(file.name, await file.arrayBuffer(), count);
      setLastFile({ file, day: upload.day });
      onUploaded(upload);
    } catch (error) {
      setFailed(refusalText(error, 'Выгрузка не принята'));
    } finally {
      setBusy(false);
      /* Сбрасываем поле: иначе повторный выбор того же файла не даст события
         и человек решит, что кнопка сломалась. */
      if (input.current) input.current.value = '';
    }
  };

  const canRebuild =
    lastFile !== null && current !== undefined && current.day === lastFile.day && countOk && count !== current.engineers;

  return (
    <div className="dsimport dayupload">
      <input
        ref={input}
        type="file"
        accept=".csv,text/csv,text/plain"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void send(file);
        }}
      />
      <p className="clients__lede">
        Файл выгрузки заявок на день — такой же, как у участков выше: колонки «Заявка», «Тип заявки
        BK», «Начало», «Окончание», «Адрес», внизу строка «Адрес офиса». Программа расчёта
        покажет, что в нём нашлось, до того как считать.
      </p>
      <div className="dayupload__row">
        <Input
          className="dayupload__count"
          label="Инженеров в смене"
          type="number"
          size="sm"
          value={engineers}
          onChange={(event) => setEngineers(event.currentTarget.value)}
          error={countOk ? undefined : `От ${ENGINEERS_MIN} до ${ENGINEERS_MAX}`}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => input.current?.click()}
          disabled={busy || !countOk}
          iconLeft={<Icon name="upload" size={14} />}
        >
          {busy ? 'Читаю файл…' : 'Загрузить выгрузку дня'}
        </Button>
        {canRebuild && (
          <Button variant="ghost" size="sm" onClick={() => void send(lastFile.file)} disabled={busy}>
            Пересобрать на {plural(count, 'инженера', 'инженеров', 'инженеров')}
          </Button>
        )}
      </div>
      <p className="dayupload__hint">
        Инженеров в выгрузке нет — бригада собирается по шаблону: навыки, транспорт и смены с
        8:00 до 22:00, выезд из офиса выгрузки.
      </p>
      {failed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>
            <b>Выгрузка не принята.</b> {failed}
          </span>
        </div>
      )}
    </div>
  );
}

/** «около 2 мин» — сколько займёт поиск адресов. */
function aboutTime(seconds: number): string {
  if (seconds < 60) return `около ${Math.max(seconds, 5)} с`;
  const minutes = Math.round(seconds / 60);
  /* После «около» — родительный: около минуты, около двух минут. */
  return minutes === 1 ? 'около минуты' : `около ${minutes} минут`;
}

const russianDate = (iso: string) => iso.split('-').reverse().join('.');

interface PreviewProps {
  upload: EngineUpload;
  onDeleted: (day: string) => void;
}

/* Что программа расчёта нашла в выгрузке — до расчёта. Ответ на три
   вопроса диспетчера: что посчитается, что нет и почему, и хватит ли для
   этого того, что есть, или нужен интернет. */
export function DayUploadPreview({ upload, onDeleted }: PreviewProps) {
  const [deleting, setDeleting] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { addresses } = upload;

  const remove = async () => {
    setDeleting(true);
    setFailed(null);
    try {
      await deleteUpload(upload.day);
      onDeleted(upload.day);
    } catch (error) {
      setFailed(
        error instanceof EngineError && error.status === 409
          ? error.message.charAt(0).toUpperCase() + error.message.slice(1) + '.'
          : humanLine(error, { title: 'Выгрузка не убрана', hint: 'Повторите ещё раз.' })
      );
    } finally {
      setDeleting(false);
    }
  };

  /* Что будет при «Рассчитать». Готовность — не одна галочка: адреса и сеть
     могут быть на месте, и тогда интернет не нужен вовсе; могут быть не на
     месте — и тогда без него не выйдет. Сказать это надо до нажатия. */
  let readiness: { tone: 'ok' | 'wait' | 'bad'; text: string };
  if (upload.status === 'готова') {
    readiness = { tone: 'ok', text: 'Готова к расчёту: адреса найдены, сеть дорог построена, план посчитан.' };
  } else if (upload.status === 'готовится') {
    const step = upload.stage ? upload.stage.charAt(0).toUpperCase() + upload.stage.slice(1) : 'Готовлю';
    const done = upload.progress ? `: ${upload.progress.done} из ${upload.progress.total}` : '';
    readiness = { tone: 'wait', text: `${step}${done}…` };
  } else if (upload.status === 'ошибка') {
    readiness = {
      tone: 'bad',
      text: (upload.error ?? 'Подготовка не удалась.').replace(/^./, (c) => c.toUpperCase())
    };
  } else if (!upload.office_found) {
    readiness = {
      tone: 'bad',
      text: 'Адрес офиса не найден геокодером — инженерам неоткуда выезжать. Проверьте строку «Адрес офиса».'
    };
  } else if (addresses.to_search > 0) {
    readiness = {
      tone: 'wait',
      text:
        `Перед расчётом программа найдёт ${plural(addresses.to_search, 'новый адрес', 'новых адреса', 'новых адресов')} ` +
        `и достроит сеть дорог — нужен интернет, ${aboutTime(addresses.search_seconds)}.`
    };
  } else if (upload.network === 'нужен интернет') {
    readiness = {
      tone: 'wait',
      text: 'Адреса известны. Перед расчётом программа построит под них сеть дорог — нужен интернет.'
    };
  } else {
    readiness = {
      tone: 'ok',
      text: 'Адреса и сеть дорог уже есть — расчёт пойдёт без интернета.'
    };
  }

  return (
    <section className="panel dayupload__preview">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Выгрузка «{upload.title}»</h2>
        <span className="dash__section-note">файл {upload.name}</span>
      </div>

      <div className="dsimport__counts">
        <span className="dsimport__count">
          <b>{upload.to_plan}</b> {pluralWord(upload.to_plan, 'заявка', 'заявки', 'заявок')} к расчёту
        </span>
        <span className="dsimport__count">
          <b>{upload.engineers}</b> {pluralWord(upload.engineers, 'инженер', 'инженера', 'инженеров')}
        </span>
        <span className="dsimport__count dsimport__count--muted">на {russianDate(upload.date)}</span>
      </div>
      <p className="dayupload__office">
        <Icon name="map-pin" size={14} /> Офис, откуда выезжают: {upload.office}
      </p>

      <div className={'dayupload__ready dayupload__ready--' + readiness.tone}>
        <Icon
          name={readiness.tone === 'ok' ? 'check-circle' : readiness.tone === 'bad' ? 'alert-triangle' : 'clock'}
          size={16}
        />
        <span>{readiness.text}</span>
      </div>

      {upload.skipped.length > 0 && (
        <details className="dayupload__skipped">
          <summary>
            {plural(upload.skipped.length, 'строка отложена', 'строки отложены', 'строк отложено')} — в
            расчёт не пойдут. Почему
          </summary>
          <ul className="dsimport__problems">
            {upload.skipped.map((row) => (
              <li key={`${row.line}-${row.id}`}>
                строка {row.line}
                {row.id ? ` · заявка ${row.id}` : ''} — {row.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {upload.warnings.length > 0 && (
        <ul className="dsimport__problems">
          {upload.warnings.map((warning) => (
            <li key={warning}>{warning.charAt(0).toUpperCase() + warning.slice(1)}</li>
          ))}
        </ul>
      )}

      <div className="dsimport__actions">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void remove()}
          disabled={deleting || upload.status === 'готовится'}
          iconLeft={<Icon name="trash" size={14} />}
        >
          {deleting ? 'Убираю…' : 'Убрать выгрузку'}
        </Button>
      </div>
      {failed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>{failed}</span>
        </div>
      )}
    </section>
  );
}
