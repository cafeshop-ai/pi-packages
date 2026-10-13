import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { Icon } from '../../components/ui/Icon';
import { Button, Input } from '../../components/ui/Controls';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/shadcn/field';
import styles from './LoginForm.module.scss';
export function LoginForm({ owner, defaultRoom, roomId, onLogin }: { owner: AppOwner; defaultRoom: string; roomId?: string; onLogin?: (room: string) => void }) {
  const { t } = useTranslation(); const helpId = useId();
  const [token, setToken] = useState('');
  const [room, setRoom] = useState(owner.storage.get('room') ?? defaultRoom);
  const [dirty, setDirty] = useState(false); const [invalid, setInvalid] = useState(false);
  useEffect(() => { if (!dirty && !owner.storage.get('room')) setRoom(defaultRoom); }, [defaultRoom, dirty, owner]);
  return <form className={styles.form} onSubmit={event => { event.preventDefault(); setInvalid(false); try { const selectedRoom = roomId ?? room; owner.login(token, selectedRoom); setToken(''); onLogin?.(selectedRoom); } catch { setInvalid(true); } }}>
    <FieldGroup><Field data-invalid={invalid}><FieldLabel htmlFor={`${helpId}-token`}>{t('clientToken')}</FieldLabel><Input id={`${helpId}-token`} aria-invalid={invalid} type="password" aria-describedby={helpId} aria-label={t('clientToken')} value={token} maxLength={4096} autoComplete="off" required onChange={event => setToken(event.target.value.slice(0, 4096))} /></Field>
    <p id={helpId} className={styles.help}>{t('tokenHelp')}</p>
    {roomId ? <p className={styles.room}><span>{t('room')}</span><strong>{roomId}</strong></p> : <Field data-invalid={invalid}><FieldLabel htmlFor={`${helpId}-room`}>{t('room')}</FieldLabel><Input id={`${helpId}-room`} aria-invalid={invalid} aria-label={t('room')} value={room} maxLength={64} required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}" onChange={event => { setDirty(true); setRoom(event.target.value.slice(0, 64)); }} /></Field>}</FieldGroup>
    <Button type="submit" variant="primary">{t('connect')}<Icon name="chevron" /></Button>
    {invalid && <p role="alert">{t('invalidLogin')}</p>}
  </form>;
}
