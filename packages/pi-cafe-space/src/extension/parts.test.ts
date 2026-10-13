import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildToolParentIndex, historicalMessages, messageProjection, transcriptMessageJson } from './index.js';
import type { TranscriptMessage } from '../protocol/index.js';
function expand(value: any): any {
  if (Array.isArray(value)) return value.map(expand);
  if (value && typeof value === 'object') {
    if (value.$repeat) return value.$repeat.text.repeat(value.$repeat.count);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expand(item)]));
  }
  return value;
}
const cases = expand(JSON.parse(readFileSync(new URL('../../protocol/fixtures/parts/projection-cases.json', import.meta.url), 'utf8'))) as any[];
const assistant = (content: unknown) => ({ role: 'assistant', timestamp: 1, content });
for (const test of cases.filter(c => c.content)) it(test.id, () => {
  const projected = messageProjection(assistant(test.content), 'a1', 'complete')!;
  expect(projected.parts).toStrictEqual(test.expectedParts);
  expect(projected.partsTruncated ?? false).toBe(test.incomplete);
});
for (const test of cases.filter(c => c.lookup)) it(test.id, () => {
  const messages = test.messages.map((m: any) => messageProjection(assistant(m.calls.map((id: string) => ({ type: 'toolCall', id, name: 'read', arguments: {} }))), m.id, 'complete')!) as TranscriptMessage[];
  expect(buildToolParentIndex(messages).get(test.lookup) ?? null).toBe(test.expectedParent);
});
it('projects 500 original indexes; 501st is omitted, never renumbered', () => {
  const content = Array.from({ length: 500 }, (_, index) => ({ type: 'text', text: String(index) }));
  const a = messageProjection(assistant(content), 'a', 'complete')!;
  expect(a.parts).toHaveLength(500);
  expect(a.partsTruncated ?? false).toBe(false);
  const b = messageProjection(assistant([...content, { type: 'text', text: '501' }]), 'a', 'complete')!;
  expect(b.parts).toHaveLength(500);
  expect(b.parts?.at(-1)?.index).toBe(499);
  expect(b.partsTruncated).toBe(true);
});
it('historical projection and JSON conversion preserve true/false errors and empty outputs', () => {
  const messages = [assistant([{ type: 'toolCall', id: 't1', name: 'read', arguments: {} }]), { role: 'toolResult', toolCallId: 't1', toolName: 'read', timestamp: 2, content: [], isError: true }, { role: 'toolResult', toolCallId: 't2', toolName: 'read', timestamp: 3, content: [], isError: false }];
  const history = historicalMessages(messages.map((message, i) => ({ type: 'message', id: `m${i}`, message })));
  expect(history.truncated).toBe(false);
  expect(history.messages[1]).toMatchObject({ text: '', toolIsError: true, status: 'error' });
  expect(history.messages[2]).toMatchObject({ text: '', toolIsError: false, status: 'complete' });
  expect(history.messages.map(transcriptMessageJson)).toStrictEqual(history.messages);
});
it('omits overlong result join IDs and bounds args and whole parts without colliding keys', () => {
  const tool = messageProjection({ role: 'toolResult', timestamp: 1, content: [], toolName: 'read', toolCallId: 'x'.repeat(257), isError: true }, 'r', 'complete')!;
  expect(tool.toolCallId).toBeNull();
  expect(tool.partsTruncated).toBe(true);
  const call = messageProjection(assistant([{ type: 'toolCall', id: 't', name: 'read', arguments: { text: 'x'.repeat(10000) } }]), 'a', 'complete')!;
  expect(call.partsTruncated).toBe(true);
  expect(call.parts?.[0]?.type === 'tool-call' && call.parts[0].argsText.length).toBeLessThanOrEqual(4096);
  const huge = messageProjection(assistant(Array.from({ length: 500 }, () => ({ type: 'text', text: '😀'.repeat(32768) }))), 'a', 'complete')!;
  expect(huge.parts).toBeUndefined();
  expect(huge.partsTruncated).toBe(true);
});
it('preserves failed historical assistant status as well as tool errors', () => {
  const history = historicalMessages([{ type: 'message', id: 'failed', message: { ...assistant([{ type: 'text', text: 'partial' }]), stopReason: 'error' } }]);
  expect(history.messages[0]?.status).toBe('error');
});
it('contains historical getter/proxy failures and recovers subsequent entries', () => {
  const damaged = new Proxy({}, { get() { throw Error('synthetic getter'); } });
  const history = historicalMessages([{ type: 'message', id: 'bad', message: damaged }, { type: 'message', id: 'good', message: assistant([{ type: 'text', text: 'ok' }]) }]);
  expect(history.truncated).toBe(true);
  expect(history.messages).toHaveLength(1);
  expect(history.messages[0]?.parts).toStrictEqual([{ index: 0, type: 'text', text: 'ok' }]);
});
