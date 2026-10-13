import { expect, it } from 'vitest';
import ordered from '../../../../../protocol/fixtures/parts/ordered.json';
import type { SessionSnapshot, ToolExecution } from '../../../../../src/protocol/index';
import { convertMessages, type ToolView } from './convertMessages';
const scope = { roomId: 'r', hostId: 'h', streamId: 'stream', sessionId: 'session', cwd: 'C:/synthetic' };
const base = ordered.expectedFinal as SessionSnapshot;
const child = (id: string, status: ToolExecution['status'] = 'complete'): ToolExecution => ({ toolCallId: id, toolName: 'read', argsText: '{"path":"file.md"}', output: status === 'error' ? 'ENOENT: file.md' : 'retained output', status });
const snapshot = (tools: ToolExecution[]): SessionSnapshot => ({ ...base, messages: [{ ...base.messages[0]!, parts: [{ index: 0, type: 'tool-call', toolCallId: 'code', toolName: 'codemode', argsText: '{"code":"await tools.read(...)"}' }] }], tools: [{ ...child('code'), toolName: 'codemode' }, ...tools] });
function tools(s: SessionSnapshot, otherScope = scope): ToolView[] {
  return convertMessages(s, otherScope).flatMap(message => typeof message.content === 'string' ? [] : message.content.filter(part => part.type === 'tool-call' || part.type === 'data').map(part => (part.type === 'tool-call' ? part.artifact : part.type === 'data' ? part.data : null) as ToolView));
}
it('groups native nested IDs under their unique codemode call without losing errors, args or output', () => {
  const s = snapshot([child('code/1'), child('code/2', 'error'), child('code/1/1')]);
  const before = JSON.stringify(s), result = tools(s);
  expect(result).toHaveLength(1);
  expect(result[0]!.status).toBe('complete');
  expect(result[0]!.nestedTools?.map(t => t.callId)).toEqual(['code/1', 'code/2', 'code/1/1']);
  expect(result[0]!.nestedTools?.[1]).toMatchObject({ status: 'error', output: 'ENOENT: file.md', argsText: child('code/2').argsText, association: 'attached' });
  expect(new Set(result[0]!.nestedTools?.map(t => t.key)).size).toBe(3);
  expect(JSON.stringify(s)).toBe(before);
  expect(tools(s, { ...scope, hostId: 'other' })[0]!.nestedTools?.[0]!.key).not.toBe(result[0]!.nestedTools?.[0]!.key);
});
it('folds a retained nested result once and prefers its final output', () => {
  const s = snapshot([child('code/1')]);
  s.messages.push({ ...base.messages[1]!, role: 'tool', toolCallId: 'code/1', text: 'final result', toolIsError: true });
  expect(convertMessages(s, scope)).toHaveLength(1);
  expect(tools(s)[0]!.nestedTools?.[0]).toMatchObject({ status: 'error', output: 'final result', conflict: true });
});
it.each(['code/0', 'code/01', 'code/abc', 'code:1', 'code-copy/1', 'code/9007199254740992'])('does not guess parents from similar IDs: %s', id => {
  const result = tools(snapshot([child(id)]));
  expect(result).toHaveLength(2); expect(result[0]!.nestedTools).toBeUndefined(); expect(result[1]!.association).toBe('missing-parent');
});
it('retains children separately when parent ownership or result identity is ambiguous', () => {
  const s = snapshot([child('code/1')]); s.messages.push({ ...s.messages[0]!, id: 'duplicate-owner' });
  expect(tools(s).every(t => !t.nestedTools)).toBe(true);
  const duplicate = snapshot([child('code/1'), child('code/1', 'error')]);
  expect(tools(duplicate)).toHaveLength(3); expect(tools(duplicate).slice(1).every(t => t.association === 'ambiguous')).toBe(true);
  const results = snapshot([child('code/1')]);
  results.messages.push(...['r1','r2'].map(id => ({ ...base.messages[1]!, id, role: 'tool' as const, toolCallId: 'code/1' })));
  expect(tools(results)[0]!.nestedTools).toBeUndefined(); expect(convertMessages(results, scope)).toHaveLength(3);
});
it('honors direct call ownership and conflicting parent hints rather than reparenting them', () => {
  const s = snapshot([child('code/1')]);
  s.messages.push({ ...s.messages[0]!, id: 'direct', parts: [{ index: 0, type: 'tool-call', toolCallId: 'code/1', toolName: 'read', argsText: '{}' }] });
  expect(tools(s)[0]!.nestedTools).toBeUndefined(); expect(tools(s)[1]!.output).toBe('retained output');
  const conflicting = snapshot([{ ...child('code/1'), parentMessageId: 'another-message' }]);
  expect(tools(conflicting)[0]!.nestedTools).toBeUndefined(); expect(tools(conflicting)).toHaveLength(2);
});
it('does not infer nesting for unrecognized parent tools or missing parents', () => {
  const s = snapshot([child('code/1')]); s.messages[0]!.parts = [{ index: 0, type: 'tool-call', toolCallId: 'code', toolName: 'read', argsText: '{}' }];
  expect(tools(s)[0]!.nestedTools).toBeUndefined();
  s.messages = []; expect(tools(s)).toHaveLength(2);
  expect(convertMessages(s, scope).every(m => m.metadata?.custom?.incomplete === false)).toBe(true);
});
