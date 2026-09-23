import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';

interface Step {
  title: string;
  what: string;
  /** Приводит экран к виду этого шага: срабатывает, как только шаг стал
      текущим. Обычно повторяет то, что уже сделало нажатие подсвеченной
      кнопки, — и потому держит показ в строю, даже если по дороге нажали
      что-то своё. */
  go?: () => void;
  /** Кнопка на рабочем экране, которую просят нажать. Она и подсвечивается;
      «Дальше» в карточке нажимает её же, а не перескакивает мимо. */
  find?: () => HTMLElement | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Есть ли открытый расчёт: без него часть шагов вести некуда. */
  hasRun: boolean;
  goHome: () => void;
  /* Диспетчерская до расчёта: тот самый вопрос «создать или взять
     готовый», с которого начинается рабочий день. */
  goDispatch: () => void;
  goCreate: () => void;
  goPlan: (view: string) => void;
  goMonitor: () => void;
  goControl: () => void;
  goRuns: () => void;
  goSettings: (mode: string) => void;
  openIncident: () => void;
}

/** Кнопка по началу подписи. `within` сужает поиск до одного окна: на
    экране «Воздействие» кнопки «Пересчитать от 10:00» стоят в карточках
    событий раньше окна правки по разметке, и показ нажимал их вместо
    «Пересчитать» в самом окне. */
const byText = (text: string, within?: string) => (): HTMLElement | null => {
  const root: ParentNode | null = within ? document.querySelector(within) : document;
  if (!root) return null;
  for (const btn of root.querySelectorAll('button')) {
    if (btn.textContent?.trim().startsWith(text)) return btn as HTMLElement;
  }
  return null;
};

/** Пункт бокового меню по названию раздела. */
const navItem = (label: string) => (): HTMLElement | null => {
  for (const btn of document.querySelectorAll<HTMLElement>('.nav__item')) {
    if (btn.querySelector('.nav__label')?.textContent?.trim() === label) return btn;
  }
  return null;
};

/** Вкладка переключателя видов в подшапке. */
const tab = (label: string) => (): HTMLElement | null => {
  for (const btn of document.querySelectorAll<HTMLElement>('.pl-seg__item')) {
    if (btn.textContent?.trim() === label) return btn;
  }
  return null;
};

const one = (selector: string) => () => document.querySelector<HTMLElement>(selector);

/* Демонстрационный маршрут: сервис от входа до пересчёта — главная,
   настройки, расчёт, четыре вида плана, мониторинг и правка по событию.

   Ведёт, но не нажимает за диспетчера. На каждом шаге подсвечена ровно одна
   настоящая кнопка рабочего экрана, и шаг кончается её нажатием: экран
   темнеет весь, кроме неё самой. «Дальше» в карточке — та же кнопка, нажатая
   отсюда, а не перескок на следующий экран мимо неё: иначе показ разошёлся
   бы с тем, что человек повторит потом сам.

   Кнопки самой карточки никогда не подсвечиваются: карточка и так лежит
   поверх всего, и подсвечивать в ней нечего.

   За кнопкой, уехавшей под сгиб, показ не бегает и экран не прокручивает:
   вместо этого внизу появляется стрелка «кнопка ниже». Человек листает сам —
   и сам видит, где она, а не ловит уехавший из-под пальца экран. */
export function DemoMode({
  open,
  onOpenChange,
  hasRun,
  goHome,
  goDispatch,
  goCreate,
  goPlan,
  goMonitor,
  goControl,
  goRuns,
  goSettings,
  openIncident
}: Props) {
  const [step, setStep] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const [away, setAway] = useState<'up' | 'down' | null>(null);
  const [side, setSide] = useState<'right' | 'left'>('right');
  const cardRef = useRef<HTMLDivElement>(null);

  const steps: Step[] = [
    {
      title: 'Главная: что где лежит',
      what: 'Сервис встречает сводкой: сверху открытый расчёт и его числа, ниже «прямо сейчас» — кто на объекте, кто в пути, кто опаздывает, дальше последние расчёты и базы данных. Отсюда день и начинается: нажмите «Открыть диспетчерскую».',
      go: goHome,
      find: one('.home__actions .runcard__go')
    },
    {
      title: 'Диспетчерская: создать или взять готовый',
      what: 'Диспетчерская до расчёта спрашивает одно: считаем новый день или открываем посчитанный раньше. Посчитаем свой — нажмите «Создать расчёт».',
      go: goDispatch,
      find: one('.gate__card--accent')
    },
    {
      title: 'Новый расчёт: вводные',
      what: 'Участок уже выбран, заявки и смены к нему подгружены — сменить участок и правила можно на панелях выше. Нажмите «Рассчитать»: день посчитается по-настоящему, программой расчёта, за несколько секунд — это не показанная заготовка.',
      go: goCreate,
      find: one('.createbar__actions .engine__cta')
    },
    {
      title: 'Обзор: куда программа развела людей',
      what: 'День посчитан. Сверху итоги расчёта, под ними карта маршрутов: у каждого инженера своя нить, у каждой заявки своя точка. Числами тот же день читается на «Сводке» — нажмите её.',
      go: () => goPlan('overview'),
      find: tab('Сводка')
    },
    {
      title: 'Сводка: день числами',
      what: 'Покрытие, загрузка, простой, пробег — и разбор «оптимизатор против базового варианта»: тот же день, посчитанный ещё и жадным перебором, чтобы было с чем сравнивать. Дальше — как день лёг по часам: вкладка «По времени».',
      go: () => goPlan('summary'),
      find: tab('По времени')
    },
    {
      title: 'По времени: смена по часам',
      what: 'Строка на инженера, полоса на заявку: видно, кто чем занят в любой час, где остались пустые окна и на ком день стоит плотнее всех. Дальше — вкладка «Карта».',
      go: () => goPlan('timeline'),
      find: tab('Карта')
    },
    {
      title: 'Карта: маршрут за маршрутом',
      what: 'Тот же план, разобранный по маршрутам: слева карта, справа список визитов выбранного инженера — во сколько и к кому он приедет. Дальше — вкладка «По этапам».',
      go: () => goPlan('map'),
      find: tab('По этапам')
    },
    {
      title: 'По этапам: где каждая заявка',
      what: 'День доской: заявки разложены по стадиям — от назначенной до закрытой, — и переезжают вместе с моментом на ползунке. Теперь посмотрим смену в реальном времени: нажмите «Мониторинг» в меню.',
      go: () => goPlan('kanban'),
      find: navItem('Мониторинг')
    },
    {
      title: 'Мониторинг: смена прямо сейчас',
      what: 'Срез по текущему часу, а не по плану: кто на объекте, кто в пути, кто опаздывает и насколько. Здесь день и расходится с расчётом — а расходится он почти всегда. Что с этим делать — в разделе «Воздействие», нажмите его.',
      go: goMonitor,
      find: navItem('Воздействие')
    },
    {
      title: 'Воздействие: день пошёл не так',
      what: 'Четыре события, каждое со своей ценой дню и своей выгодой от пересчёта: авария, инженер выбыл, инженер задержится, абонент отказался. Возьмём первое — нажмите «Пересчитать от…» в карточке «Авария».',
      go: goControl,
      find: one('.actgrid .actcard .actcard__go')
    },
    {
      title: 'Пересчёт остатка дня',
      what: 'Окно правки открыто на «Аварии»: когда случилось, сколько их и на чьём участке. Нажмите «Пересчитать» — программа пересоберёт остаток смены, не трогая уже сделанное.',
      go: openIncident,
      find: byText('Пересчитать', '.incident__card')
    },
    {
      title: 'Что дал пересчёт',
      what: 'Сколько заявок выиграли против «поехали как ехали», кого не тронули, как изменились исполнители и пробег. Пересчёт живёт только на экране, пока его не приняли. Оставим день таким, каким посчитали, — нажмите «Отменить правку».',
      find: byText('Отменить правку', '.incident__card')
    },
    {
      title: 'Базы данных: что есть вообще',
      what: 'Шесть баз стоят над расчётом и отвечают на другой вопрос — не «что с этой сменой», а «что у нас есть»: расчёты, заявки, услуги, инженеры, клиенты, маршруты. Каждую можно смотреть списком, карточками и таблицей. Последним посмотрим, чем всё это настроено, — нажмите «Настройки» внизу меню.',
      go: goRuns,
      find: navItem('Настройки')
    },
    {
      title: 'Настройки: правила расчёта',
      what: 'Здесь задаётся, с чего открывается форма нового расчёта: как держаться за уже назначенных исполнителей, сколько времени закладывать на работу и зазор между заявками, насколько ровно делить нагрузку. Дальше — вкладка «Сервис».',
      go: () => goSettings('rules'),
      find: tab('Сервис')
    },
    {
      title: 'Настройки: сервис',
      what: 'Границы смены и пороги, по которым интерфейс называет число проблемой. Расчёт от них не меняется ни на заявку — меняется то, что мы считаем нормой. Отсюда же этот показ запускается заново. Дальше — вкладка «Данные».',
      go: () => goSettings('service'),
      find: tab('Данные')
    },
    {
      title: 'Настройки: данные',
      what: 'Откуда всё взялось: дни заказчика, схема контракта, сколько расчётов в истории и сколько из них настоящих, запущена ли программа расчёта. Это последний экран показа.',
      go: () => goSettings('data')
    },
    {
      title: 'Показ окончен',
      what: 'Порядок был такой же, как в работе: главная, диспетчерская, расчёт дня, четыре вида плана, мониторинг смены, воздействие с пересчётом, базы и только в конце настройки — сначала как работать, потом как поправить. Пройти показ заново можно когда угодно: «Настройки» → «Сервис» → «Режим демонстрации».'
    }
  ];

  const current = steps[step];
  const last = step === steps.length - 1;

  const finish = () => {
    onOpenChange(false);
    setStep(0);
    setConfirmClose(false);
  };

  /* Просто следующий шаг. Зовётся и с настоящего нажатия подсвеченной
     кнопки, и из «Дальше» — но «Дальше» сперва нажимает саму кнопку. */
  const next = () => {
    if (last) { finish(); return; }
    setStep((s) => Math.min(steps.length - 1, s + 1));
  };

  /* «Дальше» нажимает подсвеченную кнопку, а не обходит её: показ должен
     вести ровно тем путём, которым человек пойдёт сам. Кнопки нет или она
     погашена — идём дальше сами, иначе показ встал бы намертво. */
  const press = () => {
    if (last) { finish(); return; }
    const target = current.find?.() ?? null;
    if (target && !(target as HTMLButtonElement).disabled) {
      target.click();
      return;
    }
    next();
  };

  /* Переход на шаг — один раз при входе в него, не при каждой перерисовке. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    current.go?.();
  }, [open, step]);

  /* Подсветка держится за цель каждый кадр и без переходов: цель ездит со
     скроллом, и любое сглаживание читается как «подсветка отстаёт».
     Настоящее нажатие по цели ведёт показ дальше само.

     Затемнение и ореол рисуются мимо React — своими узлами в <body>,
     которые правит этот же цикл. Причина не в скорости: узел, отрисованный
     React, Chrome в этой сборке упорно не показывает — ни тенью с
     разгоном, ни вырезом пути, ни маской SVG, при полностью совпадающих
     вычисленных стилях; точно такой же узел, созданный руками, рисуется
     всегда. Заодно шестьдесят кадров в секунду перестают дёргать
     перерисовку всего показа. */
  useEffect(() => {
    if (!open || confirmClose) { setAway(null); return; }

    /* Затемнение и ореол рисуются мимо React — своими узлами в <body>,
       которые правит этот же цикл: шестьдесят кадров в секунду не должны
       дёргать перерисовку всего показа. Тьму рисует сам узел тенью с
       большим разгоном: дырка тогда выходит ровно по кнопке и с её же
       скруглением. Ореол — отдельным узлом поверх: в одной тени он лёг бы
       под тьму и пропал. */
    let raf = 0;
    let armed: HTMLElement | null = null;
    let off: (() => void) | null = null;
    let dim: HTMLElement | null = null;
    let pulse: HTMLElement | null = null;
    let printed = '';

    const hide = () => {
      if (printed === '') return;
      printed = '';
      dim?.remove();
      pulse?.remove();
      dim = null;
      pulse = null;
    };

    /* Стиль переписывается, только когда цель и правда поехала: писать те
       же значения каждый кадр — зря гонять растеризацию большой тени. */
    const place = (r: DOMRect, radius: number, pad: number) => {
      const css =
        `position:fixed;top:${r.top - pad}px;left:${r.left - pad}px;` +
        `width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;` +
        `border-radius:${radius + pad}px`;
      if (css === printed) return;
      printed = css;
      if (!dim || !pulse) {
        dim = document.createElement('div');
        dim.className = 'demo__dim';
        pulse = document.createElement('div');
        pulse.className = 'demo__pulse';
        dim.style.cssText = css;
        pulse.style.cssText = css;
        document.body.append(dim, pulse);
        return;
      }
      dim.style.cssText = css;
      pulse.style.cssText = css;
    };

    const tick = () => {
      const el = current.find?.() ?? null;
      const r = el?.getBoundingClientRect() ?? null;
      const live = r !== null && (r.width > 0 || r.height > 0);

      if (!live || !r || !el) {
        hide();
        setAway(null);
        setSide('right');
      } else {
        const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        const round = Number.isFinite(radius) ? radius : 0;
        place(r, round, 6);
        setAway(r.top >= window.innerHeight - 8 ? 'down' : r.bottom <= 8 ? 'up' : null);

        /* Карточка не должна закрывать то, на что показывает: и форма
           расчёта, и окно правки кончаются кнопкой в правом нижнем углу —
           ровно там, где стоит она сама. Примеряем оба угла, а не своё
           нынешнее место: сравнение с собой качало бы её между углами. */
        const mine = cardRef.current?.getBoundingClientRect() ?? null;
        if (mine) {
          const gap = 20;
          const top = window.innerHeight - gap - mine.height;
          const covers = (left: number) =>
            r.left - 12 < left + mine.width && r.right + 12 > left && r.bottom + 12 > top;
          setSide(covers(window.innerWidth - gap - mine.width) && !covers(gap) ? 'left' : 'right');
        }
      }

      if (el !== armed) {
        off?.();
        off = null;
        if (el) {
          const onClick = () => next();
          el.addEventListener('click', onClick, { once: true });
          off = () => el.removeEventListener('click', onClick);
        }
        armed = el;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      off?.();
      hide();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, confirmClose]);

  if (!open) return null;

  /* Показ рисуется прямо в <body>, а не внутри оболочки. Затемнение —
     это тень пятна разгоном в тысячи пикселей, и внутри прокручиваемой
     оболочки Chrome её попросту не рисует: тень уходит за границы
     прокрутки и пропадает целиком. В <body> она ложится как надо. */
  return createPortal(
    <>
      {away && (
        <div className={'demo__away demo__away--' + away}>
          <Icon name={away === 'down' ? 'chevron-down' : 'chevron-up'} size={14} />
          {away === 'down' ? 'Нужная кнопка ниже — пролистайте вниз' : 'Нужная кнопка выше — пролистайте вверх'}
        </div>
      )}

      <div
        className={'demo__card' + (side === 'left' ? ' demo__card--left' : '')}
        role="dialog"
        aria-label="Режим демонстрации"
        ref={cardRef}
      >
        <div className="demo__top">
          <span className="demo__eyebrow">
            {step + 1}/{steps.length}
          </span>
          <button
            type="button"
            className="demo__close"
            onClick={() => setConfirmClose(true)}
            aria-label="Закрыть режим"
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <p className="demo__title">{current.title}</p>
        <p className="demo__what">{current.what}</p>
        <div className="demo__actions">
          {step > 0 && (
            <Button variant="secondary" size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>
              Назад
            </Button>
          )}
          <Button
            variant="accent"
            size="sm"
            onClick={press}
            iconRight={!last ? <Icon name="arrow-right" size={14} /> : undefined}
          >
            {last ? 'Закрыть режим' : 'Дальше'}
          </Button>
        </div>
        {!hasRun && step > 2 && (
          <p className="demo__note">
            <Icon name="info" size={12} />
            Расчёт ещё не открыт — часть шагов вести некуда, вернитесь к шагу с кнопкой «Рассчитать».
          </p>
        )}
      </div>

      {/* Вопрос о выходе — окно по центру экрана, а не подмена текста в
          карточке: выход из показа не шаг маршрута. Единственное, что лежит
          выше самой карточки. */}
      {confirmClose && (
        <div className="demoexit" role="dialog" aria-modal="true" aria-label="Выйти из демонстрации">
          <button
            type="button"
            className="demoexit__veil"
            onClick={() => setConfirmClose(false)}
            aria-label="Остаться в демонстрации"
          />
          <div className="demoexit__card">
            <p className="demoexit__title">Точно выйти из демонстрации?</p>
            <p className="demoexit__what">
              Шаг не сохранится — следующий заход начнётся сначала. Пройти показ заново можно в
              «Настройках» → «Сервис» → «Режим демонстрации».
            </p>
            <div className="demoexit__actions">
              <Button variant="secondary" size="sm" onClick={() => setConfirmClose(false)}>
                Остаться
              </Button>
              <Button variant="accent" size="sm" onClick={finish}>
                Выйти
              </Button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
