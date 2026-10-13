export const MAX_BUSINESS_BYTES = 256 * 1024;
export const MAX_OUTER_BYTES = 512 * 1024;
export const PACKET_BYTES = 16 * 1024;
const HEADER_BYTES = 16;
const MAGIC = 0x50434431; // PCD1; big endian, identical to the Go transport.

export function encodeChunks(id: number, input: Uint8Array): ArrayBuffer[] {
  if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || !input.byteLength || input.byteLength > MAX_BUSINESS_BYTES) throw Error('INVALID_MESSAGE');
  const result: ArrayBuffer[] = [];
  for (let offset = 0; offset < input.length; offset += PACKET_BYTES - HEADER_BYTES) {
    const part = input.subarray(offset, offset + PACKET_BYTES - HEADER_BYTES);
    const packet = new ArrayBuffer(HEADER_BYTES + part.length); const header = new DataView(packet);
    header.setUint32(0, MAGIC); header.setUint32(4, id); header.setUint32(8, input.length); header.setUint32(12, offset);
    new Uint8Array(packet, HEADER_BYTES).set(part); result.push(packet);
  }
  return result;
}
export class ChunkDecoder {
  #last = 0; #id = 0; #total = 0; #offset = 0; #data: Uint8Array | null = null; #deadline = 0;
  get pending(): boolean { return this.#data !== null; }
  expired(now = Date.now()): boolean { return this.pending && now > this.#deadline; }
  push(packet: ArrayBuffer, now = Date.now()): Uint8Array | null {
    if (packet.byteLength <= HEADER_BYTES || packet.byteLength > PACKET_BYTES) throw Error('INVALID_FRAME');
    const header = new DataView(packet);
    if (header.getUint32(0) !== MAGIC) throw Error('INVALID_FRAME');
    const id = header.getUint32(4), total = header.getUint32(8), offset = header.getUint32(12);
    const part = new Uint8Array(packet, HEADER_BYTES);
    if (!id || total < 1 || total > MAX_BUSINESS_BYTES || offset + part.length > total) throw Error('INVALID_FRAME');
    if (offset === 0) {
      const next = (this.#last + 1) >>> 0 || 1;
      if (this.#data !== null || id !== next) throw Error('MESSAGE_SEQUENCE');
      this.#id = id; this.#total = total; this.#offset = 0; this.#data = new Uint8Array(total); this.#deadline = now + 10000;
    }
    if (!this.#data || id !== this.#id || total !== this.#total || offset !== this.#offset || now > this.#deadline) throw Error('MESSAGE_SEQUENCE');
    this.#data.set(part, offset); this.#offset += part.length;
    if (this.#offset < total) return null;
    const result = this.#data; this.#data = null; this.#last = id; return result;
  }
}
export function encodeBase64(bytes: Uint8Array): string {
  if (bytes.length < 1 || bytes.length > MAX_BUSINESS_BYTES) throw Error('MESSAGE_TOO_LARGE');
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export function decodeBase64(value: string): Uint8Array {
  if (!value || value.length > Math.ceil(MAX_BUSINESS_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw Error('INVALID_FRAME');
  const binary = atob(value);
  if (binary.length > MAX_BUSINESS_BYTES || btoa(binary) !== value) throw Error('INVALID_FRAME');
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
