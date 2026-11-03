import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { WebSocketServer } from 'ws';
import { connectProxy, inspectConnection, loadedIds, READ_ONLY_REQUESTS } from './shared-check.mjs';

function fixture(responses) {
  const sent = [];
  return { sent, reader: { async read() { return responses.length ? { value: responses.shift(), done: false } : { done: true }; } },
    writer: { async write(message) { sent.push(message); } } };
}

test('existing-daemon diagnostic sends only initialize and loaded IDs requests', async () => {
  const f = fixture([
    { id: 1, result: { userAgent: 'codex/0.165.0 private-platform-metadata' } },
    { method: 'unrelated/event', params: { text: 'must not be returned' } },
    { id: 2, result: { data: ['b', 'a'], nextCursor: null } },
  ]);
  const result = await inspectConnection(f, 'test');
  assert.deepEqual(result, { ids: ['a', 'b'], more: false, serverVersion: '0.165.0' });
  assert.deepEqual(f.sent.map(x => x.method), ['initialize', 'initialized', 'thread/loaded/list']);
  assert.deepEqual(f.sent[2].params, { limit: 20 });
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.deepEqual(READ_ONLY_REQUESTS, ['initialize', 'thread/loaded/list']);
  assert(Object.isFrozen(READ_ONLY_REQUESTS));
});

test('unexpected approval is not answered or exposed', async () => {
  const f = fixture([{ id: 'server-approval', method: 'item/commandExecution/requestApproval', params: { command: 'private' } }]);
  await assert.rejects(inspectConnection(f, 'test'), /Unexpected server request/);
  assert.deepEqual(f.sent.map(x => x.method), ['initialize']);
});

test('failed requests expose only error code, never raw server details', async () => {
  const f = fixture([{ id: 1, error: { code: -32001, message: 'private-provider-details' } }]);
  await assert.rejects(inspectConnection(f, 'test'), /^AssertionError.*Metadata request failed \(-32001\)/);
  assert.equal(f.sent.length, 1);
});

test('WebSocket upgrade over proxy streams uses only metadata RPCs, no external connection', async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sent = [];
  wss.on('connection', (ws, request) => {
    assert.equal(request.url, '/');
    ws.on('message', data => {
      const message = JSON.parse(data.toString()); sent.push(message.method);
      if (message.id === 1) ws.send(JSON.stringify({ id: 1, result: { userAgent: 'codex/0.165.0' } }));
      if (message.id === 2) ws.send(JSON.stringify({ id: 2, result: { data: ['fixture'], nextCursor: null } }));
      if (message.method === 'invalid-fixture') ws.send('private malformed frame');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const socket = connect(server.address().port, '127.0.0.1');
  let transport;
  try {
    await once(socket, 'connect');
    transport = connectProxy({ stdin: socket, stdout: socket });
    await once(transport.ws, 'open');
    const result = await inspectConnection(transport, 'test');
    assert.deepEqual(result.ids, ['fixture']);
    assert.deepEqual(sent, ['initialize', 'initialized', 'thread/loaded/list']);
    await transport.writer.write({ method: 'invalid-fixture' });
    await assert.rejects(transport.reader.read(), /^Error: Invalid RPC JSON$/);
  } finally {
    transport?.ws.terminate();
    socket.destroy();
    await transport?.messages.return();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});

test('loaded ID response validation is bounded, strips extra fields and reports pagination', () => {
  assert.deepEqual(loadedIds({ data: ['a', 'a'], nextCursor: 'opaque', preview: 'private' }), { ids: ['a'], more: true });
  for (const input of [null, {}, { data: [5] }, { data: [''] }, { data: ['a'.repeat(129)] }, { data: Array(21).fill('a') }]) {
    assert.throws(() => loadedIds(input));
  }
});
