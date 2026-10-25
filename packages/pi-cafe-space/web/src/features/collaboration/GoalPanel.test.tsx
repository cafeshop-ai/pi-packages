import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { GoalPanel } from './GoalPanel';
import { type Goal, type Snapshot } from './api';

const owner = 'a'.repeat(32), reviewer = 'b'.repeat(32), ai = 'c'.repeat(32), roomId = 'd'.repeat(32);
const goal: Goal = { id: 1, title: '发布验收', criteria: '测试通过\n保留数据', reviewer, status: 'active', createdBy: owner, updatedAt: '2030-01-01T00:00:00Z' };
const initial: Snapshot = { roomId, memberId: owner, title: 'Room', expires: '2030-02-01T00:00:00Z', cursor: 0, more: false, messages: [], goal: null, goalRevision: 0, tasks: [], members: [
  { id: owner, name: '房主', kind: 'human', owner: true }, { id: reviewer, name: '验收同事', kind: 'human', owner: false }, { id: ai, name: '工作 AI', kind: 'ai', owner: false },
] };
const messages = [{ seq: 1, id: 'evidence-01', memberId: ai, text: '验证通过的证据', at: '2030-01-01T00:00:00Z' }, { seq: 2, id: 'evidence-02', memberId: owner, text: '房主的消息', at: '2030-01-01T00:00:00Z' }];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function mount(snapshot = initial, memberId = owner) {
  const requests: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url, init: RequestInit) => {
    const q = JSON.parse(init.body as string); requests.push(q);
    const current = snapshot.goal ?? goal;
    const next = q.action === 'delete' ? null : q.action === 'create' ? { ...goal, title: q.title, criteria: q.criteria, reviewer: q.reviewer } : { ...current, status: ({ pause: 'paused', resume: 'active', submit: 'review', accept: 'done', reject: 'active' } as Record<string, string>)[q.action] ?? current.status };
    return new Response(JSON.stringify({ goal: next, goalRevision: q.goalRevision + 1, tasks: snapshot.tasks ?? [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetcher);
  function Harness() {
    const [value, setValue] = useState(snapshot);
    return <GoalPanel snapshot={value} auth={{ roomId, memberId, token: 'e'.repeat(64) }} messages={messages} disabled={false} onChange={v => setValue(old => ({ ...old, ...v }))} onJump={() => {}} />;
  }
  render(<Harness />); return { requests, fetcher };
}

it('creates one Goal with explicit criteria and a selected human reviewer', async () => {
  const { requests } = mount(initial, reviewer);
  fireEvent.click(screen.getByRole('button', { name: '设置 Goal' }));
  expect(screen.getByRole('button', { name: '启动 Goal' })).toBeDisabled();
  expect([...(screen.getByLabelText('Goal 验收人') as HTMLSelectElement).options].map(o => o.value)).toEqual(['', owner, reviewer]);
  fireEvent.change(screen.getByLabelText('目标'), { target: { value: '上线邀请改动' } });
  fireEvent.change(screen.getByLabelText('验收条件与限制'), { target: { value: '邀请复制完整，保留数据' } });
  fireEvent.change(screen.getByLabelText('Goal 验收人'), { target: { value: reviewer } });
  fireEvent.click(screen.getByRole('button', { name: '启动 Goal' }));
  await screen.findByText('上线邀请改动');
  expect(requests[0]).toEqual({ op: 'goal', roomId, action: 'create', goalRevision: 0, title: '上线邀请改动', criteria: '邀请复制完整，保留数据', reviewer });
});
it('pauses and resumes the same Goal and confirms deletion without touching tasks/messages', async () => {
  const { requests } = mount({ ...initial, goal, goalRevision: 1 }, ai);
  fireEvent.click(screen.getByRole('button', { name: '暂停 Goal' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Resume Goal' }));
  await screen.findByRole('button', { name: '暂停 Goal' });
  expect(requests.map(q => [q.action, q.goalId, q.goalRevision])).toEqual([['pause', 1, 1], ['resume', 1, 2]]);
  fireEvent.click(screen.getByRole('button', { name: '删除 Goal' })); expect(requests).toHaveLength(2);
  expect(screen.getByText('只删除当前 Goal，保留已有任务和聊天记录。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '确认删除 Goal' }));
  await screen.findByRole('button', { name: '设置 Goal' });
  expect(requests[2]).toMatchObject({ op: 'goal', action: 'delete', goalRevision: 3, goalId: 1 }); expect(requests).toHaveLength(3);
});
it('allows AI to submit its own evidence but never to accept the Goal', async () => {
  const { requests } = mount({ ...initial, goal, goalRevision: 4 }, ai);
  expect(screen.getByRole('button', { name: '暂停 Goal' })).toBeEnabled();
  expect([...(screen.getByLabelText('完成证据消息') as HTMLSelectElement).options].map(o => o.value)).toEqual(['', '1']);
  fireEvent.change(screen.getByLabelText('完成证据消息'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: '提交 Goal 验收' }));
  await screen.findByText('待验收'); expect(requests[0]).toMatchObject({ action: 'submit', goalId: 1, goalRevision: 4, resultSeq: 1 });
  expect(screen.queryByRole('button', { name: '验收通过' })).toBeNull();
});
it('reserves acceptance for the reviewer, not the owner', async () => {
  mount({ ...initial, goal: { ...goal, status: 'review', result: 1, resultBy: ai }, goalRevision: 5 });
  expect(screen.queryByRole('button', { name: '验收通过' })).toBeNull(); cleanup();
  const { requests } = mount({ ...initial, goal: { ...goal, status: 'review', result: 1, resultBy: ai }, goalRevision: 5 }, reviewer);
  fireEvent.click(screen.getByRole('button', { name: '验收通过' }));
  await screen.findByText('已完成'); expect(requests[0]).toMatchObject({ action: 'accept', goalId: 1, goalRevision: 5 });
});
it('blocks review until tasks are done and blocks resume while the reviewer is absent', () => {
  mount({ ...initial, goal, goalRevision: 1, tasks: [{ id: 1, title: 'Pending', status: 'todo', goalId: 1, createdBy: owner, updatedAt: goal.updatedAt }] }, ai);
  fireEvent.change(screen.getByLabelText('完成证据消息'), { target: { value: '1' } });
  expect(screen.getByRole('button', { name: '提交 Goal 验收' })).toBeDisabled(); cleanup();
  mount({ ...initial, goal: { ...goal, status: 'paused' }, goalRevision: 2, members: initial.members.map(m => m.id === reviewer ? { ...m, removed: true } : m) });
  expect(screen.getByRole('button', { name: 'Resume Goal' })).toBeDisabled();
});
it('reports conflicts without optimistic completion or automatic write retries', async () => {
  const { fetcher } = mount({ ...initial, goal, goalRevision: 1 });
  fetcher.mockResolvedValue(new Response(JSON.stringify({ error: 'GOAL_CHANGED' }), { status: 409 }));
  fireEvent.click(screen.getByRole('button', { name: '暂停 Goal' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Goal 已变化');
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); expect(screen.getByText('进行中')).toBeInTheDocument();
});
it('does not offer unsupported Goal controls on an older relay', () => {
  mount({ ...initial, goalRevision: undefined }); expect(screen.queryByRole('region', { name: '房间 Goal' })).toBeNull();
});
it('offers non-owner AI creation but still respects the room AI pause', () => {
  mount(initial, ai);
  expect(screen.getByRole('button', { name: '设置 Goal' })).toBeEnabled(); cleanup();
  mount({ ...initial, aiPaused: true }, ai);
  expect(screen.getByRole('button', { name: '设置 Goal' })).toBeDisabled();
});
