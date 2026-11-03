import assert from 'node:assert/strict';
import test from 'node:test';
import { AcpAdapter } from './adapter.mjs';

function fixture({ request, ...options } = {}) {
  const calls = [], notifications = [], handlers = new Map(), events = [];
  let disconnect, closeCount = 0;
  const connection = {
    closed: new Promise(resolve => { disconnect = resolve; }),
    close() { closeCount++; disconnect(); },
    agent: {
      async request(method, params, opts) {
        calls.push({ method, params, signal: opts?.signal });
        if (request) { const value = request(method, params, opts); if (value !== undefined) return value; }
        if (method === 'initialize') return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
        if (method === 'session/new') return { sessionId: 'owned' };
        if (method === 'session/prompt') return { stopReason: 'end_turn' };
        return {};
      },
      async notify(method, params) { notifications.push({ method, params }); },
    },
  };
  const builder = {
    onRequest(method, handler) { handlers.set(method, handler); return this; },
    onNotification(method, handler) { handlers.set(method, handler); return this; },
    connect() { return connection; },
  };
  const adapter = new AcpAdapter({ sdk: { client: () => builder }, transport: {}, onEvent: e => events.push(e), ...options });
  return { adapter, calls, notifications, handlers, events, disconnect, get closeCount() { return closeCount; } };
}
async function ready(f) { await f.adapter.initialize(); await f.adapter.create('/temporary-empty-project'); }

test('default mode has zero prompts and advertises no client file/terminal access', async () => {
  const f = fixture(); await ready(f);
  assert.deepEqual(f.calls[0].params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  await assert.rejects(f.adapter.prompt('hello'), /budget/);
  assert.equal(f.adapter.promptAttempts, 0);
  assert(!f.calls.some(c => c.method === 'session/prompt'));
  f.adapter.close();
});

test('budget is bounded and consumed before sending; no automatic retry', async () => {
  assert.throws(() => fixture({ promptBudget: 3 }), /budget/);
  assert.throws(() => fixture({ promptBudget: -1 }), /budget/);
  const f = fixture({ promptBudget: 1, request: method => {
    if (method === 'session/prompt') throw new Error('lost response');
  } });
  await ready(f);
  await assert.rejects(f.adapter.prompt('hello'), /lost response/);
  assert.equal(f.adapter.promptAttempts, 1);
  assert.equal(f.adapter.state, 'unknown');
  await assert.rejects(f.adapter.prompt('retry'), /unknown/);
  assert.equal(f.calls.filter(c => c.method === 'session/prompt').length, 1);
  f.adapter.close();
});

test('successful turns exhaust budget and invalid input does not consume it', async () => {
  const f = fixture({ promptBudget: 1 }); await ready(f);
  await assert.rejects(f.adapter.prompt(''), /Invalid prompt/);
  assert.equal(f.adapter.promptAttempts, 0);
  assert.deepEqual(await f.adapter.prompt('hello'), { stopReason: 'end_turn' });
  assert.equal(f.adapter.state, 'idle');
  await assert.rejects(f.adapter.prompt('again'), /budget/);
  f.adapter.close();
});

test('filters other sessions and late events; permissions are always denied', async () => {
  const f = fixture(); await ready(f);
  const emit = (sessionId, update) => f.handlers.get('session/update')({ params: { sessionId, update } });
  const chunk = { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } };
  emit('foreign', chunk); assert.equal(f.events.length, 0);
  emit('owned', chunk); assert.deepEqual(f.events, [{ type: 'text', sessionId: 'owned', text: 'ok' }]);
  const denied = f.handlers.get('session/request_permission')({ params: { sessionId: 'foreign' } });
  assert.deepEqual(denied, { outcome: { outcome: 'cancelled' } });
  assert(!f.handlers.has('fs/read_text_file'));
  assert(!f.handlers.has('terminal/create'));
  f.adapter.close(); emit('owned', chunk); assert.equal(f.events.length, 1);
});

test('history restoration is not advertised as live sharing; replay is session-scoped', async () => {
  let f;
  f = fixture({ request: (method, params) => {
    if (method === 'session/load') {
      f.handlers.get('session/update')({ params: { sessionId: params.sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' },
      } } });
      return {};
    }
  } });
  await f.adapter.initialize();
  assert.deepEqual(f.adapter.capabilities, { restoreHistory: true, sharedLiveSession: false });
  await f.adapter.restore('owned', '/temporary-empty-project');
  assert.equal(f.events[0].text, 'history'); assert.equal(f.adapter.state, 'idle');
  assert(!f.calls.some(c => c.method === 'session/new'));
  f.adapter.close();
});

test('unsupported restore rejects locally without silently creating a session', async () => {
  const f = fixture({ request: method => method === 'initialize' ? { protocolVersion: 1 } : undefined });
  await f.adapter.initialize();
  await assert.rejects(f.adapter.restore('owned', '/tmp'), /not supported/);
  assert.equal(f.calls.length, 1); f.adapter.close();
});

test('rejects unsupported protocol and closes only its connection', async () => {
  const f = fixture({ request: method => method === 'initialize' ? { protocolVersion: 2 } : undefined });
  await assert.rejects(f.adapter.initialize(), /Unsupported/);
  f.adapter.close(); assert.equal(f.closeCount, 1);
  assert.deepEqual(f.calls.map(c => c.method), ['initialize']);
});

test('cancellation is not completion; concurrent prompts are rejected', async () => {
  let finish;
  const f = fixture({ promptBudget: 2, request: method => method === 'session/prompt'
    ? new Promise(resolve => { finish = resolve; }) : undefined });
  await ready(f);
  const pending = f.adapter.prompt('hello');
  await assert.rejects(f.adapter.prompt('concurrent'), /running/);
  await f.adapter.cancel(); await f.adapter.cancel();
  assert.equal(f.adapter.state, 'cancelling'); assert.equal(f.notifications.length, 1);
  finish({ stopReason: 'cancelled' });
  assert.equal((await pending).stopReason, 'cancelled'); assert.equal(f.adapter.state, 'idle');
  f.adapter.close();
});

test('disconnect and late success cannot revive a closed or unknown adapter', async () => {
  let finish;
  const f = fixture({ promptBudget: 1, request: method => method === 'session/prompt'
    ? new Promise(resolve => { finish = resolve; }) : undefined });
  await ready(f);
  const pending = f.adapter.prompt('hello');
  f.disconnect(); await Promise.resolve();
  assert.equal(f.adapter.state, 'unknown');
  finish({ stopReason: 'end_turn' });
  await assert.rejects(pending, /unknown/);
  f.adapter.close(); assert.equal(f.adapter.state, 'closed');
});

test('managed prompts can outlive lifecycle timeout and remain cancellable', async () => {
 let finish;
 const f=fixture({promptBudget:null,timeoutMs:10,promptTimeoutMs:null,request:method=>method==='session/prompt'?new Promise(resolve=>{finish=resolve;}):undefined});
 try {
  await ready(f);const pending=f.adapter.prompt('long offline turn');
  assert(f.calls[0].signal instanceof AbortSignal);assert(f.calls[1].signal instanceof AbortSignal);
  assert.equal(f.calls.at(-1).signal,undefined);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(f.adapter.state,'running');
  await f.adapter.cancel();finish({stopReason:'cancelled'});
  assert.equal((await pending).stopReason,'cancelled');assert.equal(f.notifications.length,1);
 } finally {f.adapter.close();}
});

test('prompt timeout defaults stay bounded for prototypes and reject invalid overrides', async () => {
 for(const promptTimeoutMs of [0,-1,1.5,Infinity]) assert.throws(()=>fixture({promptTimeoutMs}),/timeout/i);
 const f=fixture({promptBudget:1,timeoutMs:100});
 try {await ready(f);await f.adapter.prompt('offline');assert(f.calls.at(-1).signal instanceof AbortSignal);} finally {f.adapter.close();}
});

test('request timeout is passed to SDK and leaves outcome unknown', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  const f = fixture({ timeoutMs: 10, request: (_method, _params, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  try {
    await assert.rejects(f.adapter.initialize(), { name: 'TimeoutError' });
    assert.equal(f.adapter.state, 'unknown'); assert.equal(f.calls.length, 1);
  } finally { clearTimeout(keepAlive); f.adapter.close(); }
});
