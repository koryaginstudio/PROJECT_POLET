import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { SCHEMA } from '../data/contract.ts';
import type { HumanError } from '../data/errors.ts';

interface Props {
  /** Номер расчёта, который не открылся. */
  runCode: string;
  /** Чем кончилась загрузка — уже словами человека (`humanError`). */
  failure: HumanError;
  /** В диспетчерскую, на выбор другого расчёта. */
  onPickRun: () => void;
  onHome: () => void;
}

/* Расчёт не загрузился.

   Раньше это сообщение вставало вместо всей оболочки: ни шапки, ни меню,
   ни ленты расчётов — только заголовок и строка причины. Уйти с него было
   некуда, кроме как править адрес руками. Теперь оно стоит внутри оболочки,
   на месте экрана, которому нужен этот расчёт: меню и лента работают, и две
   кнопки ведут туда, где расчёт можно сменить.

   Версия схемы читается из контракта, а не написана руками: подпись
   «собран под 1.0» пережила две версии и врала.

   Сверху — что случилось и что делать, словами диспетчера; ответ сервера и
   версия схемы — под «Подробности»: это для того, кто будет чинить, и
   человеку, который просто открыл расчёт, они только мешают прочесть главное. */
export function DayFail({ runCode, failure, onPickRun, onHome }: Props) {
  return (
    <div className="stub enter dayfail" role="alert">
      <h2 className="stub__title">Расчёт {runCode} не загрузился</h2>
      <p className="stub__body">
        <b>{failure.title}.</b> {failure.hint}
      </p>
      <details className="fold">
        <summary className="fold__summary">
          <Icon name="chevron-right" size={13} />
          Подробности
        </summary>
        <div className="fold__body">
          {failure.detail && <p className="dayfail__detail">{failure.detail}</p>}
          <p className="stub__body">
            Интерфейс собран под схему контракта {SCHEMA}. Если расчёт пришёл от программы расчёта,
            проверьте, что она отдаёт данные этой схемы; если он посчитан в браузере — обновите
            страницу.
          </p>
        </div>
      </details>
      <div className="dayfail__actions">
        <Button variant="primary" size="sm" onClick={onPickRun} iconLeft={<Icon name="stack" size={14} />}>
          Открыть другой расчёт
        </Button>
        <Button variant="secondary" size="sm" onClick={onHome} iconLeft={<Icon name="house" size={14} />}>
          На главную
        </Button>
      </div>
    </div>
  );
}
