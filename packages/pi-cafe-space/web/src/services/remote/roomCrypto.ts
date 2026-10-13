const encoder = new TextEncoder();
export const ROOM_DUMMY_TOKEN = 'room-session';
export function decodeRoomBase64(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 256) throw Error('INVALID_ROOM_KEY');
  const raw = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
  if (encodeRoomBase64(bytes) !== value) throw Error('INVALID_ROOM_KEY');
  return bytes;
}
export function encodeRoomBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function validRoomKey(key: string): boolean {
  try { const bytes = decodeRoomBase64(key); return key.length === 87 && bytes.length === 65 && bytes[0] === 4; } catch { return false; }
}
export function roomPasswordValid(value: string): boolean {
  return value.length >= 6 && value.length <= 20 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
export function roomNonce(): string { return encodeRoomBase64(crypto.getRandomValues(new Uint8Array(32))); }
export async function roomHash(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function verifyRoomAnswer(roomKey: string, signature: string, id: string, nonce: string, offerHash: string, answer: string): Promise<boolean> {
  try {
    if (!validRoomKey(roomKey) || !/^[A-Za-z0-9_-]{43}$/.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(offerHash) || answer.length > 65536) return false;
    const bytes = decodeRoomBase64(signature); if (bytes.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', decodeRoomBase64(roomKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const text = JSON.stringify(['cafe-room-answer-v1', roomKey, id, nonce, offerHash, await roomHash(answer)]);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes, encoder.encode(text));
  } catch { return false; }
}
export function roomKeyFromInput(input: string, origin: string): string | null {
  const value = input.trim(); if (validRoomKey(value)) return value;
  try {
    const url = new URL(value);
    if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.pathname !== '/') return null;
    const match = /^#\/room\/([A-Za-z0-9_-]{87})\/?$/.exec(url.hash);
    return match && validRoomKey(match[1]!) ? match[1]! : null;
  } catch { return null; }
}
export function publicRoomPath(path: string): { key: string; base: string; page: string } | null {
  const match = /^\/room\/([A-Za-z0-9_-]{87})(\/.*)?$/.exec(path);
  if (!match || !validRoomKey(match[1]!)) return null;
  return { key: match[1]!, base: '/room/' + match[1], page: match[2] || '/' };
}
