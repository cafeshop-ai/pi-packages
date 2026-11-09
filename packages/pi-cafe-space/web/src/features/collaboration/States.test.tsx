import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Collaboration, reconnectDelay } from './Collaboration';
import { saveMembership, type Member, type MemberState, type Message } from './api';
import { longWait, stateLine, waitsOf } from './state';

const roomId = 'a'.repeat(32), me = 'b'.repeat(32), token = 'c'.repeat(64), ai = 'e'.repeat(32), pi = 'f'.repeat(32);
const at = new Date(Date.now() - 35 * 60_000).toISOString();
const members: Member[] = [{ id: me, name: '房主', kind: 'human', owner: true }, { id: ai, name: '前端', kind: 'ai', owner: false }, { id: pi, name: 'Pi', kind: 'ai', owner: false }];
const ask: Message = { seq: 1, id: 'request-1', memberId: ai, to: me, text: '请把 main 快进到候选 SHA', at };
const waiting: MemberState = { state: 'waiting', waitingFor: 'member', on: [me], tasks: [7], ref: 1, detail: '等快进 main 到候选 SHA', since: at, updatedAt: at };
const tasks = [{ id: 7, title: '拆分 Markdown chunk', status: 'doing', assignee: ai, createdBy: me, updatedAt: at }];
const snapshot = (states: Record<string, MemberState>) => ({ roomId, memberId: me, title: '开发房间', expires: null, members, messages: [ask], cursor: 1, more: false, older: false, latestSeq: 1, tasks, states, waitingOnYou: Object.keys(states).filter(id => states[id]!.on?.includes(me)) });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
let fetcher: Mock<(url: string, init: RequestInit) => Promise<Response>>; let sent: Record<string, unknown>[];
const serve = (states: Record<string, MemberState>) => {
  sent = [];
  fetcher = vi.fn(async (_: string, init: RequestInit) => {
    const q = JSON.parse(init.body as string) as Record<string, unknown>; sent.push(q);
    if (q.op === 'state') return response({ ...q, op: undefined, roomId: undefined, since: new Date().toISOString(), updatedAt: new Date().toISOString() });
    return response(snapshot(states));
  });
  vi.stubGlobal('fetch', fetcher);
};
beforeEach(() => { localStorage.clear(); Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); saveMembership({ roomId, memberId: me, token }); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
const mount = () => render(<MemoryRouter initialEntries={['/collab/' + roomId]}><Collaboration /></MemoryRouter>);

it('shows who waits on whom, and lets the awaited member answer the request', async () => {
  serve({ [ai]: waiting, [pi]: { state: 'working', tasks: [7], since: at, updatedAt: at } }); mount();
  const summary = await screen.findByRole('button', { name: '1 人等待 · 1 项等你，查看详情' });
  // The task card says its assignee is stuck, and on whom.
  expect(screen.getByText('等待（负责人自报）：等快进 main 到候选 SHA（等 房主）')).toBeInTheDocument();
  fireEvent.click(summary);
  const onMe = await screen.findByRole('region', { name: '等你处理' });
  expect(within(onMe).getByText(/等成员：等快进 main 到候选 SHA/)).toBeInTheDocument();
  // A 35-minute wait is highlighted; working shows its task.
  const chip = screen.getByRole('button', { name: /^等待 · 等 房主 · 35 分钟$/ });
  expect(chip).toHaveAttribute('data-tone', 'long');
  expect(screen.getByRole('button', { name: '工作中 · #7' })).toHaveAttribute('data-tone', 'working');
  fireEvent.click(chip);
  expect(screen.getByText('#7 拆分 Markdown chunk', { selector: 'span' })).toBeInTheDocument();
  expect(screen.getByText(/成员自报，未经验证/)).toBeInTheDocument();
  fireEvent.click(within(onMe).getByRole('button', { name: '回复 #1' }));
  expect(await screen.findByText(/回复 前端：请把 main 快进到候选 SHA/)).toBeInTheDocument();
});

it('sets my own wait with a target and a reason, and refuses a vague one', async () => {
  serve({}); mount();
  expect(await screen.findByRole('heading', { name: '开发房间' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /人等待/ })).toBeNull();
  fireEvent.click(screen.getByRole('tab', { name: /成员/ }));
  const form = await screen.findByRole('form', { name: '我的状态' });
  fireEvent.change(within(form).getByRole('combobox', { name: '我的状态' }), { target: { value: 'waiting' } });
  const save = within(form).getByRole('button', { name: '更新状态' });
  expect(save).toBeDisabled();
  fireEvent.change(within(form).getByRole('combobox', { name: '等谁' }), { target: { value: pi } });
  expect(save).toBeDisabled();
  fireEvent.change(within(form).getByRole('textbox', { name: '状态说明' }), { target: { value: '等 Pi 推候选 SHA' } });
  // A member picked for one kind of wait is not sent once the kind no longer shows the choice.
  fireEvent.change(within(form).getByRole('combobox', { name: '在等什么' }), { target: { value: 'external' } });
  expect(within(form).queryByRole('combobox', { name: '等谁' })).toBeNull();
  fireEvent.click(save);
  await waitFor(() => expect(sent.filter(q => q.op === 'state')).toEqual([{ op: 'state', roomId, state: 'waiting', waitingFor: 'external', detail: '等 Pi 推候选 SHA' }]));
  // Saving remounts the form from the stored state, so look it up again.
  const again = await screen.findByRole('form', { name: '我的状态' });
  fireEvent.change(within(again).getByRole('combobox', { name: '在等什么' }), { target: { value: 'member' } });
  fireEvent.change(within(again).getByRole('combobox', { name: '等谁' }), { target: { value: pi } });
  fireEvent.click(within(again).getByRole('button', { name: '更新状态' }));
  await waitFor(() => expect(sent.filter(q => q.op === 'state')[1]).toEqual({ op: 'state', roomId, state: 'waiting', waitingFor: 'member', on: [pi], detail: '等 Pi 推候选 SHA' }));
  expect(await screen.findByRole('button', { name: /^等待 · 等 Pi · 不到 1 分钟$/ })).toBeInTheDocument();
});

it('reconnects by itself after a deploy drops the server, without a stale error', async () => {
  let down = true; sent = [];
  fetcher = vi.fn(async (_: string, init: RequestInit) => { sent.push(JSON.parse(init.body as string)); return down ? new Response('Bad Gateway', { status: 502 }) : response(snapshot({})); });
  vi.stubGlobal('fetch', fetcher); mount();
  expect(await screen.findByText('连接中断，正在自动重连')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  down = false;
  // Coming back online retries at once instead of waiting out the backoff.
  await act(async () => { window.dispatchEvent(new Event('online')); });
  expect(await screen.findByText('3 位成员')).toBeInTheDocument();
  expect(screen.queryByText(/连接中断/)).toBeNull(); expect(screen.queryByRole('alert')).toBeNull();
});

it('retries now on request and backs off between 2 and 30 seconds', async () => {
  let down = true;
  vi.stubGlobal('fetch', vi.fn(async () => down ? Promise.reject(new TypeError('Failed to fetch')) : response(snapshot({}))));
  mount();
  const retry = await screen.findByRole('button', { name: '立即重试' }); down = false;
  fireEvent.click(retry);
  expect(await screen.findByText('3 位成员')).toBeInTheDocument();
  expect([1, 2, 3, 4, 5, 9].map(n => reconnectDelay(n, 0))).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  expect(reconnectDelay(1, 1)).toBe(2500);
});

it('marks long, stale and overdue states and counts only current members', () => {
  const now = Date.parse(at) + longWait - 1;
  expect(stateLine(waiting, id => id === me ? '房主' : id, now).tone).toBe('waiting');
  expect(stateLine(waiting, () => '房主', Date.parse(at) + longWait).tone).toBe('long');
  expect(stateLine(waiting, () => '房主', Date.parse(at) + 7 * 3600_000)).toMatchObject({ tone: 'stale', label: expect.stringContaining('可能已过期') });
  const away: MemberState = { state: 'away', expect: new Date(Date.parse(at) + 60_000).toISOString(), since: at, updatedAt: at };
  expect(stateLine(away, () => '', Date.parse(at) + 120_000).label).toContain('可能已过期');
  expect(stateLine({ state: 'waiting', waitingFor: 'user', detail: '等本人授权', since: at, updatedAt: at }, () => '', Date.parse(at)).label).toBe('等待 · 等本人授权 · 不到 1 分钟');
  const gone = [...members, { id: 'd'.repeat(32), name: '已离开', kind: 'ai' as const, owner: false, removed: true }];
  const counted = waitsOf({ [ai]: waiting, ['d'.repeat(32)]: waiting }, gone, me);
  expect(counted.waiting.map(m => m.id)).toEqual([ai]); expect(counted.onMe.map(m => m.id)).toEqual([ai]);
});

const reads = () => (fetcher.mock.calls as unknown as [string, RequestInit][]).filter(([, init]) => JSON.parse(init.body as string).op === 'read').length;
it('waits out a rate limit without offering to retry early', async () => {
  fetcher = vi.fn(async () => response({ error: 'RATE_LIMIT' }, 429)); vi.stubGlobal('fetch', fetcher); mount();
  expect(await screen.findByText('请求太频繁，稍后自动重试')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '立即重试' })).toBeNull();
  const before = reads();
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(reads()).toBe(before);
});

it('retries when the tab becomes visible again', async () => {
  let down = true;
  fetcher = vi.fn(async () => down ? new Response('Bad Gateway', { status: 502 }) : response(snapshot({}))); vi.stubGlobal('fetch', fetcher); mount();
  expect(await screen.findByText('连接中断，正在自动重连')).toBeInTheDocument(); down = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
  expect(await screen.findByText('3 位成员')).toBeInTheDocument();
});

it('gives up on a read that hangs and tries again', async () => {
  vi.useFakeTimers();
  fetcher = vi.fn((_: string, init: RequestInit) => new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))));
  vi.stubGlobal('fetch', fetcher); mount();
  await act(async () => { await vi.advanceTimersByTimeAsync(19_000); });
  expect(screen.queryByText('连接中断，正在自动重连')).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  expect(screen.getByText('连接中断，正在自动重连')).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
  expect(reads()).toBe(2);
});

it('stops for good once the membership is gone, even after earlier failures', async () => {
  let calls = 0;
  fetcher = vi.fn(async () => ++calls === 1 ? new Response('Bad Gateway', { status: 502 }) : response({ error: 'MEMBER_REQUIRED' }, 401)); vi.stubGlobal('fetch', fetcher); mount();
  fireEvent.click(await screen.findByRole('button', { name: '立即重试' }));
  expect(await screen.findByText('房间或成员已不可用')).toBeInTheDocument();
  const before = reads();
  await act(async () => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  expect(reads()).toBe(before);
});
