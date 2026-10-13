import { nanoid } from 'nanoid';
import { canonicalCommandPayload, decodeWireMessage, isCommandPayload, isSessionSnapshot, MAX_FRAME_BYTES, type ClientCommandMessage, type CommandPayload, type CommandResultMessage, type JsonValue } from '../../../../src/protocol/index';
import { CollabStore, scopeKey, historyCacheKey, type HostScope } from '../../state/CollabStore';
import type { RelayClient, RelayEvent } from './RelayClient';
type ClientPort = Pick<RelayClient, 'getState' | 'subscribe' | 'sendCommand'>;
export interface ExecuteOptions {
    signal?: AbortSignal;
    timeoutMs?: number;
    viewGeneration?: number;
    /** Completion reads do not replace the file browser's panel or request slot. */
    transient?: boolean;
}
export interface GatewayResult {
    status: 'applied' | 'dispatched' | 'rejected' | 'unknown';
    code: string | null;
    message: string | null;
    data?: JsonValue;
}
interface Pending {
    request: ClientCommandMessage;
    scope: HostScope;
    generation: number;
    view: number;
    revision: number;
    authority: number;
    slot: string;
    transient: boolean;
    bytes: number;
    sent: boolean;
    retried: boolean;
    retryAfter: number | null;
    resolve: (r: GatewayResult) => void;
    timer: ReturnType<typeof setTimeout>;
    cleanup: () => void;
}
const reads = new Set(['list_dir', 'read_file', 'list_sessions', 'get_session', 'list_commands']);
const history = new Set(['list_sessions', 'get_session']);
const encoder = new TextEncoder();
const failure = (code: string, unknown = false): GatewayResult => ({ status: unknown ? 'unknown' : 'rejected', code: unknown ? 'RESULT_UNKNOWN' : code, message: code });
function record(v: unknown): Record<string, unknown> | null { return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; }
const text = (v: unknown, n: number): v is string => typeof v === 'string' && v.length <= n;
const nullableText = (v: unknown, n: number): boolean => v === null || text(v, n);
const integer = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
function validData(payload: CommandPayload, data: unknown, scope: HostScope): boolean {
    const d = record(data);
    if (!d)
        return false;
    switch (payload.name) {
        case 'list_commands': return d.kind === 'commands' && typeof d.truncated === 'boolean' && Array.isArray(d.commands) && d.commands.length <= 200 && d.commands.every(item => { const v = record(item); return v && text(v.name, 128) && /^[^\s/\\\u0000-\u001f\u007f]+$/u.test(v.name) && text(v.description, 160) && ['extension', 'prompt', 'skill'].includes(String(v.source)); });
        case 'list_dir': return d.kind === 'directory' && d.path === (payload.path || '.') && typeof d.truncated === 'boolean' && Array.isArray(d.entries) && d.entries.length <= 300 && d.entries.every(e => { const v = record(e); return v && text(v.name, 4096) && ['directory', 'file', 'link'].includes(String(v.kind)); });
        case 'read_file': return d.kind === 'file' && d.path === payload.path && d.offset === (payload.offset ?? 0) && integer(d.size) && integer(d.bytesRead, 128 * 1024) && typeof d.truncated === 'boolean' && text(d.content, 128 * 1024);
        case 'list_sessions': return d.kind === 'sessions' && d.currentSessionId === scope.sessionId && (d.historyTruncated === undefined || typeof d.historyTruncated === 'boolean') && Array.isArray(d.sessions) && d.sessions.length <= 100 && d.sessions.every(item => { const v = record(item); return v && text(v.sessionId, 256) && v.sessionId.length > 0 && nullableText(v.name, 256) && nullableText(v.cwd, 4096) && text(v.created, 64) && v.created.length > 0 && text(v.modified, 64) && v.modified.length > 0 && integer(v.messageCount) && text(v.firstMessage, 2048); });
        case 'get_session': return d.kind === 'session' && d.sessionId === payload.sessionId && nullableText(d.name, 256) && nullableText(d.cwd, 4096) && text(d.modified, 64) && d.modified.length > 0 && Array.isArray(d.messages) && d.messages.length <= 100 && isSessionSnapshot({ protocolVersion: 1, streamId: 'history', sessionId: d.sessionId, sessionName: d.name, cwd: d.cwd ?? '', activeLeafId: d.activeLeafId, model: d.model, thinkingLevel: d.thinkingLevel, phase: 'idle', hasPendingMessages: false, messages: d.messages, historyTruncated: d.historyTruncated, tools: [], lastEventSeq: 0 });
        default: return true;
    }
}
export class CommandGateway {
    #pending = new Map<string, Pending>();
    #bytes = 0;
    #latest = new Map<string, string>();
    #disposed = false;
    #unsubscribers: (() => void)[];
    constructor(private readonly client: ClientPort, private readonly store: CollabStore, private readonly admit?: (payload: CommandPayload, scope: HostScope) => string | null) { this.#unsubscribers = [client.subscribe(event => this.#event(event)), store.subscribeImmediate(() => this.#scopeChanged())]; }
    stats = (): {
        count: number;
        bytes: number;
    } => ({ count: this.#pending.size, bytes: this.#bytes });
    execute(payload: CommandPayload, capturedScope: HostScope, options: ExecuteOptions = {}): Promise<GatewayResult> {
        if (this.#disposed)
            return Promise.resolve(failure('DISPOSED'));
        if (!isCommandPayload(payload))
            return Promise.resolve(failure('INVALID_COMMAND'));
        const scope = { ...capturedScope };
        const state = this.store.getSnapshot();
        const host = state.hosts.get(scope.hostId);
        const generation = this.client.getState().generation;
        const view = options.viewGeneration ?? state.viewGeneration;
        if (options.signal?.aborted)
            return Promise.resolve(failure('CANCELLED'));
        if (!this.store.isScope(scope) || view !== state.viewGeneration || state.selectedHostId !== scope.hostId)
            return Promise.resolve(failure('VIEW_CHANGED'));
        if (state.connection.status !== 'authenticated' || this.client.getState().status !== 'authenticated' || state.connection.generation !== generation)
            return Promise.resolve(failure('NOT_CONNECTED'));
        if (!host || host.stale || !host.snapshot)
            return Promise.resolve(failure('HOST_NOT_READY'));
        if (!host.info.connected && !history.has(payload.name))
            return Promise.resolve(failure('HOST_OFFLINE'));
        if (host.info.connected && host.info.ready === false)
            return Promise.resolve(failure('HOST_NOT_READY'));
        const denied = this.admit?.(payload, scope);
        if (denied) return Promise.resolve(failure(denied));
        if (['list_commands', 'run_command'].includes(payload.name) || payload.name === 'prompt' && payload.files !== undefined) {
            if (host.snapshot.inputAssist !== true) return Promise.resolve(failure('INPUT_ASSIST_UNAVAILABLE'));
            if (payload.name === 'run_command' && (host.snapshot.phase !== 'idle' || host.snapshot.hasPendingMessages || [...this.#pending.values()].some(p => p.scope.hostId === scope.hostId && p.request.payload.name === 'run_command'))) return Promise.resolve(failure('SESSION_BUSY'));
        }
        if (['new_session', 'rename_session', 'resume_session'].includes(payload.name)) {
            if (host.snapshot.sessionControl !== true)
                return Promise.resolve(failure('SESSION_CONTROL_UNAVAILABLE'));
            if (host.snapshot.phase !== 'idle' || host.snapshot.hasPendingMessages || [...this.#pending.values()].some(p => p.scope.hostId === scope.hostId && ['new_session', 'rename_session', 'resume_session'].includes(p.request.payload.name)))
                return Promise.resolve(failure('SESSION_BUSY'));
        }
        const requestId = nanoid();
        const request: ClientCommandMessage = { type: 'command', requestId, targetHostId: scope.hostId, expectedStreamId: scope.streamId, expectedSessionId: scope.sessionId, expectedCwd: scope.cwd, payload: canonicalCommandPayload(payload) };
        let bytes: number;
        try {
            const raw = JSON.stringify(request);
            decodeWireMessage(raw);
            bytes = encoder.encode(raw).length;
        }
        catch {
            return Promise.resolve(failure('COMMAND_TOO_LARGE'));
        }
        const abort = payload.name === 'abort';
        const perHost = [...this.#pending.values()].filter(p => p.scope.hostId === scope.hostId).length;
        if (this.#pending.size >= (abort ? 256 : 255) || perHost >= (abort ? 32 : 31) || this.#bytes + bytes > 8 * 1024 * 1024 - (abort ? 0 : MAX_FRAME_BYTES))
            return Promise.resolve(failure('COMMAND_QUEUE_FULL'));
        const timeout = options.timeoutMs ?? 20000;
        if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120000)
            return Promise.resolve(failure('INVALID_TIMEOUT'));
        return new Promise(resolve => {
            let p: Pending;
            const timer = setTimeout(() => { if (p)
                this.#settle(p.request.requestId, failure('TIMEOUT', p.sent && !reads.has(payload.name))); }, timeout);
            const onAbort = () => { if (p)
                this.#settle(p.request.requestId, failure('CANCELLED', p.sent && !reads.has(payload.name))); };
            const transient = options.transient === true || payload.name === 'list_commands';
            const slot = reads.has(payload.name) ? payload.name + (transient ? ':transient' : '') : '';
            if (slot)
                this.#latest.set(slot, requestId);
            p = { request, scope, generation, view, revision: host.revision, authority: host.authority, slot, transient, bytes, sent: false, retried: false, retryAfter: null, resolve, timer, cleanup: () => options.signal?.removeEventListener('abort', onAbort) };
            this.#pending.set(requestId, p);
            this.#bytes += bytes;
            options.signal?.addEventListener('abort', onAbort, { once: true });
            this.#send(p);
        });
    }
    #send(p: Pending): void { try {
        p.sent = true;
        this.client.sendCommand(p.request, p.generation);
    }
    catch {
        this.#settle(p.request.requestId, failure('SEND_FAILED', !reads.has(p.request.payload.name)));
    } }
    #settle(id: string, result: GatewayResult): void { const p = this.#pending.get(id); if (!p)
        return; this.#pending.delete(id); this.#bytes -= p.bytes; clearTimeout(p.timer); p.cleanup(); if (p.slot && this.#latest.get(p.slot) === id)
        this.#latest.delete(p.slot); p.resolve(result); }
    #scopeChanged(): void {
        const state = this.store.getSnapshot();
        for (const [id, p] of [...this.#pending]) {
            if (state.connection.status !== 'authenticated' || state.connection.generation !== p.generation) {
                this.#settle(id, failure('CONNECTION_CHANGED', p.sent && !reads.has(p.request.payload.name)));
                continue;
            }
            if (!this.store.isScope(p.scope) || state.viewGeneration !== p.view || state.selectedHostId !== p.scope.hostId) {
                this.#settle(id, failure('VIEW_CHANGED', p.sent && !reads.has(p.request.payload.name)));
                continue;
            }
            const h = state.hosts.get(p.scope.hostId)!;
            if (p.retryAfter !== null) {
                if (h.authority > p.retryAfter && !h.stale && h.info.connected && h.info.ready !== false) {
                    if (p.slot && this.#latest.get(p.slot) !== id) {
                        this.#settle(id, failure('VIEW_CHANGED'));
                        continue;
                    }
                    p.retryAfter = null;
                    p.retried = true;
                    p.revision = h.revision;
                    p.authority = h.authority;
                    // A rejected wire request is complete. Retry with a fresh ID, keeping the
                    // original local deadline; late replies to the old ID cannot settle it.
                    this.#pending.delete(id);
                    const newId = nanoid();
                    p.request = { ...p.request, requestId: newId };
                    this.#pending.set(newId, p);
                    if (p.slot)
                        this.#latest.set(p.slot, newId);
                    this.#send(p);
                }
            }
        }
    }
    #event(event: RelayEvent): void {
        if (event.kind !== 'message' || event.message.type !== 'command_result')
            return;
        const result = event.message;
        const p = this.#pending.get(result.requestId);
        if (!p || event.generation !== p.generation)
            return;
        if (result.hostId !== p.scope.hostId && !(result.hostId === undefined && this.store.getSnapshot().hosts.size === 1 && this.store.getSnapshot().hosts.has(p.scope.hostId))) {
            this.#settle(result.requestId, failure('RESULT_INVALID', p.sent && !reads.has(p.request.payload.name)));
            return;
        }
        if (result.status === 'dispatched' && result.code === 'REQUEST_PENDING')
            return;
        if (result.status === 'rejected' && result.code === 'HOST_NOT_READY' && reads.has(p.request.payload.name) && !p.retried && p.retryAfter === null) {
            p.retryAfter = this.store.getSnapshot().hosts.get(p.scope.hostId)!.authority;
            return;
        }
        if (p.slot && this.#latest.get(p.slot) !== result.requestId) {
            this.#settle(result.requestId, failure('VIEW_CHANGED'));
            return;
        }
        const host = this.store.getSnapshot().hosts.get(p.scope.hostId);
        if (result.status !== 'rejected' && (!host || host.stale || host.info.ready === false && host.info.connected || !host.info.connected && !history.has(p.request.payload.name))) {
            this.#settle(result.requestId, failure('STALE_CONTEXT', p.sent && !reads.has(p.request.payload.name)));
            return;
        }
        if (history.has(p.request.payload.name) && host?.revision !== p.revision) {
            this.#settle(result.requestId, failure('STALE_SESSION'));
            return;
        }
        if (result.status === 'applied' && reads.has(p.request.payload.name) && !validData(p.request.payload, result.data, p.scope)) {
            this.#settle(result.requestId, failure('RESULT_INVALID'));
            return;
        }
        if (result.status === 'applied' && reads.has(p.request.payload.name) && !p.transient && result.data !== undefined) {
            const kind = (result.data as {
                kind: 'directory' | 'file' | 'sessions' | 'session';
            }).kind;
            const key = history.has(p.request.payload.name) ? historyCacheKey(p.scope, p.revision, p.request.payload.name, p.request.payload.name === 'get_session' ? p.request.payload.sessionId : null) : undefined;
            if (!this.store.commit(p.scope, p.view, kind, result.data, key)) {
                this.#settle(result.requestId, failure('VIEW_CHANGED'));
                return;
            }
        }
        const unknownWrite = !reads.has(p.request.payload.name) && result.status === 'rejected' && ['HOST_TIMEOUT', 'HOST_REPLACED', 'HOST_OFFLINE', 'RESULT_INVALID', 'RESULT_TOO_LARGE'].includes(result.code ?? '');
        this.#settle(result.requestId, unknownWrite ? failure(result.code!, true) : this.#result(result));
    }
    #result(result: CommandResultMessage): GatewayResult { return { status: result.status, code: result.code, message: result.message, ...result.data === undefined ? {} : { data: result.data } }; }
    dispose(): void { if (this.#disposed)
        return; this.#disposed = true; for (const stop of this.#unsubscribers)
        stop(); for (const [id, p] of [...this.#pending])
        this.#settle(id, failure('DISPOSED', p.sent && !reads.has(p.request.payload.name))); this.#latest.clear(); }
}
