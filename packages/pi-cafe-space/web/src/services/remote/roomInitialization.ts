export type RoomInitStep = 'runtime' | 'random' | 'credentials' | 'origin' | 'websocket';
export interface RoomInitDiagnostic { step: RoomInitStep; exception: string }
const names = new Set(['Error','TypeError','RangeError','SyntaxError','SecurityError','NotSupportedError','InvalidStateError','AbortError','QuotaExceededError','OperationError']);
function safeException(error: unknown): string {
  try { const name = error && typeof error === 'object' && 'name' in error ? error.name : ''; return typeof name === 'string' && names.has(name) ? name : 'OtherError'; }
  catch { return 'OtherError'; }
}
export class RoomInitializationError extends Error {
  readonly diagnostic: RoomInitDiagnostic;
  constructor(step: RoomInitStep, original: unknown) {
    const exception = safeException(original);
    const code = step === 'random' ? 'ROOM_RANDOM_UNAVAILABLE' : step === 'origin' ? 'ROOM_INVALID_ORIGIN' : step === 'credentials' ? 'INVALID_ROOM_CREDENTIALS' : step === 'websocket' && exception === 'SecurityError' ? 'ROOM_SIGNAL_POLICY_DENIED' : step === 'websocket' ? 'ROOM_SIGNAL_START_FAILED' : 'ROOM_INITIALIZATION_FAILED';
    super(code); this.name = 'RoomInitializationError'; this.diagnostic = { step, exception };
  }
}
export function roomInitializationStep<T>(step: RoomInitStep, initialize: () => T): T {
  try { return initialize(); } catch (error) { throw new RoomInitializationError(step, error); }
}
export function roomInitializationFailure(error: unknown): { code: string; diagnostic: RoomInitDiagnostic } {
  if (error instanceof RoomInitializationError) return { code: error.message, diagnostic: error.diagnostic };
  if (error instanceof Error && error.message === 'ROOM_BROWSER_UNSUPPORTED') return { code: 'ROOM_BROWSER_UNSUPPORTED', diagnostic: { step: 'runtime', exception: safeException(error) } };
  return { code: 'ROOM_INITIALIZATION_FAILED', diagnostic: { step: 'runtime', exception: safeException(error) } };
}
