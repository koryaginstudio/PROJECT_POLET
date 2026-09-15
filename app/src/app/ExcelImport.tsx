import { useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { hhmm } from '../data/derive.ts';
import { CSV_TEMPLATE, parseOrders } from '../data/csvOrders.ts';
import type { Parsed } from '../data/csvOrders.ts';
import type { ExtraOrder } from './SourcePicker.tsx';

/* Импорт заявок из выгрузки.

   Пока портал не подключён, день приезжает файлом — так его и передают между
   отделами: выгрузили из учётной системы, поправили руками, прислали
   диспетчеру. Здесь этот файл и читается.

   Читаем CSV, а не двоичный .xlsx: разбор книги Excel — это отдельная
   библиотека в полмегабайта ради одного экрана, и всё равно она не спасёт от
   объединённых ячеек и трёх строк шапки. «Сохранить как CSV» — одно движение
   в самом Excel, и после него файл читается однозначно. Файл книги тоже
   принимаем, но вместо молчания говорим, что с ним сделать.

   Колонки ищем по названиям, а не по местам: в присланной выгрузке порядок
   столбцов всегда чужой, и требовать «третьим столбцом окно» значит заставить
   диспетчера переставлять их руками. Нужен только адрес — остальное
   подставляется по умолчанию и правится потом в списке. */

interface Props {
  /** Какие номера уже заняты: импорт не должен налететь на заявку, которую
      диспетчер завёл руками. */
  usedIds: Set<string>;
  onAdd: (orders: ExtraOrder[]) => void;
}

export function ExcelImport({ usedIds, onAdd }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);

  const take = async (file: File) => {
    setError(null);
    setParsed(null);

    if (/\.xlsx?$/i.test(file.name)) {
      setError(
        'Это книга Excel. Откройте её и сохраните как CSV: «Файл → Сохранить как → CSV UTF-8». ' +
          'Читать двоичный формат книги мы намеренно не умеем — в нём слишком много способов ' +
          'записать одно и то же.'
      );
      return;
    }

    const text = await file.text();
    const result = parseOrders(text, usedIds, file.name);
    if (result.orders.length === 0 && result.skipped.length === 0) {
      setError('В файле не нашлось ни одной строки с адресом. Проверьте, что в шапке есть столбец «Адрес».');
      return;
    }
    setParsed(result);
  };

  const download = () => {
    /* Шаблон отдаём файлом, а не картинкой в подсказке: его открывают в том
       же Excel, заполняют поверх примера и присылают обратно. Впереди
       BOM — без него Excel читает кириллицу кракозябрами. */
    const blob = new Blob(['﻿' + CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'заявки-шаблон.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="srcexcel">
      <p className="clients__lede">
        Файл выгрузки с заявками дня: адрес, что делаем, окно приёма и сколько занимает работа.
        Обязателен только адрес — остальное подставится по умолчанию и правится в списке ниже.
        Столбцы ищутся по названиям в шапке, порядок значения не имеет.
      </p>

      <div className="srcexcel__actions">
        <input
          ref={input}
          type="file"
          accept=".csv,.txt,.xlsx,.xls"
          className="srcexcel__input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            if (file) void take(file);
            /* Сбрасываем значение: иначе повторный выбор того же файла не
               считается изменением и ничего не происходит. */
            event.currentTarget.value = '';
          }}
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={() => input.current?.click()}
          iconLeft={<Icon name="clipboard-text" size={14} />}
        >
          Выбрать файл
        </Button>
        <button type="button" className="srcexcel__template" onClick={download}>
          <Icon name="list" size={13} />
          Скачать шаблон
        </button>
      </div>

      {error && (
        <div className="srcexcel__error">
          <Icon name="alert-triangle" size={15} />
          <span>{error}</span>
        </div>
      )}

      {parsed && (
        <div className="srcexcel__result">
          <div className="srcexcel__head">
            <span className="srcexcel__file">
              <Icon name="clipboard-list" size={13} />
              {parsed.fileName}
            </span>
            <span className="srcexcel__count">
              разобрано {parsed.orders.length}
              {parsed.skipped.length > 0 && ` · снято ${parsed.skipped.length}`}
            </span>
          </div>

          {parsed.missing.length > 0 && (
            <p className="srcexcel__note">
              Не нашлось столбцов: {parsed.missing.join(', ')}. Для этих заявок подставлено
              окно 10:00–14:00 и час работы.
            </p>
          )}

          {/* Показываем первые строки, а не все: файл на двести заявок
              превратил бы форму в таблицу, а проверяют по нему одно — что
              колонки разошлись правильно. */}
          {parsed.orders.length > 0 && (
            <div className="srcexcel__rows">
              {parsed.orders.slice(0, 5).map((order) => (
                <div key={order.id} className="srcexcel__row">
                  <span className="srcexcel__what">
                    {order.workTitle}
                    {order.urgent && <span className="srcextra__flag">авария</span>}
                  </span>
                  <span className="srcexcel__where">
                    {order.address} · окно {hhmm(order.windowStart)}–{hhmm(order.windowEnd)} ·{' '}
                    {order.minutes} мин
                  </span>
                </div>
              ))}
              {parsed.orders.length > 5 && (
                <span className="srcexcel__more">и ещё {parsed.orders.length - 5}</span>
              )}
            </div>
          )}

          {parsed.skipped.length > 0 && (
            <p className="srcexcel__note srcexcel__note--bad">
              Снято строк: {parsed.skipped.length}. {parsed.skipped[0].why} — строка{' '}
              {parsed.skipped[0].line}
              {parsed.skipped.length > 1 && ' и другие'}.
            </p>
          )}

          <div className="srcexcel__confirm">
            <Button variant="secondary" size="sm" onClick={() => setParsed(null)}>
              Отменить
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={parsed.orders.length === 0}
              onClick={() => {
                onAdd(parsed.orders);
                setParsed(null);
              }}
            >
              Добавить {parsed.orders.length} в расчёт
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
