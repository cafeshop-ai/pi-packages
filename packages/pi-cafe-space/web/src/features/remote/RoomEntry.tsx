import { CafeIdentityChoice, CafeIdentityChip, useCafeAccount } from './CafeIdentity';
import { RoomAvailability } from './RoomAvailability';
import { savedNickname, validNickname } from '../../services/remote/visitorIdentity';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { RoomStage } from '../../services/remote/RoomSocket';
import { roomDiagnosticReport } from '../../services/remote/roomDiagnosticReport';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { AppOwner } from '../../app/owner';
import { Button, Input, Label } from '../../components/ui/Controls';
import { Icon } from '../../components/ui/Icon';
import { useCollabStore } from '../../state/useCollabStore';
import { roomKeyFromInput, roomPasswordValid } from '../../services/remote/roomCrypto';
import styles from '../auth/SetupForm.module.scss';

export function RoomLanding({owner}:{owner:AppOwner}) {
  const identity=useCafeAccount(owner);
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const navigate = useNavigate();
  const [link, setLink] = useState(''); const [error, setError] = useState(false);
  if(identity.enabled&&(identity.mode==='choose'||identity.mode==='account'&&!identity.account))return <section className={styles.card}><CafeIdentityChoice owner={owner} returnPath="/"/></section>;
  return <section className={styles.card} aria-labelledby="room-home-title">
    <p className={styles.eyebrow}>CAFÉ SPACE</p><h2 className={styles.title} id="room-home-title">{zh ? '进入你的房间' : 'Join your room'}</h2>
    {identity.enabled&&<CafeIdentityChip owner={owner} onSwitch={()=>owner.account.choose('choose')}/>}
    <form className={styles.form} onSubmit={event => {
      event.preventDefault(); const key = roomKeyFromInput(link, window.location.origin);
      if (!key) { setError(true); return; } navigate('/room/' + key);
    }}>
      <p className={styles.intro}>{zh ? '粘贴房间链接，或用相机扫码。' : 'Paste a room link, or scan its QR code.'}</p>
      <div className={styles.field}><Label htmlFor="room-link">{zh ? '房间链接或房间 key' : 'Room link or room key'}</Label><Input id="room-link" className={styles.input} autoCapitalize="none" spellCheck={false} autoComplete="off" value={link} maxLength={2048} required onChange={event => { setLink(event.target.value); setError(false); }} placeholder="https://…/#/room/…" /></div>
      {error && <div className={styles.error}><p role="alert">{zh ? '请输入本站完整房间链接或有效的房间 key。' : 'Enter a room link for this site or a valid room key.'}</p></div>}
      <div className={styles.footer}><Button className={styles.submit} variant="primary" type="submit">{zh ? '打开房间' : 'Open room'}<Icon name="chevron" /></Button></div>
      <div className={styles.note}><Icon name="lock" /><p>{zh ? '房间不公开列出，进入需要密码。' : 'Rooms are private and password-protected.'}</p></div>
    </form>
  </section>;
}
export function RoomLogin({ owner, roomKey }: { owner: AppOwner; roomKey: string }) {
  return <RoomAvailability roomKey={roomKey}><RoomPasswordForm key={roomKey} owner={owner} roomKey={roomKey} /></RoomAvailability>;
}
function RoomPasswordForm({ owner, roomKey }: { owner: AppOwner; roomKey: string }) {
  const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const connection = useCollabStore(owner.store, state => state.connection.status);
  const identity=useCafeAccount(owner);const account=identity.enabled&&identity.mode==='account'?identity.account:null;
  const [password, setPassword] = useState(''); const [show, setShow] = useState(false); const [error, setError] = useState('');
  const [nickname, setNickname] = useState(() => savedNickname(roomKey));
  useEffect(() => { setNickname(savedNickname(roomKey)); }, [roomKey]);
  const [compatible, setCompatible] = useState(false);
  useEffect(()=>{setPassword('');setError('');},[identity.mode,identity.account?.sessionId]);
  const [copyState, setCopyState] = useState<'idle'|'copying'|'copied'|'fallback'>('idle');
  const [copyFallback, setCopyFallback] = useState('');
  const busy = !['stopped', 'auth-failed'].includes(connection);
  const remote = useSyncExternalStore(owner.remote.subscribe, owner.remote.getSnapshot, owner.remote.getSnapshot);
  const progress = remote.roomProgress ?? owner.roomLastProgress;
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { if (!busy) return; setElapsed(0); const started = Date.now(); const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000); return () => clearInterval(timer); }, [busy]);
  const phases: Record<RoomStage,string> = zh ? { signaling:'连接信令服务',gathering:'检测直连和中继地址','waiting-office':'等待办公电脑应答',identity:'验证房间身份',transport:'建立加密连接',password:'验证房间密码',synchronizing:'同步 Pi 实例',connected:'已连接' } : { signaling:'Connecting to signaling',gathering:'Finding direct and relay routes','waiting-office':'Waiting for the office endpoint',identity:'Verifying room identity',transport:'Establishing encrypted connection',password:'Checking room password',synchronizing:'Synchronizing Pi instances',connected:'Connected' };
  const errors: Record<string, string> = zh ? {
    INVALID_VISITOR_PROFILE: '昵称应为1–24个字符，不含#或控制字符。',
    ROOM_ACCOUNT_LOGIN_REQUIRED: 'Café 账号登录已失效或发生变化，请重新登录；不会自动切换为访客。',
    ROOM_ACCOUNT_IDENTITY_FAILED: '办公电脑未能验证 Café 账号身份。房间密码正确也不能跳过身份验证，请核对网关配置。',
    ROOM_VISITOR_IDENTITY_FAILED: '无法验证本浏览器的访客身份，请重新连接；没有恢复任何授权。',
    ROOM_BROWSER_UNSUPPORTED: '当前浏览器缺少必要的 WebRTC 或安全加密能力。请在系统 Safari 或 Chrome 中打开此链接。',
    ROOM_SIGNAL_START_FAILED: '信令连接在创建时失败。下方显示具体初始化步骤；尚未验证密码。',
    ROOM_SIGNAL_POLICY_DENIED: '浏览器报告安全限制，阻止了信令连接。请先刷新此页面；不要关闭浏览器安全保护或重置密码。',
    ROOM_RANDOM_UNAVAILABLE: '安全随机数初始化失败，连接尚未启动。请保留下方异常类型。',
    ROOM_INVALID_ORIGIN: '页面地址未通过连接检查。请使用原来的完整房间链接重新打开。',
    ROOM_INITIALIZATION_FAILED: '连接组件初始化失败，尚未启动房间通信。下方显示异常类型。',
    ROOM_SIGNAL_UNAVAILABLE: '无法建立信令连接。网页能打开不代表 WebSocket 可用，请检查当前网络或浏览器限制。',
    ROOM_SIGNAL_DISCONNECTED: '与信令服务的连接中断。已停止本次尝试，请手动重试。',
    ROOM_CONNECTION_INTERRUPTED: '连接没有完成，已停止自动重试。下方显示最后阶段，不需要重置密码。',
    ROOM_ICE_NO_CANDIDATE: '当前浏览器没有取得可用连接地址，直连和 TURN 中继均未准备好。',
    ROOM_ICE_CONNECTION_FAILED: '未能建立到办公电脑的加密通道；不是密码已被判错。请查看下方连接详情。',
    ROOM_WEBRTC_NEGOTIATION_FAILED: '浏览器无法完成 WebRTC 协商，请在系统浏览器重试。',
    ROOM_DTLS_FAILED: '加密握手未完成，连接已停止；这不是密码验证失败。可勾选兼容连接再尝试。',
    ROOM_SCTP_FAILED: '加密通道的数据传输协商失败。可勾选兼容连接再尝试，密码不需要修改。',
    ROOM_DATA_CHANNEL_FAILED: '数据通道在房间连接完成前关闭。可勾选兼容连接；下方保留了断开时的实际状态。',
    ROOM_TCP_RELAY_UNAVAILABLE: '服务没有提供可用于兼容连接的 TURN/TCP 地址，未退回其他传输。',
    ROOM_CONNECTION_LOST: '已建立的房间连接中断，请重新连接。不会自动重发任务。',
    INVALID_ROOM_CREDENTIALS: '密码需要 6–20 位，不含首尾空白或控制字符。',
    ROOM_BUSY: '这个房间连接请求较多，请稍等一分钟后重试。',
    ROOM_PROTOCOL_ERROR: '房间连接出现异常，已安全中止。请重新连接；没有自动重发任务。',
    ROOM_PASSWORD_REJECTED: '房间密码不正确，请核对房主提供的密码。',
    ROOM_AUTH_BUSY: '办公电脑正在验证其他连接，请稍等一两秒再试；密码尚未判错。',
    ROOM_AUTH_RATE_LIMITED: '这个房间本分钟的验证请求较多，请稍后重试，无需修改密码。',
    ROOM_ACCESS_CHANGED: '房间链接或密码刚刚变更，请重新获取房主当前的分享信息。',
    ROOM_OFFLINE: '房间暂时离线或不可用，请确认办公电脑上的 Café Space 已开启。',
    ROOM_IDENTITY_FAILED: '无法验证房间身份。没有发送密码，请重新向房主获取链接。',
    ROOM_WEBRTC_UNAVAILABLE: '无法建立 WebRTC 连接，请检查当前网络或稍后重试。',
    ROOM_CONNECTION_TIMEOUT: '连接超时，请确认办公电脑在线，或更换网络重试。',
  } : {
    INVALID_VISITOR_PROFILE: 'Use a nickname of 1–24 characters without # or control characters.',
    ROOM_ACCOUNT_LOGIN_REQUIRED: 'Your Café login expired or changed. Sign in again; guest access is never selected automatically.',
    ROOM_ACCOUNT_IDENTITY_FAILED: 'The office computer could not verify your Café identity. Identity verification is separate from the room password.',
    ROOM_VISITOR_IDENTITY_FAILED: 'Could not verify this browser’s visitor identity. Reconnect; no grant was restored.',
    ROOM_BROWSER_UNSUPPORTED: 'This browser lacks required WebRTC or secure cryptography support. Open the link in Safari or Chrome.',
    ROOM_SIGNAL_START_FAILED: 'Signaling failed during construction. The initialization step is shown below; the password has not been checked.',
    ROOM_SIGNAL_POLICY_DENIED: 'The browser reported a security restriction while creating signaling. Reload this page; do not disable browser security or reset the password.',
    ROOM_RANDOM_UNAVAILABLE: 'Secure random initialization failed before connecting. Keep the exception type shown below.',
    ROOM_INVALID_ORIGIN: 'The page address failed connection validation. Reopen the original complete room link.',
    ROOM_INITIALIZATION_FAILED: 'A connection component failed to initialize before room communication started. The exception type is shown below.',
    ROOM_SIGNAL_UNAVAILABLE: 'Signaling could not connect. Loading the webpage does not prove WebSocket connectivity.',
    ROOM_SIGNAL_DISCONNECTED: 'Signaling disconnected. This attempt stopped; retry when ready.',
    ROOM_CONNECTION_INTERRUPTED: 'Connection did not complete. Automatic retries stopped; the last stage is shown below. Do not reset the password.',
    ROOM_ICE_NO_CANDIDATE: 'The browser did not obtain a usable direct or TURN relay address.',
    ROOM_ICE_CONNECTION_FAILED: 'The encrypted channel to the office endpoint could not be established. This is not a wrong-password result.',
    ROOM_WEBRTC_NEGOTIATION_FAILED: 'WebRTC negotiation failed. Try the system browser.',
    ROOM_DTLS_FAILED: 'The encrypted handshake failed before password verification. Try Compatibility connection.',
    ROOM_SCTP_FAILED: 'Data transport negotiation failed. Try Compatibility connection; do not change the password.',
    ROOM_DATA_CHANNEL_FAILED: 'The data channel closed before joining the room. Try Compatibility connection; the closing state is shown below.',
    ROOM_TCP_RELAY_UNAVAILABLE: 'No TURN/TCP address is configured for Compatibility connection. No other transport was substituted.',
    ROOM_CONNECTION_LOST: 'The established room connection was interrupted. Reconnect when ready; tasks are never replayed automatically.',
    INVALID_ROOM_CREDENTIALS: 'Use 6–20 characters without surrounding whitespace or control characters.',
    ROOM_BUSY: 'This room has too many connection attempts. Please wait a minute and retry.',
    ROOM_PROTOCOL_ERROR: 'The room connection was interrupted. Reconnect when ready; no task was replayed automatically.',
    ROOM_PASSWORD_REJECTED: 'Incorrect room password. Check the password provided by the owner.',
    ROOM_AUTH_BUSY: 'The office computer is verifying another connection. Try again in a second or two; your password was not rejected.',
    ROOM_AUTH_RATE_LIMITED: 'This room has received many verification requests this minute. Wait briefly and retry; do not change the password.',
    ROOM_ACCESS_CHANGED: 'The room link or password just changed. Get the current sharing details from the owner.',
    ROOM_OFFLINE: 'This room is offline or unavailable. Check that Café Space is running on the office computer.',
    ROOM_IDENTITY_FAILED: 'Room identity could not be verified. No password was sent. Get the link again from its owner.',
    ROOM_WEBRTC_UNAVAILABLE: 'Could not establish WebRTC. Check the network and try again.',
    ROOM_CONNECTION_TIMEOUT: 'Connection timed out. Check the office computer or try another network.',
  };
  const code = error || owner.roomFailure;
  const copyDiagnostic = async () => {
    const text = roomDiagnosticReport(code, connection, progress, compatible);
    setCopyState('copying'); setCopyFallback('');
    try {
      if (!navigator.clipboard?.writeText) throw Error('CLIPBOARD_UNAVAILABLE');
      await navigator.clipboard.writeText(text); setCopyState('copied');
    } catch { setCopyFallback(text); setCopyState('fallback'); }
  };
  if(identity.enabled&&(identity.mode==='choose'||identity.mode==='account'&&!identity.account))return <section className={styles.card}><p className={styles.eyebrow}>{zh?'加入私人房间':'JOIN A PRIVATE ROOM'}</p><CafeIdentityChoice owner={owner} returnPath={'/room/'+roomKey}/></section>;
  return <section className={styles.card} aria-labelledby="room-password-title">
    <p className={styles.eyebrow}>{zh ? '私人房间' : 'PRIVATE ROOM'}</p><h2 className={styles.title} id="room-password-title">{zh ? '输入房间密码' : 'Enter room password'}</h2>
    {identity.enabled&&<CafeIdentityChip owner={owner} onSwitch={()=>{owner.logout();owner.account.choose('choose');}}/>}
    <form className={styles.form} onSubmit={event => {
      event.preventDefault(); if (busy) return;
      if (!account&&!validNickname(nickname.trim())) { setError('INVALID_VISITOR_PROFILE'); return; }
      if (!roomPasswordValid(password)) { setError('INVALID_ROOM_CREDENTIALS'); return; }
      setError(''); setCopyState('idle'); setCopyFallback(''); try { owner.connectRoomLink(roomKey, password, compatible ? 'relay-tcp' : 'auto', nickname.trim()); setPassword(''); } catch (e) { setError(e instanceof Error&&e.message==='ROOM_ACCOUNT_LOGIN_REQUIRED'?e.message:'INVALID_ROOM_CREDENTIALS'); }
    }}>
      <p className={styles.intro}>{zh ? '连接办公电脑上的 Pi。' : 'Connect to Pi on your office computer.'}</p>
      {!account&&<div className={styles.field}><Label htmlFor="room-nickname">{zh ? '你的昵称' : 'Your nickname'}</Label><Input id="room-nickname" className={styles.input} value={nickname} maxLength={48} required disabled={busy} autoComplete="nickname" onChange={event => setNickname(event.target.value)} placeholder={zh ? '例如：拿铁' : 'For example: Latte'} /><small>{zh ? '进入后显示为 昵称#ID。同一浏览器刷新保留身份；不会保存房间密码。' : 'Shown as nickname#ID. This browser keeps its identity across reloads; the room password is not saved.'}</small></div>}
      {account&&<p className={styles.intro}>{zh?'这里输入房主提供的房间密码，不是 Café 账号密码。':'Enter the password supplied by the room owner, not your Café account password.'}</p>}
      <div className={styles.field}><Label htmlFor="room-password">{zh ? '房间密码' : 'Room password'}</Label><div className={styles.inputWrap}>
        <Input id="room-password" className={styles.input} type={show ? 'text' : 'password'} autoComplete="current-password" autoCapitalize="none" spellCheck={false} value={password} minLength={6} maxLength={20} required disabled={busy} onChange={event => setPassword(event.target.value)} placeholder={zh ? '6–20 位房间密码' : '6–20 characters'} />
        <Button className={styles.visibility} variant="quiet" disabled={busy} aria-label={zh ? (show ? '隐藏密码' : '显示密码') : (show ? 'Hide password' : 'Show password')} aria-pressed={show} onClick={() => setShow(value => !value)}>{zh ? (show ? '隐藏' : '显示') : (show ? 'Hide' : 'Show')}</Button>
      </div></div>
      <div className={styles.intro}><label htmlFor="room-compatible"><input id="room-compatible" type="checkbox" checked={compatible} disabled={busy} onChange={event => setCompatible(event.target.checked)} /> {zh ? '兼容连接（强制中继）' : 'Compatibility connection (relay only)'}</label>{compatible && <p>{zh ? '只通过 TURN/TCP 建立加密连接，不改变房间密码、权限或系统代理。' : 'Uses an encrypted TURN/TCP route only. Your room password, permissions and system proxy stay unchanged.'}</p>}</div>
      {busy && <p role="status" className={styles.intro}>{phases[progress?.stage ?? 'signaling']} · {elapsed}{zh ? ' 秒' : ' s'}</p>}
      {code && !busy && <div className={styles.error}><p role="alert">{errors[code] ?? (zh ? '连接未成功，请稍后重试。' : 'Connection failed. Please try again.')}</p><p>{code}</p></div>}
      {(busy || code) && progress && <details className={styles.intro}><summary>{zh ? '连接详情（不含密码）' : 'Connection details (no password)'}</summary><p>{phases[progress.stage]}{progress.transport && <><br/>{zh ? '传输模式' : 'Mode'}: {progress.policy === 'relay-tcp' ? 'TURN/TCP' : (zh ? '自动' : 'Auto')}<br/>ICE: {progress.transport.ice}<br/>DTLS: {progress.transport.dtls}<br/>SCTP: {progress.transport.sctp}<br/>DataChannel: {progress.transport.channel}<br/>{zh ? '触发事件' : 'Event'}: {progress.transport.event} · {(progress.transport.elapsedMs / 1000).toFixed(1)}s{progress.transport.errorDetail && <><br/>RTC: {progress.transport.errorDetail}</>}{progress.transport.sctpCauseCode !== undefined && <><br/>SCTP code: {progress.transport.sctpCauseCode}</>}{progress.transport.sentAlert !== undefined && <><br/>DTLS sent: {progress.transport.sentAlert}</>}{progress.transport.receivedAlert !== undefined && <><br/>DTLS received: {progress.transport.receivedAlert}</>}</>}{progress.initialization && <><br/>{zh ? '初始化步骤' : 'Initialization step'}: {progress.initialization.step}<br/>{zh ? '异常类型' : 'Exception type'}: {progress.initialization.exception}</>}<br/>{zh ? '手机已取得中继地址' : 'Browser relay address available'}: {String(progress.localRelay)}<br/>{zh ? '办公端已提供中继地址' : 'Office relay address available'}: {String(progress.remoteRelay)}{progress.iceErrorCode !== null && <><br/>ICE: {progress.iceErrorCode}</>}{progress.signalCloseCode !== null && <><br/>WebSocket: {progress.signalCloseCode}</>}</p></details>}
      {(code || progress) && <div className={styles.intro}><Button variant="quiet" type="button" disabled={copyState==='copying'} onClick={() => void copyDiagnostic()}>{zh ? (copyState==='copied'?'已复制诊断日志':copyState==='copying'?'正在复制…':'复制诊断日志') : (copyState==='copied'?'Diagnostic log copied':copyState==='copying'?'Copying…':'Copy diagnostic log')}</Button><p role="status">{copyState==='copied' ? (zh?'已复制，可以直接粘贴发送；不含密码、房间链接或 IP 地址。':'Copied. Paste it to share; it contains no password, room link or IP address.') : copyState==='fallback' ? (zh?'浏览器未允许自动复制，请长按下方文本复制。':'Automatic copy was not allowed. Select and copy the text below.') : null}</p>{copyFallback && <textarea className={styles.input} aria-label={zh?'诊断日志文本':'Diagnostic log text'} readOnly rows={8} value={copyFallback} onFocus={event=>event.currentTarget.select()} />}</div>}
      <div className={styles.footer}><Button className={styles.submit} variant="primary" type="submit" loading={busy} disabled={busy}>{busy ? (zh ? '正在验证并连接…' : 'Verifying and connecting…') : (zh ? (code ? '重新连接' : '进入房间') : (code ? 'Retry connection' : 'Join room'))}<Icon name="chevron" /></Button></div>
      {busy && <Button variant="quiet" onClick={() => owner.logout()}>{zh ? '取消连接' : 'Cancel connection'}</Button>}
      <div className={styles.note}><Icon name="lock" /><p>{zh ? '加密连接，密码只发送给已验证的办公电脑。' : 'Encrypted connection. Your password goes only to the verified office computer.'}</p></div>
    </form>
  </section>;
}
