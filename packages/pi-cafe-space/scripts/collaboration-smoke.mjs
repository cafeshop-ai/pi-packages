// Isolated real-HTTP/browser check. Never attaches to a user's Pi, browser or room.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
const { values } = parseArgs({ options: { binary: { type: 'string' }, browser: { type: 'string' }, out: { type: 'string' } } });
assert(values.binary, '--binary must select an independently verified native Relay');
const binary = resolve(values.binary), temporary = await mkdtemp(join(tmpdir(), 'cafe-collab-smoke-'));
const reserve = createServer(); await new Promise((ok, no) => { reserve.once('error', no); reserve.listen(0, '127.0.0.1', ok); });
const port = reserve.address().port; await new Promise(ok => reserve.close(ok)); const origin = `http://127.0.0.1:${port}`;
const config = join(temporary, 'cloud.json'), data = join(temporary, 'discussions');
await writeFile(config, JSON.stringify({ mode: 'cloud', publicOrigin: origin, roomAccess: true, enableWebRTC: true }), { mode: 0o600 });
const env = {}; for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (process.env[name]) env[name] = process.env[name];
Object.assign(env, { PI_COLLAB_HOST: '127.0.0.1', PI_COLLAB_PORT: String(port), PI_COLLAB_HOST_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_CLIENT_TOKEN: randomBytes(32).toString('base64url'), PI_COLLAB_ALLOWED_ORIGINS: origin, PI_CAFE_REMOTE_CONFIG: config, PI_CAFE_COLLAB_DIRECTORY: data });
let child, browser, browserOut; const checks = [], errors = [];
const launch = async () => {
  child = spawn(binary, [], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); child.on('error', e => errors.push(e.message));
  child.stdout.on('data', () => {}); child.stderr.on('data', b => errors.push(String(b).slice(0, 1000)));
  for (let i = 0; i < 60; i++) { if (child.exitCode !== null || errors.length) throw Error('isolated Relay did not start'); try { if ((await fetch(origin + '/healthz')).ok) return; } catch {} await sleep(100); }
  throw Error('isolated Relay timed out');
};
const stop = async () => { if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise(ok => child.once('exit', ok)); child.kill(); await exited; };
const api = async (body, token, expected = 200, requestOrigin) => {
  const result = await fetch(origin + '/api/collaboration', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(body) });
  assert.equal(result.status, expected, 'HTTP status mismatch for ' + body.op); return result.json();
};
try {
  await launch();
  const owner = await api({ op: 'create', title: '隔离协作验收', name: '测试房主', kind: 'human' });
  const invite = await api({ op: 'invite', roomId: owner.roomId }, owner.token);
  const ai = await api({ op: 'join', roomId: owner.roomId, invite: invite.invite, name: '外部 HTTP AI', kind: 'ai' });
  const secondInvite = await api({ op: 'invite', roomId: owner.roomId }, ai.token);
  const colleague = await api({ op: 'join', roomId: owner.roomId, invite: secondInvite.invite, name: '第二位同事', kind: 'human' });
  const question = { op: 'send', roomId: owner.roomId, id: 'smoke-question-1', text: '请核对接口版本。', to: ai.memberId };
  await api(question, owner.token); await api(question, owner.token);
  await api({ op: 'send', roomId: owner.roomId, id: 'smoke-answer-1', text: '已核对：提交 abc123；这是合成 HTTP 回复，不是模型调用。', replyTo: 1, to: owner.memberId }, ai.token);
  let snapshot = await api({ op: 'read', roomId: owner.roomId }, colleague.token);
  assert.equal(snapshot.messages.length, 2); assert.equal(snapshot.members.length, 3); assert(!JSON.stringify(snapshot).includes(owner.token)); checks.push('three independent HTTP members, forwarded invitation, addressed reply and idempotent delivery');
  await api({ op: 'read', roomId: owner.roomId }, undefined, 401); await api({ op: 'status' }, undefined, 403, 'https://untrusted.example'); checks.push('anonymous reads and cross-origin writes denied');
  assert.deepEqual((await api({ op: 'status' })).features, ['wait', 'ack', 'pause']);
  const waiting = api({ op: 'read', roomId: owner.roomId, after: 2, wait: 10 }, ai.token); await sleep(300); const woke = Date.now();
  await api({ op: 'send', roomId: owner.roomId, id: 'smoke-wake-1', text: '唤醒等待中的 AI。' }, colleague.token);
  const woken = await waiting; assert.equal(woken.messages.length, 1); assert(Date.now() - woke < 3000, 'long poll was not woken promptly');
  await api({ op: 'ack', roomId: owner.roomId, fetched: woken.cursor, delivered: woken.cursor }, ai.token);
  assert.equal((await api({ op: 'read', roomId: owner.roomId }, owner.token)).presence[ai.memberId].delivered, 3);
  const credentials = join(temporary, 'member.json'); await writeFile(credentials, JSON.stringify({ roomId: owner.roomId, memberId: ai.memberId, token: ai.token }), { mode: 0o600 });
  const watcher = spawn(process.execPath, [fileURLToPath(new URL('./collaboration-watch.mjs', import.meta.url)), '--credentials', credentials, '--origin', origin, '--cursor', '3', '--authorized', owner.memberId], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = []; watcher.stdout.on('data', b => lines.push(...String(b).split('\n').filter(Boolean)));
  try {
    for (let i = 0; i < 50 && !lines.some(l => l.startsWith('[watch]')); i++) await sleep(100);
    assert(lines.some(l => l.includes('long-poll wait') && l.includes('reporting ack')), 'watcher did not detect wait/ack');
    await sleep(300); await api({ op: 'send', roomId: owner.roomId, id: 'smoke-watch-1', text: '给后台监听的消息。', to: ai.memberId }, owner.token);
    await api({ op: 'send', roomId: owner.roomId, id: 'smoke-watch-2', text: '范围外成员的消息。' }, colleague.token);
    for (let i = 0; i < 50 && lines.filter(l => l.startsWith('[msg')).length < 2; i++) await sleep(100);
    assert(lines.some(l => l.startsWith('[msg #4] ') && l.includes('→ @我') && l.includes('给后台监听的消息')), 'watcher missed the addressed message');
    assert(lines.some(l => l.startsWith('[msg #5 · 授权范围外]')), 'watcher did not mark an out-of-scope sender');
    assert(!lines.join('\n').includes(ai.token), 'watcher printed a credential');
    let delivered = 0; for (let i = 0; i < 30 && delivered < 5; i++) { delivered = (await api({ op: 'read', roomId: owner.roomId }, owner.token)).presence[ai.memberId]?.delivered ?? 0; if (delivered < 5) await sleep(100); }
    assert.equal(delivered, 5, 'watcher did not ack delivery');
  } finally { watcher.kill(); }
  checks.push('background watcher: long-poll wake-up, out-of-scope marking, ack delivered, no credential output');
  await api({ op: 'pause', roomId: owner.roomId, paused: true }, ai.token, 403); await api({ op: 'pause', roomId: owner.roomId, paused: true }, owner.token);
  await api({ op: 'send', roomId: owner.roomId, id: 'smoke-ai-paused', text: '暂停期间的 AI 发言。' }, ai.token, 409);
  checks.push('long-poll wait woken by a new message, connector ack presence, owner-only AI pause enforced on AI sends');
  await stop(); await launch(); snapshot = await api({ op: 'read', roomId: owner.roomId }, ai.token); assert.equal(snapshot.messages.length, 5); assert.equal(snapshot.aiPaused, true); assert.deepEqual(snapshot.presence, {}); checks.push('restart retains membership, message history and AI pause; presence restarts empty');
  if (values.browser) {
    const { chromium } = await import('playwright-core'); browser = await chromium.launch({ executablePath: resolve(values.browser), headless: true });
    const context = await browser.newContext(); const page = await context.newPage(); const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(origin + '/#/collab'); await page.getByLabel('房间名称').fill('浏览器多人讨论'); await page.getByLabel('你的名称', { exact: true }).fill('浏览器房主'); await page.getByRole('button', { name: '创建协作房间' }).click();
    await page.getByRole('button', { name: '邀请同事 / AI' }).click(); const url = await page.getByLabel('邀请链接', { exact: true }).inputValue();
    await page.getByText('让我的 AI 加入 · 无需安装').click(); const instructions = await page.getByLabel('AI 接入说明').inputValue(); assert(instructions.includes('/api/collaboration/guide')); assert(!instructions.includes(owner.token));
    const otherContext = await browser.newContext(); const other = await otherContext.newPage(); other.on('pageerror', error => pageErrors.push(error.message));
    await other.goto(url); await other.getByLabel('你的名称', { exact: true }).fill('浏览器同事'); await other.getByRole('button', { name: '同意并加入' }).click();
    await other.getByLabel('消息', { exact: true }).fill('来自独立浏览器的消息'); await other.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('来自独立浏览器的消息', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '收起邀请', exact: true }).click();
    const out = resolve(values.out ?? '.refactor/collaboration-browser'); await mkdir(out, { recursive: true });
    for (const [width, height] of [[1440, 900], [1280, 720], [390, 844], [320, 700]]) {
      await page.setViewportSize({ width, height }); await sleep(100);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
      await page.screenshot({ path: join(out, `discussion-${width}.png`), fullPage: true });
    }
    await other.reload(); await other.getByRole('heading', { name: '浏览器多人讨论', exact: true }).waitFor(); assert.deepEqual(pageErrors, []);
    const home = await context.newPage(); await home.setViewportSize({ width: 320, height: 700 }); await home.goto(origin + '/');
    await home.getByRole('button', { name: '中文', exact: true }).click(); await home.getByRole('link', { name: '协作房间 · 人与 AI' }).waitFor();
    assert(await home.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'computer-room homepage overflows at 320px');
    await home.getByRole('link', { name: '协作房间 · 人与 AI' }).click(); await home.getByRole('heading', { name: '一起讨论，不限工具。' }).waitFor();
    await otherContext.close(); await context.close(); await browser.close(); browser = undefined;
    checks.push('two isolated browsers: create, invite, consent join, message sync, refresh and AI instructions'); checks.push('desktop/short laptop/390px/320px layout with zero horizontal overflow or page errors');
    browserOut = out; checks.push('computer-room homepage retains accessible narrow-screen collaboration navigation');
  }
  await api({ op: 'remove', roomId: owner.roomId, memberId: ai.memberId }, owner.token); await api({ op: 'read', roomId: owner.roomId }, ai.token, 401);
  await api({ op: 'revoke', roomId: owner.roomId }, owner.token); await api({ op: 'join', roomId: owner.roomId, invite: secondInvite.invite, name: 'stale', kind: 'ai' }, undefined, 403);
  await api({ op: 'close', roomId: owner.roomId }, owner.token); await api({ op: 'read', roomId: owner.roomId }, colleague.token, 410); checks.push('owner removal, revocation and closure enforced by backend');
  if (browserOut) await writeFile(join(browserOut, 'result.json'), JSON.stringify({ passed: checks, providerRequests: 0, productionTouched: false }, null, 2));
  console.log(JSON.stringify({ passed: checks, providerRequests: 0, productionTouched: false }, null, 2));
} finally { if (browser) await browser.close(); await stop(); await rm(temporary, { recursive: true, force: true }); }
