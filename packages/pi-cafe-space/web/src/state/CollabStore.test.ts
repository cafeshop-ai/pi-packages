import { expect, it, vi } from 'vitest';
import { CollabStore } from './CollabStore';
import { compactSnapshot } from './compactSnapshot';
import { scopeKey } from './CollabStore';
import type { SessionSnapshot, WireMessage } from '../../../src/protocol/index';
export const snapshot = (id = 'a'): SessionSnapshot => ({ protocolVersion: 1, streamId: 'stream-' + id, sessionId: 'same', sessionName: null, cwd: 'C:/project', activeLeafId: null, model: null, thinkingLevel: 'off', phase: 'idle', hasPendingMessages: false, messages: [], tools: [], historyTruncated: false, lastEventSeq: 0 });
export function readyStore() {
    const resync = vi.fn();
    const store = new CollabStore(resync);
    store.ingest({ kind: 'state', generation: 1, state: { generation: 1, status: 'authenticated', roomId: 'main' } });
    const emit = (message: WireMessage) => store.ingest({ kind: 'message', message, generation: 1 });
    emit({ type: 'host_status', connected: true, streamId: 'stream-a', sessionId: 'same', hosts: ['a', 'b'].map(id => ({ hostId: id, connected: true, ready: true, streamId: 'stream-' + id, sessionId: 'same', sessionName: null, cwd: 'C:/project' })) });
    for (const id of ['a', 'b'])
        emit({ type: 'snapshot', hostId: id, snapshot: snapshot(id) });
    return { store, emit, resync };
}
it('preserves host B references and ingests every event before coalescing React notifications', async () => {
    const { store, emit } = readyStore();
    const b = store.getSnapshot().hosts.get('b');
    const notify = vi.fn();
    store.subscribe(notify);
    await Promise.resolve();
    notify.mockClear();
    emit({ type: 'event', hostId: 'a', streamId: 'stream-a', sessionId: 'same', seq: 1, emittedAt: 'now', event: { kind: 'message_started', message: { id: 'm', role: 'assistant', text: '', thinking: '', timestamp: 1, status: 'streaming', toolCallId: null, toolName: null } } });
    for (let seq = 2; seq <= 4; seq++)
        emit({ type: 'event', hostId: 'a', streamId: 'stream-a', sessionId: 'same', seq, emittedAt: 'now', event: { kind: 'message_delta', messageId: 'm', channel: 'text', delta: String(seq) } });
    expect(store.getSnapshot().hosts.get('a')!.snapshot!.lastEventSeq).toBe(4);
    expect(store.getSnapshot().hosts.get('a')!.snapshot!.messages[0]!.text).toBe('234');
    expect(store.getSnapshot().hosts.get('b')).toBe(b);
    expect(notify).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(notify).toHaveBeenCalledTimes(1);
    store.dispose();
});
it('gates divergent/unknown hosts and clears context on room/generation changes', () => {
    const { store, emit, resync } = readyStore();
    const view = store.getSnapshot().viewGeneration;
    store.selectHost('b');
    expect(store.getSnapshot().viewGeneration).toBeGreaterThan(view);
    emit({ type: 'event', hostId: 'a', streamId: 'stream-a', sessionId: 'same', seq: 4, emittedAt: 'now', event: { kind: 'notice', level: 'info', message: 'gap' } });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().hosts.get('a')!.stale).toBe(true);
    store.ingest({ kind: 'state', generation: 2, state: { generation: 2, status: 'connecting', roomId: 'other' } });
    expect(store.getSnapshot().hosts.size).toBe(0);
    emit({ type: 'snapshot', hostId: 'a', snapshot: snapshot() });
    expect(store.getSnapshot().hosts.size).toBe(0);
    store.dispose();
});
it('keeps scope keys unambiguous and does not clear isRunning on a dispatched receipt', () => {
    expect(scopeKey({ roomId: 'a:b', hostId: 'c', streamId: 's', sessionId: 'd', cwd: 'e' })).not.toBe(scopeKey({ roomId: 'a', hostId: 'b:c', streamId: 's', sessionId: 'd', cwd: 'e' }));
    const { store, emit } = readyStore();
    emit({ type: 'event', hostId: 'a', streamId: 'stream-a', sessionId: 'same', seq: 1, emittedAt: 'now', event: { kind: 'session_state', phase: 'running', hasPendingMessages: false } });
    emit({ type: 'command_result', hostId: 'a', requestId: 'r', status: 'dispatched', code: null, message: null });
    expect(store.getSnapshot().hosts.get('a')!.snapshot!.phase).toBe('running');
    store.dispose();
});
it('bounds messages/tools, notices and envelope bytes while retaining exact fences', () => {
    const message = { id: 'm', role: 'assistant' as const, text: '😀'.repeat(32768), thinking: '', timestamp: 1, status: 'complete' as const, toolName: null, toolCallId: null };
    const value = { ...snapshot(), messages: Array.from({ length: 101 }, (_, i) => ({ ...message, id: String(i) })), tools: [] };
    const compact = compactSnapshot(value, 'a');
    expect(compact.messages.length).toBeLessThanOrEqual(100);
    expect(compact.historyTruncated).toBe(true);
    expect(compact.cwd).toBe(value.cwd);
    expect(new TextEncoder().encode(JSON.stringify({ type: 'snapshot', hostId: 'a', snapshot: compact })).length).toBeLessThanOrEqual(261120);
    const { store } = readyStore();
    for (let i = 0; i < 110; i++)
        store.notice('N', 'x'.repeat(3000));
    expect(store.getSnapshot().notices).toHaveLength(100);
    expect(store.getSnapshot().notices[0]!.text).toHaveLength(2048);
    store.dispose();
});
it('uses a single count/byte bounded history LRU and clears it at logout', () => {
    const { store } = readyStore();
    const scope = store.scope()!, view = store.getSnapshot().viewGeneration;
    for (let i = 0; i < 20; i++)
        expect(store.commit(scope, view, 'session', { kind: 'session', id: String(i) }, String(i))).toBe(true);
    store.cachedHistory('0');
    store.commit(scope, view, 'session', {}, '20');
    expect(store.getSnapshot().history.size).toBe(20);
    expect(store.getSnapshot().history.has('0')).toBe(true);
    expect(store.getSnapshot().history.has('1')).toBe(false);
    for (let i = 21; i < 44; i++)
        store.commit(scope, view, 'session', { content: 'x'.repeat(240000) }, String(i));
    expect(store.getSnapshot().historyBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(store.getSnapshot().history.size).toBeLessThan(20);
    store.ingest({ kind: 'state', generation: 2, state: { status: 'stopped', generation: 2, roomId: null } });
    expect(store.getSnapshot().history.size).toBe(0);
    expect(store.getSnapshot().historyBytes).toBe(0);
    store.dispose();
});
it('keeps legacy host inventory and restores readiness from an authoritative snapshot', () => {
    const store = new CollabStore(vi.fn());
    store.ingest({ kind: 'state', generation: 1, state: { status: 'authenticated', generation: 1, roomId: 'main' } });
    store.ingest({ kind: 'message', generation: 1, message: { type: 'host_status', connected: true, sessionId: 'same', streamId: 'stream-a' } });
    store.ingest({ kind: 'message', generation: 1, message: { type: 'snapshot', snapshot: snapshot() } });
    expect(store.scope()?.hostId).toBe('legacy');
    expect(store.getSnapshot().hosts.get('legacy')!.info.ready).toBe(true);
    store.dispose();
});
