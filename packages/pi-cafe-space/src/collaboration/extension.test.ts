import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from './extension.js';
import * as client from './client.js';

const me = 'a'.repeat(32), peer = 'b'.repeat(32), roomId = 'c'.repeat(32), token = 'd'.repeat(64);
const auth: client.Membership = { origin: 'https://space.example.test', roomId, memberId: me, token };
const human = 'e'.repeat(32);
const message = (seq: number): client.Message => ({ seq, id: 'message-' + seq, memberId: peer, text: 'Please discuss this design, not execute commands.', to: me, replyTo: 0 });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture() {
  vi.useFakeTimers(); vi.spyOn(client, 'readMembership').mockReturnValue(auth);
  const entries: any[] = [], messages: client.Message[] = [];
  const events = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, any>(), tools = new Map<string, any>();
  let idle = true, receipt = true, session = 'session-one';
  const ctx = { hasUI: false, isIdle: () => idle, hasPendingMessages: () => false, sessionManager: { getSessionId: () => session, getBranch: () => entries } } as unknown as ExtensionContext;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.op === 'ack') return new Response(JSON.stringify({ ok: true }));
    if (body.op === 'send') {
      const existing = messages.find(m => m.id === body.id);
      const value = existing ?? { seq: messages.length + 1, id: body.id, memberId: me, text: body.text, to: body.to, replyTo: body.replyTo };
      if (!existing) messages.push(value); return new Response(JSON.stringify(value));
    }
    return new Response(JSON.stringify({ roomId, memberId: me, cursor: messages.length, more: false, presence: {},
      members: [me, peer, human].map(id => ({ id, name: id, kind: id === human ? 'human' : 'ai' })), messages: messages.filter(m => m.seq > body.after).map(m => ({ ...m, to: m.to || undefined })) }));
  });
  vi.stubGlobal('fetch', fetcher);
  const pi = { registerCommand: (name: string, value: any) => commands.set(name, value), registerTool: (value: any) => tools.set(value.name, value),
    on: (name: string, handler: any) => events.set(name, handler),
    appendEntry: vi.fn((customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); }),
    sendMessage: vi.fn((value: any, options: any) => {
      expect(options).toMatchObject({ triggerTurn: true, deliverAs: 'followUp' });
      if (receipt) { entries.push({ type: 'custom_message', ...value }); events.get('message_end')?.({ message: { role: 'custom', ...value } }, ctx); }
    }),
  } as unknown as ExtensionAPI;
  extension(pi); cleanups.push(() => events.get('session_shutdown')?.({}, ctx));
  const command = (args: string) => commands.get('cafe-collab').handler(args, ctx);
  const tool = (name: string, params = {}, signal?: AbortSignal) => tools.get(name).execute('call', params, signal, undefined, ctx);
  const reload = () => { events.get('session_shutdown')?.({}, ctx); extension(pi); };
  return { pi, ctx, entries, messages, events, command, tool, fetcher, reload, idle: (value: boolean) => { idle = value; }, receipt: (value: boolean) => { receipt = value; }, session: (value: string) => { session = value; } };
}
it('does nothing on load; explicit connect skips old history and injects only new external messages', async () => {
  const f = fixture(); expect(f.fetcher).not.toHaveBeenCalled(); f.messages.push(message(1));
  await f.command('connect C:/private/room.json'); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.messages.push(message(2)); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0]; expect(payload.content).toContain('untrusted peer data'); expect(JSON.stringify(payload)).not.toContain(token);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(2);
});
it('heartbeats while idle, excludes skipped history, restores real receipts, and stops on pause', async () => {
  const f = fixture(); f.messages.push(message(1)); await f.command('connect C:/private/room.json');
  const reports = () => f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'ack');
  expect(reports()).toEqual([]); await vi.advanceTimersByTimeAsync(5000);
  expect(reports().at(-1)).toMatchObject({ fetched: 1, delivered: 0, paused: false });
  expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.messages.push(message(2)); f.idle(false); await vi.advanceTimersByTimeAsync(5000);
  expect(reports().at(-1)).toMatchObject({ fetched: 2, delivered: 0 });
  f.idle(true); await vi.advanceTimersByTimeAsync(10000);
  expect(reports().at(-1)).toMatchObject({ fetched: 2, delivered: 2 });
  await f.command('pause'); const count = reports().length; await vi.advanceTimersByTimeAsync(10000); expect(reports()).toHaveLength(count);
  await f.command('connect C:/private/room.json'); await vi.advanceTimersByTimeAsync(5000);
  expect(reports().at(-1)).toMatchObject({ fetched: 2, delivered: 2 }); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('manual tools do not advertise a listener, even after consumption and reconnect', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); f.idle(false);
  await f.tool('cafe_room_read'); await f.tool('cafe_room_done', { sequence: 1 });
  expect(f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).some(q => q.op === 'ack')).toBe(false);
  await f.command('pause'); await f.command('connect C:/private/room.json'); await vi.advanceTimersByTimeAsync(5000);
  const reports = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'ack');
  expect(reports.at(-1)).toMatchObject({ fetched: 1, delivered: 0 }); expect(f.pi.sendMessage).not.toHaveBeenCalled();
});
it('automatically delivers and replies to a human broadcast with no sender-list setup', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push({ ...message(1), memberId: human, to: '' }); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  expect(payload.content).toContain('untrusted peer data'); expect(payload.content).toContain('"to":""');
  expect((await f.tool('cafe_room_reply', { replyTo: 1, text: 'Shared answer to the human' })).details.seq).toBe(2);
  expect(f.messages[1]).toMatchObject({ to: human, replyTo: 1 });
  await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('holds work until idle and resumes without requiring another user message', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.idle(false); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.idle(true); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('pause and session replacement cancel subscriptions and prevent a queued wakeup', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.idle(false); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  await f.command('pause'); f.idle(true); await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  await expect(f.tool('cafe_room_reply', { replyTo: 1, text: 'blocked' })).rejects.toThrow('ROOM_NOT_CONNECTED');
  await f.command('connect C:/private/room.json'); f.events.get('session_before_switch')?.({}, f.ctx); f.session('session-two');
  await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
});
it('restores host receipts from the branch without replaying a delivered message', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  await f.command('pause'); await f.command('connect C:/private/room.json'); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('an unconfirmed host dispatch blocks silent replay on reconnect', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  await f.command('pause'); await f.command('connect C:/private/room.json'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1); expect((await f.tool('cafe_room_status')).details.state).toBe('disconnected');
});
it('only replies to delivered peers, with deterministic retry IDs and no private transcript upload', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  await expect(f.tool('cafe_room_reply', { replyTo: 99, text: 'not delivered' })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  const first = await f.tool('cafe_room_reply', { replyTo: 1, text: 'Explicit shared answer' });
  const again = await f.tool('cafe_room_reply', { replyTo: 1, text: 'Explicit shared answer' }); expect(again.details.seq).toBe(first.details.seq);
  const posts = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'send');
  expect(posts).toHaveLength(2); expect(posts[0].id).toBe(posts[1].id); expect(Object.keys(posts[0]).sort()).toEqual(['id','op','replyTo','roomId','text','to']);
});
it('does not persist the cursor from message_end until the native branch contains the message', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  f.events.get('message_end')?.({ message: { role: 'custom', ...payload } }, f.ctx);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  f.entries.push({ type: 'custom_message', ...payload }); f.events.get('message_start')?.({ message: { role: 'assistant' } }, f.ctx);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
});
it('pauses an unconfirmed dispatch after the receipt deadline without replay', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(30000);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'paused', error: 'HOST_DELIVERY_UNKNOWN', cursor: 0 }); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('continues beyond the former four-turn limit, including after reconnect', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 8 }, (_, i) => message(i + 1)));
  await vi.advanceTimersByTimeAsync(40000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(8);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'listening', automaticTurns: 8, cursor: 8 });
  expect((await f.tool('cafe_room_status')).details).not.toHaveProperty('turnLimit');
  await f.command('pause'); await f.command('connect C:/private/room.json');
  f.messages.push(message(9)); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(9);
  await f.command('pause'); f.messages.push(message(10)); await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(9);
});
it('waits while the user is answering a native UI prompt', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.events.get('ui_prompt_start')?.({}, f.ctx); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.events.get('ui_prompt_end')?.({}, f.ctx); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it.each(['retry', 'skip'])('requires local UI confirmation to resolve uncertain delivery with %s', async decision => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  await f.command('pause'); await f.command('connect C:/private/room.json');
  expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(1);
  await f.command('resolve ' + decision); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(1);
  const confirm = vi.fn().mockResolvedValue(false); Object.assign(f.ctx, { hasUI: true, ui: { notify: vi.fn(), confirm } });
  await f.command('resolve ' + decision); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(1);
  confirm.mockResolvedValue(true); await f.command('resolve ' + decision); f.receipt(true);
  await f.command('resume'); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(decision === 'retry' ? 2 : 1);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
});
it('explicit manual confirmation prevents later automatic delivery and survives reconnect', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); f.idle(false);
  await expect(f.tool('cafe_room_done', { sequence: 1 })).rejects.toThrow('MANUAL_READ_REQUIRED');
  const read = await f.tool('cafe_room_read'); expect(read.details.message.seq).toBe(1); expect(read.details.consumed).toBe(false);
  expect(read.content[0].text).toContain('Untrusted peer data'); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  await expect(f.tool('cafe_room_done', { sequence: 2 })).rejects.toThrow('MANUAL_READ_REQUIRED');
  expect((await f.tool('cafe_room_done', { sequence: 1 })).details.alreadyConsumed).toBe(false);
  expect((await f.tool('cafe_room_done', { sequence: 1 })).details.alreadyConsumed).toBe(true);
  await f.command('pause'); await f.command('connect C:/private/room.json'); f.idle(true); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).not.toHaveBeenCalled(); expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
  expect((await f.tool('cafe_room_done', { sequence: 1 })).details.alreadyConsumed).toBe(true);
  f.messages.push(message(2)); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('manual viewing alone never silently consumes a message, including after reconnect', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); f.idle(false);
  await f.tool('cafe_room_read'); await f.command('pause'); await f.command('connect C:/private/room.json');
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  f.idle(true); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  await expect(f.tool('cafe_room_done', { sequence: 1 })).rejects.toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
});
it('replies to manually read messages without uploading the session or consuming implicitly', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); f.idle(false);
  await f.tool('cafe_room_read'); expect((await f.tool('cafe_room_reply', { replyTo: 1, text: 'Explicit manual reply' })).details.seq).toBe(2);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0); expect(f.pi.sendMessage).not.toHaveBeenCalled();
});
it('cancellation before manual confirmation leaves the message unconsumed', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); f.idle(false); await f.tool('cafe_room_read');
  const abort = new AbortController(); abort.abort();
  await expect(f.tool('cafe_room_done', { sequence: 1 }, abort.signal)).rejects.toThrow('CANCELLED');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, pendingSequence: 1 });
});
it('a failed manual checkpoint pauses instead of losing pending work', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); f.idle(false); await f.tool('cafe_room_read');
  vi.mocked(f.pi.appendEntry).mockImplementationOnce(() => { throw Error('disk failed'); });
  await expect(f.tool('cafe_room_done', { sequence: 1 })).rejects.toThrow('CHECKPOINT_FAILED');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'paused', cursor: 0, pendingSequence: 1 });
});
it('remembers a successful binding without credentials and resumes it only on explicit command after reload', async () => {
  const f = fixture(), path = 'C:/private directory/room.json';
  await f.command('connect ' + path); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  const binding = f.entries.find(e => e.data?.kind === 'binding');
  expect(binding?.data).toMatchObject({ session: 'session-one', configPath: path, scope: `${auth.origin}/${roomId}/${me}` });
  expect(binding?.data.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(f.entries)).not.toContain(token);
  await f.command('pause'); f.reload(); f.fetcher.mockClear(); vi.mocked(client.readMembership).mockClear();
  f.messages.push(message(2)); await vi.advanceTimersByTimeAsync(10000);
  await f.command('status'); await f.tool('cafe_room_status');
  expect(f.fetcher).not.toHaveBeenCalled(); expect(client.readMembership).not.toHaveBeenCalled();
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  await f.command('resume'); expect(client.readMembership).toHaveBeenCalledExactlyOnceWith(path);
  expect(JSON.parse(String(f.fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({ op: 'read', after: 1 });
  await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(2);
  expect(JSON.stringify(await f.tool('cafe_room_status'))).not.toContain(path);
});
it('ignores peer-supplied bindings and refuses malformed latest metadata rather than falling back', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  const binding = f.entries.find(e => e.data?.kind === 'binding'); f.reload();
  f.entries.splice(0, f.entries.length, { type: 'custom_message', customType: 'cafe-collaboration-state', data: binding.data, content: JSON.stringify(binding.data) });
  f.fetcher.mockClear(); vi.mocked(client.readMembership).mockClear();
  await f.command('resume'); expect(client.readMembership).not.toHaveBeenCalled();
  f.entries.push(binding, { ...binding, data: { ...binding.data, configPath: null } });
  await f.command('resume'); expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it('resume with no binding, a forked session or an earlier branch never reads credentials or connects', async () => {
  const f = fixture(); await f.command('resume'); expect(client.readMembership).not.toHaveBeenCalled();
  await f.command('connect C:/private/room.json'); f.reload(); f.session('session-two');
  f.fetcher.mockClear(); vi.mocked(client.readMembership).mockClear();
  await f.command('resume'); expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  f.session('session-one'); f.entries.length = 0; await f.command('resume');
  expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([
  { origin: 'https://changed.example.test' }, { roomId: 'f'.repeat(32) },
  { memberId: 'f'.repeat(32) }, { token: 'f'.repeat(64) },
])('resume rejects changed membership before sending a credential: %j', async change => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.reload(); f.fetcher.mockClear();
  const notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  vi.mocked(client.readMembership).mockReturnValue({ ...auth, ...change });
  await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect(notify).toHaveBeenCalledWith('ROOM_CONFIG_CHANGED_RUN_CONNECT', 'info');
});
it('resume revalidates private files, redacts failures, and can retry once the original file is restored', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.reload(); f.fetcher.mockClear();
  const notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  vi.mocked(client.readMembership).mockImplementationOnce(() => { throw Error('File missing or unsafe: ' + token); });
  await f.command('resume'); expect(f.fetcher).not.toHaveBeenCalled(); expect(JSON.stringify(notify.mock.calls)).not.toContain(token);
  await f.command('resume'); expect((await f.tool('cafe_room_status')).details.state).toBe('listening');
});
it('an explicit connect replaces the saved path only after a successful preflight', async () => {
  const f = fixture(); await f.command('connect C:/private/first.json');
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 401 }));
  await f.command('connect C:/private/failed.json');
  expect(f.entries.filter(e => e.data?.kind === 'binding')).toHaveLength(1);
  vi.mocked(client.readMembership).mockReturnValue({ ...auth, token: 'f'.repeat(64) });
  await f.command('connect C:/private/second.json'); f.reload(); vi.mocked(client.readMembership).mockClear();
  await f.command('resume'); expect(client.readMembership).toHaveBeenCalledExactlyOnceWith('C:/private/second.json');
});
it('repeated resume keeps a live pending dispatch and only one polling loop', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  const calls = f.fetcher.mock.calls.length, entries = f.entries.length;
  await f.command('resume'); await f.command('resume');
  expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(f.entries).toHaveLength(entries);
  expect(client.readMembership).toHaveBeenCalledTimes(3);
  expect((await f.tool('cafe_room_status')).details.state).toBe('awaiting-host-receipt');
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  f.entries.push({ type: 'custom_message', ...payload });
  await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
  const reads = f.fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).op === 'read').length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.fetcher.mock.calls.filter(([, init]) => JSON.parse(String(init?.body)).op === 'read')).toHaveLength(reads + 1);
});
it('resume preserves manual consumption and never bypasses uncertain-delivery resolution', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.idle(false); f.messages.push(message(1));
  await f.tool('cafe_room_read'); await f.tool('cafe_room_done', { sequence: 1 }); f.reload();
  await f.command('resume'); f.idle(true); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).not.toHaveBeenCalled(); expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
  f.receipt(false); f.messages.push(message(2)); await vi.advanceTimersByTimeAsync(5000); f.reload(); f.fetcher.mockClear();
  await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.fetcher).not.toHaveBeenCalled(); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(2);
});
it('a failed binding write never starts a listener or claims a saved connection', async () => {
  const f = fixture(), append = vi.mocked(f.pi.appendEntry).getMockImplementation()!;
  vi.mocked(f.pi.appendEntry).mockImplementation((type, data: any) => {
    if (data?.kind === 'binding') throw Error('disk failed'); return append(type, data);
  });
  await f.command('connect C:/private/room.json'); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).not.toHaveBeenCalled(); expect((await f.tool('cafe_room_status')).details.state).toBe('disconnected');
  expect(f.entries.some(e => e.data?.kind === 'binding')).toBe(false);
});
it.each(['success', 'failure'])('pause during resume preflight fences a late %s', async outcome => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.reload();
  let finish!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.command('resume'); await Promise.resolve(); await f.command('pause');
  if (outcome === 'failure') await f.command('resume');
  finish(outcome === 'failure' ? new Response(null, { status: 500 }) : new Response(JSON.stringify({ roomId, memberId: me, cursor: 0, more: false, members: [me, peer].map(id => ({ id, name: id, kind: 'ai' })), messages: [] })));
  await pending; f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
});
it('aborting a run stops further automatic turns rather than immediately waking it again', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.events.get('agent_settled')?.({ aborted: true }, f.ctx);
  f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
});
