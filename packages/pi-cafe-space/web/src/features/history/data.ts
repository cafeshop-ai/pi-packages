import { decodeWireMessage, type SessionSnapshot } from '../../../../src/protocol/index';
import { record, text, integer } from '../files/data';
export interface SessionItem { sessionId: string; name: string | null; cwd: string | null; created: string; modified: string; messageCount: number; firstMessage: string }
export function groupSessions(sessions: readonly SessionItem[], query: string, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const groups: Record<'today' | 'yesterday' | 'earlier', SessionItem[]> = { today: [], yesterday: [], earlier: [] };
  const search = query.trim().toLocaleLowerCase();
  const time = (session: SessionItem) => Date.parse(session.modified) || 0;
  for (const session of [...sessions].sort((a, b) => time(b) - time(a))) {
    if (![session.name, session.firstMessage, session.cwd, session.sessionId].some(value => value?.toLocaleLowerCase().includes(search))) continue;
    const modified = time(session);
    groups[modified >= +today ? 'today' : modified >= +yesterday ? 'yesterday' : 'earlier'].push(session);
  }
  return groups;
}
export interface SessionsData { kind: 'sessions'; currentSessionId: string; sessions: SessionItem[]; historyTruncated?: boolean }
export function parseSessions(value: unknown): SessionsData | null {
  const d = record(value);
  return d?.kind === 'sessions' && text(d.currentSessionId, 256) && Array.isArray(d.sessions) && d.sessions.length <= 100 && (d.historyTruncated === undefined || typeof d.historyTruncated === 'boolean') && d.sessions.every(item => {
    const s = record(item); return s && text(s.sessionId, 256) && !!s.sessionId && (s.name === null || text(s.name, 256)) && (s.cwd === null || text(s.cwd, 4096)) && text(s.created, 64) && text(s.modified, 64) && integer(s.messageCount) && text(s.firstMessage, 2048);
  }) ? d as unknown as SessionsData : null;
}
export function parseSession(value: unknown, expectedId: string): { snapshot: SessionSnapshot; modified: string } | null {
  const d = record(value);
  if (!d || d.kind !== 'session' || d.sessionId !== expectedId || !Array.isArray(d.messages) || d.messages.length > 100 || !text(d.modified, 64) || (d.cwd !== null && !text(d.cwd, 4096))) return null;
  try {
    const message = decodeWireMessage(JSON.stringify({ type: 'snapshot', snapshot: { protocolVersion: 1, streamId: 'history', sessionId: d.sessionId, sessionName: d.name, cwd: d.cwd ?? '', activeLeafId: d.activeLeafId, model: d.model, thinkingLevel: d.thinkingLevel, phase: 'idle', hasPendingMessages: false, messages: d.messages, historyTruncated: d.historyTruncated, tools: [], lastEventSeq: 0 } }));
    return message.type === 'snapshot' ? { snapshot: message.snapshot, modified: d.modified } : null;
  } catch { return null; }
}
export function historyIdFromPath(pathname: string): string | null {
  const prefix = '/history/';
  if (!pathname.startsWith(prefix)) return null;
  const segment = pathname.slice(prefix.length);
  if (!segment || segment.includes('/')) return null;
  try { const id = decodeURIComponent(segment); return id.length > 0 && id.length <= 256 ? id : null; } catch { return null; }
}
export function historyHref(id: string): string | null {
  if (!id || id.length > 256) return null;
  try { return `/history/${encodeURIComponent(id)}`; } catch { return null; }
}
