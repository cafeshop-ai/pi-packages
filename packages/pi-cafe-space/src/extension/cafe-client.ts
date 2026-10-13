import { Agent, request } from 'node:http';
import { localCredentialFile, readLocalHostToken } from './local-relay.js';

export interface CafeConfig { relayUrl: string; roomId: string; peerId: string; token: string; credentialsFile: string | null }
export type CafeState = 'ready' | 'room-offline' | 'setup' | 'local-only' | 'gateway-offline' | 'gateway-timeout' | 'gateway-error' | 'update-needed' | 'auth-error' | 'not-local';
export interface CafeInfo { state: CafeState; localURL: string | null; sharePage: string | null; name?: string; online?: boolean; activeInstances?: number; currentPiInRoom?: boolean; url?: string; roomKey?: string; revision?: number }
const clean = (v: unknown, limit: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= limit && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(v);
export function localCafeURL(value: string): string | null {
  try { const u = new URL(value); if (u.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/ws' || u.search || u.hash) return null;
    u.protocol = 'http:'; u.pathname = '/'; return u.origin;
  } catch { return null; }
}
export function parseTerminalInfo(value: unknown, localURL: string, sharing: boolean): CafeInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_CAFE_RESPONSE');
  const v = value as Record<string, unknown>;
  if (v.protocolVersion !== 1 || v.roomId !== 'main' || !clean(v.name, 128) || typeof v.online !== 'boolean' || !Number.isInteger(v.activeInstances) || Number(v.activeInstances) < 0 || Number(v.activeInstances) > 64 || typeof v.currentPiInRoom !== 'boolean' || v.visitorRole !== 'operator') throw Error('INVALID_CAFE_RESPONSE');
  const result: CafeInfo = { state: v.online ? 'ready' : 'room-offline', localURL, sharePage: localURL + '/#/rooms/main?panel=share', name: v.name, online: v.online, activeInstances: Number(v.activeInstances), currentPiInRoom: v.currentPiInRoom };
  if (sharing) {
    if (!clean(v.url, 4096) || typeof v.roomKey !== 'string' || !/^[A-Za-z0-9_-]{87}$/.test(v.roomKey) || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1) throw Error('INVALID_CAFE_RESPONSE');
    const bytes = Buffer.from(v.roomKey, 'base64url'); if (bytes.length !== 65 || bytes[0] !== 4 || bytes.toString('base64url') !== v.roomKey) throw Error('INVALID_CAFE_RESPONSE');
    const u = new URL(v.url); if (!(u.protocol === 'https:' || u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)) || u.username || u.password || u.pathname !== '/' || u.search || u.hash !== '#/room/' + v.roomKey) throw Error('INVALID_CAFE_RESPONSE');
    Object.assign(result, { url: v.url, roomKey: v.roomKey, revision: v.revision });
  } else if ('url' in v || 'roomKey' in v) throw Error('UNEXPECTED_INVITATION');
  return result;
}
interface LocalReply { status: number; body: Buffer }
// Pi may install a process-wide fetch/proxy dispatcher for model traffic.
// These requests are local IPC, not internet traffic: never use that dispatcher
// or mutate its settings. Each request owns a short-lived, non-proxy Agent.
async function localRequest(origin: string, path: '/api/config' | '/api/room/terminal', signal: AbortSignal, token?: string, body?: string): Promise<LocalReply> {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || (body && Buffer.byteLength(body) > 2048)) throw Error('INVALID_LOCAL_REQUEST');
  if (signal.aborted) throw Error('CANCELLED');
  const hostname = url.hostname === '[::1]' ? '::1' : '127.0.0.1';
  const agent = new Agent({ keepAlive: false, maxSockets: 1 });
  try {
    return await new Promise<LocalReply>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, value?: LocalReply) => {
        if (settled) return; settled = true;
        if (error) reject(error); else resolve(value!);
      };
      const headers: Record<string, string> = { Accept: 'application/json', Connection: 'close' };
      if (path === '/api/room/terminal') {
        if (!token || body === undefined) { finish(Error('INVALID_LOCAL_REQUEST')); return; }
        Object.assign(headers, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(body)), 'X-Cafe-Terminal': '1', Authorization: 'Bearer ' + token });
      }
      const req = request({ protocol: 'http:', hostname, port: url.port || '80', path, method: path === '/api/config' ? 'GET' : 'POST', headers, agent, signal, maxHeaderSize: 8192 }, response => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) { response.destroy(); finish(undefined, { status, body: Buffer.alloc(0) }); return; }
        const media = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
        if (media !== 'application/json' || response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity' || Number(response.headers['content-length'] ?? 0) > 8192) {
          response.destroy(); finish(Error('INVALID_CAFE_RESPONSE')); return;
        }
        let size = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 8192) { finish(Error('RESPONSE_TOO_LARGE')); response.destroy(); req.destroy(); return; }
          chunks.push(chunk);
        });
        response.once('end', () => response.complete ? finish(undefined, { status, body: Buffer.concat(chunks, size) }) : finish(Error('INCOMPLETE_RESPONSE')));
        response.once('error', error => finish(error));
        response.once('close', () => { if (!response.complete) finish(Error('INCOMPLETE_RESPONSE')); });
      });
      req.once('error', error => finish(error));
      req.once('upgrade', (_response, socket) => { socket.destroy(); finish(Error('UNEXPECTED_UPGRADE')); });
      req.end(body);
    });
  } finally { agent.destroy(); }
}
function responseJSON(response: LocalReply): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body));
}
export async function inspectCafe(config: CafeConfig, sharing: boolean, signal?: AbortSignal): Promise<CafeInfo> {
  const localURL = localCafeURL(config.relayUrl);
  const base: CafeInfo = { state: 'not-local', localURL, sharePage: localURL ? localURL + '/#/rooms/main?panel=share' : null };
  if (!localURL) return base;
  const cancel = new AbortController(), abort = () => cancel.abort(); if (signal?.aborted) throw Error('CANCELLED'); signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort(); }, 3500);
  try {
    const r = await localRequest(localURL, '/api/config', cancel.signal); if (r.status !== 200) return { ...base, state: r.status === 401 || r.status === 403 ? 'auth-error' : 'gateway-error' };
    const raw = responseJSON(r); if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('INVALID_CAFE_RESPONSE');
    const cfg = raw as Record<string, unknown>; if (cfg.protocolVersion !== 1) return { ...base, state: 'update-needed' };
    if (cfg.setupRequired === true) return { ...base, state: 'setup' };
    if (cfg.roomShare !== true) return { ...base, state: 'local-only' };
    if (cfg.terminalShare !== true) return { ...base, state: 'update-needed' };
    let token = config.token;
    if (config.credentialsFile) { try { const path = localCredentialFile(config.relayUrl); if (!path) return base; token = readLocalHostToken(config.credentialsFile, config.relayUrl) ?? ''; } catch { return { ...base, state: 'auth-error' }; } }
    if (!token) return { ...base, state: 'auth-error' };
    const response = await localRequest(localURL, '/api/room/terminal', cancel.signal, token, JSON.stringify({ operation: sharing ? 'share' : 'status', room: config.roomId, peerId: config.peerId }));
    token = '';
    if (response.status === 401 || response.status === 403) return { ...base, state: 'auth-error' };
    if (response.status === 404) return { ...base, state: 'update-needed' };
    if (response.status !== 200) return { ...base, state: 'gateway-error' };
    return parseTerminalInfo(responseJSON(response), localURL, sharing);
  } catch (error) {
    if (signal?.aborted) throw Error('CANCELLED');
    if (timedOut) return { ...base, state: 'gateway-timeout' };
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    return { ...base, state: code === 'ECONNREFUSED' ? 'gateway-offline' : 'gateway-error' };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
