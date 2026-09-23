import { Icon } from '../ds/components/core/Icon.jsx';

interface Props {
  onDemo: () => void;
  onNormal: () => void;
}

/* Приветствие на входе — развилка, а не онбординг: сервис ещё строится, и на
   каждый заход нужно заново решить, показываем мы его кому-то или работаем
   в нём сами. Поэтому экран не запоминает выбор и встречает заново каждый
   раз, а не один раз при первом знакомстве. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'Доброе утро';
  if (h >= 12 && h < 18) return 'Добрый день';
  if (h >= 18 && h < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

export function WelcomeGate({ onDemo, onNormal }: Props) {
  return (
    <div className="gate" role="dialog" aria-label="Выбор режима">
      <div className="gate__card">
        <span className="gate__eyebrow">{greeting()}</span>
        <h1 className="gate__title">PROJECT POLET</h1>
        <p className="gate__lede">Как продолжим?</p>

        <div className="gate__options">
          <button type="button" className="gate__option" onClick={onDemo}>
            <span className="gate__option-icon">
              <Icon name="navigation-arrow" size={20} />
            </span>
            <span className="gate__option-body">
              <span className="gate__option-title">Демо-режим</span>
              <span className="gate__option-what">
                Показанный маршрут на пять шагов: расчёт, карта, объяснение назначения, авария,
                сравнение с базовым вариантом. Подходит для знакомства с сервисом и обучения работе
                в нём.
              </span>
            </span>
            <Icon name="arrow-right" size={16} />
          </button>

          <button type="button" className="gate__option gate__option--accent" onClick={onNormal}>
            <span className="gate__option-icon">
              <Icon name="gauge" size={20} />
            </span>
            <span className="gate__option-body">
              <span className="gate__option-title">Обычный режим</span>
              <span className="gate__option-what">
                Настоящий сервис: свои расчёты, свои данные. Нужен, пока мы сами работаем над
                проектом, — без подсказок и без демонстрационного сценария.
              </span>
            </span>
            <Icon name="arrow-right" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
