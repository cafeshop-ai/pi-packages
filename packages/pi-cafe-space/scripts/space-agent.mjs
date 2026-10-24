#!/usr/bin/env node
// space-agent: a POSIX preview client for Café Space collaboration rooms.
// It keeps the member token in a private directory and never prints it, keeps
// one local inbox where "fetched" and "consumed" are separate, and recovers each
// write according to what the protocol can prove (see RECOVERY below).
// It never calls a model directly or executes room content; an optional trusted
// local handler can hand events to a host session under the user's authorization.
//
//   space-agent --home <private dir> preview            < invite link on stdin
//   space-agent --home <dir> join --name <name, at most 16 chars> [--kind ai|human] [--agent claude-code|codex|pi|…]   < invite link
//   space-agent --home <dir> status | read [--after N]
//   space-agent --home <dir> sync [--wait 25]          fetch into the inbox, report ack
//   space-agent --home <dir> next | done <seq> | skip <seq> --reason <text>
//   space-agent --home <dir> watch                     sync forever; prints every unconsumed message once per run,
//                                                      replaying the backlog on start
//   space-agent --home <dir> watch --handler /trusted/executable
//                                                      deliver JSON on stdin; consume only after a matching receipt
//   space-agent --home <dir> retry <seq>                explicitly retry an unknown handler delivery after checking the host
//   space-agent --home <dir> send --text-file <f> [--to id] [--reply seq] [--id id]
//   space-agent --home <dir> task create --title <t> [--assignee id] [--from seq] [--id id]
//   space-agent --home <dir> task claim <taskId>
//   space-agent --home <dir> task update <taskId> [--status s] [--assignee id] [--result seq] [--title t]
//   space-agent --home <dir> task delete <taskId>
//   space-agent --home <dir> goal read
//   space-agent --home <dir> goal create --title <t> --criteria-file <f> --reviewer <human id> --revision <n>
//   space-agent --home <dir> goal pause|resume|delete|reviewer|submit|accept|reject <goalId> --revision <n> [--reviewer id] [--result seq]
//   space-agent --home <dir> done-goal <revision>      confirms a next/watch Goal notification, not Goal completion
//   space-agent --home <dir> unlock                    recovery: clear a lock left by a process that died
//
// RECOVERY (unknown result = network error, timeout or 5xx):
//   read, preview, ack ............ retried freely (ack only moves forward)
//   send, task create ............. retried with the same id and body; ID_CONFLICT stops. Without --id the id
//                                   is derived from the content, so re-running the same command after an
//                                   unknown result (exit 2, id printed) reuses it
//   task claim .................... retried; the server returns a claimed task unchanged
//   task update, task delete ...... never retried: the intent is recorded, the task read back
//   join .......................... never retried: it may have created a member
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { closeSync, constants, fsyncSync, ftruncateSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, appendFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { consumeGoal, goalState, mergeGoal, pendingGoal } from './collaboration-goal.mjs';

class Fail extends Error { constructor(message, code = 1) { super(message); this.exit = code; } }
const secrets = new Set();
const clean = text => { let out = String(text); for (const s of secrets) if (s) out = out.split(s).join('[secret]'); return out; };
const print = value => process.stdout.write(clean(typeof value === 'string' ? value : JSON.stringify(value)) + '\n');

// --- private storage -------------------------------------------------------
function privateHome(home) {
  if (process.platform === 'win32') throw new Fail('space-agent is a POSIX preview client: Windows private-directory ACLs are not supported yet');
  if (!home || !home.startsWith('/')) throw new Fail('--home must be an absolute private directory');
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  const info = lstatSync(home);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Fail(`${home} must be a directory you own with mode 0700`);
  return home;
}
function readPrivate(path, fallback) {
  if (!existsSync(path)) return fallback;
  const info = lstatSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) throw new Fail(`${path} must be a file you own with mode 0600`);
  return readFileSync(path, 'utf8');
}
// writeSync may legally write fewer bytes than asked: keep going until all of it is written, and
// treat a write that makes no progress as a failure rather than a finished file.
function writeAll(fd, text, position = 0) {
  const data = Buffer.from(text);
  for (let done = 0; done < data.length;) {
    const n = writeSync(fd, data, done, data.length - done, position + done);
    if (n <= 0) throw new Fail(`write made no progress after ${done} of ${data.length} bytes`);
    done += n;
  }
}
function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeAll(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path); syncDirectory(dirname(path));
}
// A rename survives power loss only once the directory entry is on disk too.
function syncDirectory(path) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
const readJSON = (path, fallback) => { const text = readPrivate(path, null); return text === null ? fallback : JSON.parse(text); };

// --- one writer at a time ----------------------------------------------------
// Every change to state.json and inbox.jsonl is a short transaction under a lock file: re-read,
// change, write. Network waits never hold the lock, so a long poll cannot block done, and no
// writer saves a copy of the state it loaded before waiting.
// The lock is written in full first and linked into place, so it never exists empty. A lock left
// by a process that died is never taken over automatically, since no check-then-replace is
// atomic: commands stop and say so, and `unlock` clears it once the user is sure no other
// space-agent uses this home.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const lockPath = home => join(home, 'state.lock');
const holder = home => { try { return Number(readFileSync(lockPath(home), 'utf8').split(' ')[0]) || 0; } catch { return -1; } };
async function transact(home, change) {
  const lock = lockPath(home); const mine = `${process.pid} ${randomUUID()}\n`; const draft = `${lock}.${process.pid}.${randomUUID()}`;
  writeFileSync(draft, mine, { mode: 0o600, flag: 'wx' });
  try {
    for (const started = Date.now(); ;) {
      try { linkSync(draft, lock); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const pid = holder(home);
      if (pid > 0 && !alive(pid)) throw new Fail(`a space-agent process (pid ${pid}) ended while holding ${lock}; once no other space-agent uses this home, run: space-agent --home <dir> unlock`);
      if (Date.now() - started > 15_000) throw new Fail(`state is locked by another space-agent process (${lock})`);
      await sleep(20);
    }
  } finally { unlinkSync(draft); }
  try { const state = loadState(home); const value = change(state); writePrivate(statePath(home), JSON.stringify(state)); return value; }
  finally { unlinkSync(lock); }
}

// --- invite and network ----------------------------------------------------
function parseInvite(text) {
  const match = /(https?:\/\/[^\s#]+)\/?#\/collab\/([a-f0-9]{32})\?invite=([a-f0-9]{64})/.exec(text);
  if (!match) throw new Fail('stdin must contain a full invite link (…/#/collab/<room>?invite=<secret>)');
  const origin = new URL(match[1]).origin; secrets.add(match[3]);
  return { origin: checkOrigin(origin), roomId: match[2], invite: match[3] };
}
function checkOrigin(origin) {
  const url = new URL(origin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Fail('only https origins are allowed (http only on loopback)');
  return url.origin;
}
class Unknown extends Error {}
// The deadline covers a long poll's whole wait: a quiet room is healthy, not a failure.
async function call(origin, body, token, timeout = ((body.wait ?? 0) + 20) * 1000) {
  let response;
  try {
    response = await fetch(origin + '/api/collaboration', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch (error) {
    // A refused redirect is a configuration problem, not a transient failure worth retrying.
    if (/redirect/i.test(String(error.cause?.message ?? error.message))) throw new Fail('redirects are not followed; check the room origin');
    throw new Unknown(error.message);
  }
  if (response.status >= 500) throw new Unknown(`HTTP ${response.status}`);
  let json = {}; try { json = await response.json(); } catch {}
  return { status: response.status, json, retryAfter: Number(response.headers.get('Retry-After')) || 60 };
}
async function retrying(origin, body, token, attempts = 4) {
  for (let i = 0, wait = 1000; ; i++, wait *= 2) {
    try { return await call(origin, body, token); }
    catch (error) { if (!(error instanceof Unknown) || i + 1 >= attempts) throw error; await sleep(wait); }
  }
}
const failed = result => new Fail(`${result.status} ${result.json.error ?? 'request failed'}`, result.status === 401 || result.status === 410 ? 3 : 1);

// --- member state ----------------------------------------------------------
function member(home) {
  const m = readJSON(join(home, 'member.json'), null);
  if (!m) throw new Fail('not joined: run join first');
  secrets.add(m.token); return m;
}
const statePath = home => join(home, 'state.json');
const loadState = home => readJSON(statePath(home), { fetched: 0, consumed: 0, skipped: [] });
// Readers outside the lock may meet a line still being appended: only newline-terminated lines count.
const inbox = home => (readPrivate(join(home, 'inbox.jsonl'), '') ?? '').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line));
// Runs inside a transaction and reaches the disk before the fetched cursor is committed. A crash
// can leave a half-written last line, or whole lines past the cursor: the half line is cut off
// and its message fetched again, and a message already in the inbox is never added twice.
function appendInbox(home, messages) {
  const path = join(home, 'inbox.jsonl');
  if (!existsSync(path)) writePrivate(path, '');
  const text = readPrivate(path, ''); const complete = text.slice(0, text.lastIndexOf('\n') + 1);
  const known = new Set(complete.split('\n').filter(Boolean).map(line => JSON.parse(line).seq));
  const lines = messages.filter(m => !known.has(m.seq)).map(m => JSON.stringify({ seq: m.seq, id: m.id, memberId: m.memberId, text: m.text, to: m.to, replyTo: m.replyTo, at: m.at }) + '\n').join('');
  if (complete.length === text.length && !lines) return;
  const fd = openSync(path, 'r+'); const at = Buffer.byteLength(complete);
  try { ftruncateSync(fd, at); writeAll(fd, lines, at); fsyncSync(fd); } finally { closeSync(fd); }
}
/** The next message that needs the agent: own messages are recorded as skipped, never silently consumed. */
function pending(home, m, state) {
  for (const message of inbox(home)) {
    if (message.seq <= state.consumed) continue;
    if (message.memberId === m.memberId) { state.consumed = message.seq; state.skipped.push({ seq: message.seq, reason: 'own message' }); continue; }
    return message;
  }
  return null;
}
function checkHandler(path) {
  if (!path.startsWith('/')) throw new Fail('--handler must be an absolute executable path chosen by the local user');
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o022 || !(info.mode & 0o111)) throw new Fail('--handler must be an executable file you own, not writable by others');
}
async function watchHandler(home, path) {
  checkHandler(path);
  const m = member(home); let child; let reporting = false;
  const watcher = { pid: process.pid, id: randomUUID() };
  await transact(home, state => {
    if (state.deliveryWatcher && alive(state.deliveryWatcher.pid)) throw new Fail('a handler watch already owns this inbox; stop it before starting another', 2);
    if (state.delivery) throw new Fail(`delivery #${state.delivery.seq} may already have reached the host; resolve it before restarting`, 2);
    state.deliveryWatcher = watcher;
  });
  const stop = () => { child?.kill('SIGKILL'); process.exit(0); };
  const killChild = () => child?.kill('SIGKILL');
  process.once('SIGINT', stop); process.once('SIGTERM', stop); process.once('exit', killChild);
  const report = async () => {
    if (reporting) return;
    reporting = true;
    try {
      const state = loadState(home);
      const result = await call(m.origin, { op: 'ack', roomId: m.roomId, fetched: state.fetched, delivered: state.consumed, paused: !!state.aiPaused }, m.token);
      if ([401, 403, 404, 410].includes(result.status)) { process.stderr.write('membership unavailable; stopping handler watch\n'); killChild(); process.exit(3); }
    } catch {} finally { reporting = false; }
  };
  const heartbeat = setInterval(() => void report(), 20_000);
  const deliver = async () => {
    const message = await transact(home, state => {
      if (state.delivery) throw new Fail(`delivery #${state.delivery.seq} may already have reached the host; check it, then use done, skip or retry after stopping its process`, 2);
      if (state.aiPaused) return null;
      const next = pending(home, m, state);
      if (next) state.delivery = { seq: next.seq, id: `${m.roomId}:${next.seq}`, pid: process.pid };
      return next;
    });
    if (!message) return null;
    const event = { protocol: 'cafe-space-delivery-v1', id: `${m.roomId}:${message.seq}`, origin: m.origin, roomId: m.roomId, memberId: m.memberId, untrusted: true, message };
    // The executable is local configuration, never room content; no shell, token or text arguments.
    const response = new Promise((ok, no) => {
      child = execFile(path, [], { timeout: 30_000, maxBuffer: 4096, killSignal: 'SIGKILL' }, (error, stdout) => {
        child = undefined;
        if (error) no(new Fail(`delivery #${message.seq} result unknown; inspect the host before done, skip or retry`, 2)); else ok(stdout);
      });
      child.stdin.on('error', () => {});
    });
    response.catch(() => {});
    // Record the child before sending an event: a killed watcher must not hide a still-running receiver.
    const receiver = child;
    await transact(home, state => { state.delivery.handlerPid = receiver.pid ?? 0; });
    receiver.stdin.end(JSON.stringify(event) + '\n');
    const output = await response;
    let receipt;
    try { receipt = JSON.parse(output); } catch {}
    if (receipt?.id !== event.id || typeof receipt.accepted !== 'boolean') throw new Fail(`delivery #${message.seq} has no matching host receipt; not consumed`, 2);
    await transact(home, state => {
      if (state.delivery?.id !== event.id || state.delivery.pid !== process.pid) throw new Fail('delivery changed while waiting for the host; stopping', 2);
      if (receipt.accepted) state.consumed = message.seq;
      delete state.delivery;
    });
    if (receipt.accepted) { await report(); print({ delivered: message.seq, id: event.id }); }
    return receipt.accepted;
  };
  try {
    for (let first = true, backoff = 0; ;) {
      try {
        await sync(home, first ? 0 : 20); first = false; backoff = 0;
        let accepted;
        while ((accepted = await deliver()) === true) await sync(home, 0);
        if (accepted === false) await sleep(5000);
      } catch (error) {
        if (error instanceof Fail) throw error;
        backoff = Math.min(backoff ? backoff * 2 : 2000, 30_000); await sleep(backoff);
      }
    }
  } finally {
    clearInterval(heartbeat); killChild(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); process.removeListener('exit', killChild);
    await transact(home, state => { if (state.deliveryWatcher?.id === watcher.id) delete state.deliveryWatcher; });
  }
}
async function sync(home, wait) {
  const m = member(home); let after = loadState(home).fetched;
  const fetched = [];
  for (let more = true; more;) {
    const result = await retrying(m.origin, { op: 'read', roomId: m.roomId, after, ...(wait ? { wait } : {}) }, m.token);
    if (result.status === 429) { await sleep(result.retryAfter * 1000); continue; }
    if (result.status !== 200) throw failed(result);
    const page = result.json;
    // done, skip or another sync may have run while this one waited: merge into the state on disk now.
    fetched.push(...await transact(home, state => {
      const fresh = page.messages.filter(x => x.seq > state.fetched);
      appendInbox(home, fresh); state.fetched = Math.max(state.fetched, page.cursor); state.aiPaused = page.aiPaused; mergeGoal(state, page); return fresh;
    }));
    after = Math.max(after, page.cursor); more = page.more; wait = 0;
  }
  const state = loadState(home);
  // delivered reports the highest consumed seq: the agent's own confirmation, not proof of understanding.
  try { await call(m.origin, { op: 'ack', roomId: m.roomId, fetched: state.fetched, delivered: state.consumed }, m.token); } catch {}
  return { fetched, state };
}

// Retries inside one run can all fail; the id goes out so a later run can retry the same write.
async function unknownKeepsId(write, id) {
  try { return await write(); }
  catch (error) { if (!(error instanceof Unknown)) throw error; print({ unknown: true, id, note: 'result unknown; run the same command again (or pass --id) to retry this write' }); throw new Fail('write result unknown', 2); }
}

// --- commands --------------------------------------------------------------
const stdin = () => readFileSync(0, 'utf8');
async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    home: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, after: { type: 'string' }, wait: { type: 'string' },
    'text-file': { type: 'string' }, to: { type: 'string' }, reply: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
    'goal-id': { type: 'string' }, revision: { type: 'string' }, reviewer: { type: 'string' }, 'criteria-file': { type: 'string' },
    assignee: { type: 'string' }, agent: { type: 'string' }, from: { type: 'string' }, status: { type: 'string' }, result: { type: 'string' }, reason: { type: 'string' }, handler: { type: 'string' } } });
  const [command, sub, arg] = positionals; const home = privateHome(values.home);
  if (values.handler && command !== 'watch') throw new Fail('--handler is only valid with watch');
  if (command === 'preview' || command === 'join') {
    const invite = parseInvite(stdin());
    if (command === 'preview') {
      const result = await retrying(invite.origin, { op: 'preview', roomId: invite.roomId, invite: invite.invite });
      if (result.status !== 200) throw failed(result); return print(result.json);
    }
    if (existsSync(join(home, 'member.json'))) throw new Fail('this home already holds a membership; use a new --home for another room');
    if (!values.name) throw new Fail('--name is required');
    let result;
    try { result = await call(invite.origin, { op: 'join', roomId: invite.roomId, invite: invite.invite, name: values.name, kind: values.kind ?? 'ai', ...(values.agent ? { agent: values.agent } : {}) }); }
    catch (error) { if (error instanceof Unknown) throw new Fail('join result unknown: a member may have been created; ask the room owner before joining again', 2); throw error; }
    if (result.status !== 200) throw failed(result);
    secrets.add(result.json.token);
    writePrivate(join(home, 'member.json'), JSON.stringify({ origin: invite.origin, roomId: result.json.roomId, memberId: result.json.memberId, token: result.json.token }));
    writePrivate(statePath(home), JSON.stringify({ fetched: 0, consumed: 0, skipped: [] }));
    return print({ joined: true, roomId: result.json.roomId, memberId: result.json.memberId });
  }
  if (command === 'unlock') {
    // Recovery only: the user confirms no other space-agent uses this home.
    const pid = holder(home); if (pid === -1) return print({ unlocked: false, note: 'no lock' });
    if (pid > 0 && alive(pid)) throw new Fail(`pid ${pid} is still running; stop it first`);
    unlinkSync(lockPath(home)); return print({ unlocked: true, previousHolder: pid || 'unknown' });
  }
  if (command === 'status') { const m = member(home); const s = loadState(home); return print({ roomId: m.roomId, memberId: m.memberId, origin: m.origin, fetched: s.fetched, consumed: s.consumed, skipped: s.skipped.length, goal: s.goal ?? null, goalRevision: s.goalRevision ?? 0, goalConsumed: s.goalConsumed ?? 0, ...(s.delivery ? { delivery: s.delivery } : {}), ...(s.deliveryWatcher ? { watcherPid: s.deliveryWatcher.pid } : {}) }); }
  if (command === 'read') {
    // A manual view: it never changes what counts as consumed.
    const m = member(home); const result = await retrying(m.origin, { op: 'read', roomId: m.roomId, after: Number(values.after ?? 0) }, m.token);
    if (result.status !== 200) throw failed(result); return print(result.json);
  }
  if (command === 'sync') { const { fetched, state } = await sync(home, Number(values.wait ?? 0)); return print({ fetched: fetched.length, cursor: state.fetched, consumed: state.consumed, goal: state.goal ?? null, goalRevision: state.goalRevision ?? 0 }); }
  if (command === 'done-goal') { const revision = Number(sub); await transact(home, state => consumeGoal(state, revision)); return print({ goalConsumed: revision }); }
  if (command === 'next') { const m = member(home); const next = await transact(home, state => {
    const goal = pendingGoal(state); if (goal) return goal;
    if (state.deliveryWatcher && alive(state.deliveryWatcher.pid)) throw new Fail('stop the handler watch before manual delivery', 2);
    if (state.delivery) throw new Fail(`delivery #${state.delivery.seq} is pending with the host; resolve it first`, 2);
    return pending(home, m, state);
  }); return next ? print(next) : undefined; }
  if (command === 'done' || command === 'skip' || command === 'retry') {
    const m = member(home); const seq = Number(sub);
    if (command === 'skip' && !values.reason) throw new Fail('skip needs --reason');
    await transact(home, state => {
      if (state.deliveryWatcher && alive(state.deliveryWatcher.pid)) throw new Fail('stop the delivery process before resolving its receipt');
      if (state.delivery && (alive(state.delivery.pid) || state.delivery.handlerPid && alive(state.delivery.handlerPid))) throw new Fail('stop the delivery process and its handler before resolving its receipt');
      const next = pending(home, m, state);
      if (!next || next.seq !== seq) throw new Fail(`out of order: the next unconsumed message is ${next ? '#' + next.seq : 'none'}`);
      if (command === 'retry') {
        if (state.delivery?.seq !== seq) throw new Fail('retry requires an unknown delivery for this sequence');
        delete state.delivery; return;
      }
      if (command === 'skip') state.skipped.push({ seq, reason: values.reason });
      state.consumed = seq; delete state.delivery;
    });
    return print(command === 'retry' ? { retry: seq, note: 'the host may have accepted it before; deduplicate by event id' } : { consumed: seq });
  }
  if (command === 'watch') {
    if (values.handler) return watchHandler(home, values.handler);
    // Prints from the inbox, not from what this process fetched: a restart replays the whole
    // unconsumed backlog, messages another process fetched still show up, and nothing already
    // consumed is printed again.
    const m = member(home); const shown = new Set(); let shownGoal = 0;
    const show = () => { const state = loadState(home); const { consumed, delivery } = state; const goal = pendingGoal(state);
      if (state.deliveryWatcher && alive(state.deliveryWatcher.pid)) throw new Fail('stop the handler watch before manual delivery', 2);
      if (delivery) throw new Fail(`delivery #${delivery.seq} is pending with the host; resolve it first`, 2);
      if (goal && goal.revision !== shownGoal) { shownGoal = goal.revision; print(goal); }
      for (const x of inbox(home)) {
      if (x.seq <= consumed || x.memberId === m.memberId || shown.has(x.seq)) continue;
      shown.add(x.seq); print(`[msg #${x.seq}] ${x.memberId.slice(0, 6)}${x.to ? ' → ' + x.to.slice(0, 6) : ''}: ${String(x.text).replace(/\s+/g, ' ').slice(0, 1500)}`);
    } };
    show();
    for (let backoff = 0; ;) {
      try { await sync(home, 25); backoff = 0; show(); }
      catch (error) { if (error instanceof Fail) throw error; backoff = Math.min(backoff ? backoff * 2 : 2000, 30_000); await sleep(backoff); }
    }
  }
  if (command === 'send') {
    const m = member(home); const text = readFileSync(values['text-file'] ?? '/dev/stdin', 'utf8').trim();
    const body = { op: 'send', roomId: m.roomId, text, ...(values.to ? { to: values.to } : {}), ...(values.reply ? { replyTo: Number(values.reply) } : {}) };
    body.id = values.id ?? 'agent-' + createHash('sha256').update(JSON.stringify([text, body.to ?? '', body.replyTo ?? 0])).digest('hex').slice(0, 32);
    const result = await unknownKeepsId(() => retrying(m.origin, body, m.token), body.id); if (result.status !== 200) throw failed(result); return print({ seq: result.json.seq, id: body.id });
  }
  if (command === 'task') {
    const m = member(home);
    if (sub === 'create') {
      if (!values.title) throw new Fail('--title is required');
      const body = { op: 'task', roomId: m.roomId, action: 'create', title: values.title, ...(values.assignee ? { assignee: values.assignee } : {}), ...(values.from ? { from: Number(values.from) } : {}), ...(values['goal-id'] ? { goalId: Number(values['goal-id']) } : {}) };
      body.id = values.id ?? 'agent-task-' + createHash('sha256').update(JSON.stringify([body.title, body.assignee ?? '', body.from ?? 0, ...(body.goalId ? [body.goalId] : [])])).digest('hex').slice(0, 32);
      const result = await unknownKeepsId(() => retrying(m.origin, body, m.token), body.id); if (result.status !== 200) throw failed(result); return print(result.json);
    }
    const taskId = Number(arg); if (!Number.isInteger(taskId) || taskId <= 0) throw new Fail('task id required');
    if (sub === 'claim') {
      const result = await retrying(m.origin, { op: 'task', roomId: m.roomId, action: 'update', taskId, assignee: m.memberId, status: 'doing', onlyIfUnassigned: true }, m.token);
      if (result.status !== 200) throw failed(result); return print(result.json);
    }
    if (sub === 'update' || sub === 'delete') {
      const body = { op: 'task', roomId: m.roomId, action: sub, taskId, ...(values.status ? { status: values.status } : {}), ...(values.assignee !== undefined ? { assignee: values.assignee } : {}), ...(values.result ? { resultSeq: Number(values.result) } : {}), ...(values.title ? { title: values.title } : {}) };
      const intents = join(home, 'intents.jsonl'); if (!existsSync(intents)) writePrivate(intents, '');
      appendFileSync(intents, JSON.stringify({ at: new Date().toISOString(), ...body, roomId: undefined }) + '\n');
      try { const result = await call(m.origin, body, m.token); if (result.status !== 200) throw failed(result); return print(result.json); }
      catch (error) {
        if (!(error instanceof Unknown)) throw error;
        // Never replay: read the task back and report what is actually there.
        let current = null; try { const r = await call(m.origin, { op: 'read', roomId: m.roomId, after: 0 }, m.token); current = (r.json.tasks ?? []).find(t => t.id === taskId) ?? 'deleted or missing'; } catch {}
        print({ unknown: true, intent: { ...body, roomId: undefined }, current, note: 'not retried; compare and decide' }); throw new Fail('task change result unknown', 2);
      }
    }
  }
  if (command === 'goal') {
    const m = member(home);
    const read = async () => { const r = await retrying(m.origin, { op: 'read', roomId: m.roomId, after: 0 }, m.token); if (r.status !== 200) throw failed(r); const state = goalState(r.json); if (!state) throw new Fail('relay does not support Goals'); return { ...state, tasks: r.json.tasks ?? [] }; };
    if (sub === 'read') return print(await read());
    if (!['create', 'pause', 'resume', 'delete', 'reviewer', 'submit', 'accept', 'reject'].includes(sub)) throw new Fail('unknown goal action');
    const revision = Number(values.revision), goalId = Number(arg);
    if (values.revision === undefined || !Number.isSafeInteger(revision) || revision < 0 || sub !== 'create' && (!Number.isSafeInteger(goalId) || goalId <= 0)) throw new Fail('--revision from the latest read is required, plus goal id for existing goals');
    const body = { op: 'goal', roomId: m.roomId, action: sub, goalRevision: revision, ...(sub !== 'create' ? { goalId } : {}),
      ...(values.title ? { title: values.title } : {}), ...(values['criteria-file'] ? { criteria: readFileSync(values['criteria-file'], 'utf8').trim() } : {}), ...(values.reviewer ? { reviewer: values.reviewer } : {}), ...(values.result ? { resultSeq: Number(values.result) } : {}) };
    const intents = join(home, 'intents.jsonl'); if (!existsSync(intents)) writePrivate(intents, '');
    appendFileSync(intents, JSON.stringify({ at: new Date().toISOString(), ...body, roomId: undefined }) + '\n');
    try { const r = await call(m.origin, body, m.token); if (r.status !== 200) throw failed(r); return print(r.json); }
    catch (error) {
      if (!(error instanceof Unknown)) throw error;
      let current = null; try { current = await read(); } catch {}
      print({ unknown: true, intent: { ...body, roomId: undefined }, current, note: 'not retried; compare goal id and revision before deciding' }); throw new Fail('goal change result unknown', 2);
    }
  }
  throw new Fail('unknown command; see the header of space-agent.mjs');
}
main(process.argv.slice(2)).catch(error => { process.stderr.write(clean(error instanceof Fail ? error.message : `unexpected error: ${error.message}`) + '\n'); process.exitCode = error.exit ?? 1; });
