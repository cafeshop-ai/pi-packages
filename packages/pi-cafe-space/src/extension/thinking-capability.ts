import { isThinkingLevel, type ThinkingLevel } from '../protocol/index.js';

const LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export interface ThinkingCapability { reasoning: boolean; thinkingLevels: ThinkingLevel[] }
/** Project only declared native Pi metadata. Never infer support from a model name. */
export function thinkingCapability(model: unknown): ThinkingCapability | undefined {
  if (!model || typeof model !== 'object' || typeof (model as { reasoning?: unknown }).reasoning !== 'boolean') return undefined;
  const m = model as { reasoning: boolean; thinkingLevelMap?: unknown };
  if (!m.reasoning) return { reasoning: false, thinkingLevels: ['off'] };
  const mapping = m.thinkingLevelMap && typeof m.thinkingLevelMap === 'object' && !Array.isArray(m.thinkingLevelMap) ? m.thinkingLevelMap as Record<string, unknown> : undefined;
  // Matches Pi's getSupportedThinkingLevels contract: null excludes a level,
  // extended levels require an explicit mapping; ordinary levels default on.
  const thinkingLevels = LEVELS.filter(level => mapping?.[level] !== null && (level !== 'xhigh' && level !== 'max' || mapping?.[level] !== undefined));
  return { reasoning: true, thinkingLevels: thinkingLevels.length ? thinkingLevels : ['off'] };
}
export function applyThinkingLevel(api: { getThinkingLevel(): unknown; setThinkingLevel(level: ThinkingLevel): void }, model: unknown, requested: ThinkingLevel): { actual: ThinkingLevel | null; code: string | null } {
  const capability = thinkingCapability(model);
  if (capability && !capability.thinkingLevels.includes(requested)) {
    const current = api.getThinkingLevel();
    return { actual: isThinkingLevel(current) ? current : null, code: capability.reasoning ? 'THINKING_LEVEL_UNAVAILABLE' : 'THINKING_UNSUPPORTED' };
  }
  api.setThinkingLevel(requested);
  const actual = api.getThinkingLevel();
  return { actual: isThinkingLevel(actual) ? actual : null, code: actual === requested ? null : 'THINKING_NOT_APPLIED' };
}
