import { useEffect, useState } from 'react';
import type { EngineerRecord, Registry } from '../../data/registry.ts';
import { editCrew, removeCrew } from '../../data/crew.ts';
import { engineReady, loadPlaces } from '../../data/load.ts';
import type { Place } from '../../data/load.ts';
import { CREW_ENGINE_LOCK, CrewProfile } from '../../app/CrewProfile.tsx';

/* Профиль инженера, открытый из базы.

   Профиль открывается не только из базы инженеров: из карточки маршрута —
   по имени того, кто ехал, из карточки расчёта — по чипу занятого в нём
   человека. Окно одно и то же, и всё, что ему нужно сверх самой записи, —
   участки со своими офисами и запись правок — собирается здесь один раз, а
   не в каждой базе заново. */

interface Props {
  crew: EngineerRecord | null;
  registry: Registry;
  onClose: () => void;
  onOpenRun: (id: string) => void;
  onOpenMap: (id: string) => void;
  /** «Отследить» из профиля — увести в мониторинг. Базы маршрутов и расчётов
      этой дороги пока не получают: там кнопка молчит. */
  onTrack?: (id: string) => void;
  /** Данные штата поправили — справочник надо собрать заново. Без этого
      правка ложится в запись, а на экране проявится при следующей сборке. */
  onChanged?: () => void;
}

export function DbCrewProfile({ crew, registry, onClose, onOpenRun, onOpenMap, onTrack, onChanged }: Props) {
  /* Участки со своими офисами и рамками дня: из них выбирают в форме правки,
     и они же задают человеку адрес выезда и часы. */
  const [places, setPlaces] = useState<Place[]>([]);

  useEffect(() => {
    let cancelled = false;
    loadPlaces()
      .then((list) => !cancelled && setPlaces(list))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <CrewProfile
      crew={crew}
      registry={registry}
      places={places}
      onClose={onClose}
      onOpenRun={onOpenRun}
      onOpenMap={onOpenMap}
      onTrack={(id) => onTrack?.(id)}
      locked={engineReady() ? CREW_ENGINE_LOCK : null}
      onSave={(patch) => {
        if (!crew) return;
        editCrew(crew.id, patch);
        onChanged?.();
      }}
      onDelete={() => {
        if (!crew) return;
        removeCrew(crew.id);
        onClose();
        onChanged?.();
      }}
    />
  );
}
