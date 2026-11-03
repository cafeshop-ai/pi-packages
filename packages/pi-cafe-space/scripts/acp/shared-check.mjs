#!/usr/bin/env node
// Diagnostic only: existing daemon metadata, never thread/read, resume, prompt or approvals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, on } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const READ_ONLY_REQUESTS = Object.freeze(['initialize', 'thread/loaded/list']);

export function loadedIds(response) {
  assert(response && Array.isArray(response.data), 'Expected loaded thread IDs');
  assert(response.data.length <= 20 && response.data.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128), 'Invalid loaded thread IDs');
  return { ids: [...new Set(response.data)].sort(), more: response.nextCursor != null };
}

export async function inspectConnection({ reader, writer }, label, onRequest = () => {}) {
  let nextId = 0;
  async function request(method, params) {
    assert(READ_ONLY_REQUESTS.includes(method), 'Mutation or history request forbidden');
    const id = ++nextId;
    onRequest(method);
    await writer.write({ id, method, params });
    for (let count = 0; count < 200; count++) {
      const { value, done } = await reader.read();
      assert(!done, 'Proxy closed before response');
      // Do not answer an unexpected approval/auth request for somebody else's session.
      assert(!(value.method && value.id != null), 'Unexpected server request; disconnecting');
      if (value.id !== id) continue; // Notifications are neither retained nor rendered.
      assert(!value.error, `Metadata request failed (${Number.isInteger(value.error?.code) ? value.error.code : 'unknown'})`);
      return value.result;
    }
    throw new Error('Too many unrelated notifications');
  }
  const initialized = await request('initialize', {
    clientInfo: { name: `cafe_space_readonly_${label}`, version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  await writer.write({ method: 'initialized', params: {} });
  const loaded = loadedIds(await request('thread/loaded/list', { limit: 20 }));
  return { ...loaded, serverVersion: /\b\d+\.\d+\.\d+\b/.exec(initialized?.userAgent ?? '')?.[0] ?? 'unknown' };
}

export function connectProxy(child) {
  const duplex = Duplex.from({ readable: child.stdout, writable: child.stdin });
  // The native proxy carries raw socket bytes. The daemon requires a WebSocket upgrade.
  // This URL is not dialled: createConnection returns our local proxy, with a fixed safe path.
  const ws = new WebSocket('ws://cafe-space-local.invalid/', {
    createConnection: () => duplex, perMessageDeflate: false, maxPayload: 1024 * 1024,
  });
  const messages = on(ws, 'message', { close: ['close'], highWaterMark: 16, lowWaterMark: 4 });
  return {
    ws, messages,
    reader: { async read() {
      const { value, done } = await messages.next();
      if (done) return { done: true };
      assert(!value[1], 'Unexpected binary frame');
      let message;
      try { message = JSON.parse(value[0].toString('utf8')); }
      catch { throw new Error('Invalid RPC JSON'); } // Never put a private frame excerpt in an error.
      assert(message && typeof message === 'object' && !Array.isArray(message), 'Invalid RPC frame');
      return { value: message, done: false };
    } },
    writer: { write(message) { return new Promise((resolveWrite, reject) => {
      ws.send(JSON.stringify(message), error => error ? reject(error) : resolveWrite());
    }); } },
  };
}

export async function checkShared({ codex, socket, timeoutMs = 15_000 }) {
  assert(isAbsolute(codex) && isAbsolute(socket), 'Absolute native executable/socket paths required');
  const children = [];
  const inspect = async label => {
    // proxy only connects to the specified existing endpoint; never starts the daemon.
    const child = spawn(codex, ['app-server', 'proxy', '--sock', socket], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
    children.push(child);
    const progress = { lastRequest: 'spawn', stdoutBytes: 0 };
    child.stdout.on('data', data => { progress.stdoutBytes += data.length; });
    child.stdin.on('error', () => {});
    const ended = new Promise(resolveExit => { child.once('close', resolveExit); child.once('error', resolveExit); });
    let transport, timer;
    try {
      await once(child, 'spawn');
      transport = connectProxy(child);
      progress.lastRequest = 'websocket-upgrade';
      return await Promise.race([
        (async () => {
          await once(transport.ws, 'open');
          return inspectConnection(transport, label, method => { progress.lastRequest = method; });
        })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Read-only probe timed out: ${JSON.stringify(progress)}`)), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
      transport?.ws.terminate();
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill(); // Only our proxy PID, not the daemon.
      await ended;
      await transport?.messages.return().catch(() => {});
    }
  };
  // Both are independent clients of the same endpoint, with no subscription or turn mutation.
  const results = await Promise.allSettled([inspect('a'), inspect('b')]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  const [a, b] = results.map(result => result.value);
  return {
    mode: 'existing-daemon-metadata-only', promptAttempts: 0, historyRequests: 0,
    threadMutations: 0, serverVersions: [a.serverVersion, b.serverVersion],
    loadedThreadIds: a.ids, bothClientsAgree: JSON.stringify(a.ids) === JSON.stringify(b.ids),
    more: a.more || b.more, sharedTurnControl: 'not-tested', acpAttachment: 'not-tested',
    ownedProxiesClosed: children.every(child => child.exitCode !== null || child.signalCode !== null),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: {
    codex: { type: 'string' }, socket: { type: 'string' },
  }, strict: true });
  for (const key of ['codex', 'socket']) assert(values[key] && isAbsolute(values[key]), `--${key} requires an absolute path`);
  try {
    console.log(JSON.stringify(await checkShared({ codex: values.codex, socket: values.socket }), null, 2));
  } catch (error) {
    console.log(JSON.stringify({ mode: 'existing-daemon-metadata-only', promptAttempts: 0, historyRequests: 0, passed: false, error: error.message }));
    process.exitCode = 1;
  }
}
