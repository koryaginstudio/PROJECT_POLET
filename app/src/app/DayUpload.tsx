import { useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { EngineUpload } from '../data/api.ts';
import { deleteUpload, EngineError, sendUpload } from '../data/api.ts';
import { humanLine } from '../data/errors.ts';
import { plural, pluralWord } from '../data/derive.ts';
import type { ImportKind } from '../data/tabular.ts';
import { ACCEPT, toUploadBytes, uploadName } from '../data/tabular.ts';

/* Выгрузка дня — файл, который диспетчер принёс из своей системы.

   ТЗ: «загружать готовые данные из CSV». Форматов на входе три — выгрузка
   CSV, таблица в Markdown и книга Excel, — а путь у них один: файл сводится
   к выгрузке дня (см. `data/tabular.ts`) и уходит программе расчёта как
   есть. Она сама разбирает кодировку, дату и адрес офиса и говорит, что в
   файле нашлось и чего не хватает, — до расчёта, а не после минуты счёта.

   Инженеров в смене на форме не спрашиваем: бригада приходит вместе с днём.
   Программе нужно число, и она получает то же, что стояло здесь по
   умолчанию, — четырнадцать человек по шаблону участка. */

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

/** Три формата одной кнопкой каждый. Порядок — как их приносят: книга из
    учётной системы, выгрузка таблицей, ответ чужой системы.

    Markdown отсюда ушёл: таблицу в разметке присылают из переписки, а не из
    системы, и ради одного такого случая кнопка занимала место в ряду
    наравне с форматами, которыми выгружают по-настоящему. JSON на её месте
    отвечает на настоящий случай — выгрузку из чужого сервиса. */
const KINDS: { kind: ImportKind; label: string }[] = [
  { kind: 'xlsx', label: 'Excel' },
  { kind: 'csv', label: 'CSV' },
  { kind: 'json', label: 'JSON' }
];

interface UploadProps {
  /** Выгрузка принята: предпросмотр движка. */
  onUploaded: (upload: EngineUpload) => void;
  /** Программа расчёта не запущена — принимать файл некому. */
  offline?: boolean;
}

export function DayImport({ onUploaded, offline = false }: UploadProps) {
  /* Своё поле выбора на каждый формат: у них разные accept, и одно поле на
     троих пришлось бы переключать состоянием перед самым открытием окна. */
  const inputs = useRef<Partial<Record<ImportKind, HTMLInputElement | null>>>({});
  const [busy, setBusy] = useState<ImportKind | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const send = async (kind: ImportKind, file: File) => {
    setBusy(kind);
    setFailed(null);
    try {
      const bytes = await toUploadBytes(kind, file);
      const upload = await sendUpload(uploadName(kind, file.name), bytes, ENGINEERS_DEFAULT);
      onUploaded(upload);
    } catch (error) {
      /* Своя ошибка разбора — это уже готовая фраза, и оборачивать её в
         «программа расчёта не ответила» значит соврать: программа файла
         даже не видела. */
      setFailed(
        error instanceof Error && !(error instanceof EngineError)
          ? error.message.charAt(0).toUpperCase() +
            error.message.slice(1) +
            (/[.!?]$/.test(error.message) ? '' : '.')
          : refusalText(error, 'Выгрузка не принята')
      );
    } finally {
      setBusy(null);
      /* Сбрасываем поле: иначе повторный выбор того же файла не даст события
         и человек решит, что кнопка сломалась. */
      const field = inputs.current[kind];
      if (field) field.value = '';
    }
  };

  return (
    <div className="dayimport">
      <div className="dayimport__row">
        {KINDS.map((one) => (
          <span key={one.kind} className="dayimport__slot">
            <input
              ref={(node) => {
                inputs.current[one.kind] = node;
              }}
              type="file"
              data-kind={one.kind}
              accept={ACCEPT[one.kind]}
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void send(one.kind, file);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              className="dayimport__btn"
              onClick={() => inputs.current[one.kind]?.click()}
              disabled={busy !== null || offline}
              iconLeft={<Icon name={busy === one.kind ? 'clock' : 'upload'} size={14} />}
              ariaLabel={`Импортировать файл ${one.label}`}
            >
              {busy === one.kind ? 'Читаю…' : one.label}
            </Button>
          </span>
        ))}
      </div>

      {offline && (
        <p className="dayimport__hint">Программа расчёта не запущена — принять файл некому.</p>
      )}

      {failed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>
            <b>Файл не принят.</b> {failed}
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
