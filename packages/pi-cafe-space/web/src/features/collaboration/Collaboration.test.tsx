import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Collaboration, connectorState, deliveryOf, thinkingOf } from './Collaboration';
import { App } from '../../app/App';
import { aiInstructions, collaboration, saveMembership, type Member } from './api';
import { probeBlocked, probeDaily, probeOf, probesOf, probeText, probeWait } from './probe';
const roomId = 'a'.repeat(32), memberId = 'b'.repeat(32), token = 'c'.repeat(64), invite = 'd'.repeat(64);
const auth = { roomId, memberId, token };
const snapshot = { roomId, memberId, title: '多人讨论', expires: '2030-01-01T00:00:00Z', members: [{ id: memberId, name: '创建者', kind: 'human', owner: true }, { id: 'e'.repeat(32), name: '同事的 AI', kind: 'ai' }], messages: [], cursor: 0, more: false };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
let fetcher: Mock<(url: string, init: RequestInit) => Promise<Response>>;
beforeEach(() => {
  localStorage.clear(); fetcher = vi.fn(async (_: string, init: RequestInit) => {
    const q = JSON.parse(init.body as string);
    if (q.op === 'status') return response({ enabled: true });
    if (q.op === 'create' || q.op === 'join') return response(auth);
    if (q.op === 'read') return response(snapshot);
    if (q.op === 'invite') return response({ url: `${window.location.origin}/#/collab/${roomId}?invite=${invite}` });
    if (q.op === 'send') return response({ seq: 1, id: q.id, memberId, text: q.text, at: '2030-01-01T00:00:00Z' });
    return response({ ok: true });
  }); vi.stubGlobal('fetch', fetcher); vi.stubGlobal('scrollIntoView', vi.fn());
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.location.hash = ''; });
const mount = (path = '/collab') => render(<MemoryRouter initialEntries={[path]}><Collaboration /></MemoryRouter>);
it('creates a standalone room and generates a transferable human/AI invitation without member credentials', async () => {
  mount(); fireEvent.change(screen.getByLabelText('房间名称'), { target: { value: '多人讨论' } }); fireEvent.change(screen.getByLabelText('你的名称'), { target: { value: '创建者' } });
  await waitFor(() => expect(screen.getByRole('button', { name: '创建协作房间' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: '创建协作房间' }));
  expect(await screen.findByRole('heading', { name: '多人讨论' })).toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: '邀请同事 / AI' }));
  expect((await screen.findByLabelText('邀请链接') as HTMLInputElement).value).toContain(invite);
  fireEvent.click(screen.getByText('让我的 AI 加入 · 无需安装')); const instructions = screen.getByLabelText('AI 接入说明') as HTMLTextAreaElement;
  expect(instructions.value).toContain('/api/collaboration/guide'); expect(instructions.value).not.toContain(token); expect(instructions.value).toContain(invite);
  expect(instructions.value).toContain('Monitor 工具在后台运行一个监听脚本');
  fireEvent.click(screen.getByRole('radio', { name: '其他 AI' }));
  const generic = (screen.getByLabelText('AI 接入说明') as HTMLTextAreaElement).value; expect(generic).not.toContain('Monitor 工具在后台运行一个监听脚本'); expect(generic).toContain(invite);
  expect(JSON.parse(localStorage.getItem('cafe-collaboration-v1:' + roomId)!)).toEqual(auth);
});
it('joins only after explicit confirmation and sends no cookie or invitation on reads', async () => {
  mount(`/collab/${roomId}?invite=${invite}`); expect(fetcher).not.toHaveBeenCalled(); fireEvent.change(screen.getByLabelText('你的名称'), { target: { value: '同事' } }); fireEvent.click(screen.getByRole('button', { name: '同意并加入' }));
  await screen.findByRole('heading', { name: '多人讨论' }); const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
  const join = calls.find(([, v]) => JSON.parse(v.body as string).op === 'join')!; expect(JSON.parse(join[1].body as string)).toMatchObject({ invite, kind: 'human' });
  const read = calls.find(([, v]) => JSON.parse(v.body as string).op === 'read')!; expect(read[1].credentials).toBe('omit'); expect(read[1].headers).toMatchObject({ Authorization: 'Bearer ' + token }); expect(read[1].body).not.toContain(invite);
});
it('keeps the same message id when a send result is unknown, and renders text rather than HTML', async () => {
  saveMembership(auth); mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' });
  const original = fetcher.getMockImplementation()!; let failed = false;
  fetcher.mockImplementation(async (url: string, init: RequestInit) => { if (JSON.parse(init.body as string).op === 'send' && !failed) { failed = true; throw Error('connection lost'); } return original(url, init); });
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '<img src=x onerror=alert(1)>' } }); fireEvent.click(screen.getByRole('button', { name: '发送' })); await screen.findByRole('alert');
  await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).not.toBeDisabled()); fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument(); expect(document.querySelector('.message img')).toBeNull();
  const sent = (fetcher.mock.calls as unknown as [string, RequestInit][]).map(([, v]) => JSON.parse(v.body as string)).filter(v => v.op === 'send'); expect(sent).toHaveLength(2); expect(sent[0].id).toBe(sent[1].id);
});
it('keeps message sequence order when polling catches up with a locally sent message', async () => {
  vi.useFakeTimers(); saveMembership(auth); let reads = 0;
  const first = { seq: 1, id: 'other-first', memberId: 'e'.repeat(32), text: '较早的同事消息', at: '2030-01-01T00:00:00Z' };
  const second = { seq: 2, id: 'own-second', memberId, text: '自己的消息', at: '2030-01-01T00:00:01Z' };
  fetcher.mockImplementation(async (_url, init) => { const q = JSON.parse(init.body as string); return response(q.op === 'send' ? second : ++reads === 1 ? snapshot : { ...snapshot, cursor: 2, messages: [first, second] }); });
  await act(async () => { mount('/collab/' + roomId); });
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: second.text } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '发送' })); });
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  const entries = [...screen.getByRole('log').querySelectorAll('article')]; expect(entries).toHaveLength(2);
  expect(entries[0]).toHaveTextContent(first.text); expect(entries[1]).toHaveTextContent(second.text);
});
const sent = () => (fetcher.mock.calls as unknown as [string, RequestInit][]).map(([, v]) => JSON.parse(v.body as string));
const openMenu = async () => fireEvent.click(await screen.findByRole('button', { name: '房间菜单' }));
const fromMenu = async (item: string) => { await openMenu(); fireEvent.click(await screen.findByRole('menuitem', { name: item })); };
it('requires confirmation before revoking invitations and stops writes after membership is revoked', async () => {
  saveMembership(auth); mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' }); await fromMenu('撤销全部邀请');
  expect(sent().some(v => v.op === 'revoke')).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: '确认撤销' })); await waitFor(() => expect(sent().some(v => v.op === 'revoke')).toBe(true));
  cleanup(); fetcher.mockResolvedValue(response({ error: 'MEMBER_REQUIRED' }, 401)); mount('/collab/' + roomId);
  await screen.findByText('成员凭据已失效或已被移除。'); expect(screen.getByLabelText('消息')).toBeDisabled();
});
it('routes collaboration without initializing or controlling an office Pi', async () => {
  window.location.hash = '#/collab'; const createOwner = vi.fn(() => { throw Error('must not create office owner'); });
  render(<App createOwner={createOwner} />); expect(await screen.findByRole('heading', { name: '一起讨论，不限工具。' })).toBeInTheDocument(); expect(createOwner).not.toHaveBeenCalled();
});
it('sends with Enter, keeps Shift+Enter for new lines and shows the reply target', async () => {
  saveMembership(auth);
  const earlier = { seq: 1, id: 'from-ai', memberId: 'e'.repeat(32), text: '请确认部署窗口', at: '2030-01-01T00:00:00Z' };
  fetcher.mockImplementation(async (_url, init) => { const q = JSON.parse(init.body as string); return response(q.op === 'send' ? { seq: 2, id: q.id, memberId, text: q.text, replyTo: q.replyTo, to: q.to, at: '2030-01-01T00:00:01Z' } : { ...snapshot, cursor: 1, messages: [earlier] }); });
  mount('/collab/' + roomId); await screen.findByText('请确认部署窗口');
  fireEvent.click(screen.getByRole('button', { name: '回复 #1' })); expect(screen.getByText('回复 同事的 AI：请确认部署窗口')).toBeInTheDocument();
  const box = screen.getByLabelText('消息'); fireEvent.change(box, { target: { value: '今晚 9 点' } });
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
  expect((fetcher.mock.calls as unknown as [string, RequestInit][]).some(([, v]) => JSON.parse(v.body as string).op === 'send')).toBe(false);
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() => expect((fetcher.mock.calls as unknown as [string, RequestInit][]).map(([, v]) => JSON.parse(v.body as string)).find(v => v.op === 'send')).toMatchObject({ text: '今晚 9 点', replyTo: 1, to: 'e'.repeat(32) }));
});
it('shows AI connector reports honestly: online, offline or unknown, never failure', async () => {
  const ai = 'e'.repeat(32), other = 'f'.repeat(32), fresh = new Date().toISOString();
  saveMembership(auth);
  fetcher.mockImplementation(async () => response({ ...snapshot, members: [...snapshot.members, { id: other, name: '离线的 AI', kind: 'ai' }, { id: '9'.repeat(32), name: '未接入的 AI', kind: 'ai' }],
    presence: { [ai]: { fetched: 2, delivered: 1, heartbeatAt: fresh }, [other]: { fetched: 1, delivered: 1, heartbeatAt: '2020-01-01T00:00:00Z' } } }));
  mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' });
  fireEvent.click(screen.getByRole('tab', { name: /成员/ }));
  const online = await screen.findByText('在线'); expect(online).toHaveAttribute('title', '连接器上报：已取到 #2，已送入会话 #1');
  expect(screen.getByText(/^离线 · /)).toBeInTheDocument(); expect(screen.getByText('未接入连接器')).toBeInTheDocument();
  expect(screen.getByText(/启动后台监听/)).toBeInTheDocument(); expect(screen.getByText(/后台监听已停止/)).toBeInTheDocument();
  expect(connectorState({ fetched: 0, delivered: 0, paused: true, heartbeatAt: fresh }, Date.now()).tone).toBe('paused');
});
it('derives response tests from room history: one round trip, honest silence, room-wide limits', () => {
  const ai = 'e'.repeat(32), members = snapshot.members as Member[]; const at = (s: number) => new Date(Date.UTC(2030, 0, 1, 0, 0, s)).toISOString(); const t0 = Date.parse(at(0));
  const probe = { seq: 1, id: 'probe-0001', memberId, to: ai, text: probeText('K7Q2'), at: at(0) };
  expect(probeOf(probe, members)).toBe('K7Q2');
  // Only the addressed AI's own message carrying the code counts; a human echoing it or a wrong reply target does not.
  const echo = { seq: 2, id: 'echo-00001', memberId, text: 'K7Q2', at: at(3) };
  const misplaced = { seq: 3, id: 'misplaced1', memberId: ai, text: 'K7Q2', replyTo: 2, at: at(5) };
  const answer = { seq: 4, id: 'answer-001', memberId: ai, text: '收到 K7Q2', replyTo: 1, at: at(12) };
  expect(probesOf([probe, echo, misplaced], members, t0 + 60_000).latest.get(ai)).toMatchObject({ state: 'waiting' });
  const silent = probesOf([probe, echo], members, t0 + probeWait).latest.get(ai)!; expect(silent.label).toBe('尚未确认响应，原因未知');
  const ok = probesOf([probe, echo, misplaced, answer], members, t0 + 60_000); expect(ok.latest.get(ai)!.label).toBe('本次响应测试成功，耗时 12 秒'); expect(ok.answers.get(4)).toBe(ok.latest.get(ai));
  expect(probeBlocked(ok.latest.get(ai), 1, t0 + 60_000)).toBe('10 分钟内只能测试一次'); expect(probeBlocked(ok.latest.get(ai), probeDaily, t0 + probeWait)).toMatch(/24 小时内/);
  expect(probeBlocked(ok.latest.get(ai), 1, t0 + probeWait)).toBe('');
  // An AI cannot start a test, and a test of a human is not one.
  expect(probeOf({ ...probe, memberId: ai, to: memberId }, members)).toBeUndefined();
});
it('lets a human test an AI from the member list and shows the answer as one line', async () => {
  saveMembership(auth); const ai = 'e'.repeat(32); let messages: Record<string, unknown>[] = [];
  fetcher.mockImplementation(async (_url, init) => {
    const q = JSON.parse(init.body as string);
    if (q.op === 'send') { const sent = { seq: messages.length + 1, id: q.id, memberId, to: q.to, text: q.text, at: new Date().toISOString() }; messages = [...messages, sent]; return response(sent); }
    return response({ ...snapshot, cursor: messages.length, messages });
  });
  mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' }); fireEvent.click(screen.getByRole('tab', { name: /成员/ }));
  fireEvent.click(await screen.findByRole('button', { name: '测试响应' }));
  await waitFor(() => expect(sent().find(v => v.op === 'send')).toMatchObject({ to: ai })); const code = /验证码 ([A-Z0-9]{4})/.exec(sent().find(v => v.op === 'send')!.text)![1];
  expect(await screen.findByText('正在等待响应测试的回复')).toBeInTheDocument(); expect(screen.getByRole('button', { name: '再测一次' })).toBeDisabled();
  expect(screen.getByText(/向 同事的 AI 发起响应测试/)).toBeInTheDocument(); expect(screen.queryByText(/收到请直接在房间回复/)).toBeNull();
  const start = Date.parse(messages[0]!.at as string);
  messages = [...messages, { seq: 2, id: 'ai-answer-1', memberId: ai, text: code, replyTo: 1, at: new Date(start + 4000).toISOString() }, { seq: 3, id: 'ai-follow-1', memberId: ai, text: '另外我开始核对清单了', at: new Date(start + 6000).toISOString() }];
  expect(await screen.findByText('本次响应测试成功，耗时 4 秒', {}, { timeout: 8000 })).toBeInTheDocument();
  expect(screen.getByText(/同事的 AI 已回复响应测试 · 耗时 4 秒/)).toBeInTheDocument();
  // A collapsed line breaks the run, so the next message from the same AI still names its author.
  expect(document.querySelector('#msg-3 header strong')?.textContent).toBe('同事的 AI');
}, 15_000);
it('derives delivery of addressed messages from replies and connector reports only', () => {
  const ai = { id: 'e'.repeat(32), name: '同事的 AI', kind: 'ai' as const, owner: false }, human = { id: memberId, name: '创建者', kind: 'human' as const, owner: true };
  const ask = { seq: 3, id: 'ask-ai', memberId, text: '请核对', to: ai.id, at: '2030-01-01T00:00:00Z' };
  const answer = { seq: 4, id: 'ai-answer', memberId: ai.id, text: '已核对', replyTo: 3, to: memberId, at: '2030-01-01T00:00:01Z' };
  const at = '2030-01-01T00:00:00Z';
  expect(deliveryOf(ask, [human, ai], [ask, answer])).toMatchObject({ state: 'replied', label: '同事的 AI 已回复' });
  expect(deliveryOf(ask, [human, ai], [ask])).toBeNull();
  expect(deliveryOf(ask, [human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 3, heartbeatAt: at } })?.state).toBe('delivered');
  expect(deliveryOf(ask, [human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 2, heartbeatAt: at } })?.state).toBe('fetched');
  expect(deliveryOf(ask, [human, ai], [ask], { [ai.id]: { fetched: 2, delivered: 2, heartbeatAt: at } })?.state).toBe('waiting');
  expect(deliveryOf({ ...ask, to: memberId }, [human, ai], [ask])).toBeNull();
  // "Thinking" needs a live connector that delivered the latest ask and no answer since.
  const live = new Date().toISOString();
  expect(thinkingOf([human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 3, heartbeatAt: live } }).map(m => m.id)).toEqual([ai.id]);
  expect(thinkingOf([human, ai], [ask, answer], { [ai.id]: { fetched: 4, delivered: 4, heartbeatAt: live } })).toEqual([]);
  expect(thinkingOf([human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 2, heartbeatAt: live } })).toEqual([]);
  expect(thinkingOf([human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 3, heartbeatAt: '2020-01-01T00:00:00Z' } })).toEqual([]);
});
it('shows an honest "delivered, waiting" hint and compact delivery marks for messages addressed to an AI', async () => {
  saveMembership(auth); const ai = 'e'.repeat(32);
  const ask = { seq: 1, id: 'ask-the-ai', memberId, text: '请核对版本', to: ai, at: '2030-01-01T00:00:00Z' };
  fetcher.mockImplementation(async () => response({ ...snapshot, cursor: 1, messages: [ask], presence: { [ai]: { fetched: 1, delivered: 1, heartbeatAt: new Date().toISOString() } } }));
  mount('/collab/' + roomId); expect(await screen.findByText('已送达 同事的 AI · 等待回复')).toBeInTheDocument();
  expect(screen.getByLabelText(/已送入 同事的 AI 的会话/)).toHaveTextContent('✓');
});
it('lets the owner pause AI posting only after confirmation and shows the pause to everyone', async () => {
  saveMembership(auth); mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' });
  await fromMenu('暂停所有 AI 发言');
  expect(sent().some(v => v.op === 'pause')).toBe(false);
  fireEvent.click(await screen.findByRole('button', { name: '确认暂停' }));
  expect(await screen.findByText('AI 发言已暂停')).toBeInTheDocument();
  expect(sent().find(v => v.op === 'pause')).toMatchObject({ roomId, paused: true });
  await openMenu(); expect(await screen.findByRole('menuitem', { name: '恢复 AI 发言' })).toBeInTheDocument();
});
it('runs a task board: add, advance, assign and turn a message into a task', async () => {
  saveMembership(auth); const ai = 'e'.repeat(32); let tasks: Record<string, unknown>[] = [];
  const ask = { seq: 1, id: 'ask-the-ai', memberId, text: '请整理发布清单并核对版本号', to: ai, at: '2030-01-01T00:00:00Z' };
  fetcher.mockImplementation(async (_url, init) => {
    const q = JSON.parse(init.body as string);
    if (q.op === 'task' && q.action === 'create') { const task = { id: tasks.length + 1, title: q.title, status: 'todo', createdBy: memberId, updatedAt: '2030-01-01T00:00:00Z', ...(q.assignee ? { assignee: q.assignee } : {}), ...(q.from ? { from: q.from } : {}) }; tasks = [...tasks, task]; return response(task); }
    if (q.op === 'task' && q.action === 'update') { tasks = tasks.map(t => t.id === q.taskId ? { ...t, ...(q.status ? { status: q.status } : {}), ...('assignee' in q ? { assignee: q.assignee || undefined } : {}) } : t); return response(tasks.find(t => t.id === q.taskId)); }
    return response({ ...snapshot, cursor: 1, messages: [ask], tasks });
  });
  mount('/collab/' + roomId); await screen.findByText('请整理发布清单并核对版本号');
  const input = screen.getByLabelText('新任务'); fireEvent.change(input, { target: { value: '更新发布说明' } }); fireEvent.submit(input.closest('form')!);
  expect(await screen.findByText('更新发布说明')).toBeInTheDocument(); expect(sent().find(v => v.op === 'task')).toMatchObject({ action: 'create', title: '更新发布说明' });
  fireEvent.click(screen.getByRole('button', { name: '开始「更新发布说明」' }));
  await waitFor(() => expect(sent().filter(v => v.op === 'task').at(-1)).toMatchObject({ action: 'update', taskId: 1, status: 'doing' }));
  fireEvent.change(await screen.findByLabelText('「更新发布说明」的负责人'), { target: { value: ai } });
  await waitFor(() => expect(sent().filter(v => v.op === 'task').at(-1)).toMatchObject({ action: 'update', taskId: 1, assignee: ai }));
  fireEvent.click(screen.getByRole('button', { name: '转为任务' }));
  await waitFor(() => expect(sent().filter(v => v.op === 'task').at(-1)).toMatchObject({ action: 'create', title: '请整理发布清单并核对版本号', from: 1, assignee: ai }));
  expect(await screen.findByText('已加入任务板')).toBeInTheDocument(); expect(screen.getByRole('button', { name: '来自 #1' })).toBeInTheDocument();
});
it('starts an empty board from a template with stable task ids, in order', async () => {
  saveMembership(auth); let tasks: Record<string, unknown>[] = []; let fail = 3;
  fetcher.mockImplementation(async (_url, init) => {
    const q = JSON.parse(init.body as string);
    if (q.op === 'task') { if (--fail === 0) return response({ error: 'RATE_LIMITED' }, 429); const known = tasks.find(t => t.key === q.id); if (known) return response(known); const task = { id: tasks.length + 1, key: q.id, title: q.title, status: 'todo', createdBy: memberId, updatedAt: '2030-01-01T00:00:00Z' }; tasks = [...tasks, task]; return response(task); }
    return response({ ...snapshot, tasks });
  });
  mount('/collab/' + roomId); fireEvent.click(await screen.findByRole('button', { name: /故障排查/ }));
  // A failure stops the run where it happened and claims no success.
  await waitFor(() => expect(sent().filter(v => v.op === 'task')).toHaveLength(3)); expect(tasks).toHaveLength(2); expect(screen.queryByText(/已添加/)).toBeNull();
  const creates = () => sent().filter(v => v.op === 'task'); expect(creates().map(v => v.id)).toEqual(['template-debug-v1-1', 'template-debug-v1-2', 'template-debug-v1-3']);
  tasks = []; cleanup(); mount('/collab/' + roomId); fireEvent.click(await screen.findByRole('button', { name: /故障排查/ }));
  expect(await screen.findByText('已添加「故障排查」的 5 项任务')).toBeInTheDocument();
  expect(tasks.map(t => t.title)).toEqual(['描述现象：影响范围、开始时间、复现步骤', '收集证据：日志、监控、最近变更', '提出假设并逐一验证', '修复或止损，写明回滚方式', '确认恢复，记录根因与后续']);
});
it('lets an ordinary member claim unassigned tasks but not move or reassign work owned by others', async () => {
  const boss = 'f'.repeat(32), ai = 'e'.repeat(32);
  saveMembership(auth);
  const members = [{ id: boss, name: '房主', kind: 'human', owner: true }, { id: memberId, name: '我', kind: 'human' }, { id: ai, name: '同事的 AI', kind: 'ai' }];
  const result = { seq: 1, id: 'ai-result-01', memberId: ai, text: '清单已整理', at: '2030-01-01T00:00:00Z' };
  const tasks = [{ id: 1, title: '整理清单', status: 'done', assignee: ai, createdBy: boss, result: 1, resultBy: ai, updatedAt: '2030-01-01T00:00:00Z' }, { id: 2, title: '核对版本', status: 'todo', createdBy: boss, updatedAt: '2030-01-01T00:00:00Z' }];
  fetcher.mockImplementation(async (_url, init) => { const q = JSON.parse(init.body as string); return response(q.op === 'task' ? { ...tasks[1], assignee: memberId, status: 'doing' } : { ...snapshot, members, cursor: 1, messages: [result], tasks }); });
  mount('/collab/' + roomId); await screen.findByText('核对版本');
  expect(screen.getByRole('button', { name: '重新打开「整理清单」' })).toBeDisabled(); expect(screen.queryByLabelText('「整理清单」的负责人')).toBeNull();
  expect(screen.getByRole('button', { name: '结果 #1 · 同事的 AI' })).toBeInTheDocument();
  const choices = [...(screen.getByLabelText('「核对版本」的负责人') as HTMLSelectElement).options].map(o => o.textContent); expect(choices).toEqual(['未指派', '我']);
  fireEvent.click(screen.getByRole('button', { name: '认领「核对版本」' }));
  await waitFor(() => expect(sent().find(v => v.op === 'task')).toMatchObject({ action: 'update', taskId: 2, assignee: memberId, status: 'doing', onlyIfUnassigned: true }));
});
it('renders a safe Markdown subset in messages', async () => {
  saveMembership(auth);
  const text = '要点：\n- 第一项 `npm ci`\n- **第二项** https://example.com/docs\n\n```\ngo test ./...\n```\n[危险](javascript:alert(1)) <b>raw</b>';
  fetcher.mockImplementation(async () => response({ ...snapshot, cursor: 1, messages: [{ seq: 1, id: 'markdown-1', memberId: 'e'.repeat(32), text, at: '2030-01-01T00:00:00Z' }] }));
  mount('/collab/' + roomId); const item = await screen.findByText('第一项', { exact: false });
  expect(item.closest('ul')).not.toBeNull(); expect(screen.getByText('npm ci').tagName).toBe('CODE'); expect(screen.getByText('第二项').tagName).toBe('STRONG');
  expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByText('go test ./...').closest('pre')).not.toBeNull();
  expect(screen.queryByRole('link', { name: '危险' })).toBeNull(); expect(document.querySelector('[role=log] b')).toBeNull(); expect(screen.getByText(/<b>raw<\/b>/)).toBeInTheDocument();
});
it('fails closed when the feature is unavailable and describes user-authorized AI operation', async () => {
  fetcher.mockResolvedValue(response({}, 404)); mount(); await screen.findByRole('alert'); expect(screen.getByRole('button', { name: '创建协作房间' })).toBeDisabled();
  const guide = aiInstructions('https://example.test/#/collab/example'); expect(guide).toContain('监听时长以我的授权为准'); expect(guide).not.toContain('最多 3 次回复'); expect(guide).toContain('不具备双向联网能力');
  expect(guide).toContain('wait 长轮询'); expect(guide).toContain('ack'); expect(guide).toContain('仅被点名不算授权'); expect(guide).toContain('房主暂停 AI 发言时只读不发');
  await expect(collaboration({ op: 'read' })).rejects.toThrow();
});
