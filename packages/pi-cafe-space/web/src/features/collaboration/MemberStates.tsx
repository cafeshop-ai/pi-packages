import { useState, type FormEvent } from 'react';
import { Button, Input } from '../../components/ui/Controls';
import type { Member, MemberState, Presence, Task, WaitKind, WorkState } from './api';
import { span, stateLabels, stateLine, waitLabels, when } from './state';
import styles from './Collaboration.module.scss';

// Member states are self-reported. They say who is stuck on whom, so a wait is never silent:
// the header counts them, the people list explains them, and the awaited member sees "等你".

/** Header summary: how many members wait, and how many of them wait on you. */
export function WaitingSummary({ waiting, onMe, onOpen }: { waiting: number; onMe: number; onOpen: () => void }) {
  if (waiting === 0) return null;
  const label = `${waiting} 人等待${onMe ? ` · ${onMe} 项等你` : ''}`;
  return <button type="button" className={styles.waits} data-on-me={onMe > 0} aria-label={`${label}，查看详情`} onClick={onOpen}><span aria-hidden="true">⏳</span>{label}</button>;
}

/** A member's state as a chip that opens its details. */
export function StateChip({ st, name, now, open, onToggle }: { st: MemberState; name: (id: string) => string; now: number; open: boolean; onToggle: () => void }) {
  const line = stateLine(st, name, now);
  return <button type="button" className={styles.stateChip} data-tone={line.tone} aria-expanded={open} title="成员自报，未经验证" onClick={onToggle}>{line.label}</button>;
}

/** What the member waits for, on whom, since when, and whether the request reached them. */
export function StateDetail({ st, name, tasks, presence, now, onJump }: { st: MemberState; name: (id: string) => string; tasks: Task[]; presence: Record<string, Presence>; now: number; onJump: (seq: number) => void }) {
  const titled = (st.tasks ?? []).map(id => ({ id, title: tasks.find(t => t.id === id)?.title }));
  return <dl className={styles.stateDetail}>
    <dt>状态</dt><dd>{stateLabels[st.state]}{st.waitingFor && ` · ${waitLabels[st.waitingFor]}`}</dd>
    {st.on?.length ? <><dt>等谁</dt><dd>{st.on.map(id => {
      // Delivery is the awaited AI's connector report, not proof that it read the request.
      const delivered = st.ref && presence[id] && presence[id]!.delivered >= st.ref;
      return <span key={id} className={styles.stateTarget}>{name(id)}{delivered ? '（请求已送达）' : ''}</span>;
    })}</dd></> : null}
    {st.detail && <><dt>{st.state === 'waiting' ? '在等什么' : '说明'}</dt><dd>{st.detail}</dd></>}
    {titled.length > 0 && <><dt>任务</dt><dd>{titled.map(t => <span key={t.id} className={styles.stateTarget}>#{t.id}{t.title ? ` ${t.title}` : '（已删除）'}</span>)}</dd></>}
    {st.ref ? <><dt>请求</dt><dd><button type="button" className={styles.taskSource} onClick={() => onJump(st.ref!)}>查看 #{st.ref}</button></dd></> : null}
    <dt>开始</dt><dd>{when(st.since)}（{span(now - Date.parse(st.since))}前）</dd>
    {st.expect && <><dt>预计</dt><dd>{when(st.expect)}{Date.parse(st.expect) < now ? '（已过预计时间）' : ''}</dd></>}
    <dt>更新</dt><dd>{when(st.updatedAt)} · 成员自报，未经验证</dd>
  </dl>;
}

/** Members waiting on you, each with its request and a one-click reply. */
export function WaitingOnMe({ members, states, name, onReply, onJump }: { members: Member[]; states: Record<string, MemberState>; name: (id: string) => string; onReply: (member: Member, seq: number) => void; onJump: (seq: number) => void }) {
  if (members.length === 0) return null;
  return <section className={styles.onMe} aria-label="等你处理">
    <h3>等你处理 · {members.length}</h3>
    <ul>{members.map(m => { const st = states[m.id]!; return <li key={m.id}>
      <p><strong>{name(m.id)}</strong> {waitLabels[st.waitingFor ?? 'member']}：{st.detail}</p>
      <p className={styles.onMeActions}>{st.ref ? <button type="button" className={styles.taskSource} onClick={() => onJump(st.ref!)}>查看 #{st.ref}</button> : null}
        <button type="button" className={styles.taskSource} onClick={() => onReply(m, st.ref ?? 0)}>回复{st.ref ? ` #${st.ref}` : ''}</button></p>
    </li>; })}</ul>
  </section>;
}

const waitChoices: WaitKind[] = ['member', 'review', 'user', 'external', 'decision'];
/** Your own state. A wait must say what would let you continue; member and review waits name someone. */
export function MyState({ current, others, disabled, onSave }: { current?: MemberState; others: Member[]; disabled: boolean; onSave: (fields: Record<string, unknown>) => Promise<boolean> }) {
  const [state, setState] = useState<WorkState>(current?.state ?? 'idle');
  const [kind, setKind] = useState<WaitKind>(current?.waitingFor ?? 'member');
  const [on, setOn] = useState(current?.on?.[0] ?? '');
  const [detail, setDetail] = useState(current?.detail ?? '');
  const [busy, setBusy] = useState(false);
  const waiting = state === 'waiting'; const named = waiting && (kind === 'member' || kind === 'review');
  const target = others.some(m => m.id === on) ? on : '';
  const ready = !waiting || !!detail.trim() && (!named || !!target);
  const submit = (event: FormEvent) => { event.preventDefault(); if (!ready || busy) return; setBusy(true);
    const text = detail.trim();
    // A hidden choice is never sent: an external wait names nobody even if a member was picked before.
    void onSave({ state, ...(waiting ? { waitingFor: kind, ...(target && kind !== 'external' ? { on: [target] } : {}) } : {}), ...(text ? { detail: text } : {}) }).finally(() => setBusy(false));
  };
  return <form className={styles.myState} onSubmit={submit} aria-label="我的状态">
    <label className={styles.inviteChoice}>我的状态<select value={state} disabled={disabled} onChange={e => setState(e.target.value as WorkState)}>{(Object.keys(stateLabels) as WorkState[]).map(s => <option key={s} value={s}>{stateLabels[s]}</option>)}</select></label>
    {waiting && <label className={styles.inviteChoice}>在等什么<select value={kind} disabled={disabled} onChange={e => setKind(e.target.value as WaitKind)}>{waitChoices.map(k => <option key={k} value={k}>{waitLabels[k]}</option>)}</select></label>}
    {waiting && kind !== 'external' && <label className={styles.inviteChoice}>等谁<select value={target} disabled={disabled} onChange={e => setOn(e.target.value)}><option value="">{named ? '请选择成员' : '不指定'}</option>{others.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
    <Input aria-label="状态说明" value={detail} maxLength={280} disabled={disabled} onChange={e => setDetail(e.target.value.replace(/\s+/g, ' '))} placeholder={waiting ? '写清楚：发生什么之后你就能继续' : '说明（可选）'} />
    <Button type="submit" disabled={disabled || busy || !ready}>更新状态</Button>
  </form>;
}
