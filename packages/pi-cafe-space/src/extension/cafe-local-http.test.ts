import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspectCafe, type CafeConfig } from './cafe-client.js';

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => { s.closeAllConnections(); s.close(() => resolve()); }))); });
const metadata = { protocolVersion: 1, roomId: 'main', name: 'Test office', online: true, activeInstances: 1, currentPiInRoom: true, visitorRole: 'operator' };
const capabilities = { protocolVersion: 1, roomShare: true, terminalShare: true };
const json = (res: ServerResponse, value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<CafeConfig> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { relayUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`, roomId: 'main', peerId: 'test-pi', token: 'synthetic-host-only', credentialsFile: null };
}
it('local status ignores global fetch/proxy and never mutates it', async () => {
  const globalFetch = vi.fn(() => { throw Error('Global fetch must not handle local IPC'); }); vi.stubGlobal('fetch', globalFetch);
  vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:1'); vi.stubEnv('http_proxy', 'http://127.0.0.1:1');
  const calls: string[] = [];
  const config = await fixture((req, res) => {
    calls.push(req.url!);
    if (req.url === '/api/config') { expect(req.headers.authorization).toBeUndefined(); json(res, capabilities); }
    else { expect(req.headers.authorization).toBe('Bearer synthetic-host-only'); expect(req.headers.origin).toBeUndefined(); json(res, metadata); }
  });
  const result = await inspectCafe(config, false);
  expect(result).toMatchObject({ state: 'ready', currentPiInRoom: true, activeInstances: 1 }); expect(result.url).toBeUndefined();
  expect(calls).toEqual(['/api/config', '/api/room/terminal']); expect(globalFetch).not.toHaveBeenCalled(); expect(globalThis.fetch).toBe(globalFetch); expect(process.env.HTTP_PROXY).toBe('http://127.0.0.1:1');
  expect((await inspectCafe({ ...config, relayUrl: config.relayUrl.replace('127.0.0.1', 'localhost') }, false)).state).toBe('ready');
});
it('never follows a redirect or transfers the local credential to its target', async () => {
  let targetCalls = 0;
  const target = await fixture((_req, res) => { targetCalls++; json(res, metadata); });
  const config = await fixture((req, res) => { if (req.url === '/api/config') json(res, capabilities); else { res.writeHead(307, { Location: target.relayUrl.replace('ws:', 'http:') }); res.end(); } });
  expect((await inspectCafe(config, false)).state).toBe('gateway-error'); expect(targetCalls).toBe(0);
});
it.each(['invalid-json', 'html', 'oversized', 'server-error', 'truncated'])('classifies %s as response error rather than offline', async kind => {
  const config = await fixture((req, res) => {
    if (req.url === '/api/config') { json(res, capabilities); return; }
    if (kind === 'html') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>not the gateway</h1>'); return; }
    if (kind === 'server-error') { res.writeHead(503); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    if (kind === 'invalid-json') res.end('{bad');
    else if (kind === 'oversized') { res.write(' '.repeat(8192)); res.end('{}'); }
    else { res.setHeader('Content-Length', '500'); res.end('{}'); }
  });
  expect((await inspectCafe(config, false)).state).toBe('gateway-error');
});
it.each([401, 403])('keeps %s as an authentication error', async code => {
  const config = await fixture((req, res) => { if (req.url === '/api/config') json(res, capabilities); else { res.writeHead(code); res.end(); } });
  expect((await inspectCafe(config, false)).state).toBe('auth-error');
});
it('only a refused connection produces gateway-offline', async () => {
  const config = await fixture((_req, res) => json(res, capabilities));
  const server = servers.pop()!; await new Promise<void>(resolve => server.close(() => resolve()));
  expect((await inspectCafe(config, false)).state).toBe('gateway-offline');
});
it('deadline aborts a stalled local response and reports timeout', async () => {
  const config = await fixture(() => {});
  expect((await inspectCafe(config, false)).state).toBe('gateway-timeout');
}, 6000);
it('caller cancellation aborts without becoming a misleading offline state', async () => {
  const cancel = new AbortController();
  const config = await fixture(() => cancel.abort());
  await expect(inspectCafe(config, false, cancel.signal)).rejects.toThrow('CANCELLED');
});
it('nonlocal endpoints are rejected before any network call', async () => {
  let calls = 0; const config = await fixture(() => { calls++; });
  expect((await inspectCafe({ ...config, relayUrl: 'wss://example.invalid/ws' }, false)).state).toBe('not-local');
  expect(calls).toBe(0);
});
