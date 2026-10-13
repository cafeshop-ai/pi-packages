import { Agent, request } from 'node:http';
import { readPrivateJSON } from './private-json.js';
import { localCafeURL, type CafeConfig } from './cafe-client.js';

export interface CafeApplication { id: string; name: string; hostId: string; expiresAt: number }
export interface CafeApprovals { version: 1; enabled: boolean; revision: number; hostId: string; requests: CafeApplication[] }
export type CafeDecision = { operation: 'status' } | { operation: 'approve' | 'deny'; revision: number; applicationId: string };
const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(x);
const token = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9_-]{43}$/.test(x);
const codes = new Set(['LOCAL_OWNER_REQUIRED','UNAUTHORIZED','HOST_NOT_READY','CONTROL_REQUEST_GONE','CONTROL_REQUEST_EXPIRED','CONTROL_BUSY','CONTROL_DISABLED','ROOM_CONTROL_CHANGED','INVALID_REQUEST']);
export function parseCafeApprovals(value: unknown, peerId: string): CafeApprovals {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('INVALID_APPROVAL_STATE');
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || typeof v.enabled !== 'boolean' || !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || v.hostId !== peerId || !Array.isArray(v.requests) || v.requests.length > 64) throw Error('INVALID_APPROVAL_STATE');
  const requests = v.requests.map((raw): CafeApplication => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('INVALID_APPROVAL_STATE');
    const q = raw as Record<string, unknown>;
    if (!token(q.id) || !text(q.name,128) || q.hostId !== peerId || q.room !== 'main' || q.state !== 'pending' || !Number.isSafeInteger(q.expiresAt) || Number(q.expiresAt) < 0) throw Error('INVALID_APPROVAL_STATE');
    return { id:q.id, name:q.name, hostId:peerId, expiresAt:Number(q.expiresAt) };
  });
  if (new Set(requests.map(q => q.id)).size !== requests.length || !v.enabled && requests.length) throw Error('INVALID_APPROVAL_STATE');
  return { version:1, enabled:v.enabled, revision:Number(v.revision), hostId:peerId, requests };
}
async function ownerCredentials(config: CafeConfig, port: number): Promise<{ owner: string; host: string }> {
  if (!config.credentialsFile) throw Error('LOCAL_OWNER_REQUIRED');
  try {
    const v = readPrivateJSON(config.credentialsFile);
    if (v.version !== 1 || v.port !== port || !token(v.hostToken) || !text(v.clientToken,256) || v.clientToken.length < 6 || v.clientToken.trim() !== v.clientToken || v.clientToken === v.hostToken) throw Error('LOCAL_OWNER_REQUIRED');
    return { owner:v.clientToken, host:v.hostToken };
  } catch { throw Error('LOCAL_OWNER_REQUIRED'); }
}
/** Authenticated local IPC only; credentials never leave loopback or reach the model. */
export async function requestCafeApprovals(config: CafeConfig, action: CafeDecision, signal?: AbortSignal): Promise<CafeApprovals> {
  const origin = localCafeURL(config.relayUrl); if (!origin || config.roomId !== 'main' || !text(config.peerId,256)) throw Error('LOCAL_OWNER_REQUIRED');
  if (action.operation !== 'status' && (!token(action.applicationId) || !Number.isSafeInteger(action.revision) || action.revision < 1)) throw Error('INVALID_REQUEST');
  if (signal?.aborted) throw Error('CANCELLED');
  const url = new URL(origin), cancel = new AbortController(), abort = () => cancel.abort();
  signal?.addEventListener('abort',abort,{once:true});const timer = setTimeout(abort,3500);timer.unref();
  let credentials: { owner:string;host:string } | undefined;
  const agent = new Agent({keepAlive:false,maxSockets:1});let dispatched = false;
  try {
    credentials = await ownerCredentials(config,Number(url.port||80));if(cancel.signal.aborted)throw Error('CANCELLED');
    const body = JSON.stringify({ ...action, room:'main', peerId:config.peerId });
    return await new Promise<CafeApprovals>((resolve,reject) => {
      let settled = false;
      const finish = (error?: Error, value?: CafeApprovals) => { if(settled)return;settled=true;if(error)reject(error);else resolve(value!); };
      const req = request({hostname:url.hostname === '[::1]' ? '::1' : '127.0.0.1',port:url.port||80,path:'/api/room/terminal-owner',method:'POST',agent,signal:cancel.signal,maxHeaderSize:8192,headers:{Accept:'application/json','Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),'X-Cafe-Local-Owner':'1',Authorization:'Bearer '+credentials!.owner,'X-Cafe-Pi-Authorization':'Bearer '+credentials!.host}},res=>{
        const status = res.statusCode??0;
        if (status === 404) {res.destroy();finish(Error('TERMINAL_APPROVAL_UPDATE_REQUIRED'));return;}
        if(res.headers['content-type']?.split(';')[0]?.trim()!=='application/json'||res.headers['content-encoding']&&res.headers['content-encoding']!=='identity'||Number(res.headers['content-length']??0)>131072){res.destroy();finish(Error('INVALID_APPROVAL_STATE'));return;}
        let size=0;const chunks:Buffer[]=[];
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>131072){finish(Error('INVALID_APPROVAL_STATE'));res.destroy();req.destroy();return;}chunks.push(chunk);});
        res.once('end',()=>{try{if(!res.complete)throw Error('INVALID_APPROVAL_STATE');const v=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));if(status!==200)throw Error(codes.has(v?.error)?v.error:'APPROVALS_UNAVAILABLE');finish(undefined,parseCafeApprovals(v,config.peerId));}catch(e){finish(e instanceof Error?e:Error('INVALID_APPROVAL_STATE'));}});
        res.once('error',()=>finish(Error('APPROVALS_UNAVAILABLE')));res.once('close',()=>{if(!res.complete)finish(Error('APPROVALS_UNAVAILABLE'));});
      });
      req.once('error',()=>finish(Error('APPROVALS_UNAVAILABLE')));req.once('upgrade',(_r,socket)=>{socket.destroy();finish(Error('INVALID_APPROVAL_STATE'));});
      dispatched = true;req.end(body);
    });
  } catch(e) {
    const code = e instanceof Error ? e.message : '';
    if(codes.has(code)||code==='TERMINAL_APPROVAL_UPDATE_REQUIRED'||code==='LOCAL_OWNER_REQUIRED')throw Error(code);
    throw Error(action.operation!=='status'&&dispatched?'RESULT_UNKNOWN':signal?.aborted?'CANCELLED':'APPROVALS_UNAVAILABLE');
  } finally { credentials=undefined;clearTimeout(timer);signal?.removeEventListener('abort',abort);agent.destroy(); }
}
