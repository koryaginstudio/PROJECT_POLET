import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { Metric } from '../data/derive.ts';
import { hhmm, visits } from '../data/derive.ts';

interface Props {
  /** Номер расчёта, который сейчас открыт: R001 и дальше. */
  run: string;
  /** Итоги расчёта: чем движок ответил на этот день. */
  metrics: Metric[];
  /** Раскрывает число в правой панели: там оно разложено по строкам. */
  onOpenGroup: (groupId: string) => void;
  /** Выгружает расчёт книгой Excel. */
  onExport: () => void;
  /** Открывает ручное управление переменными этого расчёта. */
  onManual: () => void;
  /** Открывает окно правки: что случилось и пересчёт остатка дня. */
  onEdit: () => void;
  /** Несохранённый пересчёт: что именно показано на экране. `null` — всё
      показанное лежит в архиве. */
  draft: { at: number; gain: number; what: string } | null;
  /** Идёт сохранение. */
  saving: boolean;
  /** Чем кончилась неудачная попытка сохранить. */
  saveFailed: string | null;
  onSave: () => void;
  /** Отказаться от пересчёта и вернуться к сохранённому плану. */
  onDropDraft: () => void;
  /** Закрыть расчёт и вернуться к выбору: считать новый или открыть другой. */
  onClose: () => void;
}

/* Плитка числа. Вынесена наружу: те же пять чисел стоят и на карте обзора,
   и выглядеть они там обязаны ровно так же — иначе одно и то же покрытие
   читалось бы как два разных показателя. */
export function MetricTile({ metric, onOpen }: { metric: Metric; onOpen: () => void }) {
  return (
    <button type="button" className="cmetric" onClick={onOpen}>
      <span className="cmetric__label">
        {/* Точка вместо цветного числа: цифры на пульте одинаково чёрные,
            отметка лишь показывает, с какой из них начинать разбор. */}
        {metric.flag !== 'ok' && (
          <span className={'cmetric__dot cmetric__dot--' + metric.flag} title={metric.hint} />
        )}
        {metric.label}
      </span>
      <span className="cmetric__value">
        {metric.value}
        {metric.unit && <span className="cmetric__unit">{metric.unit}</span>}
      </span>
      <span className="cmetric__caption">{metric.caption}</span>
      <span className="cmetric__chev">
        <Icon name="chevron-right" size={12} />
      </span>
    </button>
  );
}

/* Пульт движка: момент, от которого считается день, запуск пересборки связей
   и итоги, которыми движок на этот день ответил. Момента расчёта здесь нет:
   план строится на день целиком, а следить за его ходом по часам — работа
   мониторинга, а не планирования. */
export function CalcBoard({
  run,
  metrics,
  onOpenGroup,
  onExport,
  onManual,
  onEdit,
  draft,
  saving,
  saveFailed,
  onSave,
  onDropDraft,
  onClose
}: Props) {
  return (
    <section className="panel calc" aria-label="Расчёт">
      <div className="calc__head">
        {/* Номер идёт первым и крупно: все числа на экране принадлежат
            одному расчёту, и первое, что диспетчер должен прочитать, —
            какому именно. */}
        <div className="calc__intro">
          <h2 className="calc__run" title="Открытый расчёт движка">
            {run}
          </h2>
          {/* Крестик у номера закрывает расчёт и возвращает к выбору. Выход
              из открытого плана был только один — уйти в другой раздел и
              вернуться, — и это выход не тем местом: закрывают то, что
              открыто, там же, где оно подписано. */}
          <button
            type="button"
            className="calc__close"
            onClick={onClose}
            title="Закрыть расчёт и вернуться к выбору"
            aria-label="Закрыть расчёт"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        {/* Действия разложены по тому, что они делают с расчётом, а не свалены
            в один ряд. Слева — то, что его меняет: взять план в свои руки и
            поправить точечно. Справа за чертой — то, что с ним делают, не
            трогая: сохранить и выгрузить. Пересчёта здесь нет: расчёт уже
            посчитан, а новый заводится через «Создать расчёт». */}
        <div className="calc__actions">
          <span className="calc__group">
            {/* Ручное управление: те же рычаги, что и при создании расчёта, но
                применённые к этому дню. Меняют не сам расчёт, а дают новый на
                тех же данных — прошлый остаётся в архиве, и два варианта
                можно положить рядом. */}
            <span title="Пересобрать этот день с другими переменными. Прошлый расчёт останется в архиве, на другие расчёты правка не влияет">
              <Button
                variant="primary"
                size="sm"
                onClick={onManual}
                iconLeft={<Icon name="sliders-horizontal" size={14} />}
              >
                Ручное управление
              </Button>
            </span>
            {/* Подсказка висит на обёртке: кнопка системы своего title не
                принимает, а объяснить, что это за правка, надо. */}
            <span title="День пошёл не так: авария, инженер выбыл, инженер задержится. Движок пересоберёт остаток смены за полторы секунды">
              <Button
                variant="secondary"
                size="sm"
                onClick={onEdit}
                iconLeft={<Icon name="pencil" size={14} />}
              >
                Внести правку
              </Button>
            </span>
          </span>

          <span className="calc__split" aria-hidden="true" />

          <span className="calc__group">
            {/* Сохранить горит, только когда есть что сохранять.

                Зелёная галочка на сохранённом расчёте и оранжевая кнопка на
                несохранённом — это одно и то же место, отвечающее на один
                вопрос: «то, что я вижу, уже записано?». Зелёным оно молчит,
                оранжевым требует действия. Серой неактивной кнопки здесь
                быть не должно: она читалась бы как «сохранить нельзя», а
                правда в том, что сохранять нечего. */}
            {draft ? (
              <span title="Пересчёт показан на экране, но в архив ещё не записан">
                <Button
                  variant="accent"
                  size="sm"
                  onClick={onSave}
                  disabled={saving}
                  iconLeft={<Icon name="check" size={14} />}
                >
                  {saving ? 'Сохраняю…' : 'Сохранить'}
                </Button>
              </span>
            ) : (
              <span className="calc__saved" title="Всё показанное лежит в архиве">
                <Icon name="check-circle" size={14} />
                Сохранён
              </span>
            )}
            {/* Выгрузка — единственное действие здесь, которое уже работает
                целиком: книга собирается из форм, которые вернул движок, и
                ничего не считает заново. */}
            <span title="Книга Excel: сводка, маршруты, визиты по порядку объезда, заявки без инженера и штат">
              <Button
                variant="ghost"
                size="sm"
                onClick={onExport}
                iconLeft={<Icon name="arrow-up-right" size={14} />}
              >
                Экспорт
              </Button>
            </span>
          </span>
        </div>
      </div>

      {/* Полоса несохранённого. Сказать надо прямо и в двух словах: что
          показано, от какого момента и что с этим делать. Отдельно —
          что симуляция и объяснение остались от исходного расчёта: они
          описывают план, которого на экране уже нет, и молчать об этом
          нельзя. */}
      {draft && (
        <div className="calc__draft">
          <Icon name="alert-triangle" size={16} />
          <span className="calc__draft-body">
            <b>Пересчёт не сохранён.</b> На экране остаток дня от {hhmm(draft.at)}: {draft.what}.
            {draft.gain > 0
              ? ` Пересчёт добавил ${visits(draft.gain)}.`
              : ' Пересчёт визитов не добавил.'}{' '}
            Покрытие и разбор рядом остались от исходного расчёта — они про прежний план.
          </span>
          <button type="button" className="calc__draft-drop" onClick={onDropDraft}>
            Вернуть как было
          </button>
        </div>
      )}

      {saveFailed && (
        <div className="solvefail">
          <Icon name="alert-triangle" size={16} />
          <span>
            <b>Сохранить не вышло.</b> {saveFailed}
          </span>
        </div>
      )}

      {/* Чем движок ответил на этот день. Раньше эти числа стояли в подвале
          дашборда, оторванные от кнопки, которая их и меняет. */}
      <div className="calc__metrics">
        {metrics.map((metric) => (
          <MetricTile key={metric.key} metric={metric} onOpen={() => onOpenGroup(metric.group)} />
        ))}
      </div>
    </section>
  );
}
