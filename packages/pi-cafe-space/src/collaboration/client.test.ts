import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { RoomClient, RoomError, parseMessage, readMembership, type Membership } from './client.js';
const auth: Membership = { origin: 'https://space.example.test', roomId: 'a'.repeat(32), memberId: 'b'.repeat(32), token: 'c'.repeat(64) };
const snapshot = { roomId: auth.roomId, memberId: auth.memberId, cursor: 0, more: false, members: [{ id: auth.memberId, name: 'Local AI', kind: 'ai' }], messages: [] };
const directories: string[] = [];

it('reads, acknowledges and replies beyond message 500 without accepting unsafe sequences', async () => {
  const peer = 'd'.repeat(32);
  const incoming = { seq: 501, id: 'message-501', memberId: peer, text: 'Continue', replyTo: 500 };
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.op === 'ack') return new Response(JSON.stringify({ ok: true }));
    if (body.op === 'send') return new Response(JSON.stringify({ ...body, seq: 502, memberId: auth.memberId }));
    return new Response(JSON.stringify({ ...snapshot, cursor: 501, members: [...snapshot.members, { id: peer, name: 'Peer', kind: 'human' }], messages: body.after === 500 ? [incoming] : [] }));
  });
  const client = new RoomClient(auth, request);
  expect((await client.read(500)).messages[0]?.seq).toBe(501);
  await client.ack({ fetched: 501, delivered: 501, paused: false });
  expect((await client.reply({ id: 'message-502', text: 'Reply', to: peer, replyTo: 501 })).seq).toBe(502);
  for (const seq of [501.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => parseMessage({ ...incoming, seq })).toThrow('INVALID_ROOM_RESPONSE');
    await expect(client.read(seq)).rejects.toThrow('INVALID_CURSOR');
    await expect(client.ack({ fetched: seq, delivered: 501, paused: false })).rejects.toThrow('INVALID_ACK');
    await expect(client.reply({ id: 'invalid-reply', text: 'Reply', to: peer, replyTo: seq })).rejects.toThrow('INVALID_REPLY');
  }
  expect(request).toHaveBeenCalledTimes(4);
});
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function file(value: unknown) { const dir = mkdtempSync(join(tmpdir(), 'cafe-room-client-')); directories.push(dir); const path = join(dir, 'member.json'); writeFileSync(path, JSON.stringify(value), { mode: 0o600 }); return path; }
it('requires a private room membership, not a separate sender allowlist', () => {
  expect(readMembership(file(auth))).toEqual(auth);
  expect(() => readMembership('relative.json')).toThrow('ABSOLUTE_PRIVATE_CONFIG_REQUIRED');
  for (const changes of [{ roomId: 'bad' }, { memberId: 'bad' }, { token: 'bad' }, { origin: 'http://example.com' }, { origin: 'https://space.example.test/path' }, { origin: 'https://user:secret@space.example.test' }]) expect(() => readMembership(file({ ...auth, ...changes }))).toThrow();
});
it('accepts ordinary membership configs and ignores legacy turn quotas and sender lists', () => {
  expect(readMembership(file(auth))).toEqual(auth);
  expect(readMembership(file({ ...auth, maxTurns: 4, allowMembers: ['d'.repeat(32)] }))).toEqual(auth);
  expect(readMembership(file({ ...auth, allowMembers: [] }))).toEqual(auth);
});
it('makes a real bounded loopback HTTP read with only the room member credential', async () => {
  let received: unknown;
  const server = createServer((req, res) => { let body = ''; req.on('data', b => body += b); req.on('end', () => { received = { path: req.url, token: req.headers.authorization, cookie: req.headers.cookie, body: JSON.parse(body) }; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(snapshot)); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await new RoomClient(readMembership(file({ ...auth, origin: `http://127.0.0.1:${port}` }))).read(0);
    expect(result.cursor).toBe(0); expect(received).toEqual({ path: '/api/collaboration', token: 'Bearer ' + auth.token, cookie: undefined, body: { op: 'read', after: 0, roomId: auth.roomId } });
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
it('handles stream disconnect as retryable, but malformed JSON as a closed protocol failure', async () => {
  const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(Error('connection reset')); } });
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(broken)).mockResolvedValueOnce(new Response('{broken'));
  const client = new RoomClient(auth, request);
  await expect(client.read(0)).rejects.toMatchObject({ code: 'NETWORK_RESULT_UNKNOWN', retryable: true });
  await expect(client.read(0)).rejects.toMatchObject({ code: 'INVALID_ROOM_RESPONSE', retryable: false });
});
it('bounds the response before JSON parsing and rejects invalid UTF-8', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(new Uint8Array(8 * 1024 * 1024 + 1))).mockResolvedValueOnce(new Response(new Uint8Array([255])));
  const client = new RoomClient(auth, request);
  await expect(client.read(0)).rejects.toThrow('ROOM_RESPONSE_LIMIT'); await expect(client.read(0)).rejects.toThrow('INVALID_ROOM_RESPONSE');
});
it('respects rate-limit delay and treats permission failures as terminal', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '120' } })).mockResolvedValueOnce(new Response('', { status: 403 }));
  const client = new RoomClient(auth, request);
  await expect(client.read(0)).rejects.toMatchObject({ retryable: true, retryAfterMs: 120000 });
  await expect(client.read(0)).rejects.toMatchObject({ retryable: false, code: 'ROOM_HTTP_403' }); expect(request).toHaveBeenCalledTimes(2);
});
it('never exposes remote error bodies and never retries an uncertain write', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, cursor: 1 }))).mockResolvedValueOnce(new Response('untrusted-secret-error-body', { status: 503 }));
  try { await new RoomClient(auth, request).reply({ id: 'reply-id-stable', to: 'd'.repeat(32), replyTo: 1, text: 'shared text' }); throw Error('expected failure'); }
  catch (error) { expect(error).toBeInstanceOf(RoomError); expect(String(error)).not.toContain('untrusted-secret-error-body'); }
  expect(request).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(request.mock.calls[1]![1]?.body)).op).toBe('send');
});
it('detects presence support from validated reads without requiring a new config', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ...snapshot, presence: {} }))).mockResolvedValueOnce(new Response(JSON.stringify(snapshot)));
  const client = new RoomClient(auth, request);
  await client.read(0); expect(client.supportsPresence).toBe(true);
  await client.read(0); expect(client.supportsPresence).toBe(false);
});
it('validates ack progress and sends only connector counters with the member credential', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }))).mockResolvedValueOnce(new Response('{}'));
  const client = new RoomClient(auth, request);
  await expect(client.ack({ fetched: 1, delivered: 2, paused: false })).rejects.toThrow('INVALID_ACK');
  await expect(client.ack({ fetched: Number.MAX_SAFE_INTEGER + 1, delivered: 0, paused: false })).rejects.toThrow('INVALID_ACK');
  expect(request).not.toHaveBeenCalled();
  await client.ack({ fetched: 2, delivered: 1, paused: false });
  expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({ op: 'ack', roomId: auth.roomId, fetched: 2, delivered: 1, paused: false });
  expect(request.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { Authorization: 'Bearer ' + auth.token } });
  await expect(client.ack({ fetched: 2, delivered: 1, paused: true })).rejects.toThrow('INVALID_ROOM_RESPONSE');
});
it('blocks a room reply when the owner paused AI participation', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ...snapshot, cursor: 1, aiPaused: true })));
  await expect(new RoomClient(auth, request).reply({ id: 'stable-reply-id', to: 'd'.repeat(32), replyTo: 1, text: 'blocked' })).rejects.toThrow('ROOM_AI_PAUSED');
  expect(request).toHaveBeenCalledTimes(1);
});
