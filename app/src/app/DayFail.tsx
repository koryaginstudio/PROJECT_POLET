import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { SCHEMA } from '../data/contract.ts';

interface Props {
  /** Номер расчёта, который не открылся. */
  runCode: string;
  /** Чем кончилась загрузка — строкой из загрузчика. */
  message: string;
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
   «собран под 1.0» пережила две версии и врала. */
export function DayFail({ runCode, message, onPickRun, onHome }: Props) {
  return (
    <div className="stub enter dayfail" role="alert">
      <h2 className="stub__title">Расчёт {runCode} не загрузился</h2>
      <p className="stub__body">{message}</p>
      <p className="stub__body">
        Интерфейс собран под схему контракта {SCHEMA}. Если расчёт пришёл от программы расчёта, проверьте, что
        он отдаёт данные этой схемы; если он свой — обновите страницу.
      </p>
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
