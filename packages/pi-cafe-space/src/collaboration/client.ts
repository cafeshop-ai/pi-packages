import { isAbsolute } from 'node:path';
import { readPrivateJSON } from '../extension/private-json.js';
import { goalState, type Goal } from '../../scripts/collaboration-goal.mjs';

export interface Membership { origin: string; roomId: string; memberId: string; token: string }
export interface Member { id: string; name: string; kind: 'human' | 'ai'; removed: boolean }
export interface Message { seq: number; id: string; memberId: string; text: string; to: string; replyTo: number; at?: string }
export interface Task { id: number; title: string; status: 'todo' | 'doing' | 'done'; assignee?: string; result?: number; goalId?: number }
export interface MemberState { state: 'working' | 'waiting' | 'idle' | 'away'; waitingFor?: 'member' | 'review' | 'user' | 'external' | 'decision'; detail?: string; ref?: number; since: string; updatedAt: string }
export interface Snapshot {
  roomId: string; memberId: string; cursor: number; more: boolean; members: Member[]; messages: Message[]; aiPaused?: boolean;
  title?: string; tasks?: Task[]; goal?: Goal | null; goalRevision?: number; states?: Record<string, MemberState>; waitingOnYou?: string[]; rev?: number;
}
const id = /^[a-f0-9]{32}$/;
const messageId = /^[a-zA-Z0-9_-]{8,80}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && [...v].length <= max && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(v);
export class RoomError extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly retryAfterMs = 5000) { super(code); }
}
export function readMembership(path: string): Membership {
  if (!isAbsolute(path)) throw new RoomError('ABSOLUTE_PRIVATE_CONFIG_REQUIRED');
  const value = readPrivateJSON(path);
  const origin = value.origin;
  if (typeof origin !== 'string') throw new RoomError('INVALID_ROOM_CONFIG');
  const url = new URL(origin);
  if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new RoomError('INVALID_ROOM_ORIGIN');
  if (typeof value.roomId !== 'string' || !id.test(value.roomId) || typeof value.memberId !== 'string' || !id.test(value.memberId) || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new RoomError('INVALID_ROOM_CONFIG');
  return { origin, roomId: value.roomId, memberId: value.memberId, token: value.token };
}
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function parseMessage(value: unknown): Message {
  if (!object(value) || !integer(value.seq, 1) || typeof value.id !== 'string' || !messageId.test(value.id) || typeof value.memberId !== 'string' || !id.test(value.memberId) || !text(value.text, 8000) || (value.to !== undefined && (typeof value.to !== 'string' || !id.test(value.to))) || (value.replyTo !== undefined && !integer(value.replyTo, 0, value.seq - 1)) || (value.at !== undefined && !timestamp(value.at))) throw new RoomError('INVALID_ROOM_RESPONSE');
  return { seq: value.seq, id: value.id, memberId: value.memberId, text: value.text, to: value.to as string ?? '', replyTo: value.replyTo as number ?? 0, ...(value.at !== undefined ? { at: value.at as string } : {}) };
}
export function parseSnapshot(value: unknown, auth: Membership, after: number): Snapshot {
  if (!object(value) || value.roomId !== auth.roomId || value.memberId !== auth.memberId || !integer(value.cursor, after) || typeof value.more !== 'boolean' || !Array.isArray(value.members) || value.members.length > 64 || !Array.isArray(value.messages) || value.messages.length > 100) throw new RoomError('INVALID_ROOM_RESPONSE');
  const members = value.members.map(v => {
    if (!object(v) || typeof v.id !== 'string' || !id.test(v.id) || !text(v.name, 48) || (v.kind !== 'human' && v.kind !== 'ai') || (v.removed !== undefined && typeof v.removed !== 'boolean')) throw new RoomError('INVALID_ROOM_RESPONSE');
    return { id: v.id, name: v.name, kind: v.kind, removed: v.removed === true } satisfies Member;
  });
  if (new Set(members.map(v => v.id)).size !== members.length || !members.some(v => v.id === auth.memberId && !v.removed)) throw new RoomError('MEMBERSHIP_UNAVAILABLE');
  const messages = value.messages.map(parseMessage);
  if (messages.some((v, i) => v.seq !== after + i + 1 || !members.some(m => m.id === v.memberId)) || value.cursor !== after + messages.length || (value.more && messages.length === 0)) throw new RoomError('INVALID_ROOM_RESPONSE');
  if (value.aiPaused !== undefined && typeof value.aiPaused !== 'boolean') throw new RoomError('INVALID_ROOM_RESPONSE');
  const controls: Partial<Snapshot> = {};
  if (value.title !== undefined) {
    if (!text(value.title, 80)) throw new RoomError('INVALID_ROOM_RESPONSE');
    controls.title = value.title;
  }
  if (value.rev !== undefined) {
    if (!integer(value.rev, 0)) throw new RoomError('INVALID_ROOM_RESPONSE');
    controls.rev = value.rev;
  }
  try { Object.assign(controls, goalState(value)); }
  catch { throw new RoomError('INVALID_ROOM_RESPONSE'); }
  const memberId = (v: unknown): v is string => typeof v === 'string' && id.test(v) && members.some(m => m.id === v);
  if (value.tasks !== undefined) {
    if (!Array.isArray(value.tasks) || value.tasks.length > 200) throw new RoomError('INVALID_ROOM_RESPONSE');
    controls.tasks = value.tasks.map(t => {
      if (!object(t) || !integer(t.id, 1) || !text(t.title, 200) || typeof t.status !== 'string' || !['todo', 'doing', 'done'].includes(t.status) ||
        (t.assignee !== undefined && !memberId(t.assignee)) || (t.result !== undefined && !integer(t.result, 1)) || (t.goalId !== undefined && !integer(t.goalId, 1))) throw new RoomError('INVALID_ROOM_RESPONSE');
      return { id: t.id, title: t.title, status: t.status as Task['status'], ...(t.assignee !== undefined ? { assignee: t.assignee as string } : {}),
        ...(t.result !== undefined ? { result: t.result as number } : {}), ...(t.goalId !== undefined ? { goalId: t.goalId as number } : {}) };
    });
    if (new Set(controls.tasks.map(t => t.id)).size !== controls.tasks.length) throw new RoomError('INVALID_ROOM_RESPONSE');
  }
  if (value.states !== undefined) {
    if (!object(value.states) || Object.keys(value.states).length > 64) throw new RoomError('INVALID_ROOM_RESPONSE');
    controls.states = Object.fromEntries(Object.entries(value.states).map(([member, s]) => {
      if (!memberId(member) || !object(s) || typeof s.state !== 'string' || !['working', 'waiting', 'idle', 'away'].includes(s.state) ||
        !timestamp(s.since) || !timestamp(s.updatedAt) || (s.state === 'waiting') !== (s.waitingFor !== undefined) ||
        (s.waitingFor !== undefined && (typeof s.waitingFor !== 'string' || !['member', 'review', 'user', 'external', 'decision'].includes(s.waitingFor))) ||
        (s.detail !== undefined && !text(s.detail, 280)) || (s.state === 'waiting' && !text(s.detail, 280)) ||
        (s.ref !== undefined && !integer(s.ref, 1))) throw new RoomError('INVALID_ROOM_RESPONSE');
      return [member, { state: s.state as MemberState['state'], since: s.since, updatedAt: s.updatedAt,
        ...(s.waitingFor !== undefined ? { waitingFor: s.waitingFor as NonNullable<MemberState['waitingFor']> } : {}),
        ...(s.detail !== undefined ? { detail: s.detail as string } : {}), ...(s.ref !== undefined ? { ref: s.ref as number } : {}) }];
    }));
  }
  if (value.waitingOnYou !== undefined) {
    if (!Array.isArray(value.waitingOnYou) || value.waitingOnYou.length > 64 || !value.waitingOnYou.every(memberId) ||
      value.waitingOnYou.includes(auth.memberId) || new Set(value.waitingOnYou).size !== value.waitingOnYou.length) throw new RoomError('INVALID_ROOM_RESPONSE');
    controls.waitingOnYou = value.waitingOnYou;
  }
  return { ...controls, roomId: auth.roomId, memberId: auth.memberId, cursor: value.cursor, more: value.more, members, messages, aiPaused: value.aiPaused === true };
}
export class RoomClient {
  supportsPresence = false;
  constructor(readonly membership: Membership, private readonly request: typeof fetch = fetch) {}
  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const combined = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    let response: Response;
    try {
      response = await this.request(this.membership.origin + '/api/collaboration', { method: 'POST', redirect: 'error', credentials: 'omit', signal: combined,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Authorization: 'Bearer ' + this.membership.token }, body: JSON.stringify({ ...body, roomId: this.membership.roomId }) });
    } catch { throw new RoomError(signal?.aborted ? 'CANCELLED' : 'NETWORK_RESULT_UNKNOWN', !signal?.aborted); }
    if (!response.ok) {
      await response.body?.cancel();
      const delay = Number(response.headers.get('Retry-After'));
      throw new RoomError('ROOM_HTTP_' + response.status, response.status === 429 || response.status >= 500, response.status === 429 ? Math.max(60_000, Math.min(Number.isFinite(delay) ? delay * 1000 : 0, 300_000)) : 5000);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new RoomError('INVALID_ROOM_RESPONSE');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 8 * 1024 * 1024) throw new RoomError('ROOM_RESPONSE_LIMIT'); chunks.push(next.value); }
    } catch (error) { await reader.cancel().catch(() => {}); if (error instanceof RoomError) throw error; throw new RoomError(signal?.aborted ? 'CANCELLED' : 'NETWORK_RESULT_UNKNOWN', !signal?.aborted); }
    finally { reader.releaseLock(); }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new RoomError('INVALID_ROOM_RESPONSE'); }
  }
  async read(after: number, signal?: AbortSignal): Promise<Snapshot> {
    if (!integer(after, 0)) throw new RoomError('INVALID_CURSOR');
    const value = await this.post({ op: 'read', after }, signal);
    const snapshot = parseSnapshot(value, this.membership, after);
    // Presence is returned by relays that support ack; old read/send relays keep working.
    this.supportsPresence = object(value) && object(value.presence);
    return snapshot;
  }
  async ack(progress: { fetched: number; delivered: number; paused: boolean }, signal?: AbortSignal): Promise<void> {
    if (!integer(progress.fetched, 0) || !integer(progress.delivered, 0, progress.fetched) || typeof progress.paused !== 'boolean') throw new RoomError('INVALID_ACK');
    const value = await this.post({ op: 'ack', ...progress }, signal);
    if (!object(value) || value.ok !== true) throw new RoomError('INVALID_ROOM_RESPONSE');
  }
  async reply(input: { id: string; text: string; to: string; replyTo: number }, signal?: AbortSignal): Promise<Message> {
    if (!messageId.test(input.id) || !text(input.text, 8000) || input.text.trim() !== input.text || !id.test(input.to) || input.to === this.membership.memberId || !integer(input.replyTo, 1)) throw new RoomError('INVALID_REPLY');
    // This preflight respects pause on old relays; only a server-side check can close the read/send race.
    if ((await this.read(input.replyTo, signal)).aiPaused) throw new RoomError('ROOM_AI_PAUSED');
    // Never retry a write here: callers reconcile unknown outcomes with the same ID and body.
    const reply = parseMessage(await this.post({ op: 'send', ...input }, signal));
    if (reply.id !== input.id || reply.memberId !== this.membership.memberId || reply.text !== input.text || reply.to !== input.to || reply.replyTo !== input.replyTo) throw new RoomError('INVALID_ROOM_RESPONSE');
    return reply;
  }
}
