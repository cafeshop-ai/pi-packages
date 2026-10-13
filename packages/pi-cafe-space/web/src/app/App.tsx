import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HashRouter, Route, Routes, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import styles from './App.module.scss';
import { AppOwner } from './owner';
import { parseRoomRoute, roomHref } from './roomRoute';
import { useCollabStore } from '../state/useCollabStore';
import { scopeKey } from '../state/CollabStore';
import { isThinkingLevel, type CommandPayload } from '../../../src/protocol/index';
import type { GatewayResult } from '../services/relay/CommandGateway';
import { LoginForm } from '../features/auth/LoginForm';
import { SetupForm } from '../features/auth/SetupForm';
import setupStyles from '../features/auth/SetupForm.module.scss';
import { RemoteLogin } from '../features/remote/RemoteLogin';
import { RoomLanding, RoomLogin } from '../features/remote/RoomEntry';
import { CafeIdentityMenu, CafeLoginCallback } from '../features/remote/CafeIdentity';
import { RoomShare } from '../features/remote/RoomShare';
import { useRoomControlOwner } from '../features/remote/RoomControlPanel';
import { publicRoomPath } from '../services/remote/roomCrypto';
import { ControlRequestDialog } from '../features/remote/ControlRequestDialog';
import { RemoteDevicePanel, RemoteControlBar } from '../features/remote/RemotePanel';
import { useRemoteState } from '../services/remote/useRemoteState';
import { Conversation } from '../features/chat/components/Conversation';
import { Composer } from '../features/chat/components/Composer';
import { referencedFiles } from '../features/chat/components/useInputAssist';
import { FilesPane } from '../features/files/FilesPane';
import { HistoryList, HistoryDetail } from '../features/history/History';
import { useManagedSessions, ManagedSessionList, ManagedSessionDialog } from '../features/history/ManagedSessions';
import { SessionActions, type SessionActionRequest } from '../features/history/SessionActions';
import { ModelControls } from '../features/hosts/ModelControls';
import { WorkspaceLayout, useWorkspaceMode } from '../layouts/WorkspaceLayout';
import { useFollowScroll } from '../components/ui/useFollowScroll';
import { Icon } from '../components/ui/Icon';
import { Button, IconButton, Input } from '../components/ui/Controls';
import { Drawer } from '../components/ui/Drawer';
import { UiProvider } from '../components/ui/UiProvider';
import { useMobileViewport } from '../components/ui/useMobileViewport';
const defaultFactory = () => new AppOwner();
function Workspace({ owner, roomBase, onNewSession }: { owner: AppOwner; roomBase: string; onNewSession: (trigger: HTMLElement) => void }) {
  const mode = useWorkspaceMode();
  const { t, i18n } = useTranslation();
  const state = useCollabStore(owner.store, value => value);
  const remoteState = useRemoteState(owner.remote);
  const root = useRef<HTMLElement>(null);
  const scope = owner.store.scope();
  const { following, scrollToBottom } = useFollowScroll(root, scope ? scopeKey(scope) : '');
  const [settingsTrigger, setSettingsTrigger] = useState<HTMLElement | null>(null);
  const [sessionAction, setSessionAction] = useState<SessionActionRequest | null>(null);
  const [historyTrigger, setHistoryTrigger] = useState<HTMLElement | null>(null);
  const contextKey = scope ? scopeKey(scope) : '';
  const dialogScope = JSON.stringify([contextKey, state.connection.generation, state.viewGeneration, remoteState.info?.id]);
  const [approvalDialog, setApprovalDialog] = useState<{ scope: string; trigger: HTMLElement | null } | null>(null);
  useEffect(() => { setApprovalDialog(null); }, [dialogScope]);
  useEffect(() => { setSettingsTrigger(null); setSessionAction(null); setHistoryTrigger(null); }, [contextKey]);
  const host = state.selectedHostId ? state.hosts.get(state.selectedHostId) : undefined;
  const snapshot = host?.snapshot;
  const connected = state.connection.status === 'authenticated' && !!scope && !!host && !host.stale && host.info.connected && host.info.ready !== false;
  const managedHost = scope?.hostId.startsWith('managed-') === true;
  const enabled = connected && !!scope && owner.remote.canRequestWrite();
  const execute = (payload: CommandPayload): Promise<GatewayResult> => scope ? owner.execute(payload, scope).then(result => { if (result.status === 'unknown') owner.store.notice('RESULT_UNKNOWN'); return result; }) : Promise.resolve({ status: 'rejected', code: 'HOST_REQUIRED', message: null });
  const localCommands = ['new', 'name', 'resume', 'model', 'thinking'].map((value, i) => ({ value, label: '/' + value, description: t(['newSession', 'renameSession', 'history', 'modelSettings', 'thinking'][i]!) }));
  const send = (text: string, delivery?: 'steer' | 'followUp', files?: string[]): Promise<GatewayResult> => {
    const command = text.trim();
    if (!command.startsWith('/')) {
      const references = files ?? referencedFiles(text);
      return execute({ name: 'prompt', content: text, ...(delivery ? { delivery } : {}), ...(references.length ? { files: references } : {}) });
    }
    const reject = (code: string) => Promise.resolve<GatewayResult>({ status: 'rejected', code, message: null });
    if (command === '/new') {
      if (managedHost) { const trigger = root.current?.querySelector('textarea'); if (!trigger) return reject('HOST_REQUIRED'); onNewSession(trigger); return Promise.resolve({ status: 'applied', code: null, message: null, data: { kind: 'local_action' } }); }
      if (!enabled) return reject('CONTROL_REQUIRED');
      if (snapshot?.sessionControl !== true) return reject('SESSION_CONTROL_UNAVAILABLE');
      if (snapshot.phase !== 'idle' || snapshot.hasPendingMessages) return reject('SESSION_BUSY');
      const trigger = root.current?.querySelector('textarea');
      if (!trigger) return reject('HOST_REQUIRED');
      setSessionAction({ mode: 'new_session', trigger });
      return Promise.resolve({ status: 'applied', code: null, message: null, data: { kind: 'local_action' } });
    }
    if (!enabled || snapshot?.inputAssist !== true) return reject('INPUT_ASSIST_UNAVAILABLE');
    if (snapshot.phase !== 'idle' || snapshot.hasPendingMessages) return reject('SESSION_BUSY');
    const [, name, args = ''] = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(command) ?? [];
    const trigger = root.current?.querySelector('textarea');
    if (!trigger) return reject('HOST_REQUIRED');
    if (name === 'thinking' && args) return isThinkingLevel(args) ? execute({ name: 'set_thinking', level: args }) : reject('INVALID_COMMAND');
    if (['new', 'resume', 'model', 'thinking'].includes(name ?? '') && args) return reject('INVALID_COMMAND');
    if (name === 'name') setSessionAction({ mode: 'rename_session', trigger, ...(args ? { title: args } : {}) });
    else if (name === 'model' || name === 'thinking') setSettingsTrigger(trigger);
    else if (name === 'resume') setHistoryTrigger(trigger);
    else return execute({ name: 'run_command', command });
    return Promise.resolve({ status: 'applied', code: null, message: null, data: { kind: 'local_action' } });
  };
  return <section ref={root} className={styles.center} aria-label={t('conversation')}>
    {!scope || !snapshot ? <div className={styles.placeholder}><Icon name="message" /><h2>{t(state.selectedHostId ? 'hostSynchronizing' : 'selectHost')}</h2><p>{t('hostHelp')}</p>{mode === 'mobile' && !state.selectedHostId && state.hosts.size > 0 && <div className={styles.mobileHostPicker}>{[...state.hosts.values()].map(item => <Button key={item.info.hostId} variant="quiet" className={styles.hostChoice} onClick={() => owner.selectHost(item.info.hostId)}><Icon name="hosts" /><span><strong>{item.info.sessionName || item.info.hostId}</strong><small>{item.info.cwd || (i18n.language.startsWith('zh') ? '打开会话' : 'Open conversation')}</small></span><Icon name="chevron" /></Button>)}</div>}</div> : <>
      <header className={styles.conversationHeader} aria-label={t('currentSession')}><div className={styles.conversationIdentity}><h2 title={host?.info.sessionName ?? undefined}>{host?.info.sessionName || t('conversation')}</h2><div className={styles.conversationMeta}><span title={scope.cwd}>{scope.cwd || scope.hostId}</span><span className={styles.contextState} data-offline={!connected} data-connection-state={connected?'connected':'unavailable'}>{t(!host?.info.connected || state.connection.status!=='authenticated' ? 'offline' : host.stale || host.info.ready===false ? 'hostSynchronizing' : 'online')}</span></div></div><Button variant="quiet" aria-label={managedHost ? (i18n.language.startsWith('zh') ? '启动独立 Pi 实例' : 'Start independent Pi instance') : t('newSession')} title={managedHost ? t('independentSessionHint') : t('sessionSwitchHint')} disabled={managedHost ? !connected : !enabled || snapshot.sessionControl !== true || snapshot.phase !== 'idle' || snapshot.hasPendingMessages} onClick={event => managedHost ? onNewSession(event.currentTarget) : setSessionAction({ mode: 'new_session', trigger: event.currentTarget })}><Icon name="plus" />{managedHost ? (i18n.language.startsWith('zh') ? '新实例' : 'New instance') : t('newSessionShort')}</Button></header>
      <RemoteControlBar owner={owner} hostId={scope.hostId} available={connected} compact />
      <Conversation navigation={!following && <Button className={styles.latest} onClick={scrollToBottom}><Icon name="down" />{t('jumpLatest')}</Button>} snapshot={snapshot} scope={scope} connected={connected} disabled={!enabled} onSend={async text => { const result = await send(text); if (result.status === 'rejected' || result.status === 'unknown') owner.store.notice(result.code ?? 'COMMAND_ERROR'); }} onAbort={async () => { const result = await execute({ name: 'abort' }); if (result.code) owner.store.notice(result.code); }} />
      <Composer onApprovalRequired={trigger => { if (owner.remote.getSnapshot().controlPolicy === 'approval') setApprovalDialog({scope: dialogScope, trigger}); }} scopeId={JSON.stringify([scopeKey(scope), state.connection.generation, state.viewGeneration])} enabled={enabled} phase={snapshot.phase} inputAssist={snapshot.inputAssist === true} localCommands={localCommands} readCompletions={(payload, signal) => scope ? owner.gateway.execute(payload, scope, { signal, transient: true }) : Promise.resolve({ status: 'rejected', code: 'HOST_REQUIRED', message: null })} send={send} abort={() => execute({ name: 'abort' })} context={<Button variant="quiet" className={styles.modelTrigger} aria-label={t('modelSettings')} onClick={event => setSettingsTrigger(event.currentTarget)}><Icon name="settings" /><span>{snapshot.model?.id ?? t('modelSettings')}</span><small>{snapshot.thinkingLevel ?? 'off'}</small></Button>} />
      {approvalDialog?.scope === dialogScope && <ControlRequestDialog key={dialogScope} owner={owner} hostId={scope.hostId} hostLabel={host?.info.sessionName || scope.hostId} available={connected} restoreFocusTo={approvalDialog.trigger} onClose={() => setApprovalDialog(null)} />}
      {sessionAction && <SessionActions owner={owner} roomBase={roomBase} request={sessionAction} />}
      {historyTrigger && <Drawer label={t('history')} closeLabel={t('close')} onClose={() => setHistoryTrigger(null)} restoreFocusTo={historyTrigger}><HistoryList owner={owner} roomBase={roomBase} /></Drawer>}
      {settingsTrigger && <Drawer label={t('modelSettings')} closeLabel={t('close')} onClose={() => setSettingsTrigger(null)} restoreFocusTo={settingsTrigger}><ModelControls key={contextKey} owner={owner} readOnly={!enabled} expanded /></Drawer>}
    </>}
  </section>;
}
function Shell({ owner, defaultRoom, managedSessions }: { owner: AppOwner; defaultRoom: string; managedSessions: boolean }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate(); const location = useLocation();
  // Appearance is local UI state, never part of the Relay scope or credential store.
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [search, setSearch] = useState('');
  const [preferencesTrigger, setPreferencesTrigger] = useState<HTMLElement | null>(null);
  const [shareTrigger, setShareTrigger] = useState<HTMLElement | null>(null);
  const [shareTab, setShareTab] = useState<'share' | 'settings'>('share');
  const openShare = (element: HTMLElement, tab: 'share' | 'settings' = 'share') => { setPreferencesTrigger(null); setShareTab(tab); setShareTrigger(shareButton.current ?? element); };
  const shareButton = useRef<HTMLButtonElement>(null);
  const state = useCollabStore(owner.store, value => value);
  const remote = useRemoteState(owner.remote);
  const publicRoute = owner.publicRoomMode ? publicRoomPath(location.pathname) : null;
  const route = publicRoute ? { valid: true as const, roomId: 'main', base: publicRoute.base, pagePath: publicRoute.page } : parseRoomRoute(location.pathname);
  const roomId = route.valid ? route.roomId : null;
  const base = route.valid ? route.base : '';
  const pagePath = route.valid ? route.pagePath : '';
  const liveHref = base || '/';
  const managed = useManagedSessions(owner, roomId ?? state.connection.roomId ?? defaultRoom, base, managedSessions);
  const authenticated = state.connection.status === 'authenticated';
  const activeRoom = roomId ?? state.connection.roomId ?? defaultRoom;
  const localOwner = authenticated && owner.roomControl && !owner.publicRoomMode && !remote.enabled && activeRoom === 'main';
  const localControl = useRoomControlOwner(owner, localOwner);
  const pendingControls = localControl.data?.requests.filter(q => q.state === 'pending').length ?? 0;
  useEffect(() => { setShareTrigger(null); setShareTab('share'); }, [activeRoom]);
  const login = state.connection.status === 'stopped' || state.connection.status === 'auth-failed';
  const roomWaiting = owner.publicRoomMode && !authenticated;
  const switchingRoom = roomId !== null && state.connection.roomId !== roomId && !login;
  useLayoutEffect(() => {
    if (owner.publicRoomMode) {
      if (!publicRoute || owner.remote.roomKey && owner.remote.roomKey !== publicRoute.key) owner.logout();
      return;
    }
    if (!route.valid) owner.client.stop();
    else owner.openRoom(roomId ?? owner.storage.get('room') ?? 'main');
  }, [owner, route.valid, roomId, publicRoute?.key]);
  useLayoutEffect(() => { owner.store.changeView(); }, [owner, location.pathname]);
  const shareRequested = !owner.publicRoomMode && new URLSearchParams(location.search).get('panel') === 'share';
  useEffect(() => { if (shareRequested && authenticated && owner.roomShare && shareButton.current) { setShareTab('share'); setShareTrigger(shareButton.current); } }, [shareRequested, authenticated, owner]);
  const closeShare = () => { setShareTrigger(null); if (shareRequested) { const query = new URLSearchParams(location.search); query.delete('panel'); navigate(location.pathname + (query.size ? '?' + query.toString() : ''), { replace: true }); } };
  const loginDestination = (room: string) => roomHref(room) + (pagePath === '/' ? '' : pagePath) + (shareRequested ? '?panel=share' : '');
  const selectedHost = state.selectedHostId ? state.hosts.get(state.selectedHostId) : undefined;
  const mobileTitle = selectedHost?.info.sessionName || (state.selectedHostId ? t('conversation') : 'Café Space');
  const mobileSubtitle = `${state.hosts.size} Pi · ${i18n.language.startsWith('zh') ? '点击切换实例' : 'Switch instance'}`;
  const preferencesButton = <IconButton className={styles.mobileUtilityButton} label={i18n.language.startsWith('zh') ? '更多选项' : 'More options'} onClick={event => setPreferencesTrigger(event.currentTarget)}><Icon name="more" /></IconButton>;
  const mobileRoomActions = <>{authenticated && owner.roomShare && <IconButton ref={shareButton} className={styles.mobileUtilityButton} label={i18n.language.startsWith('zh')?'分享房间':'Share room'} onClick={event=>openShare(event.currentTarget)}><Icon name="share" /></IconButton>}{preferencesButton}</>;
  const preferences = <>
    <section className={styles.preferenceGroup}><h3>{t('language')}</h3><nav className={styles.preferenceOptions} aria-label={t('language')}><Button variant="quiet" aria-pressed={i18n.language.startsWith('zh')} onClick={() => void i18n.changeLanguage('zh-CN')}>中文</Button><Button variant="quiet" aria-pressed={!i18n.language.startsWith('zh')} onClick={() => void i18n.changeLanguage('en')}>English</Button></nav></section>
    <section className={styles.preferenceGroup}><Button variant="quiet" onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} />{t(theme === 'dark' ? 'switchToLight' : 'switchToDark')}</Button></section>
    <section className={styles.preferenceGroup}>{owner.publicRoomMode&&<CafeIdentityMenu owner={owner}/>}<p className={styles.connection} data-status={state.connection.status}><i aria-hidden="true" />{t(`connection.${state.connection.status}`)}</p>{remote.enabled && <RemoteDevicePanel owner={owner} />}{remote.enabled && state.selectedHostId && <RemoteControlBar owner={owner} hostId={state.selectedHostId} available={authenticated} />}{authenticated && owner.roomShare && <Button onClick={event => { openShare(event.currentTarget); }}>{i18n.language.startsWith('zh') ? '分享房间' : 'Share room'}</Button>}{!login && !remote.enabled && <Button variant="quiet" onClick={() => { setPreferencesTrigger(null); owner.logout(); navigate(liveHref); }}><Icon name="logout" />{t('logout')}</Button>}</section>
  </>;
  const header = <>
      <div className={styles.brand}><h1>{t('appName')}</h1><span>{t('workspaceLabel')}</span></div>
      {!login && !owner.publicRoomMode && <span className={styles.room} title={t('room')}>{roomId ?? state.connection.roomId}</span>}
      <div className={styles.utilities}>
        {owner.publicRoomMode&&<CafeIdentityMenu owner={owner}/>}
        <nav className={styles.language} aria-label={t('language')}><Button variant="quiet" aria-pressed={i18n.language.startsWith('zh')} onClick={() => void i18n.changeLanguage('zh-CN')}>中文</Button><Button variant="quiet" aria-pressed={!i18n.language.startsWith('zh')} onClick={() => void i18n.changeLanguage('en')}>English</Button></nav>
        <IconButton label={t(theme === 'dark' ? 'switchToLight' : 'switchToDark')} onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></IconButton>
        <span className={styles.connection} role="status" data-status={state.connection.status}><i aria-hidden="true" />{t(`connection.${state.connection.status}`)}</span>
        {authenticated && owner.roomShare && <Button ref={shareButton} variant="quiet" aria-label={i18n.language.startsWith('zh') ? '分享房间' : 'Share room'} onClick={event => openShare(event.currentTarget)}><Icon name="share" />{i18n.language.startsWith('zh') ? '分享房间' : 'Share room'}{localOwner && pendingControls > 0 && <span> · {pendingControls}</span>}</Button>}
        {!login && <Button className={styles.logout} variant="quiet" onClick={() => { owner.logout(); navigate(liveHref); }}><Icon name="logout" />{t('logout')}</Button>}
      </div>
      {preferencesButton}
    </>;
  return <main className={styles.shell} lang={i18n.resolvedLanguage ?? 'zh-CN'} data-theme={theme} data-surface="workspace"><UiProvider>
    {(login || roomWaiting || !route.valid || switchingRoom) && <header className={styles.header}>{header}</header>}
    {!route.valid ? <p className={styles.routeError} role="alert">{t('invalidRoute')}</p> : (login || roomWaiting) ? <div className={`${styles.loginStage} ${owner.publicRoomMode ? setupStyles.stage : ''}`}>{owner.publicRoomMode && publicRoute ? <RoomLogin key={publicRoute.key} owner={owner} roomKey={publicRoute.key} /> : <section className={styles.empty}><p className={styles.eyebrow}>{t('loginEyebrow')}</p><h2>{t('loginTitle')}</h2><p className={styles.loginHelp}>{t('loginHelp')}</p>{remote.enabled ? <RemoteLogin key={base} owner={owner} {...(roomId ? { roomId } : {})} onLogin={room => navigate(loginDestination(room), { replace: true })} /> : <LoginForm key={base} owner={owner} defaultRoom={defaultRoom} {...(roomId ? { roomId } : {})} onLogin={room => navigate(loginDestination(room), { replace: true })} />}<p className={styles.loginFootnote}><Icon name="lock" />{t('description')}</p></section>}</div> : switchingRoom ? <p role="status">{t('connection.connecting')}</p> : <WorkspaceLayout header={header} mobileTitle={mobileTitle} mobileSubtitle={mobileSubtitle} mobileActions={mobileRoomActions} sidebar={<div className={styles.sidebar}><RemoteDevicePanel owner={owner}/><div className={styles.sessionHeading}><h2>{t('sessions')}</h2><SessionActions owner={owner} roomBase={base} /><Button variant="quiet" aria-label={i18n.language.startsWith('zh') ? '启动独立 Pi 实例' : 'Start independent Pi instance'} onClick={event=>managed.openNew(event.currentTarget)} disabled={!authenticated}><Icon name="plus" />{i18n.language.startsWith('zh') ? '新实例' : 'New instance'}</Button></div>
        <div className={styles.search}><Icon name="search" /><Input type="search" aria-label={t('searchSessions')} placeholder={t('searchSessions')} value={search} maxLength={256} onChange={event => setSearch(event.target.value)} />{search && <IconButton label={t('clearSearch')} onClick={() => setSearch('')}><Icon name="close" /></IconButton>}</div>
        <div className={styles.sectionHeading}><h2>{t('activeSessions')}</h2><span>{state.hosts.size}</span></div>
        <div className={styles.hostList}>{[...state.hosts.values()].filter(host => [host.info.sessionName, host.info.hostId, host.info.cwd].some(value => value?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))).map(host => <Button variant="quiet" data-close-drawer className={styles.host} type="button" key={host.info.hostId} aria-pressed={state.selectedHostId === host.info.hostId} onClick={() => { owner.selectHost(host.info.hostId); if (location.pathname !== liveHref) navigate(liveHref); }}>
          <span className={styles.hostIdentity}><Icon name="hosts" /><strong>{host.info.sessionName ?? host.info.hostId}</strong></span><small title={host.info.cwd ?? host.info.hostId}>{host.info.cwd || host.info.hostId}</small><span className={styles.hostState} data-ready={host.info.connected && !host.stale}><i aria-hidden="true" />{t(!host.info.connected ? 'offline' : host.stale ? 'hostSynchronizing' : 'online')}</span>
        </Button>)}</div>
        {state.hosts.size === 0 && <p className={styles.sidebarHint}>{t('noHosts')}<br />{t('noHostsHelp')}</p>}
        <ManagedSessionList control={managed} query={search} />
        <HistoryList key={state.viewGeneration} owner={owner} roomBase={base} query={search} />
        <p className={styles.sidebarFootnote}><Icon name="lock" />{t('sessionOwnership')}</p>
      </div>} files={<FilesPane key={state.viewGeneration} owner={owner} />}>
      <Routes location={{ ...location, pathname: pagePath }}><Route path="/" element={<Workspace owner={owner} roomBase={base} onNewSession={managed.openNew} />}  /><Route path="/history/:sessionId" element={<section className={styles.center}>{state.selectedHostId && <RemoteControlBar owner={owner} hostId={state.selectedHostId} available={authenticated && state.hosts.get(state.selectedHostId)?.info.connected === true && !state.hosts.get(state.selectedHostId)?.stale}/>}<HistoryDetail owner={owner} roomBase={base} /></section>} /><Route path="*" element={<p>{t('invalidRoute')}</p>} /></Routes>
    </WorkspaceLayout>}
    {preferencesTrigger && <Drawer label={i18n.language.startsWith('zh') ? '更多选项' : 'More options'} closeLabel={t('close')} restoreFocusTo={preferencesTrigger} onClose={() => setPreferencesTrigger(null)}><div className={styles.preferencesPanel}>{preferences}</div></Drawer>}
    {localOwner && pendingControls > 0 && !shareTrigger && <div className={styles.overlay} role="status"><Button variant="quiet" onClick={event => openShare(event.currentTarget,'settings')}>{i18n.language.startsWith('zh') ? `${pendingControls} 个控制权申请待你审批` : `${pendingControls} control requests need your approval`}</Button></div>}
    <ManagedSessionDialog control={managed} />
    {shareTrigger && authenticated && owner.roomShare && <RoomShare owner={owner} trigger={shareTrigger} onClose={closeShare} initialTab={shareTab} control={localOwner ? localControl : undefined} />}
    {!authenticated && !login && !owner.publicRoomMode && <p className={styles.overlay} role="status">{t('reconnectingHint')}</p>}
    {state.notices.length > 0 && <details className={styles.notices}><summary>{t('notices')} ({state.notices.length})</summary><ol>{state.notices.map(notice => <li key={notice.id}><code>{notice.code}</code> {notice.text !== notice.code ? notice.text : t(`errors.${notice.code}`, { defaultValue: t('commandRejected') })}</li>)}</ol></details>}
  </UiProvider></main>;
}
function OwnedApp({ createOwner }: { createOwner: () => AppOwner }) {
  useMobileViewport();
  const location = useLocation(); const { i18n } = useTranslation(); const zh = i18n.language.startsWith('zh');
  const [retry, setRetry] = useState(0);
  const [failed, setFailed] = useState(false);
  const currentPath = useRef(location.pathname); currentPath.current = location.pathname;
  const [owner, setOwner] = useState<AppOwner | null>(null);
  const [defaultRoom, setDefaultRoom] = useState('main');
  const [managedSessions, setManagedSessions] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);
  useEffect(() => {
    const next = createOwner(); let active = true; setOwner(null); setFailed(false);
    const initialRoute = parseRoomRoute(currentPath.current);
    void next.initialize(initialRoute.valid ? initialRoute.roomId ?? undefined : null).then(config => {
      if (!active) return;
      if (!config) { setFailed(true); return; }
      setDefaultRoom(config.defaultRoom); setManagedSessions(config.managedSessions === true); setSetupRequired(config.setupRequired === true); setOwner(next);
    });
    return () => { active = false; next.dispose(); };
  }, [createOwner, retry]);
  if (!owner) return <main className={styles.shell} data-theme="dark"><section className={styles.empty}>
    <h1>Pi Cafe Space</h1><p role={failed ? 'alert' : 'status'}>{failed ? (zh ? '无法读取服务配置，请确认服务在线后重试。' : 'Could not load the service configuration. Check that the service is online and retry.') : (zh ? '正在连接工作空间…' : 'Connecting to your workspace…')}</p>
    {failed && <Button onClick={() => setRetry(value => value + 1)}>{zh ? '重试' : 'Retry'}</Button>}
  </section></main>;
  if (setupRequired) return <main className={styles.shell} data-theme="dark" data-surface="workspace"><UiProvider>
    <header className={styles.header}><div className={styles.brand}><h1>Café Space</h1></div><nav className={`${styles.language} ${setupStyles.language}`} aria-label={zh ? '语言' : 'Language'}><Button variant="quiet" aria-pressed={zh} onClick={() => void i18n.changeLanguage('zh-CN')}>中文</Button><Button variant="quiet" aria-pressed={!zh} onClick={() => void i18n.changeLanguage('en')}>English</Button></nav></header>
    <div className={`${styles.loginStage} ${setupStyles.stage}`}><section className={setupStyles.card} aria-labelledby="cafe-setup-title"><p className={setupStyles.eyebrow}>{zh ? '首次使用' : 'FIRST-TIME SETUP'}</p><h2 className={setupStyles.title} id="cafe-setup-title">{zh ? '初始化访问令牌' : 'Set up your access token'}</h2>
      <SetupForm onRefresh={() => setRetry(value => value + 1)} onComplete={token => { owner.storage.set('token', token); setRetry(value => value + 1); }} />
    </section></div>
  </UiProvider></main>;
  if (owner.publicRoomMode && ['/auth/complete','/auth/cancelled','/auth/signed-out'].includes(location.pathname)) return <main className={styles.shell} data-theme="dark" data-surface="workspace"><UiProvider><div className={styles.loginStage}><CafeLoginCallback owner={owner}/></div></UiProvider></main>;
  if (owner.publicRoomMode && !publicRoomPath(location.pathname)) return <PublicRoomHome owner={owner} />;
  return <Shell owner={owner} defaultRoom={defaultRoom} managedSessions={managedSessions} />;
}
function PublicRoomHome({ owner }: { owner: AppOwner }) {
  const { i18n } = useTranslation();
  useEffect(() => { owner.logout(); }, [owner]);
  return <main className={styles.shell} data-theme="dark" data-surface="workspace"><UiProvider>
    <header className={styles.header}><div className={styles.brand}><h1>Café Space</h1></div><nav className={`${styles.language} ${setupStyles.language}`}><Button variant="quiet" onClick={() => void i18n.changeLanguage('zh-CN')}>中文</Button><Button variant="quiet" onClick={() => void i18n.changeLanguage('en')}>English</Button></nav></header>
    <div className={`${styles.loginStage} ${setupStyles.stage}`}><RoomLanding owner={owner} /></div>
  </UiProvider></main>;
}
export function App({ createOwner = defaultFactory }: { createOwner?: () => AppOwner }) {
  return <HashRouter><OwnedApp createOwner={createOwner} /></HashRouter>;
}
