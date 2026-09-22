"""
Общие механики планирования: расчёт расписания маршрута и проверка
осуществимости. Оба планировщика пользуются одним и тем же кодом —
иначе сравнение было бы сравнением двух разных проверок, а не двух
стратегий.
"""

from __future__ import annotations

from typing import Callable, Sequence

from ..core.domain import Engineer, Order, Route, Visit, too_far

# Функция буфера: сколько минут запаса до закрытия окна требовать
# для визита на позиции i (0-based).
BufferFn = Callable[[int], int]


def no_buffer(position: int) -> int:
    return 0


def fits_stock(seq: Sequence[Order], order: Order, stock: dict | None) -> bool:
    """
    Влезет ли заявка в машину исполнителя вместе с тем, что уже в маршруте.

    `stock` — что у него в машине: прибор -> штук; `None` — ограничения
    нет. От порядка визитов не зависит: всё, что поставлено в маршрут,
    везётся с утра. Поэтому проверка живёт на уровне «кто может взять», а
    не в расписании, и обе реализации солвера зовут одну эту функцию —
    место, где они могли бы разойтись, одно.
    """
    if stock is None or not order.equipment:
        return True
    for kind, n in order.equipment.items():
        занято = sum(o.equipment.get(kind, 0) for o in seq)
        if занято + n > stock.get(kind, 0):
            return False
    return True


def schedule_upto(
    engineer: Engineer,
    orders: Sequence[Order],
    net,
    buffer_fn: BufferFn = no_buffer,
    duration_factor: float = 1.0,
) -> tuple[list[Visit], int]:
    """
    Расписание последовательности заявок вместе с индексом первого
    визита, который в неё не влезает: `(визиты до поломки, индекс)`,
    где индекс -1 означает, что осуществима вся последовательность.

    Индекс нужен выбиванию заявок в LNS: удаление визита сдвигает хвост
    маршрута раньше — иногда прямо в час пик, — и остаток перестаёт быть
    осуществимым. Вызывающему надо знать, на каком именно визите он
    сломался, чтобы выбить и его тоже.

    duration_factor > 1 означает, что планируем работу с запасом
    (закладываем, что она затянется).
    """
    visits: list[Visit] = []
    clock = engineer.shift_start
    node = engineer.home_node

    for i, order in enumerate(orders):
        # Перегон длиннее того, на что годится транспорт. Временем это не
        # отсекается: полтора часа ходьбы формально влезают в смену.
        if too_far(net, node, order.node, engineer.transport):
            return visits, i
        travel = int(round(net.travel_minutes(node, order.node, clock, engineer.transport)))
        arrive = clock + travel
        start = max(arrive, order.window_start)

        # Не влезаем в окно — с учётом требуемого буфера.
        if start + buffer_fn(i) > order.window_end:
            return visits, i

        dur = int(round(order.est_minutes * duration_factor))
        finish = start + dur

        if finish > engineer.shift_end:
            return visits, i

        visits.append(Visit(order=order, arrive=arrive, start=start,
                            finish=finish, travel=travel))
        clock = finish
        node = order.node

    return visits, -1


def schedule(
    engineer: Engineer,
    orders: Sequence[Order],
    net,
    buffer_fn: BufferFn = no_buffer,
    duration_factor: float = 1.0,
) -> list[Visit] | None:
    """
    Строит расписание для заданной последовательности заявок.
    Возвращает None, если последовательность неосуществима.

    Правило расписания одно на всех и живёт в `schedule_upto`.
    """
    visits, broken = schedule_upto(engineer, orders, net, buffer_fn, duration_factor)
    return None if broken >= 0 else visits


def route_cost(visits: Sequence[Visit], engineer: Engineer) -> float:
    """Стоимость маршрута: время в пути плюс лёгкий штраф за простой."""
    if not visits:
        return 0.0
    travel = sum(v.travel for v in visits)
    idle = sum(max(0, v.start - v.arrive) for v in visits)
    return travel + 0.3 * idle


def make_route(engineer: Engineer, visits: list[Visit]) -> Route:
    return Route(engineer=engineer, visits=visits)


def order_sort_key(order: Order):
    """Порядок рассмотрения: аварии первыми, затем узкие окна."""
    return (-order.priority, order.window_len(), order.window_start)
