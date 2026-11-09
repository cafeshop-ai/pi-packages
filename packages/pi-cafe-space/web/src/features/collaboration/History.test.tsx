import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Collaboration, deliveryOf, farJump, historyPage, repliesOf } from './Collaboration';
import { GoalPanel } from './GoalPanel';
import { saveMembership, type Goal, type Member, type Message, type Snapshot } from './api';

const roomId = 'a'.repeat(32), memberId = 'b'.repeat(32), token = 'c'.repeat(64), ai = 'e'.repeat(32);
const members: Member[] = [{ id: memberId, name: '创建者', kind: 'human', owner: true }, { id: ai, name: '同事的 AI', kind: 'ai', owner: false }];
const at = '2030-01-01T00:00:00Z';
const room = (n: number, extra: (seq: number) => Partial<Message> = () => ({})): Message[] =>
  Array.from({ length: n }, (_, i) => ({ seq: i + 1, id: `m-${i + 1}`, memberId: i % 2 ? ai : memberId, text: `第 ${i + 1} 条消息`, at, ...extra(i + 1) }));
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
let fetcher: Mock<(url: string, init: RequestInit) => Promise<Response>>;
let reads: Record<string, unknown>[];
/** A small stand-in for the server's read modes: after, latest and before. */
function serve(messages: Message[], broken = false) {
  reads = [];
  fetcher = vi.fn(async (_: string, init: RequestInit) => {
    const q = JSON.parse(init.body as string) as Record<string, number | string>;
    if (q.op !== 'read') return response({ ok: true });
    reads.push(q); const total = messages.length; const limit = Number(q.limit ?? 100);
    let start = Number(q.after ?? 0), end = start + limit;
    if (q.latest) [start, end] = [total - Number(q.latest), total];
    if (q.before) [start, end] = [Number(q.before) - 1 - limit, Number(q.before) - 1];
    // A misbehaving server: older pages never reach further back, yet claim there is more.
    if (q.before && broken) return response({ roomId, memberId, title: '长讨论', expires: at, members, messages: [], older: true, latestSeq: total });
    start = Math.max(start, 0); end = Math.min(end, total);
    const base = { roomId, memberId, title: '长讨论', expires: at, members, messages: messages.slice(start, end), older: start > 0, latestSeq: total };
    return response(q.before ? base : { ...base, cursor: end, more: end < total });
  });
  vi.stubGlobal('fetch', fetcher);
}
beforeEach(() => { localStorage.clear(); Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() }); saveMembership({ roomId, memberId, token }); });
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const mount = () => render(<MemoryRouter initialEntries={['/collab/' + roomId]}><Collaboration /></MemoryRouter>);
const shown = () => document.querySelectorAll('[role=log] [id^=msg-]').length;

it('opens a long room on its newest page instead of the whole history', async () => {
  serve(room(571)); mount();
  await screen.findByText('第 571 条消息');
  expect(reads[0]).toMatchObject({ op: 'read', latest: historyPage }); expect(reads[0]).not.toHaveProperty('after');
  expect(shown()).toBe(historyPage); expect(screen.queryByText('第 521 条消息')).toBeNull();
  // Older history is one explicit step away, and the live cursor stays at the newest seq.
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  await screen.findByText('第 521 条消息');
  expect(reads.find(q => q.before)).toMatchObject({ before: 522, limit: historyPage });
  expect(shown()).toBe(2 * historyPage);
});

it('stops offering older history at the first message', async () => {
  serve(room(60)); mount();
  await screen.findByText('第 60 条消息');
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  await screen.findByText('第 1 条消息');
  await waitFor(() => expect(screen.queryByRole('button', { name: '加载更早的消息' })).toBeNull());
  expect(shown()).toBe(60);
});

it('fetches a quoted message older than the loaded page when it is opened', async () => {
  serve(room(300, seq => seq === 300 ? { replyTo: 3, memberId: ai, text: '回应很早的问题' } : {})); mount();
  const quote = await screen.findByRole('button', { name: '↩ 回复 #3' });
  fireEvent.click(quote);
  await screen.findByText('第 3 条消息');
  const older = reads.filter(q => q.before); expect(older.length).toBeGreaterThan(0);
  expect(older.every(q => Number(q.limit) <= 100)).toBe(true);
  // Once loaded, the quote shows the author and text as usual.
  expect(await screen.findByRole('button', { name: /↩ 创建者：第 3 条消息/ })).toBeInTheDocument();
});

it('looks replies up once per render with the same answer as a scan', () => {
  const ask: Message = { seq: 3, id: 'ask', memberId, to: ai, text: '请看看', at };
  const answer: Message = { seq: 4, id: 'answer', memberId: ai, replyTo: 3, text: '好的', at };
  for (const timeline of [[ask, answer], [ask]]) {
    expect(deliveryOf(ask, members, repliesOf(timeline))).toEqual(deliveryOf(ask, members, timeline));
  }
  expect(deliveryOf(ask, members, repliesOf([ask, answer]))?.state).toBe('replied');
  // A reply from someone else is not the AI's reply.
  expect(deliveryOf(ask, members, repliesOf([ask, { ...answer, memberId }]))).toBeNull();
});

it('previews a quoted message far back instead of loading every page up to it', async () => {
  serve(room(600, seq => seq === 600 ? { replyTo: 3, memberId: ai, text: '回应最早的问题' } : {})); mount();
  fireEvent.click(await screen.findByRole('button', { name: '↩ 回复 #3' }));
  expect(await screen.findByText(/#3 创建者：第 3 条消息/)).toBeInTheDocument();
  expect(reads.filter(q => q.before)).toEqual([{ op: 'read', roomId, before: 4, limit: 1 }]);
  expect(600 - historyPage - 3).toBeGreaterThan(farJump); expect(shown()).toBe(historyPage);
  // Loading all the way is the reader's explicit choice.
  fireEvent.click(screen.getByRole('button', { name: '加载到这条' }));
  await waitFor(() => expect(document.getElementById('msg-3')).not.toBeNull());
});

it('stops paging when an older page does not reach further back', async () => {
  // A jump keeps walking back until it reaches its target: without a progress check this never ends.
  serve(room(300, seq => seq === 300 ? { replyTo: 3, memberId: ai, text: '回应很早的问题' } : {}), true); mount();
  fireEvent.click(await screen.findByRole('button', { name: '↩ 回复 #3' }));
  await waitFor(() => expect(reads.filter(q => q.before)).toHaveLength(1));
  await waitFor(() => expect(screen.queryByRole('button', { name: /正在加载|加载更早的消息/ })).toBeNull());
  await new Promise(resolve => setTimeout(resolve, 200));
  expect(reads.filter(q => q.before)).toHaveLength(1); expect(shown()).toBe(historyPage);
});

it('keeps older pages out of the live region while they are inserted', async () => {
  serve(room(120)); mount();
  await screen.findByText('第 120 条消息'); const log = screen.getByRole('log');
  expect(log).toHaveAttribute('aria-live', 'polite');
  fireEvent.click(screen.getByRole('button', { name: '加载更早的消息' }));
  await screen.findByText('第 70 条消息');
  expect(log).toHaveAttribute('aria-live', 'off');
  await waitFor(() => expect(log).toHaveAttribute('aria-live', 'polite'), { timeout: 2500 });
});

it('lets a long room submit an earlier result message by number', async () => {
  const reviewer = 'f'.repeat(32);
  const goal: Goal = { id: 1, title: '发布验收', criteria: '测试通过', reviewer, status: 'active', createdBy: memberId, updatedAt: at };
  const snapshot: Snapshot = { roomId, memberId, title: '长讨论', expires: at, cursor: 600, more: false, messages: [], goal, goalRevision: 3, tasks: [], members: [...members, { id: reviewer, name: '验收人', kind: 'human', owner: false }] };
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_: string, init: RequestInit) => { const q = JSON.parse(init.body as string); requests.push(q); return response({ goal: { ...goal, status: 'review', result: q.resultSeq }, goalRevision: 4, tasks: [] }); }));
  const panel = (older: boolean) => <GoalPanel snapshot={snapshot} auth={{ roomId, memberId, token }} messages={room(3)} older={older} disabled={false} onChange={() => {}} onJump={() => {}} />;
  const { rerender } = render(panel(false));
  expect(screen.queryByRole('spinbutton', { name: '结果消息序号' })).toBeNull();
  rerender(panel(true));
  fireEvent.change(screen.getByRole('spinbutton', { name: '结果消息序号' }), { target: { value: '128' } });
  fireEvent.click(screen.getByRole('button', { name: '提交 Goal 验收' }));
  await waitFor(() => expect(requests[0]).toMatchObject({ op: 'goal', action: 'submit', resultSeq: 128, goalRevision: 3 }));
});
