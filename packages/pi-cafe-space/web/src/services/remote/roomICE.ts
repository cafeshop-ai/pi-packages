export function hasRoomCandidate(sdp: string | undefined, relay = false): boolean {
  return (sdp ?? '').split(/\r?\n/).some(line => /^a=candidate:/.test(line) && (!relay || /\styp relay(?:\s|$)/.test(line)));
}
/** Non-trickle signaling: capture a complete offer once, including an available
 * relay, without waiting for unrelated/unreachable STUN requests to time out. */
export function gatherRoomICE(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let finished = false, settling: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(deadline); clearTimeout(settling);
      pc.removeEventListener('icegatheringstatechange', changed); pc.removeEventListener('icecandidate', candidate);
      signal.removeEventListener('abort', aborted);
      error ? reject(error) : resolve();
    };
    const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const candidate = () => {
      if (!finished && !settling && hasRoomCandidate(pc.localDescription?.sdp, true)) {
        settling = setTimeout(() => { if (hasRoomCandidate(pc.localDescription?.sdp, true)) finish(); else settling = undefined; }, 250);
      }
    };
    const aborted = () => finish(Error('CANCELLED'));
    const deadline = setTimeout(() => finish(hasRoomCandidate(pc.localDescription?.sdp) ? undefined : Error('ROOM_ICE_NO_CANDIDATE')), 8000);
    pc.addEventListener('icegatheringstatechange', changed); pc.addEventListener('icecandidate', candidate);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted(); else { changed(); candidate(); }
  });
}
