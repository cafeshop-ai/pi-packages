export interface Membership { roomId: string; memberId: string; token: string }
export interface Member { id: string; name: string; kind: 'human' | 'ai'; agent?: string; owner: boolean; removed?: boolean }
export interface Message { seq: number; id: string; memberId: string; text: string; to?: string; replyTo?: number; at: string; truncated?: boolean }
/** A connector's own report (memory-only on the server); not proof that a model read anything. */
export interface Presence { fetched: number; delivered: number; paused?: boolean; heartbeatAt: string }
export type TaskStatus = 'todo' | 'doing' | 'done';
/** result/resultBy record a submitted (not accepted) delivery and stay with its submitter. */
export interface Task { id: number; title: string; status: TaskStatus; assignee?: string; createdBy: string; goalId?: number; from?: number; result?: number; resultBy?: string; updatedAt: string }
export interface Goal { id: number; title: string; criteria: string; reviewer: string; status: 'active' | 'paused' | 'review' | 'done'; createdBy: string; result?: number; resultBy?: string; updatedAt: string }
export interface GoalState { goal: Goal | null; goalRevision: number; tasks: Task[] }
export type WorkState = 'working' | 'waiting' | 'idle' | 'away';
export type WaitKind = 'member' | 'review' | 'user' | 'external' | 'decision';
/** What a member says it is doing (self-reported, never verified, not chat). since is when this state began. */
export interface MemberState { state: WorkState; waitingFor?: WaitKind; on?: string[]; tasks?: number[]; ref?: number; detail?: string; expect?: string; since: string; updatedAt: string }
/** older: earlier messages exist before this page; latestSeq: the newest seq. Pages read with before carry no cursor. */
export interface Snapshot { roomId: string; title: string; expires: string | null; members: Member[]; messages: Message[]; cursor: number; more: boolean; older?: boolean; latestSeq?: number; memberId: string; presence?: Record<string, Presence>; aiPaused?: boolean; tasks?: Task[]; goal?: Goal | null; goalRevision?: number; states?: Record<string, MemberState>; waitingOnYou?: string[] }
const errors: Record<string, string> = {
  INVALID_GOAL: '请填写目标、验收条件并选择在场的人类验收人。', GOAL_CHANGED: 'Goal 已变化，请读取最新状态后再操作，不要重复提交。', GOAL_EXISTS: '房间已有未完成的 Goal，请先完成或删除它。', GOAL_NOT_ACTIVE: 'Goal 未在进行中，相关任务已暂停；请检查目标状态及验收人。', GOAL_TASKS_OPEN: '请先完成 Goal 下的任务，再提交验收。', GOAL_REVIEWER_REQUIRED: '只有指定的人类验收人可以通过或退回 Goal。',
  MEMBER_REQUIRED: '成员凭据已失效或已被移除。', INVITE_INVALID: '邀请已撤销或无效，请向同事索取新邀请。',
  ROOM_UNAVAILABLE: '房间不存在或已到期。', ROOM_CLOSED: '房间已关闭。', RATE_LIMIT: '请求过于频繁，请在 60 秒后重试。',
  MEMBER_LIMIT: '每个房间最多登记 64 位成员。', MESSAGE_LIMIT: '当前服务器仍限制房间消息条数，请更新服务器后重试。',
  ROOM_LIMIT: '房间数量已达服务上限，请稍后再试或联系管理员。', INVITE_LIMIT: '邀请数量已达上限，请撤销旧邀请。',
  STORAGE_UNAVAILABLE: '服务器暂时无法保存，请稍后重试，不要重复执行操作。', STORAGE_LIMIT: '服务存储已满，请联系管理员。',
  INVALID_MESSAGE: '消息为空、过长或回复目标已失效。', INVALID_FIELDS: '请检查名称和房间标题。', NAME_TOO_LONG: '名称最多 16 个字，请用简短的称呼。', INVALID_AGENT: 'AI 类型只能用小写字母、数字、点和连字符，例如 claude-code。', AI_PAUSED: '房间已暂停 AI 发言。',
  INVALID_STATE: '状态无效：等待时要写清在等什么，等成员或等复核还要选择对象。',
  TASK_LIMIT: '任务数量已达上限，请先删除已完成的任务。', INVALID_TASK: '任务内容无效，或任务已被删除。', INVALID_ASSIGNEE: '负责人已不在房间里。', TASK_TAKEN: '这个任务刚被其他成员认领了。', INVALID_RESULT: '结果必须是你自己发在这个房间里的消息。',
};
export class CollaborationError extends Error {
  constructor(readonly code: string) { super(errors[code] ?? '操作失败，请检查连接；若结果未知，先刷新消息，不要重复创建或加入。'); }
}
export async function collaboration<T>(body: Record<string, unknown>, token?: string, signal?: AbortSignal): Promise<T> {
  const result = await fetch('/api/collaboration', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  if (!result.ok) { const error = await result.json().catch(() => ({})) as { error?: string }; throw new CollaborationError(error.error ?? 'UNAVAILABLE'); }
  return result.json() as Promise<T>;
}
const storageKey = (id: string) => 'cafe-collaboration-v1:' + id;
export function membership(id: string): Membership | null {
  try { const value = JSON.parse(localStorage.getItem(storageKey(id)) ?? 'null') as Membership | null;
    return value?.roomId === id && /^[a-f0-9]{32}$/.test(value.memberId) && /^[a-f0-9]{64}$/.test(value.token) ? value : null;
  } catch { return null; }
}
export function saveMembership(value: Membership) { localStorage.setItem(storageKey(value.roomId), JSON.stringify(value)); }
export function forgetMembership(id: string) { localStorage.removeItem(storageKey(id)); }
export function checkStorage() { const key = 'cafe-collaboration-storage-test'; localStorage.setItem(key, '1'); localStorage.removeItem(key); }
// Instructions follow how the AI will take part, not which product it is: any AI that can send
// HTTPS JSON requests can finish a task; only hosts that can wake it on new output can stay in.
// Whatever the user decides up front (which task, whom to answer) is written in, so a one-shot
// agent does not have to stop and ask. Task titles come from other members and stay out of the
// text: the AI reads them from the board as room content, never as the user's words. Member names
// are display data anyone can set, so authorization names members by memberId only.
export type AiMode = 'listen' | 'task';
export type AiReply = 'ask' | 'me' | 'everyone';
// listener: the invitation also allows downloading and running the official listener the server
// offers (docs/LISTENER.md). It is on unless a caller turns it off (the owner's decision); the agent
// still checks the file against the guide before running it.
export type AiOptions = { taskId?: number; reply?: AiReply; me?: { id: string; name: string }; listener?: boolean };
export function aiInstructions(link: string, mode: AiMode = 'listen', options: AiOptions = {}) {
  const guide = new URL(link).origin + '/api/collaboration/guide';
  const scope = options.reply === 'everyone' ? '，可以回答任何成员' : options.reply === 'me' && options.me ? `，只回复我（memberId ${options.me.id}）` : '，回复谁先问我';
  const work = mode === 'listen' ? `并持续参与${scope}` : options.taskId ? `，完成任务板上的任务 #${options.taskId} 后结束` : '，读完消息和任务板后向我报告，等我指定任务';
  return `我授权你按 ${guide} 加入这个 Café Space 房间${work}${options.listener !== false ? '' : '（不用官方监听器）'}：${link}`;
}

