import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Collaboration, connectorState, deliveryOf } from './Collaboration';
import { App } from '../../app/App';
import { aiInstructions, collaboration, saveMembership } from './api';
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
it('requires confirmation before revoking invitations and stops writes after membership is revoked', async () => {
  saveMembership(auth); mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' }); fireEvent.click(screen.getByRole('button', { name: '撤销全部邀请' }));
  expect((fetcher.mock.calls as unknown as [string, RequestInit][]).some(([, v]) => JSON.parse(v.body as string).op === 'revoke')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认' })); await waitFor(() => expect((fetcher.mock.calls as unknown as [string, RequestInit][]).some(([, v]) => JSON.parse(v.body as string).op === 'revoke')).toBe(true));
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
  fireEvent.click(screen.getByRole('button', { name: '回复 #1' })); expect(screen.getByText(/回复 #1 · 同事的 AI：请确认部署窗口/)).toBeInTheDocument();
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
  expect(screen.getByText('连接器在线')).toBeInTheDocument(); expect(screen.getByText('已取到 #2 · 已送入会话 #1')).toBeInTheDocument();
  expect(screen.getByText(/^连接器离线/)).toBeInTheDocument(); expect(screen.getByText('连接器未上报')).toBeInTheDocument();
  expect(connectorState({ fetched: 0, delivered: 0, paused: true, heartbeatAt: fresh }, Date.now()).tone).toBe('paused');
});
it('derives delivery of addressed messages from replies and connector reports only', () => {
  const ai = { id: 'e'.repeat(32), name: '同事的 AI', kind: 'ai' as const, owner: false }, human = { id: memberId, name: '创建者', kind: 'human' as const, owner: true };
  const ask = { seq: 3, id: 'ask-ai', memberId, text: '请核对', to: ai.id, at: '2030-01-01T00:00:00Z' };
  const answer = { seq: 4, id: 'ai-answer', memberId: ai.id, text: '已核对', replyTo: 3, to: memberId, at: '2030-01-01T00:00:01Z' };
  const at = '2030-01-01T00:00:00Z';
  expect(deliveryOf(ask, [human, ai], [ask, answer])).toBe('同事的 AI 已回复');
  expect(deliveryOf(ask, [human, ai], [ask])).toBeNull();
  expect(deliveryOf(ask, [human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 3, heartbeatAt: at } })).toBe('连接器上报：已送入对方会话');
  expect(deliveryOf(ask, [human, ai], [ask], { [ai.id]: { fetched: 3, delivered: 2, heartbeatAt: at } })).toBe('连接器上报：已取到');
  expect(deliveryOf(ask, [human, ai], [ask], { [ai.id]: { fetched: 2, delivered: 2, heartbeatAt: at } })).toBe('等待对方连接器');
  expect(deliveryOf({ ...ask, to: memberId }, [human, ai], [ask])).toBeNull();
});
it('lets the owner pause AI posting only after confirmation and shows the pause to everyone', async () => {
  saveMembership(auth); mount('/collab/' + roomId); await screen.findByRole('heading', { name: '多人讨论' });
  fireEvent.click(screen.getByRole('button', { name: '暂停所有 AI 发言' }));
  expect((fetcher.mock.calls as unknown as [string, RequestInit][]).some(([, v]) => JSON.parse(v.body as string).op === 'pause')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  expect(await screen.findByText('房主已暂停 AI 发言：AI 可以继续读取，但不应发帖。')).toBeInTheDocument();
  const pause = (fetcher.mock.calls as unknown as [string, RequestInit][]).map(([, v]) => JSON.parse(v.body as string)).find(v => v.op === 'pause');
  expect(pause).toMatchObject({ roomId, paused: true }); expect(screen.getByRole('button', { name: '恢复 AI 发言' })).toBeInTheDocument();
});
it('fails closed when the feature is unavailable and describes user-authorized AI operation', async () => {
  fetcher.mockResolvedValue(response({}, 404)); mount(); await screen.findByRole('alert'); expect(screen.getByRole('button', { name: '创建协作房间' })).toBeDisabled();
  const guide = aiInstructions('https://example.test/#/collab/example'); expect(guide).toContain('监听时长以我的授权为准'); expect(guide).not.toContain('最多 3 次回复'); expect(guide).toContain('不具备双向联网能力');
  expect(guide).toContain('wait 长轮询'); expect(guide).toContain('ack'); expect(guide).toContain('仅被点名不算授权'); expect(guide).toContain('房主暂停 AI 发言时只读不发');
  await expect(collaboration({ op: 'read' })).rejects.toThrow();
});
