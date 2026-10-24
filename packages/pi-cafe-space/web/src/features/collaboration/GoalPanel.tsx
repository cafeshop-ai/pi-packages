import { useId, useState, type FormEvent } from 'react';
import { Button, Input, Label, Textarea } from '../../components/ui/Controls';
import { collaboration, type GoalState, type Membership, type Message, type Snapshot } from './api';
import styles from './Collaboration.module.scss';

const statuses = { active: '进行中', paused: '已暂停', review: '待验收', done: '已完成' };

export function GoalPanel({ snapshot, auth, messages, disabled, onChange, onJump }: {
  snapshot: Snapshot; auth: Membership; messages: Message[]; disabled: boolean;
  onChange(value: GoalState): void; onJump(seq: number): void;
}) {
  const fieldId = useId();
  const [creating, setCreating] = useState(false); const [title, setTitle] = useState(''); const [criteria, setCriteria] = useState('');
  const [reviewer, setReviewer] = useState(''); const [result, setResult] = useState(''); const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const me = snapshot.members.find(m => m.id === auth.memberId); const owner = me?.owner === true;
  const goal = snapshot.goal; const humans = snapshot.members.filter(m => m.kind === 'human' && !m.removed);
  const currentReviewer = humans.find(m => m.id === goal?.reviewer); const canReview = currentReviewer?.id === auth.memberId;
  const chosenReviewer = humans.some(m => m.id === reviewer) ? reviewer : currentReviewer?.id ?? '';
  const tasks = (snapshot.tasks ?? []).filter(t => t.goalId === goal?.id); const done = tasks.filter(t => t.status === 'done').length;
  const evidence = messages.filter(m => m.memberId === auth.memberId);
  const locked = disabled || busy || (me?.kind === 'ai' && snapshot.aiPaused === true);
  const change = async (action: string, fields: Record<string, unknown> = {}) => {
    if (locked) return;
    setBusy(true); setError('');
    try {
      const value = await collaboration<GoalState>({ op: 'goal', roomId: auth.roomId, action, goalRevision: snapshot.goalRevision,
        ...(action !== 'create' ? { goalId: goal?.id } : {}), ...fields }, auth.token);
      onChange(value); setCreating(false); setDeleting(false); setResult(''); setReviewer('');
      if (action === 'create') { setTitle(''); setCriteria(''); }
    } catch (e) { setError(e instanceof Error ? e.message : '操作失败；请核对最新 Goal 状态，不要盲目重试。'); }
    finally { setBusy(false); }
  };
  const create = (event: FormEvent) => { event.preventDefault(); void change('create', { title: title.trim(), criteria: criteria.trim(), reviewer: chosenReviewer }); };
  // Old servers do not advertise a goal revision and must not receive unsupported writes.
  if (snapshot.goalRevision === undefined) return null;
  return <section className={styles.goal} aria-label="房间 Goal" aria-busy={busy}>
    <header className={styles.goalHead}><h3>Goal</h3><span role="status">{goal ? statuses[goal.status] : '未设置目标'}</span></header>
    {goal && <>
      <h4>{goal.title}</h4>
      <p className={styles.goalCriteria} tabIndex={0}>{goal.criteria}</p>
      <p className={styles.note}>验收人：{currentReviewer?.name ?? '已离开，请房主重新指定'} · 关联任务 {done}/{tasks.length} 已完成</p>
      {goal.result && <button type="button" className={styles.taskSource} onClick={() => onJump(goal.result!)}>{goal.status === 'review' || goal.status === 'done' ? '验收证据' : '上次提交'} #{goal.result}</button>}
      {goal.status === 'paused' && <p className={styles.note}>目标已暂停；Resume 后从现有任务继续，不会重新创建目标。</p>}
      {goal.status === 'review' && <p className={styles.note}>已提交不等于完成，等待指定验收人核对证据。</p>}
      <div className={styles.row}>
        {owner && goal.status === 'active' && <Button disabled={locked} onClick={() => void change('pause')}>暂停 Goal</Button>}
        {owner && goal.status === 'paused' && <Button variant="primary" disabled={locked || !currentReviewer} onClick={() => void change('resume')}>Resume Goal</Button>}
        {canReview && goal.status === 'review' && <><Button variant="primary" disabled={locked} onClick={() => void change('accept')}>验收通过</Button><Button disabled={locked} onClick={() => void change('reject')}>退回继续</Button></>}
        {owner && <Button variant="quiet" disabled={locked} onClick={() => setDeleting(true)}>删除 Goal</Button>}
      </div>
      {owner && goal.status !== 'done' && <details><summary>更换验收人</summary><label className={styles.inviteChoice}>新验收人<select aria-label="新验收人" value={chosenReviewer} disabled={locked} onChange={e => setReviewer(e.target.value)}><option value="">选择人类成员</option>{humans.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label><Button disabled={locked || !chosenReviewer || chosenReviewer === goal.reviewer} onClick={() => void change('reviewer', { reviewer: chosenReviewer })}>保存验收人</Button></details>}
      {goal.status === 'active' && <form className={styles.goalForm} onSubmit={event => { event.preventDefault(); void change('submit', { resultSeq: Number(result) }); }}>
        <label className={styles.inviteChoice}>完成证据<select aria-label="完成证据消息" value={result} disabled={locked} onChange={e => setResult(e.target.value)}><option value="">选择自己已发的结果消息</option>{evidence.map(m => <option key={m.seq} value={m.seq}>#{m.seq} {m.text.replace(/\s+/g, ' ').slice(0, 45)}</option>)}</select></label>
        <Button type="submit" disabled={locked || !result || done !== tasks.length || !currentReviewer}>提交 Goal 验收</Button>
      </form>}
      {deleting && <div className={styles.goalForm} role="group" aria-label="确认删除 Goal"><p>只删除当前 Goal，保留已有任务和聊天记录。</p><div className={styles.row}><Button disabled={locked} onClick={() => void change('delete')}>确认删除 Goal</Button><Button variant="quiet" disabled={locked} onClick={() => setDeleting(false)}>取消删除</Button></div></div>}
    </>}
    {owner && (!goal || goal.status === 'done') && (creating ? <form className={styles.goalForm} onSubmit={create}>
      <Label htmlFor={fieldId + '-title'}>目标</Label><Input id={fieldId + '-title'} value={title} maxLength={200} required disabled={locked} onChange={e => setTitle(e.target.value)} placeholder="要达成什么结果" />
      <Label htmlFor={fieldId + '-criteria'}>验收条件与限制</Label><Textarea id={fieldId + '-criteria'} value={criteria} maxLength={4000} rows={4} required disabled={locked} onChange={e => setCriteria(e.target.value)} placeholder="怎样验证完成，哪些约束必须保留" />
      <label className={styles.inviteChoice}>验收人<select aria-label="Goal 验收人" value={chosenReviewer} required disabled={locked} onChange={e => setReviewer(e.target.value)}><option value="">选择人类成员</option>{humans.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <p className={styles.note}>已有未完成任务会归入本目标。Goal 不授予任何成员新的本机操作权限。</p>
      <div className={styles.row}><Button variant="primary" type="submit" disabled={locked || !title.trim() || !criteria.trim() || !chosenReviewer}>启动 Goal</Button><Button disabled={locked} variant="quiet" onClick={() => setCreating(false)}>取消</Button></div>
    </form> : <Button disabled={locked} onClick={() => { setReviewer(''); setCreating(true); }}>{goal ? '新建下一个 Goal' : '设置 Goal'}</Button>)}
    {error && <p role="alert" className={styles.formError}>{error}</p>}
  </section>;
}
