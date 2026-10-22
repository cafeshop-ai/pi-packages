import type { Member, Message } from './api';

// A response test is an ordinary room message, so every member derives the same result from
// history. Success proves one round trip through the room, nothing about staying online or
// waking up on its own; silence has many causes, so it is never reported as a failure.
const pattern = /^【响应测试】.*?验证码\s*([A-HJ-NP-Z2-9]{4})/;
const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const probeWait = 10 * 60_000;
export const probeDaily = 6;

export const probeText = (code: string) => `【响应测试】收到请直接在房间回复验证码 ${code}，无需做其他事情。`;
export const probeCode = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), b => alphabet[b % alphabet.length]).join('');
export const probeOf = (message: Message, members: Member[]) => {
  const code = pattern.exec(message.text)?.[1];
  const sender = members.find(m => m.id === message.memberId); const target = members.find(m => m.id === message.to);
  return code && sender?.kind === 'human' && target?.kind === 'ai' ? code : undefined;
};

export type Probe = { message: Message; code: string; response?: Message; took?: string; state: 'ok' | 'waiting' | 'unknown'; label: string };
const duration = (ms: number) => { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`; };

/** The latest response test per AI, the answers to every test, and how many tests each AI got in the last day. */
export function probesOf(messages: Message[], members: Member[], now: number) {
  const latest = new Map<string, Probe>(); const answers = new Map<number, Probe>(); const recent = new Map<string, number>();
  const open: Probe[] = [];
  for (const message of messages) {
    const code = probeOf(message, members);
    if (code) {
      const probe: Probe = { message, code, state: 'waiting', label: '' }; open.push(probe); latest.set(message.to!, probe);
      if (now - Date.parse(message.at) < 24 * 3600_000) recent.set(message.to!, (recent.get(message.to!) ?? 0) + 1);
      continue;
    }
    const answered = open.find(p => p.message.to === message.memberId && !p.response && message.text.includes(p.code) && (!message.replyTo || message.replyTo === p.message.seq));
    if (answered) { answered.response = message; answered.took = duration(Date.parse(message.at) - Date.parse(answered.message.at)); answers.set(message.seq, answered); }
  }
  for (const probe of open) {
    probe.state = probe.response ? 'ok' : now - Date.parse(probe.message.at) < probeWait ? 'waiting' : 'unknown';
    probe.label = probe.state === 'ok' ? `本次响应测试成功，耗时 ${probe.took}` : probe.state === 'waiting' ? '正在等待响应测试的回复' : '尚未确认响应，原因未知';
  }
  return { latest, answers, recent };
}

/** Room-wide courtesy limits so no member keeps spending another AI's budget on tests. */
export const probeBlocked = (latest: Probe | undefined, recent: number, now: number) =>
  latest && now - Date.parse(latest.message.at) < probeWait ? '10 分钟内只能测试一次' : recent >= probeDaily ? `24 小时内最多测试 ${probeDaily} 次` : '';
