// Manual trial only: load the existing cafe model into memory, not a fake stream.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export default function (pi) {
  try {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw Error('Interactive console required');
    const source = JSON.parse(readFileSync(process.env.PI_CAFE_SOURCE_MODELS, 'utf8'));
    const p = source.providers?.cafe;
    const m = p?.models?.find(value => value.id === 'gpt-6-astra');
    if (!p || !m || typeof p.apiKey !== 'string' || p.apiKey.startsWith('!') || p.modelOverrides || p.headers || m.headers || (m.api ?? p.api) !== 'openai-responses') throw Error('Unsupported cafe configuration');
    // Same defaults as Pi 0.85.1 modelFromJson; keep the existing model limits,
    // costs and thinking map. No stream override, request hook or API key copy.
    const model = { name: m.id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384, ...m };
    pi.registerProvider('cafe', { ...p, models: [model] });
  } catch { throw Error('Cannot load cafe for the isolated manual trial; no provider diagnostics printed'); }
  pi.on('session_start', (_event, ctx) => {
    writeFileSync(join(process.env.PI_CAFE_TRIAL_ROOT, 'ready.json'), JSON.stringify({ pid: process.pid, interactive: !!process.stdin.isTTY && !!process.stdout.isTTY, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), provider: ctx.model?.provider, model: ctx.model?.id }));
  });
}
