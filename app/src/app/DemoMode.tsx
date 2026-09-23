import { useEffect, useRef, useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';

interface Step {
  title: string;
  what: string;
  /** Переводит экран на этот шаг: срабатывает само, как только шаг
      становится текущим — «Дальше» больше не запускает переход отдельной
      кнопкой «Открыть», сама смена шага и есть переход. */
  go?: () => void;
  /** Настоящая кнопка на экране, куда просят нажать. Пока она не найдена —
      подсветка падает на кнопку «Дальше» самой карточки: подсвечено всегда
      хоть что-то, а не «иногда». Найдена — демо ждёт клика по ней самой и
      после него идёт дальше само, без нажатия «Дальше». */
  find?: () => HTMLElement | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Есть ли открытый расчёт: без него часть шагов вести некуда. */
  hasRun: boolean;
  firstOrderId: string | null;
  goCreate: () => void;
  goOverview: () => void;
  goSummary: () => void;
  openOrder: (id: string) => void;
  openIncident: () => void;
}

const byText = (root: ParentNode, text: string): HTMLElement | null => {
  for (const btn of root.querySelectorAll('button')) {
    if (btn.textContent?.trim().startsWith(text)) return btn as HTMLElement;
  }
  return null;
};

/* Демонстрационный маршрут — не тур по экрану и не автопилот: он не нажимает
   кнопки за диспетчера. Там, где на экране есть настоящая кнопка действия
   («Рассчитать», «Пересчитать»), демо подсвечивает её и ждёт настоящего
   клика — остаток дня по-прежнему пересобирает диспетчер, а не скрипт.
   Там, где шаг — просто «посмотрите на это» (карта, разбор до/после),
   подсветка падает на «Дальше» самой карточки: подсвечено на любом шаге
   что-то одно, без исключений.

   Компактная карточка в углу, не полноэкранный тур: тридцать семь экранов
   и так способны увести защиту от главного, и оверлей на весь экран сделал
   бы то же самое ещё раз. */
export function DemoMode({
  open,
  onOpenChange,
  hasRun,
  firstOrderId,
  goCreate,
  goOverview,
  goSummary,
  openOrder,
  openIncident
}: Props) {
  const [step, setStep] = useState(0);
  const [confirmClose, setConfirmClose] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const steps: Step[] = [
    {
      title: 'Выберите участок и запустите расчёт',
      what: 'Форма нового расчёта уже открыта: выберите участок и нажмите «Рассчитать» — движок посчитает день заново, на глазах.',
      go: goCreate,
      find: () => document.querySelector<HTMLElement>('.createbar__actions .engine__cta')
    },
    {
      title: 'Покажите KPI и карту',
      what: 'Обзор открывается сам: сводка по расчёту сверху, карта маршрутов под ней — куда движок развёл людей.',
      go: goOverview
    },
    {
      title: 'Откройте заявку и объясните назначение',
      what: firstOrderId
        ? 'Карточка заявки уже открыта: кто её везёт и почему — с кандидатами, которых движок перебрал, и причиной у каждого.'
        : 'Расчёт ещё не открыт — вернитесь к первому шагу.',
      go: firstOrderId ? () => openOrder(firstOrderId) : undefined
    },
    {
      title: 'Внесите аварию',
      what: 'Окно правки открыто на «Аварии» — нажмите «Пересчитать». Остаток дня пересоберётся за секунду-две.',
      go: openIncident,
      find: () => byText(document, 'Пересчитать')
    },
    {
      title: 'Покажите «до/после»',
      what: 'Разбор уже на экране: сколько заявок выиграли, кого не тронули, как изменились исполнители и пробег.'
    },
    {
      title: 'Сравните с базовым вариантом',
      what: 'На «Сводке» — блок «Оптимизатор против базового варианта»: тот же день, посчитанный ещё и жадным перебором.',
      go: goSummary
    },
    {
      title: 'Демо окончено',
      what: 'Это и есть пять минут: расчёт, карта, объяснение, авария, до/после, сравнение с базовым вариантом. Приятного пользования!'
    }
  ];

  const current = steps[step];
  const last = step === steps.length - 1;

  const finish = () => {
    onOpenChange(false);
    setStep(0);
    setConfirmClose(false);
  };

  const advance = () => {
    if (last) { finish(); return; }
    setStep((s) => Math.min(steps.length - 1, s + 1));
  };

  /* Переход на шаг — один раз при входе в него, не при каждой перерисовке:
     иначе «Дальше» открывало бы форму заново на каждый чих состояния. */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open) return;
    current.go?.();
  }, [open, step]);

  /* Подсветка следует за целью каждый кадр, а не по событию: цель — часть
     живого экрана (диалог, карточка), и её просто найти в разметке не
     значит найти её на месте — раскладка ещё может доехать после перехода.
     Настоящая цель поймана — вешаем одноразовый клик, который сам ведёт
     демо дальше; нет цели — светим «Дальше» самой карточки. */
  useEffect(() => {
    if (!open) { setRect(null); return; }
    let raf = 0;
    let armed: HTMLElement | null = null;
    let off: (() => void) | null = null;

    const tick = () => {
      const real = current.find?.() ?? null;
      const fallback = cardRef.current?.querySelector<HTMLElement>('.demo__next-btn') ?? null;
      const el = real ?? fallback;
      setRect(el ? el.getBoundingClientRect() : null);
      if (real !== armed) {
        off?.();
        off = null;
        if (real) {
          const onClick = () => advance();
          real.addEventListener('click', onClick, { once: true });
          off = () => real.removeEventListener('click', onClick);
        }
        armed = real;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step]);

  if (!open) {
    return (
      <button type="button" className="demo__toggle" onClick={() => onOpenChange(true)}>
        <Icon name="navigation-arrow" size={14} />
        Режим демонстрации
      </button>
    );
  }

  return (
    <>
      {rect && (
        <div
          className="demo__spot"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12
          }}
        />
      )}

      <div className="demo__card" role="dialog" aria-label="Режим демонстрации" ref={cardRef}>
        <div className="demo__top">
          <span className="demo__eyebrow">
            Демонстрация · шаг {step + 1} из {steps.length}
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

        {confirmClose ? (
          <>
            <p className="demo__title">Точно выйти из демо?</p>
            <p className="demo__what">Шаг сохранится не будет — следующий заход начнётся сначала.</p>
            <div className="demo__actions">
              <Button variant="secondary" size="sm" onClick={() => setConfirmClose(false)}>
                Остаться
              </Button>
              <Button variant="accent" size="sm" onClick={finish}>
                Выйти
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="demo__title">{current.title}</p>
            <p className="demo__what">{current.what}</p>
            <div className="demo__actions">
              {step > 0 && (
                <Button variant="secondary" size="sm" onClick={() => setStep((s) => Math.max(0, s - 1))}>
                  Назад
                </Button>
              )}
              <Button
                className="demo__next-btn"
                variant="accent"
                size="sm"
                onClick={advance}
                iconRight={!last ? <Icon name="arrow-right" size={14} /> : undefined}
              >
                {last ? 'Закрыть режим' : 'Дальше'}
              </Button>
            </div>
            {!hasRun && step > 0 && (
              <p className="demo__note">
                <Icon name="info" size={12} />
                Расчёт ещё не открыт — часть шагов вести некуда, начните с первого.
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
