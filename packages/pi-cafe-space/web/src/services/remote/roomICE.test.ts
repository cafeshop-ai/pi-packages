import { afterEach, expect, it, vi } from 'vitest';
import { gatherRoomICE, hasRoomCandidate } from './roomICE';
class Peer extends EventTarget {
  iceGatheringState = 'gathering'; localDescription = { sdp: 'v=0\r\n' };
}
const relay = 'a=candidate:1 1 UDP 1 192.0.2.1 12345 typ relay\r\n';
const host = 'a=candidate:1 1 UDP 1 127.0.0.1 12345 typ host\r\n';
afterEach(() => vi.useRealTimers());
it('uses an available relay after a bounded settle instead of waiting eight seconds', async () => {
  vi.useFakeTimers(); const pc = new Peer(), done = vi.fn();
  const result = gatherRoomICE(pc as unknown as RTCPeerConnection, new AbortController().signal).then(done);
  pc.localDescription.sdp += relay; pc.dispatchEvent(new Event('icecandidate'));
  await vi.advanceTimersByTimeAsync(249); expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); await result; expect(done).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('does not prematurely stop at a host-only candidate when TURN is still pending', async () => {
  vi.useFakeTimers(); const pc = new Peer(), done = vi.fn(); pc.localDescription.sdp += host;
  const result = gatherRoomICE(pc as unknown as RTCPeerConnection, new AbortController().signal).then(done);
  await vi.advanceTimersByTimeAsync(1000); expect(done).not.toHaveBeenCalled();
  pc.localDescription.sdp += relay; pc.dispatchEvent(new Event('icecandidate'));
  await vi.advanceTimersByTimeAsync(250); await result; expect(done).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
it('missing candidates fail with a network-specific error and do not leak timers', async () => {
  vi.useFakeTimers(); const pc = new Peer();
  const result = gatherRoomICE(pc as unknown as RTCPeerConnection, new AbortController().signal).catch(error => error.message);
  await vi.advanceTimersByTimeAsync(8000); expect(await result).toBe('ROOM_ICE_NO_CANDIDATE'); expect(vi.getTimerCount()).toBe(0);
});
it('cancellation removes settle/deadline work without permitting late success', async () => {
  vi.useFakeTimers(); const pc = new Peer(), cancel = new AbortController(); pc.localDescription.sdp += relay;
  const result = gatherRoomICE(pc as unknown as RTCPeerConnection, cancel.signal).catch(error => error.message);
  cancel.abort(); expect(await result).toBe('CANCELLED'); expect(vi.getTimerCount()).toBe(0);
  pc.dispatchEvent(new Event('icecandidate')); expect(vi.getTimerCount()).toBe(0);
});
it('already-complete gathering resolves immediately and candidate classification is exact', async () => {
  vi.useFakeTimers(); const pc = new Peer(); pc.iceGatheringState = 'complete';
  await gatherRoomICE(pc as unknown as RTCPeerConnection, new AbortController().signal); expect(vi.getTimerCount()).toBe(0);
  expect(hasRoomCandidate(host)).toBe(true); expect(hasRoomCandidate(host,true)).toBe(false); expect(hasRoomCandidate(relay,true)).toBe(true); expect(hasRoomCandidate('a=other: typ relay',true)).toBe(false);
});
