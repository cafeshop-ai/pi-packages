import { expect, it } from 'vitest';
import fixture from '../../../protocol/fixtures/parts/ordered.json';
import { compactSnapshot } from './compactSnapshot';
import { type SessionSnapshot, decodeWireMessage } from '../../../src/protocol/index';
it('preserves enhanced snapshots and drops oversized structure as an explicitly incomplete message', () => {
  const s = fixture.expectedFinal as SessionSnapshot;
  expect(compactSnapshot(s, 'h')).toStrictEqual(s);
  const huge: SessionSnapshot = { ...s, messages: [{ ...s.messages[0]!, parts: Array.from({ length: 12 }, (_, index) => ({ type: 'text', index, text: '😀'.repeat(32000) })) }] };
  const result = compactSnapshot(huge, 'h');
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]!.parts).toBeUndefined();
  expect(result.messages[0]!.partsTruncated).toBe(true);
  expect(result.historyTruncated).toBe(true);
  const raw = JSON.stringify({ type: 'snapshot', hostId: 'h', snapshot: result });
  expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(261120);
  expect(() => decodeWireMessage(raw)).not.toThrow();
});
