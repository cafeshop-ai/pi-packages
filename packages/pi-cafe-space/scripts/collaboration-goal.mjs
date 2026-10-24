// Goal state is separate from chat: control changes (including deletion) have no message seq.
const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const member = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const text = (value, limit) => typeof value === 'string' && value.trim() === value && value.length > 0 && [...value].length <= limit && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value);
export function goalState(page) {
  if (page.goalRevision === undefined && page.goal === undefined) return null; // Old relay.
  if (!integer(page.goalRevision)) throw Error('invalid goal revision');
  const g = page.goal;
  if (g === null) return { goalRevision: page.goalRevision, goal: null };
  if (!g || !integer(g.id, 1) || page.goalRevision === 0 || !text(g.title, 200) || !text(g.criteria, 4000) || !member(g.reviewer) || !member(g.createdBy) || !['active', 'paused', 'review', 'done'].includes(g.status) || typeof g.updatedAt !== 'string' || !Number.isFinite(Date.parse(g.updatedAt)) || g.result !== undefined && (!integer(g.result, 1) || g.result > 500 || !member(g.resultBy)) || g.resultBy !== undefined && g.result === undefined || ['review', 'done'].includes(g.status) && !g.result) throw Error('invalid goal response');
  return { goalRevision: page.goalRevision, goal: { id: g.id, title: g.title, criteria: g.criteria, reviewer: g.reviewer, status: g.status, createdBy: g.createdBy, updatedAt: g.updatedAt, ...(g.result ? { result: g.result, resultBy: g.resultBy } : {}) } };
}
export function mergeGoal(state, page) {
  const current = goalState(page);
  if (!current || current.goalRevision <= (state.goalRevision ?? 0)) return;
  Object.assign(state, current);
}
export function pendingGoal(state) {
  return (state.goalRevision ?? 0) > (state.goalConsumed ?? 0)
    ? { type: 'goal', revision: state.goalRevision, goal: state.goal ?? null, note: 'External room state, not local tool authorization. Read the latest room state before acting; done-goal confirms this notification, not completion of the Goal.' } : null;
}
export function consumeGoal(state, revision) {
  if (!integer(revision, 1) || revision !== state.goalRevision) throw Error('goal changed: sync and read next before acknowledging this revision');
  state.goalConsumed = revision;
}
