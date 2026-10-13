import { expect, it, vi } from 'vitest';
import { AppOwner } from './owner';
import { RelayClient, type SocketLike } from '../services/relay/RelayClient';
import { createRelayStorage } from '../services/relay/storage';
class Socket implements SocketLike {
  readyState = 1; bufferedAmount = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null;
  frames: string[] = []; send = (value: string) => this.frames.push(value); close = vi.fn();
  emit(message: object) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
it('has an inert constructor, owns one client, ingests before Gateway, and clears credentials on auth failure/logout', async () => {
  const socket = new Socket(); const factory = vi.fn(() => socket);
  const storage = createRelayStorage(() => { throw Error('no storage'); });
  const client = new RelayClient({ origin: 'http://localhost', socketFactory: factory });
  const config = vi.fn(async () => ({ protocolVersion: 1 as const, wsPath: '/ws' as const, defaultRoom: 'main' }));
  const owner = new AppOwner({ client, storage, http: { config } });
  expect(factory).not.toHaveBeenCalled();
  try {
    await owner.initialize(); owner.login('secret-test', 'main'); socket.onopen?.();
    expect(factory).toHaveBeenCalledOnce(); expect(JSON.parse(socket.frames[0]!).token).toBe('secret-test');
    expect(JSON.stringify(owner.store.getSnapshot())).not.toContain('secret-test');
    socket.emit({ type: 'error', code: 'UNAUTHORIZED', message: 'no' });
    expect(storage.get('token')).toBeNull();
    expect(owner.store.getSnapshot().connection.status).toBe('auth-failed');
    owner.login('corrected', 'main'); owner.logout();
    expect(storage.get('token')).toBeNull(); expect(owner.gateway.stats().count).toBe(0);
  } finally { owner.dispose(); }
  expect(socket.onmessage).toBeNull();
});
it('does not connect with cached credentials before first-time setup', async () => {
  const factory = vi.fn(() => new Socket());
  const storage = createRelayStorage(() => { throw Error('isolated'); });
  storage.set('token', 'local-dev-client-token');
  const owner = new AppOwner({ client: new RelayClient({ origin: 'http://localhost', socketFactory: factory }), storage, http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'main', setupRequired: true }) } });
  try {
    expect(await owner.initialize()).toMatchObject({ setupRequired: true });
    expect(factory).not.toHaveBeenCalled();
    expect(() => owner.login('cached', 'main')).toThrow('CONFIG_UNAVAILABLE');
  } finally { owner.dispose(); }
});
it('never auto-selects an ambiguous inventory without a saved or explicit host', async () => {
  const socket = new Socket();
  const owner = new AppOwner({ client: new RelayClient({ origin: 'http://localhost', socketFactory: () => socket }), storage: createRelayStorage(() => { throw Error(); }), http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'main' }) } });
  try {
    await owner.initialize(); owner.login('test', 'main'); socket.onopen?.(); socket.emit({ type: 'welcome', protocolVersion: 1, connectionId: 'c', peerRole: 'client', roomId: 'main', hostConnected: true });
    const hosts = ['a', 'b'].map(hostId => ({ hostId, connected: true, ready: false, streamId: null, sessionId: null, cwd: null, sessionName: null }));
    socket.emit({ type: 'host_status', hostId: 'a', connected: true, streamId: null, sessionId: null, hosts });
    expect(owner.store.getSnapshot().selectedHostId).toBeNull();
    owner.selectHost('b'); expect(owner.storage.get('host')).toBe('b');
    socket.emit({ type: 'host_status', hostId: 'a', connected: true, streamId: null, sessionId: null, hosts });
    expect(owner.store.getSnapshot().selectedHostId).toBe('b');
  } finally { owner.dispose(); }
});
