import { useSyncExternalStore } from 'react';
import type { RemoteAccess, RemoteState } from './RemoteAccess';

export function useRemoteState(remote: RemoteAccess): RemoteState {
  return useSyncExternalStore(remote.subscribe, remote.getSnapshot, remote.getSnapshot);
}
