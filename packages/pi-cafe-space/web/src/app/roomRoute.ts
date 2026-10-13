const validRoom = (roomId: string) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(roomId);
export function roomHref(roomId: string): string {
  if (!validRoom(roomId)) throw new Error('Invalid room');
  return `/rooms/${encodeURIComponent(roomId)}`;
}
export type RoomRoute = { valid: true; roomId: string | null; base: string; pagePath: string } | { valid: false };
// HashRouter's raw pathname: decode only the room segment, exactly once.
// Leave history's opaque ID untouched for its own single-decoding validator.
export function parseRoomRoute(pathname: string): RoomRoute {
  if (pathname !== '/rooms' && !pathname.startsWith('/rooms/')) return { valid: true, roomId: null, base: '', pagePath: pathname };
  const match = /^\/rooms\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match || match[1]!.length > 192) return { valid: false };
  try {
    const roomId = decodeURIComponent(match[1]!);
    if (!validRoom(roomId)) return { valid: false };
    return { valid: true, roomId, base: roomHref(roomId), pagePath: match[2] ?? '/' };
  } catch { return { valid: false }; }
}
