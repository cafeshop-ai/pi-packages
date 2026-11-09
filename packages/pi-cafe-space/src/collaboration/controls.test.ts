import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { captureControls, controlReceipt, newControlState } from './controls.js';
import { RoomListener, type ListenerHost } from './listener.js';
import { RoomClient, type Snapshot } from './client.js';

const me = 'a'.repeat(32), peer = 'b'.repeat(32);
const page = (): Snapshot => ({ roomId: 'c'.repeat(32), memberId: me, cursor: 0, more: false, messages: [],
  members: [me, peer].map(id => ({ id, name: id, kind: 'ai', removed: false })), tasks: [], waitingOnYou: [], aiPaused: false });

it('uses every shared fixture for control deltas without message events', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../protocol/fixtures/listener/events.json', import.meta.url), 'utf8'));
  for (const c of fixture.cases) {
    const initial = { ...newControlState(), seen: c.input.seen, goalConsumed: c.input.goalConsumed ?? 0 };
    const state = captureControls(initial, c.input.page, c.me);
    expect(state.pending.flatMap(batch => batch.events), c.name).toEqual(c.events.filter((e: any) => e.type !== 'msg' && e.type !== 'backlog'));
    expect(state.seen, c.name).toEqual(c.seenAfter);
    expect(initial.seen).toEqual(c.input.seen);
  }
});
it('persists distinct bounded batches while the host is busy, and keeps the dispatched batch stable', () => {
  const initial = page(); let state = captureControls(newControlState(), initial, me);
  const changed = { ...initial, tasks: Array.from({ length: 45 }, (_, i) => ({ id: i + 1, title: 'Task', status: 'todo' as const })) };
  state = captureControls(state, changed, me);
  expect(state.pending.map(batch => batch.events.length)).toEqual([20, 20, 5]);
  const first = structuredClone(state.pending[0]!);
  state = captureControls(state, { ...changed, tasks: [] }, me);
  expect(state.pending[0]).toEqual(first);
  expect(() => controlReceipt(state, { ...first, events: [] })).toThrow('CONTROL_RECEIPT_MISMATCH');
  expect(controlReceipt(state, first).pending).toEqual(state.pending.slice(1));
});
function listenerFixture() {
  const client = new RoomClient({ origin: 'https://example.test', roomId: 'c'.repeat(32), memberId: me, token: 'd'.repeat(64) });
  const read = vi.spyOn(client, 'read').mockResolvedValue(page());
  const host: ListenerHost = { isIdle: vi.fn(() => true), deliver: vi.fn(), checkpoint: vi.fn(), deliverControls: vi.fn(), checkpointControls: vi.fn() };
  const listener = new RoomListener(client, host, 0);
  return { client, host, read, listener };
}
it('delivers waiting and member/task changes at cursor zero with a separate durable receipt', async () => {
  const f = listenerFixture(); await f.listener.poll();
  const changed = page(); changed.tasks = [{ id: 1, title: 'Task', status: 'doing' }]; changed.waitingOnYou = [peer];
  f.read.mockResolvedValue(changed); await f.listener.poll();
  const batch = f.listener.controlState.pending[0]!;
  expect(batch.events.map(e => e.type)).toEqual(['task', 'waiting']);
  expect(f.host.deliverControls).toHaveBeenCalledExactlyOnceWith(batch);
  await f.listener.poll(); expect(f.host.deliverControls).toHaveBeenCalledTimes(1);
  f.listener.acknowledge(batch.id); expect(f.listener.controlState.pending).toHaveLength(1);
  f.listener.acknowledgeControls(batch); await f.listener.poll();
  expect(f.listener.cursor).toBe(0); expect(f.host.checkpoint).not.toHaveBeenCalled();
  expect(f.host.deliver).not.toHaveBeenCalled(); expect(f.listener.controlState.pending).toEqual([]);
  expect(f.host.checkpointControls).toHaveBeenCalled();
});
it('keeps pause changes for resume without new turns during the pause', async () => {
  const f = listenerFixture(); await f.listener.poll();
  f.read.mockResolvedValue({ ...page(), aiPaused: true }); await f.listener.poll();
  expect(f.listener.state).toBe('room-paused'); expect(f.host.deliverControls).not.toHaveBeenCalled();
  f.read.mockResolvedValue(page()); await f.listener.poll();
  expect(f.listener.controlState.pending.flatMap(batch => batch.events)).toEqual([{ type: 'pause', paused: true }, { type: 'pause', paused: false }]);
  expect(f.host.deliverControls).toHaveBeenCalledTimes(1);
});
it('requires explicit delivered Goal confirmation, separate from host delivery and skip', async () => {
  const f = listenerFixture(); f.read.mockResolvedValue({ ...page(), goalRevision: 1, goal: null });
  await f.listener.poll(); const batch = f.listener.controlState.pending[0]!;
  expect(() => f.listener.consumeGoal(1)).toThrow('DELIVERED_GOAL_REQUIRED');
  expect(controlReceipt(f.listener.controlState, batch, true).goalDelivered).toEqual([]);
  f.listener.acknowledgeControls(batch);
  expect(f.listener.controlState.goalConsumed).toBe(0); f.listener.consumeGoal(1);
  expect(f.listener.controlState.goalConsumed).toBe(1); f.listener.consumeGoal(1);
  expect(() => f.listener.consumeGoal(2)).toThrow('DELIVERED_GOAL_REQUIRED');
  expect(f.listener.cursor).toBe(0); expect(f.host.checkpoint).not.toHaveBeenCalled();
});
it('restores unreceived control events and does not rediscover already observed changes', async () => {
  const f = listenerFixture(); f.read.mockResolvedValue({ ...page(), waitingOnYou: [peer] }); await f.listener.poll(false);
  const saved = f.listener.controlState;
  const restored = new RoomListener(f.client, f.host, 0, 0, 0, saved); await restored.poll();
  expect(f.host.deliverControls).toHaveBeenCalledExactlyOnceWith(saved.pending[0]);
  restored.acknowledgeControls(saved.pending[0]!);
  const again = new RoomListener(f.client, f.host, 0, 0, 0, restored.controlState); await again.poll();
  expect(f.host.deliverControls).toHaveBeenCalledTimes(1);
});
it('requires durable control checkpoints and preserves a batch when receipt persistence fails', async () => {
  const f = listenerFixture();
  expect(() => new RoomListener(f.client, { ...f.host, checkpointControls: undefined }, 0)).toThrow('CONTROL_CHECKPOINT_REQUIRED');
  f.read.mockResolvedValue({ ...page(), waitingOnYou: [peer] }); await f.listener.poll();
  const batch = f.listener.controlState.pending[0]!;
  vi.mocked(f.host.checkpointControls!).mockImplementation(() => { throw Error('disk'); });
  expect(() => f.listener.acknowledgeControls(batch)).toThrow('CHECKPOINT_FAILED');
  expect(f.listener.controlState.pending).toEqual([batch]); expect(f.listener.state).toBe('paused');
  expect(f.listener.cursor).toBe(0);
});
it('fails closed on control persistence or unknown injection without advancing message progress', async () => {
  const f = listenerFixture(); f.read.mockResolvedValue({ ...page(), waitingOnYou: [peer] });
  vi.mocked(f.host.checkpointControls!).mockImplementation(() => { throw Error('disk'); }); await f.listener.poll();
  expect(f.listener.state).toBe('paused'); expect(f.listener.error).toBe('CHECKPOINT_FAILED');
  expect(f.host.deliverControls).not.toHaveBeenCalled(); expect(f.listener.controlState.pending).toEqual([]);
  const g = listenerFixture(); g.read.mockResolvedValue({ ...page(), waitingOnYou: [peer] });
  vi.mocked(g.host.deliverControls!).mockImplementation(() => { throw Error('unknown'); }); await g.listener.poll(); await g.listener.poll();
  expect(g.listener.state).toBe('paused'); expect(g.listener.error).toBe('HOST_DELIVERY_UNKNOWN');
  expect(g.host.deliverControls).toHaveBeenCalledTimes(1); expect(g.listener.cursor).toBe(0);
});
