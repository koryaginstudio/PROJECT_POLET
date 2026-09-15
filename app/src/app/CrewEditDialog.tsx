import { useEffect, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import type { EngineerRecord } from '../data/registry.ts';
import type { CrewPatch } from '../data/crew.ts';
import { hhmm } from '../data/derive.ts';
import { skillIcon, skillName, transportName } from '../data/dictionary.ts';

interface Props {
  /** Кого правят. Пусто — окна нет. */
  crew: EngineerRecord | null;
  onClose: () => void;
  onSave: (patch: CrewPatch) => void;
  onDelete: () => void;
}

/* Правка карточки инженера.

   Правится то, что принадлежит человеку: имя, телефон, транспорт, навыки,
   состояние на день и часы смены. Не правится то, что принадлежит не ему:
   табельный номер — им человека сводят между расчётами, — участок и адрес
   офиса: они приходят из дня, а не из карточки сотрудника. Про это в окне
   сказано прямо, а не оставлено на догадку.

   Правка ложится на данные, а не на карточку: поправленный транспорт меняет
   и то, какие заявки человек возьмёт в следующем расчёте. Иначе в базе было
   бы написано одно, а планировщик считал бы по другому.

   Удаление — в два шага, первый только спрашивает. Стоит здесь же, а не
   отдельной кнопкой в карточке: рядом с «открыть» она ловила бы промахи. */

const TRANSPORTS = ['car', 'walk', 'bike', 'transit'];
const STATUSES = ['on_shift', 'off_shift', 'unavailable'];
const SKILLS = ['local', 'connect', 'emergency'];

const STATUS_LABELS: Record<string, string> = {
  on_shift: 'В смене',
  off_shift: 'Выходной',
  unavailable: 'Сегодня не выйдет'
};

const toMinutes = (value: string) => {
  const [h, m] = value.split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
};

export function CrewEditDialog({ crew, onClose, onSave, onDelete }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [transport, setTransport] = useState('car');
  const [status, setStatus] = useState('on_shift');
  const [skills, setSkills] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [confirming, setConfirming] = useState(false);

  /* Поля наполняются при каждом открытии: окно одно на весь штат, и
     оставшийся в нём чужой телефон был бы худшим из возможных обманов. */
  useEffect(() => {
    if (!crew) return;
    setName(crew.name);
    setPhone(crew.phone ?? '');
    setTransport(crew.transport ?? 'car');
    setStatus(crew.status ?? 'on_shift');
    setSkills([...crew.skills]);
    setFrom(hhmm(crew.shiftStart));
    setTo(hhmm(crew.shiftEnd));
    setConfirming(false);
  }, [crew]);

  useEffect(() => {
    if (!crew) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [crew, onClose]);

  if (!crew) return null;

  const start = toMinutes(from);
  const end = toMinutes(to);
  /* Человек без имени и без единого навыка — не запись, а дыра в справочнике:
     по имени его находят, по навыку он получает работу. Смена, кончающаяся
     раньше, чем началась, тоже не смена. */
  const valid =
    name.trim().length > 0 && skills.length > 0 && start !== null && end !== null && end > start;

  const save = () => {
    if (!valid) return;
    onSave({
      name: name.trim(),
      phone: phone.trim() || null,
      transport,
      status,
      skills,
      shift_start: start as number,
      shift_end: end as number
    });
  };

  const toggleSkill = (key: string) =>
    setSkills((was) => (was.includes(key) ? was.filter((one) => one !== key) : [...was, key]));

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Правка карточки ${crew.name}`}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card runedit">
        <div className="modal__head">
          <h3 className="runedit__title">{crew.name}</h3>
          <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={16} />
          </button>
        </div>

        <p className="runedit__lede">
          Правится то, что принадлежит человеку. Табельный номер {crew.id}, участок и адрес
          выезда правке не подлежат: номером человека сводят между расчётами, а участок с офисом
          приходят из дня, а не из карточки. Правка учитывается и в следующем расчёте — например,
          сменив транспорт, вы меняете и то, какие заявки он сможет взять.
        </p>

        <label className="runedit__field">
          <span className="runedit__label">Фамилия, имя и отчество</span>
          <input
            className="runedit__input"
            value={name}
            onChange={(event) => setName(event.currentTarget.value)}
            placeholder="Иванов Иван Иванович"
          />
        </label>

        <div className="runedit__pair">
          <label className="runedit__field">
            <span className="runedit__label">Телефон</span>
            <input
              className="runedit__input"
              value={phone}
              onChange={(event) => setPhone(event.currentTarget.value)}
              placeholder="+7 495 000-00-00"
            />
          </label>

          <label className="runedit__field">
            <span className="runedit__label">Транспорт</span>
            <Select
              size="sm"
              value={transport}
              options={TRANSPORTS.map((key) => ({ value: key, label: transportName(key) }))}
              onChange={(event) => setTransport(event.currentTarget.value)}
            />
          </label>
        </div>

        <div className="runedit__pair">
          <label className="runedit__field">
            <span className="runedit__label">Смена с</span>
            <input
              className="runedit__input"
              type="time"
              value={from}
              onChange={(event) => setFrom(event.currentTarget.value)}
            />
          </label>

          <label className="runedit__field">
            <span className="runedit__label">Смена до</span>
            <input
              className="runedit__input"
              type="time"
              value={to}
              onChange={(event) => setTo(event.currentTarget.value)}
            />
          </label>
        </div>

        <label className="runedit__field">
          <span className="runedit__label">Состояние на день</span>
          <Select
            size="sm"
            value={status}
            options={STATUSES.map((key) => ({ value: key, label: STATUS_LABELS[key] }))}
            onChange={(event) => setStatus(event.currentTarget.value)}
          />
        </label>

        <div className="runedit__field">
          <span className="runedit__label">Навыки</span>
          <div className="skillrow">
            {SKILLS.map((key) => {
              const on = skills.includes(key);
              return (
                <button
                  key={key}
                  type="button"
                  className={'chip chip--sm' + (on ? ' chip--on' : '')}
                  onClick={() => toggleSkill(key)}
                  aria-pressed={on}
                >
                  <Icon name={skillIcon(key)} size={12} />
                  {skillName(key)}
                </button>
              );
            })}
          </div>
        </div>

        <p className="runedit__note">
          Правки хранятся в этом браузере, исходные файлы не меняются. Снять их разом можно в
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
              <span className="runedit__ask">Убрать из штата?</span>
              <button type="button" className="runedit__danger" onClick={onDelete}>
                <Icon name="trash" size={13} />
                Убрать
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
              Убрать из штата
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
