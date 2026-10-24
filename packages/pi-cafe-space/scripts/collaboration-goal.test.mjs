import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consumeGoal, goalState, mergeGoal, pendingGoal } from './collaboration-goal.mjs';
const goal = { id: 1, title: 'Verify release', criteria: 'Tests pass\nKeep the data', reviewer: 'a'.repeat(32), createdBy: 'a'.repeat(32), status: 'active', updatedAt: '2030-01-01T00:00:00Z' };
const page = (revision, value = goal) => ({ goalRevision: revision, goal: value });

test('Goal changes have a durable acknowledgement separate from chat cursors', () => {
  const state = { fetched: 8, consumed: 4 };
  mergeGoal(state, page(1));
  assert.equal(pendingGoal(state).type, 'goal'); assert.equal(pendingGoal(state).revision, 1);
  assert.equal(state.fetched, 8); assert.equal(state.consumed, 4);
  const restart = JSON.parse(JSON.stringify(state));
  assert.deepEqual(pendingGoal(restart), pendingGoal(state));
  consumeGoal(restart, 1); assert.equal(pendingGoal(restart), null);
  assert.equal(restart.goal.status, 'active', 'notification acknowledgement must not complete a Goal');
  assert.equal(restart.consumed, 4);
});

test('stale long polls cannot undo pause/resume or resurrect a deleted goal', () => {
  const state = {};
  mergeGoal(state, page(1));
  mergeGoal(state, page(2, { ...goal, status: 'paused' }));
  mergeGoal(state, page(1));
  assert.equal(state.goal.status, 'paused');
  assert.throws(() => consumeGoal(state, 1), /goal changed/);
  consumeGoal(state, 2); assert.equal(pendingGoal(state), null);
  mergeGoal(state, page(3)); assert.equal(pendingGoal(state).goal.status, 'active');
  mergeGoal(state, page(4, null));
  mergeGoal(state, page(3));
  assert.equal(pendingGoal(state).goal, null); assert.equal(pendingGoal(state).revision, 4);
  assert.throws(() => consumeGoal(state, 3), /goal changed/);
  consumeGoal(state, 4); assert.equal(pendingGoal(state), null);
});

test('old servers and unchanged state do not generate wake loops', () => {
  const state = {};
  mergeGoal(state, {}); mergeGoal(state, page(0, null));
  assert.equal(pendingGoal(state), null);
  mergeGoal(state, page(1)); consumeGoal(state, 1);
  for (let i = 0; i < 20; i++) mergeGoal(state, page(1));
  assert.equal(pendingGoal(state), null);
  assert.equal(goalState({}), null);
});

test('Goal response validation rejects malformed state and strips unrelated fields', () => {
  for (const p of [page(-1), page(0), page(1, {}), page(1, { ...goal, reviewer: 'ai-name' }), page(1, { ...goal, status: 'done' }), page(1, { ...goal, title: 'x'.repeat(201) }), page(1, { ...goal, criteria: '\x1b[2J' }), page(1, { ...goal, result: 1 }), page(1, { ...goal, resultBy: 'a'.repeat(32) })]) assert.throws(() => goalState(p));
  assert.deepEqual(goalState(page(1, { ...goal, token: 'not-a-field' })).goal, goal);
  assert.equal(goalState(page(2, { ...goal, status: 'review', result: 5, resultBy: 'b'.repeat(32) })).goal.result, 5);
});
