import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Collaboration, deliveryOf, historyPage, repliesOf } from './Collaboration';
import { saveMembership, type Member, type Message } from './api';

const roomId = 'a'.repeat(32), memberId = 'b'.repeat(32), token = 'c'.repeat(64), ai = 'e'.repeat(32);
const members: Member[] = [{ id: memberId, name: '创建者', kind: 'human', owner: true }, { id: ai, name: '同事的 AI', kind: 'ai', owner: false }];
const at = '2030-01-01T00:00:00Z';
const room = (n: number, extra: (seq: number) => Partial<Message> = () => ({})): Message[] =>
  Array.from({ length: n }, (_, i) => ({ seq: i + 1, id: `m-${i + 1}`, memberId: i % 2 ? ai : memberId, text: `第 ${i + 1} 条消息`, at, ...extra(i + 1) }));
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
let fetcher: Mock<(url: string, init: RequestInit) => Promise<Response>>;
let reads: Record<string, unknown>[];
/** A small stand-in for the server's read modes: after, latest and before. */
function serve(messages: Message[]) {
  reads = [];
  fetcher = vi.fn(async (_: string, init: RequestInit) => {
    const q = JSON.parse(init.body as string) as Record<string, number | string>;
    if (q.op !== 'read') return response({ ok: true });
    reads.push(q); const total = messages.length; const limit = Number(q.limit ?? 100);
    let start = Number(q.after ?? 0), end = start + limit;
    if (q.latest) [start, end] = [total - Number(q.latest), total];
    if (q.before) [start, end] = [Number(q.before) - 1 - limit, Number(q.before) - 1];
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
