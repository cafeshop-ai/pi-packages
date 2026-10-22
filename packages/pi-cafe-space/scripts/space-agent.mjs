#!/usr/bin/env node
// space-agent: a POSIX preview client for Café Space collaboration rooms.
// It keeps the member token in a private directory and never prints it, keeps
// one local inbox where "fetched" and "consumed" are separate, and recovers each
// write according to what the protocol can prove (see RECOVERY below).
// It never calls a model and never executes room content.
//
//   space-agent --home <private dir> preview            < invite link on stdin
//   space-agent --home <dir> join --name <name> [--kind ai|human]   < invite link
//   space-agent --home <dir> status | read [--after N]
//   space-agent --home <dir> sync [--wait 25]          fetch into the inbox, report ack
//   space-agent --home <dir> next | done <seq> | skip <seq> --reason <text>
//   space-agent --home <dir> watch                     sync forever, one line per fetched message
//   space-agent --home <dir> send --text-file <f> [--to id] [--reply seq] [--id id]
//   space-agent --home <dir> task create --title <t> [--assignee id] [--from seq] [--id id]
//   space-agent --home <dir> task claim <taskId>
//   space-agent --home <dir> task update <taskId> [--status s] [--assignee id] [--result seq] [--title t]
//   space-agent --home <dir> task delete <taskId>
//
// RECOVERY (unknown result = network error, timeout or 5xx):
//   read, preview, ack ............ retried freely (ack only moves forward)
//   send, task create ............. retried with the same id and body; ID_CONFLICT stops
//   task claim .................... retried; the server returns a claimed task unchanged
//   task update, task delete ...... never retried: the intent is recorded, the task read back
//   join .......................... never retried: it may have created a member
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

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
function writePrivate(path, text) {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}
const readJSON = (path, fallback) => { const text = readPrivate(path, null); return text === null ? fallback : JSON.parse(text); };

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
async function call(origin, body, token, timeout = 20_000) {
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
const inbox = home => (readPrivate(join(home, 'inbox.jsonl'), '') ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));
function appendInbox(home, messages) {
  const path = join(home, 'inbox.jsonl');
  if (!existsSync(path)) writePrivate(path, '');
  readPrivate(path, '');
  for (const m of messages) appendFileSync(path, JSON.stringify({ seq: m.seq, id: m.id, memberId: m.memberId, text: m.text, to: m.to, replyTo: m.replyTo, at: m.at }) + '\n', { mode: 0o600 });
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
async function sync(home, wait) {
  const m = member(home); const state = loadState(home);
  let fetched = [];
  for (let more = true; more;) {
    const result = await retrying(m.origin, { op: 'read', roomId: m.roomId, after: state.fetched, ...(wait ? { wait } : {}) }, m.token);
    if (result.status === 429) { await sleep(result.retryAfter * 1000); continue; }
    if (result.status !== 200) throw failed(result);
    const page = result.json; const fresh = page.messages.filter(x => x.seq > state.fetched);
    appendInbox(home, fresh); fetched = fetched.concat(fresh); state.fetched = page.cursor; more = page.more; wait = 0;
    writePrivate(statePath(home), JSON.stringify(state));
    if (page.aiPaused !== state.aiPaused) { state.aiPaused = page.aiPaused; writePrivate(statePath(home), JSON.stringify(state)); }
  }
  // delivered reports the highest consumed seq: the agent's own confirmation, not proof of understanding.
  try { await call(m.origin, { op: 'ack', roomId: m.roomId, fetched: state.fetched, delivered: state.consumed }, m.token); } catch {}
  return { fetched, state };
}

// --- commands --------------------------------------------------------------
const stdin = () => readFileSync(0, 'utf8');
async function main(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    home: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, after: { type: 'string' }, wait: { type: 'string' },
    'text-file': { type: 'string' }, to: { type: 'string' }, reply: { type: 'string' }, id: { type: 'string' }, title: { type: 'string' },
    assignee: { type: 'string' }, from: { type: 'string' }, status: { type: 'string' }, result: { type: 'string' }, reason: { type: 'string' } } });
  const [command, sub, arg] = positionals; const home = privateHome(values.home);
  if (command === 'preview' || command === 'join') {
    const invite = parseInvite(stdin());
    if (command === 'preview') {
      const result = await retrying(invite.origin, { op: 'preview', roomId: invite.roomId, invite: invite.invite });
      if (result.status !== 200) throw failed(result); return print(result.json);
    }
    if (existsSync(join(home, 'member.json'))) throw new Fail('this home already holds a membership; use a new --home for another room');
    if (!values.name) throw new Fail('--name is required');
    let result;
    try { result = await call(invite.origin, { op: 'join', roomId: invite.roomId, invite: invite.invite, name: values.name, kind: values.kind ?? 'ai' }); }
    catch (error) { if (error instanceof Unknown) throw new Fail('join result unknown: a member may have been created; ask the room owner before joining again', 2); throw error; }
    if (result.status !== 200) throw failed(result);
    secrets.add(result.json.token);
    writePrivate(join(home, 'member.json'), JSON.stringify({ origin: invite.origin, roomId: result.json.roomId, memberId: result.json.memberId, token: result.json.token }));
    writePrivate(statePath(home), JSON.stringify({ fetched: 0, consumed: 0, skipped: [] }));
    return print({ joined: true, roomId: result.json.roomId, memberId: result.json.memberId });
  }
  if (command === 'status') { const m = member(home); const s = loadState(home); return print({ roomId: m.roomId, memberId: m.memberId, origin: m.origin, fetched: s.fetched, consumed: s.consumed, skipped: s.skipped.length }); }
  if (command === 'read') {
    // A manual view: it never changes what counts as consumed.
    const m = member(home); const result = await retrying(m.origin, { op: 'read', roomId: m.roomId, after: Number(values.after ?? 0) }, m.token);
    if (result.status !== 200) throw failed(result); return print(result.json);
  }
  if (command === 'sync') { const { fetched, state } = await sync(home, Number(values.wait ?? 0)); return print({ fetched: fetched.length, cursor: state.fetched, consumed: state.consumed }); }
  if (command === 'next') { const m = member(home); const state = loadState(home); const next = pending(home, m, state); writePrivate(statePath(home), JSON.stringify(state)); return next ? print(next) : undefined; }
  if (command === 'done' || command === 'skip') {
    const m = member(home); const state = loadState(home); const next = pending(home, m, state); const seq = Number(sub);
    if (!next || next.seq !== seq) throw new Fail(`out of order: the next unconsumed message is ${next ? '#' + next.seq : 'none'}`);
    if (command === 'skip') { if (!values.reason) throw new Fail('skip needs --reason'); state.skipped.push({ seq, reason: values.reason }); }
    state.consumed = seq; writePrivate(statePath(home), JSON.stringify(state));
    return print({ consumed: seq });
  }
  if (command === 'watch') {
    for (let backoff = 0; ;) {
      try { const { fetched } = await sync(home, 25); backoff = 0; for (const x of fetched) print(`[msg #${x.seq}] ${x.memberId.slice(0, 6)}${x.to ? ' → ' + x.to.slice(0, 6) : ''}: ${String(x.text).replace(/\s+/g, ' ').slice(0, 1500)}`); }
      catch (error) { if (error instanceof Fail) throw error; backoff = Math.min(backoff ? backoff * 2 : 2000, 30_000); await sleep(backoff); }
    }
  }
  if (command === 'send') {
    const m = member(home); const text = readFileSync(values['text-file'] ?? '/dev/stdin', 'utf8').trim();
    const body = { op: 'send', roomId: m.roomId, text, ...(values.to ? { to: values.to } : {}), ...(values.reply ? { replyTo: Number(values.reply) } : {}) };
    body.id = values.id ?? 'agent-' + createHash('sha256').update(JSON.stringify([text, body.to ?? '', body.replyTo ?? 0])).digest('hex').slice(0, 32);
    const result = await retrying(m.origin, body, m.token); if (result.status !== 200) throw failed(result); return print({ seq: result.json.seq, id: body.id });
  }
  if (command === 'task') {
    const m = member(home);
    if (sub === 'create') {
      if (!values.title) throw new Fail('--title is required');
      const body = { op: 'task', roomId: m.roomId, action: 'create', id: values.id ?? randomUUID(), title: values.title, ...(values.assignee ? { assignee: values.assignee } : {}), ...(values.from ? { from: Number(values.from) } : {}) };
      const result = await retrying(m.origin, body, m.token); if (result.status !== 200) throw failed(result); return print(result.json);
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
  throw new Fail('unknown command; see the header of space-agent.mjs');
}
main(process.argv.slice(2)).catch(error => { process.stderr.write(clean(error instanceof Fail ? error.message : `unexpected error: ${error.message}`) + '\n'); process.exitCode = error.exit ?? 1; });
