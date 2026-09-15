import { Icon } from '../ds/components/core/Icon.jsx';
import { Badge } from '../ds/components/core/Badge.jsx';
import { hhmm } from '../data/derive.ts';

interface Props {
  /** Расчёт, к плану которого применяют воздействие. */
  runCode: string;
  /** Момент, от которого движок пересобирает остаток дня. */
  cut: number;
  /** Запущен ли движок: без него ни одно воздействие посчитать нельзя. */
  live: boolean;
}

/* Управление воздействием — третий этап процесса.

   Планирование отвечает «что должно получиться», мониторинг — «что
   происходит». Здесь единственное место, где диспетчер не смотрит, а
   вмешивается: день пошёл не так, как посчитали, и надо решить, что делать.

   Ключевое решение экрана — событий три, а не одно. Соблазн сделать одну
   кнопку «ЧП» велик, но он неверен, и это замерено: выбытие инженера стоит
   дню 5,2 визита, и пересчёт возвращает 4,4 — жать обязательно. Задержка на
   сорок минут стоит 0,4–0,5 визита, и пересчёт возвращает 0,1–0,7 — буферы
   съедают её сами. Система, которая перетасовывает бригаду из-за прокола
   колеса, хуже той, что не делает ничего: людям уже позвонили и сказали
   ехать.

   Поэтому экран обязан не просто уметь пересчитать, а сказать, стоит ли.
   Цена воздействия — разница между «пересчитали» и «поехали как ехали» — это
   то, ради чего сюда заходят, и она приходит числом в ответе движка.

   Пока экран описывает, а не действует: разметку событий и цены собираем
   следующим шагом, когда договоримся о виде. Обещать кнопку, которая ничего
   не делает, хуже, чем честно сказать, что её ещё нет. */

interface Kind {
  key: string;
  icon: string;
  title: string;
  what: string;
  /** Во что событие обходится дню, если ничего не делать. */
  cost: string;
  /** Что возвращает пересчёт. */
  back: string;
  /** Стоит ли жать. Замерено, а не придумано. */
  verdict: 'press' | 'skip';
  verdictText: string;
}

const KINDS: Kind[] = [
  {
    key: 'urgent',
    icon: 'alert-triangle',
    title: 'Авария',
    what: 'В середине дня приходят срочные заявки, которых не было в плане.',
    cost: 'Без пересчёта они просто не попадают в маршруты.',
    back: 'Две аварии дают +4,1 визита за день.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    key: 'disabled',
    icon: 'user',
    title: 'Инженер выбыл',
    what: 'Сегодня его не будет — заболел, отозвали, машина не поехала.',
    cost: 'Стоит дню 5,2 визита.',
    back: 'Пересчёт возвращает 4,4 из них.',
    verdict: 'press',
    verdictText: 'Пересчитывать'
  },
  {
    key: 'delayed',
    icon: 'clock',
    title: 'Инженер задержится',
    what: 'Прокол, пробка, затянувшийся визит — выйдет на маршрут позже.',
    cost: 'Стоит дню 0,4–0,5 визита — буферы съедают её почти целиком.',
    back: 'Пересчёт возвращает 0,1–0,7: в пределах шума.',
    verdict: 'skip',
    verdictText: 'Чаще не стоит'
  }
];

export function ControlScreen({ runCode, cut, live }: Props) {
  return (
    <div className="dash enter">
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Управление воздействием</h2>
          <span className="dash__section-note">
            план расчёта {runCode}, от {hhmm(cut)} до конца смены
          </span>
        </div>
        <p className="clients__lede">
          День пошёл не так, как посчитали. Здесь объявляют, что случилось, и движок пересобирает
          остаток смены за полторы секунды. Уже закрытые визиты не трогаются, а тем, кому уже
          сказали ехать, без нужды не меняют адрес.
        </p>
      </section>

      {/* Три события, а не одна кнопка «ЧП». Это не удобство, а вывод из
          замеров: жать пересчёт стоит в двух случаях из трёх, и диспетчер
          должен видеть, в каком он сейчас. */}
      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Что случилось</h2>
          <span className="dash__section-note">три разных события, не одно</span>
        </div>

        <div className="actgrid">
          {KINDS.map((kind) => (
            <div key={kind.key} className="actcard">
              <span className="actcard__top">
                <span className="actcard__icon">
                  <Icon name={kind.icon} size={16} />
                </span>
                <span className="actcard__title">{kind.title}</span>
                <Badge tone={kind.verdict === 'press' ? 'danger' : 'neutral'}>
                  {kind.verdictText}
                </Badge>
              </span>
              <p className="actcard__what">{kind.what}</p>
              <span className="actcard__rows">
                <span className="actcard__row">
                  <span>Стоит дню</span>
                  <b>{kind.cost}</b>
                </span>
                <span className="actcard__row">
                  <span>Пересчёт вернёт</span>
                  <b>{kind.back}</b>
                </span>
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="dash__section-head">
          <h2 className="dash__section-title">Чего это будет стоить</h2>
        </div>
        <p className="clients__lede">
          На каждое воздействие движок отвечает не только новым планом, но и его ценой. Это и есть
          то, ради чего сюда заходят: пересчитать можно всегда, а вот нужно ли — вопрос, на который
          до сих пор отвечали на глаз.
        </p>
        <div className="setrow">
          <span className="setrow__key">Визитов выиграли</span>
          <span className="setrow__val">
            сколько влезло после пересчёта против того, сколько влезло бы без него
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Кого не тронули</span>
          <span className="setrow__val">
            доля визитов, сохранивших исполнителя — по тем, кого событие не касалось
          </span>
        </div>
        <div className="setrow">
          <span className="setrow__key">Судьба визитов выбывшего</span>
          <span className="setrow__val">подхватили другие · остались за ним · не влезли никуда</span>
        </div>
      </section>

      <section className="panel">
        <div className="ctrlnote">
          <Icon name={live ? 'lightning' : 'alert-triangle'} size={16} />
          <span>
            {live ? (
              <>
                <b>Движок запущен и пересчёт умеет.</b> Экран описывает воздействия, но пока их не
                запускает: разметку событий и цены соберём следующим шагом. Кнопку, которая ничего
                не делает, ставить не стали.
              </>
            ) : (
              <>
                <b>Движок не запущен.</b> Без него воздействие посчитать нечем — пересчёт это
                работа планировщика, а не заранее записанный файл.
              </>
            )}
          </span>
        </div>
      </section>
    </div>
  );
}
