import { useEffect, useMemo } from 'react';
import { Icon } from '../ds/components/core/Icon.jsx';
import type { OrderRecord } from '../data/registry.ts';
import { hhmm, plural } from '../data/derive.ts';
import { workTypeIcon } from '../data/dictionary.ts';

export interface VisitsScope {
  /** Что стоит в заголовке: «Нет линка», «Маршрут M0413», «Расчёт R001». */
  title: string;
  /** Чем этот отбор объясняется — строкой под заголовком. */
  lede: string;
  /** Заявки, попавшие в отбор. Порядок задаёт тот, кто открыл. */
  orders: OrderRecord[];
}

interface Props {
  scope: VisitsScope | null;
  onClose: () => void;
  /** Открыть заявку целиком. Нет — строки не нажимаются. */
  onOpenOrder?: (order: OrderRecord) => void;
}

/* Что где и когда человек делал — одним окном.

   Профиль инженера отвечает на «кто он и сколько отработал», и ответ этот
   сводный: восемь чипов «выполнил» с числами, три таблицы по расчётам,
   маршрутам и заявкам. На вопрос «а что за два раза он чинил линк — где это
   было и когда» сводка не отвечает: чип знает только число, строка маршрута —
   только районы.

   Окно и есть этот ответ. Оно одно на четыре входа — чип работы, строка
   смены, строка маршрута, кнопка над списком заявок, — потому что вопрос у
   них один и тот же, а разнятся только заголовок и набор строк. Четыре окна
   с одинаковыми колонками пришлось бы править вчетвером и разошлись бы они
   на первой же правке.

   Колонки отвечают ровно на «что, где, когда»: вид работ, адрес с районом,
   время визита по плану. Дальше — окно приёма и номер маршрута: первое
   говорит, насколько визит был свободен в выборе часа, второй — куда он
   встал. Заявка, которая в маршрут не попала, времени визита не имеет: у
   невзятой работы его и не бывает, и вместо часов стоит прочерк. */
export function VisitsDialog({ scope, onClose, onOpenOrder }: Props) {
  useEffect(() => {
    if (!scope) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [scope, onClose]);

  /* Сначала те, что стоят в маршруте, по времени визита; невзятые — хвостом,
     по началу окна приёма. Иначе прочерк вместо времени всплывал бы в
     середине дня и рвал ленту надвое. */
  const rows = useMemo(() => {
    if (!scope) return [];
    return [...scope.orders].sort((a, b) => {
      if (a.visitStart == null && b.visitStart == null) return a.windowStart - b.windowStart;
      if (a.visitStart == null) return 1;
      if (b.visitStart == null) return -1;
      return a.visitStart - b.visitStart;
    });
  }, [scope]);

  if (!scope) return null;

  const planned = rows.filter((order) => order.visitStart != null).length;
  const minutes = rows.reduce((sum, order) => sum + order.estMinutes, 0);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={scope.title}>
      <button type="button" className="modal__veil" onClick={onClose} aria-label="Закрыть" />

      <div className="modal__card visits">
        <div className="modal__head">
          <div className="visits__head">
            <h3 className="visits__title">{scope.title}</h3>
            <p className="visits__lede">{scope.lede}</p>
          </div>
          <button type="button" className="rpanel__x" onClick={onClose} aria-label="Закрыть">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="visits__sum">
          <span>
            <b>{rows.length}</b> {plural(rows.length, 'визит', 'визита', 'визитов').split(' ')[1]}
          </span>
          {planned < rows.length && (
            <span className="visits__warn">
              <b>{rows.length - planned}</b> без времени — в маршрут не попали
            </span>
          )}
          <span className="visits__muted">
            работы на {Math.floor(minutes / 60)} ч {minutes % 60} мин
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="crewpro__muted">Здесь пока ничего нет.</p>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Что делал</th>
                  <th>Где</th>
                  <th>Когда</th>
                  <th>Окно приёма</th>
                  <th>Работа</th>
                  <th>Маршрут</th>
                  <th>Расчёт</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr
                    className="tbl__row"
                    key={order.key}
                    onClick={onOpenOrder ? () => onOpenOrder(order) : undefined}
                  >
                    <td>
                      <span className="visits__what">
                        <Icon name={workTypeIcon(order.workType)} size={13} />
                        <span className="tbl__strong">{order.workTitle}</span>
                      </span>
                      <span className="tbl__sub">{order.id}</span>
                    </td>
                    <td>
                      <span>{order.address}</span>
                      <span className="tbl__sub">{order.district}</span>
                    </td>
                    <td className="tbl__num">
                      {order.visitStart == null || order.visitEnd == null ? (
                        <span className="tbl__muted">—</span>
                      ) : (
                        <span className="tbl__strong">
                          {hhmm(order.visitStart)}–{hhmm(order.visitEnd)}
                        </span>
                      )}
                    </td>
                    <td className="tbl__num">
                      {hhmm(order.windowStart)}–{hhmm(order.windowEnd)}
                    </td>
                    <td className="tbl__num">{order.estMinutes} мин</td>
                    <td className="tbl__num">
                      {order.routeCode ?? <span className="tbl__muted">—</span>}
                    </td>
                    <td>{order.run.code}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
