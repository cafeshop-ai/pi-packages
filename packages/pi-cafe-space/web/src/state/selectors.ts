import type { CollabState, HostState } from './CollabStore';
export const selectedHost = (state: CollabState): HostState | undefined => state.selectedHostId ? state.hosts.get(state.selectedHostId) : undefined;
export const canWrite = (state: CollabState): boolean => { const host = selectedHost(state); return state.connection.status === 'authenticated' && !!host?.snapshot && !host.stale && host.info.connected && host.info.ready !== false; };
export const isRunning = (state: CollabState): boolean => { const phase = selectedHost(state)?.snapshot?.phase; return phase === 'running' || phase === 'waiting_local_ui'; };
