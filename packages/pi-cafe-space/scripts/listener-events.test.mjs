// The shared listener fixture (protocol/fixtures/listener/events.json) drives this reference
// implementation; any other implementation of docs/LISTENER.md (the Pi extension) runs the same file.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { formatEvent, helloEvent, listenerProtocol, maxBatchMessages, pageEvents } from './listener-events.mjs';

const fixture = JSON.parse(readFileSync(new URL('../protocol/fixtures/listener/events.json', import.meta.url), 'utf8'));

test('the declared protocol version is the one LISTENER.md describes', () => {
  // The release build names this version in the room guide; source builds have no docs/ to read it from.
  const title = readFileSync(new URL('../docs/LISTENER.md', import.meta.url), 'utf8').split('\n')[0];
  assert.match(title, new RegExp(`v${listenerProtocol.replace('.', '\\.')}$`));
});

for (const c of fixture.cases) test(c.name, () => {
  const seen = structuredClone(c.input.seen);
  const events = pageEvents(seen, c.input.page, c.input.fresh, c.me, c.input.goalConsumed);
  assert.deepEqual(events, c.events);
  assert.deepEqual(events.map(e => formatEvent(e, seen.names, c.me)), c.lines);
  assert.deepEqual(seen, c.seenAfter, 'the listener memory after the page');
  if (c.hello) { assert.deepEqual(helloEvent(c.input.page, c.me), c.hello); assert.equal(formatEvent(c.hello, seen.names, c.me), c.helloLine); }
});

test('message lines fit 2 KiB including headers and full-text hints', () => {
  for (const c of fixture.cases) c.events.forEach((e, i) => {
    if (e.type === 'msg') assert.ok(Buffer.byteLength(c.lines[i], 'utf8') <= 2048, c.name);
  });
});

test('UTF-8 truncation preserves code points, routing and the original event', () => {
  const names = { peer: '😀'.repeat(48), recipient: '中'.repeat(48) };
  for (const text of ['中'.repeat(1500), '😀'.repeat(1500), 'é'.repeat(1500), '中😀e\u0301\n'.repeat(300), 'x\n'.repeat(750)]) {
    const [event] = pageEvents({}, {}, [{ seq: 9007199254740991, memberId: 'peer', to: 'recipient', replyTo: 42, text }], 'me');
    const before = structuredClone(event), line = formatEvent(event, names, 'me');
    assert.ok(Buffer.byteLength(line, 'utf8') <= 2048, 'UTF-8 byte limit');
    assert.ok(line.isWellFormed(), 'no split surrogate pair');
    assert.ok(line.startsWith(`[msg #9007199254740991 ${names.peer} → ${names.recipient} ↩#42] `));
    assert.ok(line.endsWith('…（全文：show 9007199254740991）'));
    assert.ok(!line.includes('\n'), 'flatten before measuring bytes');
    assert.deepEqual(event, before, 'formatting never changes the persisted event');
  }
});

test('member names cannot introduce extra message lines', () => {
  const line = formatEvent({ type: 'msg', seq: 1, from: 'peer', to: 'recipient', text: 'body' }, { peer: 'Pi\nName', recipient: 'Front\tEnd' });
  assert.equal(line, '[msg #1 Pi ⏎ Name → Front End] body');
});

test('only lines exceeding the UTF-8 boundary gain a full-text hint', () => {
  const head = '[msg #1 Pi] ';
  for (const extra of [-1, 0, 1]) {
    const text = '中'.repeat(600) + 'x'.repeat(2048 - Buffer.byteLength(head) - 1800 + extra);
    const [event] = pageEvents({}, {}, [{ seq: 1, memberId: 'peer', text }], 'me');
    const line = formatEvent(event, { peer: 'Pi' }, 'me');
    assert.equal(line.includes('全文：show 1'), extra > 0);
    assert.ok(Buffer.byteLength(line) <= 2048);
    if (extra <= 0) assert.equal(line, head + text);
  }
});

test('a page never dumps the board or the member list', () => {
  const first = fixture.cases[0];
  assert.ok(!first.events.some(e => e.type === 'task' || e.type === 'member'), 'the first page only remembers tasks and members');
});

test('events never use the field names the outbox adds', () => {
  // An event field named id once replaced the outbox's event id, so tail skipped later events.
  for (const c of fixture.cases) for (const e of [...c.events, ...(c.hello ? [c.hello] : [])]) for (const key of ['id', 'batch', 'at']) assert.ok(!(key in e), `${e.type} uses ${key}`);
});

test('a backlog is a count, never the messages themselves', () => {
  const c = fixture.cases.find(x => x.events[0]?.type === 'backlog');
  assert.ok(c.input.fresh.length > maxBatchMessages);
  assert.deepEqual(c.events, [{ type: 'backlog', from: c.input.fresh[0].seq, to: c.input.fresh.at(-1).seq, count: c.input.fresh.length }]);
});

test('an unconfirmed goal is announced once, a confirmed one not again', () => {
  const page = { goalRevision: 3, goal: { id: 1, status: 'active', title: 'g' } };
  const seen = {};
  assert.equal(pageEvents(seen, page, [], 'me', 1).filter(e => e.type === 'goal').length, 1);
  assert.equal(pageEvents(seen, page, [], 'me', 1).filter(e => e.type === 'goal').length, 0);
  assert.equal(pageEvents({}, page, [], 'me', 3).filter(e => e.type === 'goal').length, 0);
});
