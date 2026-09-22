import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { humanError } from '../data/errors.ts';

interface Props {
  children: ReactNode;
}

interface State {
  /** Чем упал экран. Пусто — всё в порядке, показываем детей. */
  failure: Error | null;
}

/* Последний рубеж: ошибка в любом экране ловится здесь, а не роняет страницу
   в белое.

   До этого любое исключение при отрисовке — неожиданное поле в данных,
   опечатка в новом экране — оставляло диспетчера перед пустым белым окном
   без единого слова. Пустой экран читается как «программа сломалась
   совсем», и человек лезет перезагружать компьютер. Здесь вместо этого
   сказано, что случилось, и даны две дороги: перезагрузить страницу или
   уйти на дашборд.

   Классовый компонент — не привычка, а требование: ловить ошибки отрисовки
   умеет только он, хуков для этого в React нет.

   «На дашборд» сбрасывает адрес на главную и снимает ошибку: экран, который
   упал, чаще всего упал на конкретном разделе или расчёте, и главная
   открывается заново уже без него. Если упадёт и она — снова окажемся
   здесь, и тогда останется перезагрузка. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failure: null };

  static getDerivedStateFromError(failure: Error): State {
    return { failure };
  }

  componentDidCatch(failure: Error, info: ErrorInfo) {
    /* В консоль — для того, кто будет разбираться; на экране причина стоит
       короткой строкой, и стека там не место. */
    console.error('Экран не открылся', failure, info.componentStack);
  }

  private reload = () => {
    window.location.reload();
  };

  private home = () => {
    window.location.hash = '#/home';
    this.setState({ failure: null });
  };

  render() {
    const { failure } = this.state;
    if (!failure) return this.props.children;

    /* Незнакомая ошибка отрисовки — «Экран не открылся»; знакомая (связь,
       ответ программы расчёта) — своим заголовком. Совет же всегда свой:
       здесь всего две кнопки — перезагрузить и на главную, — и «проверьте,
       что программа запущена» к ним не подходит. Строка исключения уходит
       под «Подробности»: диспетчеру она ничего не говорит. */
    const human = humanError(failure, { title: 'Экран не открылся', hint: '' });
    const hint =
      'Программа наткнулась на ошибку и не смогла нарисовать этот экран. Данные при этом не ' +
      'потеряны: расчёты и правки лежат там же, где лежали. Перезагрузите страницу или вернитесь на главную.';

    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <span className="crash__icon">
            <Icon name="alert-triangle" size={22} />
          </span>
          <h1 className="crash__title">{human.title}</h1>
          <p className="crash__body">{hint}</p>
          {human.detail && (
            <details className="fold">
              <summary className="fold__summary">
                <Icon name="chevron-right" size={13} />
                Подробности
              </summary>
              <div className="fold__body">
                <p className="crash__reason">{human.detail}</p>
              </div>
            </details>
          )}
          <div className="crash__actions">
            <Button variant="primary" size="sm" onClick={this.reload}>
              Перезагрузить страницу
            </Button>
            <Button variant="secondary" size="sm" onClick={this.home} iconLeft={<Icon name="house" size={14} />}>
              На главную
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
