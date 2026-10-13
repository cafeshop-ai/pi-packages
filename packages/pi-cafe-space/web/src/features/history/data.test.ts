import { expect, it } from 'vitest';
import ordered from '../../../../protocol/fixtures/parts/ordered.json';
import { groupSessions, historyHref, historyIdFromPath, parseSession, parseSessions } from './data';
import { parseDirectory, parseFile, childPath } from '../files/data';
it('history parses structured messages without changing active command fences', () => {
  const value = { kind: 'session', sessionId: 'saved/%2F:id', name: null, cwd: 'C:/synthetic', activeLeafId: null, model: null, thinkingLevel: 'off', messages: ordered.expectedFinal.messages, historyTruncated: false, modified: '2026-01-01' };
  const data = parseSession(value, value.sessionId);
  expect(data?.snapshot.messages).toEqual(ordered.expectedFinal.messages);
  expect(data?.snapshot.phase).toBe('idle');
  expect(parseSession(value, 'wrong')).toBeNull();
  expect(historyHref(value.sessionId)).toBe('/history/saved%2F%252F%3Aid');
  expect(historyHref('\ud800')).toBeNull();
  expect(historyIdFromPath(historyHref(value.sessionId)!)).toBe(value.sessionId);
  expect(historyIdFromPath('/history/%bad')).toBeNull();
  expect(historyIdFromPath('/history/a/b')).toBeNull();
});
it('filters real session metadata, sorts newest first and groups local dates without mutating inventory', () => {
  const item = (id: string, modified: string) => ({ sessionId: id, name: id, firstMessage: 'UI review', cwd: 'C:/café', created: modified, modified, messageCount: 3 });
  const sessions = [item('old', '2026-09-27T12:00:00'), item('invalid', 'unknown'), item('early', '2026-09-29T08:00:00'), item('yesterday', '2026-09-28T23:59:59'), item('latest', '2026-09-29T13:00:00')];
  const groups = groupSessions(sessions, ' UI ', new Date(2026, 8, 29, 14));
  expect(groups.today.map(s => s.sessionId)).toEqual(['latest', 'early']);
  expect(groups.yesterday.map(s => s.sessionId)).toEqual(['yesterday']);
  expect(groups.earlier.map(s => s.sessionId)).toEqual(['old', 'invalid']);
  expect(sessions[0]?.sessionId).toBe('old');
  expect(Object.values(groupSessions(sessions, 'no match')).flat()).toEqual([]);
  expect(Object.values(groupSessions(sessions, 'CAFÉ')).flat()).toHaveLength(5);
});
it('rejects malformed/oversized history result shapes', () => {
  expect(parseSessions({ kind: 'sessions', sessions: Array(101).fill({}) })).toBeNull();
  expect(parseSession({ kind: 'session', messages: [], sessionId: 'x' }, 'x')).toBeNull();
});
it('bounds file/directory views and only joins safe single entry names', () => {
  expect(childPath('.', 'file.txt')).toBe('file.txt'); expect(childPath('folder', 'file.txt')).toBe('folder/file.txt');
  for (const name of ['..', '../secret', 'dir/file', 'dir\\file', 'drive:stream', '\0']) expect(childPath('.', name)).toBeNull();
  expect(parseDirectory({ kind: 'directory', path: '.', entries: [{ name: 'file', kind: 'file' }], truncated: false })?.entries).toHaveLength(1);
  expect(parseDirectory({ kind: 'directory', path: '.', entries: Array(301).fill({ name: 'file', kind: 'file' }), truncated: false })).toBeNull();
  expect(parseFile({ kind: 'file', path: 'a', offset: 0, bytesRead: 0, size: 0, content: '', truncated: false })?.content).toBe('');
  expect(parseFile({ kind: 'file', path: 'a', offset: -1, bytesRead: 0, size: 0, content: '', truncated: false })).toBeNull();
});
