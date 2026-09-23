import { useEffect, useRef } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import { useModalFocus } from './modal.ts';

interface Props {
  open: boolean;
  onClose: () => void;
  /* Цвет первого маршрута дня: образцы линии и точки берут его, а не
     выдуманный, — тогда окно объясняет ту самую карту, что под ним. */
  sample: string;
  tone: { done: string; risk: string; free: string };
}

/* Что означают знаки на карте.

   Прежде это была строка в нижнем углу: три подписи, которые читают в
   первый день работы, закрывали город каждую минуту всех остальных дней.
   При этом объясняли они треть знаков — про квадраты выезда, красный
   восклицательный знак и кружки порядка объезда карта молчала вовсе.

   Окно решает и то и другое: место у города не отнимается, а сказать можно
   про все знаки разом и теми же образцами, какими карта их рисует. */
export function MapKeys({ open, onClose, sample, tone }: Props) {
  const card = useRef<HTMLDivElement>(null);
  useModalFocus(open, card);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Условные обозначения">
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card mapkeys" ref={card}>
        <div className="modal__head">
          <h2 className="mapkeys__title">Условные обозначения</h2>
          <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="mapkeys__group">
          <span className="mapkeys__group-name">Маршруты</span>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__line" style={{ background: sample }} />
            </span>
            <span className="mapkeys__what">
              <b>Линия</b> — путь одного инженера за день. Цвет свой у каждого маршрута: им же
              обведены его заявки.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__end" style={{ '--tone': sample } as React.CSSProperties}>
                <i />
                M0001
              </span>
            </span>
            <span className="mapkeys__what">
              <b>Метка с номером</b> — конец маршрута: у той заявки, куда инженер приезжает
              последним. Рядом с номером — на чём он едет.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__square" style={{ background: sample }} />
            </span>
            <span className="mapkeys__what">
              <b>Квадрат цветом маршрута</b> — место, откуда инженер выезжает.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__square mapkeys__square--nest" />
            </span>
            <span className="mapkeys__what">
              <b>Серый квадрат</b> — общее место выезда: отсюда выезжают несколько инженеров.
              Щелчок разворачивает перечень.
            </span>
          </div>
        </div>

        <div className="mapkeys__group">
          <span className="mapkeys__group-name">Чем передвигается инженер</span>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__line" style={{ background: sample }} />
            </span>
            <span className="mapkeys__what">
              <b>Сплошная</b> — автомобиль.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span
                className="mapkeys__line mapkeys__line--bike"
                style={{ '--tone': sample } as React.CSSProperties}
              />
            </span>
            <span className="mapkeys__what">
              <b>Штрихпунктир</b> — велосипед.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span
                className="mapkeys__line mapkeys__line--walk"
                style={{ '--tone': sample } as React.CSSProperties}
              />
            </span>
            <span className="mapkeys__what">
              <b>Пунктир из точек</b> — пешком.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span
                className="mapkeys__line mapkeys__line--transit"
                style={{ '--tone': sample } as React.CSSProperties}
              />
            </span>
            <span className="mapkeys__what">
              <b>Длинный штрих</b> — общественный транспорт. Рисунок говорит, на чём человек
              передвигается; улицы у всех одни и те же — другой дорожной сети в расчёте нет.
            </span>
          </div>
        </div>

        <div className="mapkeys__group">
          <span className="mapkeys__group-name">Заявки</span>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__dot" style={{ borderColor: sample }} />
            </span>
            <span className="mapkeys__what">
              <b>Точка в цветной обводке</b> — заявка назначена инженеру этого маршрута.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__dot" style={{ borderColor: tone.free }} />
            </span>
            <span className="mapkeys__what">
              <b>Точка в серой обводке</b> — заявка без инженера: в маршруты она не попала.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__alarm">!</span>
            </span>
            <span className="mapkeys__what">
              <b>Красный знак</b> — по заявке нарушен срок или не осталось запаса времени.
            </span>
          </div>
        </div>

        <div className="mapkeys__group">
          <span className="mapkeys__group-name">Выбранный маршрут</span>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__seq" style={{ background: tone.done }}>
                1
              </span>
            </span>
            <span className="mapkeys__what">
              <b>Кружок с номером</b> — порядок объезда: так инженер идёт по своим заявкам.
            </span>
          </div>
          <div className="mapkeys__row">
            <span className="mapkeys__mark">
              <span className="mapkeys__seq" style={{ background: tone.risk }}>
                4
              </span>
            </span>
            <span className="mapkeys__what">
              <b>Красный номер</b> — этот визит под угрозой срока.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
