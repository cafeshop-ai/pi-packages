// Tests for the space-agent POSIX preview client against a native Relay.
//   PI_CAFE_RELAY_BINARY=/absolute/path/to/pi-cafe-relay node --test scripts/space-agent.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
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

test('join starts the inbox near the newest message instead of replaying a long history', { skip: !binary }, async () => {
  // A separate sender keeps the owner's send budget for the other tests.
  const talker = await api({ op: 'join', roomId: owner.roomId, invite, name: 'Talker', kind: 'human' });
  for (const n of [1, 2, 3, 4, 5]) await api({ op: 'send', roomId: owner.roomId, id: `history-message-${n}`, text: `历史 ${n} ` + '很长'.repeat(60) }, talker.token);
  const latest = (await api({ op: 'read', roomId: owner.roomId, latest: 1 }, owner.token)).latestSeq;
  const h = home('catch-up'); const joined = agent(h, ['join', '--name', 'Late agent', '--backlog', '2'], link);
  assert.equal(joined.code, 0); assert.equal(joined.json().latestSeq, latest); assert.equal(joined.json().inboxFrom, latest - 1); assert.match(joined.json().note, /read --before/);
  assert.equal(agent(h, ['sync']).json().fetched, 2, 'only the backlog enters the inbox');
  assert.match(agent(h, ['next']).json().text, /^历史 4 /);
  assert.equal(agent(h, ['status']).json().consumed, 0, 'skipped history is never reported as delivered');
  assert.equal(agent(h, ['join', '--name', 'Bad', '--backlog', '101'], link).code, 1);
  // Manual reads default to the newest page; older pages carry no cursor; excerpts are marked.
  const page = agent(h, ['read']).json(); assert.equal(page.cursor, latest); assert(page.messages.length <= 20); assert.equal(page.messages.at(-1).seq, latest);
  const older = agent(h, ['read', '--before', String(latest - 1), '--limit', '1', '--excerpt', '40']).json();
  assert.equal(older.messages.length, 1); assert.equal(older.messages[0].seq, latest - 2); assert.equal(older.messages[0].truncated, true); assert.equal(older.cursor, undefined);
  assert.equal(agent(h, ['read', '--after', String(latest - 1)]).json().messages.length, 1);
});

test('unified inbox: ordered confirmation, explicit skips, replay and no redelivery after manual handling', { skip: !binary }, async () => {
  // --backlog 0: only messages sent after joining reach this inbox.
  const h = home('inbox'); assert.equal(agent(h, ['join', '--name', 'Inbox agent', '--backlog', '0'], link).code, 0);
  const me = JSON.parse(readFileSync(join(h, 'member.json'), 'utf8')).memberId;
  for (const n of [1, 2, 3]) await api({ op: 'send', roomId: owner.roomId, id: `inbox-message-${n}`, text: `第 ${n} 条`, to: me }, owner.token);
  assert.equal(agent(h, ['sync']).json().fetched, 3);
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
test('states: an agent says what it waits for, and the awaited member is woken without chat', { skip: !binary }, async () => {
  const h = home('states'); assert.equal(agent(h, ['join', '--name', 'State agent', '--backlog', '0'], link).code, 0);
  const me = JSON.parse(readFileSync(join(h, 'member.json'), 'utf8')).memberId;
  const ownerId = (await api({ op: 'read', roomId: owner.roomId, latest: 1 }, owner.token)).memberId;
  const set = agent(h, ['state', 'waiting', '--for', 'member', '--on', ownerId, '--detail', '等房主批准上线']);
  assert.equal(set.code, 0); assert.equal(set.json().state, 'waiting');
  assert.deepEqual((await api({ op: 'read', roomId: owner.roomId, latest: 1 }, owner.token)).waitingOnYou, [me]);
  assert.match(agent(h, ['state', 'waiting', '--for', 'member', '--detail', '没写等谁']).err, /INVALID_STATE/);
  assert.equal(agent(h, ['state', 'show']).json().states[me].detail, '等房主批准上线');
  // The other way round: the owner waits on this agent, and its watch prints that once.
  const ask = await api({ op: 'send', roomId: owner.roomId, id: 'state-ask-0001', text: '请复核 #62', to: me }, owner.token);
  await api({ op: 'state', roomId: owner.roomId, state: 'waiting', waitingFor: 'review', on: [me], ref: ask.seq, detail: '等复核 #62' }, owner.token);
  assert.equal(agent(h, ['sync']).code, 0);
  assert.equal(agent(h, ['status']).json().waitingOnMe[0].detail, '等复核 #62');
  const child = spawn(process.execPath, [client, '--home', h, 'watch'], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  child.stdout.on('data', b => out += b); await sleep(1500); child.kill(); await new Promise(ok => child.once('exit', ok)); outputs.push(out);
  assert.equal([...out.matchAll(/\[waiting-on-you\] .* review: 等复核 #62 \(#(\d+)\)/g)].length, 1, out);
  assert.equal(agent(h, ['state', 'idle']).json().state, 'idle');
  await api({ op: 'state', roomId: owner.roomId, state: 'idle' }, owner.token);
});

// Runs listen (or another long command) for a while and returns what it printed.
const running = async (h, args, ms, during) => {
  const child = spawn(process.execPath, [client, '--home', h, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '';
  child.stdout.on('data', b => out += b); await sleep(900); if (during) await during(); await sleep(ms);
  child.kill(); await new Promise(ok => child.once('exit', ok)); outputs.push(out); return out;
};
test('listen: one line per change, never the board, and a restart replays nothing', { skip: !binary }, async () => {
  const h = home('listen'); assert.equal(agent(h, ['join', '--name', 'Listener', '--backlog', '0'], link).code, 0);
  const me = JSON.parse(readFileSync(join(h, 'member.json'), 'utf8')).memberId;
  const talker = await api({ op: 'join', roomId: owner.roomId, invite, name: 'Talker two', kind: 'human' });
  const first = await running(h, ['listen'], 2500, async () => {
    const sent = await api({ op: 'send', roomId: owner.roomId, id: 'listen-message-0001', text: '第一条\n第二行', to: me }, talker.token);
    await api({ op: 'task', roomId: owner.roomId, action: 'create', id: 'listen-task-0001', title: '监听器任务' }, talker.token);
    await api({ op: 'state', roomId: owner.roomId, state: 'waiting', waitingFor: 'member', on: [me], ref: sent.seq, detail: '等你看一下' }, talker.token);
  });
  assert.match(first, /^\[listener\] 已连接/m); assert.match(first, /^\[room 客户端测试\] 成员 \d+ · 未完成任务 \d+/m);
  assert.match(first, /^\[msg #\d+ Talker two → 你\] 第一条 ⏎ 第二行$/m);
  assert.match(first, /^\[task #\d+ 新建 todo 未指派\] 监听器任务$/m);
  assert.match(first, /^\[waiting-on-you Talker two member #\d+\] 等你看一下$/m);
  assert.ok(!/"tasks"|"members"|"presence"/.test(first), 'no snapshot is printed');
  const again = await running(h, ['listen'], 1800, () => api({ op: 'state', roomId: owner.roomId, state: 'idle' }, talker.token));
  assert.ok(!again.includes('第一条') && !again.includes('监听器任务'), 'events already printed are not printed again');
  assert.match(again, /^\[waiting-ended Talker two\]$/m);
  // One network listener per home.
  const busy = spawn(process.execPath, [client, '--home', h, 'listen', '--quiet'], { stdio: 'ignore' }); await sleep(900);
  const second = agent(h, ['listen']); busy.kill(); await new Promise(ok => busy.once('exit', ok));
  assert.equal(second.code, 2); assert.match(second.err, /another listen/);
  // board is the short form; show prints a message whole.
  const board = agent(h, ['board']); assert.equal(board.code, 0); assert.match(board.out, /^\[board\] 客户端测试 · 未完成 \d+/m); assert.match(board.out, /^#\d+ \[todo\] 监听器任务 · 未指派$/m);
  const seq = Number(/\[msg #(\d+) Talker two/.exec(first)[1]);
  assert.match(agent(h, ['show', String(seq)]).out, /第一条\n第二行/);
});

test('listen: a long gap is one backlog line; next serves it and done --through confirms it', { skip: !binary }, async () => {
  const h = home('listen-backlog'); assert.equal(agent(h, ['join', '--name', 'Backlogged', '--backlog', '0'], link).code, 0);
  await running(h, ['listen', '--quiet'], 300); assert.equal(agent(h, ['tail']).code, 0);
  const a = await api({ op: 'join', roomId: owner.roomId, invite, name: 'Sender A', kind: 'human' });
  const b = await api({ op: 'join', roomId: owner.roomId, invite, name: 'Sender B', kind: 'human' });
  const seqs = [];
  for (let i = 0; i < 21; i++) seqs.push((await api({ op: 'send', roomId: owner.roomId, id: `backlog-message-${String(i).padStart(3, '0')}`, text: `积压 ${i}` }, i % 2 ? b.token : a.token)).seq);
  const out = await running(h, ['listen'], 1500);
  assert.equal([...out.matchAll(/^\[backlog #(\d+)–#(\d+) 共 21 条\]/gm)].length, 1, out);
  assert.ok(!/积压 \d+/.test(out), 'backlogged messages are not printed one by one');
  assert.equal(agent(h, ['next']).json().seq, seqs[0], 'next starts with the oldest unconsumed message');
  assert.equal(agent(h, ['done', '--through', String(seqs.at(-1))]).json().consumed, seqs.at(-1));
  assert.equal(agent(h, ['next']).out, '');
});

test('listen --quiet keeps the connection; tail prints each event once per consumer', { skip: !binary }, async () => {
  const h = home('listen-tail'); assert.equal(agent(h, ['join', '--name', 'Quiet one', '--backlog', '0'], link).code, 0);
  const quiet = await running(h, ['listen', '--quiet'], 1500, () => api({ op: 'send', roomId: owner.roomId, id: 'tail-message-0001', text: '给 tail 的消息' }, owner.token));
  assert.equal(quiet, '', 'quiet prints nothing');
  const shown = agent(h, ['tail']); assert.match(shown.out, /^\[msg #\d+ Owner\] 给 tail 的消息$/m);
  assert.equal(agent(h, ['tail']).out, '', 'nothing twice for the same consumer');
  const json = agent(h, ['tail', '--json', '--as', 'program']).out.split('\n').map(line => JSON.parse(line));
  assert.ok(json.every(e => Number.isSafeInteger(e.id) && Number.isSafeInteger(e.batch)) && json.some(e => e.type === 'msg' && e.text === '给 tail 的消息'));
  // A monitor beside a background listener: tail --follow prints new events as listen --quiet writes them.
  const background = spawn(process.execPath, [client, '--home', h, 'listen', '--quiet'], { stdio: 'ignore' });
  const followed = await running(h, ['tail', '--follow'], 2500, () => api({ op: 'send', roomId: owner.roomId, id: 'tail-message-0002', text: '跟随输出的新消息' }, owner.token));
  background.kill(); await new Promise(ok => background.once('exit', ok));
  assert.match(followed, /^\[msg #\d+ Owner\] 跟随输出的新消息$/m); assert.ok(!followed.includes('给 tail 的消息'), 'already printed events stay printed');
});

test('deliver: only a receipt naming the batch advances a program consumer; unknown batches are never resent blindly', { skip: !binary }, async () => {
  const h = home('deliver'); assert.equal(agent(h, ['join', '--name', 'Queue agent', '--backlog', '0'], link).code, 0);
  // Trusted handlers chosen by the local user: each reads the batch file and prints one receipt line.
  const tools = join(dir, 'handlers'); mkdirSync(tools, { mode: 0o700, recursive: true });
  const handler = (name, body) => { const path = join(tools, name); writeFileSync(path, `#!/usr/bin/env node\nconst fs = require('fs'); const b = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\nfs.appendFileSync(${JSON.stringify(join(tools, 'calls.log'))}, ${JSON.stringify(name)} + ' ' + b.batch + '\\n');\n${body}\n`, { mode: 0o700 }); return path; };
  const accept = handler('accept.cjs', "console.log(JSON.stringify({ batch: b.batch, accepted: true }));");
  const crash = handler('crash.cjs', 'process.exit(1);');
  const wrong = handler('wrong.cjs', "console.log(JSON.stringify({ batch: '0-0', accepted: true }));");
  const flaky = handler('flaky.cjs', `const seen = fs.existsSync(${JSON.stringify(join(tools, 'once'))}); fs.writeFileSync(${JSON.stringify(join(tools, 'once'))}, ''); console.log(JSON.stringify({ batch: b.batch, accepted: seen }));`);
  const calls = () => existsSync(join(tools, 'calls.log')) ? readFileSync(join(tools, 'calls.log'), 'utf8').trim().split('\n') : [];
  const sent = await api({ op: 'send', roomId: owner.roomId, id: 'deliver-message-0001', text: '交给队列的消息' }, owner.token);
  await running(h, ['listen', '--quiet'], 300);
  const state = () => JSON.parse(readFileSync(join(h, 'state.json'), 'utf8'));
  // A crash leaves the batch unknown; the next deliver refuses without calling any handler.
  const crashed = agent(h, ['deliver', '--as', 'queue', '--handler', crash]); assert.equal(crashed.code, 2); assert.match(crashed.err, /no receipt/);
  assert.ok(state().handoffs.queue && !state().tailed?.queue, 'nothing is confirmed after a crash');
  assert.equal(agent(h, ['tail', '--as', 'queue']).code, 2, 'tail never moves a deliver consumer past a pending batch');
  const before = calls().length; assert.equal(agent(h, ['deliver', '--as', 'queue', '--handler', accept]).code, 2); assert.equal(calls().length, before, 'an unknown batch is never handed out again');
  // After checking the host: resend, and an accepted receipt confirms the consumer and delivered.
  assert.equal(agent(h, ['deliver-resolve', '--as', 'queue', '--resend']).json().settled, 'resend');
  assert.equal(agent(h, ['deliver', '--as', 'queue', '--handler', accept]).code, 0);
  assert.ok(state().tailed.queue > 0 && state().delivered >= sent.seq && !state().handoffs.queue);
  const kept = readdirSync(join(h, 'batches')); assert.equal(kept.length, 1, 'an accepted batch file stays for the host, which may hold only its path');
  // An explicit refusal means nothing was queued: it is offered again after a pause, then accepted.
  await api({ op: 'send', roomId: owner.roomId, id: 'deliver-message-0002', text: '第二条' }, owner.token); await running(h, ['listen', '--quiet'], 300);
  const mark = state().tailed.queue;
  assert.equal(agent(h, ['deliver', '--as', 'queue', '--handler', flaky]).code, 0);
  assert.equal(calls().filter(c => c.startsWith('flaky')).length, 2); assert.ok(state().tailed.queue > mark);
  // A receipt for another batch is not a receipt: unknown, then settled as accepted after checking.
  await api({ op: 'send', roomId: owner.roomId, id: 'deliver-message-0003', text: '第三条' }, owner.token); await running(h, ['listen', '--quiet'], 300);
  assert.equal(agent(h, ['deliver', '--as', 'queue', '--handler', wrong]).code, 2);
  const open = state().handoffs.queue; const batchFile = JSON.parse(readFileSync(open.file, 'utf8'));
  assert.ok(batchFile.events.some(e => e.type === 'msg' && e.text === '第三条' && e.line.includes('第三条')), 'the batch carries events and their lines, no credentials');
  assert.equal(statSync(open.file).mode & 0o777, 0o600); assert.ok(!readFileSync(open.file, 'utf8').includes(JSON.parse(readFileSync(join(h, 'member.json'), 'utf8')).token));
  assert.equal(agent(h, ['deliver-resolve', '--as', 'queue', '--accepted']).json().settled, 'accepted');
  assert.equal(state().tailed.queue, open.through); assert.ok(existsSync(open.file), 'settled as accepted, the file stays like after a receipt');
  // One hand-off per consumer: two delivers at once hand the batch out once; resolve cannot touch a running one.
  const slow = handler('slow.cjs', "setTimeout(() => console.log(JSON.stringify({ batch: b.batch, accepted: true })), 1500);");
  await api({ op: 'send', roomId: owner.roomId, id: 'deliver-message-0004', text: '第四条' }, owner.token); await running(h, ['listen', '--quiet'], 300);
  const [a, b] = await Promise.all([agentAsync(h, ['deliver', '--as', 'queue', '--handler', slow]), (async () => { await sleep(300); return agentAsync(h, ['deliver', '--as', 'queue', '--handler', slow]); })()]);
  assert.deepEqual([a.code, b.code].sort(), [0, 2]); assert.match(a.err + b.err, /another deliver/);
  const batches = calls().filter(c => c.startsWith('slow')); assert.equal(new Set(batches).size, batches.length, 'no batch reaches the handler twice');
  await api({ op: 'send', roomId: owner.roomId, id: 'deliver-message-0005', text: '第五条' }, owner.token); await running(h, ['listen', '--quiet'], 300);
  const busy = agentAsync(h, ['deliver', '--as', 'queue', '--handler', slow]); await sleep(400);
  const early = agent(h, ['deliver-resolve', '--as', 'queue', '--resend']); assert.equal(early.code, 2); assert.match(early.err, /still handing/);
  assert.equal((await busy).code, 0);
  // The stream consumer is separate: tail still prints everything it has not printed.
  assert.match(agent(h, ['tail', '--as', 'monitor']).out, /第三条/);
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

// Fault injection: writeSync may legally write less than asked (short), or nothing at all (zero).
const faulty = mode => { const path = join(dir, `faulty-${mode}.mjs`); writeFileSync(path, `
import fs from 'node:fs'; import { syncBuiltinESMExports } from 'node:module';
const original = fs.writeSync; const limit = ${mode === 'zero' ? 120 : 32};
fs.writeSync = (fd, data, ...rest) => {
  const bytes = typeof data === 'string' ? Buffer.from(data) : data; const [offset = 0, length = bytes.length - offset, position] = typeof data === 'string' ? [0, undefined, rest[0]] : rest;
  if (length <= limit) return original(fd, bytes, offset, length, position);
  return ${mode === 'zero' ? '0' : 'original(fd, bytes, offset, limit, position)'};
};
syncBuiltinESMExports();`); return path; };
const agentWith = (preload, h, args) => { const r = spawnSync(process.execPath, ['--import', preload, client, '--home', h, ...args], { encoding: 'utf8', timeout: 60_000 }); outputs.push(r.stdout, r.stderr); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };
test('short writes are completed and a write that makes no progress never commits the cursor', { skip: !binary }, async () => {
  const h = home('short'); assert.equal(agent(h, ['join', '--name', 'Short writer'], link).code, 0);
  await api({ op: 'send', roomId: owner.roomId, id: 'short-write-1', text: '这一条要完整落盘'.repeat(8) }, owner.token);
  assert.equal(agentWith(faulty('short'), h, ['sync']).code, 0);
  const lines = readFileSync(join(h, 'inbox.jsonl'), 'utf8').trim().split('\n'); assert(lines.every(l => JSON.parse(l).seq > 0));
  assert(lines.some(l => l.includes('这一条要完整落盘')));
  const z = home('zero'); assert.equal(agent(z, ['join', '--name', 'Zero write agent'], link).code, 0);
  // join starts the inbox near the newest message, so compare with where it started, not with 0.
  const start = agent(z, ['status']).json().fetched;
  await api({ op: 'send', roomId: owner.roomId, id: 'short-write-2', text: '零进度写入后游标不能前进' }, owner.token);
  const stalled = agentWith(faulty('zero'), z, ['sync']); assert.equal(stalled.code, 1); assert.match(stalled.err, /no progress/);
  assert.equal(agent(z, ['status']).json().fetched, start, 'the cursor did not move past what the inbox holds');
  assert.equal(agent(z, ['sync']).code, 0); assert.equal(agent(z, ['next']).code, 0); assert(agent(z, ['next']).json().seq > 0);
});

test('a quiet room is healthy: a full 25-second long poll returns normally', { skip: !binary }, async () => {
  const h = home('quiet'); assert.equal(agent(h, ['join', '--name', 'Quiet agent'], link).code, 0); assert.equal(agent(h, ['sync']).code, 0);
  const started = Date.now(); const quiet = await agentAsync(h, ['sync', '--wait', '25']);
  assert.equal(quiet.code, 0, quiet.err); assert(Date.now() - started >= 24_000, 'it really waited the whole poll');
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

test('Goal CLI controls and notifications survive restart without consuming chat or replaying stale controls', { skip: !binary }, async () => {
  const room = await api({ op: 'create', title: 'Goal CLI', name: 'Goal owner', kind: 'human' });
  const invitation = await api({ op: 'invite', roomId: room.roomId }, room.token);
  const admin = home('goal-owner'), worker = home('goal-worker');
  writeFileSync(join(admin, 'member.json'), JSON.stringify({ ...room, origin }), { mode: 0o600 });
  assert.equal(agent(worker, ['join', '--name', 'Goal worker'], invitation.url).code, 0);
  const criteria = join(dir, 'goal-criteria.txt'); writeFileSync(criteria, 'The linked task is done and the owner reviews its evidence.');
  const create = agent(admin, ['goal', 'create', '--title', 'Verify Goal', '--criteria-file', criteria, '--reviewer', room.memberId, '--revision', '0']);
  assert.equal(create.code, 0, create.err); assert.equal(create.json().goal.status, 'active');
  assert.equal(agent(worker, ['sync']).code, 0);
  const event = agent(worker, ['next']).json(); assert.equal(event.type, 'goal'); assert.equal(event.revision, 1);
  assert.equal(agent(worker, ['next']).json().revision, 1, 'a new process replays the unconfirmed Goal state');
  assert.equal(agent(worker, ['done-goal', '1']).code, 0); assert.equal(agent(worker, ['next']).out, '');
  assert.equal(agent(worker, ['status']).json().consumed, 0);
  assert.equal(agent(worker, ['goal', 'pause', '1', '--revision', '1']).json().goal.status, 'paused', 'any member may pause the room Goal');
  assert.equal(agent(admin, ['goal', 'resume', '1', '--revision', '1']).code, 1, 'stale revision is refused');
  assert.equal(agent(admin, ['goal', 'resume', '1', '--revision', '2']).json().goal.status, 'active');
  agent(worker, ['sync']); assert.equal(agent(worker, ['next']).json().revision, 3);
  assert.equal(agent(worker, ['done-goal', '2']).code, 1); assert.equal(agent(worker, ['done-goal', '3']).code, 0);
  const task = agent(worker, ['task', 'create', '--title', 'Verify result', '--goal-id', '1']).json(); assert.equal(task.goalId, 1);
  assert.equal(agent(worker, ['task', 'update', String(task.id), '--status', 'done']).code, 0);
  const evidence = join(dir, 'goal-evidence.txt'); writeFileSync(evidence, 'Result verified.');
  const sent = agent(worker, ['send', '--text-file', evidence]).json();
  assert.equal(agent(worker, ['goal', 'submit', '1', '--revision', '3', '--result', String(sent.seq)]).json().goal.status, 'review');
  assert.equal(agent(worker, ['goal', 'accept', '1', '--revision', '4']).code, 1);
  assert.equal(agent(admin, ['goal', 'accept', '1', '--revision', '4']).json().goal.status, 'done');
  await stopRelay();
  const unknown = agent(admin, ['goal', 'delete', '1', '--revision', '5']);
  assert.equal(unknown.code, 2); assert.equal(unknown.json().unknown, true);
  await startRelay();
  assert.equal(agent(admin, ['goal', 'read']).json().goal.status, 'done', 'unknown Goal writes are not replayed');
  assert.equal(agent(admin, ['goal', 'delete', '1', '--revision', '5']).json().goal, null);
  agent(worker, ['sync']); const deleted = agent(worker, ['next']).json(); assert.equal(deleted.type, 'goal'); assert.equal(deleted.goal, null);
  assert.equal(agent(worker, ['done-goal', '6']).code, 0);
  const view = agent(worker, ['goal', 'read']).json(); assert.equal(view.goal, null); assert.equal(view.tasks.length, 1);
  for (const text of outputs) { assert(!text.includes(room.token)); assert(!text.includes(invitation.invite)); }
});
