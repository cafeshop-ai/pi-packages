import { RelayClient, browserSocket } from '../services/relay/RelayClient';
import { CommandGateway, type ExecuteOptions, type GatewayResult } from '../services/relay/CommandGateway';
import { isCommandPayload, type CommandPayload } from '../../../src/protocol/index';
import { createRelayStorage, type RelayStorage } from '../services/relay/storage';
import { createHttpClient, type RelayConfig } from '../services/http/client';
import { CollabStore, type HostScope } from '../state/CollabStore';
import { RemoteAccess } from '../services/remote/RemoteAccess';
import { CafeAccountController } from '../services/remote/cafeAccount';
import type { RoomProgress } from '../services/remote/RoomSocket';
import type { RemoteMode } from '../services/remote/RemoteSocket';
import { managedRequest, type ManagedRequest } from '../services/http/workspace';
const readCommands = new Set(['list_dir', 'read_file', 'list_sessions', 'get_session', 'list_commands']);
interface OwnerOptions {
  client?: RelayClient;
  remote?: RemoteAccess;
  storage?: RelayStorage;
  http?: { config: (signal?: AbortSignal) => Promise<RelayConfig> };
}
export class AppOwner {
  publicRoomMode = false;
  roomShare = false;
  roomControl = false;
  roomFailure: string | null = null;
  roomLastProgress: RoomProgress | null = null;
  #roomHasConnected = false;
  readonly client: RelayClient;
  readonly storage: RelayStorage;
  readonly store: CollabStore;
  readonly gateway: CommandGateway;
  readonly remote: RemoteAccess;
  readonly account = new CafeAccountController();
  readonly #accountUnsubscribe: () => void;
  #initialized = false;
  readonly #resume = () => {
    if (this.#disposed || !this.remote.enabled || document.visibilityState === 'hidden') return;
    if (['authenticated', 'reconnecting'].includes(this.client.getState().status)) this.client.resync();
  };
  readonly #http: NonNullable<OwnerOptions['http']>;
  readonly #cancel = new AbortController();
  readonly #unsubscribe: () => void;
  #desiredHost: string | null;
  #disposed = false;
  constructor(options: OwnerOptions = {}) {
    this.remote = options.remote ?? new RemoteAccess();
    this.client = options.client ?? new RelayClient({
      socketFactory: url => this.remote.enabled ? this.remote.createSocket() : browserSocket(url),
      connectTimeoutMs: () => this.remote.enabled ? 30000 : 5000,
    });
    this.#accountUnsubscribe = this.account.subscribe(() => {
      const session=this.remote.accountSession,state=this.account.getSnapshot();
      if(session&&(state.mode!=='account'||state.status==='ready'&&state.account?.sessionId!==session)) {
        this.disconnectRemote();this.roomFailure='ROOM_ACCOUNT_LOGIN_REQUIRED';this.store?.notice('ACCOUNT_SESSION_ENDED');
      }
    });
    this.storage = options.storage ?? createRelayStorage();
    this.#http = options.http ?? createHttpClient();
    this.#desiredHost = this.storage.get('host');
    this.store = new CollabStore(() => this.client.resync());
    // Store ingestion precedes Gateway callbacks; a result sees the newest
    // authoritative context, even before React's coalesced notification.
    this.#unsubscribe = this.client.subscribe(event => {
      if (event.kind === 'notice' && this.publicRoomMode && !this.#roomHasConnected) {
        this.roomFailure = this.remote.getSnapshot().error ?? (event.code === 'INVALID_FRAME' ? 'ROOM_PROTOCOL_ERROR' : 'ROOM_CONNECTION_INTERRUPTED');
        this.roomLastProgress = this.remote.getSnapshot().roomProgress ?? null;
        this.client.stop(); this.remote.logout(); return;
      }
      this.store.ingest(event);
      if (event.kind === 'state') { this.remote.authenticated(event.state.status === 'authenticated'); if (this.publicRoomMode && event.state.status === 'authenticated') this.#roomHasConnected = true; }
      if (event.kind === 'state' && event.state.status === 'auth-failed') {
        if (this.publicRoomMode) { this.roomFailure = this.remote.getSnapshot().error ?? 'ROOM_CONNECTION_FAILED'; this.roomLastProgress = this.remote.getSnapshot().roomProgress ?? null; }
        this.remote.logout();
        this.storage.logout(); this.#desiredHost = null; this.store.notice('AUTH_FAILED');
      }
      if (event.kind === 'message' && event.message.type === 'host_status') {
        const hosts = this.store.getSnapshot().hosts;
        if (this.#desiredHost && hosts.has(this.#desiredHost)) this.store.selectHost(this.#desiredHost);
        else if (hosts.size === 1) this.selectHost(hosts.keys().next().value!);
        else this.store.selectHost(null);
      }
    });
    this.gateway = new CommandGateway(this.client, this.store, (payload, scope) => {
      if (!this.remote.enabled || readCommands.has(payload.name) || this.remote.canWrite(scope.hostId)) return null;
      return this.remote.getSnapshot().info?.role === 'viewer' ? 'READ_ONLY' : this.remote.getSnapshot().controlPolicy === 'approval' ? 'CONTROL_APPROVAL_REQUIRED' : 'CONTROL_REQUIRED';
    });
    if (typeof window !== 'undefined') window.addEventListener('online', this.#resume);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.#resume);
  }
  async initialize(roomId?: string | null): Promise<RelayConfig | null> {
    // Determine the server's mode before sending any credential or attempting
    // the old /ws route. A missing config must not downgrade a cloud connection.
    let config: RelayConfig;
    try { config = await this.#http.config(this.#cancel.signal); }
    catch { if (!this.#disposed) this.store.notice('CONFIG_UNAVAILABLE'); return null; }
    if (this.#disposed) return null;
    this.remote.enable(config.remoteAccess === true);
    this.publicRoomMode = config.roomAccess === true;
    this.account.enable(this.publicRoomMode && config.accountLogin === true);
    this.roomShare = config.roomShare === true;
    this.roomControl = config.roomControl === true && config.roomAccess !== true && config.remoteAccess !== true;
    if (config.setupRequired) { this.#initialized = false; this.client.stop(); return config; }
    this.#initialized = true;
    if (this.publicRoomMode) { this.#desiredHost = null; return config; }
    if (roomId === null) return config;
    if (!this.remote.enabled) { this.openRoom(roomId ?? this.storage.get('room') ?? config.defaultRoom); return config; }
    const token = this.storage.get('token');
    if (token && /^[A-Za-z0-9_-]{43,128}$/.test(token)) {
      try {
        const catalog = await this.remote.discover(token, this.#cancel.signal);
        if (this.#disposed) return null;
        const saved = this.remote.savedSelection();
        const room = roomId ?? saved?.roomId ?? this.storage.get('room') ?? config.defaultRoom;
        if (saved && catalog.devices.some(d => d.id === saved.deviceId && d.rooms.some(r => r.id === room))) this.connectRemote(token, saved.deviceId, room, saved.mode);
      } catch { if (!this.#disposed) { this.storage.logout(); this.store.notice('REMOTE_LOGIN_REQUIRED'); } }
    }
    return config;
  }
  async execute(payload: CommandPayload, scope: HostScope, options: ExecuteOptions = {}): Promise<GatewayResult> {
    if (!this.remote.enabled || readCommands.has(payload.name) || this.remote.canWrite(scope.hostId)) return this.gateway.execute(payload, scope, options);
    const fail = (code: string): GatewayResult => ({ status: 'rejected', code, message: null });
    if (!isCommandPayload(payload)) return fail('INVALID_COMMAND');
    if (this.#disposed || options.signal?.aborted) return fail('CANCELLED');
    const state = this.store.getSnapshot(), generation = this.client.getState().generation, view = state.viewGeneration;
    if (state.connection.status !== 'authenticated') return fail('NOT_CONNECTED');
    if (!this.store.isScope(scope) || state.selectedHostId !== scope.hostId || options.viewGeneration !== undefined && options.viewGeneration !== view) return fail('VIEW_CHANGED');
    const host = state.hosts.get(scope.hostId);
    if (!host || host.stale || !host.snapshot || !host.info.connected || host.info.ready === false) return fail('HOST_NOT_READY');
    try { await this.remote.ensureControl(scope.hostId); }
    catch (error) {
      const code = error instanceof Error ? error.message : 'CONTROL_UNCONFIRMED';
      return fail(['CONTROL_BUSY','CONTROL_APPROVAL_REQUIRED','READ_ONLY','NOT_CONNECTED','HOST_NOT_READY','CONTROL_LIMIT'].includes(code) ? code : 'CONTROL_UNCONFIRMED');
    }
    if (this.#disposed || options.signal?.aborted) return fail('CANCELLED');
    if (this.client.getState().generation !== generation || this.store.getSnapshot().viewGeneration !== view || !this.store.isScope(scope) || this.store.getSnapshot().selectedHostId !== scope.hostId) return fail('VIEW_CHANGED');
    // Gateway rechecks the authoritative lease, selected host and live session.
    // No business command was sent during acquisition; this is the single send.
    return this.gateway.execute(payload, scope, { ...options, viewGeneration: view });
  }
  openRoom(roomId: string): void {
    if (this.#disposed || !this.#initialized || this.publicRoomMode) return;
    if (this.remote.enabled && !this.remote.getSnapshot().deviceId) return;
    const token = this.storage.get('token');
    if (token) {
      try { this.login(token, roomId); }
      catch { this.client.stop(); this.store.notice('REMOTE_ROOM_UNAVAILABLE'); }
    }
  }
  login(token: string, roomId: string): void {
    if (this.#disposed) return;
    if (!this.#initialized) throw Error('CONFIG_UNAVAILABLE');
    if (this.remote.enabled) this.remote.prepareRoom(token, roomId);
    const roomChanged = this.storage.get('room') !== roomId;
    // Validate/start before touching storage. start fences pending operations
    // synchronously; no inventory arrives until after this call returns.
    this.client.start({ token, roomId, peerId: this.storage.peerId() });
    if (roomChanged) { this.#desiredHost = null; this.storage.remove('host'); }
    this.storage.set('token', token); this.storage.set('room', roomId);
  }
  selectHost(id: string): void {
    if (!this.store.getSnapshot().hosts.has(id)) return;
    this.#desiredHost = id; this.storage.set('host', id); this.store.selectHost(id);
  }
  connectRoomLink(roomKey: string, password: string, connectionPolicy: 'auto' | 'relay-tcp' = 'auto', nickname?: string): void {
    if (this.#disposed || !this.#initialized || !this.publicRoomMode) throw Error('CONFIG_UNAVAILABLE');
    this.client.stop(); this.remote.logout(); this.roomFailure = null; this.roomLastProgress = null; this.#roomHasConnected = false; this.#desiredHost = null;
    const identity=this.account.getSnapshot();
    if(identity.enabled&&(identity.mode==='choose'||identity.mode==='account'&&!identity.account))throw Error('ROOM_ACCOUNT_LOGIN_REQUIRED');
    const account=identity.enabled&&identity.mode==='account'?identity.account??undefined:undefined;
    this.remote.prepareRoomLink(roomKey, password, connectionPolicy, account?.nickname??nickname, account);
    this.client.start({ token: 'room-session', roomId: 'main', peerId: this.storage.peerId() });
  }
  connectRemote(token: string, deviceId: string, roomId: string, mode: RemoteMode): void {
    if (this.#disposed || !this.#initialized || !this.remote.enabled) throw Error('CONFIG_UNAVAILABLE');
    this.remote.prepare(token, deviceId, roomId, mode);
    this.client.stop();
    this.#desiredHost = null; this.storage.remove('host');
    this.login(token, roomId);
  }
  disconnectRemote(): void { this.client.stop(); this.#desiredHost = null; this.remote.logout(); }
  workspace(request: ManagedRequest, signal?: AbortSignal): Promise<unknown> {
    return this.remote.enabled ? this.remote.workspace(request, signal) : managedRequest(this.storage.get('token') ?? '', request, signal);
  }
  logout(): void { this.roomFailure = null; this.roomLastProgress = null; this.#roomHasConnected = false; this.storage.logout(); this.#desiredHost = null; this.client.stop(); this.remote.logout(); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;this.#accountUnsubscribe();this.account.dispose();this.#cancel.abort(); this.client.stop(); this.gateway.dispose(); this.#unsubscribe(); this.remote.dispose(); this.store.dispose();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.#resume);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.#resume);
  }
}
