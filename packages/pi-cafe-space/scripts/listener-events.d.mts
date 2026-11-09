export const maxBatchMessages: number;
export function formatEvent(
  event: { type: 'msg'; seq: number; from: string; to?: string; replyTo?: number; text: string; truncated?: boolean } | { type: 'backlog'; from: number; to: number; count: number },
  names?: Record<string, string>,
  me?: string,
): string;
