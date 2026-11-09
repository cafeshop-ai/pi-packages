#!/usr/bin/env node
// Actual Pi SDK + source extension + loopback HTTP; synthetic providers only, no user resources.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { 'pi-root': { type: 'string' }, extension: { type: 'string' } }, strict: true });
const extensionPath = values.extension ? resolve(values.extension) : fileURLToPath(new URL('../src/collaboration/extension.ts', import.meta.url));
const piRoot = await realpath(values['pi-root'] ?? fileURLToPath(new URL('../../../node_modules/@earendil-works/pi-coding-agent/', import.meta.url)));
const root = await mkdtemp(join(tmpdir(), 'cafe collaboration native-'));
const nativeFetch = globalThis.fetch, sessions = [], messages = [], modelCalls = [], errors = [];
let origin, blockedNetwork = 0, httpRequests = 0;
const presence = {}, acknowledgements = [], requests = [0, 0];
const pageOutTargets = [], shownPageOut = [];
const controls = { tasks: [], waitingOnYou: [], aiPaused: false };
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  if (!origin || url !== origin + '/api/collaboration') { blockedNetwork++; throw Error('Non-fixture network forbidden'); }
  httpRequests++; return nativeFetch(input, init);
};
const ids = ['a'.repeat(32), 'b'.repeat(32)], tokens = ['c'.repeat(64), 'd'.repeat(64)], roomId = 'e'.repeat(32);
const server = createServer((req, res) => {
  const index = tokens.findIndex(t => req.headers.authorization === 'Bearer ' + t);
  if (index < 0 || req.url !== '/api/collaboration') { res.writeHead(401); res.end(); return; }
  requests[index]++;
  let body = ''; req.on('data', b => { body += b; }); req.on('end', () => {
    try {
      const q = JSON.parse(body); assert.equal(q.roomId, roomId); let value;
      if (q.op === 'read') {
        const page = messages.filter(m => m.seq > q.after).slice(0, q.limit ?? 100), cursor = page.at(-1)?.seq ?? q.after;
        value = { roomId, memberId: ids[index], cursor, more: cursor < messages.length, ...controls, presence, members: ids.map(id => ({ id, name: 'Synthetic peer', kind: 'ai' })), messages: page };
      }
      else if (q.op === 'ack') {
        assert(Number.isInteger(q.fetched) && q.fetched >= 0 && q.fetched <= messages.length);
        assert(Number.isInteger(q.delivered) && q.delivered >= 0 && q.delivered <= q.fetched);
        assert.equal(typeof q.paused, 'boolean');
        acknowledgements.push({ index, fetched: q.fetched, delivered: q.delivered, paused: q.paused });
        presence[ids[index]] = { fetched: q.fetched, delivered: q.delivered, paused: q.paused, heartbeatAt: new Date().toISOString() };
        value = { ok: true };
      } else {
        assert.equal(q.op, 'send'); value = messages.find(m => m.id === q.id);
        if (!value) { value = { seq: messages.length + 1, id: q.id, memberId: ids[index], text: q.text, to: q.to, replyTo: q.replyTo }; messages.push(value); }
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));
    } catch (error) { errors.push(String(error)); res.writeHead(500); res.end(); }
  });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 90000;
  while (!predicate()) { if (Date.now() >= deadline) throw Error('Timed out: ' + label + '; messages=' + messages.length + '; modelCalls=' + modelCalls.length + '; errors=' + JSON.stringify(errors)); await delay(50); }
}
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = 'http://127.0.0.1:' + server.address().port;
  const sdk = await import(pathToFileURL(join(piRoot, 'dist/index.js')).href);
  const { createAssistantMessageEventStream } = await import(pathToFileURL(resolve(piRoot, '../pi-ai/dist/compat.js')).href);
  const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = sdk;
  async function open(index, manager) {
    const dir = join(root, String(index)); await mkdir(dir, { recursive: true });
    const config = join(dir, 'member.json');
    if (!manager) await writeFile(config, JSON.stringify({ origin, roomId, memberId: ids[index], token: tokens[index] }), { mode: 0o600 });
    const requestCount = requests[index];
    const runtime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, modelsStorePath: join(dir, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider('cafe-synthetic-' + index, {
      api: 'cafe-synthetic-api', apiKey: 'synthetic-not-a-real-credential', baseUrl: 'http://127.0.0.1:1',
      models: [{ id: 'fixture', name: 'Offline collaboration fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
      streamSimple(model, context) {
        const transcript = JSON.stringify(context);
        assert(!tokens.some(token => transcript.includes(token)), 'Credentials must not enter model requests');
        assert(!transcript.includes(config) && !transcript.includes(JSON.stringify(config).slice(1, -1)), 'Binding path must not enter model requests');
        modelCalls.push(index); const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          const output = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'pending', timestamp: Date.now() };
          stream.push({ type: 'start', partial: output });
          // Native Pi can append a system-section patch after the latest conversation message.
          const last = context.messages.findLast(message => message.role !== 'system');
          const text = typeof last?.content === 'string' ? last.content : (last?.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
          if (last?.role === 'toolResult' && pageOutTargets.length) {
            if (last.toolName === 'cafe_room_show') {
              assert(!last.isError); const message = JSON.parse(text.slice(text.indexOf('{'))).message;
              assert(pageOutTargets.includes(message.seq)); assert.equal(message.text, 'Synthetic page-out mention ' + message.seq); shownPageOut.push(message.seq);
            } else if (last.toolName === 'cafe_room_read') {
              assert(!last.isError); assert.equal(JSON.parse(text.slice(text.indexOf('{'))).message.seq, pageOutTargets[0] - 100);
            } else { assert.equal(last.toolName, 'cafe_room_done'); assert(last.isError && text.includes('NEXT_UNDISPATCHED_MESSAGE_REQUIRED')); }
            output.content = [{ type: 'text', text: 'Synthetic page-out boundary checked; no consumption or reply.' }]; output.stopReason = 'stop';
          } else if (text.includes('Synthetic page-out mention ') || text === 'Verify restored page-out full text.') {
            const sequence = text === 'Verify restored page-out full text.' ? pageOutTargets.at(-1) : Number(/\[msg #(\d+) /.exec(text)?.[1]);
            assert(pageOutTargets.includes(sequence));
            output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_show', arguments: { sequence } }]; output.stopReason = 'toolUse';
          } else if (text === 'Verify page-out cannot skip the unread prefix.') {
            output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_done', arguments: { sequence: pageOutTargets.at(-1) } }]; output.stopReason = 'toolUse';
          } else if (text === 'Read the oldest backlog item without consuming it.') {
            output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_read', arguments: {} }]; output.stopReason = 'toolUse';
          } else if (text.includes('[backlog ')) {
            output.content = [{ type: 'text', text: 'Synthetic backlog observed; no automatic consumption.' }]; output.stopReason = 'stop';
          } else if (last?.role === 'toolResult' && last.toolName === 'cafe_room_read') {
            const seq = [...text.matchAll(/"seq":(\d+)/g)].at(-1)?.[1];
            if (!seq) { errors.push('Manual read did not return its pending message'); output.stopReason = 'stop'; }
            else { output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_done', arguments: { sequence: Number(seq), through: true } }]; output.stopReason = 'toolUse'; }
          } else if (last?.role === 'toolResult') {
            if (last.toolName === 'cafe_room_show') assert(last.isError && text.includes('DELIVERED_MESSAGE_REQUIRED'), 'Controls must not grant unseen-message access');
            output.content = [{ type: 'text', text: 'Private synthetic completion; not uploaded to the room.' }]; output.stopReason = 'stop'; }
          else if (text === 'Read and confirm the next pending room message manually.') {
            output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_read', arguments: { limit: 20 } }]; output.stopReason = 'toolUse';
          } else if (text === 'Confirm delivered synthetic Goal.') {
            output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_done_goal', arguments: { revision: 1 } }]; output.stopReason = 'toolUse';
          } else if (text === 'Verify control grants no message access.') {
            output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_show', arguments: { sequence: 13 } }]; output.stopReason = 'toolUse';
          } else if (/\[(task #|goal r|pause |waiting-on-you|waiting-ended|member[+-])/.test(text)) {
            output.content = [{ type: 'text', text: 'Observed synthetic control delta; no room reply or message consumption.' }]; output.stopReason = 'stop';
          } else {
            const match = /\[msg #(\d+) /.exec(text);
            if (!match) { output.content = [{ type: 'text', text: 'Unexpected fixture input' }]; output.stopReason = 'stop'; errors.push('Missing labeled external message: ' + JSON.stringify({ role: last?.role, types: Array.isArray(last?.content) ? last.content.map(p => p.type) : typeof last?.content, text: text.slice(0, 200) })); }
            else if (text.includes('Discussion complete; no response needed.')) { output.content = [{ type: 'text', text: 'No reply required.' }]; output.stopReason = 'stop'; }
            else {
              // Bound the synthetic conversation with a conclusion, not a production listener quota.
              const finished = Number(match[1]) === 8 || text.includes('New task; respond once and finish.');
              output.content = [{ type: 'toolCall', id: 'synthetic-' + modelCalls.length, name: 'cafe_room_reply', arguments: { replyTo: Number(match[1]), text: finished ? 'Discussion complete; no response needed.' : `Explicit shared answer from peer ${index}` } }]; output.stopReason = 'toolUse';
            }
          }
          stream.push({ type: 'done', reason: output.stopReason, message: output }); stream.end();
        }); return stream;
      },
    });
    const settings = SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'Synthetic test. No external provider or user tools.', additionalExtensionPaths: [extensionPath] });
    await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime: runtime, model: runtime.getModel('cafe-synthetic-' + index, 'fixture'), resourceLoader: loader, settingsManager: settings, sessionManager: manager ?? SessionManager.create(dir, join(dir, 'sessions')), noTools: 'all', tools: ['cafe_room_done', 'cafe_room_done_goal', 'cafe_room_read', 'cafe_room_reply', 'cafe_room_show', 'cafe_room_status'], thinkingLevel: 'off' });
    sessions.push(session); await session.bindExtensions({});
    assert.deepEqual(session.getActiveToolNames().sort(), ['cafe_room_done', 'cafe_room_done_goal', 'cafe_room_read', 'cafe_room_reply', 'cafe_room_show', 'cafe_room_status']);
    await session.prompt('/cafe collab status');
    if (manager) await delay(5500);
    assert.equal(requests[index], requestCount, 'Loading/status must not connect, including a previously bound session');
    await session.prompt(manager ? '/cafe collab resume' : '/cafe collab connect ' + config);
    return { session, config };
  }
  const a = await open(0), b = await open(1); assert.equal(modelCalls.length, 0);
  await until(() => ids.every(id => presence[id]), 'idle connectors report presence');
  assert.equal(modelCalls.length, 0); assert(acknowledgements.every(q => q.fetched === 0 && q.delivered === 0));
  console.log('PASS: two native Pi connectors heartbeat while idle without invoking a model');
  messages.push({ seq: 1, id: 'synthetic-seed', memberId: ids[1], text: 'Start a bounded synthetic discussion.', replyTo: 0 });
  await until(() => messages.length === 9 && modelCalls.length === 17, 'eight autonomous replies and a quiet conclusion');
  await Promise.all([a.session.waitForIdle(), b.session.waitForIdle()]);
  assert.deepEqual(messages.slice(1).map(m => m.replyTo), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert(messages.slice(1, 8).every(m => m.text.startsWith('Explicit shared answer')));
  assert.equal(messages[8].text, 'Discussion complete; no response needed.');
  console.log('PASS: eight autonomous replies; discussion ends on its conclusion, not a runtime quota');
  await delay(5500); assert.equal(modelCalls.length, 17); assert.equal(messages.length, 9);
  await a.session.prompt('/cafe collab pause'); const sessionPath = a.session.sessionFile; assert(sessionPath); a.session.dispose(); sessions.splice(sessions.indexOf(a.session), 1);
  const stored = await readFile(sessionPath, 'utf8'); assert(!tokens.some(token => stored.includes(token)), 'No credential in saved session');
  const restored = await open(0, SessionManager.open(sessionPath));
  await delay(5500); assert.equal(modelCalls.length, 17); assert.equal(messages.length, 9);
  messages.push({ seq: 10, id: 'synthetic-new-task', memberId: ids[1], text: 'New task; respond once and finish.', to: ids[0], replyTo: 0 });
  await until(() => messages.length === 11 && modelCalls.length === 20, 'new work after restore without renewing a quota');
  await Promise.all([restored.session.waitForIdle(), b.session.waitForIdle()]);
  assert.equal(messages[10].replyTo, 10);
  console.log('PASS: path-free resume after SDK restore does not replay history; new work still wakes the agent');
  const deliveredEntries = restored.session.sessionManager.getBranch();
  assert(!deliveredEntries.some(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'consumed'), 'Automatic receipts and replies must not implicitly consume messages');
  await restored.session.prompt('Read and confirm the next pending room message manually.');
  await restored.session.waitForIdle(); assert.equal(modelCalls.length, 23); assert.equal(messages.length, 11);
  const confirmation = restored.session.sessionManager.getBranch().findLast(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'consumed');
  assert.deepEqual(confirmation?.data?.messages, [1, 3, 5, 7, 9, 10]);
  console.log('PASS: restored automatic deliveries remain unconsumed until an explicit atomic batch acknowledgement');
  await restored.session.prompt('/cafe collab pause'); await restored.session.prompt('/cafe collab resume');
  messages.push({ seq: 12, id: 'synthetic-manual-task', memberId: ids[1], text: 'Handle once through the shared inbox.', to: ids[0], replyTo: 0 });
  await restored.session.prompt('Read and confirm the next pending room message manually.');
  await delay(5500); assert.equal(modelCalls.length, 26); assert.equal(messages.length, 12);
  await restored.session.prompt('/cafe collab pause'); const manualPath = restored.session.sessionFile; assert(manualPath);
  restored.session.dispose(); sessions.splice(sessions.indexOf(restored.session), 1);
  const manualEntries = (await readFile(manualPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert(manualEntries.some(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'consumed' && e.data?.seq === 12));
  assert(!tokens.some(token => JSON.stringify(manualEntries).includes(token)));
  const restoredAgain = await open(0, SessionManager.open(manualPath)); await delay(5500);
  assert.equal(modelCalls.length, 26); assert.equal(messages.length, 12);
  console.log('PASS: native manual read/done persists consumption and prevents automatic replay after restore');
  assert(acknowledgements.some(q => q.index === 0 && q.fetched === 12 && q.delivered === 10));
  assert(!acknowledgements.some(q => q.delivered === 12), 'Manual consumption is not automatic host delivery');
  assert(acknowledgements.some(q => q.index === 1 && q.delivered === 11));
  const beats = acknowledgements.length; await Promise.all(sessions.map(session => session.prompt('/cafe collab pause')));
  await delay(5500); assert.equal(acknowledgements.length, beats);
  console.log('PASS: connector reports distinguish fetch, persisted delivery and manual consumption; pause stops heartbeat');
  const beforeReload = httpRequests;
  await restoredAgain.session.reload(); await restoredAgain.session.prompt('/cafe collab status'); await delay(5500);
  assert.equal(httpRequests, beforeReload, 'Native reload must not reconnect automatically');
  const originalConfig = await readFile(restoredAgain.config, 'utf8');
  for (const change of [{ token: 'f'.repeat(64) }, { origin: 'https://do-not-contact.invalid' }]) {
    await writeFile(restoredAgain.config, JSON.stringify({ ...JSON.parse(originalConfig), ...change }), { mode: 0o600 });
    await restoredAgain.session.prompt('/cafe collab resume');
    assert.equal(httpRequests, beforeReload, 'Changed binding must be refused before network access');
  }
  await rm(restoredAgain.config); await restoredAgain.session.prompt('/cafe collab resume');
  assert.equal(httpRequests, beforeReload, 'Missing config must not trigger discovery or a fallback connection');
  await writeFile(restoredAgain.config, originalConfig, { mode: 0o600 });
  await restoredAgain.session.prompt('/cafe collab resume');
  const resumedRequests = httpRequests; await restoredAgain.session.prompt('/cafe collab resume');
  assert.equal(httpRequests, resumedRequests, 'Repeated resume does not create another listener');
  await until(() => acknowledgements.length > beats, 'path-free resume after real native reload');
  assert.equal(modelCalls.length, 26); assert.equal(messages.length, 12);
  console.log('PASS: native reload stays disconnected; resume revalidates original config, rejects changed/missing files, and does not replay');
  // Controls change while the message stream stays at sequence 12.
  const controlState = session => session.sessionManager.getBranch().findLast(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'controls')?.data.controls;
  const progress = session => {
    const records = session.sessionManager.getBranch().filter(e => e.customType === 'cafe-collaboration-state' && ['cursor', 'consumed'].includes(e.data?.kind)).map(e => e.data);
    return { cursor: Math.max(0, ...records.map(e => e.seq)), consumed: records.filter(e => e.kind === 'consumed') };
  };
  const beforeControls = progress(restoredAgain.session), callsBeforeControls = modelCalls.length;
  controls.tasks = Array.from({ length: 25 }, (_, i) => ({ id: i + 1, title: 'Synthetic task ' + (i + 1), status: 'todo' }));
  controls.waitingOnYou = [ids[1]];
  controls.goalRevision = 1;
  controls.goal = { id: 1, title: 'Synthetic Goal', criteria: 'Observe controls only', status: 'active', reviewer: ids[1], createdBy: ids[1], updatedAt: new Date().toISOString() };
  await until(() => controlState(restoredAgain.session)?.goalDelivered.includes(1) && controlState(restoredAgain.session)?.pending.length === 0, 'bounded controls delivered at the same message cursor');
  await restoredAgain.session.waitForIdle();
  assert.equal(modelCalls.length, callsBeforeControls + 2);
  const batches = restoredAgain.session.sessionManager.getBranch().filter(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'dispatch' && e.data.control);
  assert.deepEqual(batches.map(e => e.data.control.events.length), [20, 7]);
  assert.equal(controlState(restoredAgain.session).goalConsumed, 0, 'Host receipt must not confirm Goal handling');
  assert.deepEqual(progress(restoredAgain.session), beforeControls); assert.equal(messages.length, 12);
  await restoredAgain.session.prompt('Verify control grants no message access.');
  await restoredAgain.session.prompt('Confirm delivered synthetic Goal.');
  assert.equal(controlState(restoredAgain.session).goalConsumed, 1);
  console.log('PASS: native bounded task/Goal/waiting controls at fixed cursor, no message access or implicit consumption');
  controls.aiPaused = true; controls.tasks[0].status = 'doing';
  const beforePause = modelCalls.length;
  await until(() => controlState(restoredAgain.session)?.seen.paused === true, 'paused controls persisted');
  await delay(5500); assert.equal(modelCalls.length, beforePause);
  const pendingControls = controlState(restoredAgain.session).pending;
  assert(pendingControls.length > 0); assert(acknowledgements.some(q => q.index === 0 && q.paused));
  await restoredAgain.session.prompt('/cafe collab pause'); const controlPath = restoredAgain.session.sessionFile; assert(controlPath);
  restoredAgain.session.dispose(); sessions.splice(sessions.indexOf(restoredAgain.session), 1);
  const controlRestored = await open(0, SessionManager.open(controlPath));
  await delay(5500); assert.equal(modelCalls.length, beforePause);
  assert.deepEqual(controlState(controlRestored.session).pending, pendingControls);
  controls.aiPaused = false;
  await until(() => controlState(controlRestored.session)?.seen.paused === false && controlState(controlRestored.session)?.pending.length === 0, 'pending controls delivered after resume');
  await controlRestored.session.waitForIdle();
  assert.equal(modelCalls.length, beforePause + 2); assert.equal(controlState(controlRestored.session).goalConsumed, 1);
  assert.deepEqual(progress(controlRestored.session), beforeControls); assert.equal(messages.length, 12);
  const afterControls = modelCalls.length;
  await controlRestored.session.reload(); await controlRestored.session.prompt('/cafe collab resume');
  await delay(10500); assert.equal(modelCalls.length, afterControls);
  assert.deepEqual(progress(controlRestored.session), beforeControls);
  assert(acknowledgements.slice(-2).every(q => q.index === 0 && q.fetched === 12 && q.delivered === 10 && !q.paused));
  console.log('PASS: native pause queues controls without model turns; saved-session restore and reload preserve receipts and Goal acknowledgement without replay');
  assert.equal(blockedNetwork, 0); assert.deepEqual(errors, []);
  const version = JSON.parse(await readFile(join(piRoot, 'package.json'), 'utf8')).version;
  const automaticWakeups = sessions.reduce((sum, session) => sum + session.sessionManager.getBranch().filter(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'dispatch').length, 0);
  assert.equal(automaticWakeups, 15);
  const sharedReplies = messages.length - 3, offset = messages.length;
  const branch = () => controlRestored.session.sessionManager.getBranch();
  messages.push(...Array.from({ length: 100 }, (_, i) => ({ seq: offset + i + 1, id: 'backlog-' + i, memberId: ids[1], text: 'Ordinary synthetic backlog' })));
  await until(() => branch().some(e => e.type === 'custom_message' && e.details?.backlog), 'native backlog summary receipt');
  await controlRestored.session.waitForIdle();
  pageOutTargets.push(...[101, 250, 501].map(seq => offset + seq));
  messages.push(...Array.from({ length: 450 }, (_, i) => {
    const seq = offset + i + 101, addressed = pageOutTargets.includes(seq);
    return { seq, id: 'page-out-' + seq, memberId: ids[1], text: addressed ? 'Synthetic page-out mention ' + seq : 'Ordinary synthetic backlog', ...(addressed ? { to: ids[0] } : {}) };
  }));
  await until(() => shownPageOut.length === 3, 'native page-out receipts and full-text access at relative #101/#250/#501');
  await controlRestored.session.waitForIdle();
  assert.deepEqual(shownPageOut, pageOutTargets);
  const discovery = branch().findLast(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'discovery')?.data.discovery;
  assert.deepEqual(discovery.received, pageOutTargets); assert.deepEqual(discovery.pending, []);
  assert.deepEqual(progress(controlRestored.session), beforeControls);
  await controlRestored.session.prompt('Verify page-out cannot skip the unread prefix.');
  await controlRestored.session.prompt('Read the oldest backlog item without consuming it.');
  assert.deepEqual(progress(controlRestored.session), beforeControls);
  await controlRestored.session.prompt('/cafe collab pause'); const pageOutPath = controlRestored.session.sessionFile; assert(pageOutPath);
  controlRestored.session.dispose(); sessions.splice(sessions.indexOf(controlRestored.session), 1);
  const beforePageOutRestore = modelCalls.length, pageOutRestored = await open(0, SessionManager.open(pageOutPath));
  await delay(10500); assert.equal(modelCalls.length, beforePageOutRestore, 'Saved native page-out receipts prevent replay');
  await pageOutRestored.session.prompt('Verify restored page-out full text.');
  assert.deepEqual(shownPageOut, [...pageOutTargets, pageOutTargets.at(-1)]);
  assert.deepEqual(progress(pageOutRestored.session), beforeControls);
  assert(acknowledgements.slice(-2).every(q => q.index === 0 && q.fetched === messages.length && q.delivered === 10));
  assert.equal(blockedNetwork, 0); assert.deepEqual(errors, []);
  assert(!tokens.some(token => JSON.stringify(pageOutRestored.session.sessionManager.getBranch()).includes(token)));
  const pageOutWakeups = pageOutRestored.session.sessionManager.getBranch().filter(e => e.customType === 'cafe-collaboration-state' && e.data?.kind === 'dispatch' && e.data.discovered).length;
  assert.equal(pageOutWakeups, 3);
  console.log('PASS: native page-out #101/#250/#501 receipts grant exact full text, retain the unread prefix, and survive actual session restore without replay');
  console.log(JSON.stringify({ passed: true, nativePiVersion: version, compiledEntry: values.extension !== undefined, automaticWakeups: automaticWakeups + 1 + pageOutWakeups, pageOutWakeups, pageOutReceiptsSurviveRestore: true, pageOutCannotSkipUnreadPrefix: true, nativeControlsAtFixedCursor: true, pausedControlsSurviveRestore: true, goalConfirmationSurvivesRestore: true, syntheticModelCalls: modelCalls.length, sharedReplies, restoredWithoutReplay: true, newWorkAfterRestore: true, manualConsumptionSurvivesRestore: true, automaticReceiptDoesNotConsume: true, explicitBatchConsumptionAfterRestore: true, pathFreeResume: true, nativeReloadWithoutAutoConnect: true, changedConfigRejectedBeforeNetwork: true, realModelRequests: 0, connectorHeartbeats: acknowledgements.length, blockedNetwork, httpRequests, scope: 'Actual Pi SDKs and loopback HTTP; synthetic model and relay, not live Pi/Claude acceptance.' }, null, 2));
} finally {
  for (const session of sessions) { try { await session.prompt('/cafe collab pause'); } catch {} session.dispose(); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  globalThis.fetch = nativeFetch; await rm(root, { recursive: true, force: true });
}
