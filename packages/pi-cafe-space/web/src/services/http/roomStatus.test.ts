import { afterEach, expect, it, vi } from 'vitest';
import { roomOnline } from './roomStatus';
const key = 'B' + 'A'.repeat(86);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
it.each([true, false])('queries only a supplied key, without password/cookies/session creation: %s', async online => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ online }))); vi.stubGlobal('fetch', fetcher);
  expect(await roomOnline(key, new AbortController().signal)).toBe(online);
  expect(fetcher).toHaveBeenCalledWith('/api/room/status', expect.objectContaining({ method: 'POST', body: JSON.stringify({ roomKey: key }), credentials: 'omit', redirect: 'error', cache: 'no-store' }));
});
it.each([['{}', 200], ['{"online":"false"}', 200], ['{"online":false}', 503], ['x'.repeat(1025), 200]])('rejects unavailable or malformed status rather than inventing offline: %s', async (body, status) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
  await expect(roomOnline(key, new AbortController().signal)).rejects.toThrow();
});
it('rejects invalid keys and already cancelled requests before network access', async () => {
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
  await expect(roomOnline('bad', new AbortController().signal)).rejects.toThrow('INVALID_ROOM_KEY');
  const cancel = new AbortController(); cancel.abort();
  await expect(roomOnline(key, cancel.signal)).rejects.toThrow('CANCELLED'); expect(fetcher).not.toHaveBeenCalled();
});
it('bounds pending requests and propagates cancellation', async () => {
  vi.useFakeTimers(); const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => { signals.push(options.signal); options.signal.addEventListener('abort', () => reject(Error('aborted'))); })));
  const cancel = new AbortController(), result = roomOnline(key, cancel.signal), rejected = expect(result).rejects.toThrow('aborted');
  await vi.advanceTimersByTimeAsync(5000); await rejected; expect(signals[0]!.aborted).toBe(true);
  const second = roomOnline(key, cancel.signal), stopped = expect(second).rejects.toThrow('aborted'); cancel.abort(); await stopped;
  expect(signals[1]!.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
