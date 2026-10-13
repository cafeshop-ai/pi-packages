import { expect, it } from 'vitest';
import { ChunkDecoder, encodeChunks, decodeBase64, encodeBase64, MAX_BUSINESS_BYTES } from './framing';

it('reassembles the maximum message without changing bytes', () => {
  const input = new Uint8Array(MAX_BUSINESS_BYTES).map((_, i) => i % 251);
  const decoder = new ChunkDecoder(); let result: Uint8Array | null = null;
  const packets = encodeChunks(1, input);
  expect(packets.length).toBeGreaterThan(1);
  for (const packet of packets) { expect(packet.byteLength).toBeLessThanOrEqual(16384); result = decoder.push(packet, 0); }
  expect(result).toEqual(input);
  expect(decoder.push(encodeChunks(2, new Uint8Array([1,2]))[0]!, 1)).toEqual(new Uint8Array([1,2]));
  expect(() => decoder.push(packets[0]!, 2)).toThrow();
});
it('rejects out of order, concurrent, oversized and expired assemblies', () => {
  const packets = encodeChunks(1, new Uint8Array(20000));
  expect(() => new ChunkDecoder().push(packets[1]!, 0)).toThrow();
  const concurrent = new ChunkDecoder(); concurrent.push(packets[0]!, 0);
  expect(() => concurrent.push(packets[0]!, 1)).toThrow();
  const stale = new ChunkDecoder(); stale.push(packets[0]!, 0);
  expect(() => stale.push(packets[1]!, 10001)).toThrow();
  expect(() => encodeChunks(1, new Uint8Array(MAX_BUSINESS_BYTES + 1))).toThrow();
  expect(() => encodeChunks(0, new Uint8Array([1]))).toThrow();
  const corrupted = packets[0]!.slice(0); new DataView(corrupted).setUint32(8, MAX_BUSINESS_BYTES + 1);
  expect(() => new ChunkDecoder().push(corrupted, 0)).toThrow();
});
it('round trips bounded binary payloads and rejects invalid encodings', () => {
  const input = new Uint8Array([0, 255, 127, 42]); expect(decodeBase64(encodeBase64(input))).toEqual(input);
  for (const value of ['!!!', 'a', 'AAAA=', 'AA A=']) expect(() => decodeBase64(value)).toThrow();
  expect(() => decodeBase64('A'.repeat(MAX_BUSINESS_BYTES * 2))).toThrow();
});
