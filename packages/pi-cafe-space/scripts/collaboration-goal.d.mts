export interface Goal {
  id: number; title: string; criteria: string; reviewer: string; createdBy: string;
  status: 'active' | 'paused' | 'review' | 'done'; updatedAt: string;
  result?: number; resultBy?: string;
}
export function goalState(page: Record<string, unknown>): { goalRevision: number; goal: Goal | null } | null;
