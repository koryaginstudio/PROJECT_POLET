import { useState } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { Button } from '../ds/components/core/Button.jsx';

interface Step {
  title: string;
  what: string;
  /** Переводит экран на этот шаг. Не у каждого шага — некоторые просят
      просто нажать кнопку, которая уже на экране (запустить расчёт,
      пересчитать), и переход туда не нужен вовсе. */
  go?: () => void;
}

interface Props {
  /** Есть ли открытый расчёт: без него шаги 3–7 вести некуда. */
  hasRun: boolean;
  /** Первая заявка открытого расчёта — та, что объяснит назначение. `null`
      — расчёта ещё нет. */
  firstOrderId: string | null;
  goCreate: () => void;
  goOverview: () => void;
  goSummary: () => void;
  openOrder: (id: string) => void;
  openIncident: () => void;
}

/* Демонстрационный маршрут — не тур по экрану и не автопилот: он не нажимает
   кнопки за диспетчера и не проматывает шаги сам. Каждый шаг — короткая
   подсказка, что показать и почему, и, где это осмысленно, переход на
   нужный экран одним нажатием. Запуск расчёта и сам пересчёт остаются
   ручными — это как раз то, что и должны увидеть на защите: не подготовленную
   запись, а работающую программу.

   Компактная карточка в углу, не полноэкранный тур: тридцать семь экранов
   и так способны увести защиту от главного, и оверлей на весь экран сделал
   бы то же самое ещё раз. */
export function DemoMode({
  hasRun,
  firstOrderId,
  goCreate,
  goOverview,
  goSummary,
  openOrder,
  openIncident
}: Props) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);

  const steps: Step[] = [
    { title: 'Выберите участок и запустите расчёт', what: 'На форме нового расчёта выберите участок и нажмите «Считать» — движок посчитает день заново, на глазах.', go: goCreate },
    { title: 'Покажите KPI и карту', what: 'Обзор открывается сам: сводка по расчёту сверху, карта маршрутов под ней — куда движок развёл людей.', go: goOverview },
    {
      title: 'Откройте заявку и объясните назначение',
      what: firstOrderId
        ? 'Карточка заявки: кто её везёт и почему — с кандидатами, которых движок перебрал, и причиной у каждого.'
        : 'Расчёт ещё не открыт — вернитесь к шагу 1.',
      go: firstOrderId ? () => openOrder(firstOrderId) : undefined
    },
    { title: 'Внесите аварию', what: 'В «Воздействии» нажмите «Авария» → «Пересчитывать». Остаток дня пересоберётся за секунду-две.', go: openIncident },
    { title: 'Покажите «до/после»', what: 'Окно правки уже открыто на разборе: сколько заявок выиграли, кого не тронули, как изменились исполнители и пробег.' },
    { title: 'Сравните с базовым вариантом', what: 'На «Сводке» — блок «Оптимизатор против базового варианта»: тот же день, посчитанный ещё и жадным перебором.', go: goSummary },
    { title: 'Готово', what: 'Это и есть пять минут: расчёт, карта, объяснение, авария, до/после, сравнение с базовым вариантом. Дальше — вопросы.' }
  ];

  if (!open) {
    return (
      <button type="button" className="demo__toggle" onClick={() => setOpen(true)}>
        <Icon name="navigation-arrow" size={14} />
        Режим демонстрации
      </button>
    );
  }

  const current = steps[step];
  const last = step === steps.length - 1;

  return (
    <div className="demo__card" role="dialog" aria-label="Режим демонстрации">
      <div className="demo__top">
        <span className="demo__eyebrow">
          Демонстрация · шаг {step + 1} из {steps.length}
        </span>
        <button type="button" className="demo__close" onClick={() => setOpen(false)} aria-label="Закрыть режим">
          <Icon name="x" size={14} />
        </button>
      </div>
      <p className="demo__title">{current.title}</p>
      <p className="demo__what">{current.what}</p>
      <div className="demo__actions">
        {step > 0 && (
          <Button variant="secondary" size="sm" onClick={() => setStep((s) => s - 1)}>
            Назад
          </Button>
        )}
        {current.go && (
          <Button variant="secondary" size="sm" onClick={current.go}>
            Открыть
          </Button>
        )}
        {!last ? (
          <Button variant="accent" size="sm" onClick={() => setStep((s) => Math.min(steps.length - 1, s + 1))}>
            Дальше
          </Button>
        ) : (
          <Button variant="accent" size="sm" onClick={() => { setOpen(false); setStep(0); }}>
            Закрыть режим
          </Button>
        )}
      </div>
      {!hasRun && step > 0 && (
        <p className="demo__note">
          <Icon name="info" size={12} />
          Расчёт ещё не открыт — часть шагов вести некуда, начните с первого.
        </p>
      )}
    </div>
  );
}
