export function formatEvent(
  event: { type: 'msg'; seq: number; from: string; to?: string; replyTo?: number; text: string; truncated?: boolean },
  names?: Record<string, string>,
  me?: string,
): string;
