import assert from 'node:assert/strict';
import test from 'node:test';
import { SharedPolicy } from './shared-policy.mjs';
const threadId = '00000000-0000-7000-8000-000000000001';
const foreign = '00000000-0000-7000-8000-000000000002';
const rpc = (method, params = {}, id = 1) => ({ id, method, params });

test('attach strips every model/permissions/MCP/instructions override', () => {
  const policy = new SharedPolicy({ threadId });
  const request = policy.client(rpc('thread/resume', { threadId, config: { projects: { '/': { trust_level: 'trusted' } } }, cwd: '/wrong', model: 'wrong', modelProvider: 'wrong', approvalPolicy: 'never', sandbox: 'danger-full-access', developerInstructions: 'wrong', runtimeWorkspaceRoots: ['/'], history: [], excludeTurns: false }));
  assert.deepEqual(request.params, { threadId, excludeTurns: true });
  assert(policy.stats.strippedOverrides >= 8);
});

test('no stored history, arbitrary mutation, foreign thread, login or global lifecycle', () => {
  const policy = new SharedPolicy({ threadId });
  for (const method of ['thread/start', 'thread/fork', 'thread/delete', 'thread/archive', 'thread/settings/update', 'thread/goal/set', 'account/login/start', 'account/logout', 'config/value/write', 'skills/extraRoots/set', 'server/shutdown']) {
    assert.throws(() => policy.client(rpc(method, { threadId })), /not allowed/);
  }
  assert.throws(() => policy.client(rpc('thread/read', { threadId, includeTurns: true })), /not allowed/);
  assert.throws(() => policy.client(rpc('thread/resume', { threadId: foreign })), /not allowed/);
});

test('zero budget cannot send; one budget strips sticky overrides, counts failures, no retry', () => {
  const params = { threadId, input: [{ type: 'text', text: 'hello' }], model: 'wrong', sandboxPolicy: {}, collaborationMode: {}, effort: 'high', serviceTier: 'fast' };
  assert.throws(() => new SharedPolicy({ threadId }).client(rpc('turn/start', params)), /not allowed/);
  assert.throws(() => new SharedPolicy({ threadId, promptBudget: 2 }));
  const policy = new SharedPolicy({ threadId, promptBudget: 1 });
  const request = policy.client(rpc('turn/start', params));
  assert.deepEqual(request.params, { threadId, input: [{ type: 'text', text: 'hello', text_elements: [] }] });
  policy.server({ id: 1, error: { code: -1 } });
  assert.throws(() => policy.client(rpc('turn/start', params, 2)), /not allowed/);
  assert.equal(policy.stats.promptAttempts, 1);
});

test('may interrupt only an owned turn, never the terminal turn or unrelated approvals', () => {
  const policy = new SharedPolicy({ threadId, promptBudget: 1 });
  assert.throws(() => policy.client(rpc('turn/interrupt', { threadId, turnId: 'terminal-turn' })), /not allowed/);
  policy.client(rpc('turn/start', { threadId, input: [{ type: 'text', text: 'hello' }] }));
  policy.server({ id: 1, result: { turn: { id: 'own-turn' } } });
  assert.equal(policy.client(rpc('turn/interrupt', { threadId, turnId: 'own-turn' }, 2)).params.turnId, 'own-turn');
  assert.equal(policy.server({ id: 10, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'terminal-turn' } }), null);
  assert.throws(() => policy.client({ id: 10, result: { decision: 'accept' } }), /Unowned/);
  policy.server({ id: 11, method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'own-turn' } });
  assert.deepEqual(policy.client({ id: 11, result: { decision: 'acceptForSession' } }), { id: 11, error: { code: -32000, message: 'Shared probe denies tool approval' } });
  policy.server({ method: 'turn/completed', params: { threadId, turn: { id: 'own-turn' } } });
  assert.throws(() => policy.client(rpc('turn/interrupt', { threadId, turnId: 'own-turn' }, 3)), /not allowed/);
});

test('does not forward foreign session data, broad account/config pushes or unknown replies', () => {
  const policy = new SharedPolicy({ threadId });
  assert.equal(policy.server({ method: 'item/agentMessage/delta', params: { threadId: foreign, delta: 'private' } }), null);
  assert.equal(policy.server({ method: 'account/updated', params: { secret: 'private' } }), null);
  assert.equal(policy.server({ id: 999, result: 'private' }), null);
  assert(policy.server({ method: 'item/agentMessage/delta', params: { threadId, delta: 'ok' } }));
  assert(policy.server({ method: 'thread/started', params: { thread: { id: threadId } } }));
  policy.client(rpc('config/read'));
  assert(policy.server({ id: 1, result: { config: {} } }));
  assert(!JSON.stringify(policy.stats).includes('private'));
});
