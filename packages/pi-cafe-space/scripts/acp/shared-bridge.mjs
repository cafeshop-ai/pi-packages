#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { open, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectProxy } from './shared-check.mjs';
import { SharedPolicy } from './shared-policy.mjs';

export async function runSharedBridge({ codex, socket, threadId, promptBudget = 0, reportPath, input = process.stdin, output = process.stdout }) {
  assert(isAbsolute(codex) && isAbsolute(socket), 'Absolute native binary and socket required');
  const policy = new SharedPolicy({ threadId, promptBudget });
  const child = spawn(codex, ['app-server', 'proxy', '--sock', socket], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
  child.stdin.on('error', () => {});
  const ended = new Promise(resolveExit => { child.once('close', resolveExit); child.once('error', resolveExit); });
  let transport, stopped = false, rpcId = 0;
  const pending = new Map();
  const send = value => new Promise((resolveWrite, reject) => output.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolveWrite()));
  const request = async (method, params) => {
    const id = `cafe-bridge-${++rpcId}`;
    let timer;
    try {
      return await new Promise((resolveReply, reject) => {
        timer = setTimeout(() => { pending.delete(id); reject(new Error('Shared metadata timed out')); }, 15000);
        pending.set(id, { resolve: resolveReply, reject });
        transport.writer.write({ id, method, params }).catch(reject);
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  };
  const stop = () => {
    if (stopped) return; stopped = true;
    for (const waiter of pending.values()) waiter.reject(new Error('Shared connection closed'));
    transport?.ws.terminate();
    input.destroy();
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill(); // Proxy only; never daemon.
  };
  const signalHandler = () => stop();
  process.once('SIGTERM', signalHandler);
  let incoming;
  try {
    await once(child, 'spawn');
    transport = connectProxy(child);
    const deadline = setTimeout(stop, 15000);
    try { await once(transport.ws, 'open'); } finally { clearTimeout(deadline); }
    incoming = (async () => {
      for (;;) {
        const { value, done } = await transport.reader.read();
        if (done) break;
        const waiter = pending.get(value.id);
        if (waiter) {
          if (value.error) waiter.reject(new Error('Shared metadata request rejected'));
          else waiter.resolve(value.result);
        } else {
          const safe = policy.server(value);
          if (safe) await send(safe);
        }
      }
    })();
    incoming.catch(stop);
    // Bound line length before JSON parsing; do not expose malformed private input in errors.
    let bytes = 0;
    input.on('data', chunk => {
      for (const byte of chunk) { if (byte === 10) bytes = 0; else if (++bytes > 65536) { stop(); break; } }
    });
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (stopped) break;
      let message;
      try { message = JSON.parse(line); } catch { throw new Error('Invalid client RPC JSON'); }
      let safe;
      try { safe = policy.client(message); }
      catch {
        if (message.id != null) await send({ id: message.id, error: { code: -32601, message: 'Borrowed session operation refused' } });
        continue;
      }
      if (safe.method === 'thread/resume' || safe.method === 'turn/start') {
        // Refuse to load a stored conversation or silently steer somebody else's running turn.
        const { thread } = await request('thread/read', { threadId, includeTurns: false });
        assert.equal(thread.id, threadId);
        assert(thread.status.type !== 'notLoaded', 'Target no longer loaded');
        if (safe.method === 'thread/resume') assert(thread.status.type === 'idle', 'Borrowed session is active; no attach performed');
        if (safe.method === 'turn/start' && thread.status.type !== 'idle') {
          await send({ id: safe.id, error: { code: -32000, message: 'Shared session busy; no implicit steering' } });
          continue;
        }
        if (safe.method === 'turn/start' && reportPath) {
          // Persist before sending: a crashed or unknown attempt cannot be replayed by rerunning.
          const file = await open(reportPath + '.prompt-attempt', 'wx', 0o600);
          try { await file.writeFile('{"promptAttempts":1,"automaticRetries":0}\n'); } finally { await file.close(); }
        }
      }
      await transport.writer.write(safe);
    }
  } finally {
    stop();
    await ended;
    await incoming?.catch(() => {});
    await transport?.messages.return().catch(() => {});
    process.off('SIGTERM', signalHandler);
    if (reportPath) await writeFile(reportPath, JSON.stringify({ ...policy.stats, proxyClosed: true }, null, 2) + '\n', { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], 'app-server');
  try {
    await runSharedBridge({ codex: process.env.CAFE_SHARED_CODEX, socket: process.env.CAFE_SHARED_SOCKET,
      threadId: process.env.CAFE_SHARED_THREAD, promptBudget: process.env.CAFE_SHARED_BUDGET === 'unlimited' ? null : Number(process.env.CAFE_SHARED_BUDGET ?? 0), reportPath: process.env.CAFE_SHARED_REPORT });
  } catch { process.exitCode = 1; } // No private server data or errors printed.
}
