// Tests for the space-agent POSIX preview client against a native Relay.
//   PI_CAFE_RELAY_BINARY=/absolute/path/to/pi-cafe-relay node --test scripts/space-agent.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const binary = process.env.PI_CAFE_RELAY_BINARY;
const client = fileURLToPath(new URL('./space-agent.mjs', import.meta.url));
let dir, origin, relay, env, outputs = [];
const startRelay = async () => {
  relay = spawn(binary, [], { env, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(origin + '/healthz')).ok) return; } catch {} await sleep(100); }
  throw Error('relay did not start');
};
const stopRelay = async () => { if (relay.exitCode !== null) return; const done = new Promise(ok => relay.once('exit', ok)); relay.kill(); await done; };
// The Relay closes idle keep-alive connections after a few seconds; retry once if a pooled one went stale.
const api = async (body, token) => {
  const send = () => fetch(origin + '/api/collaboration', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  try { return (await send()).json(); } catch { return (await send()).json(); }
};
const agent = (home, args, input = '') => {
  const r = spawnSync(process.execPath, [client, '--home', home, ...args], { input, encoding: 'utf8', timeout: 60_000 });
  outputs.push(r.stdout, r.stderr); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), json: () => JSON.parse(r.stdout.trim().split('\n').at(-1)) };
};
// For servers living in this process: spawnSync would block them and deadlock.
const agentAsync = (home, args, input = '') => new Promise(ok => {
  const child = spawn(process.execPath, [client, '--home', home, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }); let out = '', err = '';
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.stdin.end(input);
  child.on('exit', code => { outputs.push(out, err); ok({ code, out: out.trim(), err: err.trim() }); });
});
const home = name => { const path = join(dir, name); mkdirSync(path, { mode: 0o700 }); return path; };
let owner, link, invite;

before(async () => {
  if (!binary) return;
  dir = await mkdtemp(join(tmpdir(), 'space-agent-test-'));
  const reserve = createNet(); await new Promise(ok => reserve.listen(0, '127.0.0.1', ok)); const port = reserve.address().port; await new Promise(ok => reserve.close(ok));
  origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ mode: 'cloud', publicOrigin: origin, roomAccess: true, enableWebRTC: true }), { mode: 0o600 });
  env = { PATH: process.env.PATH ?? '', PI_COLLAB_HOST: '127.0.0.1', PI_COLLAB_PORT: String(port), PI_COLLAB_HOST_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_CLIENT_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_ALLOWED_ORIGINS: origin, PI_CAFE_REMOTE_CONFIG: join(dir, 'cloud.json'), PI_CAFE_COLLAB_DIRECTORY: join(dir, 'data') };
  await startRelay();
  owner = await api({ op: 'create', title: '客户端测试', name: 'Owner', kind: 'human' });
  ({ invite, url: link } = await api({ op: 'invite', roomId: owner.roomId }, owner.token));
});
after(async () => {
  if (!binary) return;
  await stopRelay(); await rm(dir, { recursive: true, force: true });
  // No output of any command may contain a credential or the invite.
  for (const text of outputs) { assert(!text.includes(invite), 'invite leaked'); assert(!text.includes(owner.token), 'token leaked'); }
});

test('refuses unsafe homes, non-https origins and redirects', { skip: !binary }, async () => {
  const open = join(dir, 'open'); mkdirSync(open, { mode: 0o755 }); chmodSync(open, 0o755);
  const r = agent(open, ['status']); assert.equal(r.code, 1); assert.match(r.err, /0700/);
  assert.match(agent(home('remote'), ['preview'], `http://example.com/#/collab/${owner.roomId}?invite=${invite}`).err, /only https/);
  const redirect = createServer((_, res) => { res.writeHead(307, { Location: origin + '/api/collaboration' }); res.end(); });
  await new Promise(ok => redirect.listen(0, '127.0.0.1', ok));
  let followed = false; redirect.on('request', () => {});
  const target = createServer((_, res) => { followed = true; res.end('{}'); }); await new Promise(ok => target.listen(0, '127.0.0.1', ok));
  redirect.removeAllListeners('request'); redirect.on('request', (_, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/api/collaboration` }); res.end(); });
  const started = Date.now();
  const bounced = await agentAsync(home('redirect'), ['preview'], `http://127.0.0.1:${redirect.address().port}/#/collab/${owner.roomId}?invite=${invite}`);
  redirect.close(); target.close();
  assert.notEqual(bounced.code, 0, 'a redirect must not be followed'); assert.equal(followed, false, 'the redirect target was contacted');
  assert(Date.now() - started < 5_000, 'a redirect fails at once instead of being retried'); assert.match(bounced.err, /redirects are not followed/);
});

test('joins privately and never prints the token', { skip: !binary }, () => {
  const h = home('member');
  const preview = agent(h, ['preview'], link); assert.equal(preview.code, 0); assert.equal(preview.json().title, '客户端测试');
  const joined = agent(h, ['join', '--name', 'Test agent'], link); assert.equal(joined.code, 0); assert.equal(joined.json().joined, true);
  const token = JSON.parse(readFileSync(join(h, 'member.json'), 'utf8')).token; outputs.push(''); assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(statSync(join(h, 'member.json')).mode & 0o777, 0o600); assert.equal(statSync(h).mode & 0o777, 0o700);
  assert.equal(agent(h, ['join', '--name', 'Again'], link).code, 1, 'one membership per home');
  for (const text of outputs) assert(!text.includes(token), 'member token leaked');
});

test('unified inbox: ordered confirmation, explicit skips, replay and no redelivery after manual handling', { skip: !binary }, async () => {
  const h = home('inbox'); assert.equal(agent(h, ['join', '--name', 'Inbox agent'], link).code, 0);
  const me = JSON.parse(readFileSync(join(h, 'member.json'), 'utf8')).memberId;
  for (const n of [1, 2, 3]) await api({ op: 'send', roomId: owner.roomId, id: `inbox-message-${n}`, text: `第 ${n} 条`, to: me }, owner.token);
  const base = (await api({ op: 'read', roomId: owner.roomId }, owner.token)).cursor - 3;
  assert.equal(agent(h, ['sync']).json().fetched, base + 3);
  const first = agent(h, ['next']).json(); assert.equal(first.text, '第 1 条');
  assert.match(agent(h, ['done', String(first.seq + 1)]).err, /out of order/);
  assert.equal(agent(h, ['done', String(first.seq)]).code, 0);
  // A manual read shows everything but consumes nothing.
  assert.equal(agent(h, ['read']).code, 0); assert.equal(agent(h, ['next']).json().text, '第 2 条');
  assert.match(agent(h, ['skip', String(first.seq + 1)]).err, /reason/);
  assert.equal(agent(h, ['skip', String(first.seq + 1), '--reason', 'handled by hand']).code, 0);
  // A new process replays the unconfirmed message until it is confirmed.
  assert.equal(agent(h, ['next']).json().text, '第 3 条'); assert.equal(agent(h, ['next']).json().text, '第 3 条');
  assert.equal(agent(h, ['done', String(first.seq + 2)]).code, 0);
  // Own messages never become work; confirmed messages are never delivered again.
  writeFileSync(join(dir, 'reply.txt'), '收到三条'); assert.equal(agent(h, ['send', '--text-file', join(dir, 'reply.txt')]).code, 0);
  agent(h, ['sync']); assert.equal(agent(h, ['next']).out, '');
  const status = agent(h, ['status']).json(); assert.equal(status.consumed, status.fetched); assert.equal(status.skipped, 2);
  const presence = (await api({ op: 'read', roomId: owner.roomId }, owner.token)).presence[me];
  assert.equal(presence.delivered, first.seq + 2, 'delivered reports the highest confirmed message');
});

test('a long poll never overwrites a confirmation made while it waited', { skip: !binary }, async () => {
  const h = home('race'); assert.equal(agent(h, ['join', '--name', 'Race agent'], link).code, 0);
  await api({ op: 'send', roomId: owner.roomId, id: 'race-message-1', text: '先处理这条' }, owner.token);
  assert.equal(agent(h, ['sync']).code, 0); const first = agent(h, ['next']).json();
  // The poll waits for a message that never comes; meanwhile another process confirms one.
  const polling = agentAsync(h, ['sync', '--wait', '4']); await sleep(800);
  assert.equal(agent(h, ['done', String(first.seq)]).code, 0);
  assert.equal((await polling).code, 0);
  assert.equal(agent(h, ['status']).json().consumed, first.seq, 'the confirmation survived the poll');
  assert.notEqual(agent(h, ['next']).json().seq, first.seq);
});

// Runs watch for a while and returns the message seqs it printed.
const watched = (h, ms) => new Promise(ok => {
  const child = spawn(process.execPath, [client, '--home', h, 'watch'], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  child.stdout.on('data', b => out += b); setTimeout(() => child.kill(), ms);
  child.on('exit', () => { outputs.push(out); ok([...out.matchAll(/\[msg #(\d+)\]/g)].map(x => Number(x[1]))); });
});
test('watch replays the unconsumed backlog after a restart, and never what was confirmed', { skip: !binary }, async () => {
  const h = home('replay'); assert.equal(agent(h, ['join', '--name', 'Replay agent'], link).code, 0);
  const backlog = await api({ op: 'send', roomId: owner.roomId, id: 'replay-message-1', text: '重启前未处理' }, owner.token);
  assert.equal(agent(h, ['sync']).code, 0);
  assert(( await watched(h, 1500)).includes(backlog.seq), 'a restarted watch prints the fetched but unconsumed message');
  for (let n = agent(h, ['next']); n.out; n = agent(h, ['next'])) assert.equal(agent(h, ['done', String(n.json().seq)]).code, 0);
  assert.deepEqual(await watched(h, 1500), [], 'nothing confirmed is printed again');
  const fresh = (async () => { await sleep(800); return api({ op: 'send', roomId: owner.roomId, id: 'replay-message-2', text: '重启后新到' }, owner.token); })();
  const printed = await watched(h, 4000); assert.deepEqual(printed, [(await fresh).seq]);
});

test('a write with an unknown result can be retried by a later run with the same id', { skip: !binary }, async () => {
  const h = home('stable'); assert.equal(agent(h, ['join', '--name', 'Stable agent'], link).code, 0);
  await stopRelay();
  const unknown = agent(h, ['task', 'create', '--title', '跨进程恢复的任务']); assert.equal(unknown.code, 2);
  const { id } = JSON.parse(unknown.out); assert.match(id, /^agent-task-[a-f0-9]{32}$/);
  await startRelay();
  const created = agent(h, ['task', 'create', '--title', '跨进程恢复的任务']).json();
  assert.equal(agent(h, ['task', 'create', '--title', '跨进程恢复的任务', '--id', id]).json().id, created.id, 'the printed id is the one a re-run uses');
});

test('after a crash, a half-written inbox line is cut off and fetched again, never glued on or duplicated', { skip: !binary }, async () => {
  const h = home('crash'); assert.equal(agent(h, ['join', '--name', 'Crash agent'], link).code, 0);
  await api({ op: 'send', roomId: owner.roomId, id: 'crash-message-1', text: '崩溃前最后一条' }, owner.token);
  assert.equal(agent(h, ['sync']).code, 0);
  const lines = readFileSync(join(h, 'inbox.jsonl'), 'utf8').trim().split('\n'); const seqs = lines.map(l => JSON.parse(l).seq);
  // The crash: the last line was half written, and the cursor never moved past several whole lines.
  writeFileSync(join(h, 'inbox.jsonl'), lines.slice(0, -1).join('\n') + '\n{"seq":', { mode: 0o600 });
  const state = JSON.parse(readFileSync(join(h, 'state.json'), 'utf8')); writeFileSync(join(h, 'state.json'), JSON.stringify({ ...state, fetched: seqs[0] }), { mode: 0o600 });
  assert.equal(agent(h, ['sync']).code, 0);
  const after = readFileSync(join(h, 'inbox.jsonl'), 'utf8'); assert(after.endsWith('\n'));
  assert.deepEqual(after.trim().split('\n').map(l => JSON.parse(l).seq), seqs, 'every message once, in order, the cut-off one fetched again');
  assert.equal(agent(h, ['next']).json().seq, seqs[0]);
});

test('a lock left by a process that died stops every writer until unlock', { skip: !binary }, () => {
  const h = home('lock'); assert.equal(agent(h, ['join', '--name', 'Lock agent'], link).code, 0);
  const dead = spawnSync(process.execPath, ['-e', '']).pid; const lock = join(h, 'state.lock');
  writeFileSync(lock, `${dead} crashed\n`, { mode: 0o600 });
  const started = Date.now(); const blocked = agent(h, ['next']);
  assert.equal(blocked.code, 1); assert.match(blocked.err, /unlock/); assert(Date.now() - started < 5_000, 'fails at once instead of waiting');
  writeFileSync(lock, `${process.pid} alive\n`, { mode: 0o600 });
  assert.match(agent(h, ['unlock']).err, /still running/);
  writeFileSync(lock, `${dead} crashed\n`, { mode: 0o600 });
  assert.equal(agent(h, ['unlock']).json().unlocked, true); assert.equal(agent(h, ['next']).code, 0);
});

test('send retries safely, claims are idempotent and unknown updates are never replayed', { skip: !binary }, async () => {
  const a = home('claim-a'), b = home('claim-b');
  assert.equal(agent(a, ['join', '--name', 'Claimer A'], link).code, 0); assert.equal(agent(b, ['join', '--name', 'Claimer B'], link).code, 0);
  writeFileSync(join(dir, 'same.txt'), '同一条消息');
  assert.equal(agent(a, ['send', '--text-file', join(dir, 'same.txt')]).json().seq, agent(a, ['send', '--text-file', join(dir, 'same.txt')]).json().seq);
  const task = await api({ op: 'task', roomId: owner.roomId, action: 'create', id: 'agent-test-task-1', title: '统计 alpha 与 beta' }, owner.token);
  assert.equal(agent(a, ['task', 'claim', String(task.id)]).json().status, 'doing');
  assert.equal(agent(a, ['task', 'claim', String(task.id)]).json().status, 'doing', 'a retried claim returns the task');
  assert.match(agent(b, ['task', 'claim', String(task.id)]).err, /TASK_TAKEN/);
  await stopRelay();
  const unknown = agent(a, ['task', 'update', String(task.id), '--status', 'done']);
  assert.equal(unknown.code, 2); assert.match(unknown.out, /"unknown":true/);
  assert.match(readFileSync(join(a, 'intents.jsonl'), 'utf8'), /"status":"done"/);
  await startRelay();
  const tasks = (await api({ op: 'read', roomId: owner.roomId }, owner.token)).tasks;
  assert.equal(tasks.find(t => t.id === task.id).status, 'doing', 'the unknown update was not replayed');
});
