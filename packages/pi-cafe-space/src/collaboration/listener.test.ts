import { expect, it, vi } from 'vitest';
import { RoomClient, RoomError, parseSnapshot, type Membership, type Message, type Snapshot } from './client.js';
import { RoomListener, type ListenerHost } from './listener.js';
const me = 'a'.repeat(32), peer = 'b'.repeat(32), stranger = 'c'.repeat(32);
const auth: Membership = { origin: 'https://space.example.test', roomId: 'd'.repeat(32), memberId: me, token: 'e'.repeat(64), allowMembers: [peer] };
const message = (seq: number, patch: Partial<Message> = {}): Message => ({ seq, id: 'message-' + seq, memberId: peer, text: 'external data', to: me, replyTo: 0, ...patch });
const snapshot = (messages: Message[], after = 0): Snapshot => ({ roomId: auth.roomId, memberId: me, cursor: after + messages.length, more: false, members: [me, peer, stranger].map(id => ({ id, name: id, kind: 'ai', removed: false })), messages });
function fixture(messages = [message(1)]) {
  const client = new RoomClient(auth);
  const read = vi.spyOn(client, 'read').mockImplementation(async after => snapshot(messages.filter(m => m.seq > after), after));
  const host: ListenerHost = { isIdle: vi.fn(() => true), deliver: vi.fn(), checkpoint: vi.fn() };
  const listener = new RoomListener(client, host, 0);
  return { listener, host, read, client };
}
it('does not confuse dispatch with a native host receipt, and does not redeliver', async () => {
  const { listener, host } = fixture();
  await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1); expect(listener.cursor).toBe(0);
  await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1);
  listener.acknowledge(99); expect(listener.cursor).toBe(0);
  listener.acknowledge(1); expect(listener.cursor).toBe(1); expect(host.checkpoint).toHaveBeenCalledWith(1);
  await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1);
});
it('holds busy-session input in the connector, and pause cancels it before injection', async () => {
  const { listener, host } = fixture(); vi.mocked(host.isIdle).mockReturnValue(false);
  await listener.poll(); expect(listener.state).toBe('waiting-for-idle'); expect(listener.cursor).toBe(0); expect(host.deliver).not.toHaveBeenCalled();
  listener.pause(); vi.mocked(host.isIdle).mockReturnValue(true); await listener.poll(); expect(host.deliver).not.toHaveBeenCalled();
});
it('delivers queued input when the current session becomes idle', async () => {
  const { listener, host } = fixture(); vi.mocked(host.isIdle).mockReturnValueOnce(false);
  await listener.poll(); await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1); expect(listener.pending?.seq).toBe(1);
});
it('a mention alone does not authorize a stranger, and neither self echoes nor broadcasts wake the agent', async () => {
  const { listener, host } = fixture([message(1, { memberId: stranger }), message(2, { memberId: me }), message(3, { to: '' }), message(4)]);
  await listener.poll(); expect(host.deliver).toHaveBeenCalledExactlyOnceWith(message(4)); expect(listener.cursor).toBe(3);
});
it('recognizes replies to its own room posts without waking on messages addressed elsewhere', async () => {
  const { listener, host } = fixture([message(1, { to: stranger, replyTo: 100 }), message(2, { to: '', replyTo: 100 })]);
  listener.recordReply(100); await listener.poll(); expect(host.deliver).toHaveBeenCalledExactlyOnceWith(message(2, { to: '', replyTo: 100 }));
});
it('does not inject a late read result after cancellation or start overlapping polls', async () => {
  const { listener, host, read } = fixture(); let resolve!: (s: Snapshot) => void;
  read.mockImplementation(() => new Promise(r => { resolve = r; }));
  const running = listener.poll(); const joined = listener.poll(false); expect(read).toHaveBeenCalledTimes(1);
  listener.pause(); resolve(snapshot([message(1)])); await Promise.all([running, joined]); expect(host.deliver).not.toHaveBeenCalled();
});
it('retries a transient read but stops on authorization failure without changing credentials', async () => {
  const { listener, read, host } = fixture(); read.mockRejectedValueOnce(new RoomError('ROOM_HTTP_429', true, 60000));
  expect(await listener.poll()).toBe(60000); expect(listener.state).toBe('listening');
  read.mockRejectedValueOnce(new RoomError('ROOM_HTTP_401')); await listener.poll(); await listener.poll();
  expect(listener.state).toBe('paused'); expect(read).toHaveBeenCalledTimes(2); expect(host.deliver).not.toHaveBeenCalled();
});
it('does not replay an uncertain host injection or bypass a failed checkpoint', async () => {
  const f = fixture(); vi.mocked(f.host.deliver).mockImplementation(() => { throw Error('host uncertain'); });
  await f.listener.poll(); await f.listener.poll(); expect(f.listener.error).toBe('HOST_DELIVERY_UNKNOWN'); expect(f.host.deliver).toHaveBeenCalledTimes(1);
  const g = fixture(); await g.listener.poll(); vi.mocked(g.host.checkpoint).mockImplementation(() => { throw Error('disk failed'); });
  expect(() => g.listener.acknowledge(1)).toThrow('CHECKPOINT_FAILED'); expect(g.listener.cursor).toBe(0); expect(g.listener.state).toBe('paused');
});
it('stops before injecting queued data from a removed sender', async () => {
  const { listener, host, read } = fixture(); vi.mocked(host.isIdle).mockReturnValue(false); await listener.poll();
  const changed = snapshot([message(1)]); changed.members[1]!.removed = true; read.mockResolvedValue(changed); vi.mocked(host.isIdle).mockReturnValue(true);
  await listener.poll(); expect(listener.error).toBe('SENDER_REMOVED'); expect(host.deliver).not.toHaveBeenCalled();
});
it('continues delivering without a turn-count or listening-duration quota', async () => {
  vi.useFakeTimers();
  try {
    const { listener, host } = fixture(Array.from({ length: 100 }, (_, i) => message(i + 1)));
    vi.mocked(host.deliver).mockImplementation(m => listener.acknowledge(m.seq));
    for (let i = 0; i < 100; i++) { vi.advanceTimersByTime(60000); await listener.poll(); }
    expect(host.deliver).toHaveBeenCalledTimes(100); expect(listener.cursor).toBe(100); expect(listener.state).toBe('listening');
    listener.pause(); await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(100);
  } finally { vi.useRealTimers(); }
});
it('recovers from transient failure without requiring user renewal', async () => {
  const { listener, host, read } = fixture();
  read.mockRejectedValueOnce(new RoomError('NETWORK_RESULT_UNKNOWN', true));
  await listener.poll(); await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1);
});
it('manual reads and consumption share the filtered inbox without starting a turn', async () => {
  const { listener, host } = fixture([message(1, { memberId: stranger }), message(2, { memberId: me }), message(3, { to: '' }), message(4), message(5)]);
  await listener.poll(false); expect(listener.undispatched?.seq).toBe(4); expect(listener.cursor).toBe(3); expect(host.deliver).not.toHaveBeenCalled();
  expect(() => listener.consume(5)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  listener.consume(4); expect(host.checkpoint).toHaveBeenCalledWith(4, true);
  await listener.poll(); expect(host.deliver).toHaveBeenCalledExactlyOnceWith(message(5));
  expect(() => listener.consume(5)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  expect(listener.undispatched).toBeUndefined();
});
it('joining an in-flight read shares its result without another fetch or cursor', async () => {
  const { listener, host, read } = fixture(); vi.mocked(host.isIdle).mockReturnValue(false);
  let resolve!: (value: Snapshot) => void; read.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const automatic = listener.poll(), manual = listener.poll(false); expect(read).toHaveBeenCalledTimes(1);
  resolve(snapshot([message(1)])); await Promise.all([automatic, manual]);
  expect(listener.undispatched?.seq).toBe(1); expect(listener.cursor).toBe(0); expect(host.deliver).not.toHaveBeenCalled();
});
it('owner pause holds delivery until a later snapshot resumes it', async () => {
  const { listener, host, read } = fixture(); read.mockResolvedValueOnce({ ...snapshot([message(1)]), aiPaused: true });
  await listener.poll(); expect(listener.state).toBe('room-paused'); expect(host.deliver).not.toHaveBeenCalled();
  await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1);
});
it('validates room, member, cursor continuity and response fields before host delivery', () => {
  expect(() => parseSnapshot({ ...snapshot([message(1)]), roomId: 'f'.repeat(32) }, auth, 0)).toThrow();
  expect(() => parseSnapshot(snapshot([message(2)]), auth, 0)).toThrow();
  expect(() => parseSnapshot(snapshot([message(1, { text: '\x1b[2J' })]), auth, 0)).toThrow();
  expect(() => parseSnapshot({ ...snapshot([]), more: true }, auth, 0)).toThrow();
});
it('uses only an Authorization header, omits cookies and redirects, and never retries sends', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot([message(1)])), { headers: { 'Content-Type': 'application/json' } }));
  const client = new RoomClient(auth, request); await client.read(0);
  const [url, init] = request.mock.calls[0]!; expect(url).toBe(auth.origin + '/api/collaboration'); expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer ' + auth.token } }); expect(init?.body).not.toContain(auth.token);
  request.mockRejectedValueOnce(Error('connection lost'));
  await expect(client.reply({ id: 'stable-reply-1', to: peer, replyTo: 1, text: 'reply' })).rejects.toThrow('NETWORK_RESULT_UNKNOWN'); expect(request).toHaveBeenCalledTimes(2);
});
