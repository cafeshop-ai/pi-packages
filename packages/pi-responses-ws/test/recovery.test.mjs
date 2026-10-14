import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { ResponsesTransport } from '../src/transport.ts';
import { context, opts, modelFor, reply, server, nextContext, collect } from './helpers.mjs';

function manager(t, { now = Date.now, wait = async () => {}, ...policy } = {}) {
  const transport = new ResponsesTransport(now, wait, { random: () => 0, ...policy });
  t.after(() => transport.clear());
  return transport;
}
const rejection = (code, extra = {}) => ({ type: 'error', status: 400, error: { code, message: 'private-server-text' }, ...extra });

for (const mode of ['auto', 'websocket', 'websocket-cached']) test(`${mode}: 426 falls back immediately and respects the existing cooldown`, async t => {
  let now = 0;
  const s = await server(t), waits = [], m = manager(t, { now: () => now, wait: async ms => waits.push(ms) });
  s.rejectUpgrade(426);
  const model = modelFor(s.baseUrl), options = opts({ transport: mode });
  assert.equal((await m.stream(model, context(), options).result()).stopReason, 'stop');
  assert.equal(s.handshakes.length, 1); assert.equal(s.requests.length, 1); assert.equal(s.requests[0].transport, 'sse');
  assert.equal(s.warmups.length, 0); assert.deepEqual(waits, []);
  assert.equal(m.snapshot('fixture-session').lastReason, 'upgrade_required_sse');
  s.rejectUpgrade(0);
  await m.stream(model, context(), options).result(); assert.equal(s.handshakes.length, 1);
  now = 300001;
  await m.stream(model, context(), options).result(); assert.equal(s.handshakes.length, 2);
  assert.equal(s.requests.at(-1).transport, 'websocket'); assert.equal(s.requests.at(-1).body.previous_response_id, undefined);
});

for (const placement of ['nested', 'flat', 'after-created']) test(`expired connection: ${placement} error creates a fresh socket and sends full input`, async t => {
  const s = await server(t, (_body, r) => {
    if (r.n !== 2) return reply(r.n);
    const error = placement === 'flat' ? { type: 'error', code: 'websocket_connection_limit_reached' } : rejection('websocket_connection_limit_reached');
    return placement === 'after-created' ? [reply(r.n)[0], error] : [error];
  }), m = manager(t), model = modelFor(s.baseUrl), ctx = context();
  const first = await m.stream(model, ctx, opts()).result();
  const second = await collect(m.stream(model, nextContext(ctx, first), opts()));
  assert.equal(second.output.stopReason, 'stop', second.output.errorMessage);
  assert.equal(s.handshakes.length, 2); assert.equal(s.requests.length, 3);
  assert.equal(s.requests[1].body.previous_response_id, 'resp_1'); assert.equal(s.requests[2].body.previous_response_id, undefined);
  assert.ok(s.requests[2].body.input.length > s.requests[1].body.input.length);
  assert.equal(second.events.filter(e => e.type === 'start').length, 1);
});

test('repeated connection-expired errors consume the same five retries, then one SSE', async t => {
  const waits = [], s = await server(t, (_body, r) => r.transport === 'sse' ? reply(r.n) : [rejection('websocket_connection_limit_reached')]);
  const m = manager(t, { wait: async ms => waits.push(ms) });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.equal(s.handshakes.length, 6); assert.equal(s.requests.length, 7); assert.equal(s.warmups.length, 1);
  assert.deepEqual(waits, [200, 400, 800, 1600, 3200]); assert.equal(s.requests.at(-1).transport, 'sse');
});

for (const kind of ['caller id', 'no local delta', 'rejected full replay', 'message-only']) test(`missing response recovery boundary: ${kind}`, async t => {
  const s = await server(t, (_body, r) => {
    if (kind === 'rejected full replay' && r.n === 1) return reply(r.n);
    return kind === 'message-only' ? [{ type: 'error', code: 'unknown', message: 'previous_response_not_found' }] : [rejection('previous_response_not_found')];
  }), m = manager(t), model = modelFor(s.baseUrl);
  const options = opts(kind === 'caller id' ? { onPayload: body => ({ ...body, previous_response_id: 'caller-owned' }) } : {});
  let ctx = context();
  if (kind === 'rejected full replay') ctx = nextContext(ctx, await m.stream(model, ctx, options).result());
  const result = await m.stream(model, ctx, options).result();
  assert.equal(result.stopReason, 'error'); assert.equal(s.requests.length, kind === 'rejected full replay' ? 3 : 1);
  assert.equal(s.handshakes.length, kind === 'rejected full replay' ? 2 : 1);
  assert.ok(s.requests.every(r => r.transport === 'websocket'));
  if (kind === 'caller id') { assert.equal(s.requests[0].body.previous_response_id, 'caller-owned'); assert.equal(s.warmups.length, 0); }
});

for (const [headers, expected] of [
  [{ 'Retry-After': '1.25' }, 1250],
  [{ 'retry-after-ms': '42.5', 'retry-after': '9' }, 43],
  [{ 'Retry-After': 'Wed, 01 Jan 2025 00:00:02 GMT' }, 2000],
  [{ 'retry-after': '-10' }, 200],
  [{ 'retry-after': '1oops' }, 200],
  [{ 'retry-after-ms': 'NaN', 'retry-after': '0.5' }, 500],
]) test(`handshake Retry-After: ${JSON.stringify(headers)}`, async t => {
  const s = await server(t), delays = [];
  s.rejectUpgrade(503, headers);
  const m = manager(t, { now: () => Date.UTC(2025, 0, 1), wait: async ms => { delays.push(ms); s.rejectUpgrade(0); } });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.deepEqual(delays, [expected]); assert.equal(s.handshakes.length, 2);
  assert.equal(m.snapshot('fixture-session').lastRetryDelayMs, expected);
});

for (const nested of [true, false]) test(`wrapped error Retry-After, nested=${nested}`, async t => {
  const headers = { 'Retry-After-Ms': '750' }, waits = [];
  const s = await server(t, (_body, r) => r.n === 1 ? [nested
    ? rejection('websocket_connection_limit_reached', { error: { code: 'websocket_connection_limit_reached', headers } })
    : rejection('websocket_connection_limit_reached', { headers })] : reply(r.n));
  const m = manager(t, { wait: async ms => waits.push(ms) });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.deepEqual(waits, [750]); assert.equal(s.handshakes.length, 2);
});

test('retry jitter uses the exponential base without modifying server minimum delays', async t => {
  const s = await server(t), delays = [];
  s.rejectUpgrade(503);
  const m = manager(t, { random: () => 0.5, wait: async ms => { delays.push(ms); if (delays.length === 2) s.rejectUpgrade(0); } });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.deepEqual(delays, [210, 420]);
});

for (const [value, cap] of [['61', undefined], ['2', 1000], ['2147484', 0]]) test(`server retry delay exceeding safe cap fails, not shortened or bypassed: ${value}`, async t => {
  const s = await server(t), delays = [], m = manager(t, { wait: async ms => delays.push(ms) });
  s.rejectUpgrade(503, { 'Retry-After': value });
  const result = await m.stream(modelFor(s.baseUrl), context(), opts({ maxRetryDelayMs: cap })).result();
  assert.equal(result.stopReason, 'error'); assert.match(result.errorMessage, /retry_delay_exceeded/);
  assert.equal(s.handshakes.length, 1); assert.equal(s.requests.length, 0); assert.deepEqual(delays, []);
});

test('last failed attempt honors Retry-After before SSE fallback', async t => {
  const s = await server(t), delays = [], m = manager(t, { wait: async ms => delays.push(ms) });
  s.rejectUpgrade(503, { 'Retry-After': '2' });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.equal(s.handshakes.length, 6); assert.deepEqual(delays, [2000, 2000, 2000, 2000, 2000, 2000]);
  assert.equal(s.requests.length, 1); assert.equal(s.requests[0].transport, 'sse');
});

test('abort while honoring a server retry delay prevents retries and SSE', async t => {
  const s = await server(t), controller = new AbortController();
  s.rejectUpgrade(503, { 'Retry-After': '10' });
  const m = manager(t, { wait: (ms, signal) => { controller.abort(); return sleep(ms, undefined, { signal }); } });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts({ signal: controller.signal })).result()).stopReason, 'aborted');
  assert.equal(s.handshakes.length, 1); assert.equal(s.requests.length, 0);
});

for (const mode of ['auto', 'websocket', 'websocket-cached']) test(`${mode}: automatic cold-connection warmup precedes generation, without injecting history or hooks`, async t => {
  let completed = false, payloads = 0, responses = 0, events = 0;
  const s = await server(t, (_body, r) => { assert.equal(completed, true); return reply(r.n); }, async body => {
    assert.deepEqual(body.input, []); assert.equal(body.generate, false); assert.equal(body.store, false);
    assert.equal(body.reasoning.effort, 'high'); assert.equal(body.client_metadata.session_id, 'fixture-session');
    assert.equal(body.previous_response_id, undefined); assert.equal(body.stream, undefined);
    await sleep(10); completed = true; return reply('warmup-only', { empty: true });
  }), m = manager(t), model = modelFor(s.baseUrl), ctx = context();
  const options = opts({ transport: mode, reasoningEffort: 'high', onPayload: () => { payloads++; }, onResponse: () => { responses++; }, onProviderStreamEvent: () => { events++; } });
  const first = await m.stream(model, ctx, options, false).result();
  assert.equal(first.stopReason, 'stop', first.errorMessage); assert.equal(first.responseId, 'resp_1'); assert.equal(first.usage.totalTokens, 14);
  assert.equal(s.requests[0].body.previous_response_id, undefined); assert.ok(s.requests[0].body.input.length > 0);
  const second = await m.stream(model, nextContext(ctx, first), options, false).result();
  assert.equal(second.stopReason, 'stop'); assert.equal(s.handshakes.length, 1); assert.equal(s.warmups.length, 1);
  assert.equal(s.warmups[0].ws, s.requests[0].ws); assert.equal(s.requests[0].ws, s.requests[1].ws);
  assert.equal(s.requests[1].body.previous_response_id, mode === 'websocket' ? undefined : 'resp_1');
  assert.equal(payloads, 2); assert.equal(responses, 2); assert.equal(events, 10);
  const status = m.snapshot('fixture-session'); assert.equal(status.warmupRequests, 1); assert.equal(status.warmupsCompleted, 1); assert.equal(status.lastWarmup, 'completed');
  assert.equal(status.lastWs.eventsReceived, 5); assert.equal(status.lastWs.lastEvent, 'response.completed');
});

for (const kind of ['rejected', 'disconnect', 'generates text', 'generates tool', 'incomplete', 'missing output']) test(`failed optional warmup: ${kind}, fresh full generation and no leaked tool/output`, async t => {
  const s = await server(t, undefined, (_body, r) => {
    if (kind === 'rejected') return [rejection('unsupported_value')];
    if (kind === 'disconnect') { r.ws.terminate(); return []; }
    if (kind === 'generates text') return reply('unwanted');
    if (kind === 'generates tool') return reply('unwanted', { tool: true });
    if (kind === 'incomplete') return [{ type: 'response.incomplete', response: { id: 'unwanted', status: 'incomplete' } }];
    return [{ type: 'response.completed', response: { id: 'unwanted', status: 'completed' } }];
  }), m = manager(t);
  const result = await collect(m.stream(modelFor(s.baseUrl), context(), opts()));
  assert.equal(result.output.stopReason, 'stop', result.output.errorMessage);
  assert.equal(s.warmups.length, 1); assert.equal(s.handshakes.length, 2); assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].body.previous_response_id, undefined); assert.equal(result.output.responseId, 'resp_1');
  assert.ok(!result.events.some(e => e.type.startsWith('toolcall')));
  assert.equal(result.events.filter(e => e.type === 'start').length, 1);
  assert.equal(m.snapshot('fixture-session').lastWarmup, 'failed'); assert.equal(m.snapshot('fixture-session').warmupsCompleted, 0);
});

for (const action of ['abort', 'clear']) test(`${action} during warmup closes resources and never sends generation`, async t => {
  const controller = new AbortController(); let m;
  const s = await server(t, undefined, () => { if (action === 'abort') controller.abort(); else m.clear('fixture-session'); return []; });
  m = manager(t);
  const output = await m.stream(modelFor(s.baseUrl), context(), opts({ signal: controller.signal })).result();
  assert.equal(output.stopReason, 'aborted'); assert.equal(s.warmups.length, 1); assert.equal(s.requests.length, 0); assert.equal(s.handshakes.length, 1);
  assert.equal(m.snapshot('fixture-session').activeConnections, 0);
});

for (const kind of ['sse', 'no session', 'no cache', 'custom fetch', 'diagnostic']) test(`warmup is skipped: ${kind}`, async t => {
  const s = await server(t), m = manager(t, { prewarm: kind !== 'diagnostic' });
  const extra = kind === 'sse' ? { transport: 'sse' } : kind === 'no session' ? { sessionId: undefined }
    : kind === 'no cache' ? { cacheRetention: 'none' } : kind === 'custom fetch' ? { transport: 'auto', fetch: globalThis.fetch } : {};
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts(extra)).result()).stopReason, 'stop');
  assert.equal(s.warmups.length, 0); assert.equal(s.requests.length, 1);
  assert.equal(s.handshakes.length, ['sse', 'custom fetch'].includes(kind) ? 0 : 1);
});

for (const code of ['invalid_api_key', 'insufficient_quota', 'rate_limit_exceeded']) test(`warmup ${code} remains terminal, no blind generation replay`, async t => {
  const s = await server(t, undefined, () => [rejection(code)]), waits = [], m = manager(t, { wait: async ms => waits.push(ms) });
  const result = await m.stream(modelFor(s.baseUrl), context(), opts()).result();
  assert.equal(result.stopReason, 'error'); assert.equal(s.handshakes.length, 1); assert.equal(s.requests.length, 0);
  assert.equal(s.warmups.length, 1); assert.deepEqual(waits, []);
  const status = m.snapshot('fixture-session'); assert.equal(status.lastWs.phase, 'warmup'); assert.equal(status.lastWs.requestSent, true);
  assert.equal(status.lastWs.providerCode, code); assert.equal(status.activeConnections, 0);
  assert.ok(!JSON.stringify({ result, status }).includes('private-server-text'));
});

test('warmup error Retry-After is retained before attempting normal generation', async t => {
  const s = await server(t, undefined, () => [rejection('unsupported_value', { headers: { 'Retry-After': '2' } })]);
  const waits = [], m = manager(t, { wait: async ms => waits.push(ms) });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.deepEqual(waits, [2000]); assert.equal(s.warmups.length, 1); assert.equal(s.requests.length, 1);
});

test('warmup deadline is total, even when the server keeps sending nonterminal events', { timeout: 8000 }, async t => {
  const s = await server(t, undefined, (_body, r) => {
    const timer = setInterval(() => { if (r.ws.readyState === 1) r.ws.send(JSON.stringify(reply('warm')[0])); }, 50);
    r.ws.once('close', () => clearInterval(timer)); t.after(() => clearInterval(timer)); return [];
  }), m = manager(t);
  const start = performance.now();
  const result = await m.stream(modelFor(s.baseUrl), context(), opts({ timeoutMs: 10000 })).result();
  assert.equal(result.stopReason, 'stop', result.errorMessage); assert.ok(performance.now() - start < 7000);
  assert.equal(s.warmups.length, 1); assert.equal(s.handshakes.length, 2); assert.equal(s.requests.length, 1);
});

test('cold connections after age expiry, model switch, and cleanup each warm once with their own identity', async t => {
  let now = 0;
  const s = await server(t), m = manager(t, { now: () => now }), model = modelFor(s.baseUrl);
  await m.stream(model, context(), opts()).result(); now += 56 * 60000;
  await m.stream(model, context(), opts()).result();
  await m.stream({ ...model, id: 'alternate-model' }, context(), opts({ apiKey: 'alternate-key' })).result();
  m.clear('fixture-session'); await m.stream(model, context(), opts()).result();
  assert.equal(s.warmups.length, 4); assert.equal(s.handshakes.length, 4);
  assert.equal(s.warmups[2].body.model, 'alternate-model'); assert.equal(s.warmups[2].headers.authorization, 'Bearer alternate-key');
  for (let i = 0; i < 4; i++) assert.equal(s.warmups[i].ws, s.requests[i].ws);
});

for (const status of [401, 403, 429]) test(`warmup HTTP-like ${status} remains terminal even with an unknown error code`, async t => {
  const s = await server(t, undefined, () => [rejection('unknown', { status_code: status, status: undefined })]), m = manager(t);
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'error');
  assert.equal(s.handshakes.length, 1); assert.equal(s.requests.length, 0); assert.equal(s.warmups.length, 1);
});

test('warmup failures and subsequent generation failures share one retry budget', async t => {
  const s = await server(t, (_body, r) => { if (r.transport === 'sse') return reply(r.n); r.ws.terminate(); return []; }, () => [rejection('unsupported_value')]);
  const waits = [], m = manager(t, { wait: async ms => waits.push(ms) });
  assert.equal((await m.stream(modelFor(s.baseUrl), context(), opts()).result()).stopReason, 'stop');
  assert.equal(s.handshakes.length, 6); assert.equal(s.warmups.length, 1); assert.equal(s.requests.length, 6);
  assert.equal(s.requests.at(-1).transport, 'sse'); assert.deepEqual(waits, [200, 400, 800, 1600, 3200]);
});
