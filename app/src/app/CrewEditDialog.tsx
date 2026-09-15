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
  /** Табельные, уже занятые другими: новый номер не должен свести двух
      человек в одного. */
  taken: string[];
  onSave: (patch: CrewPatch) => void;
  onDelete: () => void;
}

/* Правка карточки инженера.

   Правится всё: табельный номер, имя, телефон, транспорт, состояние, навыки,
   участки с адресами выезда и сменами.

   Смена стоит внутри участка, а не в общем списке полей. Это не оформление:
   график считается по нарядам дня на конкретном участке, и у того, кто
   работает на двух, смены разные — одно поле на человека переписало бы обе.

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

interface PostDraft {
  /** Название участка, под которым правка ляжет на данные. Не меняется даже
      когда участок переименовали: в данных он остался прежним. */
  source: string;
  zone: string;
  home: string;
  from: string;
  to: string;
}

export function CrewEditDialog({ crew, taken, onClose, onSave, onDelete }: Props) {
  const [id, setId] = useState('');
  const [posts, setPosts] = useState<PostDraft[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [transport, setTransport] = useState('car');
  const [status, setStatus] = useState('on_shift');
  const [skills, setSkills] = useState<string[]>([]);
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
    setId(crew.id);
    setPosts(
      crew.posts.map((post) => ({
        source: post.zone,
        zone: post.zone,
        home: post.homeAddress ?? '',
        from: hhmm(post.shiftStart),
        to: hhmm(post.shiftEnd)
      }))
    );
    setConfirming(false);
  }, [crew]);

  useEffect(() => {
    if (!crew) return;
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [crew, onClose]);

  if (!crew) return null;

  const patchPost = (index: number, patch: Partial<PostDraft>) =>
    setPosts((was) => was.map((one, at) => (at === index ? { ...one, ...patch } : one)));

  /* Человек без имени, без номера и без единого навыка — не запись, а дыра в
     справочнике: по имени его находят, по номеру сводят между расчётами, по
     навыку он получает работу. Смена, кончающаяся раньше, чем началась, тоже
     не смена. Номер, занятый другим, свёл бы двух людей в одного. */
  const trimmedId = id.trim();
  const idBusy = trimmedId !== crew.id && taken.includes(trimmedId);
  const shiftsOk = posts.every((post) => {
    const start = toMinutes(post.from);
    const end = toMinutes(post.to);
    return start !== null && end !== null && end > start;
  });
  const valid =
    name.trim().length > 0 && trimmedId.length > 0 && !idBusy && skills.length > 0 && shiftsOk;

  const save = () => {
    if (!valid) return;
    onSave({
      id: trimmedId,
      name: name.trim(),
      phone: phone.trim() || null,
      transport,
      status,
      skills,
      posts: Object.fromEntries(
        posts.map((post) => [
          post.source,
          {
            zone: post.zone.trim() || post.source,
            home_address: post.home.trim() || null,
            shift_start: toMinutes(post.from) as number,
            shift_end: toMinutes(post.to) as number
          }
        ])
      )
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

        <div className="runedit__pair">
          <label className="runedit__field">
            <span className="runedit__label">Фамилия, имя и отчество</span>
            <input
              className="runedit__input"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder="Иванов Иван Иванович"
            />
          </label>

          <label className="runedit__field">
            <span className="runedit__label">Табельный номер</span>
            <input
              className="runedit__input"
              value={id}
              onChange={(event) => setId(event.currentTarget.value.trim())}
              placeholder="E001"
            />
            {idBusy && <span className="runedit__wrong">Такой номер уже занят</span>}
          </label>
        </div>

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

        <label className="runedit__field">
          <span className="runedit__label">Состояние на день</span>
          <Select
            size="sm"
            value={status}
            options={STATUSES.map((key) => ({ value: key, label: STATUS_LABELS[key] }))}
            onChange={(event) => setStatus(event.currentTarget.value)}
          />
        </label>

        {/* Участки со сменами. Смена стоит здесь, а не в общем списке полей,
            потому что она принадлежит участку: график считается по нарядам
            дня, и у того, кто работает на двух участках, смены разные. */}
        {posts.map((post, index) => (
          <div className="runedit__post" key={post.source}>
            <div className="runedit__pair">
              <label className="runedit__field">
                <span className="runedit__label">
                  {posts.length > 1 ? `Участок ${index + 1}` : 'Участок'}
                </span>
                <input
                  className="runedit__input"
                  value={post.zone}
                  onChange={(event) => patchPost(index, { zone: event.currentTarget.value })}
                  placeholder="Восток"
                />
              </label>

              <label className="runedit__field">
                <span className="runedit__label">Адрес выезда</span>
                <input
                  className="runedit__input"
                  value={post.home}
                  onChange={(event) => patchPost(index, { home: event.currentTarget.value })}
                  placeholder="Москва, улица…"
                />
              </label>
            </div>

            <div className="runedit__pair">
              <label className="runedit__field">
                <span className="runedit__label">Смена с</span>
                <input
                  className="runedit__input"
                  type="time"
                  value={post.from}
                  onChange={(event) => patchPost(index, { from: event.currentTarget.value })}
                />
              </label>

              <label className="runedit__field">
                <span className="runedit__label">Смена до</span>
                <input
                  className="runedit__input"
                  type="time"
                  value={post.to}
                  onChange={(event) => patchPost(index, { to: event.currentTarget.value })}
                />
              </label>
            </div>
          </div>
        ))}

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
