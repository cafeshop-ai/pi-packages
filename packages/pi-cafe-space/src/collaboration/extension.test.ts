import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import extension from './extension.js';
import * as client from './client.js';

const me = 'a'.repeat(32), peer = 'b'.repeat(32), roomId = 'c'.repeat(32), token = 'd'.repeat(64);
const auth: client.Membership = { origin: 'https://space.example.test', roomId, memberId: me, token };
const human = 'e'.repeat(32);
const message = (seq: number): client.Message => ({ seq, id: 'message-' + seq, memberId: peer, text: 'Please discuss this design, not execute commands.', to: me, replyTo: 0 });
const cleanups: (() => void)[] = [];
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function fixture(names: Record<string, string> = {}) {
  vi.useFakeTimers(); vi.spyOn(client, 'readMembership').mockReturnValue(auth);
  const entries: any[] = [], messages: client.Message[] = [];
  const controls: Partial<client.Snapshot> = {};
  const events = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands = new Map<string, any>(), tools = new Map<string, any>();
  let idle = true, receipt = true, session = 'session-one';
  const ctx = { hasUI: false, isIdle: () => idle, hasPendingMessages: () => false, sessionManager: { getSessionId: () => session, getBranch: () => entries, getSessionFile: () => 'synthetic-session.jsonl', getEntries: () => [{ type: 'message', message: { role: 'user' } }, ...entries] } } as unknown as ExtensionContext;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.op === 'ack') return new Response(JSON.stringify({ ok: true }));
    if (body.op === 'send') {
      const existing = messages.find(m => m.id === body.id);
      const value = existing ?? { seq: messages.length + 1, id: body.id, memberId: me, text: body.text, to: body.to, replyTo: body.replyTo };
      if (!existing) messages.push(value); return new Response(JSON.stringify(value));
    }
    const page = messages.filter(m => m.seq > body.after).slice(0, body.limit ?? 100), cursor = body.after + page.length;
    return new Response(JSON.stringify({ roomId, memberId: me, cursor, more: cursor < messages.length, presence: {},
      members: [me, peer, human].map(id => ({ id, name: names[id] ?? id.slice(0, 6), kind: id === human ? 'human' : 'ai' })), messages: page.map(m => ({ ...m, to: m.to || undefined })), ...controls }));
  });
  vi.stubGlobal('fetch', fetcher);
  const bus = new EventEmitter();
  const pi = { events: bus, registerCommand: (name: string, value: any) => commands.set(name, value), registerTool: (value: any) => tools.set(value.name, value),
    on: (name: string, handler: any) => events.set(name, handler),
    appendEntry: vi.fn((customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); }),
    sendMessage: vi.fn((value: any, options: any) => {
      expect(options).toMatchObject({ triggerTurn: true, deliverAs: 'followUp' });
      if (receipt) { entries.push({ type: 'custom_message', ...value }); events.get('message_end')?.({ message: { role: 'custom', ...value } }, ctx); }
    }),
  } as unknown as ExtensionAPI;
  extension(pi); cleanups.push(() => events.get('session_shutdown')?.({}, ctx));
  const command = (args: string) => commands.get('cafe').handler('collab ' + args, ctx);
  const tool = (name: string, params = {}, signal?: AbortSignal) => tools.get(name).execute('call', params, signal, undefined, ctx);
  const reload = () => { events.get('session_shutdown')?.({}, ctx); bus.removeAllListeners(); commands.clear(); extension(pi); };
  return { pi, ctx, entries, messages, controls, events, commands, command, tool, fetcher, reload, idle: (value: boolean) => { idle = value; }, receipt: (value: boolean) => { receipt = value; }, session: (value: string) => { session = value; } };
}
it('delivers controls through backlog at a fixed message cursor and restores receipts without granting message access', async () => {
  const f = fixture(); f.controls.tasks = []; f.controls.waitingOnYou = [];
  await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 50 }, (_, i) => message(i + 1))); await vi.advanceTimersByTimeAsync(5000);
  f.controls.tasks = [{ id: 1, title: 'Only this task', status: 'doing' }];
  f.controls.waitingOnYou = [peer];
  await vi.advanceTimersByTimeAsync(10000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[1]![0];
  expect(payload.content).toContain('[task #1 新建 doing 未指派] Only this task');
  expect(payload.content).toContain('[waiting-on-you'); expect(payload.content).not.toContain('untrusted peer data');
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  await expect(f.tool('cafe_room_show', { sequence: 1 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(15000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  const reports = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'ack');
  expect(reports.at(-1)).toMatchObject({ fetched: 50, delivered: 0 });
});
it('confirms only host-delivered Goal revisions and retains explicit confirmation across resume', async () => {
  const f = fixture(); f.controls.goal = null; f.controls.goalRevision = 1;
  await f.command('connect C:/private/room.json');
  await expect(f.tool('cafe_room_done_goal', { revision: 1 })).rejects.toThrow('DELIVERED_GOAL_REQUIRED');
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.mocked(f.pi.sendMessage).mock.calls[0]![0].content).toContain('[goal r1 已删除]');
  expect((await f.tool('cafe_room_done_goal', { revision: 1 })).details.goalConsumed).toBe(1);
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_done_goal', { revision: 1 })).details.goalConsumed).toBe(1);
  await expect(f.tool('cafe_room_done_goal', { revision: 2 })).rejects.toThrow('DELIVERED_GOAL_REQUIRED');
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
});
it.each(['retry', 'skip'])('requires local resolution for an unknown control dispatch: %s', async decision => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify, confirm: async () => true } });
  f.controls.waitingOnYou = [peer]; f.receipt(false); await f.command('connect C:/private/room.json');
  await vi.advanceTimersByTimeAsync(25000); f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(1);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  await f.command('resolve ' + decision);
  // A late receipt for a locally resolved attempt must not consume the pending batch again.
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  f.entries.push({ type: 'custom_message', ...payload });
  f.receipt(true); await f.command('resume');
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(decision === 'retry' ? 2 : 1);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
});
it('records pause transitions without automatic turns until resume, and without replay afterwards', async () => {
  const f = fixture(); f.controls.aiPaused = false; await f.command('connect C:/private/room.json');
  f.controls.aiPaused = true; await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).not.toHaveBeenCalled(); expect((await f.tool('cafe_room_status')).details.state).toBe('room-paused');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.controls.aiPaused = false; await vi.advanceTimersByTimeAsync(10000);
  const sent = vi.mocked(f.pi.sendMessage).mock.calls.map(([p]) => p.content);
  expect(sent).toHaveLength(2); expect(sent[0]).toContain('[pause on]'); expect(sent[1]).toContain('[pause off]');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(2); expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
});
it('rejects partial control receipts and restores the original pending batch', async () => {
  const f = fixture(); f.controls.tasks = []; f.controls.waitingOnYou = [];
  await f.command('connect C:/private/room.json'); f.receipt(false);
  f.controls.tasks = [{ id: 1, title: 'Task', status: 'todo' }]; f.controls.waitingOnYou = [peer];
  await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0] as any;
  f.entries.push({ type: 'custom_message', ...payload, details: { ...payload.details, control: { ...payload.details.control, events: payload.details.control.events.slice(0, 1) } } });
  await f.events.get('message_end')!({}, f.ctx); await vi.advanceTimersByTimeAsync(20000);
  expect((await f.tool('cafe_room_status')).details.error).toBe('HOST_DELIVERY_UNKNOWN');
  f.reload(); await f.command('resume'); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(1);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('only registers /cafe, and usage and status never read credentials or start a network request', async () => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  expect([...f.commands.keys()]).toEqual(['cafe']);
  await f.commands.get('cafe').handler('', f.ctx);
  await f.command(''); await f.command('status');
  expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  expect(JSON.stringify(notify.mock.calls)).toContain('/cafe collab connect');
  expect(JSON.stringify(notify.mock.calls)).not.toContain('/cafe-collab');
});
it.each(['connect', 'resume', 'poll'])('explains HTTP 404 during %s without changing bindings, retrying or leaking credentials', async phase => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  if (phase !== 'connect') await f.command('connect C:/private/room.json');
  if (phase === 'resume') f.reload();
  const entries = [...f.entries]; f.fetcher.mockClear(); notify.mockClear();
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
  if (phase === 'poll') await vi.advanceTimersByTimeAsync(5000);
  else await f.command(phase === 'connect' ? 'connect C:/private/room.json' : 'resume');
  await vi.advanceTimersByTimeAsync(60000);
  const text = JSON.stringify(notify.mock.calls);
  for (const hint of ['ROOM_HTTP_404', 'room or API endpoint', 'resume uses the saved room binding', '/cafe collab connect <absolute private config path>']) expect(text).toContain(hint);
  expect(text).not.toContain(token); expect(text).not.toContain('C:/private/room.json');
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.entries).toEqual(entries); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect((await f.tool('cafe_room_status')).details.state).toBe(phase === 'poll' ? 'paused' : 'disconnected');
});
it('does nothing on load; explicit connect skips old history and injects only new external messages', async () => {
  const f = fixture(); expect(f.fetcher).not.toHaveBeenCalled(); f.messages.push(message(1));
  await f.command('connect C:/private/room.json'); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.messages.push(message(2)); await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0]; expect(payload.content).toContain('untrusted peer data'); expect(JSON.stringify(payload)).not.toContain(token);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(2);
});
it('lets the model bind its own session with cafe_room_connect, then resume it after a reload', async () => {
  const f = fixture(); f.messages.push(...Array.from({ length: 30 }, (_, i) => message(i + 1)));
  const connected = await f.tool('cafe_room_connect', { config: 'C:/private/room with spaces.json', consumedThrough: 25 });
  expect(connected.details).toMatchObject({ outcome: 'CONNECTED', cursor: 25, consumed: 25, delivered: 0 });
  expect(client.readMembership).toHaveBeenCalledWith('C:/private/room with spaces.json');
  // The same single binding record as the user's migrate command; the token never reaches the session.
  expect(f.entries[0].data).toMatchObject({ kind: 'binding', consumedThrough: 25, configPath: 'C:/private/room with spaces.json' });
  expect(JSON.stringify(f.entries) + JSON.stringify(connected)).not.toContain(token);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.pi.sendMessage).mock.calls[0]![0].content).toContain('[msg #26');
  f.reload();
  expect((await f.tool('cafe_room_status')).details.state).toBe('disconnected');
  const resumed = await f.tool('cafe_room_connect', { config: 'C:/ignored.json', consumedThrough: 0 });
  expect(resumed.details).toMatchObject({ outcome: 'RESUMED', consumed: 25 });
  expect(client.readMembership).toHaveBeenLastCalledWith('C:/private/room with spaces.json');
});
it.each([
  [{}, 'ABSOLUTE_PRIVATE_CONFIG_REQUIRED'], [{ config: 'room.json', consumedThrough: 0 }, 'ABSOLUTE_PRIVATE_CONFIG_REQUIRED'],
  [{ config: '"C:/private/room.json"', consumedThrough: 0 }, 'ABSOLUTE_PRIVATE_CONFIG_REQUIRED'], [{ config: 'C:/private/room.json' }, 'CONSUMED_THROUGH_REQUIRED'],
])('refuses a self-binding without an absolute unquoted config and a handled prefix: %j', async (params, outcome) => {
  const f = fixture();
  expect((await f.tool('cafe_room_connect', params)).details).toMatchObject({ outcome, state: 'disconnected' });
  expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.entries).toEqual([]);
});
it.each([
  [{ listener: process.pid }, 'SPACE_AGENT_LISTENER_RUNNING'], [{ deliveryWatcher: { pid: process.pid } }, 'SPACE_AGENT_LISTENER_RUNNING'],
  [{ delivery: { seq: 4, pid: 0 } }, 'SPACE_AGENT_DELIVERY_PENDING'],
])('refuses to share a member with a running or unsettled space-agent: %j', async (state, outcome) => {
  const home = mkdtempSync(join(tmpdir(), 'cafe-connect-')); cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  writeFileSync(join(home, 'state.json'), JSON.stringify({ fetched: 5, consumed: 5, skipped: [], ...state }));
  const f = fixture(); f.messages.push(...Array.from({ length: 5 }, (_, i) => message(i + 1)));
  expect((await f.tool('cafe_room_connect', { config: join(home, 'member.json'), consumedThrough: 5 })).details).toMatchObject({ outcome, state: 'disconnected' });
  expect(client.readMembership).not.toHaveBeenCalled(); expect(f.entries).toEqual([]);
  // Once that listener is gone, a stale pid no longer blocks the binding.
  writeFileSync(join(home, 'state.json'), JSON.stringify({ fetched: 5, consumed: 5, skipped: [], listener: 2 ** 31 - 2 }));
  if (!('delivery' in state)) expect((await f.tool('cafe_room_connect', { config: join(home, 'member.json'), consumedThrough: 5 })).details.outcome).toBe('CONNECTED');
});
it('reports a refused migration to the model instead of only to the screen', async () => {
  const f = fixture();
  await f.command('connect C:/private/room.json');
  f.session('session-two');
  const result = await f.tool('cafe_room_connect', { config: 'C:/private/room.json', consumedThrough: 0 });
  expect(result.details.outcome).toBe('NOT_CONNECTED');
  expect(result.details.notices).toContain('ROOM_ALREADY_INITIALIZED_USE_RESUME');
});
it('migrates an explicit handled prefix without skipping backlog or inventing host delivery, and restores it', async () => {
  const f = fixture(); f.messages.push(...Array.from({ length: 550 }, (_, i) => message(i + 1)));
  await f.command('migrate --consumed-through 500 C:/private/room with spaces.json');
  expect(client.readMembership).toHaveBeenCalledWith('C:/private/room with spaces.json');
  expect(f.entries[0].data).toMatchObject({ kind: 'binding', consumedThrough: 500, configPath: 'C:/private/room with spaces.json' });
  expect(JSON.stringify(f.entries)).not.toContain(token);
  expect(f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
    { op: 'read', roomId, after: 499, limit: 1 }, { op: 'read', roomId, after: 500 },
  ]);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 500, consumed: 500, delivered: 0 });
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.pi.sendMessage).mock.calls[0]![0].content).toContain('[backlog #501–#550 共 50 条]');
  for (const sequence of [500, 501, 550]) {
    await expect(f.tool('cafe_room_show', { sequence })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
    await expect(f.tool('cafe_room_reply', { replyTo: sequence, text: 'Not authorized by migration' })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  }
  expect(f.fetcher.mock.calls.some(([, init]) => JSON.parse(String(init?.body)).op === 'send')).toBe(false);
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(15000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 500, consumed: 500, delivered: 0 });
  const reports = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'ack');
  expect(reports.at(-1)).toMatchObject({ fetched: 550, delivered: 0 });
  expect((await f.tool('cafe_room_read', { limit: 20 })).details.messages.map(m => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 501));
  await f.tool('cafe_room_done', { sequence: 520, through: true });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 520, consumed: 520, delivered: 0 });
});
it('explicit zero migration preserves preexisting page-out mentions and their independent receipts', async () => {
  const f = fixture(), targets = [101, 250, 501];
  f.messages.push(...Array.from({ length: 550 }, (_, i) => ({ ...message(i + 1), to: targets.includes(i + 1) ? me : '' })));
  await f.command('migrate --consumed-through 0 C:/private/room.json'); await vi.advanceTimersByTimeAsync(40000);
  const receipts = f.entries.filter(e => e.type === 'custom_message' && e.details?.discovered);
  expect(receipts.map(e => e.details.seq)).toEqual(targets);
  for (const sequence of targets) expect((await f.tool('cafe_room_show', { sequence })).details.message.seq).toBe(sequence);
  await expect(f.tool('cafe_room_done', { sequence: 501 })).rejects.toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, consumed: 0, delivered: 0 });
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.entries.filter(e => e.type === 'custom_message' && e.details?.discovered)).toHaveLength(3);
});
it.each(['migrate', 'migrate C:/private/room.json', 'migrate --consumed-through C:/private/room.json',
  ...['-1', '1.5', 'NaN', 'Infinity', '0x10', '1e2', '9007199254740992'].map(seq => `migrate --consumed-through ${seq} C:/private/room.json`)])('rejects invalid migration arguments without reading credentials: %s', async command => {
  const f = fixture(); await f.command(command);
  expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.entries).toEqual([]);
});
it.each(['memory-only', 'no-conversation'])('rejects migration before credentials or network when the session is %s', async kind => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  Object.assign(f.ctx.sessionManager, kind === 'memory-only' ? { getSessionFile: () => undefined } : { getEntries: () => [] });
  await f.command('migrate --consumed-through 0 C:/private/room.json');
  expect(JSON.stringify(notify.mock.calls)).toContain('MIGRATION_REQUIRES_SAVED_CONVERSATION');
  expect(client.readMembership).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.entries).toEqual([]);
});
it('rejects a migration beyond the room tail without recording any checkpoint', async () => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } }); f.messages.push(message(1));
  await f.command('migrate --consumed-through 2 C:/private/room.json');
  expect(JSON.stringify(notify.mock.calls)).toContain('MIGRATION_SEQUENCE_NOT_FOUND');
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.entries).toEqual([]); expect(f.pi.sendMessage).not.toHaveBeenCalled();
});
it.each(['connect C:/private/room.json', 'migrate --consumed-through 0 C:/private/room.json'])('rejects migration over existing native state without stopping its listener: %s', async initial => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } }); await f.command(initial);
  const before = [...f.entries], requests = f.fetcher.mock.calls.length;
  await f.command('migrate --consumed-through 0 C:/private/room.json');
  expect(JSON.stringify(notify.mock.calls)).toContain('ROOM_ALREADY_INITIALIZED_USE_RESUME');
  expect(f.entries).toEqual(before); expect(f.fetcher).toHaveBeenCalledTimes(requests);
  f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('migration saves its binding and prefix together before the first pending-page read, including read failure', async () => {
  const f = fixture(); f.messages.push(message(1), message(2), message(3));
  const read = client.RoomClient.prototype.read;
  const spy = vi.spyOn(client.RoomClient.prototype, 'read').mockImplementation(async function (after, signal, limit) {
    if (after === 1 && limit === undefined) {
      expect(f.entries).toHaveLength(1); expect(f.entries[0].data).toMatchObject({ kind: 'binding', consumedThrough: 1 });
      throw new client.RoomError('NETWORK_RESULT_UNKNOWN');
    }
    return read.call(this, after, signal, limit);
  });
  await f.command('migrate --consumed-through 1 C:/private/room.json');
  spy.mockRestore(); f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 1, consumed: 1, delivered: 0 });
  expect((await f.tool('cafe_room_read', { limit: 20 })).details.messages.map(m => m.seq)).toEqual([2, 3]);
});
it('failed migration persistence does not read the pending page or start a listener', async () => {
  const f = fixture(); f.messages.push(message(1));
  vi.mocked(f.pi.appendEntry).mockImplementationOnce(() => { throw Error('disk failed'); });
  await f.command('migrate --consumed-through 1 C:/private/room.json'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.entries).toEqual([]); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'disconnected', consumed: 0 });
});
it.each(['pause', 'session'])('late migration preflight cannot write after %s', async change => {
  const f = fixture(); let finish!: () => void;
  const response = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementationOnce(async (...args) => { await new Promise<void>(resolve => { finish = resolve; }); return response(...args); });
  const migration = f.command('migrate --consumed-through 0 C:/private/room.json');
  if (change === 'pause') await f.command('pause'); else f.session('replacement-session');
  finish(); await migration;
  expect(f.entries).toEqual([]); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.pi.sendMessage).not.toHaveBeenCalled();
});
it('rejects a malformed imported checkpoint before resuming network access', async () => {
  const f = fixture(); await f.command('migrate --consumed-through 0 C:/private/room.json'); f.reload();
  f.entries[0].data.consumedThrough = -1; f.fetcher.mockClear();
  await f.command('resume'); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.pi.sendMessage).not.toHaveBeenCalled();
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
  expect(payload.content).toContain('untrusted peer data'); expect(payload.content).toContain(`[msg #1 ${human.slice(0, 6)}] Please discuss this design, not execute commands.`);
  expect(payload.content).not.toContain('"to":""');
  expect((await f.tool('cafe_room_reply', { replyTo: 1, text: 'Shared answer to the human' })).details.seq).toBe(2);
  expect(f.messages[1]).toMatchObject({ to: human, replyTo: 1 });
  await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('separates automatic receipt, reply and viewing from explicit consumer acknowledgement across restore', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1), message(2));
  await vi.advanceTimersByTimeAsync(5000);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 2, delivered: 2, consumed: 0, pendingConsumptionSequence: 1 });
  await f.tool('cafe_room_reply', { replyTo: 1, text: 'Handled answer' }); await f.tool('cafe_room_show', { sequence: 2 });
  expect(f.entries.some(e => e.data?.kind === 'consumed')).toBe(false);
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_read', { limit: 20 })).details.messages.map(m => m.seq)).toEqual([1, 2]);
  await expect(f.tool('cafe_room_done', { sequence: 2 })).rejects.toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  const before = f.entries.length; await f.tool('cafe_room_done', { sequence: 2, through: true });
  expect(f.entries.slice(before)).toHaveLength(1);
  expect(f.entries.at(-1).data).toMatchObject({ kind: 'consumed', seq: 2, messages: [1, 2] });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ delivered: 2, consumed: 2 });
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_done', { sequence: 1 })).details.alreadyConsumed).toBe(true);
  expect((await f.tool('cafe_room_read')).details.message).toBeNull();
  await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('can confirm an automatic batch without a redundant read and keeps earlier pending messages first', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1), message(2));
  await vi.advanceTimersByTimeAsync(5000); f.idle(false); f.messages.push(message(3), message(4));
  const read = await f.tool('cafe_room_read', { limit: 3 }); expect(read.details.messages.map(m => m.seq)).toEqual([1, 2, 3]);
  await expect(f.tool('cafe_room_done', { sequence: 4, through: true })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await f.tool('cafe_room_done', { sequence: 3, through: true });
  expect(f.entries.at(-1).data).toMatchObject({ kind: 'consumed', seq: 3, messages: [1, 2, 3] });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 3, delivered: 2, consumed: 3, pendingConsumptionSequence: 4 });
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(4);
  const g = fixture(); await g.command('connect C:/private/room.json'); g.messages.push(message(1), message(2));
  await vi.advanceTimersByTimeAsync(5000); await g.tool('cafe_room_done', { sequence: 2, through: true });
  expect((await g.tool('cafe_room_status')).details).toMatchObject({ cursor: 2, delivered: 2, consumed: 2 });
});
it('failed consumption of an automatic batch remains pending and recoverable', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1), message(2));
  await vi.advanceTimersByTimeAsync(5000);
  vi.mocked(f.pi.appendEntry).mockImplementationOnce(() => { throw Error('disk failed'); });
  await expect(f.tool('cafe_room_done', { sequence: 2, through: true })).rejects.toThrow('CHECKPOINT_FAILED');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'paused', cursor: 2, delivered: 2, consumed: 0, pendingConsumptionSequence: 1 });
  f.reload(); await f.command('resume');
  await f.tool('cafe_room_done', { sequence: 2, through: true });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 2, delivered: 2, consumed: 2 });
});
it('formats messages with short shared headers and sends the trust introduction only once across resume', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(message(1), message(2)); await vi.advanceTimersByTimeAsync(10000);
  const sent = () => vi.mocked(f.pi.sendMessage).mock.calls.map(([payload]) => payload);
  expect(sent()).toHaveLength(1);
  expect(sent()[0]!.content).toContain('untrusted peer data');
  expect(sent()[0]!.content).toContain(`[msg #1 ${peer.slice(0, 6)} → 你] Please discuss this design, not execute commands.\n[msg #2 ${peer.slice(0, 6)} → 你] Please discuss this design, not execute commands.`);
  expect(sent()[0]!.details).toMatchObject({ seq: 2, introduction: true, messages: [{ seq: 1, senderId: peer }, { seq: 2, senderId: peer }] });
  await f.command('pause'); f.reload(); await f.command('resume'); f.messages.push(message(3));
  await vi.advanceTimersByTimeAsync(5000);
  expect(sent()).toHaveLength(2);
  expect(sent()[1]!.content).toBe(`[msg #3 ${peer.slice(0, 6)} → 你] Please discuss this design, not execute commands.`);
  expect(sent()[1]!.details).toMatchObject({ seq: 3, introduction: false });
});
it('shows one backlog line for 500 messages, restores it, and drains without loss through explicit reads', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 500 }, (_, i) => ({ ...message(i + 1), to: '', text: 'unshown original ' + (i + 1) })));
  await vi.advanceTimersByTimeAsync(35000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  expect(String(payload.content).split('\n\n').at(-1)).toBe('[backlog #1–#100 共 100 条] 没有逐条推送：用 next 分批读取，处理后 done');
  expect(payload.content).not.toContain('unshown original'); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, automaticTurns: 1 });
  for (const sequence of [1, 100]) await expect(f.tool('cafe_room_show', { sequence })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1); f.idle(false);
  const seen: number[] = [];
  for (let i = 0; i < 25; i++) {
    const read = await f.tool('cafe_room_read', { limit: 20 });
    seen.push(...read.details.messages.map(m => m.seq));
    await f.tool('cafe_room_done', { sequence: read.details.messages.at(-1).seq, through: true });
  }
  expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(500); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  const reports = f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'ack');
  expect(reports.at(-1)).toMatchObject({ fetched: 500, delivered: 0 });
  expect((await f.tool('cafe_room_done', { sequence: 1, through: true })).details.alreadyConsumed).toBe(true);
});
it('restores durable page-out discovery without granting delivery or consumption authority', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 550 }, (_, i) => ({ ...message(i + 1), to: i + 1 === 250 ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000); f.idle(false); await vi.advanceTimersByTimeAsync(5000);
  const saved = f.entries.filter(e => e.data?.kind === 'discovery').at(-1).data.discovery;
  expect(saved).toEqual({ cursor: 300, pending: [250] });
  expect(JSON.stringify(saved)).not.toContain(token);
  f.reload(); const before = f.fetcher.mock.calls.length; await f.command('resume');
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.entries.filter(e => e.data?.kind === 'discovery').at(-1).data.discovery).toEqual({ cursor: 550, pending: [250] });
  const reads = f.fetcher.mock.calls.slice(before).map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'read');
  expect(reads.some(q => q.after === 300)).toBe(true);
  expect(reads.some(q => q.after === 100 || q.after === 200)).toBe(false);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0 });
  await expect(f.tool('cafe_room_show', { sequence: 250 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_reply', { replyTo: 250, text: 'Not authorized by discovery' })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_done', { sequence: 250 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('rejects corrupted discovery state on resume before any network request', async () => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  await f.command('connect C:/private/room.json'); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  const entry = f.entries.find(e => e.data?.kind === 'discovery'); entry.data.discovery.pending = [2];
  f.reload(); const count = f.fetcher.mock.calls.length; await f.command('resume');
  expect(f.fetcher).toHaveBeenCalledTimes(count); expect(JSON.stringify(notify.mock.calls)).toContain('INVALID_DISCOVERY_STATE');
});
it.each([101, 250, 501])('discovers a new addressed message beyond the backlog page without consuming earlier messages (#%s)', async target => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 100 }, (_, i) => ({ ...message(i + 1), to: '' })));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  f.messages.push(...Array.from({ length: 450 }, (_, i) => ({ ...message(i + 101), to: i + 101 === target ? me : '', text: i + 101 === target ? 'page-out mention ' + target : 'ordinary broadcast' })));
  await vi.advanceTimersByTimeAsync(35000);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'listening', cursor: 0, consumed: 0 });
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(1);
  const pageOut = () => vi.mocked(f.pi.sendMessage).mock.calls.filter(([payload]) => (payload.details as any).discovered === true);
  expect(pageOut()).toHaveLength(1); expect(pageOut()[0][0].content).toContain('page-out mention ' + target);
  expect((await f.tool('cafe_room_show', { sequence: target })).details.message.seq).toBe(target);
  await expect(f.tool('cafe_room_show', { sequence: target + 1 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_done', { sequence: target })).rejects.toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_done', { sequence: target, through: true })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(pageOut()).toHaveLength(1);
  expect((await f.tool('cafe_room_reply', { replyTo: target, text: 'Only the explicitly shared answer' })).details.seq).toBe(551);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0 });
});
it('requires a stored matching page-out receipt before granting full-text or reply access', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(...Array.from({ length: 112 }, (_, i) => ({ ...message(i + 1), to: i + 1 === 101 ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0][0];
  expect(payload.details).toMatchObject({ discovered: true, seq: 101, backlog: false });
  await expect(f.tool('cafe_room_show', { sequence: 101 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_reply', { replyTo: 101, text: 'Not received' })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.events.get('message_end')?.({ message: { role: 'custom', ...payload } }, f.ctx);
  await expect(f.tool('cafe_room_show', { sequence: 101 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.entries.push({ type: 'custom_message', ...payload }); f.events.get('message_start')?.({}, f.ctx);
  expect((await f.tool('cafe_room_show', { sequence: 101 })).details.message.seq).toBe(101);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0, pendingConsumptionSequence: 1 });
});
it.each([false, true])('consumes an older prefix while a page-out wake awaits its receipt (received=%s)', async received => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(message(1), message(2)); await vi.advanceTimersByTimeAsync(5000);
  f.receipt(false);
  f.messages.push(...Array.from({ length: 110 }, (_, i) => ({ ...message(i + 3), to: i + 3 === 103 ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[1][0];
  expect(payload.details).toMatchObject({ discovered: true, seq: 103 });
  expect((await f.tool('cafe_room_done', { sequence: 2, through: true })).details).toMatchObject({ consumed: 2, alreadyConsumed: false });
  expect(f.entries.at(-1).data).toMatchObject({ kind: 'consumed', seq: 2, messages: [1, 2] });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'awaiting-host-receipt', cursor: 2, delivered: 2, consumed: 2 });
  expect(f.entries.findLast(e => e.data?.kind === 'discovery').data.discovery).toEqual({ cursor: 112, pending: [103] });
  await expect(f.tool('cafe_room_show', { sequence: 103 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_done', { sequence: 103, through: true })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  if (received) {
    f.entries.push({ type: 'custom_message', ...payload }); f.events.get('message_start')?.({}, f.ctx);
    expect((await f.tool('cafe_room_show', { sequence: 103 })).details.message.seq).toBe(103);
    expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'listening', cursor: 2, delivered: 2, consumed: 2, pendingConsumptionSequence: 3 });
    await expect(f.tool('cafe_room_done', { sequence: 103 })).rejects.toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  }
  f.reload(); await f.command('resume'); f.idle(false); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  if (received) {
    expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 2, delivered: 2, consumed: 2, uncertainSequence: undefined });
    expect((await f.tool('cafe_room_done', { sequence: 2 })).details.alreadyConsumed).toBe(true);
    expect((await f.tool('cafe_room_read')).details.message.seq).toBe(3);
    expect((await f.tool('cafe_room_show', { sequence: 103 })).details.message.seq).toBe(103);
  } else {
    expect((await f.tool('cafe_room_status')).details).toMatchObject({ consumed: 2, uncertainSequence: 103 });
    await expect(f.tool('cafe_room_show', { sequence: 103 })).rejects.toThrow('ROOM_NOT_CONNECTED');
  }
});
it.each([101, 105])('restores sparse #%s, catches up without redelivery, and confirms the ordinary prefix once', async target => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 112 }, (_, i) => ({ ...message(i + 1), to: i + 1 === target ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000); f.reload(); await f.command('resume'); f.idle(false);
  for (let end = 20; end <= 100; end += 20) { await f.tool('cafe_room_read', { limit: 20 }); await f.tool('cafe_room_done', { sequence: end, through: true }); }
  f.idle(true); await vi.advanceTimersByTimeAsync(5000);
  const payloads = vi.mocked(f.pi.sendMessage).mock.calls.map(([p]) => p);
  expect(payloads).toHaveLength(2);
  expect((payloads[1].details as any).messages.map((m: any) => m.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 101).filter(seq => seq !== target));
  expect((await f.tool('cafe_room_read', { limit: 20 })).details.messages.map((m: client.Message) => m.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 101));
  await f.tool('cafe_room_done', { sequence: 112, through: true });
  expect(f.entries.at(-1).data).toMatchObject({ kind: 'consumed', seq: 112, messages: Array.from({ length: 12 }, (_, i) => i + 101) });
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect((await f.tool('cafe_room_read')).details.message).toBeNull(); expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  expect((await f.tool('cafe_room_done', { sequence: target })).details.alreadyConsumed).toBe(true);
});
it.each([101, 105])('restores stale discovery after manual consumption passes sparse #%s', async target => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 112 }, (_, i) => ({ ...message(i + 1), to: i + 1 === target ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000); f.idle(false);
  for (let end = 20; end <= 100; end += 20) { await f.tool('cafe_room_read', { limit: 20 }); await f.tool('cafe_room_done', { sequence: end, through: true }); }
  await f.tool('cafe_room_read', { limit: 20 }); await f.tool('cafe_room_done', { sequence: 112, through: true });
  f.messages.push({ ...message(113), to: '' });
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(113);
  await f.tool('cafe_room_done', { sequence: 113 });
  expect(f.entries.findLast(e => e.data?.kind === 'discovery').data.discovery).toEqual({ cursor: 112, pending: [], received: [target] });
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 113, delivered: 0, consumed: 113, error: undefined, uncertainSequence: undefined });
  expect((await f.tool('cafe_room_show', { sequence: target })).details.message.seq).toBe(target);
  expect((await f.tool('cafe_room_done', { sequence: target })).details.alreadyConsumed).toBe(true);
  f.idle(true); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_read')).details.message).toBeNull();
  expect(f.entries.findLast(e => e.data?.kind === 'discovery').data.discovery).toEqual({ cursor: 113, pending: [], received: [] });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 113, delivered: 0, consumed: 113 });
});
it.each(['retry', 'skip'])('locally resolves an uncertain page-out wake with %s without skipping unread history', async decision => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(...Array.from({ length: 112 }, (_, i) => ({ ...message(i + 1), to: i + 1 === 101 ? me : '' })));
  await vi.advanceTimersByTimeAsync(25000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0][0]; f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(101);
  const confirm = vi.fn().mockResolvedValue(true); Object.assign(f.ctx, { hasUI: true, ui: { notify: vi.fn(), confirm } });
  await f.command('resolve ' + decision); expect(confirm.mock.calls[0][1]).toContain('Page-out message batch');
  if (decision === 'skip') expect(confirm.mock.calls[0][1]).toContain('original message remains unread');
  f.entries.push({ type: 'custom_message', ...payload }); f.receipt(true); await f.command('resume');
  await vi.advanceTimersByTimeAsync(10000);
  const pageOut = vi.mocked(f.pi.sendMessage).mock.calls.filter(([p]) => (p.details as any).discovered === true);
  expect(pageOut).toHaveLength(decision === 'retry' ? 2 : 1);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0 });
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(1);
  if (decision === 'retry') expect((await f.tool('cafe_room_show', { sequence: 101 })).details.message.seq).toBe(101);
  else await expect(f.tool('cafe_room_show', { sequence: 101 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(5000);
  expect(vi.mocked(f.pi.sendMessage).mock.calls.filter(([p]) => (p.details as any).discovered === true)).toHaveLength(pageOut.length);
  if (decision === 'skip') {
    f.idle(false);
    for (let end = 20; end <= 100; end += 20) { await f.tool('cafe_room_read', { limit: 20 }); await f.tool('cafe_room_done', { sequence: end, through: true }); }
    expect((await f.tool('cafe_room_read')).details.message.seq).toBe(101);
    expect((await f.tool('cafe_room_show', { sequence: 101 })).details.message.seq).toBe(101);
    expect((await f.tool('cafe_room_status')).details.consumed).toBe(100);
  }
});
it('recovers an actual page-out host receipt after its discovery checkpoint failed', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  const append = vi.mocked(f.pi.appendEntry).getMockImplementation()!; let failed = false;
  vi.mocked(f.pi.appendEntry).mockImplementation((type, data: any) => {
    if (!failed && data.kind === 'discovery' && data.discovery.received?.length) { failed = true; throw Error('disk'); }
    append(type, data);
  });
  f.messages.push(...Array.from({ length: 112 }, (_, i) => ({ ...message(i + 1), to: i + 1 === 101 ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'paused', cursor: 0, delivered: 0, error: 'CHECKPOINT_FAILED' });
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(15000);
  expect(vi.mocked(f.pi.sendMessage).mock.calls.filter(([p]) => (p.details as any).discovered === true)).toHaveLength(1);
  expect((await f.tool('cafe_room_show', { sequence: 101 })).details.message.seq).toBe(101);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0 });
});
it('rejects received discovery metadata without a matching actual host receipt before networking', async () => {
  const f = fixture(), notify = vi.fn(); Object.assign(f.ctx, { hasUI: true, ui: { notify } });
  await f.command('connect C:/private/room.json'); const scope = f.entries.find(e => e.data?.kind === 'binding').data.scope;
  f.entries.push({ type: 'custom', customType: 'cafe-collaboration-state', data: { kind: 'discovery', scope, discovery: { cursor: 101, pending: [], received: [101] } } });
  f.reload(); const calls = f.fetcher.mock.calls.length; await f.command('resume');
  expect(f.fetcher).toHaveBeenCalledTimes(calls); expect(JSON.stringify(notify.mock.calls)).toContain('DISCOVERY_RECEIPT_REQUIRED');
});
it.each(['mode', 'sender', 'sequence', 'attempt', 'backlog', 'control'])('rejects mismatched page-out receipt %s live and on restore', async fault => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(...Array.from({ length: 112 }, (_, i) => ({ ...message(i + 1), to: i + 1 === 101 ? me : '' })));
  await vi.advanceTimersByTimeAsync(5000); const payload = vi.mocked(f.pi.sendMessage).mock.calls[0][0] as any;
  const details = structuredClone(payload.details);
  if (fault === 'mode') delete details.discovered;
  if (fault === 'sender') { details.senderId = human; details.messages[0].senderId = human; }
  if (fault === 'sequence') { details.seq = 102; details.messages[0].seq = 102; }
  if (fault === 'attempt') delete details.attempt;
  if (fault === 'backlog') details.backlog = true;
  if (fault === 'control') details.control = { id: 999, events: [] };
  f.entries.push({ type: 'custom_message', ...payload, details }); f.events.get('message_start')?.({}, f.ctx);
  await expect(f.tool('cafe_room_show', { sequence: 101 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(101);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('wakes waiting-on-you while a new message remains beyond the backlog page', async () => {
  const f = fixture(); f.controls.waitingOnYou = [];
  await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 100 }, (_, i) => ({ ...message(i + 1), to: '' })));
  await vi.advanceTimersByTimeAsync(5000);
  f.messages.push(...Array.from({ length: 450 }, (_, i) => ({ ...message(i + 101), to: '' })));
  f.controls.waitingOnYou = [peer]; await vi.advanceTimersByTimeAsync(35000);
  const sent = vi.mocked(f.pi.sendMessage).mock.calls.map(([payload]) => String(payload.content));
  expect(sent).toHaveLength(2); expect(sent[1]).toContain('[waiting-on-you');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0 });
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(1);
  await expect(f.tool('cafe_room_show', { sequence: 501 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
});
it('refreshes a changed backlog page at most once a minute and preserves its receipt across resume', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 500 }, (_, i) => ({ ...message(i + 1), to: '' }))); await vi.advanceTimersByTimeAsync(5000);
  const sent = () => vi.mocked(f.pi.sendMessage).mock.calls.map(([p]) => p as any);
  expect(sent()[0].details.summary).toMatchObject({ from: 1, through: 100, count: 100 });
  f.idle(false); await f.tool('cafe_room_read', { limit: 20 }); await f.tool('cafe_room_done', { sequence: 20, through: true });
  f.reload(); await f.command('resume'); f.idle(true);
  await vi.advanceTimersByTimeAsync(55000); expect(sent()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(5000); expect(sent()).toHaveLength(2);
  expect(sent()[1].content).toContain('[backlog #21–#120 共 100 条]');
  expect(sent()[1].details.summary).toMatchObject({ from: 21, through: 120, count: 100 });
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 20, delivered: 0, consumed: 20 });
  for (const tool of ['cafe_room_show', 'cafe_room_done']) await expect(f.tool(tool, { sequence: 120 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(180000); expect(sent()).toHaveLength(2);
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(21);
});
it.each(['legacy', 'future'])('bounds backlog refresh after restoring %s summary metadata', async variant => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 50 }, (_, i) => message(i + 1))); await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0] as any;
  const dispatch = f.entries.find(e => e.data?.kind === 'dispatch');
  if (variant === 'legacy') { delete payload.details.summary; delete dispatch.data.summary; }
  else { payload.details.summary.at = Date.now() + 86400000; dispatch.data.summary.at = Date.now() + 86400000; }
  f.reload(); await f.command('resume'); f.idle(false);
  await f.tool('cafe_room_read', { limit: 20 }); await f.tool('cafe_room_done', { sequence: 20, through: true }); f.idle(true);
  await vi.advanceTimersByTimeAsync(55000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 20, delivered: 0, consumed: 20 });
});
it('requires local resolution of an uncertain refreshed summary without skipping messages or replaying stale receipts', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push(...Array.from({ length: 25 }, (_, i) => message(i + 1))); await vi.advanceTimersByTimeAsync(5000);
  const first = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  f.messages.push(...Array.from({ length: 5 }, (_, i) => message(i + 26))); f.receipt(false);
  await vi.advanceTimersByTimeAsync(80000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0, error: 'HOST_DELIVERY_UNKNOWN' });
  f.reload(); await f.command('resume'); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(30);
  Object.assign(f.ctx, { hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) } });
  await f.command('resolve skip');
  f.entries.push({ type: 'custom_message', ...first });
  f.receipt(true); await f.command('resume'); await vi.advanceTimersByTimeAsync(180000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(2);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ cursor: 0, delivered: 0, consumed: 0 });
  await expect(f.tool('cafe_room_show', { sequence: 30 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(1);
});
it('reads and atomically confirms only the manually viewed prefix, with idempotent restore', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.idle(false);
  f.messages.push(message(1), { ...message(2), memberId: me }, message(3), message(4));
  const result = await f.tool('cafe_room_read', { limit: 2 });
  expect(result.details.messages.map(m => m.seq)).toEqual([1, 3]); expect(result.details.consumed).toBe(false);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  await expect(f.tool('cafe_room_done', { sequence: 4, through: true })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  const read = await f.tool('cafe_room_read', { limit: 1 }); expect(read.details.messages[0].seq).toBe(1);
  expect(read.details).not.toHaveProperty('message');
  const before = f.entries.length;
  await f.tool('cafe_room_done', { sequence: 3, through: true });
  expect(f.entries.slice(before)).toHaveLength(1);
  expect(f.entries.at(-1).data).toMatchObject({ kind: 'consumed', seq: 3, messages: [1, 3] });
  expect(f.fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body))).filter(q => q.op === 'ack')).toEqual([]);
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_done', { sequence: 1 })).details.alreadyConsumed).toBe(true);
  expect((await f.tool('cafe_room_read')).details.message.seq).toBe(4);
});
it('failed batch consumption is atomic and cancellation never consumes', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.idle(false); f.messages.push(message(1), message(2));
  await f.tool('cafe_room_read', { limit: 20 });
  const abort = new AbortController(); abort.abort(); const before = [...f.entries];
  await expect(f.tool('cafe_room_done', { sequence: 2, through: true }, abort.signal)).rejects.toThrow('CANCELLED');
  expect(f.entries).toEqual(before);
  vi.mocked(f.pi.appendEntry).mockImplementationOnce(() => { throw Error('disk failed'); });
  await expect(f.tool('cafe_room_done', { sequence: 2, through: true })).rejects.toThrow('CHECKPOINT_FAILED');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'paused', cursor: 0, pendingSequence: 1 });
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_read', { limit: 20 })).details.messages.map(m => m.seq)).toEqual([1, 2]);
});
it.each(['retry', 'skip'])('resolves an uncertain backlog summary with %s without skipping its unread messages', async decision => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(...Array.from({ length: 25 }, (_, i) => message(i + 1))); await vi.advanceTimersByTimeAsync(5000);
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ uncertainSequence: 25, state: 'disconnected' });
  const confirm = vi.fn().mockResolvedValue(true); Object.assign(f.ctx, { hasUI: true, ui: { notify: vi.fn(), confirm } });
  await f.command('resolve ' + decision); expect(confirm.mock.calls[0][1]).toContain('Backlog summary');
  f.receipt(true); await f.command('resume'); await vi.advanceTimersByTimeAsync(10000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(decision === 'retry' ? 2 : 1);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  await expect(f.tool('cafe_room_show', { sequence: 25 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  expect((await f.tool('cafe_room_read', { limit: 20 })).details.messages.map(m => m.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
});
it('does not confuse a backlog receipt with actual message delivery', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(...Array.from({ length: 25 }, (_, i) => message(i + 1))); await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  f.entries.push({ type: 'custom_message', ...payload, details: { ...(payload.details as any), backlog: false } });
  f.events.get('message_start')?.({}, f.ctx); expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  f.reload(); await f.command('resume'); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(25);
});
it('uses member names and restores reply/full-text access to every message in a batch', async () => {
  const f = fixture({ [peer]: 'Pi', [human]: 'Frontend' }); await f.command('connect C:/private/room.json');
  f.messages.push(message(1), { ...message(2), memberId: human, to: peer, replyTo: 1 });
  await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  expect(payload.content).toContain('[msg #1 Pi → 你]'); expect(payload.content).toContain('[msg #2 Frontend → Pi ↩#1]');
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_show', { sequence: 1 })).details.message).toEqual(message(1));
  expect((await f.tool('cafe_room_show', { sequence: 2 })).details.message.memberId).toBe(human);
  await f.tool('cafe_room_reply', { replyTo: 1, text: 'First reply' });
  await f.tool('cafe_room_reply', { replyTo: 2, text: 'Second reply' });
  expect(f.messages.slice(2).map(m => m.to)).toEqual([peer, human]);
  await vi.advanceTimersByTimeAsync(10000); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('requires a stored batch receipt, then advances once through its last message', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(message(1), message(2)); await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  f.events.get('message_end')?.({ message: { role: 'custom', ...payload } }, f.ctx);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  for (const sequence of [1, 2]) await expect(f.tool('cafe_room_show', { sequence })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  f.entries.push({ type: 'custom_message', ...payload }); f.events.get('message_start')?.({}, f.ctx);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(2);
  expect(f.entries.filter(e => e.data?.kind === 'cursor').map(e => e.data.seq)).toEqual([0, 2]);
  for (const sequence of [1, 2]) expect((await f.tool('cafe_room_show', { sequence })).details.message.seq).toBe(sequence);
});
it.each(['retry', 'skip'])('resolves the entire uncertain batch with explicit %s, without partial replay', async decision => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(message(1), message(2)); await vi.advanceTimersByTimeAsync(5000); f.reload();
  await f.command('resume'); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(2);
  Object.assign(f.ctx, { hasUI: true, ui: { notify: vi.fn(), confirm: vi.fn().mockResolvedValue(true) } });
  await f.command('resolve ' + decision); f.receipt(true); await f.command('resume'); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(decision === 'retry' ? 2 : 1);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(2);
  if (decision === 'retry') expect((vi.mocked(f.pi.sendMessage).mock.calls[1]![0].details as any).messages.map(m => m.seq)).toEqual([1, 2]);
});
it('restores legacy single-message receipts without replay', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1)); await vi.advanceTimersByTimeAsync(5000);
  const receipt = f.entries.find(e => e.type === 'custom_message'); delete receipt.details.messages;
  f.reload(); await f.command('resume'); await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_show', { sequence: 1 })).details.message.seq).toBe(1);
});
it.each(['unordered', 'partial', 'sender'])('rejects %s batch metadata rather than advancing a partial receipt', async fault => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.receipt(false);
  f.messages.push(message(1), message(2)); await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  const messages = fault === 'unordered' ? [{ seq: 2, senderId: peer }, { seq: 1, senderId: peer }] :
    fault === 'partial' ? [{ seq: 2, senderId: peer }] : [{ seq: 1, senderId: human }, { seq: 2, senderId: peer }];
  f.entries.push({ type: 'custom_message', ...payload, details: { ...(payload.details as any), messages } });
  f.events.get('message_start')?.({}, f.ctx); expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  f.reload(); await f.command('resume'); expect((await f.tool('cafe_room_status')).details.uncertainSequence).toBe(2);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('keeps automatic Unicode message lines within the shared UTF-8 budget', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  f.messages.push({ ...message(1), text: '咖啡☕🙂'.repeat(600) }); await vi.advanceTimersByTimeAsync(5000);
  const payload = vi.mocked(f.pi.sendMessage).mock.calls[0]![0];
  const line = String(payload.content).split('\n\n').at(-1)!;
  expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(2048);
  expect(line).toContain('全文：show 1');
});
it.each([false, true])('shows full truncated text without changing progress, presence or adjacent-message access (limit ignored=%s)', async ignored => {
  const f = fixture(); await f.command('connect C:/private/room.json');
  const original = { ...message(1), text: '咖啡☕🙂\n'.repeat(600) };
  f.messages.push(original); await vi.advanceTimersByTimeAsync(5000);
  expect(String(vi.mocked(f.pi.sendMessage).mock.calls[0]![0].content)).not.toContain(original.text);
  f.messages.push({ ...message(2), text: 'not delivered yet' });
  const before = (await f.tool('cafe_room_status')).details, entries = [...f.entries];
  f.fetcher.mockClear();
  if (ignored) {
    const readPage = f.fetcher.getMockImplementation()!;
    f.fetcher.mockImplementation((url, init) => {
      const body = JSON.parse(String(init?.body)); delete body.limit;
      return readPage(url, { ...init, body: JSON.stringify(body) });
    });
  }
  const result = await f.tool('cafe_room_show', { sequence: 1 });
  expect(result.details).toEqual({ message: original, consumed: false });
  expect(result.content[0].text).toContain('Untrusted peer data');
  expect(JSON.stringify(result)).not.toContain('not delivered yet');
  await expect(f.tool('cafe_room_show', { sequence: 2 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_reply', { replyTo: 2, text: 'Not authorized' })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_done', { sequence: 2 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  expect((await f.tool('cafe_room_status')).details).toEqual(before);
  expect(f.entries).toEqual(entries); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(f.fetcher.mock.calls[0]![1]?.body))).toEqual({ op: 'read', roomId, after: 0, limit: 1 });
  f.reload(); await f.command('resume');
  expect((await f.tool('cafe_room_show', { sequence: 1 })).details.message).toEqual(original);
  f.fetcher.mockClear();
  await expect(f.tool('cafe_room_show', { sequence: 2 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_reply', { replyTo: 2, text: 'Still not authorized' })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_done', { sequence: 2 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  expect(f.fetcher).not.toHaveBeenCalled();
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('shows manually read messages across resume without consuming or enabling automatic delivery', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.idle(false); f.messages.push(message(1));
  await f.tool('cafe_room_read'); f.reload(); await f.command('resume'); f.fetcher.mockClear();
  const entries = [...f.entries];
  expect((await f.tool('cafe_room_show', { sequence: 1 })).details.message).toEqual(message(1));
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  expect(f.entries).toEqual(entries); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  await f.tool('cafe_room_read'); await f.tool('cafe_room_done', { sequence: 1 });
  expect((await f.tool('cafe_room_show', { sequence: 1 })).details.consumed).toBe(false);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(1);
});
it('allows full-text reads during room AI pause without sending or consuming', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000); f.fetcher.mockClear();
  f.fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ roomId, memberId: me, cursor: 1, more: false, aiPaused: true,
    members: [me, peer].map(id => ({ id, name: id, kind: 'ai' })), messages: [message(1)] })));
  const before = (await f.tool('cafe_room_status')).details, entries = [...f.entries];
  const result = await f.tool('cafe_room_show', { sequence: 1 });
  expect(result.details.message).toEqual(message(1)); expect(JSON.stringify(result)).not.toContain(token);
  expect((await f.tool('cafe_room_status')).details).toEqual(before); expect(f.entries).toEqual(entries);
  expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
});
it('does not show unseen messages or an uncertain automatic dispatch', async () => {
  const f = fixture();
  await expect(f.tool('cafe_room_show', { sequence: 1 })).rejects.toThrow('ROOM_NOT_CONNECTED');
  expect(f.fetcher).not.toHaveBeenCalled();
  await f.command('connect C:/private/room.json'); f.receipt(false); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000); f.fetcher.mockClear();
  await expect(f.tool('cafe_room_show', { sequence: 1 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  await expect(f.tool('cafe_room_show', { sequence: 99 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each(['missing', 'sender'])('rejects %s full-message results without moving the listener', async change => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000);
  if (change === 'missing') f.messages.length = 0;
  else f.messages[0] = { ...message(1), memberId: human };
  const entries = [...f.entries];
  await expect(f.tool('cafe_room_show', { sequence: 1 })).rejects.toThrow('INVALID_ROOM_RESPONSE');
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'listening', cursor: 1 });
  expect(f.entries).toEqual(entries);
});
it('does not retry full-text failures or change listener delivery state', async () => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000); f.fetcher.mockClear();
  f.fetcher.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await expect(f.tool('cafe_room_show', { sequence: 1 })).rejects.toThrow('ROOM_HTTP_429');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ state: 'listening', cursor: 1 });
});
it.each(['cancel', 'pause', 'session'])('discards full text after %s without persisting a read', async change => {
  const f = fixture(); await f.command('connect C:/private/room.json'); f.messages.push(message(1));
  await vi.advanceTimersByTimeAsync(5000); f.fetcher.mockClear();
  const abort = new AbortController(); abort.abort();
  await expect(f.tool('cafe_room_show', { sequence: 1 }, abort.signal)).rejects.toThrow('CANCELLED');
  expect(f.fetcher).not.toHaveBeenCalled();
  let finish!: (value: Response) => void;
  f.fetcher.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const during = new AbortController(), pending = f.tool('cafe_room_show', { sequence: 1 }, during.signal);
  const rejected = expect(pending).rejects.toThrow(change === 'cancel' ? 'CANCELLED' : change === 'pause' ? 'SESSION_CHANGED' : 'ROOM_NOT_CONNECTED');
  if (change === 'cancel') during.abort();
  else if (change === 'pause') await f.command('pause');
  else f.session('session-two');
  const entries = [...f.entries];
  finish(new Response(JSON.stringify({ roomId, memberId: me, cursor: 1, more: false,
    members: [me, peer].map(id => ({ id, name: id, kind: 'ai' })), messages: [message(1)] })));
  await rejected; expect(f.entries).toEqual(entries); expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
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
it('delivers, replies and restores native receipts beyond message 500', async () => {
  const f = fixture();
  f.messages.push(...Array.from({ length: 501 }, (_, i) => message(i + 1)));
  await f.command('connect C:/private/room.json');
  expect(f.pi.sendMessage).not.toHaveBeenCalled();
  f.messages.push(message(502));
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(502);
  expect((await f.tool('cafe_room_reply', { replyTo: 502, text: 'Continue the discussion' })).details.seq).toBe(503);
  f.reload();
  await f.command('resume');
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(1);
  expect((await f.tool('cafe_room_reply', { replyTo: 502, text: 'Continue the discussion' })).details.seq).toBe(503);
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
  for (let i = 1; i <= 8; i++) { f.messages.push(message(i)); await vi.advanceTimersByTimeAsync(5000); }
  expect(f.pi.sendMessage).toHaveBeenCalledTimes(8);
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
  await expect(f.tool('cafe_room_done', { sequence: 1 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
  const read = await f.tool('cafe_room_read'); expect(read.details.message.seq).toBe(1); expect(read.details.consumed).toBe(false);
  expect(read.content[0].text).toContain('Untrusted peer data'); expect(f.pi.sendMessage).not.toHaveBeenCalled();
  expect((await f.tool('cafe_room_status')).details.cursor).toBe(0);
  await expect(f.tool('cafe_room_done', { sequence: 2 })).rejects.toThrow('DELIVERED_MESSAGE_REQUIRED');
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
  expect((await f.tool('cafe_room_status')).details).toMatchObject({ delivered: 1, consumed: 0, pendingConsumptionSequence: 1 });
  await f.tool('cafe_room_done', { sequence: 1 });
  expect((await f.tool('cafe_room_status')).details.consumed).toBe(1);
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
