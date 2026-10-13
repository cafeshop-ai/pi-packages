/// <reference types="node" />
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeRoomBase64, encodeRoomBase64, publicRoomPath, roomHash, roomKeyFromInput, roomNonce, roomPasswordValid, validRoomKey, verifyRoomAnswer } from './roomCrypto';
afterEach(() => vi.unstubAllGlobals());
async function fixture() {
  vi.stubGlobal('crypto', webcrypto);
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const room = encodeRoomBase64(new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey)));
  const id = roomNonce(), nonce = roomNonce(), offer = await roomHash('offer SDP'), answer = 'answer SDP';
  const transcript = JSON.stringify(['cafe-room-answer-v1', room, id, nonce, offer, await roomHash(answer)]);
  const signature = encodeRoomBase64(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, new TextEncoder().encode(transcript))));
  return { room, id, nonce, offer, answer, signature };
}
it('accepts the raw P-256 signature only for its exact room and handshake', async () => {
  const f = await fixture(); expect(await verifyRoomAnswer(f.room, f.signature, f.id, f.nonce, f.offer, f.answer)).toBe(true);
  for (const patch of [{ nonce: roomNonce() }, { id: roomNonce() }, { offer: await roomHash('different offer') }, { answer: 'different answer' }, { signature: encodeRoomBase64(new Uint8Array(64)) }]) {
    const v = { ...f, ...patch }; expect(await verifyRoomAnswer(v.room, v.signature, v.id, v.nonce, v.offer, v.answer)).toBe(false);
  }
  const other = await fixture(); expect(await verifyRoomAnswer(other.room, f.signature, f.id, f.nonce, f.offer, f.answer)).toBe(false);
});
it('same-site link and room key resolve without accepting embedded passwords or other sites', async () => {
  const f = await fixture(); const origin = 'https://space.example'; const link = origin + '/#/room/' + f.room;
  expect(roomKeyFromInput(link, origin)).toBe(f.room); expect(roomKeyFromInput(f.room, origin)).toBe(f.room);
  for (const value of [link.replace('space.example', 'evil.example'), link + '?password=secret', origin + '/?password=secret#/room/' + f.room, 'https://user:pass@space.example/#/room/' + f.room, link.replace('/#/room/', '/other/#/room/')]) expect(roomKeyFromInput(value, origin)).toBeNull();
  expect(publicRoomPath('/room/' + f.room + '/files')).toEqual({ key: f.room, base: '/room/' + f.room, page: '/files' });
  expect(publicRoomPath('/rooms/main')).toBeNull(); expect(validRoomKey('main')).toBe(false);
  expect(() => decodeRoomBase64('abc=')).toThrow(); expect(encodeRoomBase64(decodeRoomBase64(f.room))).toBe(f.room);
});
it.each(['123456', 'aaaaaa', '我的访问令牌', 'a'.repeat(20)])('keeps the chosen 6–20 character password rule: %s', value => expect(roomPasswordValid(value)).toBe(true));
it.each(['', '12345', 'a'.repeat(21), ' leading', 'trailing ', 'line\nbreak'])('rejects invalid room password input: %s', value => expect(roomPasswordValid(value)).toBe(false));
