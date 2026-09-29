import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';

interface Step {
  title: string;
  what: string;
  /** Рабочая область шага: то, о чём на этом шаге речь. Она остаётся
      освещённой целиком, а всё вокруг гаснет. Не задана — светится главное
      поле оболочки: боковое меню при этом тонет, и правильно. */
  area?: () => HTMLElement | null;
  /** Приводит экран к виду этого шага: срабатывает, как только шаг стал
      текущим. Обычно повторяет то, что уже сделало нажатие подсвеченной
      кнопки, — и потому держит показ в строю, даже если по дороге нажали
      что-то своё. */
  go?: () => void;
  /** Кнопка на рабочем экране, которую просят нажать. Она и подсвечивается;
      «Дальше» в карточке нажимает её же, а не перескакивает мимо. */
  find?: () => HTMLElement | null;
  /** Шагу нужно окно правки открытым. На всех прочих шагах оно закрывается
      само: окно живёт поверх всего экрана, и, оставшись открытым, оно
      переезжает вместе с показом в базы и настройки, где ему нечего
      делать. Возврат «Назад» этим же и лечится — шаг сам приводит экран к
      своему виду, а не надеется на то, каким его оставил соседний. */
  dialog?: boolean;
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
  /** Закрыть окно правки вместе с показанным в нём пересчётом. */
  closeIncident: () => void;
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

/** Рабочее поле оболочки — всё, кроме бокового меню и шапки. Область по
    умолчанию: почти на каждом шаге речь именно о нём. */
const mainArea = one('.shell__main');

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
  openIncident,
  closeIncident
}: Props) {
  const [step, setStep] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const [away, setAway] = useState<'up' | 'down' | null>(null);
  const [side, setSide] = useState<'right' | 'left'>('right');
  const cardRef = useRef<HTMLDivElement>(null);

  const steps: Step[] = [
    {
      title: 'Главная: что где лежит',
      what: 'Сервис встречает сводкой: сверху открытый расчёт и его числа, ниже «прямо сейчас» — кто на объекте, кто в пути, кто опаздывает, дальше последние расчёты и базы данных. Отсюда день и начинается: нажмите «Диспетчерская».',
      go: goHome,
      /* Кнопка ищется по слову, а не по классу: ряд действий на Главной
         переписывали, и класс у кнопки сменился, а показ молча остался без
         цели — светилась область, а нажимать было нечего. Слово в подписи
         переживает переделку вида. */
      find: byText('Диспетчерская', '.home__actions')
    },
    {
      title: 'Диспетчерская: создать или взять готовый расчёт',
      what: 'Диспетчерская встречает одним действием, а посчитанное раньше лежит списком под ним. Посчитаем свой день — нажмите «Создать новый расчёт».',
      go: goDispatch,
      find: one('.gatehero__cta')
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
      what: 'Здесь день правят: отмечают, что случилось — передали другому, выехал, выполнена, сорвалась, инженер задержится или выбыл, — и отсюда же пересобирают остаток смены. Раздел ведёт рабочий день: пока мониторинг сегодня не открывали, отмечать нечего, и он так и говорит. Само окно правки посмотрим следующим шагом.',
      go: goControl,
      /* Кнопка ищется по слову, и её может не быть вовсе: раздел ведёт
         рабочий день, а в показе его не заводят — тогда экран пуст, и
         показ идёт дальше сам. Искать по разметке тут нельзя: раздел
         переделывали, и прежние карточки событий с кнопкой «Пересчитать
         от…» сменились списком причин внутри самого окна правки. */
      find: byText('Пересчитать остаток дня')
    },
    {
      title: 'Пересчёт остатка дня',
      what: 'Окно правки открыто на «Аварии»: когда случилось, сколько их и на чьём участке. Нажмите «Пересчитать» — программа пересоберёт остаток смены, не трогая уже сделанное.',
      go: openIncident,
      dialog: true,
      area: one('.incident__card'),
      find: byText('Пересчитать', '.incident__card')
    },
    {
      title: 'Что дал пересчёт',
      what: 'Сколько заявок выиграли против «поехали как ехали», кого не тронули, как изменились исполнители и пробег. Пересчёт живёт только на экране, пока его не приняли. Оставим день таким, каким посчитали, — нажмите «Отменить правку».',
      dialog: true,
      area: one('.incident__card'),
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

  /* Переход на шаг — один раз при входе в него, не при каждой перерисовке.

     Шаг приводит экран к своему виду целиком: не только уводит в нужный
     раздел, но и закрывает окно правки, если оно этому шагу не нужно.
     Прежде окно закрывал только тот, кто его открыл, и стоило уйти с
     пересчёта вперёд или вернуться «Назад», как оно оставалось висеть
     поверх баз, настроек и последнего слова показа. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    if (!current.dialog) closeIncident();
    current.go?.();
  }, [open, step]);

  /* Нажатие по цели ведёт показ дальше — и это не должно зависеть от
     кадров.

     Прежде слушатель вешался внутри цикла подсветки, а тот живёт на
     requestAnimationFrame. Кадры идут, только пока вкладка на виду: стоит
     показу уехать в фон — свернули окно, открыли соседнюю вкладку, вывели
     на второй экран и смотрят там — и цикл замирает. Цель на экране есть,
     человек по ней нажимает, переход происходит, а показ остаётся на том
     же шаге и дальше не идёт.

     Поэтому цель вооружается своим таймером: пять раз в секунду проверить
     селектор — расход никакой, а показ идёт и в фоне. */
  useEffect(() => {
    if (!open || confirmClose) return;
    let armed: HTMLElement | null = null;
    let off: (() => void) | null = null;
    const arm = () => {
      const el = current.find?.() ?? null;
      if (el === armed) return;
      off?.();
      off = null;
      armed = el;
      if (!el) return;
      const onClick = () => next();
      el.addEventListener('click', onClick, { once: true });
      off = () => el.removeEventListener('click', onClick);
    };
    arm();
    const timer = window.setInterval(arm, 200);
    return () => {
      window.clearInterval(timer);
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, confirmClose, step]);

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

    /* Светятся двое: рабочая область шага и кнопка, которую просят нажать.

       Прежде светилась одна кнопка, а весь экран вокруг тонул в тьме — и
       показ превращался в «нажми сюда, теперь сюда»: что это за экран,
       куда смотреть после нажатия и где вообще происходит дело, оставалось
       за темнотой. Теперь горит вся рабочая область — то, о чём идёт речь,
       — и в ней отдельным ореолом кнопка. Боковое меню при этом гаснет,
       кроме тех шагов, где нажимать надо как раз его пункт: тогда светится
       и пункт.

       Тьма рисуется не одной тенью с разгоном, а прямоугольниками вокруг
       светлых мест: тень умеет вырезать одну дырку, а их две. Куски
       считаются вычитанием — экран минус область минус кнопка, — и потому
       нигде не накладываются друг на друга: наложение читалось бы как
       пятно вдвое темнее.

       Узлы рисуются мимо React, своими руками в <body>: шестьдесят кадров
       в секунду не должны дёргать перерисовку всего показа, а узел,
       отрисованный React, Chrome в этой сборке для таких теней упорно не
       показывает. */
    let raf = 0;
    let shade: SVGSVGElement | null = null;
    let hole: SVGPathElement | null = null;
    let ring: HTMLElement | null = null;
    let pulse: HTMLElement | null = null;
    let printed = '';

    const hide = () => {
      if (printed === '') return;
      printed = '';
      shade?.remove();
      shade = null;
      hole = null;
      ring?.remove();
      pulse?.remove();
      ring = null;
      pulse = null;
    };

    interface Box { x: number; y: number; w: number; h: number }

    const box = (r: DOMRect, pad: number): Box => ({
      x: r.left - pad,
      y: r.top - pad,
      w: r.width + pad * 2,
      h: r.height + pad * 2
    });

    /* Экран минус светлые места — одним путём с дырками.

       Прежде тьма складывалась из четырёх прямоугольников вокруг каждой
       дырки, и дырки выходили прямоугольными: вокруг кнопки-пилюли в
       темноте светился прямоугольник с прямыми углами, а у скруглённого
       окна в углах оставались светлые уголки. Путь с правилом evenodd
       вырезает ровно ту форму, какая у цели: со скруглением её же радиуса. */
    const roundRect = (one: Box, r: number): string => {
      const radius = Math.max(0, Math.min(r, one.w / 2, one.h / 2));
      const x = one.x;
      const y = one.y;
      const w = one.w;
      const h = one.h;
      if (radius <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`;
      return (
        `M${x + radius} ${y}h${w - radius * 2}` +
        `a${radius} ${radius} 0 0 1 ${radius} ${radius}v${h - radius * 2}` +
        `a${radius} ${radius} 0 0 1 ${-radius} ${radius}h${-(w - radius * 2)}` +
        `a${radius} ${radius} 0 0 1 ${-radius} ${-radius}v${-(h - radius * 2)}` +
        `a${radius} ${radius} 0 0 1 ${radius} ${-radius}Z`
      );
    };

    const css = (one: Box, radius = 0) =>
      `position:fixed;top:${Math.round(one.y)}px;left:${Math.round(one.x)}px;` +
      `width:${Math.round(one.w)}px;height:${Math.round(one.h)}px;` +
      (radius > 0 ? `border-radius:${radius}px` : '');

    const draw = (holes: { box: Box; radius: number }[], area: Box | null, aim: Box | null, round: number) => {
      const full: Box = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
      const path =
        roundRect(full, 0) + holes.map((one) => roundRect(one.box, one.radius)).join('');
      const mark =
        path + '#' + (area ? css(area, 12) : '') + '#' + (aim ? css(aim, round + 6) : '');
      if (mark === printed) return;
      printed = mark;

      if (!shade) {
        shade = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        shade.setAttribute('class', 'demo__shade');
        hole = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        hole.setAttribute('fill-rule', 'evenodd');
        /* Цвет задаётся атрибутом, а не только правилом в таблице стилей:
           у `<path>` заливка по умолчанию — непрозрачный чёрный, и стоит
           браузеру взять стили из кэша постарее, как приглушённая тьма
           показа превращается в сплошную черноту с дырками. */
        hole.setAttribute('fill', 'rgba(10, 10, 10, 0.62)');
        shade.append(hole);
        document.body.append(shade);
      }
      shade.setAttribute('viewBox', `0 0 ${full.w} ${full.h}`);
      shade.style.cssText = `position:fixed;top:0;left:0;width:${full.w}px;height:${full.h}px`;
      hole?.setAttribute('d', path);

      if (area) {
        if (!ring) {
          ring = document.createElement('div');
          ring.className = 'demo__area';
          document.body.append(ring);
        }
        ring.style.cssText = css(area, 12);
      } else {
        ring?.remove();
        ring = null;
      }

      if (aim) {
        if (!pulse) {
          pulse = document.createElement('div');
          pulse.className = 'demo__pulse';
          document.body.append(pulse);
        }
        pulse.style.cssText = css(aim, round + 6);
      } else {
        pulse?.remove();
        pulse = null;
      }
    };

    const tick = () => {
      const target = current.find?.() ?? null;
      const region = (current.area ?? mainArea)() ?? null;

      const tr = target?.getBoundingClientRect() ?? null;
      const rr = region?.getBoundingClientRect() ?? null;
      const alive = (r: DOMRect | null) => r !== null && (r.width > 0 || r.height > 0);

      if (!alive(tr) && !alive(rr)) {
        hide();
        setAway(null);
        setSide('right');
      } else {
        const aim = alive(tr) && tr ? box(tr, 6) : null;
        const area = alive(rr) && rr ? box(rr, 4) : null;
        const radius = target ? parseFloat(getComputedStyle(target).borderTopLeftRadius) : 0;
        const round = Number.isFinite(radius) ? radius : 0;
        /* Каждая дырка со своим скруглением: область — как панель под ней,
           цель — как сама кнопка. */
        const holes = [
          area ? { box: area, radius: 12 } : null,
          aim ? { box: aim, radius: round + 6 } : null
        ].filter((one): one is { box: Box; radius: number } => one !== null);
        draw(holes, area, aim, round);

        setAway(
          !tr ? null : tr.top >= window.innerHeight - 8 ? 'down' : tr.bottom <= 8 ? 'up' : null
        );

        /* Карточка не должна закрывать то, на что показывает: и форма
           расчёта, и окно правки кончаются кнопкой в правом нижнем углу —
           ровно там, где стоит она сама. Примеряем оба угла, а не своё
           нынешнее место: сравнение с собой качало бы её между углами. */
        const mine = cardRef.current?.getBoundingClientRect() ?? null;
        if (mine && tr) {
          const gap = 20;
          const top = window.innerHeight - gap - mine.height;
          const covers = (left: number) =>
            tr.left - 12 < left + mine.width && tr.right + 12 > left && tr.bottom + 12 > top;
          setSide(covers(window.innerWidth - gap - mine.width) && !covers(gap) ? 'left' : 'right');
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
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
