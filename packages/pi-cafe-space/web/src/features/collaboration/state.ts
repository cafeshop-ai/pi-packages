import type { Member, MemberState, WaitKind, WorkState } from './api';

export const stateLabels: Record<WorkState, string> = { working: '工作中', waiting: '等待中', idle: '空闲', away: '暂离' };
export const waitLabels: Record<WaitKind, string> = { member: '等成员', review: '等复核', user: '等本人授权', external: '等外部事件', decision: '等决定' };
/** A wait this long is highlighted; a state nobody refreshed for this long may no longer hold. */
export const longWait = 30 * 60_000;
export const staleState = 6 * 3600_000;

export const span = (ms: number) => ms < 60_000 ? '不到 1 分钟' : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} 分钟` : ms < 48 * 3600_000 ? `${Math.round(ms / 3_600_000)} 小时` : `${Math.round(ms / 86_400_000)} 天`;
export const when = (at: string) => new Date(at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export type StateTone = 'working' | 'waiting' | 'long' | 'stale' | 'idle' | 'away';
/** The chip text: what the member says it does, for how long, and whether that may be out of date. */
export function stateLine(st: MemberState, name: (id: string) => string, now: number): { tone: StateTone; label: string } {
  const age = now - Date.parse(st.since);
  const stale = st.state !== 'idle' && (now - Date.parse(st.updatedAt) > staleState || !!st.expect && Date.parse(st.expect) < now);
  const note = stale ? '（可能已过期）' : '';
  if (st.state === 'waiting') {
    const target = st.on?.length ? `等 ${st.on.map(name).join('、')}` : waitLabels[st.waitingFor ?? 'external'];
    return { tone: stale ? 'stale' : age >= longWait ? 'long' : 'waiting', label: `等待 · ${target} · ${span(age)}${note}` };
  }
  if (st.state === 'working') return { tone: stale ? 'stale' : 'working', label: `工作中${st.tasks?.length ? ' · ' + st.tasks.map(t => '#' + t).join(' ') : ''}${note}` };
  if (st.state === 'away') return { tone: 'away', label: `暂离${st.expect ? ' · 预计 ' + when(st.expect) + ' 回来' : ''}${note}` };
  return { tone: 'idle', label: '空闲' };
}

/** Current members who wait, and those of them who wait on me. Removed members never count. */
export function waitsOf(states: Record<string, MemberState> | undefined, members: Member[], me: string) {
  const waiting = members.filter(m => !m.removed && states?.[m.id]?.state === 'waiting');
  return { waiting, onMe: waiting.filter(m => states![m.id]!.on?.includes(me)) };
}
