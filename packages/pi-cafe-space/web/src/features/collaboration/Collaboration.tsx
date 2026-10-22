import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Tabs } from '@base-ui/react/tabs';
import { Button, IconButton, Input, Label, Textarea } from '../../components/ui/Controls';
import { UiProvider } from '../../components/ui/UiProvider';
import { Drawer } from '../../components/ui/Drawer';
import { Icon } from '../../components/ui/Icon';
import { aiInstructions, checkStorage, collaboration, CollaborationError, forgetMembership, membership, saveMembership, type AiMode, type Member, type Membership, type Message, type Presence, type Snapshot, type Task, type TaskStatus } from './api';
import { MessageText } from './MessageText';
import { templateTaskId, templates, type Template } from './templates';
import { probeBlocked, probeCode, probeOf, probesOf, probeText } from './probe';
import styles from './Collaboration.module.scss';

const messageError = (error: unknown) => error instanceof Error ? error.message : '连接失败，请重试。';
// Connectors heartbeat at least every 30s while idle; allow for one missed beat.
const onlineWindow = 90_000;
const ago = (ms: number) => ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : `${Math.round(ms / 3_600_000)} 小时`;
const clock = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const day = (at: string) => new Date(at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const excerpt = (text: string, max = 48) => { const flat = text.replace(/\s+/g, ' ').trim(); return [...flat].length > max ? [...flat].slice(0, max).join('') + '…' : flat; };
const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
// Six warm tones keep avatars distinguishable without turning the room into a rainbow.
const tone = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6;
/** Presence is the connector's own report: absent means unknown, never failure. */
export function connectorState(presence: Presence | undefined, now: number): { label: string; tone: 'online' | 'paused' | 'offline' | 'unknown' } {
  if (!presence) return { label: '未接入连接器', tone: 'unknown' };
  const age = now - Date.parse(presence.heartbeatAt);
  if (!(age < onlineWindow)) return { label: `离线 · ${ago(age)}前在线`, tone: 'offline' };
  return presence.paused ? { label: '在线 · 已暂停', tone: 'paused' } : { label: '在线', tone: 'online' };
}
/** Delivery of a message addressed to an AI; null when nothing honest can be said. */
export function deliveryOf(message: Message, members: Member[], messages: Message[], presence: Record<string, Presence> = {}): { state: 'replied' | 'delivered' | 'fetched' | 'waiting'; label: string } | null {
  const target = members.find(m => m.id === message.to);
  if (!target || target.kind !== 'ai') return null;
  if (messages.some(m => m.memberId === target.id && m.replyTo === message.seq)) return { state: 'replied', label: `${target.name} 已回复` };
  const report = presence[target.id];
  if (!report) return null;
  if (report.delivered >= message.seq) return { state: 'delivered', label: `已送入 ${target.name} 的会话（连接器上报，不代表已读）` };
  if (report.fetched >= message.seq) return { state: 'fetched', label: `${target.name} 的连接器已取到` };
  return { state: 'waiting', label: `等待 ${target.name} 的连接器` };
}
/** AIs whose connector delivered the latest message addressed to them and that have not answered since.
 * Delivery proves the connector handed the message on, not that the host woke up, so the UI says "waiting". */
export function thinkingOf(members: Member[], messages: Message[], presence: Record<string, Presence> = {}, now = Date.now()): Member[] {
  return members.filter(m => {
    if (m.kind !== 'ai' || m.removed || connectorState(presence[m.id], now).tone !== 'online') return false;
    const ask = [...messages].reverse().find(x => x.to === m.id);
    return !!ask && presence[m.id]!.delivered >= ask.seq && !messages.some(x => x.memberId === m.id && x.seq > ask.seq);
  });
}
function Avatar({ member, fallback, presence, small }: { member?: Member; fallback: string; presence?: string; small?: boolean }) {
  const initial = [...(member?.name ?? fallback).trim()][0] ?? '?';
  return <span className={styles.avatar} data-tone={tone(member?.id ?? fallback)} data-kind={member?.kind ?? 'human'} data-presence={presence} data-small={small} aria-hidden="true">{initial.toUpperCase()}</span>;
}
/** A small anchored menu: focus moves into it, arrows move between items, Escape or an outside press closes it. */
function RoomMenu({ label, disabled, buttonRef, children }: { label: string; disabled?: boolean; buttonRef: React.RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  const [open, setOpen] = useState(false); const root = useRef<HTMLDivElement>(null);
  const items = () => [...(root.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)') ?? [])];
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close); items()[0]?.focus();
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return <div ref={root} className={styles.menuWrap} onKeyDown={event => {
    if (!open) return;
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); buttonRef.current?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const list = items(); const index = list.indexOf(document.activeElement as HTMLButtonElement); list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus(); }
  }}>
    <button ref={buttonRef} type="button" className={styles.menuTrigger} aria-label={label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}><Icon name="more" /></button>
    {open && <div role="menu" aria-label={label} className={styles.menu} onClick={event => { if ((event.target as Element).closest('[role=menuitem]')) setOpen(false); }}>{children}</div>}
  </div>;
}
function Steam() {
  return <svg className={styles.steam} viewBox="0 0 30 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M8 16c-4-3 3-5-1-9" /><path d="M15 16c-4-3 3-5-1-9" /><path d="M22 16c-4-3 3-5-1-9" /></svg>;
}

export function Collaboration() {
  const location = useLocation();
  const match = /^\/collab\/([a-f0-9]{32})$/.exec(location.pathname);
  return <main lang="zh-CN" className={styles.page} data-theme="dark" data-surface="workspace"><UiProvider>
    <header className={styles.header}>
      <Link to="/collab" className={styles.brand}>Café Space <span>协作</span></Link>
      <nav className={styles.nav}><Link to="/">电脑房间</Link></nav>
    </header>
    {match ? <Room key={match[1]} id={match[1]!} invite={new URLSearchParams(location.search).get('invite') ?? ''} /> : location.pathname === '/collab' ? <Create /> : <section className={styles.card}><h1>无效的协作链接</h1><p className={styles.note}>请检查链接是否完整，或向邀请人索取新的链接。</p><Link to="/collab">返回协作首页</Link></section>}
  </UiProvider></main>;
}

function Create() {
  const navigate = useNavigate();
  const [name, setName] = useState(''); const [title, setTitle] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null); const [retention, setRetention] = useState(7);
  useEffect(() => { const abort = new AbortController(); void collaboration<{ enabled: boolean; retentionDays?: number }>({ op: 'status' }, undefined, abort.signal).then(v => { setEnabled(v.enabled); if (Number.isInteger(v.retentionDays) && v.retentionDays! > 0) setRetention(v.retentionDays!); }, () => { if (!abort.signal.aborted) setEnabled(false); }); return () => abort.abort(); }, []);
  return <section className={styles.landing}>
    <div className={styles.pitch}>
      <p className={styles.eyebrow}>PEOPLE + AI</p>
      <h1>一起讨论，不限工具。</h1>
      <p className={styles.lead}>同事和各自的 AI 在同一个房间里讨论、分工、推进。AI 通过 HTTPS 加入，不需要安装 Space，也不开放任何人的电脑。</p>
      <ul className={styles.facts}>
        <li><Icon name="share" /><div><strong>邀请即加入</strong><span>链接发给同事或 AI，确认后直接进入。</span></div></li>
        <li><Icon name="check" /><div><strong>任务板</strong><span>把讨论变成任务，指派给人或 AI，看得见进度。</span></div></li>
        <li><Icon name="lock" /><div><strong>边界清楚</strong><span>只共享房间里的内容，房主随时可以暂停 AI 或关闭房间。</span></div></li>
      </ul>
    </div>
    <form className={styles.formCard} onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try { checkStorage(); const value = await collaboration<Membership>({ op: 'create', title: title.trim(), name: name.trim(), kind: 'human' }); saveMembership(value); navigate('/collab/' + value.roomId); }
      catch (e) { setError(messageError(e)); } finally { setBusy(false); }
    })(); }}>
      <h2>新建房间</h2>
      <div className={styles.field}><Label htmlFor="collab-title">房间名称</Label><Input id="collab-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} required placeholder="例如：Space 发布讨论" /></div>
      <div className={styles.field}><Label htmlFor="collab-name">你的名称</Label><Input id="collab-name" value={name} onChange={e => setName(e.target.value)} maxLength={48} required autoComplete="nickname" placeholder="其他成员看到的称呼" /></div>
      <p className={styles.note}>消息以明文保存在云端，{retention} 天后到期。请勿发送密钥或敏感资料。</p>
      <Button type="submit" variant="primary" loading={busy} disabled={enabled !== true}>创建协作房间</Button>
      {enabled === false && <p className={styles.formError} role="alert">协作服务暂不可用，请稍后再试；电脑房间不受影响。</p>}
      {error && <p className={styles.formError} role="alert">{error}</p>}
    </form>
  </section>;
}

function Room({ id, invite }: { id: string; invite: string }) {
  const navigate = useNavigate(); const [auth, setAuth] = useState(() => membership(id));
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (auth) return <Discussion auth={auth} onForget={() => { forgetMembership(id); setAuth(null); }} />;
  return <section className={styles.card}>
    <p className={styles.eyebrow}>INVITATION</p>
    <h1>加入协作房间</h1>
    <p className={styles.lead}>加入后可以查看已有讨论、发言和认领任务。名称由你自己填写，不代表已验证的身份。</p>
    {!/^[a-f0-9]{64}$/.test(invite) ? <p className={styles.formError} role="alert">请向邀请人索取完整的邀请链接；此浏览器没有保存这个房间的成员凭据。</p> : <form className={styles.joinForm} onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try { checkStorage(); const value = await collaboration<Membership>({ op: 'join', roomId: id, invite, name: name.trim(), kind: 'human' }); saveMembership(value); setAuth(value); navigate('/collab/' + id, { replace: true }); }
      catch (e) { setError(messageError(e)); } finally { setBusy(false); }
    })(); }}>
      <div className={styles.field}><Label htmlFor="join-name">你的名称</Label><Input id="join-name" maxLength={48} value={name} onChange={e => setName(e.target.value)} required autoComplete="nickname" /></div>
      <p className={styles.note}>不会连接或操作你的电脑。成员凭据只保存在当前浏览器，请不要在共用设备上加入。</p>
      <Button variant="primary" type="submit" loading={busy}>同意并加入</Button>
      {error && <p className={styles.formError} role="alert">{error}</p>}
    </form>}
    {invite && <AiInvitation link={window.location.origin + '/#/collab/' + id + '?invite=' + invite} />}
  </section>;
}

function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return <Button onClick={() => { setCopied(false); void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }}><Icon name={copied ? 'check' : 'copy'} />{copied ? done : label}</Button>;
}
function AiInvitation({ link }: { link: string }) {
  const [mode, setMode] = useState<AiMode>('listen'); const text = aiInstructions(link, mode);
  return <details className={styles.aiInvite}><summary>让我的 AI 加入 · 无需安装</summary>
    <div className={styles.hosts} role="radiogroup" aria-label="你的 AI 怎样参与">
      {([['listen', '持续参与讨论'], ['task', '完成一项任务']] as const).map(([value, label]) => <button key={value} type="button" role="radio" aria-checked={mode === value} className={styles.host} onClick={() => setMode(value)}>{label}</button>)}
    </div>
    <p>{mode === 'listen' ? '需要能在后台运行任务、有新消息时唤醒 AI 的客户端，例如 Claude Code；接通后成员列表显示“在线”。其他客户端只在你提醒时读取房间。' : '适合任何能发 HTTPS JSON 请求的 AI：加入、完成你指定的任务、交付结果后结束，不需要后台监听。'}</p>
    <Textarea aria-label="AI 接入说明" value={text} readOnly rows={7} />
    <div className={styles.row}><CopyButton text={text} label="复制 AI 接入说明" done="说明已复制" /><a href="/api/collaboration/guide" target="_blank" rel="noreferrer">查看 HTTP 协议</a></div>
  </details>;
}

const statusOrder: [TaskStatus, string][] = [['doing', '进行中'], ['todo', '待办'], ['done', '已完成']];
const nextStatus: Record<TaskStatus, TaskStatus> = { todo: 'doing', doing: 'done', done: 'todo' };
const statusAction: Record<TaskStatus, string> = { todo: '开始', doing: '完成', done: '重新打开' };
type Confirm = { op: string; fields?: Record<string, unknown>; label: string; action: string };

function Discussion({ auth, onForget }: { auth: Membership; onForget: () => void }) {
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState(''); const [connected, setConnected] = useState(false); const [terminal, setTerminal] = useState(false); const [busy, setBusy] = useState(false);
  const [text, setText] = useState(''); const [to, setTo] = useState(''); const [reply, setReply] = useState(0); const [link, setLink] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false); const [sideOpen, setSideOpen] = useState(false); const [tab, setTab] = useState<'tasks' | 'people'>('tasks');
  const [confirm, setConfirm] = useState<Confirm | null>(null); const [privacyOpen, setPrivacyOpen] = useState(false); const [draft, setDraft] = useState(''); const [applying, setApplying] = useState(''); const [probing, setProbing] = useState(''); const [notice, setNotice] = useState('');
  // Touch screens have no hover: tapping a bubble reveals that message's actions.
  const [selected, setSelected] = useState(0);
  const cursor = useRef(0); const freshFrom = useRef<number | null>(null); const pending = useRef<{ id: string; text: string; to: string; replyTo: number } | null>(null);
  const bottom = useRef<HTMLDivElement>(null); const follow = useRef(true); const inviteButton = useRef<HTMLButtonElement>(null); const sideButton = useRef<HTMLButtonElement>(null); const menuButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>; let stopped = false;
    const poll = async () => {
      let delay = 5000;
      try {
        const value = await collaboration<Snapshot>({ op: 'read', roomId: auth.roomId, after: cursor.current }, auth.token, abort.signal);
        if (stopped) return; setSnapshot(value); setConnected(true); cursor.current = value.cursor; freshFrom.current ??= value.cursor;
        setMessages(old => { const seen = new Set(old.map(m => m.seq)); return [...old, ...value.messages.filter(m => !seen.has(m.seq))].sort((a, b) => a.seq - b.seq); });
        if (value.more) delay = 0;
      } catch (e) {
        if (stopped) return; setConnected(false); setError(messageError(e));
        if (e instanceof CollaborationError && ['MEMBER_REQUIRED', 'ROOM_CLOSED', 'ROOM_UNAVAILABLE'].includes(e.code)) { setTerminal(true); return; }
        delay = 60000;
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    };
    void poll(); return () => { stopped = true; abort.abort(); clearTimeout(timer); };
  }, [auth]);
  useEffect(() => { if (follow.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(timer); }, [notice]);
  const call = async <T,>(fields: Record<string, unknown>) => collaboration<T>({ roomId: auth.roomId, ...fields }, auth.token);
  const act = async (op: string, fields: Record<string, unknown> = {}) => {
    setBusy(true); setError('');
    try {
      const value = await call<{ url?: string }>({ op, ...fields });
      if (op === 'invite' && value.url) setLink(value.url);
      if (op === 'revoke') { setLink(''); setInviteOpen(false); setNotice('已撤销全部邀请'); }
      if (op === 'close' || op === 'leave') { onForget(); navigate('/collab'); }
      if (op === 'remove') setSnapshot(old => old ? { ...old, members: old.members.map(m => m.id === fields.memberId ? { ...m, removed: true } : m) } : old);
      if (op === 'pause') setSnapshot(old => old ? { ...old, aiPaused: fields.paused === true } : old);
    } catch (e) { setError(messageError(e)); } finally { setBusy(false); setConfirm(null); }
  };
  const taskAct = async (fields: Record<string, unknown>, done?: string) => {
    setError('');
    try {
      const value = await call<Task | { ok: true }>({ op: 'task', ...fields });
      setSnapshot(old => {
        if (!old) return old; const tasks = old.tasks ?? [];
        if (fields.action === 'delete') return { ...old, tasks: tasks.filter(t => t.id !== fields.taskId) };
        const task = value as Task; return { ...old, tasks: tasks.some(t => t.id === task.id) ? tasks.map(t => t.id === task.id ? task : t) : [...tasks, task] };
      });
      if (done) setNotice(done);
      return true;
    } catch (e) { setError(messageError(e)); return false; }
  };
  const send = () => { if (busy || terminal || !text.trim()) return; void (async () => {
    const message = { text: text.trim(), to, replyTo: reply };
    if (!pending.current || pending.current.text !== message.text || pending.current.to !== to || pending.current.replyTo !== reply) pending.current = { ...message, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { const sent = await call<Message>({ op: 'send', ...pending.current });
      setMessages(old => old.some(m => m.seq === sent.seq) ? old : [...old, sent].sort((a, b) => a.seq - b.seq)); setText(''); setReply(0); setTo(''); pending.current = null; follow.current = true;
    } catch (e) { setError(messageError(e)); } finally { setBusy(false); }
  })(); };
  const probe = (ai: Member) => { if (probing) return; setProbing(ai.id); setError(''); void (async () => {
    try { const sent = await call<Message>({ op: 'send', id: crypto.randomUUID(), text: probeText(probeCode()), to: ai.id });
      setMessages(old => old.some(m => m.seq === sent.seq) ? old : [...old, sent].sort((a, b) => a.seq - b.seq)); follow.current = true; setNotice(`已向 ${ai.name} 发出响应测试`);
    } catch (e) { setError(messageError(e)); } finally { setProbing(''); }
  })(); };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop chat convention; touch keyboards keep Enter for new lines and use the send button.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && !coarse) { event.preventDefault(); send(); }
  };
  const members = snapshot?.members ?? []; const active = members.filter(m => !m.removed); const presence = snapshot?.presence ?? {};
  const own = members.find(m => m.id === auth.memberId); const owner = !!own?.owner;
  const memberOf = (memberId?: string) => members.find(m => m.id === memberId);
  const nameOf = (memberId: string) => memberOf(memberId)?.name ?? '已离开的成员';
  const now = Date.now(); const tasks = snapshot?.tasks ?? []; const openTasks = tasks.filter(t => t.status !== 'done').length;
  const presenceOf = (m: Member) => m.kind === 'ai' ? connectorState(presence[m.id], now).tone : undefined;
  const thinking = thinkingOf(members, messages, presence, now);
  const probes = probesOf(messages, members, now);
  // Tests and bare answers to them collapse into one line each; an answer with more to say stays a message.
  const compact = (message: Message) => !!probeOf(message, members) || probes.answers.has(message.seq) && message.text.trim().length <= 16;
  const jump = (seq: number) => { const target = document.getElementById(`msg-${seq}`); target?.scrollIntoView({ block: 'center', behavior: 'smooth' }); target?.animate?.([{ backgroundColor: 'var(--collab-highlight)' }, { backgroundColor: 'transparent' }], { duration: 1600 }); setSideOpen(false); };
  const openSide = (next: 'tasks' | 'people') => { setTab(next); if (narrow()) setSideOpen(true); };
  const openInvite = () => { setInviteOpen(true); if (!link) void act('invite'); };
  const addTask = (event: FormEvent) => { event.preventDefault(); const title = draft.trim(); if (!title) return; void taskAct({ action: 'create', id: crypto.randomUUID(), title }).then(ok => { if (ok) setDraft(''); }); };
  const applyTemplate = async (template: Template) => {
    setApplying(template.key); let added = 0;
    for (const [index, title] of template.tasks.entries()) { if (!await taskAct({ action: 'create', id: templateTaskId(template, index), title })) break; added++; }
    setApplying(''); if (added === template.tasks.length) setNotice(`已添加「${template.label}」的 ${added} 项任务`);
  };
  const fromMessage = (message: Message) => void taskAct({ action: 'create', id: crypto.randomUUID(), title: excerpt(message.text, 80), from: message.seq, ...(memberOf(message.to)?.kind === 'ai' ? { assignee: message.to } : {}) }, '已加入任务板').then(ok => { if (ok) setTab('tasks'); });

  const board = (): ReactNode => {
    const done = tasks.filter(t => t.status === 'done').length;
    return <div className={styles.board}>
      <div className={styles.boardHead}><p><strong>{done}</strong> / {tasks.length} 已完成</p><progress aria-label="任务完成度" value={done} max={Math.max(tasks.length, 1)} /></div>
      <form className={styles.addTask} onSubmit={addTask}><Icon name="plus" /><Input aria-label="新任务" placeholder="添加任务，回车保存" value={draft} maxLength={200} disabled={terminal || !snapshot} onChange={e => setDraft(e.target.value)} /></form>
      {tasks.length === 0 && <div className={styles.boardEmpty}><p>还没有任务。把讨论里的事项“转为任务”，或从一套清单开始：</p>
        <div className={styles.templates}>{templates.map(t => <button key={t.key} type="button" className={styles.template} disabled={terminal || !snapshot || !!applying} aria-busy={applying === t.key} onClick={() => void applyTemplate(t)}><strong>{t.label}</strong><span>{t.hint}</span></button>)}</div>
      </div>}
      {statusOrder.map(([status, label]) => { const items = tasks.filter(t => t.status === status); return items.length > 0 && <section key={status} className={styles.taskGroup} data-status={status}>
        <h3>{label}<span>{items.length}</span></h3>
        <ul>{items.map(task => {
          // Mirrors the server: status belongs to the assignee, creator and owner; anyone may claim an unassigned task.
          const assignee = memberOf(task.assignee); const privileged = owner || task.createdBy === auth.memberId; const mineTask = task.assignee === auth.memberId;
          const canMove = privileged || mineTask; const canClaim = !task.assignee && !canMove;
          const choices = privileged ? active : mineTask || !task.assignee ? active.filter(m => m.id === auth.memberId) : [];
          return <li key={task.id} className={styles.task} data-status={task.status}>
          <button type="button" className={styles.check} data-status={task.status} aria-label={canClaim ? `认领「${task.title}」` : `${statusAction[task.status]}「${task.title}」`} title={!canMove && !canClaim ? `由 ${assignee?.name ?? '负责人'} 推进` : undefined} disabled={terminal || (!canMove && !canClaim)}
            onClick={() => void taskAct(canClaim ? { action: 'update', taskId: task.id, assignee: auth.memberId, status: 'doing', onlyIfUnassigned: true } : { action: 'update', taskId: task.id, status: nextStatus[task.status] })}>{task.status === 'done' && <Icon name="check" />}</button>
          <div className={styles.taskMain}><p>{task.title}</p>
            {(task.from || task.result) ? <p className={styles.taskLinks}>{task.from ? <button type="button" className={styles.taskSource} onClick={() => jump(task.from!)}>来自 #{task.from}</button> : null}{task.result ? <button type="button" className={styles.taskSource} data-result onClick={() => jump(task.result!)}>{task.status === 'done' ? '结果' : '上次结果'} #{task.result} · {nameOf(task.resultBy ?? '')}</button> : null}</p> : null}</div>
          <span className={styles.assignee} title={assignee ? `负责人：${assignee.name}` : '未指派'}>
            {assignee ? <Avatar member={assignee} fallback={assignee.id} small /> : <span className={styles.unassigned}><Icon name="plus" /></span>}
            {choices.length > 0 && <select aria-label={`「${task.title}」的负责人`} value={task.assignee && !assignee?.removed ? task.assignee : ''} disabled={terminal} onChange={e => void taskAct({ action: 'update', taskId: task.id, assignee: e.target.value, ...(!privileged && e.target.value === auth.memberId ? { onlyIfUnassigned: true } : {}) })}><option value="">未指派</option>{choices.map(m => <option key={m.id} value={m.id}>{m.name}{m.kind === 'ai' ? '（AI）' : ''}</option>)}</select>}
          </span>
          {(owner || task.createdBy === auth.memberId) && <IconButton label={`删除任务「${task.title}」`} variant="quiet" className={styles.taskDelete} disabled={terminal} onClick={() => void taskAct({ action: 'delete', taskId: task.id })}><Icon name="close" /></IconButton>}
        </li>; })}</ul>
      </section>; })}
    </div>;
  };
  const people = (): ReactNode => <ul className={styles.people}>{active.map(m => { const state = m.kind === 'ai' ? connectorState(presence[m.id], now) : null; const report = presence[m.id]; return <li key={m.id}>
    <Avatar member={m} fallback={m.id} presence={presenceOf(m)} />
    <div className={styles.person}>
      <p className={styles.personName}><strong>{m.name}</strong>{m.id === auth.memberId && <span className={styles.you}>你</span>}</p>
      <p className={styles.meta}>{m.owner ? '房主' : m.kind === 'ai' ? 'AI' : '成员'}{state && <> · <span className={styles.connector} data-tone={state.tone} title={report ? `连接器上报：已取到 #${report.fetched}，已送入会话 #${report.delivered}` : '这个 AI 还没有用连接器上报状态'}>{state.label}</span></>}</p>
      {state?.tone === 'unknown' && <p className={styles.hint}>它没有上报后台监听，只在被提醒时读取房间。需要持续参与时，按“邀请 → 让我的 AI 加入 → 持续参与讨论”的说明启动监听。</p>}
      {state?.tone === 'offline' && <p className={styles.hint}>后台监听已停止。让它重新启动监听后会恢复在线。</p>}
      {m.kind === 'ai' && (() => { const last = probes.latest.get(m.id); const blocked = snapshot?.aiPaused ? 'AI 发言已暂停' : probeBlocked(last, probes.recent.get(m.id) ?? 0, now);
        return (last || own?.kind === 'human') && <p className={styles.probe}>
          {last && <span data-state={last.state} title="只说明这一次在房间里往返成功，不代表持续在线或会自动处理">{last.label}</span>}
          {own?.kind === 'human' && <button type="button" className={styles.probeButton} disabled={!!blocked || !!probing || terminal} title={blocked || '发一条带验证码的消息，看它多久回复'} onClick={() => probe(m)}>{probing === m.id ? '正在发出…' : last ? '再测一次' : '测试响应'}</button>}
        </p>; })()}
    </div>
    {owner && !m.owner && <IconButton label={`移除 ${m.name}`} variant="quiet" className={styles.remove} disabled={busy || terminal} onClick={() => setConfirm({ op: 'remove', fields: { memberId: m.id }, label: `移除 ${m.name}？若其仍持有效邀请，可能重新加入；必要时撤销全部邀请。`, action: '移除' })}><Icon name="close" /></IconButton>}
  </li>; })}</ul>;
  const side = (): ReactNode => <Tabs.Root value={tab} onValueChange={value => setTab(value as 'tasks' | 'people')} className={styles.sideTabs}>
    <Tabs.List className={styles.tabs} aria-label="任务与成员"><Tabs.Tab value="tasks" className={styles.tab}>任务{openTasks > 0 && <span>{openTasks}</span>}</Tabs.Tab><Tabs.Tab value="people" className={styles.tab}>成员<span>{active.length}</span></Tabs.Tab><Tabs.Indicator className={styles.tabIndicator} /></Tabs.List>
    <Tabs.Panel value="tasks" className={styles.tabPanel}>{board()}</Tabs.Panel>
    <Tabs.Panel value="people" className={styles.tabPanel}>{people()}</Tabs.Panel>
  </Tabs.Root>;

  return <section className={styles.room}>
    <header className={styles.toolbar}>
      <div className={styles.titleBlock}>
        <h1>{snapshot?.title ?? '正在读取房间…'}</h1>
        {(!connected || terminal) && <p role="status" className={styles.connection}>{terminal ? '房间或成员已不可用' : '正在连接…'}</p>}
      </div>
      <div className={styles.toolbarActions}>
        <button type="button" className={styles.stack} aria-label={`成员 · ${active.length}`} disabled={!snapshot} onClick={() => openSide('people')}>{active.slice(0, 4).map(m => <Avatar key={m.id} member={m} fallback={m.id} presence={presenceOf(m)} small />)}{active.length > 4 && <span className={styles.more}>+{active.length - 4}</span>}</button>
        <Button ref={sideButton} className={styles.tasksToggle} disabled={!snapshot} onClick={() => openSide('tasks')}><Icon name="check" />任务{openTasks > 0 && ` · ${openTasks}`}</Button>
        <Button ref={inviteButton} variant="primary" aria-label="邀请同事 / AI" disabled={busy || terminal || !snapshot} onClick={openInvite}><Icon name="plus" /><span className={styles.inviteLabel}>邀请</span></Button>
        <RoomMenu label="房间菜单" disabled={!snapshot} buttonRef={menuButton}>
          {snapshot && <p className={styles.menuInfo}>{new Date(snapshot.expires).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期</p>}
          {owner && <button type="button" role="menuitem" className={styles.menuItem} disabled={terminal} onClick={() => setConfirm(snapshot?.aiPaused ? { op: 'pause', fields: { paused: false }, label: '恢复 AI 发言？各 AI 会在下一次读取时看到。', action: '恢复' } : { op: 'pause', fields: { paused: true }, label: '暂停所有 AI 发言？AI 仍可读取，但服务端会拒绝其发帖和改动任务；这不移除任何成员。', action: '暂停' })}>{snapshot?.aiPaused ? '恢复 AI 发言' : '暂停所有 AI 发言'}</button>}
          {owner && <button type="button" role="menuitem" className={styles.menuItem} disabled={terminal} onClick={() => setConfirm({ op: 'revoke', label: '撤销全部已发邀请？现有成员仍能访问，新成员需要新邀请。', action: '撤销' })}>撤销全部邀请</button>}
          <button type="button" role="menuitem" className={styles.menuItem} onClick={() => setPrivacyOpen(true)}>隐私与限制</button>
          <hr className={styles.menuSeparator} />
          {owner ? <button type="button" role="menuitem" className={styles.menuItem} data-danger disabled={terminal} onClick={() => setConfirm({ op: 'close', label: '关闭房间？所有成员将无法继续访问，此操作不能撤销。', action: '关闭房间' })}>关闭房间</button>
            : <button type="button" role="menuitem" className={styles.menuItem} disabled={terminal} onClick={() => setConfirm({ op: 'leave', label: '退出房间并清除此浏览器的成员凭据？', action: '退出' })}>退出房间</button>}
        </RoomMenu>
      </div>
    </header>
    <div className={styles.layout}>
      <div className={styles.conversation}>
        {error && <div className={styles.error} role="alert"><span>{error}</span><Button variant="quiet" onClick={() => setError('')}>收起提示</Button></div>}
        {terminal && <div className={styles.error}><Button onClick={() => { onForget(); navigate('/collab'); }}>清除此浏览器凭据并返回</Button></div>}
        {snapshot?.aiPaused && !terminal && <p className={styles.paused} role="status">AI 发言已暂停</p>}
        <div className={styles.timeline} role="log" aria-label="房间消息" aria-live="polite" onScroll={event => { const e = event.currentTarget; follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 100; }}>
          <div className={styles.timelineInner}>
            {snapshot && messages.length === 0 && <div className={styles.empty}><Steam /><p>开始讨论吧</p><span>提一个问题，或邀请同事和他们的 AI 加入。</span></div>}
            {messages.map((message, index) => {
              const previous = messages[index - 1]; const author = memberOf(message.memberId); const mine = message.memberId === auth.memberId;
              const newDay = !previous || day(previous.at) !== day(message.at);
              const continued = !newDay && previous?.memberId === message.memberId && Date.parse(message.at) - Date.parse(previous.at) < 5 * 60_000 && !message.replyTo && !compact(previous);
              const quoted = message.replyTo ? messages.find(m => m.seq === message.replyTo) : undefined;
              const delivery = snapshot && deliveryOf(message, members, messages, presence);
              const tested = probes.answers.get(message.seq);
              if (compact(message)) return <div key={message.seq}>
                {newDay && <p className={styles.dayDivider}><span>{day(message.at)}</span></p>}
                <p id={`msg-${message.seq}`} className={styles.probeLine} data-state={tested ? 'ok' : undefined}>{tested ? <><Icon name="check" />{nameOf(message.memberId)} 已回复响应测试 · 耗时 {tested.took}</> : <>{nameOf(message.memberId)} 向 {nameOf(message.to ?? '')} 发起响应测试</>}<time dateTime={message.at}>{clock(message.at)}</time></p>
              </div>;
              return <div key={message.seq}>
                {newDay && <p className={styles.dayDivider}><span>{day(message.at)}</span></p>}
                <article id={`msg-${message.seq}`} className={styles.message} data-own={mine} data-ai={author?.kind === 'ai'} data-addressed={message.to === auth.memberId} data-continued={continued} data-fresh={freshFrom.current !== null && message.seq > freshFrom.current} data-selected={selected === message.seq}>
                  {!mine && (continued ? <span className={styles.avatarSpacer} /> : <Avatar member={author} fallback={message.memberId} presence={author ? presenceOf(author) : undefined} />)}
                  <div className={styles.messageBody}>
                    {!continued && <header>{!mine && <><strong>{nameOf(message.memberId)}</strong>{author?.kind === 'ai' && <span className={styles.badge}>AI</span>}</>}<time dateTime={message.at}>{clock(message.at)}</time></header>}
                    <div className={styles.bubble} onClick={event => { if (!(event.target as Element).closest('a, button')) setSelected(value => value === message.seq ? 0 : message.seq); }}>
                      {(quoted || message.to) && <p className={styles.context}>{quoted && <button type="button" className={styles.quote} onClick={() => jump(quoted.seq)}>↩ {nameOf(quoted.memberId)}：{excerpt(quoted.text, 40)}</button>}{message.to && <span className={styles.mention}>@{message.to === auth.memberId ? '你' : nameOf(message.to)}</span>}</p>}
                      <MessageText text={message.text} className={styles.text} />
                    </div>
                    {delivery && (delivery.state === 'replied' || delivery.state === 'delivered') && <span className={styles.delivery} data-state={delivery.state} title={delivery.label} aria-label={delivery.label}>{delivery.state === 'replied' ? '✓✓' : '✓'}</span>}
                  </div>
                  <div className={styles.messageActions}>
                    <IconButton label={`回复 #${message.seq}`} variant="quiet" disabled={terminal} onClick={() => { setReply(message.seq); setTo(mine ? to : message.memberId); setSelected(0); }}><Icon name="back" /></IconButton>
                    <IconButton label="转为任务" variant="quiet" disabled={terminal} onClick={() => { fromMessage(message); setSelected(0); }}><Icon name="check" /></IconButton>
                  </div>
                </article>
              </div>;
            })}
            {thinking.length > 0 && <div className={styles.thinking} role="status"><Steam /><span>已送达 {thinking.map(m => m.name).join('、')} · 等待回复</span></div>}
            <div ref={bottom} />
          </div>
        </div>
        {notice && <p className={styles.notice} role="status">{notice}</p>}
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); send(); }}>
          {reply > 0 && <div className={styles.replying}><Icon name="back" /><span>回复 {(() => { const quoted = messages.find(m => m.seq === reply); return quoted ? `${nameOf(quoted.memberId)}：${excerpt(quoted.text, 36)}` : `#${reply}`; })()}</span><IconButton label="取消回复" variant="quiet" onClick={() => setReply(0)}><Icon name="close" /></IconButton></div>}
          <div className={styles.inputBox}>
            <Label htmlFor="collab-message" className="sr-only">消息</Label>
            <Textarea id="collab-message" value={text} onChange={e => setText(e.target.value)} onKeyDown={onComposerKey} maxLength={8000} rows={1} disabled={busy || terminal} placeholder={to ? `给 ${nameOf(to)} 的消息…` : '说点什么…'} required />
            <div className={styles.composerBar}>
              <span className={styles.mentionPicker} title="提醒某位成员"><span aria-hidden="true">@</span><select aria-label="提醒谁" value={to} disabled={busy || terminal} onChange={e => setTo(e.target.value)}><option value="">所有成员</option>{active.filter(m => m.id !== auth.memberId).map(m => <option key={m.id} value={m.id}>{m.name}{m.kind === 'ai' ? '（AI）' : ''}</option>)}</select></span>
              {to && <span className={styles.mentionChip}>@{nameOf(to)}<button type="button" aria-label="取消提醒" onClick={() => setTo('')}><Icon name="close" /></button></span>}
              <Button variant="primary" type="submit" className={styles.send} disabled={terminal || !snapshot || !text.trim()} loading={busy}><Icon name="send" />发送</Button>
            </div>
          </div>
        </form>
      </div>
      <aside className={styles.side}>{side()}</aside>
    </div>
    {sideOpen && <Drawer label={tab === 'tasks' ? '任务' : '成员'} closeLabel="关闭" restoreFocusTo={sideButton.current} onClose={() => setSideOpen(false)}><div className={styles.drawerBody}>{side()}</div></Drawer>}
    {inviteOpen && <Drawer room label="邀请同事或 AI" closeLabel="收起邀请" restoreFocusTo={inviteButton.current} onClose={() => setInviteOpen(false)}>
      <div className={styles.drawerBody}>
        <section className={styles.panelSection} aria-label="分享邀请">
          <p className={styles.note}>收到链接的人确认后即可加入，能看到全部历史并继续邀请。请勿公开发布。</p>
          {link ? <><Input aria-label="邀请链接" readOnly value={link} onFocus={e => e.currentTarget.select()} /><CopyButton text={link} label="复制邀请链接" done="邀请已复制" /></> : <p className={styles.note} role="status">{busy ? '正在生成邀请…' : '未能生成邀请，请关闭后重试。'}</p>}
        </section>
        {link && <AiInvitation link={link} />}
      </div>
    </Drawer>}
    {confirm && <Drawer compact label="确认操作" closeLabel="取消" restoreFocusTo={menuButton.current} onClose={() => setConfirm(null)}>
      <div className={styles.confirm}><p>{confirm.label}</p><Button variant="primary" loading={busy} onClick={() => void act(confirm.op, confirm.fields ?? {})}>确认{confirm.action}</Button></div>
    </Drawer>}
    {privacyOpen && <Drawer compact label="隐私与限制" closeLabel="关闭" restoreFocusTo={menuButton.current} onClose={() => setPrivacyOpen(false)}>
      <div className={styles.privacy}><p>讨论和任务以明文保存在云端，不是端到端加密；新成员可以看到全部历史。</p><p>房间不会同步任何人的电脑会话、文件或工具权限。到期后停止访问；最多 64 位成员、500 条消息、200 个任务。</p><p>AI 的在线与送达状态由其连接器上报，不代表模型已读。清除浏览器数据会丢失成员凭据。</p></div>
    </Drawer>}
  </section>;
}
