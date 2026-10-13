import { expect, it } from 'vitest';
import ordered from '../../../../../protocol/fixtures/parts/ordered.json';
import { type SessionSnapshot } from '../../../../../src/protocol/index';
import { convertMessages, type ToolView } from './convertMessages';
const scope = { roomId: 'r', hostId: 'h', streamId: 'stream', sessionId: 'session', cwd: 'C:/synthetic' };
const snapshot = ordered.expectedFinal as SessionSnapshot;
const view = (part: { type: string; artifact?: unknown; data?: unknown }) => (part.type === 'tool-call' ? part.artifact : part.data) as ToolView;
it('converts exactly ordered parts and folds final results once, including empty and errors', () => {
  const messages = convertMessages(snapshot, scope);
  expect(messages).toHaveLength(1);
  const parts = messages[0]!.content;
  if (typeof parts === 'string') throw Error('expected parts');
  expect(parts.map(p => p.type)).toEqual(['text', 'tool-call', 'text', 'tool-call', 'text']);
  const t1 = view(parts[1]!); const t2 = view(parts[3]!);
  expect(t1).toMatchObject({ callId: 't1', output: '', hasOutput: true, status: 'complete', association: 'attached' });
  expect(t2).toMatchObject({ callId: 't2', status: 'error' });
  expect(t1.key).not.toBe(t2.key);
  expect(convertMessages(JSON.parse(JSON.stringify(snapshot)), scope)).toEqual(messages);
});
it('does not infer from names or nearest assistant; legacy explicit unique IDs only', () => {
  const legacy = { ...snapshot, messages: snapshot.messages.map(m => { const { parts: _p, ...rest } = m; return rest; }) };
  const messages = convertMessages(legacy, scope);
  expect(messages).toHaveLength(3); // original assistant and two result positions
  const fallback = messages.slice(1).map(m => typeof m.content === 'string' ? null : view(m.content[0]!));
  expect(fallback.map(v => v?.association)).toEqual(['missing-parent', 'missing-parent']);
  expect(messages[0]?.metadata?.custom?.sourceId).toBe('a1');
  const explicit = { ...legacy, messages: legacy.messages.map((m, i) => i === 0 ? { ...m, toolCallId: 't1' } : m) };
  expect(convertMessages(explicit, scope)).toHaveLength(2);
});
it('duplicate call ownership stays ambiguous, even inside one assistant and with a parent hint', () => {
  const base = snapshot.messages[0]!;
  const duplicate = { ...snapshot, messages: [{ ...base, parts: [{ index: 0, type: 'tool-call' as const, toolCallId: 't1', toolName: 'read', argsText: '{}' }, { index: 1, type: 'tool-call' as const, toolCallId: 't1', toolName: 'read', argsText: '{}' }] }, snapshot.messages.find(m => m.toolCallId === 't1' && m.role === 'tool')!] };
  const messages = convertMessages(duplicate, scope);
  const parts = messages[0]!.content;
  if (typeof parts === 'string') throw Error('expected parts');
  expect(parts.map(p => view(p).association)).toEqual(['ambiguous', 'ambiguous']);
  expect(parts.map(p => view(p).hasOutput)).toEqual([false, false]);
  expect(messages[1]?.metadata?.custom?.sourceRole).toBe('tool');
});
it('keeps scopes distinct and never uses another host data to resolve a call', () => {
  const a = convertMessages(snapshot, scope); const b = convertMessages(snapshot, { ...scope, hostId: 'other' });
  expect(a[0]?.id).not.toBe(b[0]?.id);
  const pa = a[0]!.content; const pb = b[0]!.content;
  if (typeof pa === 'string' || typeof pb === 'string') throw Error('expected parts');
  expect(view(pa[1]!).key).not.toBe(view(pb[1]!).key);
});
it('does not turn absent, invalid or truncated args into an apparently validated empty object', () => {
  const a = snapshot.messages[0]!;
  for (const argsText of ['{broken', '[]', 'null', '{"__proto__":{}}']) {
    const messages = convertMessages({ ...snapshot, messages: [{ ...a, parts: [{ index: 7, type: 'tool-call', toolCallId: 't1', toolName: 'read', argsText }] }] }, scope);
    const parts = messages[0]!.content;
    if (typeof parts === 'string') throw Error('expected parts');
    expect(parts[0]?.type).toBe('data');
    expect(view(parts[0]!)).toMatchObject({ argsText, argsValid: false });
  }
});
it('empty enhanced parts take precedence over flat text and tool shortcut; absent executions remain pending', () => {
  const s = { ...snapshot, tools: [], messages: [{ ...snapshot.messages[0]!, parts: [], text: 'not duplicated', toolCallId: 't1' }] };
  expect(convertMessages(s, scope)[0]?.content).toEqual([]);
  const p = convertMessages({ ...snapshot, tools: [], messages: snapshot.messages.slice(0, 1) }, scope)[0]!.content;
  if (typeof p === 'string') throw Error('expected parts');
  expect(view(p[1]!).status).toBe('pending');
});
it('explicit error cannot be reversed by legacy complete; contradictory terminals mark conflict', () => {
  const result = snapshot.messages.find(m => m.role === 'tool' && m.toolCallId === 't2')!;
  for (const toolIsError of [undefined, false]) {
    const s = { ...snapshot, messages: [snapshot.messages[0]!, { ...result, status: 'complete' as const, toolIsError }] };
    const parts = convertMessages(s, scope)[0]!.content;
    if (typeof parts === 'string') throw Error('expected parts');
    expect(view(parts[3]!)).toMatchObject({ status: 'error', conflict: toolIsError === false });
  }
});
it('orphan execution is a transcript live-edge data item, not a guessed assistant owner', () => {
  const result = convertMessages({ ...snapshot, messages: [] }, scope);
  expect(result).toHaveLength(2);
  expect(result.map(m => m.metadata?.custom?.projectionOnly)).toEqual([true, true]);
  expect(result.map(m => m.metadata?.custom?.incomplete)).toEqual([false, false]);
  expect(result.map(m => typeof m.content === 'string' ? null : view(m.content[0]!).association)).toEqual(['missing-parent', 'missing-parent']);
});
