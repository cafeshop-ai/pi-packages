import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, IconButton, Input, Label, Textarea } from '../../components/ui/Controls';
import { UiProvider } from '../../components/ui/UiProvider';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { Drawer } from '../../components/ui/Drawer';
import { Icon } from '../../components/ui/Icon';
import { aiInstructions, checkStorage, collaboration, CollaborationError, forgetMembership, membership, saveMembership, type Member, type Membership, type Message, type Presence, type Snapshot } from './api';
import styles from './Collaboration.module.scss';

const messageError = (error: unknown) => error instanceof Error ? error.message : '连接失败，请重试。';
// Connectors heartbeat at least every 30s while idle; allow for one missed beat.
const onlineWindow = 90_000;
const ago = (ms: number) => ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : `${Math.round(ms / 3_600_000)} 小时`;
const clock = (at: string) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const day = (at: string) => new Date(at).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
const excerpt = (text: string, max = 48) => { const flat = text.replace(/\s+/g, ' ').trim(); return [...flat].length > max ? [...flat].slice(0, max).join('') + '…' : flat; };
/** Presence is the connector's own report: absent means unknown, never failure. */
export function connectorState(presence: Presence | undefined, now: number): { label: string; tone: 'online' | 'paused' | 'offline' | 'unknown' } {
  if (!presence) return { label: '连接器未上报', tone: 'unknown' };
  const age = now - Date.parse(presence.heartbeatAt);
  if (!(age < onlineWindow)) return { label: `连接器离线 · ${ago(age)}前上报`, tone: 'offline' };
  return presence.paused ? { label: '连接器在线 · 已暂停', tone: 'paused' } : { label: '连接器在线', tone: 'online' };
}
/** Delivery of a message addressed to an AI; null when nothing honest can be said. */
export function deliveryOf(message: Message, members: Member[], messages: Message[], presence: Record<string, Presence> = {}): string | null {
  const target = members.find(m => m.id === message.to);
  if (!target || target.kind !== 'ai') return null;
  if (messages.some(m => m.memberId === target.id && m.replyTo === message.seq)) return `${target.name} 已回复`;
  const report = presence[target.id];
  if (!report) return null;
  if (report.delivered >= message.seq) return '连接器上报：已送入对方会话';
  if (report.fetched >= message.seq) return '连接器上报：已取到';
  return '等待对方连接器';
}
function Avatar({ member, fallback }: { member?: Member; fallback: string }) {
  const initial = [...(member?.name ?? fallback).trim()][0] ?? '?';
  return <span className={styles.avatar} data-kind={member?.kind ?? 'human'} aria-hidden="true">{initial.toUpperCase()}</span>;
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
      <p className={styles.lead}>为同事和各自的 AI 建一个共同的讨论房间。持邀请直接加入，AI 通过 HTTPS 接入，不需要安装 Space，也不开放任何人的电脑。</p>
      <ul className={styles.facts}>
        <li><Icon name="share" /><div><strong>邀请即加入</strong><span>把链接发给同事或 AI，对方确认后直接进入，也可以继续邀请。</span></div></li>
        <li><Icon name="message" /><div><strong>AI 有消息才响应</strong><span>支持后台唤醒的 AI 客户端在有新消息时自动收到，房间里能看到它的连接状态。</span></div></li>
        <li><Icon name="lock" /><div><strong>边界清楚</strong><span>只共享发到房间的消息。房主可以移除成员、暂停 AI 发言或关闭房间。</span></div></li>
      </ul>
    </div>
    <form className={styles.formCard} onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try { checkStorage(); const value = await collaboration<Membership>({ op: 'create', title: title.trim(), name: name.trim(), kind: 'human' }); saveMembership(value); navigate('/collab/' + value.roomId); }
      catch (e) { setError(messageError(e)); } finally { setBusy(false); }
    })(); }}>
      <h2>新建房间</h2>
      <div className={styles.field}><Label htmlFor="collab-title">房间名称</Label><Input id="collab-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} required placeholder="例如：Space 发布讨论" /></div>
      <div className={styles.field}><Label htmlFor="collab-name">你的名称</Label><Input id="collab-name" value={name} onChange={e => setName(e.target.value)} maxLength={48} required autoComplete="nickname" placeholder="其他成员看到的称呼" /></div>
      <p className={styles.note}>持邀请的人可以查看全部历史。消息以明文保存在云端，房间 {retention} 天后到期，请勿发送密钥或敏感资料。</p>
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
    <p className={styles.lead}>加入后可以查看已有讨论、发言并邀请其他人。名称由你自己填写，不代表已验证的身份。</p>
    {!/^[a-f0-9]{64}$/.test(invite) ? <p className={styles.formError} role="alert">请向邀请人索取完整的邀请链接；此浏览器没有保存这个房间的成员凭据。</p> : <form className={styles.joinForm} onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try { checkStorage(); const value = await collaboration<Membership>({ op: 'join', roomId: id, invite, name: name.trim(), kind: 'human' }); saveMembership(value); setAuth(value); navigate('/collab/' + id, { replace: true }); }
      catch (e) { setError(messageError(e)); } finally { setBusy(false); }
    })(); }}>
      <div className={styles.field}><Label htmlFor="join-name">你的名称</Label><Input id="join-name" maxLength={48} value={name} onChange={e => setName(e.target.value)} required autoComplete="nickname" /></div>
      <p className={styles.note}>讨论内容保存在云端，不会连接或操作你的电脑。成员凭据只保存在当前浏览器，请不要在共用设备上加入。</p>
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
  const text = aiInstructions(link);
  return <details className={styles.aiInvite}><summary>让我的 AI 加入 · 无需安装</summary>
    <p>把下面的说明交给你已有的 AI。它需要能发 HTTPS 请求；支持后台唤醒的客户端（例如 Claude Code）可以在有新消息时自动响应。这里只分享当前房间，不分享浏览器里的成员凭据。</p>
    <Textarea aria-label="AI 接入说明" value={text} readOnly rows={7} />
    <div className={styles.row}><CopyButton text={text} label="复制 AI 接入说明" done="说明已复制" /><a href="/api/collaboration/guide" target="_blank" rel="noreferrer">查看 HTTP 协议</a></div>
  </details>;
}

function Discussion({ auth, onForget }: { auth: Membership; onForget: () => void }) {
  const navigate = useNavigate(); const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState(''); const [connected, setConnected] = useState(false); const [terminal, setTerminal] = useState(false); const [busy, setBusy] = useState(false);
  const [text, setText] = useState(''); const [to, setTo] = useState(''); const [reply, setReply] = useState(0); const [link, setLink] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false); const [membersOpen, setMembersOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ op: string; fields?: Record<string, unknown>; label: string } | null>(null);
  const cursor = useRef(0); const pending = useRef<{ id: string; text: string; to: string; replyTo: number } | null>(null);
  const bottom = useRef<HTMLDivElement>(null); const follow = useRef(true); const inviteButton = useRef<HTMLButtonElement>(null); const membersButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>; let stopped = false;
    const poll = async () => {
      let delay = 5000;
      try {
        const value = await collaboration<Snapshot>({ op: 'read', roomId: auth.roomId, after: cursor.current }, auth.token, abort.signal);
        if (stopped) return; setSnapshot(value); setConnected(true); cursor.current = value.cursor;
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
  const act = async (op: string, fields: Record<string, unknown> = {}) => {
    setBusy(true); setError('');
    try {
      const value = await collaboration<{ url?: string }>({ op, roomId: auth.roomId, ...fields }, auth.token);
      if (op === 'invite' && value.url) setLink(value.url);
      if (op === 'revoke') { setLink(''); setInviteOpen(false); }
      if (op === 'close' || op === 'leave') { onForget(); navigate('/collab'); }
      if (op === 'remove') setSnapshot(old => old ? { ...old, members: old.members.map(m => m.id === fields.memberId ? { ...m, removed: true } : m) } : old);
      if (op === 'pause') setSnapshot(old => old ? { ...old, aiPaused: fields.paused === true } : old);
    } catch (e) { setError(messageError(e)); } finally { setBusy(false); setConfirm(null); }
  };
  const send = () => { if (busy || terminal || !text.trim()) return; void (async () => {
    const draft = { text: text.trim(), to, replyTo: reply };
    if (!pending.current || pending.current.text !== draft.text || pending.current.to !== to || pending.current.replyTo !== reply) pending.current = { ...draft, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { const message = await collaboration<Message>({ op: 'send', roomId: auth.roomId, ...pending.current }, auth.token);
      setMessages(old => old.some(m => m.seq === message.seq) ? old : [...old, message].sort((a, b) => a.seq - b.seq)); setText(''); setReply(0); pending.current = null; follow.current = true;
    } catch (e) { setError(messageError(e)); } finally { setBusy(false); }
  })(); };
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Desktop chat convention; touch keyboards keep Enter for new lines and use the send button.
    const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing && !coarse) { event.preventDefault(); send(); }
  };
  const members = snapshot?.members ?? []; const active = members.filter(m => !m.removed);
  const own = members.find(m => m.id === auth.memberId);
  const memberOf = (memberId: string) => members.find(m => m.id === memberId);
  const nameOf = (memberId: string) => memberOf(memberId)?.name ?? memberId.slice(0, 8);
  const now = Date.now();
  const openInvite = () => { setInviteOpen(true); if (!link) void act('invite'); };
  const participants = (): ReactNode => <>
    <section className={styles.panelSection}>
      <h2>参与者 <span>{active.length}</span></h2>
      <ul className={styles.people}>{active.map(m => { const state = m.kind === 'ai' ? connectorState(snapshot?.presence?.[m.id], now) : null; const report = snapshot?.presence?.[m.id]; return <li key={m.id}>
        <Avatar member={m} fallback={m.id} />
        <div className={styles.person}>
          <p className={styles.personName}><strong>{m.name}</strong>{m.kind === 'ai' && <span className={styles.badge}>AI</span>}{m.id === auth.memberId && <span className={styles.you}>你</span>}</p>
          <p className={styles.meta}>{m.owner ? '房主' : m.kind === 'ai' ? '自声明 AI' : '成员'} · #{m.id.slice(0, 6)}</p>
          {state && <p className={styles.connector} data-tone={state.tone} title="由该 AI 的连接器自行上报，仅供参考。">{state.label}</p>}
          {state && report && <p className={styles.meta}>已取到 #{report.fetched} · 已送入会话 #{report.delivered}</p>}
        </div>
        {own?.owner && !m.owner && <Button variant="quiet" className={styles.remove} aria-label={`移除 ${m.name}`} disabled={busy || terminal} onClick={() => setConfirm({ op: 'remove', fields: { memberId: m.id }, label: `移除 ${m.name}？若其仍持有效邀请，可能重新加入；必要时撤销全部邀请。` })}>移除</Button>}
      </li>; })}</ul>
      <p className={styles.footnote}>名称与类型由成员自行填写。AI 的连接与送达状态由其连接器上报，不代表模型已读。</p>
    </section>
    {own?.owner ? <section className={styles.panelSection}><h2>房间管理</h2><div className={styles.manage}>
      <Button disabled={busy || terminal || !snapshot} onClick={() => setConfirm(snapshot?.aiPaused ? { op: 'pause', fields: { paused: false }, label: '恢复 AI 发言？各 AI 会在下一次读取时看到。' } : { op: 'pause', fields: { paused: true }, label: '暂停所有 AI 发言？AI 仍可读取，但服务端会拒绝其发帖；这不移除任何成员。' })}>{snapshot?.aiPaused ? '恢复 AI 发言' : '暂停所有 AI 发言'}</Button>
      <Button disabled={busy || terminal} onClick={() => setConfirm({ op: 'revoke', label: '撤销全部已发邀请？现有成员仍能访问，新成员需要新邀请。' })}>撤销全部邀请</Button>
      <Button className={styles.danger} disabled={busy || terminal} onClick={() => setConfirm({ op: 'close', label: '关闭房间？所有成员将无法继续访问，此操作不能撤销。' })}>关闭房间</Button>
    </div></section> : <section className={styles.panelSection}><Button disabled={busy || terminal} onClick={() => setConfirm({ op: 'leave', label: '退出房间并清除此浏览器的成员凭据？' })}>退出房间</Button></section>}
    {confirm && <section className={styles.confirm} aria-label="确认操作"><p>{confirm.label}</p><div className={styles.row}><Button variant="primary" loading={busy} onClick={() => void act(confirm.op, confirm.fields ?? {})}>确认</Button><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button></div></section>}
    <details className={styles.privacy}><summary>隐私与限制</summary><p>讨论以明文保存在云端，不是端到端加密；新成员可以看到全部历史。房间不会同步任何人的电脑会话、文件或工具权限。房间到期后停止访问（到期时间见页面顶部），最多登记 64 位成员、保存 500 条消息。离线的 AI 不会被唤醒。清除浏览器数据会丢失成员凭据，房主凭据没有找回入口。</p></details>
  </>;
  return <section className={styles.room}>
    <header className={styles.toolbar}>
      <div className={styles.titleBlock}>
        <h1>{snapshot?.title ?? '正在读取房间…'}</h1>
        <p role="status"><span className={styles.dot} data-tone={terminal ? 'offline' : connected ? 'online' : 'unknown'} />{terminal ? '房间或成员已不可用' : connected ? '已连接' : '正在连接…'}{snapshot && ` · ${new Date(snapshot.expires).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 到期`}</p>
      </div>
      <div className={styles.toolbarActions}>
        <Button ref={membersButton} className={styles.membersToggle} disabled={!snapshot} onClick={() => setMembersOpen(true)}>成员 · {active.length}</Button>
        <Button ref={inviteButton} variant="primary" disabled={busy || terminal || !snapshot} onClick={openInvite}><Icon name="plus" />邀请同事 / AI</Button>
      </div>
    </header>
    <div className={styles.layout}>
      <div className={styles.conversation}>
        {error && <div className={styles.error} role="alert"><span>{error}</span><Button variant="quiet" onClick={() => setError('')}>收起提示</Button></div>}
        {terminal && <div className={styles.error}><Button onClick={() => { onForget(); navigate('/collab'); }}>清除此浏览器凭据并返回</Button></div>}
        {snapshot?.aiPaused && !terminal && <p className={styles.paused} role="status">房主已暂停 AI 发言：AI 可以继续读取，但不应发帖。</p>}
        <div className={styles.timeline} role="log" aria-label="房间消息" aria-live="polite" onScroll={event => { const e = event.currentTarget; follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 100; }}>
          <div className={styles.timelineInner}>
            {snapshot && messages.length === 0 && <div className={styles.empty}><p>还没有消息</p><span>提一个问题，或邀请同事和他们的 AI 一起讨论。</span></div>}
            {messages.map((message, index) => {
              const previous = messages[index - 1]; const author = memberOf(message.memberId);
              const newDay = !previous || day(previous.at) !== day(message.at);
              const continued = !newDay && previous?.memberId === message.memberId && Date.parse(message.at) - Date.parse(previous.at) < 5 * 60_000 && !message.to && !message.replyTo;
              const quoted = message.replyTo ? messages.find(m => m.seq === message.replyTo) : undefined;
              const delivery = snapshot && deliveryOf(message, members, messages, snapshot.presence);
              return <div key={message.seq}>
                {newDay && <p className={styles.dayDivider}><span>{day(message.at)}</span></p>}
                <article className={styles.message} data-own={message.memberId === auth.memberId} data-addressed={message.to === auth.memberId} data-continued={continued}>
                  {continued ? <span className={styles.avatarSpacer} /> : <Avatar member={author} fallback={message.memberId} />}
                  <div className={styles.messageBody}>
                    {!continued && <header><strong>{nameOf(message.memberId)}</strong>{author?.kind === 'ai' && <span className={styles.badge}>AI</span>}<time dateTime={message.at}>{clock(message.at)}</time></header>}
                    {(message.to || message.replyTo) ? <p className={styles.context}>{message.replyTo ? <span className={styles.quote}>回复 #{message.replyTo}{quoted ? ` · ${nameOf(quoted.memberId)}：${excerpt(quoted.text)}` : ''}</span> : null}{message.to ? <span className={styles.mention}>@{message.to === auth.memberId ? '你' : nameOf(message.to)} · 所有成员可见</span> : null}</p> : null}
                    <p className={styles.text}>{message.text}</p>
                    {delivery && <footer><small className={styles.delivery} title="连接器自报的进度，不代表模型已读；未授权成员的消息可能被跳过。">{delivery}</small></footer>}
                  </div>
                  <button type="button" className={styles.replyAction} disabled={terminal} onClick={() => { setReply(message.seq); setTo(message.memberId === auth.memberId ? to : message.memberId); }}>回复 #{message.seq}</button>
                </article>
              </div>;
            })}
            <div ref={bottom} />
          </div>
        </div>
        <form className={styles.composer} onSubmit={event => { event.preventDefault(); send(); }}>
          {reply > 0 && <div className={styles.replying}><span>回复 #{reply}{(() => { const quoted = messages.find(m => m.seq === reply); return quoted ? ` · ${nameOf(quoted.memberId)}：${excerpt(quoted.text, 36)}` : ''; })()}</span><IconButton label="取消回复" variant="quiet" onClick={() => setReply(0)}><Icon name="close" /></IconButton></div>}
          <div className={styles.inputBox}>
            <Label htmlFor="collab-message" className="sr-only">消息</Label>
            <Textarea id="collab-message" value={text} onChange={e => setText(e.target.value)} onKeyDown={onComposerKey} maxLength={8000} rows={2} disabled={busy || terminal} placeholder="提出问题、补充资料，或分享一个结论…" required />
            <div className={styles.composerBar}>
              <ChoiceSelect label="提醒谁" native value={to} disabled={busy || terminal} onValueChange={setTo} items={[{ value: '', label: '所有成员' }, ...active.filter(m => m.id !== auth.memberId).map(m => ({ value: m.id, label: `${m.name}${m.kind === 'ai' ? ' · AI' : ''}` }))]} />
              <small className={styles.hint}>Enter 发送 · Shift+Enter 换行</small>
              <Button variant="primary" type="submit" disabled={terminal || !snapshot || !text.trim()} loading={busy}><Icon name="send" />发送</Button>
            </div>
          </div>
          <p className={styles.composerNote}>定向提醒对所有成员可见，不是私信，也不保证唤醒 AI。只分享你有权共享的内容。</p>
        </form>
      </div>
      <aside className={styles.side} aria-label="房间成员">{participants()}</aside>
    </div>
    {membersOpen && <Drawer label="参与者与房间管理" closeLabel="关闭" restoreFocusTo={membersButton.current} onClose={() => setMembersOpen(false)}><div className={styles.drawerBody}>{participants()}</div></Drawer>}
    {inviteOpen && <Drawer room label="邀请同事或 AI" closeLabel="收起邀请" restoreFocusTo={inviteButton.current} onClose={() => setInviteOpen(false)}>
      <div className={styles.drawerBody}>
        <section className={styles.panelSection} aria-label="分享邀请">
          <h2>持链接直接加入</h2>
          <p className={styles.note}>收到链接的人确认后即可加入，并能看到全部历史和继续邀请。转发前请确认接收人，不要公开发布。</p>
          {link ? <><Input aria-label="邀请链接" readOnly value={link} onFocus={e => e.currentTarget.select()} /><CopyButton text={link} label="复制邀请链接" done="邀请已复制" /></> : <p className={styles.note} role="status">{busy ? '正在生成邀请…' : '未能生成邀请，请关闭后重试。'}</p>}
        </section>
        {link && <AiInvitation link={link} />}
      </div>
    </Drawer>}
  </section>;
}
