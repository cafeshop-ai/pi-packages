import { requestAccountAttestation, type CafeAccount } from './cafeAccount';
import { visitorIdentity, visitorProof, validNickname, type VisitorIdentity } from './visitorIdentity';
import type { SocketLike } from '../relay/RelayClient';
import type { RemoteInfo, RemoteRoute } from './RemoteSocket';
import { ChunkDecoder, encodeChunks, MAX_BUSINESS_BYTES, PACKET_BYTES } from './framing';
import { gatherRoomICE, hasRoomCandidate } from './roomICE';
import { roomInitializationStep, type RoomInitDiagnostic } from './roomInitialization';
import { captureRoomTransport, roomPeerConfiguration, roomTransportFailure, type RoomConnectionPolicy, type RoomTransportDiagnostic, type RoomTransportEvent } from './roomTransport';
import { roomHash, roomNonce, roomPasswordValid, validRoomKey, verifyRoomAnswer } from './roomCrypto';

export type RoomStage = 'signaling' | 'gathering' | 'waiting-office' | 'identity' | 'transport' | 'password' | 'synchronizing' | 'connected';
export interface RoomProgress { stage: RoomStage; localRelay: boolean; remoteRelay: boolean; iceErrorCode: number | null; signalCloseCode: number | null; initialization?: RoomInitDiagnostic; transport?: RoomTransportDiagnostic; policy?: RoomConnectionPolicy }
export interface RoomSocketOptions {
  nickname?: string; account?: CafeAccount; onVisitor?: (name: string, persistent: boolean, kind?: 'account' | 'guest') => void;
  roomKey: string; password: string; origin?: string; connectionPolicy?: RoomConnectionPolicy;
  socketFactory?: (url: string) => WebSocket;
  peerFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  onInfo?: (info: RemoteInfo) => void; onRoute?: (route: RemoteRoute) => void;
  onAuxiliary?: (value: Record<string, unknown>) => void; onEnd?: (code: string) => void;
  onProgress?: (progress: RoomProgress) => void;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function ice(value: unknown): RTCIceServer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw Error('INVALID_ICE_CONFIGURATION');
  return value.map(server => {
    if (!object(server) || !Array.isArray(server.urls) || !server.urls.length || server.urls.length > 4 || !server.urls.every(url => typeof url === 'string' && url.length <= 2048 && /^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw Error('INVALID_ICE_CONFIGURATION');
    if (server.username !== undefined && (typeof server.username !== 'string' || server.username.length > 256) || server.credential !== undefined && (typeof server.credential !== 'string' || server.credential.length > 4096)) throw Error('INVALID_ICE_CONFIGURATION');
    return { urls: server.urls as string[], ...(typeof server.username === 'string' ? { username: server.username } : {}), ...(typeof server.credential === 'string' ? { credential: server.credential } : {}) };
  });
}
/** Only signaling reaches the public server. Password and business frames use
 * a reliable ordered DataChannel whose DTLS fingerprint was signed by the
 * public room identity embedded in the invitation URL. */
export class RoomSocket implements SocketLike {
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly #options: Omit<RoomSocketOptions, 'password'>;
  readonly #nonce: string; readonly #ws: WebSocket; readonly #cancel = new AbortController();
  readonly #assembly = new ChunkDecoder();
  #progress: RoomProgress = { stage: 'signaling', localRelay: false, remoteRelay: false, iceErrorCode: null, signalCloseCode: null };
  #report(change: Partial<RoomProgress>): void { this.#progress = { ...this.#progress, ...change }; this.#options.onProgress?.(this.#progress); }
  readonly #startedAt = Date.now();
  #channelOpened = false;
  #transportTargets = new Set<EventTarget>(); #transportCleanup: (() => void)[] = [];
  #capture(event: RoomTransportEvent, error?: unknown): RoomTransportDiagnostic {
    const transport = captureRoomTransport(this.#pc, this.#dc, event, this.#channelOpened, Date.now() - this.#startedAt, error);
    this.#report({ transport, policy: this.#options.connectionPolicy ?? 'auto' }); return transport;
  }
  #transportFailed(event: RoomTransportEvent, error?: unknown): void {
    if (this.#closed) return;
    const diagnostic = this.#capture(event, error);
    this.#fail(this.#verified ? 'ROOM_CONNECTION_LOST' : roomTransportFailure(diagnostic));
  }
  #observeTransports(): void {
    const sctp = this.#pc?.sctp, dtls = sctp?.transport;
    for (const [target, event] of [[sctp, 'sctp-state'], [dtls, 'dtls-state']] as const) {
      if (!target || typeof target.addEventListener !== 'function' || this.#transportTargets.has(target)) continue;
      this.#transportTargets.add(target);
      const changed = () => { if (!this.#closed) { this.#capture(event); if (event === 'dtls-state' && target.state === 'failed') this.#transportFailed('dtls-state'); } };
      target.addEventListener('statechange', changed); this.#transportCleanup.push(() => target.removeEventListener('statechange', changed));
      if (event === 'dtls-state') {
        const failed = (error: Event) => this.#transportFailed('dtls-error', (error as RTCErrorEvent).error);
        target.addEventListener('error', failed); this.#transportCleanup.push(() => target.removeEventListener('error', failed));
      }
    }
  }
  #profile: Promise<VisitorIdentity> | null = null; #proof: Awaited<ReturnType<typeof visitorProof>> | null = null; #persistent = false;
  #accountProof: Awaited<ReturnType<typeof requestAccountAttestation>> | null = null;
  #accountPending: Promise<void> | null = null; #accountTimer: ReturnType<typeof setTimeout> | undefined;
  #effectiveNickname = ''; #accountRenewing = false; #accountUpdated = 0;
  #password: string; #id = ''; #offerHash = ''; #answerReceived = false;
  #pc: RTCPeerConnection | null = null; #dc: RTCDataChannel | null = null;
  #requested = false; #selected = false; #verified = false; #closed = false;
  #queue: Uint8Array[] = []; #queuedBytes = 0; #inflight = 0; #pumping = false; #sequence = 0;
  #timer: ReturnType<typeof setTimeout>; #assemblyTimer: ReturnType<typeof setTimeout> | undefined;
  get readyState(): number { return this.#closed ? 3 : this.#verified ? 1 : 0; }
  get bufferedAmount(): number { return this.#queuedBytes + this.#inflight + (this.#dc?.bufferedAmount ?? 0); }
  constructor(options: RoomSocketOptions) {
    if (!globalThis.crypto?.subtle || typeof globalThis.crypto.getRandomValues !== 'function' || !options.peerFactory && typeof RTCPeerConnection !== 'function' || !options.socketFactory && typeof WebSocket !== 'function') throw Error('ROOM_BROWSER_UNSUPPORTED');
    this.#nonce = roomInitializationStep('random', roomNonce);
    roomInitializationStep('credentials', () => { if (!validRoomKey(options.roomKey) || !roomPasswordValid(options.password)) throw Error('INVALID_ROOM_CREDENTIALS'); });
    const origin = roomInitializationStep('origin', () => {
      const value = new URL(options.origin ?? window.location.origin);
      if (!['http:', 'https:'].includes(value.protocol) || value.username || value.password || value.pathname !== '/' || value.search || value.hash) throw Error('INVALID_ROOM_ORIGIN');
      value.protocol = value.protocol === 'https:' ? 'wss:' : 'ws:'; value.pathname = '/room/join';
      return value;
    });
    const { password, ...safe } = options; this.#options = safe; this.#password = password;
    const nickname = options.account?.nickname ?? options.nickname;
    if(nickname !== undefined) { if(!validNickname(nickname))throw Error('INVALID_VISITOR_PROFILE'); this.#effectiveNickname=nickname;this.#profile=visitorIdentity(options.roomKey); void this.#profile.catch(()=>{}); }
    this.#ws = roomInitializationStep('websocket', () => (options.socketFactory ?? (url => new WebSocket(url)))(origin.href));
    this.#timer = setTimeout(() => { this.#capture('timeout'); this.#fail('ROOM_CONNECTION_TIMEOUT'); }, 28000);
    this.#ws.onopen = () => { this.#report({ stage: 'signaling' }); try { this.#signal({ type: 'room_connect', roomKey: options.roomKey, nonce: this.#nonce }); } catch { this.#fail('ROOM_SIGNAL_UNAVAILABLE'); } };
    this.#ws.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || encoder.encode(event.data).length > 131072) throw Error('INVALID_ROOM_SIGNAL');
        const frame: unknown = JSON.parse(event.data); if (!object(frame)) throw Error('INVALID_ROOM_SIGNAL');
        this.#outer(frame);
      } catch { this.#fail('ROOM_IDENTITY_FAILED'); }
    };
    this.#ws.onerror = () => this.#fail('ROOM_SIGNAL_UNAVAILABLE');
    this.#ws.onclose = event => { this.#report({ signalCloseCode: event.code }); this.#fail(event.code === 4004 ? 'ROOM_OFFLINE' : event.code === 4008 ? 'ROOM_BUSY' : 'ROOM_SIGNAL_DISCONNECTED'); };
  }
  #signal(value: Record<string, unknown>): void {
    if (this.#closed || this.#ws.readyState !== 1 || this.#ws.bufferedAmount > 128 * 1024) throw Error('ROOM_SIGNAL_UNAVAILABLE');
    const raw = JSON.stringify(value); if (encoder.encode(raw).length > 131072) throw Error('INVALID_ROOM_SIGNAL'); this.#ws.send(raw);
  }
  #outer(frame: Record<string, unknown>): void {
    if (this.#closed) return;
    if (frame.type === 'room_opened') {
      if (this.#id || !identifier(frame.id) || frame.roomKey !== this.#options.roomKey || frame.nonce !== this.#nonce || frame.webRTC !== true) throw Error('ROOM_IDENTITY_FAILED');
      this.#id = frame.id;
      if(this.#options.account){this.#accountPending=this.#prepareAccount();void this.#accountPending.catch(()=>{});}
      this.#report({ stage: 'gathering' });
      void this.#start(ice(frame.iceServers)).catch(error => this.#fail(error instanceof Error && ['ROOM_ICE_NO_CANDIDATE','ROOM_TCP_RELAY_UNAVAILABLE'].includes(error.message) ? error.message : 'ROOM_WEBRTC_UNAVAILABLE')); return;
    }
    if (frame.id !== this.#id || !this.#id) throw Error('ROOM_IDENTITY_FAILED');
    if (frame.type === 'answer') {
      if (this.#answerReceived || !this.#pc || !this.#offerHash || typeof frame.sdp !== 'string' || !frame.sdp || frame.sdp.length > 65536 || frame.peerId !== this.#offerHash || typeof frame.signature !== 'string') throw Error('ROOM_IDENTITY_FAILED');
      this.#answerReceived = true;
      this.#report({ stage: 'identity', remoteRelay: hasRoomCandidate(frame.sdp, true) });
      void this.#answer(frame.sdp, frame.signature).catch(() => this.#fail('ROOM_IDENTITY_FAILED')); return;
    }
    if (frame.type === 'selected') {
      if (!this.#requested || this.#selected || frame.mode !== 'webrtc' || this.#dc?.readyState !== 'open') throw Error('INVALID_ROOM_TRANSPORT');
      this.#selected = true;
      this.#report({ stage: 'password' });
      void this.#authenticate().catch(() => this.#fail(this.#options.account ? 'ROOM_ACCOUNT_LOGIN_REQUIRED' : 'ROOM_VISITOR_IDENTITY_FAILED')); return;
    }
    if (frame.type === 'signal_error') { this.#fail('ROOM_WEBRTC_UNAVAILABLE'); return; }
    throw Error('INVALID_ROOM_SIGNAL');
  }
  async #prepareAccount(): Promise<void> {
    const profile=await this.#profile!,account=this.#options.account!;
    const proof=await requestAccountAttestation(account,this.#options.roomKey,this.#id,this.#nonce,profile.publicKey,this.#cancel.signal);
    if(this.#closed)return;this.#accountProof=proof;this.#effectiveNickname=proof.identity.nickname;this.#accountUpdated=Date.now();
  }
  async #renewAccount(): Promise<void> {
    if(this.#closed||!this.#verified||!this.#options.account||this.#accountRenewing)return;
    this.#accountRenewing=true;
    try{await this.#prepareAccount();if(this.#closed||!this.#accountProof)return;this.#enqueue(JSON.stringify({type:'room.account.renew',assertion:this.#accountProof.assertion}));this.#accountTimer=setTimeout(()=>void this.#renewAccount(),20000);}
    catch(error){if(this.#closed)return;const code=error instanceof Error?error.message:'';if(['ACCOUNT_LOGIN_REQUIRED','ACCOUNT_IDENTITY_CHANGED'].includes(code)||!this.#accountProof||this.#accountProof.expiresAt<=Date.now()+5000){this.#fail('ROOM_ACCOUNT_LOGIN_REQUIRED');}else this.#accountTimer=setTimeout(()=>void this.#renewAccount(),3000);}
    finally{this.#accountRenewing=false;}
  }
  async #authenticate(): Promise<void> {
    if(this.#accountPending)await this.#accountPending;
    if(this.#profile){const profile=await this.#profile;this.#proof=await visitorProof(profile,this.#options.roomKey,this.#id,this.#nonce,this.#effectiveNickname);this.#persistent=profile.persistent;}
    if(this.#closed)return;
    this.#enqueue(JSON.stringify({type:'room.auth',id:this.#id,nonce:this.#nonce,password:this.#password,...this.#proof?{nickname:this.#effectiveNickname,visitor:{publicKey:this.#proof.publicKey,signature:this.#proof.signature}}:{},...this.#accountProof?{account:this.#accountProof.assertion}:{}}));
    this.#password='';
  }
  async #answer(sdp: string, signature: string): Promise<void> {
    if (!await verifyRoomAnswer(this.#options.roomKey, signature, this.#id, this.#nonce, this.#offerHash, sdp)) throw Error('ROOM_IDENTITY_FAILED');
    if (this.#closed) return;
    this.#report({ stage: 'transport' });
    try { await this.#pc!.setRemoteDescription({ type: 'answer', sdp }); if (!this.#closed) this.#observeTransports(); }
    catch { this.#fail('ROOM_WEBRTC_NEGOTIATION_FAILED'); }
  }
  async #start(servers: RTCIceServer[]): Promise<void> {
    const pc = (this.#options.peerFactory ?? (config => new RTCPeerConnection(config)))(roomPeerConfiguration(servers, this.#options.connectionPolicy ?? 'auto')); this.#pc = pc;
    const dc = pc.createDataChannel('pi-cafe-v1', { ordered: true, protocol: 'pi-cafe-v1' }); this.#dc = dc;
    dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 65536;
    dc.onopen = () => {
      if (this.#closed || this.#requested) return;
      this.#channelOpened = true; this.#capture('data-open');
      if (pc.sctp && pc.sctp.maxMessageSize > 0 && pc.sctp.maxMessageSize < PACKET_BYTES) { this.#fail('ROOM_WEBRTC_UNAVAILABLE'); return; }
      this.#requested = true;
      try { this.#signal({ type: 'select', id: this.#id, mode: 'webrtc' }); } catch { this.#fail('ROOM_SIGNAL_UNAVAILABLE'); }
    };
    dc.onclose = () => this.#transportFailed('data-close');
    dc.onerror = event => this.#transportFailed('data-error', (event as RTCErrorEvent).error);
    dc.onmessage = event => {
      try {
        if (!this.#selected || !(event.data instanceof ArrayBuffer)) throw Error('INVALID_ROOM_DATA');
        const complete = this.#assembly.push(event.data);
        if (complete) { clearTimeout(this.#assemblyTimer); this.#assemblyTimer = undefined; this.#data(complete); }
        else if (!this.#assemblyTimer) this.#assemblyTimer = setTimeout(() => this.#fail('ROOM_MESSAGE_TIMEOUT'), 10001);
      } catch { this.#fail('INVALID_ROOM_DATA'); }
    };
    pc.onicecandidateerror = event => { if (!this.#closed) this.#report({ iceErrorCode: event.errorCode }); };
    pc.oniceconnectionstatechange = () => { if (!this.#closed) this.#capture('ice-state'); };
    pc.onconnectionstatechange = () => { if (!this.#closed) { this.#capture('peer-state'); if (['failed', 'closed'].includes(pc.connectionState)) this.#transportFailed('peer-state'); } };
    await pc.setLocalDescription(await pc.createOffer());
    if (!this.#closed) this.#observeTransports();
    await gatherRoomICE(pc, this.#cancel.signal);
    if (this.#closed) return;
    const sdp = pc.localDescription?.sdp; if (!sdp || encoder.encode(sdp).length > 65536) throw Error('INVALID_SDP');
    this.#report({ stage: 'waiting-office', localRelay: hasRoomCandidate(sdp, true) });
    this.#offerHash = await roomHash(sdp);
    this.#signal({ type: 'offer', id: this.#id, sdp });
  }
  #data(bytes: Uint8Array): void {
    if (this.#closed) return;
    const raw = decoder.decode(bytes), value: unknown = JSON.parse(raw);
    if (!object(value) || typeof value.type !== 'string') throw Error('INVALID_ROOM_DATA');
    if (!this.#verified) {
      if (value.type === 'room.denied') {
        const allowed = ['ROOM_PASSWORD_REJECTED','ROOM_ACCOUNT_IDENTITY_FAILED','ROOM_AUTH_BUSY','ROOM_AUTH_RATE_LIMITED','ROOM_ACCESS_CHANGED'];
        this.#fail(value.code === undefined ? 'ROOM_PASSWORD_REJECTED' : typeof value.code === 'string' && allowed.includes(value.code) ? value.code : 'ROOM_PROTOCOL_ERROR'); return;
      }
      if (value.type !== 'room.authenticated' || value.id !== this.#id || value.roomKey !== this.#options.roomKey || value.deviceId !== 'room' || value.roomId !== 'main' || value.userId !== (this.#accountProof?.userId ?? this.#proof?.userId ?? 'guest-' + this.#id) || value.role !== 'operator' || typeof value.name !== 'string' || !value.name || value.name.length > 128 || typeof value.managed !== 'boolean') throw Error('INVALID_ROOM_IDENTITY');
      if(this.#proof && value.visitorName !== (this.#accountProof?.identity.displayName??this.#proof.displayName)) throw Error('INVALID_ROOM_IDENTITY');
      if(this.#options.account&&(!this.#accountProof||value.identityKind!=='account'||value.accountId!==this.#accountProof.identity.accountId))throw Error('INVALID_ROOM_IDENTITY');
      if(!this.#options.account&&value.identityKind==='account')throw Error('INVALID_ROOM_IDENTITY');
      this.#verified = true; clearTimeout(this.#timer); this.#report({ stage: 'synchronizing' });
      this.#options.onInfo?.({ id: this.#id, deviceId: 'room', roomId: 'main', userId: this.#accountProof?.userId ?? this.#proof?.userId ?? 'guest-' + this.#id, name: value.name, role: 'operator', managed: value.managed });
      if(this.#proof)this.#options.onVisitor?.(this.#accountProof?.identity.displayName??this.#proof.displayName,this.#persistent,this.#accountProof?'account':'guest');
      if(this.#accountProof)this.#accountTimer=setTimeout(()=>void this.#renewAccount(),20000);
      this.#options.onRoute?.('webrtc'); this.onopen?.(); void this.#route(); return;
    }
    if (value.type === 'remote.presence' || value.type === 'remote.result') this.#options.onAuxiliary?.(value);
    else this.onmessage?.({ data: raw });
  }
  send(raw: string): void {
    if (this.readyState !== 1) throw Error('ROOM_NOT_AUTHENTICATED');
    const value: unknown = JSON.parse(raw);
    if (object(value) && value.type === 'hello') raw = JSON.stringify({ ...value, token: 'remote-session' });
    this.#enqueue(raw);
  }
  #enqueue(raw: string): void {
    const bytes = encoder.encode(raw);
    if (!bytes.length || bytes.length > MAX_BUSINESS_BYTES || this.#queue.length >= 128 || this.bufferedAmount + bytes.length > 1024 * 1024) throw Error('ROOM_SEND_LIMIT');
    this.#queue.push(bytes); this.#queuedBytes += bytes.length; void this.#pump();
  }
  async #pump(): Promise<void> {
    if (this.#pumping) return; this.#pumping = true;
    try {
      while (!this.#closed && this.#queue.length) {
        const bytes = this.#queue.shift()!; this.#queuedBytes -= bytes.length; this.#inflight = bytes.length;
        const dc = this.#dc; if (!dc || dc.readyState !== 'open') throw Error('NOT_CONNECTED');
        this.#sequence = (this.#sequence + 1) >>> 0 || 1;
        for (const packet of encodeChunks(this.#sequence, bytes)) {
          if (dc.bufferedAmount > 256 * 1024) await new Promise<void>((resolve, reject) => {
            const finish = (error?: Error) => { clearTimeout(timer); dc.removeEventListener('bufferedamountlow', low); this.#cancel.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
            const low = () => { if (dc.bufferedAmount <= 256 * 1024) finish(); };
            const abort = () => finish(Error('CANCELLED'));
            const timer = setTimeout(() => finish(Error('SEND_TIMEOUT')), 5000);
            dc.addEventListener('bufferedamountlow', low); this.#cancel.signal.addEventListener('abort', abort, { once: true });
            if (this.#cancel.signal.aborted) abort(); else low();
          });
          if (this.#closed) return; dc.send(packet);
        }
        this.#inflight = 0;
      }
    } catch (error) { this.#transportFailed('send-error', error); }
    finally { this.#inflight = 0; this.#pumping = false; }
  }
  async #route(): Promise<void> {
    try {
      const stats = await this.#pc?.getStats(); if (!stats || this.#closed) return;
      let pair: RTCStats | undefined;
      stats.forEach(item => { if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId); });
      if (!pair) stats.forEach(item => { if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') pair = item; });
      if (!pair) return;
      const selected = pair as RTCStats & { localCandidateId: string; remoteCandidateId: string };
      const local = stats.get(selected.localCandidateId), remote = stats.get(selected.remoteCandidateId);
      this.#options.onRoute?.(local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'webrtc-turn' : 'webrtc-direct');
    } catch { /* The generic WebRTC label remains accurate. */ }
  }
  #dispose(): void {
    this.#closed = true; this.#password = ''; clearTimeout(this.#accountTimer);this.#accountProof=null;this.#cancel.abort(); clearTimeout(this.#timer); clearTimeout(this.#assemblyTimer);
    this.#queue.length = 0; this.#queuedBytes = 0; this.#inflight = 0;
    this.#ws.onopen = null; this.#ws.onmessage = null; this.#ws.onerror = null; this.#ws.onclose = null;
    if (this.#dc) { this.#dc.onopen = null; this.#dc.onmessage = null; this.#dc.onclose = null; this.#dc.onerror = null; }
    for (const cleanup of this.#transportCleanup.splice(0)) cleanup(); this.#transportTargets.clear();
    if (this.#pc) { this.#pc.onconnectionstatechange = null; this.#pc.oniceconnectionstatechange = null; this.#pc.onicecandidateerror = null; }
    try { this.#dc?.close(); this.#pc?.close(); this.#ws.close(); } catch { /* Already closed. */ }
  }
  #fail(code: string): void {
    if (this.#closed) return;
    if (code === 'ROOM_IDENTITY_FAILED' && this.#selected) code = 'ROOM_PROTOCOL_ERROR';
    this.#dispose(); this.#options.onEnd?.(code);
    if (code === 'ROOM_PASSWORD_REJECTED') this.onmessage?.({ data: JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Room password was rejected' }) });
    else this.onclose?.();
  }
  close(): void { if (this.#closed) return; this.#dispose(); this.#options.onEnd?.('CLOSED'); }
}
