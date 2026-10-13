#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute, dirname, delimiter } from 'node:path';
import { parseArgs } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import WebSocket from 'ws';

const { values } = parseArgs({ strict: true, options: { binary: { type: 'string' }, candidate: { type: 'string' }, cli: { type: 'string' }, browser: { type: 'string' }, report: { type: 'string' } } });
for (const key of ['binary', 'candidate', 'cli', 'browser']) assert(values[key] && isAbsolute(values[key]), '--'+key+' needs an absolute path');
const binary = await realpath(values.binary), candidate = await realpath(values.candidate), cli = await realpath(values.cli);
const root = await realpath(await mkdtemp(join(tmpdir(), 'cafe-onboarding-')));
const report = values.report ? resolve(values.report) : null;
if (report) await mkdir(report, { recursive: true });
const children = [], sockets = [], checks = [], statuses = [], issues = [];
let browser, relay, pi;
const hash = value => createHash('sha256').update(value).digest('hex');
async function until(fn, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw Error(label + ' timed out');
}
async function freePort() {
  const server = createServer(); await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port; await new Promise(done => server.close(done)); return port;
}
function spawnOwned(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ['pipe','pipe','pipe'] }); children.push(child);
  child.on('error', e => issues.push('spawn:' + e.code)); child.stderr.on('data', () => {}); return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(done => child.once('exit', done)); child.stdin?.end(); child.kill('SIGTERM');
  await Promise.race([exited, delay(5000)]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
}
async function hello(base, token) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws'); sockets.push(ws);
  return await new Promise((done, fail) => {
    const timer = setTimeout(() => { ws.terminate(); fail(Error('client handshake timeout')); }, 5000);
    ws.on('open', () => ws.send(JSON.stringify({ type:'hello', protocolVersion:1, peerRole:'client', peerId:'setup-verifier-'+randomBytes(4).toString('hex'), roomId:'main', token })));
    ws.on('message', raw => { const value = JSON.parse(raw.toString()); if (value.type === 'welcome' || value.type === 'error') { clearTimeout(timer); ws.close(); done(value.type); } });
    ws.on('error', e => { clearTimeout(timer); fail(e); });
  });
}
try {
  for (const path of ['home','agent','project']) await mkdir(join(root, path), { mode:0o700 });
  await writeFile(join(root,'agent','settings.json'), JSON.stringify({ enableInstallTelemetry:false, enableAnalytics:false, defaultThinkingLevel:'off', extensions:[], skills:[], themes:[], prompts:[], retry:{enabled:false} }), { mode:0o600 });
  const port = await freePort(), base = `http://127.0.0.1:${port}`, file = join(root,'private','credentials.json');
  const env = { HOME:join(root,'home'), USERPROFILE:join(root,'home'), TMPDIR:root, TEMP:root, TMP:root, PATH:dirname(process.execPath)+delimiter+(process.env.PATH??''), PI_CAFE_CREDENTIALS_FILE:file, PI_COLLAB_HOST:'127.0.0.1', PI_COLLAB_PORT:String(port) };
  for (const key of ['SystemRoot','WINDIR']) if (process.env[key]) env[key] = process.env[key];
  const startRelay = () => { const child = spawnOwned(binary, [], env); child.stdout.resume(); return child; };
  relay = startRelay();
  await until(async () => { try { return (await fetch(base+'/healthz')).ok; } catch { return false; } }, 'relay health');
  assert.equal((await (await fetch(base+'/api/config')).json()).setupRequired, true);
  assert.equal((await fetch(base+'/ws')).status, 423);
  await assert.rejects(stat(file), { code:'ENOENT' }); checks.push('Uninitialized relay refuses business access and has no saved credentials');
  pi = spawnOwned(process.execPath, [cli,'--mode','rpc','--offline','--no-extensions','-e',join(candidate,'dist/extension/index.js'),'--no-tools','--no-approve','--no-session','--no-context-files','--no-skills','--no-prompt-templates','--no-themes'], { ...env, PI_CODING_AGENT_DIR:join(root,'agent'), PI_COLLAB_RELAY_URL:base.replace('http:','ws:')+'/ws', PI_COLLAB_PEER_ID:'onboarding-test-pi' });
  let pending = '';
  pi.stdout.on('data', bytes => { pending += bytes.toString(); let index; while ((index = pending.indexOf('\n')) >= 0) { const line = pending.slice(0,index); pending = pending.slice(index+1); try { const event = JSON.parse(line); if (event.type === 'extension_ui_request' && event.method === 'setStatus') statuses.push(event.statusText); } catch {} } if (pending.length > 65536) pending = ''; });
  await until(() => statuses.includes('café space: setup required'), 'native setup status');
  browser = await chromium.launch({ executablePath:values.browser, headless:true, chromiumSandbox:true });
  const context = await browser.newContext({ viewport:{width:1280,height:900} }); const page = await context.newPage(); let browserWelcome = false;
  page.on('pageerror', e => issues.push('browser:'+e.name));
  page.on('websocket', ws => ws.on('framereceived', frame => { try { const m = JSON.parse(String(frame.payload)); if (m.type === 'welcome' && m.peerRole === 'client') browserWelcome = true; } catch {} }));
  await page.goto(base); await page.getByRole('button',{name:'中文',exact:true}).click();
  await page.getByRole('heading',{name:'初始化访问令牌',exact:true}).waitFor();
  await page.getByRole('button',{name:'保存并进入 Café Space',exact:true}).waitFor();
  const geometry = await page.evaluate(() => {
    const card = document.querySelector('section[aria-labelledby="cafe-setup-title"]');
    const input = card.querySelector('input'); const label = card.querySelector('label');
    const button = card.querySelector('button[type="submit"]');
    return { width:card.getBoundingClientRect().width,height:card.getBoundingClientRect().height,inputHeight:input.getBoundingClientRect().height,labelOffset:Math.abs(label.getBoundingClientRect().left-input.getBoundingClientRect().left),buttonHeight:button.getBoundingClientRect().height,labelAlign:getComputedStyle(label).textAlign,headingSize:parseFloat(getComputedStyle(card.querySelector('h2')).fontSize),backgroundImage:getComputedStyle(card).backgroundImage };
  });
  assert(geometry.width <= 440 && geometry.height <= 600, 'setup should be a compact workspace panel');
  assert(geometry.inputHeight === 40 && geometry.buttonHeight <= 44 && geometry.labelOffset <= 1 && geometry.labelAlign === 'left' && geometry.headingSize <= 24);
  assert.equal(geometry.backgroundImage,'none');
  if (report) { await page.screenshot({path:join(report,'setup-desktop.png'),fullPage:true}); await page.locator('section[aria-labelledby="cafe-setup-title"]').screenshot({path:join(report,'setup-card.png')}); }
  for (const width of [320,390]) {
    await page.setViewportSize({width,height:844});
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1), 'setup mobile overflow');
    const button = await page.getByRole('button',{name:'保存并进入 Café Space',exact:true}).boundingBox();
    assert(button && button.y+button.height <= 844,'save button fits mobile viewport');
  }
  if (report) await page.screenshot({path:join(report,'setup-mobile.png'),fullPage:true});
  checks.push('Original workspace tokens, compact 440px panel, left-aligned labels, inline controls and 320/390px layout verified');
  await page.getByRole('button',{name:'English',exact:true}).click();
  await page.getByRole('heading',{name:'Set up your access token',exact:true}).waitFor();
  await page.getByRole('button',{name:'Generate random token',exact:true}).click();
  assert.match(await page.getByLabel('Access token',{exact:true}).inputValue(), /^[a-f0-9]{20}$/);
  await assert.rejects(stat(file), {code:'ENOENT'});
  const token = '123456'; // Deliberately simple, confined to this temporary test service.
  await page.getByLabel('Access token',{exact:true}).fill(token);
  await page.getByLabel('Confirm token',{exact:true}).fill('Other-Token_7a9Qp2Lm!');
  await page.getByRole('button',{name:'Save and open Café Space',exact:true}).click();
  await page.getByRole('alert').filter({hasText:'do not match'}).waitFor();
  await assert.rejects(stat(file), {code:'ENOENT'});
  checks.push('Real webpage offers custom/generated tokens, checks confirmation, and never saves merely on page load or generation');
  await page.getByLabel('Confirm token',{exact:true}).fill(token);
  await page.getByRole('button',{name:'Save and open Café Space',exact:true}).click();
  await until(() => statuses.includes('café space: connected'), 'same Pi connects after setup');
  await until(() => browserWelcome, 'browser automatic authentication');
  assert.equal(await page.getByRole('heading',{name:'Set up your access token',exact:true}).count(),0);
  const bytes = await readFile(file), credentials = JSON.parse(bytes);
  const roomConfig = join(root,'room-device.json');
  await writeFile(roomConfig,JSON.stringify({mode:'device',publicOrigin:'https://rooms.example',cloudUrl:'wss://rooms.example/room/host',roomIdentityFile:join(root,'identity','room.json'),enableWebRTC:true,rooms:['main'],maxRole:'operator'}),{mode:0o600});
  const roomCheck = spawnSync(process.execPath,[join(candidate,'scripts/remote/room-run.mjs'),'--config',roomConfig,'--credentials',file,'--check'],{encoding:'utf8',timeout:15000});
  assert.equal(roomCheck.status,0,roomCheck.stderr);assert.equal(JSON.parse(roomCheck.stdout).valid,true);
  checks.push('Packaged room launcher reads the same private credentials/configuration under the actual Pi Node runtime');
  assert.equal(credentials.clientToken,token); assert.notEqual(credentials.hostToken,token);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777,0o600);
  const state = await (await fetch(base+'/api/setup',{headers:{'X-Cafe-Setup':'1'}})).json();
  assert.deepEqual(state,{required:false});
  assert.equal(await hello(base,'local-dev-client-token'),'error');
  assert.equal(await hello(base,token),'welcome');
  checks.push('Simple custom token authenticates without complexity rules, old default fails, and running Pi adopts its separate private host key');
  const other = await browser.newContext(); const second = await other.newPage();
  await second.goto(base); await second.getByRole('button',{name:'English',exact:true}).click();
  await second.getByLabel('Client token',{exact:true}).waitFor();
  assert.equal(await second.getByRole('heading',{name:'Set up your access token',exact:true}).count(),0); await other.close();
  const reconnectStart = statuses.length; await stop(relay); relay = startRelay();
  await until(async () => { try { const r = await fetch(base+'/api/config'); return r.ok && !(await r.json()).setupRequired; } catch { return false; } }, 'saved setup after restart');
  await until(() => statuses.slice(reconnectStart).includes('café space: connected'), 'Pi reconnect after relay restart');
  assert.equal(hash(await readFile(file)),hash(bytes));
  assert.equal(await hello(base,token),'welcome');
  assert(statuses.every(s => s.startsWith('café space: ')));
  checks.push('Second browser sees sign-in, restart preserves credentials and Pi reconnects with the new status prefix');
  assert.deepEqual(issues,[]);
  const result = {passed:true,checks,providerRequests:0,piRestartedForSetup:false,platform:process.platform,browser:await browser.version(),node:process.version,scope:'isolated loopback server, temporary credentials, real native Pi and independent browser; live user token not initialized'};
  if(report) await writeFile(join(report,'result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result,null,2));
} catch (error) {
  const result = {passed:false,checks,error:String(error.message),statuses,issues,providerRequests:0};
  if(report) await writeFile(join(report,'result.json'),JSON.stringify(result,null,2)); console.error(JSON.stringify(result,null,2)); process.exitCode=1;
} finally {
  for (const ws of sockets) ws.terminate(); await browser?.close().catch(()=>{});
  for (const child of children.reverse()) await stop(child);
  await rm(root,{recursive:true,force:true});
}
