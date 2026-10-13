import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RelayClient, type SocketLike, type RelayEvent } from './RelayClient';
class FakeSocket implements SocketLike {
    readyState = 0;
    bufferedAmount = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: {
        data: unknown;
    }) => void) | null = null;
    send(value: string) { this.sent.push(value); }
    close() { this.readyState = 3; }
    open() { this.readyState = 1; this.onopen?.(); }
    message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const welcome = { type: 'welcome', protocolVersion: 1, connectionId: 'conn', peerRole: 'client', roomId: 'main', hostConnected: false };
const credentials = { token: 'secret', roomId: 'main', peerId: 'browser' };
function setup() { const sockets: FakeSocket[] = []; const urls: string[] = []; const events: RelayEvent[] = []; const client = new RelayClient({ origin: 'https://example.test', socketFactory: url => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; } }); client.subscribe(e => events.push(e)); return { client, sockets, urls, events }; }
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('starts once, authenticates only on welcome, sends token only in hello', () => {
    const { client, sockets, urls, events } = setup();
    expect(sockets).toHaveLength(0);
    client.start(credentials);
    client.start(credentials);
    expect(sockets).toHaveLength(1);
    sockets[0]!.open();
    expect(client.getState().status).toBe('authenticating');
    expect(urls).toEqual(['wss://example.test/ws']);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ type: 'hello', token: 'secret' });
    sockets[0]!.message(welcome);
    expect(client.getState().status).toBe('authenticated');
    expect(JSON.stringify(events)).not.toContain('secret');
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
});
it('invalidates old callbacks across stop/start, resync and room changes', () => {
    const { client, sockets } = setup();
    client.start(credentials);
    const old = sockets[0]!;
    const callbacks = { open: old.onopen, message: old.onmessage, close: old.onclose };
    client.stop();
    client.start({ ...credentials, roomId: 'other' });
    callbacks.open?.();
    callbacks.message?.({ data: JSON.stringify(welcome) });
    callbacks.close?.();
    expect(client.getState().status).toBe('connecting');
    expect(old.sent).toHaveLength(0);
    sockets[1]!.open();
    sockets[1]!.message({ ...welcome, roomId: 'other' });
    expect(client.getState().status).toBe('authenticated');
    const g = client.getState().generation;
    client.resync();
    expect(client.getState().generation).toBeGreaterThan(g);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
});
it('stops automatic retry on invalid credentials until explicit corrected start', () => {
    const { client, sockets } = setup();
    client.start(credentials);
    sockets[0]!.open();
    sockets[0]!.message({ type: 'error', code: 'UNAUTHORIZED', message: 'Invalid credentials' });
    vi.advanceTimersByTime(60000);
    expect(sockets).toHaveLength(1);
    expect(client.getState().status).toBe('auth-failed');
    client.resync();
    expect(sockets).toHaveLength(1);
    client.start({ ...credentials, token: 'correct' });
    expect(sockets).toHaveLength(2);
    client.stop();
});
it('bounds backoff, hello deadline and rejects malformed/binary/oversize/unexpected frames', () => {
    for (const data of ['{', new ArrayBuffer(3), 'x'.repeat(262145), '😀'.repeat(65537), JSON.stringify({ type: 'command', requestId: 'x', expectedStreamId: 's', payload: { name: 'abort' } })]) {
        const { client, sockets } = setup();
        client.start(credentials);
        sockets[0]!.open();
        sockets[0]!.message(welcome);
        sockets[0]!.onmessage?.({ data });
        expect(client.getState().status).toBe('reconnecting');
        vi.advanceTimersByTime(500);
        expect(sockets).toHaveLength(2);
        client.stop();
        expect(vi.getTimerCount()).toBe(0);
    }
    const { client, sockets } = setup();
    client.start(credentials);
    vi.advanceTimersByTime(5000);
    expect(client.getState().status).toBe('reconnecting');
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(2);
    client.stop();
});
it('does not queue/replay writes and requires current generation plus authentication', () => {
    const { client, sockets } = setup();
    const command = { type: 'command' as const, requestId: 'r', expectedStreamId: 's', payload: { name: 'abort' as const } };
    client.start(credentials);
    expect(() => client.sendCommand(command, client.getState().generation)).toThrow();
    sockets[0]!.open();
    sockets[0]!.message(welcome);
    const g = client.getState().generation;
    client.sendCommand(command, g);
    client.resync();
    expect(() => client.sendCommand(command, g)).toThrow();
    sockets[1]!.open();
    sockets[1]!.message(welcome);
    expect(sockets[1]!.sent).toHaveLength(1);
    client.stop();
});
it('rejects foreign origins and credentials in socket endpoint configuration', () => {
    for (const origin of ['file:///tmp', 'https://user:pass@a.test', 'https://a.test/path', 'https://a.test/?token=x'])
        expect(() => new RelayClient({ origin })).toThrow();
});
it('bounds backoff and notices and respects stop during state notification', () => {
    const { client, sockets, events } = setup();
    client.start(credentials);
    for (const delay of [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
        const count = sockets.length;
        sockets.at(-1)!.onerror?.();
        vi.advanceTimersByTime(delay - 1);
        expect(sockets).toHaveLength(count);
        vi.advanceTimersByTime(1);
        expect(sockets).toHaveLength(count + 1);
    }
    expect(events.filter(e => e.kind === 'notice').length).toBeLessThan(8);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
    const next = setup();
    next.client.subscribe(e => { if (e.kind === 'state' && e.state.status === 'connecting')
        next.client.stop(); });
    next.client.start(credentials);
    expect(next.sockets).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
});
