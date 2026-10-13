import { validRoomKey } from '../remote/roomCrypto';

/** Presence only: never send passwords, account cookies, or start a visitor session. */
export async function roomOnline(roomKey: string, signal: AbortSignal): Promise<boolean> {
  if (!validRoomKey(roomKey)) throw Error('INVALID_ROOM_KEY');
  const cancel = new AbortController(), abort = () => cancel.abort();
  if (signal.aborted) throw Error('CANCELLED');
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 5000);
  try {
    const response = await fetch('/api/room/status', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: cancel.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ roomKey }),
    });
    if (!response.ok || !response.body) throw Error('ROOM_STATUS_UNAVAILABLE');
    const reader = response.body.getReader(), bytes = new Uint8Array(1024); let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        if (size + value.length > bytes.length) { await reader.cancel(); throw Error('INVALID_ROOM_STATUS'); }
        bytes.set(value, size); size += value.length;
      }
    } finally { reader.releaseLock(); }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as { online?: unknown }).online !== 'boolean') throw Error('INVALID_ROOM_STATUS');
    return (value as { online: boolean }).online;
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
