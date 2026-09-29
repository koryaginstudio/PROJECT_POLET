# -*- coding: utf-8 -*-
"""Сборка двух тестовых выгрузок дня: CSV и JSON, с разным наполнением.

Формат — тот же, что у выгрузки заказчика: шапка «Заявка … Адрес» и строка
«Адрес офиса» внизу. Адреса взяты из настоящих выгрузок того же участка —
геокодер движка на них прогрет, и расчёт считается без выхода в сеть.
Инженер и клиент — наши: ФИО штата участка и контакт на объекте.
"""
import csv, json, io, random
from pathlib import Path
from collections import OrderedDict

HERE = Path(__file__).resolve().parent
SRC = HERE.parent / 'source'   # настоящие выгрузки участков: адреса и районы
OUT = HERE
CREW = HERE.parent / 'out'     # штат участка: ФИО инженеров и адрес офиса

HEAD = ['Заявка', 'Тип заявки BK', 'Статус BK', 'Тип заявки HD', 'Начало', 'Окончание',
        'Район', 'Адрес', 'Инженер', 'Клиент', 'Телефон клиента', 'Лицевой счёт',
        'Подключение', 'Гигабитное подключение']

# Тип работ → навык, которым он делается: тот же справочник, что в dataset/build.py.
SKILL = {'Подключение': 'connect', 'Дозаказ': 'connect',
         'Локальная заявка': 'local', 'Глобальная проблема': 'emergency'}

# Имя и фамилия берутся из одной пары списков: иначе в выгрузке появляются
# «Татьяна Сорокин» и «Владимир Жукова», и на такой карточке видно, что данные
# собраны машиной.
MEN = ['Дмитрий', 'Сергей', 'Михаил', 'Алексей', 'Игорь', 'Владимир', 'Павел', 'Руслан']
MEN_LAST = ['Кириллов', 'Панкратов', 'Лобанов', 'Тихонов', 'Балашов', 'Сорокин',
            'Шестаков', 'Нечаев']
WOMEN = ['Анна', 'Елена', 'Ольга', 'Татьяна', 'Наталья', 'Марина', 'Светлана', 'Вера']
WOMEN_LAST = ['Зотова', 'Ушакова', 'Северина', 'Мещерякова', 'Ремизова', 'Жукова',
              'Круглова', 'Гаврилова']


def pool(zone_file):
    """Адреса и районы участка из настоящей выгрузки: адрес, район."""
    rows = list(csv.DictReader(open(SRC / zone_file, encoding='utf-8-sig'), delimiter=';'))
    seen, out = set(), []
    for row in rows:
        if not (row['Заявка'] or '').strip().isdigit():
            continue
        key = (row['Адрес'].strip(), row['Район'].strip())
        if key in seen:
            continue
        seen.add(key)
        out.append(key)
    return out


def crew(key):
    data = json.load(open(CREW / key / 'engineers.json', encoding='utf-8'))
    return data['engineers'], data['engineers'][0]['home_address']


def client(rnd):
    first, last = (MEN, MEN_LAST) if rnd.random() < 0.5 else (WOMEN, WOMEN_LAST)
    name = f"{rnd.choice(first)} {rnd.choice(last)}"
    phone = f"+7 9{rnd.randint(0, 99):02d} {rnd.randint(100, 999)}-{rnd.randint(10, 99)}-{rnd.randint(10, 99)}"
    account = f"{rnd.randint(2, 9)}{rnd.randint(1000000, 9999999)}"
    return name, phone, account


def build(zone_file, crew_key, date, mix, windows, statuses, techs, count, seed, gigabit_share):
    """Строки выгрузки одного дня.

    `mix` — сколько заявок каждого типа BK, `windows` — из каких окон выбирать,
    `statuses` — с какими весами ставить статус наряда.
    """
    rnd = random.Random(seed)
    addresses = pool(zone_file)
    people, office = crew(crew_key)

    plan = []
    for bk, hd_list in mix.items():
        share = round(count * sum(weight for _, weight in hd_list) / sum(
            sum(w for _, w in v) for v in mix.values()))
        for _ in range(share):
            names, weights = zip(*hd_list)
            plan.append((bk, rnd.choices(names, weights=weights)[0]))
    rnd.shuffle(plan)

    rows, number = [], 410000001
    for index, (bk, hd) in enumerate(plan):
        address, district = addresses[index % len(addresses)]
        # Глобальной проблеме выгрузка ставит круглосуточное окно: договорённости
        # с абонентом у неё нет, чинить можно когда угодно.
        start, end = ('0:01', '23:59') if bk == 'Глобальная проблема' and rnd.random() < 0.7 \
            else rnd.choice(windows)
        skill = SKILL[bk]
        able = [one for one in people if skill in one['skills']]
        status = rnd.choices(list(statuses), weights=list(statuses.values()))[0]
        # Наряд, который ещё не отправлен, ни за кем не закреплён.
        engineer = '' if status == 'Не отправлена' else rnd.choice(able)['name']
        name, phone, account = client(rnd)
        tech = rnd.choice(techs) if bk in ('Подключение', 'Дозаказ') else ''
        rows.append(OrderedDict(zip(HEAD, [
            str(number + index), bk, status, hd,
            f'{date} {start}', f'{date} {end}', district, address,
            engineer, name, phone, account, tech,
            'Да' if rnd.random() < gigabit_share else 'Нет'
        ])))
    return rows, office


WINDOWS_DAY = [('10:00', '12:00'), ('12:00', '14:00'), ('14:00', '16:00'),
               ('16:00', '18:00'), ('18:00', '20:00'), ('20:00', '22:00')]
WINDOWS_MORNING = [('8:00', '10:00'), ('9:00', '11:00'), ('10:00', '12:00'),
                   ('11:00', '13:00'), ('12:00', '14:00'), ('14:00', '16:00'),
                   ('16:00', '18:00')]

# ─── набор 1: Восток, обычный день подключений ──────────────────────────────
east_rows, east_office = build(
    'east-synthetic.csv', 'east', '12.10.2026',
    mix={
        'Подключение': [('Конвергенция абонента', 14), ('Заявка на подключение', 6),
                        ('Заказ подключения/Дозаказ оборудования', 5),
                        ('Переключение на Гбит/с', 3)],
        'Дозаказ': [('Дозаказ оборудования', 5), ('ТВ. Замена приставки техником', 2)],
        'Локальная заявка': [('Нет линка', 8), ('Разрывы', 4), ('Низкая скорость', 3),
                             ('Роутер. Замена техническим специалистом', 3),
                             ('Работа с кабелем', 2), ('Мониторинг', 2)],
        'Глобальная проблема': [('Авария', 4), ('Информация', 2)]
    },
    windows=WINDOWS_DAY,
    statuses={'Отправлена': 6, 'Не отправлена': 3, 'В работе': 1},
    techs=['FMC', 'FMC', 'FTTB'], count=64, seed=1210, gigabit_share=0.12)

# ─── набор 2: Юго-Восток, аварийный день ────────────────────────────────────
se_rows, se_office = build(
    'southeast-synthetic.csv', 'southeast', '13.10.2026',
    mix={
        'Подключение': [('Конвергенция абонента', 6), ('Заявка на подключение', 4),
                        ('Заказ подключения/Дозаказ оборудования', 3)],
        'Дозаказ': [('Дозаказ оборудования', 2)],
        'Локальная заявка': [('Нет линка', 7), ('Рост ошибок на порту', 5),
                             ('IP-адрес 169...', 4), ('Работа с кабелем', 4),
                             ('Разрывы', 3), ('TVE/ENT. Замена приставки техником', 2)],
        'Глобальная проблема': [('Авария', 12), ('Работа с кабелем', 4), ('Информация', 2)]
    },
    windows=WINDOWS_MORNING,
    statuses={'Отправлена': 5, 'Не отправлена': 2, 'В пути': 2, 'В работе': 2, 'Просрочена': 1},
    techs=['FMC', 'FTTB', 'GPON'], count=58, seed=1310, gigabit_share=0.2)

# ─── запись ─────────────────────────────────────────────────────────────────
def write_csv(path, rows, office):
    buf = io.StringIO(newline='')
    writer = csv.writer(buf, delimiter=';', lineterminator='\r\n')
    writer.writerow(HEAD)
    for row in rows:
        writer.writerow(list(row.values()))
    writer.writerow([''] * len(HEAD))
    writer.writerow(['Адрес офиса', office] + [''] * (len(HEAD) - 2)) 
    path.write_bytes('﻿'.encode('utf-8') + buf.getvalue().encode('utf-8'))


def write_json(path, rows, office, meta):
    body = {
        'источник': meta,
        'заявки': [dict(row) for row in rows] + [
            {'Заявка': 'Адрес офиса', 'Тип заявки BK': office}
        ]
    }
    path.write_text(json.dumps(body, ensure_ascii=False, indent=1), encoding='utf-8')


write_csv(OUT / 'Восток — выгрузка дня 12.10.2026.csv', east_rows, east_office)
write_json(OUT / 'Юго-Восток — выгрузка дня 13.10.2026.json', se_rows, se_office,
           'учебная выгрузка дня: участок Юго-Восток, 13 октября 2026, день с авариями')
print('CSV', len(east_rows), east_office)
print('JSON', len(se_rows), se_office)
