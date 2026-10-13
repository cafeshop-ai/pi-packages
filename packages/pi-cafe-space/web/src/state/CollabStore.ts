import { enableMapSet, produce, type Draft } from 'immer';
import { nanoid } from 'nanoid';
import { applyEvent, type HostInfo, type SessionSnapshot, type JsonValue, type WireMessage } from '../../../src/protocol/index';
import type { ConnectionState, RelayEvent } from '../services/relay/RelayClient';
import { compactSnapshot } from './compactSnapshot';
enableMapSet();
export interface HostScope {
    readonly roomId: string;
    readonly hostId: string;
    readonly streamId: string;
    readonly sessionId: string;
    readonly cwd: string;
}
export const scopeKey = (scope: HostScope): string => JSON.stringify([scope.roomId, scope.hostId, scope.streamId, scope.sessionId, scope.cwd]);
export const historyCacheKey = (scope: HostScope, revision: number, command: string, sessionId: string | null = null) => JSON.stringify([scopeKey(scope), revision, command, sessionId]);
export interface HostState {
    info: HostInfo;
    snapshot: SessionSnapshot | null;
    stale: boolean;
    authority: number;
    revision: number;
}
export interface Notice {
    id: string;
    code: string;
    text: string;
    level: 'info' | 'warning' | 'error';
}
export interface CollabState {
    connection: ConnectionState;
    hosts: Map<string, HostState>;
    selectedHostId: string | null;
    viewGeneration: number;
    notices: Notice[];
    panels: Partial<Record<'directory' | 'file' | 'sessions' | 'session', JsonValue>>;
    history: Map<string, {
        data: JsonValue;
        bytes: number;
    }>;
    historyBytes: number;
}
export class CollabStore {
    #state: CollabState = { connection: { status: 'stopped', generation: 0, roomId: null }, hosts: new Map(), selectedHostId: null, viewGeneration: 0, notices: [], panels: {}, history: new Map(), historyBytes: 0 };
    #listeners = new Set<() => void>();
    #syncListeners = new Set<() => void>();
    #scheduled = false;
    #disposed = false;
    #resyncing = false;
    constructor(private readonly resync: () => void) { }
    getSnapshot = (): CollabState => this.#state;
    subscribe = (fn: () => void): (() => void) => { this.#listeners.add(fn); return () => { this.#listeners.delete(fn); }; };
    subscribeImmediate = (fn: () => void): (() => void) => { this.#syncListeners.add(fn); return () => { this.#syncListeners.delete(fn); }; };
    #update(fn: (state: Draft<CollabState>) => void): void {
        if (this.#disposed)
            return;
        const next = produce(this.#state, fn);
        if (next === this.#state)
            return;
        this.#state = next;
        for (const listener of this.#syncListeners)
            listener();
        if (!this.#scheduled) {
            this.#scheduled = true;
            queueMicrotask(() => { this.#scheduled = false; if (!this.#disposed)
                for (const listener of this.#listeners)
                    listener(); });
        }
    }
    dispose(): void { this.#disposed = true; this.#listeners.clear(); this.#syncListeners.clear(); }
    selectHost(id: string | null): void { if (id !== null && !this.#state.hosts.has(id))
        return; if (id === this.#state.selectedHostId)
        return; this.#update(s => { s.selectedHostId = id; s.viewGeneration++; s.panels = {}; }); }
    changeView(): number { this.#update(s => { s.viewGeneration++; s.panels = {}; }); return this.#state.viewGeneration; }
    scope(id = this.#state.selectedHostId): HostScope | null { const roomId = this.#state.connection.roomId; const host = id ? this.#state.hosts.get(id) : null; const snapshot = host?.snapshot; if (!roomId || !id || !snapshot)
        return null; return { roomId, hostId: id, streamId: snapshot.streamId, sessionId: snapshot.sessionId, cwd: snapshot.cwd }; }
    isScope(scope: HostScope): boolean { const actual = this.scope(scope.hostId); return actual !== null && scopeKey(actual) === scopeKey(scope); }
    notice(code: string, text = code, level: Notice['level'] = 'warning'): void { this.#update(s => { s.notices.push({ id: nanoid(), code: code.slice(0, 128), text: text.slice(0, 2048), level }); if (s.notices.length > 100)
        s.notices.splice(0, s.notices.length - 100); }); }
    #diverged(hostId?: string): void { this.#update(s => { if (hostId) {
        const h = s.hosts.get(hostId);
        if (h)
            h.stale = true;
    }
    else
        for (const h of s.hosts.values())
            h.stale = true; }); if (!this.#resyncing) {
        this.#resyncing = true;
        this.resync();
    } }
    #hostId(message: {
        hostId?: string;
    }): string | null { if (message.hostId !== undefined)
        return this.#state.hosts.has(message.hostId) ? message.hostId : null; return this.#state.hosts.size === 1 ? [...this.#state.hosts.keys()][0]! : null; }
    ingest(event: RelayEvent): void {
        if (this.#disposed || event.generation < this.#state.connection.generation)
            return;
        if (event.kind === 'state') {
            const changed = event.state.generation !== this.#state.connection.generation || event.state.status !== 'authenticated';
            this.#resyncing = false;
            this.#update(s => {
                const roomChanged = s.connection.roomId !== event.state.roomId;
                s.connection = event.state;
                if (roomChanged || ['stopped', 'auth-failed'].includes(event.state.status)) {
                    s.hosts.clear();
                    s.selectedHostId = null;
                    s.history.clear();
                    s.historyBytes = 0;
                }
                if (changed) {
                    for (const h of s.hosts.values())
                        h.stale = true;
                    s.viewGeneration++;
                    s.panels = {};
                    s.history.clear();
                    s.historyBytes = 0;
                }
            });
            return;
        }
        if (event.generation !== this.#state.connection.generation)
            return;
        if (event.kind === 'notice') {
            this.notice(event.code);
            return;
        }
        if (this.#state.connection.status !== 'authenticated')
            return;
        this.#message(event.message);
    }
    #message(message: WireMessage): void {
        if (message.type === 'host_status') {
            const entries: HostInfo[] = message.hosts ?? [{ hostId: message.hostId ?? 'legacy', connected: message.connected, streamId: message.streamId, sessionId: message.sessionId, sessionName: null, cwd: null }];
            if (new Set(entries.map(h => h.hostId)).size !== entries.length) {
                this.#diverged();
                return;
            }
            this.#update(s => {
                const ids = new Set(entries.map(h => h.hostId));
                for (const id of s.hosts.keys())
                    if (!ids.has(id))
                        s.hosts.delete(id);
                for (const info of entries) {
                    let h = s.hosts.get(info.hostId);
                    if (!h) {
                        h = { info, snapshot: null, stale: true, authority: 0, revision: 0 };
                        s.hosts.set(info.hostId, h);
                    }
                    else {
                        const contextChanged = h.snapshot && ((info.streamId !== null && h.snapshot.streamId !== info.streamId) || (info.sessionId !== null && h.snapshot.sessionId !== info.sessionId) || (info.cwd !== null && h.snapshot.cwd !== info.cwd));
                        if (contextChanged || info.connected && info.ready === false)
                            h.stale = true;
                        if (contextChanged && s.selectedHostId === info.hostId) {
                            s.viewGeneration++;
                            s.panels = {};
                        }
                        h.info = info;
                    }
                }
                if (s.selectedHostId && !s.hosts.has(s.selectedHostId)) {
                    s.selectedHostId = null;
                    s.viewGeneration++;
                    s.panels = {};
                }
                if (!s.selectedHostId && entries.length) {
                    s.selectedHostId = entries[0]!.hostId;
                    s.viewGeneration++;
                }
            });
            return;
        }
        if (message.type === 'snapshot') {
            const id = this.#hostId(message);
            if (!id) {
                this.#diverged();
                return;
            }
            const old = this.#state.hosts.get(id)!;
            const prev = old.snapshot;
            let next: SessionSnapshot;
            try {
                next = compactSnapshot(message.snapshot, id);
            }
            catch {
                this.#diverged(id);
                return;
            }
            if (prev && prev.streamId === next.streamId && prev.sessionId === next.sessionId && next.lastEventSeq < prev.lastEventSeq) {
                this.#diverged(id);
                return;
            }
            const identity = prev && (prev.streamId !== next.streamId || prev.sessionId !== next.sessionId || prev.cwd !== next.cwd);
            this.#update(s => { const h = s.hosts.get(id)!; h.snapshot = next; h.stale = false; h.info = { ...h.info, ready: h.info.connected, streamId: next.streamId, sessionId: next.sessionId, cwd: next.cwd, sessionName: next.sessionName }; h.authority++; h.revision++; if (identity) {
                s.history.clear();
                s.historyBytes = 0;
                if (s.selectedHostId === id) {
                    s.viewGeneration++;
                    s.panels = {};
                }
            } });
            return;
        }
        if (message.type === 'event') {
            const id = this.#hostId(message);
            if (!id) {
                this.#diverged();
                return;
            }
            const h = this.#state.hosts.get(id)!;
            if (h.stale || !h.info.connected || h.info.ready === false)
                return;
            if (!h.snapshot) {
                this.#diverged(id);
                return;
            }
            let snapshot: SessionSnapshot;
            try {
                snapshot = compactSnapshot(applyEvent(h.snapshot, message), id);
            }
            catch {
                this.#diverged(id);
                return;
            }
            this.#update(s => { const target = s.hosts.get(id)!; target.snapshot = snapshot; if (!['session_state', 'ui_wait', 'notice', 'model_changed', 'thinking_changed'].includes(message.event.kind)) {
                target.revision++;
                s.history.clear();
                s.historyBytes = 0;
            } });
            if (message.event.kind === 'notice')
                this.notice('PI_NOTICE', message.event.message, message.event.level);
            return;
        }
        if (message.type === 'error')
            this.notice(message.code, message.message);
    }
    cachedHistory(key: string): JsonValue | undefined { const entry = this.#state.history.get(key); if (!entry)
        return undefined; this.#update(s => { s.history.delete(key); s.history.set(key, entry); }); return entry.data; }
    commit(scope: HostScope, view: number, kind: 'directory' | 'file' | 'sessions' | 'session', data: JsonValue, historyKey?: string): boolean {
        if (view !== this.#state.viewGeneration || !this.isScope(scope) || this.#state.selectedHostId !== scope.hostId)
            return false;
        const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
        if (bytes > 256 * 1024)
            return false;
        this.#update(s => {
            s.panels[kind] = data;
            if (historyKey && bytes <= 4 * 1024 * 1024) {
                const old = s.history.get(historyKey);
                if (old) {
                    s.historyBytes -= old.bytes;
                    s.history.delete(historyKey);
                }
                s.history.set(historyKey, { data, bytes });
                s.historyBytes += bytes;
                while (s.history.size > 20 || s.historyBytes > 4 * 1024 * 1024) {
                    const key = s.history.keys().next().value!;
                    s.historyBytes -= s.history.get(key)!.bytes;
                    s.history.delete(key);
                }
            }
        });
        return true;
    }
}
