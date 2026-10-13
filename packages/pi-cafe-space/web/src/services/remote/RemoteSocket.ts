import type { SocketLike } from '../relay/RelayClient';
import { ChunkDecoder, decodeBase64, encodeBase64, encodeChunks, MAX_BUSINESS_BYTES, MAX_OUTER_BYTES, PACKET_BYTES } from './framing';

export type RemoteMode = 'auto' | 'relay' | 'webrtc';
export type RemoteRole = 'viewer' | 'operator' | 'admin';
export type RemoteRoute = 'cloud-relay' | 'webrtc' | 'webrtc-direct' | 'webrtc-turn';
export interface RemoteInfo { id: string; deviceId: string; roomId: string; userId: string; name: string; role: RemoteRole; managed: boolean }
export interface RemoteSocketOptions {
  token: string; deviceId: string; roomId: string; mode: RemoteMode; origin?: string;
  socketFactory?: (url: string) => WebSocket;
  peerFactory?: (configuration: RTCConfiguration) => RTCPeerConnection;
  onInfo?: (info: RemoteInfo) => void;
  onRoute?: (route: RemoteRoute) => void;
  onAuxiliary?: (value: Record<string, unknown>) => void;
  onEnd?: (code: string) => void;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
export const isRole = (value: unknown): value is RemoteRole => ['viewer', 'operator', 'admin'].includes(String(value));
function iceServers(value: unknown): RTCIceServer[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw Error('INVALID_ICE_CONFIGURATION');
  return value.map(server => {
    if (!object(server) || !Array.isArray(server.urls) || !server.urls.length || server.urls.length > 4 || !server.urls.every(url => typeof url === 'string' && url.length <= 2048 && /^(stun|stuns|turn|turns):[^\s]+$/.test(url))) throw Error('INVALID_ICE_CONFIGURATION');
    if (server.username !== undefined && (typeof server.username !== 'string' || server.username.length > 256)) throw Error('INVALID_ICE_CONFIGURATION');
    if (server.credential !== undefined && (typeof server.credential !== 'string' || server.credential.length > 4096)) throw Error('INVALID_ICE_CONFIGURATION');
    return { urls: server.urls as string[], ...(typeof server.username === 'string' ? { username: server.username } : {}), ...(typeof server.credential === 'string' ? { credential: server.credential } : {}) };
  });
}
function gathered(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(Error('CANCELLED'));
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', changed); signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve(); };
    const changed = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const cancelled = () => finish(Error('CANCELLED'));
    const timer = setTimeout(() => finish(Error('ICE_GATHER_TIMEOUT')), 8000);
    pc.addEventListener('icegatheringstatechange', changed); signal.addEventListener('abort', cancelled, { once: true }); changed();
  });
}

/** A single immutable business route. Signalling remains connected while using
 * WebRTC so device authorization can expire/revoke independently of DTLS. */
export class RemoteSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly #ws: WebSocket;
  readonly #options: RemoteSocketOptions;
  readonly #cancel = new AbortController();
  readonly #assembly = new ChunkDecoder();
  #pc: RTCPeerConnection | null = null;
  #dc: RTCDataChannel | null = null;
  #id = ''; #closed = false;
  #requested: 'relay' | 'webrtc' | null = null;
  #selected: 'relay' | 'webrtc' | null = null;
  #rtcTimer: ReturnType<typeof setTimeout> | undefined;
  #assemblyTimer: ReturnType<typeof setTimeout> | undefined;
  #queue: Uint8Array[] = []; #queueBytes = 0; #inflight = 0; #pumping = false; #sequence = 0;
  get readyState(): number { return this.#closed ? 3 : this.#selected ? 1 : 0; }
  get bufferedAmount(): number { return this.#queueBytes + this.#inflight + (this.#selected === 'webrtc' ? this.#dc?.bufferedAmount ?? 0 : this.#ws.bufferedAmount); }
  constructor(options: RemoteSocketOptions) {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(options.token) || !identifier(options.deviceId) || !identifier(options.roomId) || !['auto','relay','webrtc'].includes(options.mode)) throw Error('INVALID_REMOTE_SELECTION');
    const origin = new URL(options.origin ?? window.location.origin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('INVALID_REMOTE_ORIGIN');
    origin.protocol = origin.protocol === 'https:' ? 'wss:' : 'ws:'; origin.pathname = '/remote/connect';
    this.#options = options; this.#ws = (options.socketFactory ?? (url => new WebSocket(url)))(origin.href);
    this.#ws.onopen = () => { try { this.#signal({ type:'connect', token:options.token, deviceId:options.deviceId, room:options.roomId, mode:options.mode }); } catch { this.#fail('SIGNAL_UNAVAILABLE'); } };
    this.#ws.onmessage = event => {
      if (this.#closed) return;
      try { if (typeof event.data !== 'string' || event.data.length > MAX_OUTER_BYTES || encoder.encode(event.data).length > MAX_OUTER_BYTES) throw Error('INVALID_FRAME'); const frame: unknown = JSON.parse(event.data); if (!object(frame)) throw Error('INVALID_FRAME'); this.#outer(frame); }
      catch { this.#fail('INVALID_FRAME'); }
    };
    this.#ws.onerror = () => this.#fail('SIGNAL_UNAVAILABLE');
    this.#ws.onclose = event => {
      if (event.code === 4003 && !this.#closed) this.onmessage?.({ data: JSON.stringify({type:'error',code:'UNAUTHORIZED',message:'Remote credentials rejected'}) });
      this.#fail(event.code === 4003 ? 'UNAUTHORIZED' : 'CONNECTION_LOST');
    };
  }
  #signal(value: Record<string, unknown>): void {
    if (this.#closed || this.#ws.readyState !== 1) throw Error('SIGNAL_UNAVAILABLE');
    const raw = JSON.stringify(value);
    if (encoder.encode(raw).length > MAX_OUTER_BYTES || this.#ws.bufferedAmount + raw.length > 2 * 1024 * 1024) throw Error('SEND_BUDGET_EXCEEDED');
    this.#ws.send(raw);
  }
  #outer(frame: Record<string, unknown>): void {
    switch (frame.type) {
      case 'opened': {
        if (this.#id || typeof frame.id !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(frame.id) || frame.deviceId !== this.#options.deviceId || frame.room !== this.#options.roomId || !identifier(frame.userId) || typeof frame.name !== 'string' || !frame.name || frame.name.length > 128 || !isRole(frame.role)) throw Error('INVALID_REMOTE_IDENTITY');
        this.#id = frame.id;
        this.#options.onInfo?.({id:frame.id,deviceId:this.#options.deviceId,roomId:this.#options.roomId,userId:frame.userId,name:frame.name,role:frame.role,managed:frame.managed === true});
        const available = frame.webRTC === true && (this.#options.peerFactory !== undefined || typeof RTCPeerConnection !== 'undefined');
        if (this.#options.mode === 'relay' || !available && this.#options.mode === 'auto') { this.#select('relay'); return; }
        if (!available) { this.#fail('WEBRTC_UNAVAILABLE'); return; }
        this.#rtcTimer = setTimeout(() => this.#fallback(), 18000);
        void this.#startRTC(iceServers(frame.iceServers)).catch(() => this.#fallback());
        return;
      }
      case 'answer':
        if (frame.id !== this.#id || typeof frame.sdp !== 'string' || !frame.sdp || frame.sdp.length > 65536) throw Error('INVALID_SDP');
        if (this.#requested === 'relay' || this.#closed) return;
        if (!this.#pc) throw Error('UNEXPECTED_ANSWER');
        void this.#pc.setRemoteDescription({type:'answer',sdp:frame.sdp}).catch(() => this.#fallback()); return;
      case 'selected':
        if (!this.#id || frame.id !== this.#id || this.#selected || frame.mode !== this.#requested) throw Error('INVALID_TRANSPORT_SELECTION');
        if (frame.mode === 'webrtc' && this.#dc?.readyState !== 'open') throw Error('DATA_CHANNEL_NOT_READY');
        this.#selected = frame.mode as 'relay' | 'webrtc';
        this.#options.onRoute?.(this.#selected === 'relay' ? 'cloud-relay' : 'webrtc');
        this.onopen?.(); if (this.#selected === 'webrtc') void this.#routeStats(); return;
      case 'data':
        if (frame.id !== this.#id || this.#selected !== 'relay' || typeof frame.payload !== 'string') throw Error('INVALID_DATA_ROUTE');
        this.#data(decodeBase64(frame.payload)); return;
      case 'signal_error':
        if (frame.id !== this.#id) throw Error('INVALID_SIGNAL_SCOPE'); this.#fallback(); return;
      default: throw Error('INVALID_SIGNAL_MESSAGE');
    }
  }
  async #startRTC(servers: RTCIceServer[]): Promise<void> {
    const pc = (this.#options.peerFactory ?? (config => new RTCPeerConnection(config)))({iceServers:servers}); this.#pc = pc;
    const dc = pc.createDataChannel('pi-cafe-v1', { ordered:true, protocol:'pi-cafe-v1' }); this.#dc = dc;
    dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 65536;
    dc.onopen = () => { if (this.#closed || this.#requested) return; if (pc.sctp && pc.sctp.maxMessageSize < PACKET_BYTES) { this.#fallback(); return; } this.#select('webrtc'); };
    dc.onclose = () => { if (this.#selected === 'webrtc') this.#fail('DATA_CHANNEL_CLOSED'); else if (!this.#requested) this.#fallback(); };
    dc.onerror = () => { if (this.#selected === 'webrtc') this.#fail('DATA_CHANNEL_FAILED'); else if (!this.#requested) this.#fallback(); };
    dc.onmessage = event => {
      if (this.#closed) return;
      try {
        if (this.#selected !== 'webrtc' || !(event.data instanceof ArrayBuffer)) throw Error('INVALID_DATA_ROUTE');
        const complete = this.#assembly.push(event.data);
        if (complete) { clearTimeout(this.#assemblyTimer); this.#assemblyTimer = undefined; this.#data(complete); }
        else if (!this.#assemblyTimer) this.#assemblyTimer = setTimeout(() => { if (this.#assembly.pending) this.#fail('MESSAGE_REASSEMBLY_TIMEOUT'); }, 10001);
      } catch { this.#fail('INVALID_FRAME'); }
    };
    pc.onconnectionstatechange = () => {
      if (this.#closed || !['failed','closed'].includes(pc.connectionState)) return;
      if (this.#selected === 'webrtc' || this.#requested === 'webrtc') this.#fail('WEBRTC_CONNECTION_LOST'); else if (!this.#requested) this.#fallback();
    };
    const offer = await pc.createOffer(); if (this.#closed || this.#requested) return;
    await pc.setLocalDescription(offer); await gathered(pc, this.#cancel.signal);
    if (this.#closed || this.#requested) return;
    const text = pc.localDescription?.sdp;
    if (!text || encoder.encode(text).length > 65536) throw Error('INVALID_SDP');
    this.#signal({type:'offer',id:this.#id,sdp:text});
  }
  #fallback(): void {
    if (this.#closed || this.#requested) return;
    if (this.#options.mode === 'auto') this.#select('relay'); else this.#fail('WEBRTC_UNAVAILABLE');
  }
  #select(mode: 'relay' | 'webrtc'): void {
    if (this.#closed || this.#requested || !this.#id) return;
    this.#requested = mode; clearTimeout(this.#rtcTimer);
    if (mode === 'relay') { this.#dc?.close(); this.#pc?.close(); }
    try { this.#signal({type:'select',id:this.#id,mode}); } catch { this.#fail('SIGNAL_UNAVAILABLE'); }
  }
  #data(bytes: Uint8Array): void {
    const raw = decoder.decode(bytes); const value: unknown = JSON.parse(raw);
    if (!object(value) || typeof value.type !== 'string') throw Error('INVALID_FRAME');
    if (value.type === 'remote.presence' || value.type === 'remote.result') { this.#options.onAuxiliary?.(value); return; }
    this.onmessage?.({ data:raw });
  }
  send(value: string): void {
    if (this.readyState !== 1) throw Error('NOT_CONNECTED');
    let raw = value;
    const parsed: unknown = JSON.parse(value);
    // The office endpoint authenticates a cloud-issued, connection-bound grant.
    // Never forward the browser's reusable cloud access key to a Pi instance.
    if (object(parsed) && parsed.type === 'hello') raw = JSON.stringify({...parsed,token:'remote-session'});
    const bytes = encoder.encode(raw);
    if (!bytes.length || bytes.length > MAX_BUSINESS_BYTES) throw Error('MESSAGE_TOO_LARGE');
    if (this.#selected === 'relay') { this.#signal({type:'data',id:this.#id,payload:encodeBase64(bytes)}); return; }
    if (this.#queue.length >= 128 || this.bufferedAmount + bytes.length > 1024*1024) throw Error('SEND_BUDGET_EXCEEDED');
    this.#queue.push(bytes); this.#queueBytes += bytes.length;
    void this.#pump();
  }
  async #lowWater(dc: RTCDataChannel): Promise<void> {
    if (this.#closed) throw Error('CANCELLED');
    if (dc.bufferedAmount <= 256*1024) return;
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); dc.removeEventListener('bufferedamountlow', low); this.#cancel.signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve(); };
      const low = () => { if (dc.bufferedAmount <= 256*1024) finish(); };
      const cancelled = () => finish(Error('CANCELLED'));
      const timer = setTimeout(() => finish(Error('SEND_BUDGET_TIMEOUT')), 5000);
      dc.addEventListener('bufferedamountlow', low); this.#cancel.signal.addEventListener('abort', cancelled, {once:true}); low();
    });
  }
  async #pump(): Promise<void> {
    if (this.#pumping) return; this.#pumping = true;
    try {
      while (!this.#closed && this.#queue.length) {
        const bytes = this.#queue.shift()!; this.#queueBytes -= bytes.length; this.#inflight = bytes.length;
        this.#sequence = (this.#sequence + 1) >>> 0 || 1;
        const dc = this.#dc;
        if (!dc || dc.readyState !== 'open') throw Error('DATA_CHANNEL_CLOSED');
        for (const packet of encodeChunks(this.#sequence,bytes)) { await this.#lowWater(dc); if (this.#closed) return; dc.send(packet); }
        this.#inflight = 0;
      }
    } catch { this.#fail('SEND_FAILED'); }
    finally { this.#inflight = 0; this.#pumping = false; }
  }
  async #routeStats(): Promise<void> {
    try {
      const stats = await this.#pc?.getStats(); if (!stats || this.#closed || this.#selected !== 'webrtc') return;
      let pair: Record<string,unknown> | undefined;
      stats.forEach(item => { if (item.type === 'transport' && item.selectedCandidatePairId) pair = stats.get(item.selectedCandidatePairId); });
      if (!pair) stats.forEach(item => { if (item.type === 'candidate-pair' && item.nominated && item.state === 'succeeded') pair = item; });
      if (!pair) return;
      const local = stats.get(String(pair.localCandidateId)), remote = stats.get(String(pair.remoteCandidateId));
      if (!local || !remote) return;
      this.#options.onRoute?.(local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'webrtc-turn' : 'webrtc-direct');
    } catch { /* Display generic WebRTC rather than claiming an unobserved route. */ }
  }
  #fail(code: string): void { if (this.#closed) return; this.#finish(code); this.onclose?.(); }
  #finish(code: string): void {
    if (this.#closed) return; this.#closed = true; this.#cancel.abort(); clearTimeout(this.#rtcTimer); clearTimeout(this.#assemblyTimer);
    this.#queue = []; this.#queueBytes = 0;
    this.#ws.onopen = null; this.#ws.onmessage = null; this.#ws.onclose = null; this.#ws.onerror = null;
    this.#ws.close(); if (this.#dc) { this.#dc.onclose = null; this.#dc.onerror = null; this.#dc.onmessage = null; this.#dc.close(); }
    if (this.#pc) { this.#pc.onconnectionstatechange = null; this.#pc.close(); }
    this.#options.onEnd?.(code);
  }
  close(): void { this.#finish('CLOSED'); }
}
