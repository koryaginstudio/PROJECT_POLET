import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Registry } from '../data/registry.ts';
import { findAll, KIND_ICON, KIND_ORDER, KIND_TITLE } from '../data/find.ts';
import type { Hit } from '../data/find.ts';

interface Props {
  /** Справочники. Пусто, пока не загружены: до этого искать не по чему, и
      поле честно говорит об этом, а не отвечает «ничего не нашлось». */
  registry: Registry | null;
  /** Открыть находку. Что именно открывается, решает оболочка: карточку
      записи, расчёт или карту — у разных родов записей это разное. */
  onOpen: (hit: Hit) => void;
}

/* Поиск по всем базам сразу — единственная строка ввода, которая отвечает на
   любой вопрос диспетчера.

   Раньше здесь искалось только внутри открытого расчёта и только среди
   заявок с инженерами, а на экранах баз данных поиск не отвечал вовсе:
   найденное клалось в правую панель, которой там нет. Теперь он ищет по
   справочникам и сам открывает карточку — из любого раздела, потому что
   карточка рисуется поверх экрана, а не сбоку от него.

   Находки сгруппированы по роду записи: «Заявки», «Клиенты», «Инженеры» и
   дальше. Плоский список из двенадцати строк заставлял бы читать каждую,
   чтобы понять, нашлось ли то, что искали; с заголовками ответ виден до
   чтения — по тому, какие группы вообще появились.

   Рядом с находкой стоит, чем она совпала: «телефон», «адрес», «инженер».
   Без этого строка с чужим на вид названием читается как промах — диспетчер
   набрал номер телефона, а в списке заявка на подключение, и связь между
   ними видна только нам.

   Стрелками список ходит сверху вниз, Enter открывает. Диспетчер держит
   руку на клавиатуре: снимать её ради щелчка по третьей строке — это ровно
   та мелочь, из которой складывается «неудобная программа». */
export function GlobalSearch({ registry, onOpen }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  const hits = useMemo(() => findAll(registry, query), [registry, query]);

  /* Группы в постоянном порядке: список не должен перетасовываться от того,
     что в новом запросе нашлось на одного клиента больше. */
  const groups = useMemo(() => {
    const byKind = new Map<string, Hit[]>();
    for (const hit of hits) {
      const list = byKind.get(hit.kind) ?? [];
      list.push(hit);
      byKind.set(hit.kind, list);
    }
    return KIND_ORDER.filter((kind) => byKind.has(kind)).map((kind) => ({
      kind,
      list: byKind.get(kind) ?? []
    }));
  }, [hits]);

  /* Плоский порядок обхода стрелками — тот же, что на экране: сперва первая
     группа целиком, потом вторая. */
  const flat = useMemo(() => groups.flatMap((group) => group.list), [groups]);

  useEffect(() => setCursor(0), [query]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, []);

  const pick = (hit: Hit) => {
    onOpen(hit);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setCursor((at) => (flat.length === 0 ? 0 : (at + 1) % flat.length));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setCursor((at) => (flat.length === 0 ? 0 : (at - 1 + flat.length) % flat.length));
      return;
    }
    if (event.key === 'Enter' && flat[cursor]) {
      event.preventDefault();
      pick(flat[cursor]);
    }
  };

  const asking = query.trim().length >= 2;
  /* Сквозной номер строки для подсветки: группы рисуются по очереди, а
     счётчик один на весь список. */
  let row = -1;

  return (
    <div className="search" ref={wrap}>
      <span className="search__icon">
        <Icon name="search" size={16} />
      </span>
      <input
        className="search__input"
        type="search"
        value={query}
        placeholder="Телефон, адрес, номер заявки, клиент, инженер, маршрут"
        aria-label="Поиск по всем базам"
        role="combobox"
        aria-expanded={open && asking}
        aria-controls="search-drop"
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />

      {open && asking && (
        <div className="search__drop" id="search-drop" role="listbox">
          {!registry ? (
            <p className="search__empty">Справочники ещё читаются — секунду.</p>
          ) : flat.length === 0 ? (
            <p className="search__empty">
              По запросу «{query.trim()}» ничего нет. Ищется номер заявки, маршрута, расчёта и
              точки, телефон, адрес, название клиента, фамилия инженера и вид работ.
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.kind} className="search__group">
                <p className="search__group-title">
                  <Icon name={KIND_ICON[group.kind]} size={13} />
                  {KIND_TITLE[group.kind]}
                </p>
                {group.list.map((hit) => {
                  row += 1;
                  const at = row;
                  return (
                    <button
                      key={hit.kind + hit.key}
                      type="button"
                      role="option"
                      aria-selected={at === cursor}
                      className={'search__hit' + (at === cursor ? ' search__hit--on' : '')}
                      onMouseEnter={() => setCursor(at)}
                      onClick={() => pick(hit)}
                    >
                      <span className="search__hit-code">{hit.code}</span>
                      <span className="search__hit-body">
                        <span className="search__hit-title">{hit.title}</span>
                        <span className="search__hit-meta">{hit.meta}</span>
                      </span>
                      {hit.why && <span className="search__hit-why">{hit.why}</span>}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
