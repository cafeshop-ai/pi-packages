import { useCallback, useSyncExternalStore } from 'react';
import type { CollabState, CollabStore } from './CollabStore';
// Selectors must return stable per-host references or primitive values, not a
// newly constructed object on each call. Immer preserves unrelated host refs.
export function useCollabStore<T>(store: CollabStore, selector: (state: CollabState) => T): T {
    const snapshot = useCallback(() => selector(store.getSnapshot()), [store, selector]);
    return useSyncExternalStore(store.subscribe, snapshot, snapshot);
}
