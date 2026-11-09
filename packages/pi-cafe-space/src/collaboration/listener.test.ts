import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
import { RoomClient, RoomError, parseSnapshot, type Membership, type Message, type Snapshot } from './client.js';
import { RoomListener, parseDiscoveryState, type ListenerHost } from './listener.js';
const me = 'a'.repeat(32), peer = 'b'.repeat(32), stranger = 'c'.repeat(32);
const auth: Membership = { origin: 'https://space.example.test', roomId: 'd'.repeat(32), memberId: me, token: 'e'.repeat(64) };
const message = (seq: number, patch: Partial<Message> = {}): Message => ({ seq, id: 'message-' + seq, memberId: peer, text: 'external data', to: me, replyTo: 0, ...patch });
const snapshot = (messages: Message[], after = 0): Snapshot => ({ roomId: auth.roomId, memberId: me, cursor: after + messages.length, more: false, members: [me, peer, stranger].map(id => ({ id, name: id, kind: 'ai', removed: false })), messages });
function fixture(messages = [message(1)]) {
  const client = new RoomClient(auth);
  const read = vi.spyOn(client, 'read').mockImplementation(async after => snapshot(messages.filter(m => m.seq > after), after));
  const host: ListenerHost = { isIdle: vi.fn(() => true), deliver: vi.fn(), checkpoint: vi.fn() };
  const listener = new RoomListener(client, host, 0);
  return { listener, host, read, client };
}
function discoveryFixture(messages: Message[], restored?: { cursor: number; pending: number[] }, limitAware = true) {
  const f = fixture(messages);
  f.read.mockImplementation(async (after, _signal, limit) => {
    const page = messages.filter(m => m.seq > after).slice(0, limitAware ? limit ?? 100 : 100);
    return { ...snapshot(page, after), more: after + page.length < messages.length };
  });
  f.host.checkpointDiscovery = vi.fn();
  const listener = new RoomListener(f.client, f.host, 0, 0, 0, undefined, [], undefined, restored);
  return { ...f, listener };
}
it.each([101, 250, 501])('persists page-out mention #%s separately from processing and resumes its scan', async target => {
  const messages = Array.from({ length: 550 }, (_, i) => message(i + 1, { to: i + 1 === target ? me : '' }));
  const f = discoveryFixture(messages);
  await f.listener.poll(); f.listener.acknowledge(100);
  const saved = f.listener.discoveryState;
  const restored = new RoomListener(f.client, f.host, 0, 0, 100, undefined, [], undefined, saved);
  const offset = f.read.mock.calls.length;
  for (let i = 0; i < 5; i++) await restored.poll();
  expect(restored.discoveryState).toEqual({ cursor: 550, pending: [target] });
  expect(f.read.mock.calls.slice(offset).some(([after]) => after === saved.cursor)).toBe(true);
  expect(restored.cursor).toBe(0); expect(restored.delivered).toBe(0);
  expect(restored.pendingConsumptionBatch).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  expect(f.host.checkpoint).not.toHaveBeenCalled();
  expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith(messages.slice(0, 100), true);
});
it('caps the durable discovery queue, including when legacy servers ignore limit, and resumes after processing', async () => {
  const messages = Array.from({ length: 350 }, (_, i) => message(i + 1));
  const f = discoveryFixture(messages, { cursor: 199, pending: Array.from({ length: 99 }, (_, i) => i + 101) }, false);
  await f.listener.poll(); f.listener.acknowledge(100);
  expect(f.listener.discoveryState).toEqual({ cursor: 200, pending: Array.from({ length: 100 }, (_, i) => i + 101) });
  const calls = f.read.mock.calls.length; await f.listener.poll();
  expect(f.read.mock.calls.slice(calls).map(([after]) => after)).toEqual([0]);
  // Advancing the ordinary processing cursor frees the durable references without consuming them implicitly.
  for (let i = 0; i < 6; i++) { await f.listener.poll(false); f.listener.consume((i + 1) * 20, true); }
  await f.listener.poll();
  expect(f.listener.cursor).toBe(120); expect(f.listener.delivered).toBe(0);
  expect(f.listener.discoveryState).toEqual({ cursor: 240, pending: [...Array.from({ length: 80 }, (_, i) => i + 121), ...Array.from({ length: 20 }, (_, i) => i + 221)] });
});
it('does not scan or persist discovery on manual reads', async () => {
  const f = discoveryFixture(Array.from({ length: 150 }, (_, i) => message(i + 1)));
  await f.listener.poll(false);
  expect(f.read.mock.calls.map(([after]) => after)).toEqual([0]);
  expect(f.host.checkpointDiscovery).not.toHaveBeenCalled(); expect(f.listener.discoveryState).toEqual({ cursor: 0, pending: [] });
});
it('fails closed on a discovery checkpoint error without advancing any progress or dispatching', async () => {
  const f = discoveryFixture(Array.from({ length: 150 }, (_, i) => message(i + 1)));
  vi.mocked(f.host.checkpointDiscovery!).mockImplementation(() => { throw Error('disk'); });
  await f.listener.poll();
  expect(f.listener.state).toBe('paused'); expect(f.listener.error).toBe('CHECKPOINT_FAILED');
  expect(f.listener.discoveryState).toEqual({ cursor: 0, pending: [] });
  expect(f.listener.cursor).toBe(0); expect(f.listener.delivered).toBe(0);
  expect(f.host.deliver).not.toHaveBeenCalled(); expect(f.host.checkpoint).not.toHaveBeenCalled();
});
it('honors newer pause metadata from the discovery page and only queues active addressed peers', async () => {
  const messages = Array.from({ length: 104 }, (_, i) => message(i + 1, { to: '' }));
  messages[100] = message(101); messages[101] = message(102, { memberId: me });
  messages[102] = message(103, { memberId: stranger }); messages[103] = message(104, { to: peer });
  const f = discoveryFixture(messages), read = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (...args) => {
    const page = await read(...args);
    return args[0] === 100 ? { ...page, aiPaused: true, members: page.members.map(m => ({ ...m, removed: m.id === stranger })) } : page;
  });
  await f.listener.poll();
  expect(f.listener.discoveryState).toEqual({ cursor: 104, pending: [101] });
  expect(f.listener.state).toBe('room-paused'); expect(f.host.deliver).not.toHaveBeenCalled();
});
it('persists observed controls before a retryable discovery failure, even if the change disappears before retry', async () => {
  const f = discoveryFixture(Array.from({ length: 250 }, (_, i) => message(i + 1, { to: '' })));
  f.host.deliverControls = vi.fn(); f.host.checkpointControls = vi.fn();
  const read = f.read.getMockImplementation()!; let failing = true;
  f.read.mockImplementation(async (...args) => {
    if (args[0] === 100 && failing) throw new RoomError('NETWORK_RESULT_UNKNOWN', true, 17000);
    return { ...await read(...args), waitingOnYou: failing ? [peer] : [] };
  });
  expect(await f.listener.poll()).toBe(17000);
  const observed = f.listener.controlState;
  expect(observed.pending.flatMap(batch => batch.events).map(event => event.type)).toEqual(['waiting']);
  expect(f.host.checkpointControls).toHaveBeenCalledExactlyOnceWith(observed);
  expect(f.listener.discoveryState).toEqual({ cursor: 0, pending: [] });
  expect(f.host.deliverControls).not.toHaveBeenCalled(); expect(f.host.deliver).not.toHaveBeenCalled();
  failing = false;
  const restored = new RoomListener(f.client, f.host, 0, 0, 0, observed, [], undefined, f.listener.discoveryState);
  await restored.poll();
  expect(f.host.deliverControls).toHaveBeenCalledExactlyOnceWith(observed.pending[0]);
  expect(restored.discoveryState.cursor).toBe(200); expect(restored.cursor).toBe(0); expect(restored.delivered).toBe(0);
});
it.each(['resolve', 'reject'])('ignores a late discovery %s after local pause without checkpoint or heartbeat', async outcome => {
  const f = discoveryFixture(Array.from({ length: 150 }, (_, i) => message(i + 1)));
  f.client.supportsPresence = true; const ack = vi.spyOn(f.client, 'ack').mockResolvedValue();
  const read = f.read.getMockImplementation()!;
  let resolve!: (page: Snapshot) => void, reject!: (error: Error) => void;
  f.read.mockImplementation((...args) => args[0] === 100 ? new Promise((yes, no) => { resolve = yes; reject = no; }) : read(...args));
  const polling = f.listener.poll(); await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2));
  expect(f.listener.poll(false)).toBe(polling);
  f.listener.pause();
  if (outcome === 'resolve') resolve(await read(100)); else reject(new RoomError('CANCELLED'));
  await polling;
  expect(f.listener.discoveryState).toEqual({ cursor: 0, pending: [] });
  expect(f.listener.state).toBe('paused'); expect(f.listener.cursor).toBe(0); expect(f.listener.delivered).toBe(0);
  expect(f.host.checkpointDiscovery).not.toHaveBeenCalled(); expect(f.host.checkpoint).not.toHaveBeenCalled();
  expect(f.host.deliver).not.toHaveBeenCalled(); expect(ack).not.toHaveBeenCalled();
});
it.each(['ROOM_HTTP_401', 'INVALID_ROOM_RESPONSE'])('stops on a terminal discovery failure: %s', async code => {
  const f = discoveryFixture(Array.from({ length: 150 }, (_, i) => message(i + 1)));
  const read = f.read.getMockImplementation()!;
  f.read.mockImplementation((...args) => args[0] === 100 ? Promise.reject(new RoomError(code)) : read(...args));
  await f.listener.poll(); const calls = f.read.mock.calls.length; await f.listener.poll();
  expect(f.read).toHaveBeenCalledTimes(calls); expect(f.listener.state).toBe('paused'); expect(f.listener.error).toBe(code);
  expect(f.listener.discoveryState).toEqual({ cursor: 0, pending: [] });
  expect(f.host.checkpointDiscovery).not.toHaveBeenCalled(); expect(f.host.deliver).not.toHaveBeenCalled();
});
it('retains durable discovery through a failed heartbeat and continues without duplicating pending references', async () => {
  const f = discoveryFixture(Array.from({ length: 250 }, (_, i) => message(i + 1, { to: i + 1 === 150 ? me : '' })));
  f.client.supportsPresence = true;
  const ack = vi.spyOn(f.client, 'ack').mockRejectedValueOnce(new RoomError('ROOM_HTTP_503', true, 19000)).mockResolvedValue();
  expect(await f.listener.poll()).toBe(19000);
  expect(f.listener.discoveryState).toEqual({ cursor: 200, pending: [150] });
  expect(f.host.deliver).not.toHaveBeenCalled(); expect(f.listener.delivered).toBe(0);
  await f.listener.poll();
  expect(f.listener.discoveryState).toEqual({ cursor: 250, pending: [150] });
  expect(f.read.mock.calls.map(([after]) => after)).toEqual([0, 100, 0, 200]);
  expect(ack).toHaveBeenLastCalledWith({ fetched: 250, delivered: 0, paused: false }, expect.any(AbortSignal));
  expect(f.host.checkpoint).not.toHaveBeenCalled(); expect(f.host.deliver).toHaveBeenCalledTimes(1);
});
it.each([101, 250, 501])('isolates the host receipt for discovered #%s and restores it without skipping backlog', async target => {
  const messages = Array.from({ length: 550 }, (_, i) => message(i + 1, { to: i + 1 === target ? me : '' }));
  const f = discoveryFixture(messages); f.host.deliverDiscovered = vi.fn();
  for (let i = 0; i < 6; i++) {
    await f.listener.poll();
    if (f.listener.dispatchedSummary) f.listener.acknowledge(100);
    if (vi.mocked(f.host.deliverDiscovered).mock.calls.length) break;
  }
  expect(f.host.deliverDiscovered).toHaveBeenCalledExactlyOnceWith([messages[target - 1]]);
  f.listener.acknowledge(target); f.listener.acknowledgeDiscovered(target + 1);
  expect(f.listener.state).toBe('awaiting-host-receipt'); expect(f.listener.discoveryState.received).toBeUndefined();
  f.listener.acknowledgeDiscovered(target);
  expect(f.listener.discoveryState.received).toEqual([target]); expect(f.listener.discoveryState.pending).toEqual([]);
  expect(f.listener.cursor).toBe(0); expect(f.listener.delivered).toBe(0); expect(f.host.checkpoint).not.toHaveBeenCalled();
  expect(() => f.listener.consume(target, true)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  const restored = new RoomListener(f.client, f.host, 0, 0, 100, undefined, [], undefined, f.listener.discoveryState);
  for (let i = 0; i < 6; i++) await restored.poll();
  expect(f.host.deliverDiscovered).toHaveBeenCalledTimes(1); expect(restored.cursor).toBe(0);
  expect(restored.pendingConsumptionBatch[0]).toBe(1);
});
it('does not redeliver a discovered receipt when ordinary processing reaches it, and retains its consumption order', async () => {
  const messages = Array.from({ length: 122 }, (_, i) => message(i + 1, { to: i + 1 === 101 ? me : '' }));
  const f = discoveryFixture(messages); f.host.deliverDiscovered = vi.fn();
  await f.listener.poll(); f.listener.acknowledgeDiscovered(101);
  expect(f.host.deliverDiscovered).toHaveBeenCalledTimes(1);
  for (let end = 20; end <= 100; end += 20) { await f.listener.poll(false); f.listener.consume(end, true); }
  await f.listener.poll();
  expect(f.listener.cursor).toBe(101); expect(f.listener.pendingConsumptionBatch).toEqual([101]);
  expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith(messages.slice(101), true);
  f.listener.acknowledge(122);
  expect(f.listener.pendingConsumptionBatch).toEqual(Array.from({ length: 20 }, (_, i) => i + 101));
  f.listener.consume(120, true);
  expect(f.listener.pendingConsumptionBatch).toEqual([121, 122]);
  expect(f.host.checkpoint).toHaveBeenLastCalledWith(120, true, Array.from({ length: 20 }, (_, i) => i + 101));
});
it.each([101, 105])('merges sparse receipt #%s into a real ordinary delivery without duplicates or reordering', async target => {
  const messages = Array.from({ length: 112 }, (_, i) => message(i + 1, { to: i + 1 === target ? me : '' }));
  const f = discoveryFixture(messages); f.host.deliverDiscovered = vi.fn();
  await f.listener.poll(); f.listener.acknowledgeDiscovered(target);
  for (let end = 20; end <= 100; end += 20) { await f.listener.poll(false); f.listener.consume(end, true); }
  await f.listener.poll();
  expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith(messages.slice(100).filter(m => m.seq !== target));
  f.listener.acknowledge(112);
  expect(f.listener.delivered).toBe(112);
  expect(f.listener.pendingConsumptionBatch).toEqual(Array.from({ length: 12 }, (_, i) => i + 101));
  f.listener.consume(112, true); expect(f.listener.pendingConsumptionBatch).toEqual([]);
  await f.listener.poll(false); expect(f.listener.pendingConsumptionBatch).toEqual([]);
});
it('counts received references toward the discovery bound and keeps them until processing catches up', async () => {
  const messages = Array.from({ length: 350 }, (_, i) => message(i + 1));
  const f = discoveryFixture(messages); f.host.deliverDiscovered = vi.fn();
  for (let seq = 101; seq <= 200; seq++) { await f.listener.poll(); f.listener.acknowledgeDiscovered(seq); }
  expect(f.listener.discoveryState.received).toHaveLength(100); expect(f.listener.discoveryState.pending).toEqual([]);
  const calls = f.read.mock.calls.length; await f.listener.poll();
  expect(f.read.mock.calls.slice(calls).map(([after]) => after)).toEqual([0]);
  expect(f.listener.discoveryState.cursor).toBe(200); expect(f.listener.cursor).toBe(0);
});
it('keeps discovery pending and stops on an unknown host delivery or missing receipt', async () => {
  vi.useFakeTimers();
  for (const throwing of [false, true]) {
    const f = discoveryFixture(Array.from({ length: 101 }, (_, i) => message(i + 1, { to: i === 100 ? me : '' })));
    f.host.deliverDiscovered = vi.fn(() => { if (throwing) throw Error('unknown'); });
    await f.listener.poll(); await vi.advanceTimersByTimeAsync(20000); await f.listener.poll(); await f.listener.poll();
    expect(f.listener.state).toBe('paused'); expect(f.listener.error).toBe('HOST_DELIVERY_UNKNOWN');
    expect(f.listener.discoveryState.pending).toEqual([101]); expect(f.listener.discoveryState.received).toBeUndefined();
    expect(f.host.deliverDiscovered).toHaveBeenCalledTimes(1); expect(f.host.checkpoint).not.toHaveBeenCalled();
  }
});
it('does not overwrite a durable sparse receipt arriving during the next discovery scan', async () => {
  const messages = Array.from({ length: 350 }, (_, i) => message(i + 1, { to: i + 1 === 101 ? me : '' }));
  const f = discoveryFixture(messages); f.host.deliverDiscovered = vi.fn();
  await f.listener.poll(); expect(f.listener.state).toBe('awaiting-host-receipt');
  const read = f.read.getMockImplementation()!; let resolve!: (page: Snapshot) => void;
  f.read.mockImplementation((...args) => args[0] === 200 ? new Promise(yes => { resolve = yes; }) : read(...args));
  const polling = f.listener.poll(); await vi.waitFor(() => expect(f.read).toHaveBeenCalledWith(200, expect.any(AbortSignal), 99));
  f.listener.acknowledgeDiscovered(101); resolve(await read(200, undefined, 99)); await polling;
  expect(f.listener.discoveryState).toEqual({ cursor: 299, pending: [], received: [101] });
  expect(f.host.deliverDiscovered).toHaveBeenCalledTimes(1); expect(f.listener.cursor).toBe(0); expect(f.listener.delivered).toBe(0);
  expect(f.host.checkpointDiscovery).toHaveBeenLastCalledWith(f.listener.discoveryState);
});
it('preserves the discovery batch on receipt checkpoint failure', async () => {
  const f = discoveryFixture(Array.from({ length: 101 }, (_, i) => message(i + 1, { to: i === 100 ? me : '' })));
  f.host.deliverDiscovered = vi.fn(); await f.listener.poll();
  const saved = f.listener.discoveryState;
  vi.mocked(f.host.checkpointDiscovery!).mockImplementation(() => { throw Error('disk'); });
  expect(() => f.listener.acknowledgeDiscovered(101)).toThrow('CHECKPOINT_FAILED');
  expect(f.listener.state).toBe('paused'); expect(f.listener.discoveryState).toEqual(saved);
  expect(f.listener.cursor).toBe(0); expect(f.listener.delivered).toBe(0);
});
it('revalidates a restored discovery reference and respects the fresh pause before dispatch', async () => {
  const messages = Array.from({ length: 250 }, (_, i) => message(i + 1, { to: i + 1 === 150 ? me : '' }));
  const f = discoveryFixture(messages, { cursor: 250, pending: [150] }); f.host.deliverDiscovered = vi.fn();
  const read = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (...args) => ({ ...await read(...args), aiPaused: args[0] === 149 }));
  await f.listener.poll();
  expect(f.read).toHaveBeenLastCalledWith(149, expect.any(AbortSignal), 1);
  expect(f.listener.state).toBe('room-paused'); expect(f.host.deliverDiscovered).not.toHaveBeenCalled();
  expect(f.listener.discoveryState.pending).toEqual([150]);
});
it.each(['recipient', 'sender', 'removed', 'sequence', 'missing'])('rejects a changed restored discovery %s before dispatch', async fault => {
  const messages = Array.from({ length: 250 }, (_, i) => message(i + 1, { to: '' })); messages[149] = message(150);
  const f = discoveryFixture(messages, { cursor: 250, pending: [150] }); f.host.deliverDiscovered = vi.fn();
  const read = f.read.getMockImplementation()!;
  f.read.mockImplementation(async (...args) => {
    const page = await read(...args); if (args[0] !== 149) return page;
    if (fault === 'missing') return { ...page, messages: [] };
    if (fault === 'removed') return { ...page, members: page.members.map(m => ({ ...m, removed: m.id === peer })) };
    return { ...page, messages: page.messages.map(m => ({ ...m, ...(fault === 'recipient' ? { to: stranger } : fault === 'sender' ? { memberId: me } : { seq: 151 }) })) };
  });
  await f.listener.poll(); expect(f.listener.error).toBe('DISCOVERY_MESSAGE_MISMATCH'); expect(f.listener.state).toBe('paused');
  expect(f.host.deliverDiscovered).not.toHaveBeenCalled(); expect(f.listener.discoveryState.pending).toEqual([150]);
});
it.each(['pause', 'busy'])('does not dispatch after %s during a targeted discovery fetch', async action => {
  const messages = Array.from({ length: 250 }, (_, i) => message(i + 1, { to: i + 1 === 150 ? me : '' }));
  const f = discoveryFixture(messages, { cursor: 250, pending: [150] }); f.host.deliverDiscovered = vi.fn();
  const read = f.read.getMockImplementation()!; let resolve!: (page: Snapshot) => void;
  f.read.mockImplementation((...args) => args[0] === 149 ? new Promise(yes => { resolve = yes; }) : read(...args));
  const polling = f.listener.poll(); await vi.waitFor(() => expect(f.read).toHaveBeenCalledWith(149, expect.any(AbortSignal), 1));
  if (action === 'pause') f.listener.pause(); else vi.mocked(f.host.isIdle).mockReturnValue(false);
  resolve(await read(149)); await polling;
  expect(f.host.deliverDiscovered).not.toHaveBeenCalled(); expect(f.listener.discoveryState.pending).toEqual([150]);
  expect(f.listener.state).toBe(action === 'pause' ? 'paused' : 'waiting-for-idle');
});
it.each([{ cursor: 5, pending: [], received: null }, { cursor: 5, pending: [], received: [0] },
  { cursor: 5, pending: [], received: [6] }, { cursor: 5, pending: [], received: [1, 1] },
  { cursor: 5, pending: [], received: [2, 1] }, { cursor: 5, pending: [1], received: [1] },
  { cursor: 200, pending: [101], received: Array.from({ length: 100 }, (_, i) => i + 1) }])('rejects invalid sparse receipts: %j', value => {
  expect(() => parseDiscoveryState(value)).toThrow('INVALID_DISCOVERY_STATE');
});
it('requires durable discovery checkpoints before enabling page-out delivery', () => {
  const f = fixture(); expect(() => new RoomListener(f.client, { ...f.host, deliverDiscovered: vi.fn() }, 0)).toThrow('DISCOVERY_CHECKPOINT_REQUIRED');
});
it.each([null, {}, { cursor: -1, pending: [] }, { cursor: 1.5, pending: [] }, { cursor: 5, pending: [0] },
  { cursor: 5, pending: [6] }, { cursor: 5, pending: [2, 1] }, { cursor: 5, pending: [1, 1] },
  { cursor: 200, pending: Array.from({ length: 101 }, (_, i) => i + 1) }])('rejects malformed restored discovery state: %j', value => {
  expect(() => parseDiscoveryState(value)).toThrow('INVALID_DISCOVERY_STATE');
});
it('retains host-delivered messages until explicit consumption without rewinding delivery', async () => {
  const f = fixture([message(1), message(2)]); await f.listener.poll(); f.listener.acknowledge(2);
  expect(f.listener.cursor).toBe(2); expect(f.listener.delivered).toBe(2);
  expect(f.listener.pendingConsumptionBatch).toEqual([1, 2]); expect(f.host.checkpoint).toHaveBeenCalledExactlyOnceWith(2);
  f.listener.consume(1); expect(f.host.checkpoint).toHaveBeenLastCalledWith(1, true);
  expect(f.listener.cursor).toBe(2); expect(f.listener.delivered).toBe(2); expect(f.listener.pendingConsumptionBatch).toEqual([2]);
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(1);
  f.listener.consume(2, true); expect(f.host.checkpoint).toHaveBeenLastCalledWith(2, true, [2]);
  expect(f.listener.pendingConsumptionBatch).toEqual([]);
});
it('atomically consumes a prefix crossing delivered and manually read messages', async () => {
  const f = fixture([message(1), message(2)]); await f.listener.poll(); f.listener.acknowledge(2);
  f.read.mockResolvedValue(snapshot([message(3), message(4)], 2)); await f.listener.poll(false);
  expect(f.listener.pendingConsumptionBatch).toEqual([1, 2, 3, 4]);
  f.listener.consume(3, true);
  expect(f.host.checkpoint).toHaveBeenLastCalledWith(3, true, [1, 2, 3]);
  expect(f.listener.cursor).toBe(3); expect(f.listener.delivered).toBe(2);
  expect(f.listener.pendingConsumptionBatch).toEqual([4]);
});
it('can consume an older delivered message while a later automatic batch awaits receipt', async () => {
  const f = fixture([message(1)]); await f.listener.poll(); f.listener.acknowledge(1);
  f.read.mockResolvedValue(snapshot([message(2)], 1)); await f.listener.poll();
  expect(f.listener.pendingConsumptionBatch).toEqual([1]); f.listener.consume(1);
  expect(f.listener.state).toBe('awaiting-host-receipt'); expect(f.listener.pending?.seq).toBe(2);
  expect(() => f.listener.consume(2)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  f.listener.acknowledge(2); expect(f.listener.pendingConsumptionBatch).toEqual([2]);
});
it('preserves delivered progress and pending consumption when its checkpoint fails', async () => {
  const f = fixture([message(1), message(2)]); await f.listener.poll(); f.listener.acknowledge(2);
  vi.mocked(f.host.checkpoint).mockImplementation(() => { throw Error('disk'); });
  expect(() => f.listener.consume(2, true)).toThrow('CHECKPOINT_FAILED');
  expect(f.listener.cursor).toBe(2); expect(f.listener.delivered).toBe(2); expect(f.listener.pendingConsumptionBatch).toEqual([1, 2]);
});
it('restores only the unconsumed delivered prefix and bounds confirmation to twenty messages', async () => {
  const f = fixture([]), pending = Array.from({ length: 25 }, (_, i) => i + 1);
  const listener = new RoomListener(f.client, f.host, 25, 25, 0, undefined, pending);
  expect(listener.pendingConsumptionBatch).toEqual(pending.slice(0, 20));
  expect(() => listener.consume(25, true)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  listener.consume(20, true); expect(listener.pendingConsumptionBatch).toEqual([21, 22, 23, 24, 25]);
  expect(listener.cursor).toBe(25); expect(listener.delivered).toBe(25);
  expect(() => new RoomListener(f.client, f.host, 25, 25, 0, undefined, [2, 1])).toThrow('INVALID_CURSOR');
  expect(() => new RoomListener(f.client, f.host, 25, 25, 0, undefined, [26])).toThrow('INVALID_CURSOR');
});
it('resumes delivery and checkpoints beyond message 500', async () => {
  const { client, host } = fixture([message(502)]);
  const listener = new RoomListener(client, host, 501, 501);
  await listener.poll();
  expect(host.deliver).toHaveBeenCalledWith([message(502)]);
  listener.acknowledge(502);
  expect(listener.cursor).toBe(502);
  expect(host.checkpoint).toHaveBeenCalledWith(502);
  listener.pause();
  expect(() => new RoomListener(client, host, Number.MAX_SAFE_INTEGER + 1)).toThrow('INVALID_CURSOR');
  expect(() => new RoomListener(client, host, 0, 0, -1)).toThrow('INVALID_CURSOR');
});
it('summarizes a large page once without advancing delivery or consumption', async () => {
  const messages = Array.from({ length: 100 }, (_, i) => message(i + 1));
  const f = fixture(messages); f.client.supportsPresence = true;
  const ack = vi.spyOn(f.client, 'ack').mockResolvedValue();
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith(messages, true);
  expect(f.listener.undispatchedBatch).toEqual([]); f.listener.acknowledge(100);
  expect(f.listener.cursor).toBe(0); expect(f.host.checkpoint).not.toHaveBeenCalled();
  await f.listener.poll(); await f.listener.poll();
  expect(f.host.deliver).toHaveBeenCalledTimes(1); expect(f.listener.undispatchedBatch).toEqual(messages.slice(0, 20));
  expect(ack).toHaveBeenLastCalledWith({ fetched: 100, delivered: 0, paused: false }, expect.any(AbortSignal));
  f.listener.consume(20, true); expect(f.listener.cursor).toBe(20);
  expect(f.host.checkpoint).toHaveBeenCalledExactlyOnceWith(20, true, Array.from({ length: 20 }, (_, i) => i + 1));
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(1);
});
it('refreshes only changed backlog ranges after one minute, without acknowledging messages', async () => {
  vi.useFakeTimers();
  const messages = Array.from({ length: 100 }, (_, i) => message(i + 1)), f = fixture(messages);
  await f.listener.poll(); const first = f.listener.dispatchedSummary!; f.listener.acknowledge(100);
  f.read.mockResolvedValue(snapshot(messages.slice(0, 75)));
  vi.advanceTimersByTime(59999); await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1); await f.listener.poll();
  expect(f.host.deliver).toHaveBeenLastCalledWith(messages.slice(0, 75), true);
  expect(f.listener.dispatchedSummary).toEqual({ from: 1, through: 75, count: 75, at: first.at + 60000 });
  f.listener.acknowledge(75); expect(f.listener.cursor).toBe(0); expect(f.listener.delivered).toBe(0);
  expect(f.host.checkpoint).not.toHaveBeenCalled();
  vi.advanceTimersByTime(180000); await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(2);
});
it('refreshes the remaining page after consumption but still delivers small batches immediately', async () => {
  vi.useFakeTimers();
  const messages = Array.from({ length: 50 }, (_, i) => message(i + 1)), f = fixture(messages);
  await f.listener.poll(); f.listener.acknowledge(50);
  await f.listener.poll(false); f.listener.consume(20, true);
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60000); await f.listener.poll();
  expect(f.listener.dispatchedSummary).toMatchObject({ from: 21, through: 50, count: 30 });
  f.listener.acknowledge(50); await f.listener.poll(false); f.listener.consume(40, true);
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenLastCalledWith(messages.slice(40));
  expect(f.listener.cursor).toBe(40); expect(f.listener.delivered).toBe(0);
});
it('does not refresh a summary during pause or busy input, and an unknown refresh is never retried', async () => {
  vi.useFakeTimers();
  const messages = Array.from({ length: 30 }, (_, i) => message(i + 1)), f = fixture(messages);
  await f.listener.poll(); f.listener.acknowledge(30);
  const changed = snapshot(messages.slice(0, 25)); f.read.mockResolvedValue({ ...changed, aiPaused: true });
  vi.advanceTimersByTime(60000); await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(1);
  f.read.mockResolvedValue(changed); vi.mocked(f.host.isIdle).mockReturnValue(false);
  await f.listener.poll(); expect(f.listener.state).toBe('waiting-for-idle'); expect(f.host.deliver).toHaveBeenCalledTimes(1);
  vi.mocked(f.host.isIdle).mockReturnValue(true); await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(20000); await f.listener.poll();
  expect(f.listener.error).toBe('HOST_DELIVERY_UNKNOWN'); expect(f.listener.cursor).toBe(0);
  vi.advanceTimersByTime(60000); await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledTimes(2);
});
it('restores a backlog summary separately from the message cursor', async () => {
  const f = fixture(Array.from({ length: 50 }, (_, i) => message(i + 1)));
  const restored = new RoomListener(f.client, f.host, 0, 0, 50); await restored.poll();
  expect(restored.cursor).toBe(0); expect(f.host.deliver).not.toHaveBeenCalled(); expect(restored.undispatched?.seq).toBe(1);
});
it('keeps a dispatched batch stable until its final sequence is acknowledged', async () => {
  const f = fixture([message(1), message(2)]); await f.listener.poll();
  f.read.mockResolvedValue(snapshot([message(1), message(2), message(3)]));
  f.listener.acknowledge(1); await f.listener.poll();
  expect(f.listener.cursor).toBe(0); expect(f.host.checkpoint).not.toHaveBeenCalled();
  expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith([message(1), message(2)]);
  expect(() => f.listener.consume(1)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  f.listener.acknowledge(2); expect(f.host.checkpoint).toHaveBeenCalledExactlyOnceWith(2);
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenLastCalledWith([message(3)]);
});
it('manual confirmation removes only the first message before automatic batching', async () => {
  const f = fixture([message(1), message(2), message(3)]);
  await f.listener.poll(false); f.listener.consume(1);
  expect(f.listener.pending?.seq).toBe(2); expect(f.listener.cursor).toBe(1);
  await f.listener.poll(); expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith([message(2), message(3)]);
});
it('does not skip an unacknowledged batch across self echoes and removed senders', async () => {
  const f = fixture([message(1), message(2, { memberId: me }), message(3, { memberId: stranger }), message(4)]);
  const page = snapshot([message(1), message(2, { memberId: me }), message(3, { memberId: stranger }), message(4)]);
  page.members[2]!.removed = true; f.read.mockResolvedValue(page);
  await f.listener.poll(); expect(f.listener.cursor).toBe(0);
  expect(f.host.deliver).toHaveBeenCalledExactlyOnceWith([message(1), message(4)]);
  f.listener.acknowledge(1); expect(f.listener.cursor).toBe(0);
  f.listener.acknowledge(4); expect(f.listener.cursor).toBe(4);
});
it('stops if any queued sender is removed, not only the first', async () => {
  const f = fixture([message(1), message(2, { memberId: stranger })]);
  vi.mocked(f.host.isIdle).mockReturnValue(false); await f.listener.poll();
  const page = snapshot([message(1), message(2, { memberId: stranger })]); page.members[2]!.removed = true;
  f.read.mockResolvedValue(page); vi.mocked(f.host.isIdle).mockReturnValue(true); await f.listener.poll();
  expect(f.listener.error).toBe('SENDER_REMOVED'); expect(f.listener.cursor).toBe(0); expect(f.host.deliver).not.toHaveBeenCalled();
});
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
it('delivers all active members’ room messages without a sender list or mention, but skips self echoes', async () => {
  const messages = [message(1, { memberId: me }), message(2, { memberId: stranger, to: '' }), message(3, { to: '' }), message(4, { to: stranger }), message(5)];
  const { listener, host } = fixture(messages);
  vi.mocked(host.deliver).mockImplementation(batch => listener.acknowledge(batch.at(-1)!.seq));
  for (let i = 0; i < 5; i++) await listener.poll();
  expect(vi.mocked(host.deliver).mock.calls.map(([batch]) => batch)).toEqual([messages.slice(1)]);
  expect(listener.cursor).toBe(5);
});
it('does not deliver messages from removed members', async () => {
  const { listener, host, read } = fixture();
  const changed = snapshot([message(1, { memberId: stranger, to: '' }), message(2)]); changed.members[2]!.removed = true; read.mockResolvedValue(changed);
  await listener.poll(); expect(host.deliver).toHaveBeenCalledExactlyOnceWith([message(2)]); expect(listener.cursor).toBe(1);
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
    const { listener, host, read } = fixture(Array.from({ length: 100 }, (_, i) => message(i + 1)));
    read.mockImplementation(async after => snapshot(Array.from({ length: Math.min(20, 100 - after) }, (_, i) => message(after + i + 1)), after));
    vi.mocked(host.deliver).mockImplementation(batch => listener.acknowledge(batch.at(-1)!.seq));
    for (let i = 0; i < 100; i++) { vi.advanceTimersByTime(60000); await listener.poll(); }
    expect(host.deliver).toHaveBeenCalledTimes(5); expect(listener.cursor).toBe(100); expect(listener.state).toBe('listening');
    expect(vi.mocked(host.deliver).mock.calls.flatMap(([batch]) => batch.map(m => m.seq))).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    listener.pause(); await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(5);
  } finally { vi.useRealTimers(); }
});
it('recovers from transient failure without requiring user renewal', async () => {
  const { listener, host, read } = fixture();
  read.mockRejectedValueOnce(new RoomError('NETWORK_RESULT_UNKNOWN', true));
  await listener.poll(); await listener.poll(); expect(host.deliver).toHaveBeenCalledTimes(1);
});
it('manual reads and consumption share the room inbox without starting a turn', async () => {
  const { listener, host } = fixture([message(1, { memberId: me }), message(2, { memberId: stranger, to: '' }), message(3)]);
  await listener.poll(false); expect(listener.undispatched?.seq).toBe(2); expect(listener.cursor).toBe(1); expect(host.deliver).not.toHaveBeenCalled();
  expect(() => listener.consume(3)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
  listener.consume(2); expect(host.checkpoint).toHaveBeenCalledWith(2, true);
  await listener.poll(); expect(host.deliver).toHaveBeenCalledExactlyOnceWith([message(3)]);
  expect(() => listener.consume(3)).toThrow('NEXT_UNDISPATCHED_MESSAGE_REQUIRED');
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
it('reports fetched separately from persisted host delivery, even while busy', async () => {
  const { listener, host, client } = fixture([message(1), message(2)]);
  client.supportsPresence = true; const ack = vi.spyOn(client, 'ack').mockResolvedValue();
  vi.mocked(host.isIdle).mockReturnValue(false); await listener.poll();
  expect(ack).toHaveBeenLastCalledWith({ fetched: 2, delivered: 0, paused: false }, expect.any(AbortSignal));
  vi.mocked(host.isIdle).mockReturnValue(true); await listener.poll();
  await listener.poll(); expect(ack).toHaveBeenLastCalledWith({ fetched: 2, delivered: 0, paused: false }, expect.any(AbortSignal));
  listener.acknowledge(1); expect(listener.cursor).toBe(0);
  listener.acknowledge(2); await listener.poll();
  expect(ack).toHaveBeenLastCalledWith({ fetched: 2, delivered: 2, paused: false }, expect.any(AbortSignal));
  expect(host.deliver).toHaveBeenCalledExactlyOnceWith([message(1), message(2)]);
});
it('manual reads and consumption do not advertise background presence or automatic delivery', async () => {
  const { listener, client } = fixture(); client.supportsPresence = true;
  const ack = vi.spyOn(client, 'ack').mockResolvedValue();
  await listener.poll(false); listener.consume(1); expect(ack).not.toHaveBeenCalled();
  await listener.poll(); expect(ack).toHaveBeenLastCalledWith({ fetched: 1, delivered: 0, paused: false }, expect.any(AbortSignal));
  listener.pause(); await listener.poll(); expect(ack).toHaveBeenCalledTimes(1);
});
it('keeps old relays working and reports owner pause without starting a model', async () => {
  const { listener, client, read, host } = fixture(); const ack = vi.spyOn(client, 'ack').mockResolvedValue();
  await listener.poll(); expect(ack).not.toHaveBeenCalled();
  listener.acknowledge(1); client.supportsPresence = true;
  read.mockResolvedValue({ ...snapshot([], 1), aiPaused: true }); await listener.poll();
  expect(ack).toHaveBeenLastCalledWith({ fetched: 1, delivered: 1, paused: true }, expect.any(AbortSignal));
  expect(host.deliver).toHaveBeenCalledTimes(1);
});
it('backs off failed heartbeats without advancing delivery or bypassing cancellation', async () => {
  const { listener, client, host } = fixture(); client.supportsPresence = true;
  const ack = vi.spyOn(client, 'ack').mockRejectedValueOnce(new RoomError('ROOM_HTTP_429', true, 60000)).mockResolvedValue();
  expect(await listener.poll()).toBe(60000); expect(listener.cursor).toBe(0); expect(host.deliver).not.toHaveBeenCalled();
  let resolve!: () => void; ack.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  const running = listener.poll(); await Promise.resolve(); listener.pause(); resolve(); await running;
  expect(host.deliver).not.toHaveBeenCalled();
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
