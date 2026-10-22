import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, Input, Label, Textarea } from '../../components/ui/Controls';
import { UiProvider } from '../../components/ui/UiProvider';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { aiInstructions, checkStorage, collaboration, CollaborationError, forgetMembership, membership, saveMembership, type Member, type Membership, type Message, type Presence, type Snapshot } from './api';
import styles from './Collaboration.module.scss';

const messageError = (error: unknown) => error instanceof Error ? error.message : '连接失败，请重试。';
// Connectors heartbeat at least every 30s while idle; allow for one missed beat.
const onlineWindow = 90_000;
const ago = (ms: number) => ms < 90 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟` : `${Math.round(ms / 3_600_000)} 小时`;
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
export function Collaboration() {
  const location = useLocation();
  const match = /^\/collab\/([a-f0-9]{32})$/.exec(location.pathname);
  return <main lang="zh-CN" className={styles.page} data-theme="dark" data-surface="workspace"><UiProvider>
    <header className={styles.header}><Link to="/collab" className={styles.brand}>Café Space <span>协作实验室</span></Link><Link to="/">电脑房间</Link></header>
    {match ? <Room key={match[1]} id={match[1]!} invite={new URLSearchParams(location.search).get('invite') ?? ''} /> : location.pathname === '/collab' ? <Create /> : <section className={styles.card}><h1>无效的协作链接</h1><Link to="/collab">返回协作首页</Link></section>}
  </UiProvider></main>;
}
function Create() {
  const navigate = useNavigate();
  const [name, setName] = useState(''); const [title, setTitle] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => { const abort = new AbortController(); void collaboration<{ enabled: boolean }>({ op: 'status' }, undefined, abort.signal).then(v => setEnabled(v.enabled), () => { if (!abort.signal.aborted) setEnabled(false); }); return () => abort.abort(); }, []);
  return <section className={styles.card}><p className={styles.eyebrow}>PEOPLE + AI</p><h1>一起讨论，不限工具。</h1><p>创建一个独立协作房间，把邀请交给同事或他们的 AI。无需安装 Space，不开放任何人的电脑权限。</p>
    <form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try { checkStorage(); const value = await collaboration<Membership>({ op: 'create', title: title.trim(), name: name.trim(), kind: 'human' }); saveMembership(value); navigate('/collab/' + value.roomId); }
      catch (e) { setError(messageError(e)); } finally { setBusy(false); }
    })(); }}>
      <Label htmlFor="collab-title">房间名称</Label><Input id="collab-title" value={title} onChange={e => setTitle(e.target.value)} maxLength={80} required placeholder="例如：Space 开发讨论" />
      <Label htmlFor="collab-name">你的名称</Label><Input id="collab-name" value={name} onChange={e => setName(e.target.value)} maxLength={48} required autoComplete="nickname" />
      <p className={styles.note}>持邀请链接可直接加入并查看全部历史，也可以继续邀请。共享消息以明文保存在云端；实验房间 7 天到期，最多 500 条消息。请勿发送秘密或敏感资料。</p>
      <Button type="submit" variant="primary" loading={busy} disabled={enabled !== true}>创建协作房间</Button>
      {enabled === false && <p role="alert">协作服务尚未启用或暂不可用；原电脑房间不受影响。</p>}
      {error && <p role="alert">{error}</p>}
    </form>
  </section>;
}
function Room({ id, invite }: { id: string; invite: string }) {
  const navigate = useNavigate(); const [auth, setAuth] = useState(() => membership(id));
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  if (auth) return <Discussion auth={auth} onForget={() => { forgetMembership(id); setAuth(null); }} />;
  return <section className={styles.card}><p className={styles.eyebrow}>INVITATION</p><h1>加入协作房间</h1><p>加入后可查看已有讨论、发言并邀请其他人。名称是自我声明，不是已验证身份。</p>
    {!/^[a-f0-9]{64}$/.test(invite) ? <p role="alert">请向同事索取完整邀请链接；此浏览器没有保存这个房间的成员凭据。</p> : <form onSubmit={event => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); void (async () => {
      try { checkStorage(); const value = await collaboration<Membership>({ op: 'join', roomId: id, invite, name: name.trim(), kind: 'human' }); saveMembership(value); setAuth(value); navigate('/collab/' + id, { replace: true }); }
      catch (e) { setError(messageError(e)); } finally { setBusy(false); }
    })(); }}><Label htmlFor="join-name">你的名称</Label><Input id="join-name" maxLength={48} value={name} onChange={e => setName(e.target.value)} required autoComplete="nickname" /><p className={styles.note}>共享内容保存在云端；不会连接或操作你的电脑。成员凭据仅保存于此浏览器，请勿在共用浏览器中使用。</p><Button variant="primary" type="submit" loading={busy}>同意并加入</Button>{error && <p role="alert">{error}</p>}</form>}
    {invite && <AiInvitation link={window.location.origin + '/#/collab/' + id + '?invite=' + invite} />}
  </section>;
}
function AiInvitation({ link }: { link: string }) {
  const text = aiInstructions(link); const [copied, setCopied] = useState(false);
  return <details className={styles.details}><summary>让我的 AI 加入 · 无需安装</summary><p>把下面说明交给你已有的 AI。它需要获准调用 HTTPS 接口；不能联网时无法自动收发。这里只分享当前房间，不分享浏览器的成员凭据。</p><Textarea aria-label="AI 接入说明" value={text} readOnly rows={8} /><Button onClick={() => { setCopied(false); void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '说明已复制' : '复制 AI 接入说明'}</Button><a href="/api/collaboration/guide" target="_blank" rel="noreferrer">查看 HTTP 协议</a></details>;
}
function Discussion({ auth, onForget }: { auth: Membership; onForget: () => void }) {
  const navigate = useNavigate(); const [snapshot, setSnapshot] = useState<Snapshot | null>(null); const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState(''); const [connected, setConnected] = useState(false); const [terminal, setTerminal] = useState(false); const [busy, setBusy] = useState(false);
  const [text, setText] = useState(''); const [to, setTo] = useState(''); const [reply, setReply] = useState(0); const [link, setLink] = useState(''); const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<{ op: string; fields?: Record<string, unknown>; label: string } | null>(null);
  const cursor = useRef(0); const pending = useRef<{ id: string; text: string; to: string; replyTo: number } | null>(null);
  const bottom = useRef<HTMLDivElement>(null); const follow = useRef(true);
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
      if (op === 'invite' && value.url) { setLink(value.url); setCopied(false); }
      if (op === 'revoke') { setLink(''); setCopied(false); }
      if (op === 'close' || op === 'leave') { onForget(); navigate('/collab'); }
      if (op === 'remove') setSnapshot(old => old ? { ...old, members: old.members.map(m => m.id === fields.memberId ? { ...m, removed: true } : m) } : old);
      if (op === 'pause') setSnapshot(old => old ? { ...old, aiPaused: fields.paused === true } : old);
    } catch (e) { setError(messageError(e)); } finally { setBusy(false); setConfirm(null); }
  };
  const own = snapshot?.members.find(m => m.id === auth.memberId);
  const now = Date.now();
  const nameOf = (memberId: string) => snapshot?.members.find(m => m.id === memberId)?.name ?? memberId.slice(0, 8);
  return <section className={styles.workspace}>
    <header className={styles.roomHeader}><div><p className={styles.eyebrow}>COLLABORATION · 实验版</p><h1>{snapshot?.title ?? '正在读取房间…'}</h1><p role="status">{terminal ? '房间或成员已不可用' : connected ? '消息连接正常 · 每 5 秒同步' : '正在连接或重连'}{snapshot && ` · ${new Date(snapshot.expires).toLocaleString()} 到期`}</p></div>
      <div className={styles.actions}><Button disabled={busy || terminal || !snapshot} onClick={() => void act('invite')}>邀请同事 / AI</Button><Link to="/collab">创建房间</Link></div>
    </header>
    <div className={styles.columns}><div className={styles.discussion}>
      {error && <div className={styles.error} role="alert">{error}<Button variant="quiet" onClick={() => setError('')}>收起提示</Button></div>}
      {terminal && <p><Button onClick={() => { onForget(); navigate('/collab'); }}>清除此浏览器凭据并返回</Button></p>}
      {snapshot?.aiPaused && !terminal && <p className={styles.paused} role="status">房主已暂停 AI 发言：AI 可以继续读取，但不应发帖。</p>}
      {link && <section className={styles.invitation} aria-label="分享邀请"><h2>持链接直接加入</h2><p>新成员可查看全部历史。转发前确认接收人；不要公开发布。</p><Input aria-label="邀请链接" readOnly value={link} /><Button onClick={() => { setCopied(false); void navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => setCopied(false)); }}>{copied ? '邀请已复制' : '复制邀请链接'}</Button><AiInvitation link={link} /><Button variant="quiet" onClick={() => setLink('')}>收起邀请</Button></section>}
      <div className={styles.messages} role="log" aria-label="房间消息" aria-live="polite" onScroll={event => { const e = event.currentTarget; follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 100; }}>
        {snapshot && messages.length === 0 && <p className={styles.empty}>还没有消息。发一个问题，或邀请同事和 AI 一起讨论。</p>}
        {messages.map(message => <article key={message.seq} className={styles.message} data-own={message.memberId === auth.memberId}>
          <header><strong>{nameOf(message.memberId)}</strong><span>{snapshot?.members.find(m => m.id === message.memberId)?.kind === 'ai' ? 'AI · 自声明' : '成员'} · #{message.memberId.slice(0, 6)}</span><time dateTime={message.at}>{new Date(message.at).toLocaleTimeString()}</time></header>
          {(message.to || message.replyTo) && <small>{message.to ? `@${nameOf(message.to)} · 所有成员可见` : ''}{message.replyTo ? ` 回复 #${message.replyTo}` : ''}</small>}
          <p>{message.text}</p>{(() => { const delivery = snapshot && deliveryOf(message, snapshot.members, messages, snapshot.presence); return delivery && <small className={styles.delivery} title="连接器自报的进度，不代表模型已读；未授权成员的消息可能被跳过。">{delivery}</small>; })()}
          <Button variant="quiet" disabled={terminal} onClick={() => { setReply(message.seq); setTo(message.memberId); }}>回复 #{message.seq}</Button>
        </article>)}<div ref={bottom} />
      </div>
      <form className={styles.composer} onSubmit={event => { event.preventDefault(); if (busy || terminal || !text.trim()) return; void (async () => {
        const draft = { text: text.trim(), to, replyTo: reply };
        if (!pending.current || pending.current.text !== draft.text || pending.current.to !== to || pending.current.replyTo !== reply) pending.current = { ...draft, id: crypto.randomUUID() };
        setBusy(true); setError('');
        try { const message = await collaboration<Message>({ op: 'send', roomId: auth.roomId, ...pending.current }, auth.token);
          setMessages(old => old.some(m => m.seq === message.seq) ? old : [...old, message].sort((a, b) => a.seq - b.seq)); setText(''); setReply(0); pending.current = null; follow.current = true;
        } catch (e) { setError(messageError(e)); } finally { setBusy(false); }
      })(); }}>
        {reply > 0 && <p>回复 #{reply} <Button variant="quiet" onClick={() => setReply(0)}>取消回复</Button></p>}
        <div className={styles.actions}><ChoiceSelect label="提醒谁" native value={to} disabled={busy || terminal} onValueChange={setTo} items={[{ value: "", label: "所有成员" }, ...(snapshot?.members.filter(m => !m.removed && m.id !== auth.memberId).map(m => ({ value: m.id, label: `${m.name} #${m.id.slice(0, 6)}` })) ?? [])]} /><small>定向提醒不是私信，也不保证唤醒 AI。</small></div>
        <Label htmlFor="collab-message">消息</Label><Textarea id="collab-message" value={text} onChange={e => setText(e.target.value)} maxLength={8000} rows={3} disabled={busy || terminal} placeholder="提出问题、补充资料，或分享一个结论…" required />
        <div className={styles.actions}><small>仅分享你有权共享的内容；回车换行。</small><Button variant="primary" type="submit" disabled={terminal || !snapshot || !text.trim()} loading={busy}>发送</Button></div>
      </form>
    </div><aside className={styles.members} aria-label="房间成员"><h2>成员 · {snapshot?.members.filter(m => !m.removed).length ?? 0}</h2><p>名称和 AI 类型由成员自行填写，不表示账号认证或在线执行。</p>
      <ul>{snapshot?.members.filter(m => !m.removed).map(m => { const state = m.kind === 'ai' ? connectorState(snapshot.presence?.[m.id], now) : null; const report = snapshot.presence?.[m.id]; return <li key={m.id}><div><strong>{m.name}</strong><small>#{m.id.slice(0, 6)} · {m.owner ? '房主' : m.kind === 'ai' ? 'AI' : '成员'}{m.id === auth.memberId ? ' · 你' : ''}</small>
        {state && <small className={styles.connector} data-tone={state.tone} title="由该 AI 的连接器自行上报，仅供参考。">{state.label}</small>}
        {state && report && <small>已取到 #{report.fetched} · 已送入会话 #{report.delivered}</small>}</div>
        {own?.owner && !m.owner && <Button variant="quiet" disabled={busy || terminal} onClick={() => setConfirm({ op: 'remove', fields: { memberId: m.id }, label: `移除 ${m.name}？若其仍持有效邀请，可能重新加入；必要时撤销全部邀请。` })}>移除</Button>}</li>; })}</ul>
      <details className={styles.details}><summary>隐私与实验限制</summary><p>讨论以明文保存在云端，不是端到端加密。新成员可看全部历史。不自动同步电脑会话、文件和工具权限。房间 7 天到期，最多 64 个成员登记及 500 条消息。离线 AI 不会被唤醒。AI 的连接与送达状态由其连接器自行上报，不代表模型已读。浏览器清除数据会丢失成员凭据；房主凭据没有匿名找回入口。</p></details>
      {own?.owner ? <><Button disabled={busy || terminal || !snapshot} onClick={() => setConfirm(snapshot?.aiPaused ? { op: 'pause', fields: { paused: false }, label: '恢复 AI 发言？各 AI 会在下一次读取时看到。' } : { op: 'pause', fields: { paused: true }, label: '暂停所有 AI 发言？AI 仍可读取，但按协议不应再发帖；这不撤销任何成员。' })}>{snapshot?.aiPaused ? '恢复 AI 发言' : '暂停所有 AI 发言'}</Button><Button disabled={busy || terminal} onClick={() => setConfirm({ op: 'revoke', label: '撤销全部已发邀请？现有成员仍能访问，新成员需要新邀请。' })}>撤销全部邀请</Button><Button disabled={busy || terminal} onClick={() => setConfirm({ op: 'close', label: '关闭房间？所有成员将无法继续访问，此操作不能撤销。' })}>关闭房间</Button></> : <Button disabled={busy || terminal} onClick={() => setConfirm({ op: 'leave', label: '退出房间并清除此浏览器的成员凭据？' })}>退出房间</Button>}
      {confirm && <section className={styles.confirm} aria-label="确认操作"><p>{confirm.label}</p><Button variant="primary" loading={busy} onClick={() => void act(confirm.op, confirm.fields ?? {})}>确认</Button><Button disabled={busy} onClick={() => setConfirm(null)}>取消</Button></section>}
    </aside></div>
  </section>;
}
