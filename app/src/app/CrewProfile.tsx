import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Select } from '../ds/components/forms/Select.jsx';
import { SegmentedControl } from '../ds/components/forms/SegmentedControl.jsx';
import type { EngineerRecord, OrderRecord, Registry } from '../data/registry.ts';
import type { CrewPatch } from '../data/crew.ts';
import { dec, hhmm, hoursText } from '../data/derive.ts';
import { skillIcon, skillName, teamName, transportIcon, transportName } from '../data/dictionary.ts';
import { transportWhy } from '../data/rationale.ts';
import { faceOf } from '../data/photos.ts';
import { PersonName } from './PersonName.tsx';
import { OrderProfile } from './OrderProfile.tsx';
import { NoteField } from './NoteField.tsx';
import { VisitsDialog } from './VisitsDialog.tsx';
import type { VisitsScope } from './VisitsDialog.tsx';
import { WhyMark } from './WhyMark.tsx';
import { useModalFocus } from './modal.ts';

interface Place {
  zone: string;
  home: string | null;
  from: number;
  to: number;
}

interface Props {
  /** Чей профиль открыт. Пусто — профиля нет. */
  crew: EngineerRecord | null;
  registry: Registry;
  onClose: () => void;
  /** «Отследить»: увести туда, где видно, где человек сейчас и что делает.
      Своего экрана слежения пока нет — ведёт в мониторинг. Строка в ответ —
      следить некуда (расчёта его участка нет), и это объяснение: карточка
      остаётся открытой и показывает его у кнопки. */
  onTrack: (id: string) => string | void;
  /** Участки со своими офисами и рамками дня — из них выбирают при правке
      участка, и они же задают человеку адрес выезда и часы. */
  places: Place[];
  onSave: (patch: CrewPatch) => void;
  onDelete: () => void;
  /** Почему карточку править нельзя. Задано — кнопки «Править» нет, а на
      её месте стоит эта причина словами. */
  locked?: string | null;
  /** Уйти в расчёт заявки, открытой отсюда, и показать её на карте: те же
      две дороги, что ведут из базы заявок. */
  onOpenRun: (id: string) => void;
  onOpenMap: (id: string, orderId?: string) => void;
}

/* Профиль инженера: всё, что мы о нём знаем, на одном экране — и то же окно,
   в котором это правят.

   Карточка в списке отвечает на «кто это и сколько отработал» — её читают
   бегло, десятками. Профиль отвечает на «расскажи про него»: постоянные
   данные, выработка, каждая смена по расчётам, каждый маршрут и каждая
   заявка, которую он вёз.

   Правка не открывает поверх второе окно. Диспетчер уже смотрит на этого
   человека — отдельный диалог с теми же полями заставлял бы искать те же
   данные во второй раз и закрывать два окна вместо одного. Кнопка «Править»
   переключает часть уже открытого профиля в режим формы: шапка и панель
   данных становятся полями, история снизу на время правки прячется — это
   посчитанные вещи, их не редактируют, и во время правки они только мешают. */
type Tab = 'shifts' | 'routes' | 'orders';

const TRANSPORTS = ['car', 'walk', 'bike', 'transit'];
const SKILLS = ['local', 'connect', 'emergency'];

interface PostDraft {
  /** Название участка, под которым правка ляжет на данные. Не меняется даже
      когда участок сменили: в данных он остался прежним. */
  source: string;
  zone: string;
}

export function CrewProfile({
  crew,
  registry,
  onClose,
  onTrack,
  places,
  onSave,
  onDelete,
  onOpenRun,
  onOpenMap,
  locked = null
}: Props) {
  /* Какая из трёх историй открыта. Сбрасывается на сменах, когда открывают
     другого человека: вкладка, оставшаяся от предыдущего профиля, показала
     бы чужой по смыслу разрез — пришли посмотреть на человека, а открылись
     его заявки. */
  const [tab, setTab] = useState<Tab>('shifts');

  /* Какой отбор визитов сейчас раскрыт поверх профиля. Профиль отвечает
     сводно — «восемь раз чинил линк», — а это окно показывает сами восемь
     раз: что, где и когда. Открывается из четырёх мест, и все четыре кладут
     сюда готовый отбор, а не свои правила. */
  const [visits, setVisits] = useState<VisitsScope | null>(null);

  /* Какая заявка раскрыта поверх. Профиль заявки — то же окно, что и в базе
     заявок: заводить для него второй вид, потому что пришли из другого
     раздела, значило бы держать две карточки одной и той же вещи. */
  const [order, setOrder] = useState<OrderRecord | null>(null);

  /* Правится ли карточка прямо сейчас. */
  const [editing, setEditing] = useState(false);
  const [id, setId] = useState('');
  const [posts, setPosts] = useState<PostDraft[]>([]);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [transport, setTransport] = useState('car');
  const [skills, setSkills] = useState<string[]>([]);
  const [confirming, setConfirming] = useState(false);
  /* Почему «Отследить» никуда не увело — словами у кнопки, а не молча. */
  const [trackMiss, setTrackMiss] = useState<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(crew !== null, card);

  useEffect(() => {
    if (crew) setTab('shifts');
    setEditing(false);
    setConfirming(false);
    setTrackMiss(null);
    /* Открыли другого человека — чужой отбор визитов закрывается: он про
       предыдущего, и остаться поверх нового профиля не может. */
    setVisits(null);
    setOrder(null);
  }, [crew?.id]);

  /* Поля формы наполняются заново при каждом входе в правку: то, что
     осталось от предыдущего открытия, — чужие данные, а не черновик. */
  const startEdit = () => {
    if (!crew) return;
    setName(crew.name);
    setPhone(crew.phone ?? '');
    setTransport(crew.transport ?? 'car');
    setSkills([...crew.skills]);
    setId(crew.id);
    setPosts(crew.posts.map((post) => ({ source: post.zone, zone: post.zone })));
    setConfirming(false);
    setEditing(true);
  };

  useEffect(() => {
    if (!crew) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      /* Пока поверх профиля раскрыто окно — визиты или карточка заявки, —
         Escape принадлежит ему: оно само себя и закроет. Профиль в этот
         момент молчит, иначе одно нажатие схлопывало бы сразу два слоя, и
         диспетчер, закрывая заявку, терял бы человека, из которого в неё
         пришёл. */
      if (visits || order) return;
      /* Escape в форме отменяет правку, а не закрывает профиль целиком:
         обе команды на одной клавише читались бы как одна, и случайный Esc
         во время редактирования выкидывал бы из карточки, а не из формы. */
      if (editing) setEditing(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [crew, editing, onClose, visits, order]);

  const routes = useMemo(
    () => (crew ? registry.routes.filter((route) => route.engineerKey === crew.id) : []),
    [crew, registry]
  );

  const orders = useMemo(
    () => (crew ? registry.orders.filter((order) => order.engineerKey === crew.id) : []),
    [crew, registry]
  );

  /* Что он делал чаще всего: виды работ по числу заявок. Отвечает на вопрос,
     на котором список навыков останавливается, — навык говорит «умеет», а
     это говорит «делает». */
  const byWork = useMemo(() => {
    /* Ключом — код вида работ, а не подпись: по нему отбирают заявки для
       окна визитов, и подписи двух разных кодов могут совпасть. */
    const map = new Map<string, { title: string; count: number }>();
    for (const order of orders) {
      const cell = map.get(order.workType) ?? { title: order.workTitle, count: 0 };
      cell.count += 1;
      map.set(order.workType, cell);
    }
    return [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  }, [orders]);

  /* Табельные, уже занятые другими: новый номер не должен свести двух
     человек в одного. */
  const taken = useMemo(
    () => (crew ? registry.engineers.filter((one) => one.id !== crew.id).map((one) => one.id) : []),
    [crew, registry]
  );

  if (!crew) return null;

  const worked = crew.workMinutes + crew.travelMinutes;
  const shifts = [...crew.byRun].reverse();

  const patchPost = (index: number, patch: Partial<PostDraft>) =>
    setPosts((was) => was.map((one, at) => (at === index ? { ...one, ...patch } : one)));

  const toggleSkill = (key: string) =>
    setSkills((was) => (was.includes(key) ? was.filter((one) => one !== key) : [...was, key]));

  /* Человек без имени, без номера и без единого навыка — не запись, а дыра в
     справочнике: по имени его находят, по номеру сводят между расчётами, по
     навыку он получает работу. Номер, занятый другим, свёл бы двух людей в
     одного. */
  const trimmedId = id.trim();
  const idBusy = trimmedId !== crew.id && taken.includes(trimmedId);
  const valid = name.trim().length > 0 && trimmedId.length > 0 && !idBusy && skills.length > 0;

  /* Строки трёх таблиц открываются и с клавиатуры: Tab доводит до строки,
     Enter или пробел открывают — как кнопку. Отборы визитов собраны здесь,
     а не в разметке, чтобы щелчок и клавиша вели в одно и то же место. */
  const onRowKey = (event: ReactKeyboardEvent, open: () => void) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    open();
  };
  const openShift = (shift: (typeof shifts)[number]) =>
    setVisits({
      title: `Смена в расчёте ${shift.code}`,
      lede: `${crew.name} — что делал в этом расчёте`,
      orders: orders.filter((order) => order.run.id === shift.runId)
    });
  const openRoute = (route: (typeof routes)[number]) =>
    setVisits({
      title: `Маршрут ${route.code}`,
      lede: `${crew.name}, расчёт ${route.run.code} — заявки по порядку объезда`,
      orders: orders.filter((order) => order.run.id === route.run.id && order.seq !== null)
    });

  const save = () => {
    if (!valid) return;
    onSave({
      id: trimmedId,
      name: name.trim(),
      phone: phone.trim() || null,
      transport,
      skills,
      /* Участок задаёт и офис, и часы: выбрали другой — человек выезжает
         оттуда и работает в его рамках. Руками часы не правятся, иначе в
         карточке стояла бы смена, которой участок не знает.

         Но только если участок действительно сменили. Раньше границы
         участка подставлялись всегда — и правка телефона удлиняла смену
         человека на три часа: у участка день с 07:00 до 22:00, а у него
         своя смена короче. Участок тот же — смена остаётся его
         собственной, как стоит в данных. */
      posts: Object.fromEntries(
        posts.map((post) => {
          const moved = post.zone !== post.source;
          const place = moved ? places.find((one) => one.zone === post.zone) : undefined;
          const was = crew.posts.find((one) => one.zone === post.source);
          return [
            post.source,
            {
              zone: post.zone,
              home_address: place ? place.home : (was?.homeAddress ?? null),
              shift_start: place ? place.from : (was?.shiftStart ?? crew.shiftStart),
              shift_end: place ? place.to : (was?.shiftEnd ?? crew.shiftEnd)
            }
          ];
        })
      )
    });
    setEditing(false);
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={`Профиль: ${crew.name}`}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card crewpro" ref={card}>
        {/* Фото — портретом слева, во весь рост шапки: лицо здесь не значок
            для узнавания в ряду, а то, ради чего открыли профиль. Имя, цифры
            и действия стоят справа, вровень с фотографией по высоте. Само
            фото правке не подлежит — лицо не текстовое поле, — поэтому
            остаётся на месте и в режиме формы. */}
        <div className="crewpro__hero">
          <img className="crewpro__face" src={faceOf(crew)} alt="" />

          <div className="crewpro__hero-body">
            {editing && (
              /* Крестик остаётся на месте и в форме: без него закрыть профиль
                 можно было бы только щелчком по тёмному полю за карточкой —
                 не то место, где его ищут. Ведёт из формы тем же путём, что
                 и Esc: сначала отменяет правку, а не рвёт профиль сразу. */
              <div className="crewpro__editbar">
                <span className="crewpro__editbar-title">Правка карточки</span>
                <button
                  type="button"
                  className="rpanel__x"
                  onClick={() => setEditing(false)}
                  aria-label="Отменить правку"
                >
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}

            {editing ? (
              <div className="runedit__pair">
                <label className="runedit__field">
                  <span className="runedit__label">Фамилия, имя и отчество</span>
                  <input
                    className="runedit__input"
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    placeholder="Иванов Иван Иванович"
                    autoFocus
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
            ) : (
              <div className="crewpro__top">
                <div className="crewpro__who">
                  {/* Табельный номер — первым и крупно: в базе им человека
                      находят и им же его называют между собой, а не именем.
                      Должность рядом отвечает на «кто он» тому, кто открыл
                      профиль впервые и табельных ещё не читает. */}
                  <div className="crewpro__idrow">
                    <span className="crewpro__id">{crew.code}</span>
                    <span className="crewpro__role">
                      Инженер
                      {/* У программы расчёта номер повторяется на каждом
                          участке — без участка карточки не различить. */}
                      {crew.id.includes(':') && (crew.zone ?? crew.posts[0]?.zone)
                        ? ` · участок ${crew.zone ?? crew.posts[0]?.zone}`
                        : ''}
                      {crew.team ? ` · бригада ${teamName(crew.team)}` : ''}
                    </span>
                  </div>
                  <h2 className="crewpro__name">
                    <PersonName name={crew.name} />
                  </h2>
                  {crew.phone && <span className="crewpro__phone">{crew.phone}</span>}
                  {/* Причина — словами на месте кнопки, а не подсказкой при
                      наведении: пропавшая «Править» без объяснения читается
                      как поломка, а подсказку никто не наводит. */}
                  {locked && (
                    <p className="crewpro__locked">
                      <Icon name="info" size={14} />
                      <span>{locked}</span>
                    </p>
                  )}
                  {/* «Отследить» не увело: человек с другого участка, а
                      расчёта его участка нет. Объяснение — там же, где и
                      причина закрытой правки. */}
                  {trackMiss && (
                    <p className="crewpro__locked" role="status">
                      <Icon name="info" size={14} />
                      <span>{trackMiss}</span>
                    </p>
                  )}
                </div>
                <div className="crewpro__actions">
                  {/* Куда он сейчас едет и что делает — свой экран слежения
                      пока не собран, поэтому ведёт в мониторинг: он и
                      отвечает на этот вопрос по открытому сегодня расчёту. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      const miss = onTrack(crew.id);
                      setTrackMiss(typeof miss === 'string' ? miss : null);
                    }}
                    iconLeft={<Icon name="navigation-arrow" size={13} />}
                  >
                    Отследить
                  </Button>
                  {!locked && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={startEdit}
                      iconLeft={<Icon name="pencil" size={13} />}
                    >
                      Править
                    </Button>
                  )}
                  <span className="modal__esc">
                    <kbd>Esc</kbd> — закрыть
                  </span>
                  <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
                    <Icon name="x" size={16} />
                  </button>
                </div>
              </div>
            )}

            {editing ? (
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
            ) : (
              /* Транспорт — в шапке, сразу под телефоном: это не справочное
                 поле в ряду с навыками, а часть ответа на «кто приедет» —
                 читается вместе с именем и телефоном, а не в общем списке
                 данных ниже. */
              crew.transport && (
                <span className="crewpro__transport">
                  <span className="crewpro__transport-label">Транспорт</span>
                  <Icon name={transportIcon(crew.transport)} size={15} />
                  {transportName(crew.transport)}
                  <WhyMark text={transportWhy(crew.transport)} />
                </span>
              )
            )}

            {!editing && (
              /* Выработка. Первым — отработанные часы: это то, чем меряют
                 человека, а не маршрут. Считанные цифры при правке не
                 показываем — их всё равно не трогают, а место нужно форме. */
              <div className="crewpro__stats">
                <Stat value={dec(worked / 60)} unit="ч" label="отработано всего" />
                <Stat value={String(crew.visits)} label="заявок" />
                <Stat value={`${crew.routes} из ${crew.runs}`} label="смен с маршрутом" />
                <Stat value={`${dec(crew.occupancyMean * 100)} %`} label="средняя занятость" />
                <Stat value={hoursText(crew.travelMinutes)} label="в дороге" />
                <Stat
                  value={crew.distanceKm !== null ? dec(crew.distanceKm) : '—'}
                  unit={crew.distanceKm !== null ? 'км' : undefined}
                  label="пробег"
                />
                <Stat
                  value={crew.overtimeMinutes > 0 ? hoursText(crew.overtimeMinutes) : '—'}
                  label="сверх смены"
                  bad={crew.overtimeMinutes > 0}
                />
              </div>
            )}
          </div>
        </div>

        {editing ? (
          /* Панель данных превращается в форму: те же вопросы — навыки,
             участки, — но полями вместо готового текста. */
          <section className="crewpro__block">
            <h3 className="crewpro__title">Участки и навыки</h3>

            {posts.map((post, index) => {
              const place = places.find((one) => one.zone === post.zone);
              return (
                <div className="runedit__post" key={post.source}>
                  <label className="runedit__field">
                    <span className="runedit__label">
                      {posts.length > 1 ? `Участок ${index + 1}` : 'Участок'}
                    </span>
                    <Select
                      size="sm"
                      value={post.zone}
                      options={places.map((one) => ({ value: one.zone, label: one.zone }))}
                      onChange={(event) => patchPost(index, { zone: event.currentTarget.value })}
                    />
                  </label>

                  {/* Офис и часы участок задаёт сам: они не свойства
                      человека, а свойства места. Руками их здесь не
                      правят — иначе в карточке стояла бы смена, которой
                      участок не знает. */}
                  <div className="runedit__derived">
                    <span className="runedit__derived-row">
                      <span className="runedit__derived-key">Выезд</span>
                      <span>{place?.home ?? 'адрес не указан'}</span>
                    </span>
                    <span className="runedit__derived-row">
                      <span className="runedit__derived-key">Часы работы</span>
                      <span>{place ? `${hhmm(place.from)}–${hhmm(place.to)}` : '—'}</span>
                    </span>
                  </div>
                </div>
              );
            })}

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
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
                Отмена
              </Button>

              <span className="runedit__spacer" />

              {confirming ? (
                <>
                  <span className="runedit__ask">Удалить из базы?</span>
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
          </section>
        ) : (
          <>
            {/* Постоянные данные — одной панелью, а не четырьмя блоками
                подряд. Навыки, транспорт, участки и привычные работы
                отвечают на один вопрос — «кто он и что может», — и читают их
                вместе, одним взглядом. */}
            <section className="crewpro__block">
              <h3 className="crewpro__title">Данные инженера</h3>

              <div className="crewpro__grid">
                <div className="crewpro__cell">
                  <span className="crewpro__label">Навыки</span>
                  <div className="skillrow">
                    {crew.skills.map((key) => (
                      <span key={key} className="skillchip">
                        <Icon name={skillIcon(key)} size={13} />
                        {skillName(key)}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="crewpro__cell">
                  <span className="crewpro__label">
                    {crew.posts.length > 1 ? 'Участки' : 'Участок'}
                    {crew.posts.length > 1 && (
                      <span className="crewpro__count">{crew.posts.length}</span>
                    )}
                  </span>
                  <div className="crewpro__posts">
                    {crew.posts.map((post) => (
                      <div className="crewpro__post" key={post.zone}>
                        <span className="crewpro__post-zone">{post.zone}</span>
                        <span className="crewpro__post-line">
                          Смена {hhmm(post.shiftStart)}–{hhmm(post.shiftEnd)}
                        </span>
                        {post.homeAddress && (
                          <span className="crewpro__post-line crewpro__muted">
                            Выезд: {post.homeAddress}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="crewpro__cell crewpro__cell--wide">
                  <span className="crewpro__label">Заметка</span>
                  {/* Всё в этой панели пришло из выгрузки и расчёта. Заметка —
                      единственное, что знает только диспетчер: «не берёт
                      вечерние», «звонить на личный». */}
                  <NoteField kind="engineer" id={crew.id} placeholder="Добавить заметку об инженере" />
                </div>

                {byWork.length > 0 && (
                  <div className="crewpro__cell crewpro__cell--wide">
                    <span className="crewpro__label">Выполнил</span>
                    {/* Чип — кнопка: число на нём отвечает «сколько раз», а
                        нажатие — «что это были за разы». Раньше число было
                        тупиком: восемь раз чинил линк, а где и когда — иди
                        ищи в трёх таблицах ниже. */}
                    <div className="crewpro__works">
                      {byWork.slice(0, 8).map(([type, work]) => (
                        <button
                          type="button"
                          className="crewpro__work crewpro__work--open"
                          key={type}
                          onClick={() =>
                            setVisits({
                              title: work.title,
                              lede: `${crew.name} — что делал по этому виду работ`,
                              orders: orders.filter((order) => order.workType === type)
                            })
                          }
                        >
                          <span className="crewpro__work-title">{work.title}</span>
                          <span className="crewpro__work-count">{work.count}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* История — тремя вкладками, а не тремя таблицами подряд. При
                правке её нет вовсе: это посчитанные вещи, их не редактируют,
                а место в форме нужнее полям. */}
            <section className="crewpro__block">
              <div className="crewpro__tabs">
                <SegmentedControl
                  size="sm"
                  value={tab}
                  onChange={(value: string) => setTab(value as Tab)}
                  items={[
                    { value: 'shifts', label: `Смены · ${shifts.length}` },
                    { value: 'routes', label: `Маршруты · ${routes.length}` },
                    { value: 'orders', label: `Заявки · ${orders.length}` }
                  ]}
                />
              </div>

              {tab === 'shifts' &&
                (shifts.length === 0 ? (
                  <p className="crewpro__muted">Ни в одном расчёте он ещё не участвовал.</p>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Расчёт</th>
                          <th>Заявок</th>
                          <th>В работе</th>
                          <th>В дороге</th>
                          <th>Пробег</th>
                          <th>Занятость</th>
                          <th>Сверх смены</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shifts.map((shift) => (
                          <tr
                            className="tbl__row"
                            key={shift.runId}
                            title={`Заявки в расчёте ${shift.code}`}
                            tabIndex={0}
                            role="button"
                            onClick={() => openShift(shift)}
                            onKeyDown={(event) => onRowKey(event, () => openShift(shift))}
                          >
                            <td>
                              <span className="tbl__strong">{shift.code}</span>
                            </td>
                            <td className="tbl__num">
                              {shift.routed ? (
                                shift.visits
                              ) : (
                                <span className="tbl__muted">без маршрута</span>
                              )}
                            </td>
                            <td className="tbl__num">{hoursText(shift.workMinutes)}</td>
                            <td className="tbl__num">{hoursText(shift.travelMinutes)}</td>
                            <td className="tbl__num">
                              {shift.distanceKm !== null ? `${dec(shift.distanceKm)} км` : '—'}
                            </td>
                            <td className="tbl__num">{dec(shift.occupancy * 100)} %</td>
                            <td className="tbl__num">
                              {shift.overtimeMinutes > 0 ? (
                                <span className="tbl__warn">{hoursText(shift.overtimeMinutes)}</span>
                              ) : (
                                <span className="tbl__muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

              {tab === 'routes' &&
                (routes.length === 0 ? (
                  <p className="crewpro__muted">Маршрутов пока нет.</p>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Маршрут</th>
                          <th>Расчёт</th>
                          <th>Заявок</th>
                          <th>Начало</th>
                          <th>Конец</th>
                          <th>Районы</th>
                          <th>Под угрозой</th>
                        </tr>
                      </thead>
                      <tbody>
                        {routes.map((route) => (
                          <tr
                            className="tbl__row"
                            key={route.key}
                            title={`Заявки маршрута ${route.code}`}
                            tabIndex={0}
                            role="button"
                            onClick={() => openRoute(route)}
                            onKeyDown={(event) => onRowKey(event, () => openRoute(route))}
                          >
                            <td>
                              <span className="tbl__strong">{route.code}</span>
                            </td>
                            <td>{route.run.code}</td>
                            <td className="tbl__num">{route.visits}</td>
                            <td className="tbl__num">{hhmm(route.start)}</td>
                            <td className="tbl__num">{hhmm(route.end)}</td>
                            <td>{route.districts.join(', ')}</td>
                            <td className="tbl__num">
                              {route.risky > 0 ? (
                                <span className="tbl__warn">{route.risky}</span>
                              ) : (
                                <span className="tbl__muted">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}

              {tab === 'orders' &&
                (orders.length === 0 ? (
                  <p className="crewpro__muted">Заявок за ним пока не числится.</p>
                ) : (
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Заявка</th>
                          <th>Что делаем</th>
                          <th>Адрес</th>
                          <th>Окно приёма</th>
                          <th>Работа</th>
                          <th>Расчёт</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((order) => (
                          <tr
                            className="tbl__row"
                            key={order.key}
                            title={`Карточка заявки ${order.id}`}
                            tabIndex={0}
                            role="button"
                            onClick={() => setOrder(order)}
                            onKeyDown={(event) => onRowKey(event, () => setOrder(order))}
                          >
                            <td>
                              <span className="tbl__strong">{order.id}</span>
                            </td>
                            <td>{order.workTitle}</td>
                            <td>{order.address}</td>
                            <td className="tbl__num">
                              {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                            </td>
                            <td className="tbl__num">{order.estMinutes} мин</td>
                            <td>{order.run.code}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
            </section>
          </>
        )}
      </div>

      {/* Оба окна стоят поверх профиля, а не вместо него: диспетчер разворачивал
          карточку человека и провалился на шаг глубже — закрыв визит, он обязан
          вернуться туда, откуда пришёл, а не на пустой экран базы. */}
      <VisitsDialog
        scope={visits}
        onClose={() => setVisits(null)}
        onOpenOrder={(picked) => {
          setVisits(null);
          setOrder(picked);
        }}
      />

      <OrderProfile
        order={order}
        registry={registry}
        onClose={() => setOrder(null)}
        onOpenRun={(id) => {
          setOrder(null);
          onOpenRun(id);
        }}
        onOpenMap={(id, orderId) => {
          setOrder(null);
          onOpenMap(id, orderId);
        }}
      />
    </div>
  );
}

function Stat({
  value,
  unit,
  label,
  bad = false
}: {
  value: string;
  unit?: string;
  label: string;
  bad?: boolean;
}) {
  return (
    <div className={'crewpro__stat' + (bad ? ' crewpro__stat--bad' : '')}>
      <span className="crewpro__stat-value">
        {value}
        {unit && <span className="crewpro__stat-unit">{unit}</span>}
      </span>
      <span className="crewpro__stat-label">{label}</span>
    </div>
  );
}

/** Почему штат не правится при живой программе расчёта. Бригаду она берёт
    из своей выгрузки, ручки для правки штата у неё нет, а правка в браузере
    ложилась только на файлы вёрстки: «сохранено» — и ни план, ни база не
    менялись. Один текст на все двери в карточку. */
export const CREW_ENGINE_LOCK =
  'Только просмотр: бригаду задаёт программа расчёта по выгрузке заказчика, ' +
  'и правка здесь не попала бы в её планы.';
