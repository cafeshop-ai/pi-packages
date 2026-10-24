import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const client = fileURLToPath(new URL('./space-agent.mjs', import.meta.url));
const until = async (check, timeout = 3000) => { for (let i = 0; i < timeout / 20; i++) { if (check()) return; await sleep(20); } throw Error('condition timed out'); };
async function fixture(t, text = 'external data') {
  const home = await mkdtemp(join(tmpdir(), 'space-delivery-')); chmodSync(home, 0o700);
  const roomId = 'a'.repeat(32), memberId = 'b'.repeat(32), token = 'c'.repeat(64);
  const messages = [{ seq: 1, id: 'message-1', memberId: 'd'.repeat(32), text, at: new Date().toISOString() }];
  const acks = [], wake = new Set(), children = new Set(); let paused = false, revoked = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    const q = JSON.parse(body); assert.equal(req.headers.authorization, 'Bearer ' + token);
    res.setHeader('Content-Type', 'application/json');
    if (revoked) { res.statusCode = 401; res.end('{"error":"MEMBER_REQUIRED"}'); return; }
    if (q.op === 'ack') { acks.push(q); res.end('{}'); return; }
    assert.equal(q.op, 'read');
    const reply = () => res.end(JSON.stringify({ cursor: messages.at(-1)?.seq ?? 0, messages: messages.filter(m => m.seq > q.after), more: false, aiPaused: paused }));
    if (q.wait && q.after >= (messages.at(-1)?.seq ?? 0)) {
      const timer = setTimeout(() => { wake.delete(ready); reply(); }, q.wait * 1000);
      const ready = () => { clearTimeout(timer); wake.delete(ready); reply(); }; wake.add(ready);
      res.on('close', () => { clearTimeout(timer); wake.delete(ready); });
    } else reply();
  });
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const origin = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(home, 'member.json'), JSON.stringify({ origin, roomId, memberId, token }), { mode: 0o600 });
  writeFileSync(join(home, 'state.json'), JSON.stringify({ fetched: 0, consumed: 0, skipped: [] }), { mode: 0o600 });
  const state = () => JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
  const received = () => existsSync(join(home, 'received.jsonl')) ? readFileSync(join(home, 'received.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
  const handler = (code = 'console.log(JSON.stringify({id:event.id,accepted:true}));') => {
    const path = join(home, 'handler');
    writeFileSync(path, `#!${process.execPath}\n(async()=>{const fs=require('node:fs');const event=JSON.parse(fs.readFileSync(0,'utf8'));fs.appendFileSync(${JSON.stringify(join(home, 'received.jsonl'))},JSON.stringify(event)+'\\n',{mode:0o600});${code}})();\n`, { mode: 0o700 });
    return path;
  };
  const start = (args, flags = []) => {
    const child = spawn(process.execPath, [...flags, client, '--home', home, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child); let out = '', err = '';
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    const done = new Promise(ok => child.on('exit', code => { children.delete(child); ok({ code, out, err }); }));
    return { child, done };
  };
  const stop = async run => { run.child.kill('SIGTERM'); const result = await run.done; assert(!result.out.includes(token)); assert(!result.err.includes(token)); return result; };
  t.after(async () => {
    for (const child of children) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
    server.closeAllConnections(); await new Promise(ok => server.close(ok)); await rm(home, { recursive: true, force: true });
  });
  return { home, roomId, memberId, token, messages, acks, state, received, handler, start, stop,
    pause(value) { paused = value; for (const ready of [...wake]) ready(); },
    revoke() { revoked = true; },
    notify() { for (const ready of [...wake]) ready(); } };
}

test('generic handler receives full untrusted JSON, never a credential; acceptance survives restart', async t => {
  const text = '$(touch /tmp/never-execute-room-text)\n' + '长消息 '.repeat(1500);
  const f = await fixture(t, text), path = f.handler();
  const first = f.start(['watch', '--handler', path]);
  await until(() => f.state().consumed === 1 && f.acks.some(a => a.delivered === 1));
  const [event] = f.received();
  assert.equal(event.protocol, 'cafe-space-delivery-v1'); assert.equal(event.id, f.roomId + ':1');
  assert.equal(event.untrusted, true); assert.equal(event.message.text, text);
  assert(!JSON.stringify(event).includes(f.token)); assert.equal(f.acks.at(-1).delivered, 1);
  await f.stop(first);
  assert.equal(f.state().deliveryWatcher, undefined, 'graceful stop releases the inbox owner');
  const second = f.start(['watch', '--handler', path]); await until(() => f.acks.length >= 3); await sleep(100);
  await f.stop(second); assert.equal(f.received().length, 1, 'confirmed events must not be replayed');
});

test('wrong, missing and failed receipts stop with an unknown intent; restart never silently redelivers', async t => {
  for (const code of ["console.log('{}');", "console.log('not JSON');", "console.log(JSON.stringify({id:'wrong',accepted:true}));", 'process.exit(1);']) {
    await t.test(code, async t => {
      const f = await fixture(t), path = f.handler(code);
      const result = await f.start(['watch', '--handler', path]).done;
      assert.equal(result.code, 2); assert.equal(f.state().consumed, 0); assert.equal(f.state().delivery.seq, 1);
      assert.equal((await f.start(['watch', '--handler', path]).done).code, 2);
      assert.equal(f.received().length, 1, 'an unknown result cannot be retried automatically');
      assert.equal((await f.start(['retry', '1']).done).code, 0); f.handler();
      const recovered = f.start(['watch', '--handler', path]); await until(() => f.state().consumed === 1); await f.stop(recovered);
      assert.equal(f.received()[0].id, f.received()[1].id, 'explicit retries retain a stable event id');
    });
  }
});

test('pause and an explicit busy receipt keep the message pending instead of pretending delivery', async t => {
  const f = await fixture(t); f.pause(true);
  const path = f.handler('console.log(JSON.stringify({id:event.id,accepted:false}));');
  const run = f.start(['watch', '--handler', path]); await until(() => f.state().fetched === 1); await sleep(100);
  assert.equal(f.received().length, 0); assert.equal(f.state().consumed, 0);
  f.pause(false); await until(() => f.received().length === 1 && !f.state().delivery);
  assert.equal(f.state().consumed, 0);
  writeFileSync(join(f.home, 'state.json'), JSON.stringify({ ...f.state(), goalRevision: 1, goal: null }), { mode: 0o600 });
  assert.equal(JSON.parse((await f.start(['next']).done).out).type, 'goal', 'Goal notifications retain their independent cursor');
  assert.equal((await f.start(['done-goal', '1']).done).code, 0);
  assert.equal(f.state().consumed, 0, 'Goal acknowledgement must not consume the pending chat');
  assert.equal((await f.start(['next']).done).code, 2, 'a busy handler watch still owns the inbox');
  assert.equal((await f.start(['watch', '--handler', path]).done).code, 2);
  f.notify(); await sleep(150); assert.equal(f.received().length, 1, 'a busy receipt must not cause a tight retry loop');
  f.handler(); const wakeAfterBackoff = setTimeout(() => f.notify(), 5200); wakeAfterBackoff.unref();
  await until(() => f.state().consumed === 1, 10000); clearTimeout(wakeAfterBackoff); await f.stop(run);
  assert.equal(f.received().length, 2);
});

test('two watchers cannot invoke the same event concurrently, and live delivery cannot be manually confirmed', async t => {
  const f = await fixture(t), path = f.handler('await new Promise(r=>setTimeout(r,700));console.log(JSON.stringify({id:event.id,accepted:true}));');
  const first = f.start(['watch', '--handler', path]); await until(() => f.received().length === 1);
  assert.equal((await f.start(['watch', '--handler', path]).done).code, 2);
  assert.equal((await f.start(['next']).done).code, 2);
  assert.equal((await f.start(['watch']).done).code, 2);
  assert.match((await f.start(['done', '1']).done).err, /stop the delivery process/);
  assert.match((await f.start(['retry', '1']).done).err, /stop the delivery process/);
  await until(() => f.state().consumed === 1); await f.stop(first); assert.equal(f.received().length, 1);
});

test('a SIGKILLed watcher cannot hide an orphan receiver from explicit recovery', async t => {
  const f = await fixture(t), path = f.handler('await new Promise(r=>setTimeout(r,1200));console.log(JSON.stringify({id:event.id,accepted:true}));');
  const first = f.start(['watch', '--handler', path]); await until(() => f.received().length === 1);
  assert(f.state().delivery.handlerPid > 0);
  first.child.kill('SIGKILL'); await first.done;
  assert.match((await f.start(['retry', '1']).done).err, /stop the delivery process/);
  assert.match((await f.start(['done', '1']).done).err, /stop the delivery process/);
  assert.equal(f.state().consumed, 0);
  try { process.kill(f.state().delivery.handlerPid, 'SIGKILL'); } catch {}
});

test('heartbeat continues while a hook is busy; timeout and cancellation never confirm an event', async t => {
  const f = await fixture(t), preload = join(f.home, 'timers.mjs');
  writeFileSync(preload, `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';const original=cp.execFile;cp.execFile=(file,args,options,cb)=>{if(options.timeout!==30000)throw Error('missing bounded delivery deadline');return original(file,args,{...options,timeout:160},cb);};syncBuiltinESMExports();const interval=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms===20000?20:ms,...args);`);
  const path = f.handler('setInterval(()=>{},1000);await new Promise(()=>{});');
  const result = await f.start(['watch', '--handler', path], ['--import', preload]).done;
  assert.equal(result.code, 2); assert.equal(f.state().consumed, 0); assert(f.acks.length >= 3);
  assert(f.acks.every(a => a.delivered === 0));
  assert.equal((await f.start(['retry', '1']).done).code, 0);
  const cancelled = f.start(['watch', '--handler', path]); await until(() => f.received().length === 2); await f.stop(cancelled);
  assert.equal(f.state().consumed, 0); assert.equal((await f.start(['watch', '--handler', path]).done).code, 2);
});

test('only a local-owned absolute executable is allowed, never a shell string or a symlink', async t => {
  const f = await fixture(t), path = f.handler();
  assert.notEqual((await f.start(['watch', '--handler', 'echo room-content']).done).code, 0);
  const link = join(f.home, 'link'); symlinkSync(path, link);
  assert.notEqual((await f.start(['watch', '--handler', link]).done).code, 0);
  chmodSync(path, 0o777); assert.notEqual((await f.start(['watch', '--handler', path]).done).code, 0);
  assert.equal(f.received().length, 0);
});

test('revoked membership stops the listener, releases its owner and keeps uncertain delivery unconfirmed', async t => {
  const f = await fixture(t), preload = join(f.home, 'heartbeat.mjs');
  writeFileSync(preload, 'const original=setInterval;globalThis.setInterval=(fn,ms,...args)=>original(fn,ms===20000?20:ms,...args);');
  const path = f.handler('setInterval(()=>{},1000);await new Promise(()=>{});');
  const run = f.start(['watch', '--handler', path], ['--import', preload]);
  await until(() => f.received().length === 1); f.revoke();
  const result = await run.done;
  assert.equal(result.code, 3, result.err); assert.equal(f.state().consumed, 0);
  assert.equal(f.state().deliveryWatcher, undefined); assert.equal(f.state().delivery.seq, 1);
});
