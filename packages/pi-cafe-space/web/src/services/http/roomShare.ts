import { validRoomKey } from '../remote/roomCrypto';
export interface RoomShareInfo { roomKey: string; url: string; name: string; online: boolean; revision: number; visitorRole: 'operator' }
export type ShareAction = { operation: 'status' } | { operation: 'password'; password: string; confirmPassword: string; revision: number } | { operation: 'reset-link'; revision: number };
export function parseRoomShare(value: unknown): RoomShareInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_ROOM_SHARE');
  const v = value as Record<string, unknown>;
  if (typeof v.roomKey !== 'string' || !validRoomKey(v.roomKey) || typeof v.url !== 'string' || v.url.length > 4096 || typeof v.name !== 'string' || !v.name || v.name.length > 128 || typeof v.online !== 'boolean' || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || v.visitorRole !== 'operator') throw Error('INVALID_ROOM_SHARE');
  const url = new URL(v.url);
  if (!(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) || url.username || url.password || url.search || url.pathname !== '/' || url.hash !== '#/room/' + v.roomKey) throw Error('INVALID_ROOM_SHARE');
  return { roomKey: v.roomKey, url: v.url, name: v.name, online: v.online, revision: Number(v.revision), visitorRole: 'operator' };
}
export async function roomShareRequest(token: string, action: ShareAction, signal?: AbortSignal): Promise<RoomShareInfo> {
  const cancel = new AbortController(), abort = () => cancel.abort();
  if (signal?.aborted) throw Error('CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 10000);
  try {
    const response = await fetch('/api/room/share', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: cancel.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Cafe-Room': '1' }, body: JSON.stringify({ token, ...action }),
    });
    const raw = await response.text(); if (raw.length > 8192) throw Error('INVALID_ROOM_SHARE');
    if (!response.ok) throw Error(response.status === 409 ? 'ROOM_CHANGED' : response.status === 401 ? 'UNAUTHORIZED' : 'ROOM_SHARE_FAILED');
    return parseRoomShare(JSON.parse(raw));
  } catch (error) {
    if (error instanceof Error && ['ROOM_CHANGED', 'UNAUTHORIZED', 'ROOM_SHARE_FAILED', 'INVALID_ROOM_SHARE'].includes(error.message)) throw error;
    throw Error(action.operation === 'status' ? 'ROOM_SHARE_UNAVAILABLE' : 'RESULT_UNKNOWN');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
