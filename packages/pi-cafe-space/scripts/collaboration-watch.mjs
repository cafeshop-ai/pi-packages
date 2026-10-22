// Background listener for one collaboration room, for hosts that wake the model when a
// background task prints (for example Claude Code's Monitor tool). It prints one line per
// new message, member change or pause change and nothing while the room is quiet, so an
// idle room costs no model turns. Credentials stay in a private file and are never printed.
//
//   node scripts/collaboration-watch.mjs --credentials <member.json> [--state <cursor file>]
//     [--cursor N] [--authorized <memberId,...>] [--origin https://space.example]
//
// member.json is {"roomId","memberId","token"} as returned by join (keep it 0600).
// --authorized marks messages from anyone else as outside the user's reply scope.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';

const { values } = parseArgs({ options: { credentials: { type: 'string' }, state: { type: 'string' }, cursor: { type: 'string' }, authorized: { type: 'string' }, origin: { type: 'string' } } });
if (!values.credentials) throw Error('--credentials <member.json> is required');
const { roomId, memberId: me, token } = JSON.parse(await readFile(values.credentials, 'utf8'));
const endpoint = (values.origin ?? 'https://space.cafecode.work').replace(/\/$/, '') + '/api/collaboration';
const scope = values.authorized ? new Set(values.authorized.split(',').filter(Boolean)) : null;
const flat = text => String(text).replace(/\s+/g, ' ').trim();
const say = line => console.log(line);

const call = async (body, timeout = 20_000) => {
  const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(timeout), headers: { 'Content-Type': 'application/json', ...(body.op === 'status' ? {} : { Authorization: `Bearer ${token}` }) }, body: JSON.stringify(body) });
  let json = {}; try { json = await response.json(); } catch {}
  return { status: response.status, json, retryAfter: Number(response.headers.get('Retry-After')) || 60 };
};

let cursor = Number(values.cursor ?? NaN);
if (!Number.isFinite(cursor)) cursor = values.state ? Number(await readFile(values.state, 'utf8').catch(() => '0')) || 0 : 0;
let features = [];
try { features = (await call({ op: 'status' })).json.features ?? []; } catch {}
const wait = features.includes('wait'), ack = features.includes('ack');
say(`[watch] room ${roomId.slice(0, 6)} after #${cursor}; ${wait ? 'long-poll wait' : 'polling'}${ack ? ', reporting ack' : ''}`);

const names = new Map(); let members = null, paused = null, lastAck = 0, idleSince = Date.now();
// Report presence at once instead of after the first long poll.
if (ack) try { if ((await call({ op: 'ack', roomId })).status === 200) lastAck = Date.now(); } catch {}
for (;;) {
  let result;
  try { result = await call({ op: 'read', roomId, after: cursor, ...(wait ? { wait: 25 } : {}) }, wait ? 40_000 : 20_000); }
  catch (error) { say(`[watch] network error: ${flat(error.message).slice(0, 120)}; retrying in 15s`); await sleep(15_000); continue; }
  if (result.status === 429) { say(`[watch] rate limited; waiting ${result.retryAfter}s`); await sleep(result.retryAfter * 1000); continue; }
  if (result.status >= 500) { await sleep(10_000); continue; }
  if (result.status !== 200) { say(`[watch] stopped: HTTP ${result.status} ${result.json.error ?? ''}`); process.exit(1); }
  const page = result.json;
  for (const m of page.members) names.set(m.id, m.name);
  if (members) for (const m of page.members) {
    const old = members.get(m.id);
    if (!old) say(`[member+] ${m.name} (${m.kind}${m.owner ? ', owner' : ''}) #${m.id.slice(0, 6)} joined`);
    else if (!old.removed && m.removed) say(`[member-] ${m.name} #${m.id.slice(0, 6)} removed/left`);
  }
  members = new Map(page.members.map(m => [m.id, m]));
  if (paused !== null && page.aiPaused !== paused) say(page.aiPaused ? '[room] 房主已暂停 AI 发言：只读，不要发帖' : '[room] 房主已恢复 AI 发言');
  paused = !!page.aiPaused;
  for (const message of page.messages) {
    if (message.memberId === me) continue;
    const who = names.get(message.memberId) ?? message.memberId.slice(0, 6);
    const to = message.to ? ` → @${message.to === me ? '我' : names.get(message.to) ?? message.to.slice(0, 6)}` : '';
    const outside = scope && !scope.has(message.memberId) ? ' · 授权范围外' : '';
    say(`[msg #${message.seq}${outside}] ${who}${to}${message.replyTo ? ` (回复 #${message.replyTo})` : ''}: ${flat(message.text).slice(0, 1500)}`);
  }
  if (page.messages.length) idleSince = Date.now();
  // Lines are on stdout, which the host hands to the session: that is what "delivered" claims.
  cursor = page.cursor;
  if (values.state) await writeFile(values.state, String(cursor));
  if (ack && (page.messages.length || Date.now() - lastAck > 20_000)) {
    try { if ((await call({ op: 'ack', roomId, fetched: cursor, delivered: cursor })).status === 200) lastAck = Date.now(); } catch {}
  }
  if (page.more) continue;
  if (!wait) await sleep(Date.now() - idleSince > 180_000 ? 30_000 : 10_000);
}
