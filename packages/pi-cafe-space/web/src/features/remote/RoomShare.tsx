import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import type { AppOwner } from '../../app/owner';
import { Button, IconButton, Input, Label } from '../../components/ui/Controls';
import { Icon } from '../../components/ui/Icon';
import { RoomControlContent, type RoomControlOwner } from './RoomControlPanel';
import { Drawer } from '../../components/ui/Drawer';
import { roomShareRequest, type RoomShareInfo, type ShareAction } from '../../services/http/roomShare';
import { roomPasswordValid } from '../../services/remote/roomCrypto';
import styles from './RoomShare.module.scss';

export function RoomShare({ owner, trigger, onClose, control, initialTab = 'share' }: { owner: AppOwner; trigger: HTMLElement; onClose: () => void; control?: RoomControlOwner; initialTab?: 'share' | 'settings' }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [info, setInfo] = useState<RoomShareInfo | null>(null); const [error, setError] = useState('');
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [noticeWarning,setNoticeWarning] = useState(false);
  const [password, setPassword] = useState(''); const [confirm, setConfirm] = useState('');
  const [reset, setReset] = useState(false); const [editing, setEditing] = useState(false);
  const [tab, setTab] = useState<'share' | 'settings'>(initialTab); const tabsId = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const canConfigure = owner.roomControl && !owner.publicRoomMode && !owner.remote.enabled && !!control;
  const pendingCount = canConfigure ? control.data?.requests.filter(q => q.state === 'pending').length ?? 0 : 0;
  const locked = busy || !!(canConfigure && control.busy);
  const switchTab = (value: 'share' | 'settings') => { if (locked) return; setTab(value); setEditing(false); setReset(false); setPassword(''); setConfirm(''); if(error==='INVALID_PASSWORD')setError(''); };
  useEffect(() => { setTab(initialTab); }, [initialTab]);
  const epoch = useRef(0);
  const alive = useRef(false), pending = useRef(false), cancel = useRef<AbortController | null>(null);
  const operate = async (action: ShareAction) => {
    if (pending.current || action.operation !== 'status' && error && error !== 'INVALID_PASSWORD') return; const ticket = epoch.current; pending.current = true; setBusy(true); setError(''); setNotice(''); setNoticeWarning(false);
    try {
      const value = await roomShareRequest(owner.storage.get('token') ?? '', action, cancel.current?.signal);
      if (!alive.current || ticket !== epoch.current) return;
      setInfo(value); setReset(false); setEditing(false); setPassword(''); setConfirm('');
      if (action.operation === 'password') setNotice(zh ? '密码已更新，房间链接不变。已连接访客需要重新输入密码。' : 'Password updated. The link is unchanged; connected visitors must sign in again.');
      if (action.operation === 'reset-link') setNotice(zh ? '已生成新房间链接，旧链接和旧二维码失效。' : 'A new room link is ready. Old links and QR codes no longer work.');
    } catch (e) { if (alive.current && ticket === epoch.current) setError(e instanceof Error ? e.message : 'ROOM_SHARE_FAILED'); }
    finally { if (ticket === epoch.current) { pending.current = false; if (alive.current) setBusy(false); } }
  };
  useEffect(() => {
    const controller = new AbortController(); epoch.current++; pending.current = false; cancel.current = controller; alive.current = true;
    void operate({ operation: 'status' });
    return () => { alive.current = false; epoch.current++; controller.abort(); };
  }, [owner]);
  const messages: Record<string, string> = zh ? {
    RESULT_UNKNOWN: '未收到修改结果，请先刷新房间信息，不要重复操作。', ROOM_CHANGED: '房间设置已变化，请刷新后再操作。',
    UNAUTHORIZED: '本机登录已失效，请重新登录。', INVALID_PASSWORD: '请输入两次一致的 6–20 位密码，不含首尾空白或控制字符。',
  } : {
    RESULT_UNKNOWN: 'Change result unknown. Refresh room information before another operation.', ROOM_CHANGED: 'Room settings changed. Refresh before editing.',
    UNAUTHORIZED: 'Local sign-in has expired. Sign in again.', INVALID_PASSWORD: 'Enter the same 6–20 character password twice, without surrounding whitespace or control characters.',
  };
  return <Drawer label={zh ? '分享房间' : 'Share room'} closeLabel={zh ? '关闭' : 'Close'} restoreFocusTo={trigger} onClose={onClose} room>
    <div className={styles.content}>
      {info && <div className={styles.identity}><div><span className={styles.kicker}>{zh ? '当前房间' : 'YOUR ROOM'}</span><strong>{info.name}</strong></div><span className={styles.online} data-online={info.online}><i aria-hidden="true" />{info.online ? (zh ? '在线' : 'Online') : (zh ? '连接中' : 'Connecting')}</span></div>}
      <div className={styles.tabs} role="tablist" aria-label={zh ? '分享与房间设置' : 'Share and room settings'}>
        {(['share','settings'] as const).map((value,index)=><button key={value} ref={node=>{tabRefs.current[index]=node;}} type="button" role="tab" id={`${tabsId}-${value}-tab`} aria-controls={`${tabsId}-${value}`} aria-selected={tab===value} tabIndex={tab===value?0:-1} disabled={locked} onClick={()=>switchTab(value)} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?1:index===0?1:0;switchTab(next===0?'share':'settings');tabRefs.current[next]?.focus();}}><Icon name={value==='share'?'share':'settings'} />{value==='share'?(zh?'分享':'Share'):(zh?'房间设置':'Room settings')}{value==='settings'&&pendingCount>0&&<span className={styles.badge} aria-label={zh?`${pendingCount} 个待审批`:`${pendingCount} pending requests`}>{pendingCount}</span>}</button>)}
      </div>
      {!info && <p role="status">{zh ? '正在读取房间信息…' : 'Loading room information…'}</p>}
      {info && <>
        <section role="tabpanel" id={`${tabsId}-share`} aria-labelledby={`${tabsId}-share-tab`} hidden={tab!=='share'} className={styles.sharePage}>
        <div className={styles.invitation}><div className={styles.qr}>{error==='RESULT_UNKNOWN'||error==='ROOM_CHANGED'?<p className={styles.staleCode}>{zh?'先刷新房间信息，再显示二维码':'Refresh room information to show the QR code'}</p>:<QRCodeSVG value={info.url} size={220} level="M" marginSize={4} title={zh ? '房间二维码' : 'Room QR code'} />}</div><h3>{zh ? '扫码加入这个房间' : 'Scan to join this room'}</h3><p className={styles.help}>{zh ? '用手机相机扫描，再输入房间密码。' : 'Scan with your phone, then enter the room password.'}</p></div>
        <div className={styles.field}><Label htmlFor="share-room-url">{zh ? '房间链接' : 'Room link'}</Label><Input id="share-room-url" value={info.url} readOnly disabled={error==='RESULT_UNKNOWN'||error==='ROOM_CHANGED'} onFocus={event => event.currentTarget.select()} /></div>
        <Button className={styles.copyButton} variant="primary" disabled={locked || !!error} onClick={async () => {
          setNoticeWarning(false);
          try { if (!navigator.clipboard?.writeText) throw Error('clipboard unavailable'); await navigator.clipboard.writeText(info.url); if (alive.current) setNotice(zh ? '房间链接已复制。' : 'Room link copied.'); }
          catch { if (alive.current) { setNoticeWarning(true); setNotice(zh ? '无法访问剪贴板，请选中上方链接手动复制。' : 'Clipboard unavailable. Select and copy the link above.'); } }
        }}><Icon name="copy" />{zh ? '复制链接' : 'Copy link'}</Button>
        <p className={styles.securityNote}><Icon name="lock" />{zh ? '链接和二维码不包含密码，请单独告知访客。' : 'The link and QR code never include the password. Share it separately.'}</p>
        <Button className={styles.settingsLink} variant="quiet" disabled={locked} onClick={()=>switchTab('settings')}><Icon name="settings" /><span><strong>{zh?'房间设置':'Room settings'}</strong><small>{pendingCount>0?(zh?`${pendingCount} 个控制权申请待审批`:`${pendingCount} control requests need review`):canConfigure&&!control.error&&control.data?(control.data.enabled?(zh?'已开启审批 · 管理申请与访问':'Approval on · manage requests and access'):(zh?'审批已关闭 · 所有访客可直接操作':'Approval off · all guests can operate Pi')):(zh?'控制权审批、密码与链接管理':'Approval, password and link management')}</small></span><Icon name="chevron" /></Button>
        </section>
        <section role="tabpanel" id={`${tabsId}-settings`} aria-labelledby={`${tabsId}-settings-tab`} hidden={tab!=='settings'} className={styles.settingsPage}>
        <p className={styles.localOnly}><Icon name="lock" />{zh?'仅在房主这台电脑上管理，不会随链接分享。':'Manage on this computer only. These controls are not shared with guests.'}</p>
        {canConfigure && <RoomControlContent owner={owner} control={control} />}
        {!canConfigure && <p className={styles.help}>{zh?'当前网关未提供控制权审批设置。':'Control approval settings are not available on this gateway.'}</p>}
        <div className={styles.management}>
          <div className={styles.settingRow}><div><h3>{zh?'房间密码':'Room password'}</h3><p>{zh?'已设置 · 不显示现有密码':'Set · the current password is never shown'}</p></div><Button variant="quiet" aria-expanded={editing} disabled={locked || !!error} onClick={() => { setEditing(value => !value); setReset(false); setPassword(''); setConfirm(''); }}>{zh ? '修改房间密码' : 'Change room password'}</Button></div>
          {editing && <form className={styles.form} onSubmit={event => {
            event.preventDefault(); if (!roomPasswordValid(password) || password !== confirm) { setError('INVALID_PASSWORD'); return; }
            void operate({ operation: 'password', password, confirmPassword: confirm, revision: info.revision });
          }}>
            <div className={styles.field}><Label htmlFor="new-room-password">{zh ? '新房间密码' : 'New room password'}</Label><Input id="new-room-password" type="password" autoComplete="new-password" value={password} required minLength={6} maxLength={20} disabled={busy} onChange={event => { setPassword(event.target.value); if (error === 'INVALID_PASSWORD') setError(''); }} /></div>
            <div className={styles.field}><Label htmlFor="confirm-room-password">{zh ? '确认新密码' : 'Confirm new password'}</Label><Input id="confirm-room-password" type="password" autoComplete="new-password" value={confirm} required minLength={6} maxLength={20} disabled={busy} onChange={event => { setConfirm(event.target.value); if (error === 'INVALID_PASSWORD') setError(''); }} /></div>
            <p className={styles.help}>{zh ? '首次房间密码沿用创建时的本机令牌。修改后链接不变，现有访客会断开；本机登录令牌不变。' : 'Initially, the room uses the local token from creation. Changing this password keeps the link and local token unchanged, but disconnects visitors.'}</p>
            <div className={styles.actions}><Button variant="quiet" disabled={busy} onClick={()=>{setEditing(false);setPassword('');setConfirm('');if(error==='INVALID_PASSWORD')setError('');}}>{zh?'取消':'Cancel'}</Button><Button type="submit" variant="primary" disabled={locked || !!error && error !== 'INVALID_PASSWORD'}>{zh ? '确认修改密码' : 'Confirm password change'}</Button></div>
          </form>}
          <div className={`${styles.settingRow} ${styles.danger}`}><div><h3>{zh?'让旧邀请失效':'Invalidate old invitations'}</h3><p>{zh?'只有链接泄露或需要收回邀请时才使用。':'Use only to retire a shared link.'}</p></div><Button variant="quiet" aria-expanded={reset} disabled={locked || !!error} onClick={() => { setReset(value => !value); setEditing(false); setPassword(''); setConfirm(''); }}>{zh ? '重置房间链接' : 'Reset room link'}</Button></div>
          {reset && <div className={styles.confirm}><p>{zh ? '旧链接和二维码将立即失效，并断开现有访客。房间密码保持不变。' : 'Old links and QR codes stop working, and current visitors disconnect. The room password stays the same.'}</p><Button variant="primary" disabled={busy} onClick={() => void operate({ operation: 'reset-link', revision: info.revision })}>{zh ? '确认重置链接' : 'Confirm link reset'}</Button><Button variant="quiet" disabled={busy} onClick={() => setReset(false)}>{zh ? '取消' : 'Cancel'}</Button></div>}
        </div>
        </section>
      </>}
      {error && <p role="alert" className={styles.error}>{messages[error] ?? (zh ? '无法读取或修改房间，请确认本机服务在线。' : 'Room operation failed. Check the local service.')}</p>}
      {notice && <p role="status" className={styles.notice} data-warning={noticeWarning}><Icon name={noticeWarning?'copy':'check'} />{notice}</p>}
      <footer className={styles.footer}><span>{zh?'同一房间 · 链接长期有效':'One room · a reusable invitation'}</span><IconButton label={zh?'刷新房间信息':'Refresh room information'} disabled={locked} loading={busy} onClick={()=>void operate({operation:'status'})}><Icon name="refresh" /></IconButton></footer>
    </div>
  </Drawer>;
}
