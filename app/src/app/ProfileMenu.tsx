import { useEffect, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { CURRENT_DISPATCHER, initials } from './profile.ts';

/* Карточка диспетчера раскрывается из самого кружка: она масштабируется
   от правого верхнего угла, а не выезжает откуда-то сбоку. */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const me = CURRENT_DISPATCHER;
  const showPhoto = Boolean(me.photo) && !photoFailed;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  const face = showPhoto ? (
    <img src={me.photo} alt="" onError={() => setPhotoFailed(true)} />
  ) : (
    <span>{initials(me.name)}</span>
  );

  return (
    <div className="profile" ref={wrap}>
      <button
        type="button"
        className={'avatar' + (open ? ' avatar--open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Профиль: ${me.name}`}
        title={me.name}
      >
        {face}
      </button>

      {open && (
        <div className="profile__card" role="dialog" aria-label="Профиль диспетчера">
          <div className="profile__head">
            <span className="avatar avatar--lg" aria-hidden="true">
              {face}
            </span>
            <span className="profile__id">
              <span className="profile__name">{me.name}</span>
              <span className="profile__role">{me.role}</span>
            </span>
          </div>

          <div className="profile__shift">
            <Icon name="clock" size={16} />
            <span>
              Рабочий день {me.shiftStart}–{me.shiftEnd}
            </span>
          </div>

          <div className="profile__actions">
            <Button variant="secondary" size="sm" block iconLeft={<Icon name="shuffle" size={14} />}>
              Сменить аккаунт
            </Button>
            <button type="button" className="profile__exit">
              <Icon name="arrow-left" size={14} />
              Выйти из аккаунта
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
