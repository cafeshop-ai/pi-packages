// Stability drill for collaboration rooms: runs a native Relay and the real background
// watcher, injects failures and checks that every message reaches the watcher exactly once.
// Never touches a user's Pi, browser or production room.
//   node scripts/collaboration-drill.mjs --binary /absolute/path/to/pi-cafe-relay
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const { values } = parseArgs({ options: { binary: { type: 'string' } } });
assert(values.binary, '--binary must select an independently verified native Relay');
const binary = resolve(values.binary), temporary = await mkdtemp(join(tmpdir(), 'cafe-collab-drill-'));
const reserve = createServer(); await new Promise((ok, no) => { reserve.once('error', no); reserve.listen(0, '127.0.0.1', ok); });
const port = reserve.address().port; await new Promise(ok => reserve.close(ok)); const origin = `http://127.0.0.1:${port}`;
const config = join(temporary, 'cloud.json'); await writeFile(config, JSON.stringify({ mode: 'cloud', publicOrigin: origin, roomAccess: true, enableWebRTC: true }), { mode: 0o600 });
const env = { PATH: process.env.PATH ?? '', PI_COLLAB_HOST: '127.0.0.1', PI_COLLAB_PORT: String(port), PI_COLLAB_HOST_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_CLIENT_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_ALLOWED_ORIGINS: origin, PI_CAFE_REMOTE_CONFIG: config, PI_CAFE_COLLAB_DIRECTORY: join(temporary, 'data') };
const watcherPath = fileURLToPath(new URL('./collaboration-watch.mjs', import.meta.url));
let relay, watcher; const lines = []; const checks = [];
const startRelay = async () => {
  relay = spawn(binary, [], { env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(origin + '/healthz')).ok) return; } catch {} await sleep(100); }
  throw Error('Relay did not start');
};
const stopRelay = async () => { if (relay?.exitCode !== null) return; const exited = new Promise(ok => relay.once('exit', ok)); relay.kill(); await exited; };
const api = async (body, token, expected = 200) => {
  const r = await fetch(origin + '/api/collaboration', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  assert.equal(r.status, expected, `${body.op} returned ${r.status}`); return r.json();
};
const startWatcher = (credentials, state) => {
  watcher = spawn(process.execPath, [watcherPath, '--credentials', credentials, '--state', state, '--origin', origin], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  watcher.stdout.on('data', b => lines.push(...String(b).split('\n').filter(Boolean)));
};
const stopWatcher = async () => { if (watcher?.exitCode !== null || watcher.signalCode) return; const exited = new Promise(ok => watcher.once('exit', ok)); watcher.kill('SIGKILL'); await exited; };
const seen = () => lines.filter(l => l.startsWith('[msg #')).map(l => Number(/^\[msg #(\d+)/.exec(l)[1]));
const until = async (predicate, ms, what) => { for (let i = 0; i < ms / 100; i++) { if (predicate()) return; await sleep(100); } throw Error('timed out waiting for ' + what); };
try {
  await startRelay();
  const owner = await api({ op: 'create', title: '稳定性演练', name: 'Drill owner', kind: 'human' });
  const ai = await api({ op: 'join', roomId: owner.roomId, invite: (await api({ op: 'invite', roomId: owner.roomId }, owner.token)).invite, name: 'Drill AI', kind: 'ai' });
  const credentials = join(temporary, 'member.json'), state = join(temporary, 'cursor.txt');
  await writeFile(credentials, JSON.stringify({ roomId: owner.roomId, memberId: ai.memberId, token: ai.token }), { mode: 0o600 });
  const say = (id, text) => api({ op: 'send', roomId: owner.roomId, id, text, to: ai.memberId }, owner.token);
  startWatcher(credentials, state); await until(() => lines.some(l => l.startsWith('[watch]')), 5000, 'watcher start');

  await say('drill-message-0001', 'baseline'); await until(() => seen().includes(1), 5000, 'baseline delivery');
  checks.push('baseline: long-poll delivery');

  // 1. The Relay restarts while the watcher is holding a long poll.
  await sleep(300); await stopRelay(); await sleep(1500); await startRelay();
  await say('drill-message-0002', 'after relay restart'); await until(() => seen().includes(2), 40000, 'delivery after relay restart');
  checks.push('relay restart during a long poll: watcher reconnects and delivers');

  // 2. The watcher crashes; messages sent meanwhile arrive once after restart from the saved cursor.
  await stopWatcher(); await say('drill-message-0003', 'while watcher down'); await say('drill-message-0004', 'second while down');
  startWatcher(credentials, state); await until(() => seen().includes(4), 10000, 'catch-up after watcher restart');
  checks.push('watcher crash: restart from persisted cursor catches up');

  // 3. A sender retries an unknown result with the same id.
  const first = await say('drill-message-0005', 'retry me'); const again = await say('drill-message-0005', 'retry me');
  assert.equal(first.seq, again.seq); await until(() => seen().includes(5), 5000, 'retried message');
  checks.push('duplicate send with the same id stores one message');

  // 4. The watcher is frozen (busy host) while several messages arrive; all arrive in order afterwards.
  watcher.kill('SIGSTOP'); for (let i = 6; i <= 9; i++) await say(`drill-message-000${i}`, `burst ${i}`); watcher.kill('SIGCONT');
  await until(() => seen().includes(9), 40000, 'burst after freeze');
  checks.push('frozen watcher: queued burst delivered in order');

  // 5. Pause takes effect for the next AI write and is reported to the watcher.
  await api({ op: 'pause', roomId: owner.roomId, paused: true }, owner.token);
  await api({ op: 'send', roomId: owner.roomId, id: 'drill-ai-paused', text: 'should be rejected' }, ai.token, 409);
  await until(() => lines.some(l => l.includes('房间已暂停 AI 发言')), 40000, 'pause notice');
  checks.push('pause: AI writes rejected immediately and the watcher reports it');

  const order = seen(); const unique = new Set(order);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'messages out of order');
  assert.equal(unique.size, order.length, `duplicates delivered: ${order}`);
  assert.deepEqual([...unique], [1, 2, 3, 4, 5, 6, 7, 8, 9], `lost messages: ${order}`);
  checks.push('across all failures: 9/9 messages delivered, 0 lost, 0 duplicated, in order');
  console.log(JSON.stringify({ passed: checks, providerRequests: 0, productionTouched: false }, null, 2));
} finally { await stopWatcher().catch(() => {}); await stopRelay().catch(() => {}); await rm(temporary, { recursive: true, force: true }); }
