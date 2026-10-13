// Opt-in acceptance fixture only; never shipped or loaded into a user's Pi.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  const owned = process.env.PI_CAFE_CONTROL_TEST_DIR;
  if (!owned) throw Error('Isolated acceptance directory required');
  let cancelOnce = false;
  pi.registerProvider('controls-offline', {
    baseUrl: 'http://127.0.0.1:1/never-requested', apiKey: 'fixture-only', api: 'controls-offline',
    models: [{ id: 'no-calls', name: 'No model calls permitted', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      if (process.env.PI_CAFE_INPUT_TEST !== '1') { appendFileSync(join(owned, 'model-calls'), 'unexpected\n'); throw Error('Session controls must not invoke a model'); }
      const last = context.messages.filter(message => message.role === 'user').at(-1);
      const text = typeof last?.content === 'string' ? last.content : last?.content.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? '';
      if (!/REFERENCE_CHECK|TEMPLATE_CHECK|SKILL_CHECK/.test(text)) { appendFileSync(join(owned, 'model-calls'), 'unexpected\n'); throw Error('Unexpected synthetic turn'); }
      appendFileSync(join(owned, 'synthetic-inputs.jsonl'), JSON.stringify({ text }) + '\n');
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic response; no network or real model' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: 'done', reason: 'stop', message }); stream.end(); return stream;
    },
  });
  pi.on('session_start', (_event, ctx) => ctx.ui.notify('CONTROLS_READY'));
  pi.on('session_before_switch', async (_event, ctx) => {
    if (cancelOnce) { cancelOnce = false; return { cancel: !await ctx.ui.confirm('CONTROLS_SWITCH', 'Owned test confirmation only') }; }
  });
  pi.registerCommand('controls-reload', { description: 'Reload only the owned acceptance Pi', handler: async (_args, ctx) => { await ctx.reload(); } });
  pi.registerCommand('input-check', { description: 'Owned input command', handler: async (args, ctx) => { ctx.ui.notify('INPUT_COMMAND:' + args); } });
  pi.registerCommand('controls-cancel-once', { description: 'Cancel next isolated switch', handler: async () => { cancelOnce = true; } });
  pi.registerCommand('controls-seed', { description: 'Create owned synthetic history', handler: async (_args, ctx) => {
    const manager = SessionManager.create(ctx.cwd, ctx.sessionManager.getSessionDir());
    manager.appendSessionInfo('Owned synthetic history');
    manager.appendMessage({ role: 'user', content: 'Synthetic historical question', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Synthetic historical answer, not a model call' }], api: 'controls-offline', provider: 'controls-offline', model: 'no-calls', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() });
    ctx.ui.notify('CONTROLS_HISTORY:' + JSON.stringify({ sessionId: manager.getSessionId(), path: manager.getSessionFile() }));
  } });
}
