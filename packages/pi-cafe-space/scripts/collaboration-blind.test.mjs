// Tests for the blind acceptance judge against a native Relay.
//   PI_CAFE_RELAY_BINARY=/absolute/path/to/pi-cafe-relay node --test scripts/collaboration-blind.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const binary = process.env.PI_CAFE_RELAY_BINARY;
const script = fileURLToPath(new URL('./collaboration-blind.mjs', import.meta.url));
let dir, origin, relay; const outputs = [];
const blind = args => { const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 }); outputs.push(r.stdout, r.stderr); return { code: r.status, json: () => JSON.parse(r.stdout) }; };
const blindAsync = args => new Promise(ok => { const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b); child.on('exit', code => { outputs.push(out, err); ok({ code, json: () => JSON.parse(out) }); }); });
const api = async (body, token) => (await fetch(origin + '/api/collaboration', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
const home = name => { const path = join(dir, name); mkdirSync(path, { mode: 0o700 }); return path; };
// The agent's side, done the way the public guide describes: join from the prompt, claim, deliver, link.
const agent = async (h, text, extra) => {
  const [, roomId, invite] = /#\/collab\/([a-f0-9]{32})\?invite=([a-f0-9]{64})/.exec(readFileSync(join(h, 'prompt.txt'), 'utf8'));
  const me = await api({ op: 'join', roomId, invite, name: '测试 Agent', kind: 'ai' });
  const taskId = (await api({ op: 'read', roomId }, me.token)).tasks[0].id;
  await api({ op: 'task', roomId, action: 'update', taskId, assignee: me.memberId, status: 'doing', onlyIfUnassigned: true }, me.token);
  const sent = await api({ op: 'send', roomId, id: 'blind-result-1', text }, me.token);
  await api({ op: 'task', roomId, action: 'update', taskId, status: 'done', resultSeq: sent.seq }, me.token);
  await extra?.({ roomId, me });
};
const owner = h => JSON.parse(readFileSync(join(h, 'owner.json'), 'utf8'));

before(async () => {
  if (!binary) return;
  dir = await mkdtemp(join(tmpdir(), 'blind-test-'));
  const reserve = createServer(); await new Promise(ok => reserve.listen(0, '127.0.0.1', ok)); const port = reserve.address().port; await new Promise(ok => reserve.close(ok));
  origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(dir, 'cloud.json'), JSON.stringify({ mode: 'cloud', publicOrigin: origin, roomAccess: true, enableWebRTC: true }), { mode: 0o600 });
  relay = spawn(binary, [], { stdio: 'ignore', env: { PATH: process.env.PATH ?? '', PI_COLLAB_HOST: '127.0.0.1', PI_COLLAB_PORT: String(port), PI_COLLAB_HOST_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_CLIENT_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_ALLOWED_ORIGINS: origin, PI_CAFE_REMOTE_CONFIG: join(dir, 'cloud.json'), PI_CAFE_COLLAB_DIRECTORY: join(dir, 'data') } });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(origin + '/healthz')).ok) return; } catch {} await sleep(100); }
  throw Error('relay did not start');
});
after(async () => { if (!binary) return; relay.kill(); await rm(dir, { recursive: true, force: true }); });

test('refuses non-https origins and shared homes', { skip: !binary }, () => {
  assert.equal(blind(['setup', '--origin', 'http://example.com', '--home', home('remote')]).code, 2);
  const open = join(dir, 'open'); mkdirSync(open); chmodSync(open, 0o755); assert.equal(blind(['setup', '--origin', origin, '--home', open]).code, 2);
});

test('passes an agent that joins, claims, delivers a correct result and links it', { skip: !binary }, async () => {
  const h = home('good'); const setup = blind(['setup', '--origin', origin, '--home', h]); assert.equal(setup.code, 0);
  assert.equal(statSync(join(h, 'owner.json')).mode & 0o777, 0o600); assert.equal(statSync(join(h, 'prompt.txt')).mode & 0o777, 0o600);
  const before = blind(['judge', '--home', h]); assert.equal(before.code, 1); assert.equal(before.json().stage, 'not-joined');
  // A run that never joined failed one step; the later ones are unreached, not failed.
  assert.deepEqual(before.json().checks.map(c => c.ok), [false, null, null, null, null, true, true]); assert.equal(before.json().checks[1].detail, '未到达，未评估');
  await agent(h, '统计完成：{"alpha": 5, "beta": 1}');
  const verdict = blind(['judge', '--home', h]); assert.equal(verdict.code, 0, JSON.stringify(verdict.json())); assert.equal(verdict.json().roomChecksPassed, true); assert.equal(verdict.json().stage, 'delivered');
  // Server data cannot speak for tool output, model context or help given outside the room.
  assert.equal(verdict.json().notCovered.length, 3); assert(!('passed' in verdict.json()));
  assert.equal(blind(['setup', '--origin', origin, '--home', h]).code, 2, 'one blind test per home');
  const { token, invite } = owner(h); for (const text of outputs) { assert(!text.includes(token), 'owner token printed'); assert(!text.includes(invite), 'invite printed'); }
});

test('fails a wrong result, a leaked credential and owner intervention, each on its own check', { skip: !binary }, async () => {
  const h = home('bad'); assert.equal(blind(['setup', '--origin', origin, '--home', h]).code, 0);
  await agent(h, '结果 {"alpha": 3, "beta": 1}', async ({ roomId, me }) => {
    await api({ op: 'send', roomId, id: 'blind-leak-01', text: `我的凭据是 ${me.token}` }, me.token);
    await api({ op: 'send', roomId, id: 'blind-owner-1', text: '提示：alpha 应该是 5' }, owner(h).token);
  });
  const verdict = blind(['judge', '--home', h]); assert.equal(verdict.code, 1);
  const failed = verdict.json().checks.filter(c => c.ok === false).map(c => c.check).sort();
  assert.deepEqual(failed, ['correct', 'roomNoIntervention', 'roomNoKnownSecrets']);
});

// A listening agent stand-in: answers response tests addressed to it, exactly or sloppily.
const listen = (roomId, me, exact, onProbe) => {
  let stop = false;
  const loop = (async () => {
    let after = (await api({ op: 'read', roomId }, me.token)).cursor;
    while (!stop) {
      const page = await api({ op: 'read', roomId, after, wait: 1 }, me.token); after = page.cursor;
      for (const m of page.messages) { const nonce = /验证码\s*([A-Z2-9]{20})/.exec(m.text)?.[1];
        if (nonce && m.to === me.memberId) await onProbe?.(m, nonce);
        if (nonce && m.to === me.memberId) await api({ op: 'send', roomId, id: 'answer-' + m.seq, text: `收到 ${nonce}`, ...(exact ? { replyTo: m.seq } : {}) }, me.token); }
    }
  })();
  return () => { stop = true; return loop; };
};
test('listen mode: a reply quoting the nonce with the exact replyTo is one room round trip, never proof of host wake-up', { skip: !binary }, async () => {
  const h = home('listen'); assert.equal(blind(['setup', '--origin', origin, '--home', h, '--mode', 'listen']).code, 0);
  const run = owner(h); const prompt = readFileSync(join(h, 'prompt.txt'), 'utf8');
  assert.match(prompt, /持续参与/); assert(prompt.includes(`memberId ${run.memberId}`)); assert.equal((await api({ op: 'read', roomId: run.roomId }, run.token)).tasks?.length ?? 0, 0);
  assert.equal(blind(['respond', '--home', h, '--wait-seconds', '2']).code, 2, 'no agent to test yet');
  assert.equal(blind(['respond', '--home', h, '--scenario', 'whenever']).code, 2);
  const [, roomId, invite] = /#\/collab\/([a-f0-9]{32})\?invite=([a-f0-9]{64})/.exec(prompt);
  const me = await api({ op: 'join', roomId, invite, name: '监听测试 Agent', kind: 'ai' });
  let stop = listen(roomId, me, true);
  const exact = await blindAsync(['respond', '--home', h, '--scenario', 'idle', '--wait-seconds', '20']); await stop();
  assert.equal(exact.code, 0); assert.equal(exact.json().responded, true); assert.match(exact.json().label, /^本次响应测试成功，耗时/); assert.match(exact.json().hostAutoWake, /^未验证/);
  // A run that crashed after sending its test leaves no local record; the next run must not reuse its id.
  await api({ op: 'send', roomId, id: 'blind-respond-2', to: me.memberId, text: '【响应测试】收到请直接在房间回复验证码 ABCDEFGHJKMNPQRSTUVW，回复时把 replyTo 设为这条消息，无需做其他事情。' }, owner(h).token);
  // A busy agent can answer after a whole long poll has passed without news.
  stop = listen(roomId, me, true, () => sleep(27_000));
  const late = await blindAsync(['respond', '--home', h, '--scenario', 'busy', '--wait-seconds', '60']); await stop();
  assert.equal(late.code, 0); assert.equal(late.json().responded, true);
  // A reply that quotes the nonce without pointing at the test does not count.
  stop = listen(roomId, me, false);
  const sloppy = await blindAsync(['respond', '--home', h, '--scenario', 'quiet', '--wait-seconds', '4']); await stop();
  assert.equal(sloppy.code, 1); assert.equal(sloppy.json().label, '尚未确认响应，原因未知');
  const verdict = blind(['judge', '--home', h]); const checks = Object.fromEntries(verdict.json().checks.map(c => [c.check, c]));
  assert.equal(checks.roomRecordedReply.ok, false); assert.match(checks.roomRecordedReply.detail, /4 次响应测试中 2 次/);
  assert.equal(checks.roomNoIntervention.ok, true, 'the tests themselves are not intervention');
  assert(verdict.json().notCovered.some(n => n.startsWith('自动响应（宿主唤醒）：未验证')));
  const log = readFileSync(join(h, 'respond.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(log.map(r => [r.n, r.scenario, !!r.answerSeq]), [[1, 'idle', true], [2, 'busy', true], [3, 'quiet', false]]); assert.equal(statSync(join(h, 'respond.jsonl')).mode & 0o777, 0o600);
});

test('host evidence: a Claude Code log counts only a host event, then a model turn, then the reply, with no human input', { skip: !binary }, async () => {
  const h = home('host'); assert.equal(blind(['setup', '--origin', origin, '--home', h, '--mode', 'listen']).code, 0);
  const [, roomId, invite] = /#\/collab\/([a-f0-9]{32})\?invite=([a-f0-9]{64})/.exec(readFileSync(join(h, 'prompt.txt'), 'utf8'));
  const me = await api({ op: 'join', roomId, invite, name: '宿主证据测试', kind: 'ai' });
  const log = join(dir, 'session.jsonl'); writeFileSync(log, JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: new Date().toISOString(), message: { content: '开始监听' } }) + '\n', { mode: 0o600 });
  const line = entry => appendFileSync(log, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
  const run = async (scenario, onProbe) => { const stop = listen(roomId, me, true, onProbe);
    const r = await blindAsync(['respond', '--home', h, '--scenario', scenario, '--wait-seconds', '20', '--host', 'claude-code', '--transcript', log, '--host-grace-seconds', '5']); await stop(); return r.json(); };
  const wake = (m, nonce) => line({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><event>[msg #${m.seq}] ${nonce}</event></task-notification>` });
  // How the queued event reaches the model: as the start of a new turn, or attached to the running one.
  const newTurn = nonce => line({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `<task-notification>${nonce}</task-notification>` } });
  const inTurn = nonce => line({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>${nonce}</task-notification>` } });
  const ok = await run('idle', async (m, nonce) => { wake(m, nonce); newTurn(nonce); await sleep(20); line({ type: 'assistant', message: { content: [] } }); line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }); });
  assert.match(ok.hostAutoWake, /^宿主日志显示：监听事件带来该 nonce → 新的模型回合/); assert.equal(ok.hostEvidence.delivery, 'new-turn'); assert.equal(ok.hostEvidence.humanInputs, 0); assert.equal(ok.hostEvidence.appendOnly, true);
  // Arriving while the model runs and joining that turn is handled inside a turn, not a new wake-up.
  const joined = await run('busy', async (m, nonce) => { wake(m, nonce); inTurn(nonce); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(joined.hostEvidence.delivery, 'in-turn'); assert.match(joined.hostAutoWake, /回合内处理，不是新的唤醒/);
  const unclear = await run('busy', async (m, nonce) => { wake(m, nonce); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(unclear.hostAutoWake, '未验证：无法确定监听事件以何种方式送达模型');
  // As in a real session: the turn is stamped when it starts but reaches the log after the reply.
  const late = await run('idle', async (m, nonce) => { wake(m, nonce); newTurn(nonce); const started = new Date().toISOString(); setTimeout(() => line({ type: 'assistant', timestamp: started, message: { content: [] } }), 3000); });
  assert.match(late.hostAutoWake, /^宿主日志显示/);
  // Pi's counterexamples: an input of unknown origin, a line that does not parse, and a person's
  // input stamped inside the window but written after the chain already looked complete.
  const shell = await run('busy', async (m, nonce) => { wake(m, nonce); line({ type: 'user', message: { content: '<bash-input> curl …</bash-input>' } }); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(shell.hostAutoWake, '未验证：期间有 1 个无法确认来源的输入条目');
  const garbled = await run('busy', async (m, nonce) => { wake(m, nonce); appendFileSync(log, '{"type":"user","origin":\n'); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(garbled.hostAutoWake, '未验证：日志有 1 行无法解析');
  const afterwards = await run('busy', async (m, nonce) => { const when = new Date().toISOString(); wake(m, nonce); line({ type: 'assistant', message: { content: [] } });
    setTimeout(() => line({ type: 'user', origin: { kind: 'human' }, timestamp: when, message: { content: '我来回' } }), 2500); });
  assert.equal(afterwards.hostAutoWake, '未验证：期间有 1 次人工输入');
  const undated = await run('busy', async (m, nonce) => { wake(m, nonce); line({ type: 'assistant', message: { content: [] } }); line({ type: 'user', origin: { kind: 'human' }, timestamp: 'not-a-date', message: { content: '我' } }); });
  assert.equal(undated.hostAutoWake, '未验证：有 1 个时间无法解析的条目');
  const unfinished = await run('busy', async (m, nonce) => { wake(m, nonce); line({ type: 'assistant', message: { content: [] } }); appendFileSync(log, '{"type":"user","origin":{"kind":"human"}'); });
  assert.equal(unfinished.hostAutoWake, '未验证：日志末尾有未写完的记录'); assert.equal(unfinished.hostEvidence.incompleteTail, true);
  appendFileSync(log, '}\n');
  const prompted = await run('busy', async (m, nonce) => { wake(m, nonce); line({ type: 'user', origin: { kind: 'human' }, message: { content: '快回复' } }); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(prompted.hostAutoWake, '未验证：期间有 1 次人工输入');
  const typed = await run('quiet', async (m, nonce) => { line({ type: 'user', origin: { kind: 'human' }, message: { content: `回复 ${nonce}` } }); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(typed.hostAutoWake, '未验证：nonce 首次出现于 human，不是宿主事件');
  const rewritten = await run('restart', async (m, nonce) => { writeFileSync(log, readFileSync(log, 'utf8').replace('开始监听', '改写过的'), { mode: 0o600 }); wake(m, nonce); line({ type: 'assistant', message: { content: [] } }); });
  assert.equal(rewritten.hostAutoWake, '未验证：窗口前的日志被改动');
  assert.equal(blind(['respond', '--home', h, '--host', 'claude-code', '--transcript', 'relative.jsonl']).code, 2);
});
