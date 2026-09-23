interface Props {
  onDemo: () => void;
  onNormal: () => void;
}

/* Приветствие на входе — развилка, а не онбординг: сервис ещё строится, и на
   каждый заход нужно заново решить, показываем мы его кому-то или работаем
   в нём сами. Поэтому экран не запоминает выбор и встречает заново каждый
   раз, а не один раз при первом знакомстве.

   Экран стоит один, без интерфейса за спиной: пока режим не выбран, сервис
   не открыт — показывать его затемнённым значило бы предлагать выбор поверх
   того, что выбор и определяет. Обе двери выглядят и подсвечиваются
   одинаково: ни одна из них не «правильная», это не рекомендация, а
   развилка. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'Доброе утро';
  if (h >= 12 && h < 18) return 'Добрый день';
  if (h >= 18 && h < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

export function WelcomeGate({ onDemo, onNormal }: Props) {
  return (
    <div className="welcome" role="dialog" aria-label="Выбор режима">
      <div className="welcome__card">
        <span className="welcome__eyebrow">{greeting()}</span>
        <h1 className="welcome__title">PROJECT POLET</h1>
        <p className="welcome__lede">Как продолжим?</p>

        <div className="welcome__options">
          <button type="button" className="welcome__option" onClick={onDemo}>
            <span className="welcome__option-title">Режим демонстрации</span>
            <span className="welcome__option-what">
              Показанный маршрут по всему сервису в рабочем порядке: главная, диспетчерская,
              расчёт дня, четыре вида плана, мониторинг, воздействие с пересчётом, базы и настройки.
              День при этом считается по-настоящему. Подходит для знакомства и обучения.
            </span>
            <span className="welcome__option-go">Начать показ</span>
          </button>

          <button type="button" className="welcome__option" onClick={onNormal}>
            <span className="welcome__option-title">Обычный режим</span>
            <span className="welcome__option-what">
              Настоящий сервис: свои расчёты, свои данные. Нужен, пока мы сами работаем над
              проектом, — без подсказок и без демонстрационного сценария.
            </span>
            <span className="welcome__option-go">Перейти к работе</span>
          </button>
        </div>
      </div>
    </div>
  );
}
