import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AcpAdapter } from './adapter.mjs';
import { launchAgent, reserveLiveAttempt } from './probe.mjs';

const sdkRoot = process.env.CAFE_ACP_ROOT;
const sdkUrl = sdkRoot && pathToFileURL(join(sdkRoot, 'node_modules/@agentclientprotocol/sdk/dist/v1/stable/acp.js')).href;

test('live budget reservation is exclusive, persistent and never reset on rerun', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cafe-acp-budget-test-'));
  try {
    const attempts = await Promise.allSettled([reserveLiveAttempt(root), reserveLiveAttempt(root)]);
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 1);
    const before = await readFile(join(root, 'live-attempt.json'), 'utf8');
    assert.equal(JSON.parse(before).reservedPromptAttempts, 1);
    await assert.rejects(reserveLiveAttempt(root), { code: 'EEXIST' });
    assert.equal(await readFile(join(root, 'live-attempt.json'), 'utf8'), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('official SDK wire roundtrip: initialize, restore, text, deny permissions and client file access', { skip: !sdkRoot }, async () => {
  const sdk = await import(sdkUrl);
  const incoming = new TransformStream(), outgoing = new TransformStream();
  const server = sdk.agent()
    .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
    .onRequest('session/load', () => ({}))
    .onRequest('session/prompt', async ({ params, client }) => {
      const permission = await client.request('session/request_permission', {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'blocked', title: 'Do not run', kind: 'execute', status: 'pending' },
        options: [{ optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      });
      assert.equal(permission.outcome.outcome, 'cancelled');
      await assert.rejects(client.request('fs/read_text_file', { sessionId: params.sessionId, path: '/never-read' }));
      await client.notify('session/update', { sessionId: 'foreign', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'private' },
      } });
      await client.notify('session/update', { sessionId: params.sessionId, update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture-ok' },
      } });
      return { stopReason: 'end_turn' };
    })
    .connect(sdk.ndJsonStream(outgoing.writable, incoming.readable));
  const events = [];
  const adapter = new AcpAdapter({ sdk, transport: sdk.ndJsonStream(incoming.writable, outgoing.readable), promptBudget: 1, onEvent: e => events.push(e) });
  try {
    await adapter.initialize(); await adapter.restore('fixture-session', '/tmp');
    assert.equal((await adapter.prompt('offline fixture')).stopReason, 'end_turn');
    assert.deepEqual(events.map(e => e.text), ['fixture-ok']);
  } finally { adapter.close(); server.close(); }
});

test('owned child process closes without any model or Codex invocation', { skip: !sdkRoot }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'cafe-acp-child-test-'));
  const entry = join(root, 'fake-agent.mjs');
  await writeFile(entry, `import { Readable, Writable } from 'node:stream';
import * as sdk from ${JSON.stringify(sdkUrl)};
sdk.agent().onRequest('initialize', () => ({ protocolVersion: 1 }))
.connect(sdk.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`);
  const sdk = await import(sdkUrl);
  let handle;
  try {
    handle = await launchAgent({ sdk, entry, codex: process.execPath, cwd: root, promptBudget: 0 });
    await handle.adapter.initialize(); await handle.close(); await handle.close();
    assert.throws(() => process.kill(handle.pid, 0), { code: 'ESRCH' });
  } finally { await handle?.close(); await rm(root, { recursive: true, force: true }); }
});
