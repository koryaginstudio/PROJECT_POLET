import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';

interface Props {
  title: string;
  onBack: () => void;
}

/* Заглушка раздела. Пустой экран — приглашение к действию, а не констатация пустоты. */
export function Stub({ title, onBack }: Props) {
  return (
    <div className="stub enter">
      <h2 className="stub__title">{title}</h2>
      <p className="stub__body">
        Раздел заложен в каркасе и пока не наполнен. Данные для него уже есть в контракте — экран
        соберём следующим шагом.
      </p>
      <Button variant="secondary" onClick={onBack} iconLeft={<Icon name="arrow-left" size={16} />}>
        Вернуться в диспетчерскую
      </Button>
    </div>
  );
}
