import { useEffect, useRef, useState } from 'react';
import { Button } from '../ds/components/core/Button.jsx';
import { Icon } from '../ds/components/core/Icon.jsx';
import { CURRENT_DISPATCHER, initials } from './profile.ts';
import { useModalFocus } from './modal.ts';

/* Карточка диспетчера раскрывается из самого кружка: она масштабируется
   от правого верхнего угла, а не выезжает откуда-то сбоку. */
export function ProfileMenu() {
  const [open, setOpen] = useState(false);
  /* Снимок во весь рост — окном поверх экрана. Кружок в шапке сорок
     пикселей, и разглядеть в нём лица нельзя: щелчок по большому кружку в
     карточке показывает снимок целиком. */
  const [face, setFace] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const shot = useRef<HTMLDivElement>(null);
  useModalFocus(face, shot);
  const me = CURRENT_DISPATCHER;
  const showPhoto = Boolean(me.photo) && !photoFailed;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /* Esc закрывает то, что сверху: сперва снимок, и только потом саму
         карточку — иначе одно нажатие уносит оба окна разом. */
      if (face) setFace(false);
      else setOpen(false);
    };
    const onDown = (e: PointerEvent) => {
      if (face) return;
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open, face]);

  const mug = showPhoto ? (
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
        {mug}
      </button>

      {open && (
        <div className="profile__card" role="dialog" aria-label="Профиль диспетчера">
          <div className="profile__head">
            {/* Кружок в карточке — кнопка, когда есть что показывать: снимок
                открывается крупно. Без снимка это по-прежнему инициалы, и
                нажимать в них не на что. */}
            {showPhoto ? (
              <button
                type="button"
                className="avatar avatar--lg avatar--zoom"
                onClick={() => setFace(true)}
                title="Показать снимок крупно"
                aria-label="Показать снимок крупно"
              >
                {mug}
              </button>
            ) : (
              <span className="avatar avatar--lg" aria-hidden="true">
                {mug}
              </span>
            )}
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

      {/* Снимок крупно. Окном, а не раскрытием карточки: карточка живёт в
          углу шапки и шире стать не может, а смотреть на снимок хочется
          посередине экрана. */}
      {face && showPhoto && (
        <div className="modal facewin" role="dialog" aria-modal="true" aria-label={me.name}>
          <button
            type="button"
            className="modal__veil"
            onClick={() => setFace(false)}
            aria-label="Закрыть"
          />
          <div className="modal__card facewin__card" ref={shot}>
            <img className="facewin__img" src={me.photo} alt={me.name} />
            <div className="facewin__foot">
              <span className="facewin__id">
                <span className="facewin__name">{me.name}</span>
                <span className="facewin__role">{me.role}</span>
              </span>
              <button
                type="button"
                className="facewin__close"
                onClick={() => setFace(false)}
                title="Закрыть"
              >
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
