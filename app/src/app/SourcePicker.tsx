import { useMemo, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { BitrixMark, ExcelMark } from './BrandMarks.tsx';
import { Switch } from '../ds/components/forms/Switch.jsx';
import { Input } from '../ds/components/forms/Input.jsx';
import type { DayView } from '../data/derive.ts';
import { hhmm, plural } from '../data/derive.ts';
import { skillIcon, skillName } from '../data/dictionary.ts';
import { ExcelImport } from './ExcelImport.tsx';

/** Заявка, которую диспетчер завёл руками поверх выгрузки. */
export interface ExtraOrder {
  id: string;
  address: string;
  workTitle: string;
  windowStart: number;
  windowEnd: number;
  minutes: number;
  urgent: boolean;
}

export interface SourceChoice {
  /** Откуда берём состав дня. */
  from: 'bitrix' | 'excel' | 'manual';
  /** Инженеры, которых ставим в смену. */
  engineers: string[];
  /** Навыки, снятые у конкретных инженеров на этот расчёт. */
  skillsOff: Record<string, string[]>;
  /** Заявки, добавленные руками. */
  extra: ExtraOrder[];
}

interface Props {
  view: DayView;
  value: SourceChoice;
  onChange: (next: SourceChoice) => void;
}

/* Вводные расчёта: откуда берём день, кто в смене и что добавлено сверх
   выгрузки.

   Всё это лежит в одном блоке, а не в трёх подряд. Вводные — один вопрос:
   что именно движок будет раскладывать. Разнесённые по отдельным панелям,
   они читались как три независимых настройки, и состав смены терялся между
   источником данных и параметрами солвера.

   Источников три, и они отвечают на «откуда пришёл день»: портал, файл
   выгрузки или ручной ввод. Состояние подключения на карточках не пишем —
   выбранный источник сам раскрывает то, что с ним можно сделать.

   Что уже работает по-настоящему: состав смены и заявки. Инженера можно снять
   с сегодняшнего дня, у оставшегося — снять навык, заявки можно загрузить
   файлом или дописать руками. Это то, что диспетчер делает каждое утро, и от
   источника данных оно не зависит.

   Навыки снимаются, но не выдаются: навык — подтверждённая квалификация из
   кадровой системы. «Сегодня без инструмента для линейных работ» — решение на
   смену, и это как раз снятие. */

const BITRIX_ENTITIES = [
  { key: 'engineers', label: 'Инженеры', what: 'Пользователи портала с ролью выездного специалиста' },
  { key: 'orders', label: 'Заявки', what: 'Сделки или дела с адресом и окном приёма' },
  { key: 'skills', label: 'Навыки', what: 'Пользовательское поле квалификации в карточке сотрудника' },
  { key: 'shifts', label: 'Графики смен', what: 'Табель рабочего времени — данные, а не настройка' }
];

const nextOrderId = (used: Set<string>) => {
  for (let n = 1; n < 1000; n += 1) {
    const id = `X${String(n).padStart(3, '0')}`;
    if (!used.has(id)) return id;
  }
  return `X${Date.now()}`;
};

export function SourcePicker({ view, value, onChange }: Props) {
  const [openCrew, setOpenCrew] = useState(false);
  const [draft, setDraft] = useState<ExtraOrder | null>(null);

  const crew = useMemo(() => view.loads.map((load) => load.engineer), [view]);
  const chosen = new Set(value.engineers);

  const set = (patch: Partial<SourceChoice>) => onChange({ ...value, ...patch });

  const toggleEngineer = (id: string) => {
    const next = chosen.has(id)
      ? value.engineers.filter((e) => e !== id)
      : [...value.engineers, id];
    /* Пустая смена — не выбор, а ошибка: считать будет некому. Последнего
       не снимаем. */
    if (next.length > 0) set({ engineers: next });
  };

  const toggleSkill = (engineerId: string, skill: string) => {
    const off = value.skillsOff[engineerId] ?? [];
    const next = off.includes(skill) ? off.filter((s) => s !== skill) : [...off, skill];
    set({ skillsOff: { ...value.skillsOff, [engineerId]: next } });
  };

  const offCount = Object.values(value.skillsOff).reduce((sum, list) => sum + list.length, 0);

  return (
    <section className="panel">
      <div className="dash__section-head">
        <h2 className="dash__section-title">Откуда берём данные</h2>
      </div>
      <p className="clients__lede">
        Расчёту нужны две вещи: кто сегодня вышел и что сегодня приехало. Источник дня выбирается
        ниже, состав смены и заявки правятся здесь же.
      </p>

      <div className="srcgrid">
        <button
          type="button"
          className={'srccard' + (value.from === 'bitrix' ? ' srccard--on' : '')}
          onClick={() => set({ from: 'bitrix' })}
        >
          <span className="srccard__top">
            <BitrixMark size={18} />
            <span className="srccard__title">Импорт из Битрикс24</span>
          </span>
          <span className="srccard__what">
            Инженеры, заявки и навыки поступают с портала по вебхуку. Подключение настраивает
            администратор один раз.
          </span>
        </button>

        <button
          type="button"
          className={'srccard' + (value.from === 'excel' ? ' srccard--on' : '')}
          onClick={() => set({ from: 'excel' })}
        >
          <span className="srccard__top">
            <ExcelMark size={18} />
            <span className="srccard__title">Импорт из Excel</span>
          </span>
          <span className="srccard__what">
            Заявки дня загружаются файлом выгрузки: адрес, вид работ, окно приёма и длительность.
          </span>
        </button>

        <button
          type="button"
          className={'srccard' + (value.from === 'manual' ? ' srccard--on' : '')}
          onClick={() => set({ from: 'manual' })}
        >
          <span className="srccard__top">
            <Icon name="stack" size={16} />
            <span className="srccard__title">Добавить вручную</span>
          </span>
          <span className="srccard__what">
            День стенда: {view.loads.length} инженеров и {view.orderById.size} заявок с реальными
            адресами. Заявки дополняются вручную.
          </span>
        </button>
      </div>

      {value.from === 'bitrix' && (
        <div className="srcbitrix">
          <p className="clients__lede">С портала поступают четыре набора данных:</p>
          <div className="srcentities">
            {BITRIX_ENTITIES.map((item) => (
              <div key={item.key} className="srcentity">
                <span className="srcentity__label">{item.label}</span>
                <span className="srcentity__what">{item.what}</span>
              </div>
            ))}
          </div>

          <div className="srcfields">
            <Input label="Адрес портала" placeholder="https://company.bitrix24.ru" disabled />
            <Input label="Вебхук" placeholder="Ключ входящего вебхука" disabled />
          </div>
        </div>
      )}

      {value.from === 'excel' && (
        <div className="srcbitrix">
          <ExcelImport
            usedIds={new Set(value.extra.map((order) => order.id))}
            onAdd={(orders) => set({ extra: [...value.extra, ...orders] })}
          />
        </div>
      )}

      {/* Состав смены. Работает независимо от источника: снять человека с
          сегодняшнего дня — решение диспетчера, а не свойство выгрузки. */}
      <div className="srcblock">
        <div className="dash__section-head">
          <h3 className="srcblock__title">Кто сегодня в смене</h3>
          <span className="dash__section-note">
            {value.engineers.length} из {crew.length}
            {offCount > 0 && ` · снято навыков: ${offCount}`}
          </span>
        </div>
        <p className="clients__lede">
          Снятый инженер в расчёт не попадёт, его заявки движок распределит между остальными. Навык
          снимается на один день; выдать навык здесь нельзя — это данные кадровой системы.
        </p>

        <button
          type="button"
          className="srctoggle"
          onClick={() => setOpenCrew((v) => !v)}
          aria-expanded={openCrew}
        >
          <Icon name={openCrew ? 'chevron-up' : 'chevron-down'} size={13} />
          {openCrew ? 'Свернуть состав' : 'Показать состав'}
        </button>

        {openCrew && (
          <div className="srccrew">
            {crew.map((engineer) => {
              const on = chosen.has(engineer.id);
              const off = value.skillsOff[engineer.id] ?? [];
              return (
                <div key={engineer.id} className={'srcman' + (on ? '' : ' srcman--off')}>
                  <Switch
                    size="sm"
                    label=""
                    checked={on}
                    onChange={() => toggleEngineer(engineer.id)}
                  />
                  <span className="srcman__body">
                    <span className="srcman__name">
                      {engineer.name}
                      <span className="srcman__id">{engineer.id}</span>
                    </span>
                    <span className="srcman__shift">
                      смена {hhmm(engineer.shift_start)}–{hhmm(engineer.shift_end)}
                    </span>
                  </span>
                  <span className="srcman__skills">
                    {engineer.skills.map((skill) => {
                      const dropped = off.includes(skill);
                      return (
                        <button
                          key={skill}
                          type="button"
                          className={'srcskill' + (dropped ? ' srcskill--off' : '')}
                          disabled={!on}
                          onClick={() => toggleSkill(engineer.id, skill)}
                          title={dropped ? 'Вернуть навык на сегодня' : 'Снять навык на сегодня'}
                        >
                          <Icon name={skillIcon(skill)} size={12} />
                          {skillName(skill)}
                        </button>
                      );
                    })}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Заявки сверх выгрузки: то, что поступило после её формирования —
          звонок, авария, перенос с прошлого дня. */}
      <div className="srcblock">
        <div className="dash__section-head">
          <h3 className="srcblock__title">Заявки поверх выгрузки</h3>
          <span className="dash__section-note">
            {value.extra.length === 0
              ? 'ни одной'
              : plural(value.extra.length, 'заявка', 'заявки', 'заявок')}
          </span>
        </div>
        <p className="clients__lede">
          Заявки, которых не было в выгрузке. В расчёт они идут наравне с остальными.
        </p>

        {value.extra.length > 0 && (
          <div className="srcextra">
            {value.extra.map((order) => (
              <div key={order.id} className="srcextra__row">
                <span className="srcextra__id">{order.id}</span>
                <span className="srcextra__body">
                  <span className="srcextra__what">
                    {order.workTitle}
                    {order.urgent && <span className="srcextra__flag">авария</span>}
                  </span>
                  <span className="srcextra__where">
                    {order.address} · окно {hhmm(order.windowStart)}–{hhmm(order.windowEnd)} ·{' '}
                    {order.minutes} мин
                  </span>
                </span>
                <button
                  type="button"
                  className="rpanel__x"
                  onClick={() => set({ extra: value.extra.filter((e) => e.id !== order.id) })}
                  aria-label={`Убрать заявку ${order.id}`}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}

        {draft ? (
          <div className="srcform">
            <Input
              label="Адрес"
              placeholder="улица и дом"
              value={draft.address}
              onChange={(e) => setDraft({ ...draft, address: e.target.value })}
            />
            <Input
              label="Что делаем"
              placeholder="Подключение, ремонт…"
              value={draft.workTitle}
              onChange={(e) => setDraft({ ...draft, workTitle: e.target.value })}
            />
            <label className="incident__field">
              <span className="incident__field-label">Окно с</span>
              <input
                className="rule__input"
                type="time"
                value={hhmm(draft.windowStart)}
                onChange={(e) => {
                  const [h, m] = e.currentTarget.value.split(':').map(Number);
                  if (Number.isFinite(h)) setDraft({ ...draft, windowStart: h * 60 + m });
                }}
              />
            </label>
            <label className="incident__field">
              <span className="incident__field-label">Окно до</span>
              <input
                className="rule__input"
                type="time"
                value={hhmm(draft.windowEnd)}
                onChange={(e) => {
                  const [h, m] = e.currentTarget.value.split(':').map(Number);
                  if (Number.isFinite(h)) setDraft({ ...draft, windowEnd: h * 60 + m });
                }}
              />
            </label>
            <label className="incident__field">
              <span className="incident__field-label">Работы, мин</span>
              <input
                className="rule__input"
                type="number"
                min={15}
                max={480}
                step={15}
                value={draft.minutes}
                onChange={(e) => setDraft({ ...draft, minutes: Number(e.currentTarget.value) })}
              />
            </label>
            <label className="srcform__urgent">
              <Switch
                size="sm"
                label="Авария"
                checked={draft.urgent}
                onChange={() => setDraft({ ...draft, urgent: !draft.urgent })}
              />
            </label>

            <div className="srcform__actions">
              <Button variant="secondary" size="sm" onClick={() => setDraft(null)}>
                Отмена
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!draft.address.trim() || !draft.workTitle.trim()}
                onClick={() => {
                  set({ extra: [...value.extra, draft] });
                  setDraft(null);
                }}
              >
                Добавить
              </Button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="srctoggle"
            onClick={() =>
              setDraft({
                id: nextOrderId(new Set(value.extra.map((e) => e.id))),
                address: '',
                workTitle: '',
                windowStart: 10 * 60,
                windowEnd: 14 * 60,
                minutes: 60,
                urgent: false
              })
            }
          >
            <Icon name="plus" size={13} />
            Добавить заявку
          </button>
        )}
      </div>
    </section>
  );
}
