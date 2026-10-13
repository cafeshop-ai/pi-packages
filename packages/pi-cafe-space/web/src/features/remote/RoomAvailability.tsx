import { useEffect, useState, type PropsWithChildren } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui/Controls';
import { roomOnline } from '../../services/http/roomStatus';
import styles from '../auth/SetupForm.module.scss';

export function RoomAvailability({ roomKey, children }: PropsWithChildren<{ roomKey: string }>) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; state: 'checking' | 'online' | 'offline' | 'unavailable' }>({ key: roomKey, state: 'checking' });
  useEffect(() => {
    const cancel = new AbortController();
    setResult({ key: roomKey, state: 'checking' });
    void roomOnline(roomKey, cancel.signal).then(online => {
      if (!cancel.signal.aborted) setResult({ key: roomKey, state: online ? 'online' : 'offline' });
    }, () => { if (!cancel.signal.aborted) setResult({ key: roomKey, state: 'unavailable' }); });
    return () => cancel.abort();
  }, [roomKey, retry]);
  const state = result.key === roomKey ? result.state : 'checking';
  if (state === 'online') return children;
  const title = state === 'checking' ? (zh ? '正在检查房间状态…' : 'Checking room status…')
    : state === 'offline' ? (zh ? '房间已离线' : 'Room is offline')
    : (zh ? '暂时无法确认房间状态' : 'Could not check room status');
  return <section className={styles.card} aria-labelledby="room-availability-title">
    <p className={styles.eyebrow}>{zh ? '私人房间' : 'PRIVATE ROOM'}</p>
    <h2 className={styles.title} id="room-availability-title" role="status">{title}</h2>
    {state === 'offline' && <p className={styles.intro}>{zh ? '房主电脑上的 Café Space 未连接到服务器，或此链接已失效。请联系房主确认；无需输入密码。' : 'The host’s Café Space is not connected to the server, or this link is no longer valid. Check with the host; no password is needed yet.'}</p>}
    {state === 'unavailable' && <p className={styles.intro}>{zh ? '状态查询失败，不能据此判断房间离线或密码错误。请稍后重试。' : 'The status check failed. This does not mean the room is offline or the password is wrong. Try again shortly.'}</p>}
    {state !== 'checking' && <Button variant="primary" onClick={() => { setResult({ key: roomKey, state: 'checking' }); setRetry(value => value + 1); }}>{zh ? '重新检查' : 'Check again'}</Button>}
  </section>;
}
