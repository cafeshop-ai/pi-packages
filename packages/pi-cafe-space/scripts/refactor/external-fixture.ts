import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, type AssistantMessage, type StreamFunction, type OpenAIResponsesOptions } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ExternalBudget } from './external-budget.ts';
export const TEST_PROMPT = 'Call r18_external_probe exactly once with marker R18_ONLY. After its result, reply with exactly R18_EXTERNAL_OK. This is a synthetic acceptance test.';
const SYSTEM = 'You are running a synthetic integration test. Use only the provided test tool. Do not request files, commands, or additional context.';
export default async function (pi: ExtensionAPI) {
  const dry = process.env.R18_EXTERNAL_DRY_RUN === '1';
  let config;
  try {
    const source = JSON.parse(readFileSync(process.env.R18_SOURCE_MODELS!, 'utf8'));
    const provider = source.providers?.cafe;
    const model = provider?.models?.find((m: { id: string }) => m.id === 'gpt-6-astra');
    if (!provider || !model || (model.api ?? provider.api) !== 'openai-responses' || typeof provider.apiKey !== 'string' || provider.apiKey.startsWith('!') || provider.headers || model.headers || model.compat || provider.compat || model.samplingParams || model.baseUrl || (model.thinkingLevelMap?.low !== undefined && model.thinkingLevelMap.low !== 'low') || provider.modelOverrides || model.reasoning !== true || !Number.isFinite(model.contextWindow)) throw Error();
    const base = new URL(provider.baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw Error();
    if (dry && (base.href !== 'https://example.invalid/v1' || provider.apiKey !== 'NON_SECRET_TEST_KEY')) throw Error();
    config = { apiKey: provider.apiKey as string, baseUrl: base.href, contextWindow: model.contextWindow as number };
  } catch { throw Error('External acceptance configuration rejected; no request sent'); }
  const secret = config.apiKey;
  // Explicit installed implementation: never recurse through the custom provider registry.
  const api: { stream: StreamFunction<'openai-responses', OpenAIResponsesOptions> } = await import(pathToFileURL(join(process.env.R18_PI_ROOT!, '../pi-ai/dist/api/openai-responses.js')).href);
  let dryCalls = 0;
  const fakeFetch: typeof fetch = async () => {
    dryCalls++;
    const item = dryCalls === 1 ? { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'r18_external_probe', arguments: '{"marker":"R18_ONLY"}' } : { type: 'message', id: 'msg_fixture', role: 'assistant', content: [{ type: 'output_text', text: 'R18_EXTERNAL_OK' }] };
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', content: [] } },
      dryCalls === 1 ? { type: 'response.function_call_arguments.delta', output_index: 0, delta: item.arguments } : { type: 'response.output_text.delta', output_index: 0, delta: 'R18_EXTERNAL_OK' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 8, total_tokens: 18 } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const budget = new ExternalBudget({ url: config.baseUrl.replace(/\/$/, '') + '/responses', apiKey: secret, ledger: process.env.R18_EXTERNAL_LEDGER!, fetch: dry ? fakeFetch : globalThis.fetch.bind(globalThis) });
  let tools = 0;
  const completions: { call: number; stopReason: string; outputTokens: number; reasoningTokens: number }[] = [];
  let failed = false;
  let dryDiagnostic: string | undefined;
  pi.registerProvider('cafe', {
    api: 'openai-responses', baseUrl: config.baseUrl, apiKey: secret,
    models: [{ id: 'gpt-6-astra', name: 'gpt-6-astra', reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low' }, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: config.contextWindow, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const ticket = budget.reserve();
          if (context.messages.filter(m => m.role === 'user').length !== 1 || context.tools?.length !== 1 || context.tools[0]?.name !== 'r18_external_probe') throw Error('CONTEXT_REJECTED');
          const user = context.messages.find(m => m.role === 'user');
          if (!user || !JSON.stringify(user.content).includes(TEST_PROMPT)) throw Error('CONTEXT_REJECTED');
          const stream = api.stream({ ...model, api: 'openai-responses', maxTokens: 1024 }, { ...context, systemPrompt: SYSTEM }, {
            apiKey: secret, maxTokens: 1024, maxRetries: 0, maxRetryDelayMs: 1, timeoutMs: ticket.timeoutMs,
            signal: options?.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal,
            fetch: ticket.fetch, cacheRetention: 'none', reasoningEffort: 'low', reasoningSummary: 'auto',
            toolChoice: ticket.call === 1 ? { type: 'function', name: 'r18_external_probe' } : 'none',
            onPayload: async (payload, selected) => {
              const result = await options?.onPayload?.(payload, selected) ?? payload;
              if (!result || typeof result !== 'object') throw Error('PAYLOAD_REJECTED');
              return { ...result, max_output_tokens: 1024 };
            },
          });
          for await (const event of stream) {
            if (event.type === 'error') { if (dry) dryDiagnostic = event.error.errorMessage; throw Error('PROVIDER_FAILURE'); }
            if (JSON.stringify(event).includes(secret)) throw Error('PROVIDER_FAILURE');
            if (event.type === 'done') {
              if (event.message.usage.output > 1024) throw Error('OUTPUT_LIMIT_VIOLATION');
              completions.push({ call: ticket.call, stopReason: event.message.stopReason, outputTokens: event.message.usage.output, reasoningTokens: event.message.usage.reasoning ?? 0 });
            }
            output.push(structuredClone(event));
          }
        } catch (error) {
          if (dry && !dryDiagnostic) dryDiagnostic = String(error);
          failed = true;budget.close();
          const message: AssistantMessage = { role: 'assistant', content: [], api: 'openai-responses', provider: 'cafe', model: 'gpt-6-astra', timestamp: Date.now(), stopReason: 'error', errorMessage: 'External acceptance stopped; private provider diagnostics suppressed', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          output.push({ type: 'error', reason: 'error', error: message });
        }
      })();
      return output;
    },
  });
  pi.registerTool({ name: 'r18_external_probe', label: 'External acceptance probe', description: 'Return a fixed non-secret test result. No filesystem, network, or shell access.', parameters: Type.Object({ marker: Type.Literal('R18_ONLY') }), async execute(_id, args) {
    if (++tools !== 1 || args.marker !== 'R18_ONLY') throw Error('TEST_TOOL_REJECTED');
    return { content: [{ type: 'text', text: 'R18_TOOL_OK' }], details: {} };
  } });
  pi.on('before_agent_start', () => ({ systemPrompt: SYSTEM }));
  pi.on('session_start', (_event, ctx) => { ctx.ui.notify('R18_EXTERNAL_READY', 'info'); });
  pi.on('agent_end', () => { budget.close(); });
  pi.on('session_shutdown', () => { budget.close(); });
  pi.registerCommand('r18-external-arm', { description: 'Arm one authorized budget', handler: async (_args, ctx) => { budget.arm();ctx.ui.notify('R18_EXTERNAL_ARMED', 'info'); } });
  pi.registerCommand('r18-external-stats', { description: 'Redacted acceptance accounting', handler: async (_args, ctx) => { ctx.ui.notify('R18_EXTERNAL_STATS:' + JSON.stringify({ ...budget.summary(), dry, tools, completions, failed, ...(dry ? { dryDiagnostic } : {}) }), 'info'); } });
  pi.registerCommand('r18-external-shutdown', { description: 'Stop this isolated acceptance Pi', handler: async (_args, ctx) => { budget.close();ctx.shutdown(); } });
}
