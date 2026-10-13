import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compactSnapshot as compactHost } from '../extension/index.js';
import { compactRelaySnapshot } from '../relay/server.js';
import { decodeWireMessage, fitCommandResult, MAX_FRAME_BYTES, type SessionSnapshot } from './index.js';
const fixture = JSON.parse(readFileSync(new URL('../../protocol/fixtures/parts/ordered.json', import.meta.url), 'utf8')) as { expectedFinal: SessionSnapshot };
for (const [name, compact] of Object.entries({ host: compactHost, node: compactRelaySnapshot })) {
  describe(name + ' parts compaction', () => {
    it('preserves in-budget fields including false and empty result', () => {
      expect(compact(fixture.expectedFinal)).toStrictEqual(fixture.expectedFinal);
    });
    it('drops an oversized parts array without losing the remaining message identity', () => {
      const s: SessionSnapshot = { ...fixture.expectedFinal, messages: [{ ...fixture.expectedFinal.messages[0]!, text: 'flat', thinking: '', parts: Array.from({ length: 12 }, (_, index) => ({ index, type: 'text', text: '😀'.repeat(32000) })) }] };
      const before = JSON.stringify(s);
      const result = compact(s);
      expect(JSON.stringify(s)).toBe(before);
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.id).toBe('a1');
      expect(result.messages[0]!.parts).toBeUndefined();
      expect(result.messages[0]!.partsTruncated).toBe(true);
      expect(result.historyTruncated).toBe(true);
      const encoded = JSON.stringify({ type: 'snapshot', hostId: 'h', snapshot: result });
      expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_FRAME_BYTES - 1024);
      expect(() => decodeWireMessage(encoded)).not.toThrow();
    });
  });
}
it('history result fit preserves nested parts or explicitly rejects an oversized graph', () => {
  const result = { type: 'command_result' as const, requestId: 'r', hostId: 'h', status: 'applied' as const, code: null, message: null, data: JSON.parse(JSON.stringify({ kind: 'session', messages: fixture.expectedFinal.messages })) };
  expect(fitCommandResult(result)).toStrictEqual(result);
  const huge = { ...result, data: { messages: Array.from({ length: 501 }, () => ({ parts: [] })) } };
  expect(fitCommandResult(huge).status).toBe('rejected');
});
