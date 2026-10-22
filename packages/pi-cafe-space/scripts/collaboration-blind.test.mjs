// Tests for the blind acceptance judge against a native Relay.
//   PI_CAFE_RELAY_BINARY=/absolute/path/to/pi-cafe-relay node --test scripts/collaboration-blind.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
  const open = join(dir, 'open'); mkdirSync(open, { mode: 0o755 }); assert.equal(blind(['setup', '--origin', origin, '--home', open]).code, 2);
});

test('passes an agent that joins, claims, delivers a correct result and links it', { skip: !binary }, async () => {
  const h = home('good'); const setup = blind(['setup', '--origin', origin, '--home', h]); assert.equal(setup.code, 0);
  assert.equal(statSync(join(h, 'owner.json')).mode & 0o777, 0o600); assert.equal(statSync(join(h, 'prompt.txt')).mode & 0o777, 0o600);
  const before = blind(['judge', '--home', h]); assert.equal(before.code, 1); assert.equal(before.json().checks.find(c => c.check === 'joined').ok, false);
  await agent(h, '统计完成：{"alpha": 5, "beta": 1}');
  const verdict = blind(['judge', '--home', h]); assert.equal(verdict.code, 0, JSON.stringify(verdict.json())); assert.equal(verdict.json().roomChecksPassed, true);
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
  const failed = verdict.json().checks.filter(c => !c.ok).map(c => c.check).sort();
  assert.deepEqual(failed, ['correct', 'roomNoIntervention', 'roomNoKnownSecrets']);
});
