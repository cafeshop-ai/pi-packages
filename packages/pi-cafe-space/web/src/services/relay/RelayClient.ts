import { decodeWireMessage, MAX_FRAME_BYTES, type ClientCommandMessage, type WireMessage } from '../../../../src/protocol/index';
export interface SocketLike {
    readonly readyState: number;
    readonly bufferedAmount: number;
    onopen: (() => void) | null;
    onclose: (() => void) | null;
    onerror: (() => void) | null;
    onmessage: ((event: {
        data: unknown;
    }) => void) | null;
    send(value: string): void;
    close(): void;
}
export type ConnectionStatus = 'stopped' | 'connecting' | 'authenticating' | 'authenticated' | 'reconnecting' | 'auth-failed';
export interface ConnectionState {
    readonly status: ConnectionStatus;
    readonly generation: number;
    readonly roomId: string | null;
}
export type RelayEvent = {
    kind: 'state';
    state: ConnectionState;
    generation: number;
} | {
    kind: 'message';
    message: WireMessage;
    generation: number;
} | {
    kind: 'notice';
    code: 'CONNECTION_LOST' | 'INVALID_FRAME';
    generation: number;
};
export interface Credentials {
    token: string;
    roomId: string;
    peerId: string;
}
export interface RelayOptions {
    origin?: string;
    socketFactory?: (url: string) => SocketLike;
    now?: () => number;
    connectTimeoutMs?: () => number;
}
export function browserSocket(url: string): SocketLike {
    const ws = new WebSocket(url);
    const port: SocketLike = { get readyState() { return ws.readyState; }, get bufferedAmount() { return ws.bufferedAmount; }, onopen: null, onclose: null, onerror: null, onmessage: null, send: value => ws.send(value), close: () => { ws.onopen = null; ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.close(); } };
    ws.onopen = () => port.onopen?.();
    ws.onclose = () => port.onclose?.();
    ws.onerror = () => port.onerror?.();
    ws.onmessage = event => port.onmessage?.({ data: event.data });
    return port;
}
const encoder = new TextEncoder();
export class RelayClient {
    readonly #url: string;
    readonly #factory: (url: string) => SocketLike;
    readonly #now: () => number;
    readonly #connectTimeoutMs: () => number;
    #socket: SocketLike | null = null;
    #credentials: Credentials | null = null;
    #state: ConnectionState = { status: 'stopped', generation: 0, roomId: null };
    #listeners = new Set<(event: RelayEvent) => void>();
    #timer: ReturnType<typeof setTimeout> | undefined;
    #helloTimer: ReturnType<typeof setTimeout> | undefined;
    #retry = 500;
    #lastNotice = -Infinity;
    constructor(options: RelayOptions = {}) {
        const url = new URL(options.origin ?? window.location.origin);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
            throw new Error('Relay requires an HTTP origin');
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.pathname = '/ws';
        this.#url = url.href;
        this.#factory = options.socketFactory ?? browserSocket;
        this.#now = options.now ?? Date.now;
        this.#connectTimeoutMs = options.connectTimeoutMs ?? (() => 5000);
    }
    getState = (): ConnectionState => this.#state;
    subscribe = (listener: (event: RelayEvent) => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
    #emit(event: RelayEvent): void { for (const listener of [...this.#listeners])
        listener(event); }
    #set(status: ConnectionStatus, generation = this.#state.generation): void { this.#state = { status, generation, roomId: this.#credentials?.roomId ?? null }; this.#emit({ kind: 'state', state: this.#state, generation }); }
    start(credentials: Credentials): void {
        decodeWireMessage(JSON.stringify({ type: 'hello', protocolVersion: 1, peerRole: 'client', token: credentials.token, roomId: credentials.roomId, peerId: credentials.peerId }));
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(credentials.roomId))
            throw new Error('Invalid room');
        const old = this.#credentials;
        if (old && old.token === credentials.token && old.roomId === credentials.roomId && old.peerId === credentials.peerId && this.#state.status !== 'auth-failed')
            return;
        this.#dispose();
        this.#credentials = { ...credentials };
        this.#retry = 500;
        this.#connect();
    }
    stop(): void {
        if (this.#state.status === 'stopped')
            return;
        this.#dispose();
        this.#credentials = null;
        this.#set('stopped', this.#state.generation + 1);
    }
    resync(): void { if (!this.#credentials || this.#state.status === 'auth-failed')
        return; this.#dispose(); this.#connect(); }
    #dispose(): void {
        clearTimeout(this.#timer);
        clearTimeout(this.#helloTimer);
        this.#timer = undefined;
        this.#helloTimer = undefined;
        const socket = this.#socket;
        this.#socket = null;
        if (socket) {
            socket.onopen = null;
            socket.onmessage = null;
            socket.onclose = null;
            socket.onerror = null;
            try {
                socket.close();
            }
            catch { /* already closed */ }
        }
    }
    #notice(code: 'CONNECTION_LOST' | 'INVALID_FRAME'): void { if (this.#now() - this.#lastNotice < 5000)
        return; this.#lastNotice = this.#now(); this.#emit({ kind: 'notice', code, generation: this.#state.generation }); }
    #fail(code: 'CONNECTION_LOST' | 'INVALID_FRAME'): void {
        if (!this.#credentials || this.#state.status === 'auth-failed' || this.#state.status === 'stopped')
            return;
        this.#dispose();
        const generation = this.#state.generation + 1;
        this.#set('reconnecting', generation);
        const active = () => this.#state.generation === generation && this.#state.status === 'reconnecting';
        if (!active())
            return;
        this.#notice(code);
        if (!active())
            return;
        const delay = this.#retry;
        this.#retry = Math.min(this.#retry * 2, 30000);
        this.#timer = setTimeout(() => { if (!active())
            return; this.#timer = undefined; this.#connect(); }, delay);
    }
    #connect(): void {
        if (!this.#credentials)
            return;
        const generation = this.#state.generation + 1;
        this.#set('connecting', generation);
        if (this.#state.generation !== generation || !this.#credentials)
            return;
        let socket: SocketLike;
        try {
            socket = this.#factory(this.#url);
        }
        catch {
            this.#fail('CONNECTION_LOST');
            return;
        }
        this.#socket = socket;
        const current = () => this.#socket === socket && this.#state.generation === generation;
        const requestedTimeout = this.#connectTimeoutMs();
        const connectTimeout = Number.isFinite(requestedTimeout) ? Math.max(1, Math.min(30000, requestedTimeout)) : 5000;
        this.#helloTimer = setTimeout(() => { if (current())
            this.#fail('CONNECTION_LOST'); }, connectTimeout);
        socket.onopen = () => {
            if (!current() || !this.#credentials)
                return;
            try {
                clearTimeout(this.#helloTimer);
                this.#helloTimer = setTimeout(() => { if (current()) this.#fail('CONNECTION_LOST'); }, 5000);
                this.#set('authenticating');
                const credentials = this.#credentials;
                if (current() && credentials)
                    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 1, peerRole: 'client', token: credentials.token, roomId: credentials.roomId, peerId: credentials.peerId }));
            }
            catch {
                this.#fail('CONNECTION_LOST');
            }
        };
        socket.onerror = () => { if (current())
            this.#fail('CONNECTION_LOST'); };
        socket.onclose = () => { if (current())
            this.#fail('CONNECTION_LOST'); };
        socket.onmessage = ({ data }) => {
            if (!current())
                return;
            let message: WireMessage;
            try {
                if (typeof data !== 'string' || data.length > MAX_FRAME_BYTES || encoder.encode(data).length > MAX_FRAME_BYTES)
                    throw new Error('Invalid frame');
                message = decodeWireMessage(data);
            }
            catch {
                this.#fail('INVALID_FRAME');
                return;
            }
            if (message.type === 'error' && (message.code === 'UNAUTHORIZED' || message.code === 'INVALID_ROOM')) {
                this.#dispose();
                this.#credentials = null;
                this.#set('auth-failed', generation + 1);
                return;
            }
            if (message.type === 'welcome') {
                if (this.#state.status !== 'authenticating' || message.peerRole !== 'client' || message.roomId !== this.#credentials?.roomId) {
                    this.#fail('INVALID_FRAME');
                    return;
                }
                clearTimeout(this.#helloTimer);
                this.#helloTimer = undefined;
                this.#retry = 500;
                this.#set('authenticated');
            }
            else if (!['host_status', 'snapshot', 'event', 'command_result', 'error'].includes(message.type) || this.#state.status !== 'authenticated') {
                this.#fail('INVALID_FRAME');
                return;
            }
            // Synchronous ingestion; transport never coalesces/drops protocol events.
            if (current())
                this.#emit({ kind: 'message', message, generation });
        };
    }
    sendCommand(message: ClientCommandMessage, generation: number): void {
        const socket = this.#socket;
        if (this.#state.status !== 'authenticated' || generation !== this.#state.generation || !socket || socket.readyState !== 1)
            throw new Error('Relay is not authenticated');
        const canonical = decodeWireMessage(JSON.stringify(message));
        if (canonical.type !== 'command')
            throw new Error('Only commands can be sent');
        const raw = JSON.stringify(canonical);
        const bytes = encoder.encode(raw).length;
        if (bytes > MAX_FRAME_BYTES || socket.bufferedAmount + bytes > 1024 * 1024)
            throw new Error('Relay send budget exceeded');
        // No local replay buffer. A throw after send begins does not prove that Pi
        // never received the command; Gateway reports unknown write outcomes.
        socket.send(raw);
    }
}
