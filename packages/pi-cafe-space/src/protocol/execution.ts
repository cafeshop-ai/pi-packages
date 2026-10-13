/** Optional v1 metadata. Describes observed execution, never connection or authorization. */
export type ExecutionActivity = 'idle' | 'working' | 'waiting' | 'compacting' | 'retrying';
export type RunOutcome = 'none' | 'completed' | 'aborted' | 'error' | 'unknown';
export type PromptKind = 'select' | 'confirm' | 'input' | 'editor' | 'custom';
export type CompactionReason = 'manual' | 'threshold' | 'overflow';
export interface ExecutionState {
  version: 1;
  runId: string | null;
  activity: ExecutionActivity;
  outcome: RunOutcome;
  waitKind?: PromptKind;
  reason?: CompactionReason;
  attempt?: number;
  maxAttempts?: number;
  delayMs?: number;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const boundedInteger = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
export function isPromptKind(value: unknown): value is PromptKind { return ['select','confirm','input','editor','custom'].includes(value as string); }
export function isCompactionReason(value: unknown): value is CompactionReason { return ['manual','threshold','overflow'].includes(value as string); }
export function isExecutionState(value: unknown): value is ExecutionState {
  if (!object(value) || value.version !== 1 || !(value.runId === null || typeof value.runId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.runId)) ||
      !['idle','working','waiting','compacting','retrying'].includes(value.activity as string) || !['none','completed','aborted','error','unknown'].includes(value.outcome as string)) return false;
  if (value.outcome !== 'none' && (value.activity !== 'idle' || value.runId === null)) return false;
  if (value.waitKind !== undefined && (value.activity !== 'waiting' || !isPromptKind(value.waitKind))) return false;
  if (value.reason !== undefined && (value.activity !== 'compacting' || !isCompactionReason(value.reason))) return false;
  if (value.attempt !== undefined && (value.activity !== 'retrying' || !boundedInteger(value.attempt, 10000) || value.attempt < 1)) return false;
  if (value.maxAttempts !== undefined && (value.attempt === undefined || !boundedInteger(value.maxAttempts, 10000) || Number(value.maxAttempts) < Number(value.attempt))) return false;
  if (value.delayMs !== undefined && (value.activity !== 'retrying' || !boundedInteger(value.delayMs, 86400000))) return false;
  return true;
}
/** Rebuild a whitelist, so native messages/titles/errors/credentials cannot enter status. */
export function canonicalExecution(value: ExecutionState): ExecutionState {
  if (!isExecutionState(value)) throw Error('Invalid execution state');
  return { version:1, runId:value.runId, activity:value.activity, outcome:value.outcome,
    ...(value.waitKind === undefined ? {} : {waitKind:value.waitKind}),
    ...(value.reason === undefined ? {} : {reason:value.reason}),
    ...(value.attempt === undefined ? {} : {attempt:value.attempt}),
    ...(value.maxAttempts === undefined ? {} : {maxAttempts:value.maxAttempts}),
    ...(value.delayMs === undefined ? {} : {delayMs:value.delayMs}) };
}
