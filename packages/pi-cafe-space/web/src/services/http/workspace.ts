import axios from 'axios';
import {canonicalExecution,isExecutionState,type ExecutionState} from '../../../../src/protocol/execution';
import type {SessionSnapshot} from '../../../../src/protocol/index';
export function executionScope(snapshot:Pick<SessionSnapshot,'streamId'|'sessionId'|'lastEventSeq'>|null|undefined):string|null{return snapshot?JSON.stringify([snapshot.streamId,snapshot.sessionId,snapshot.lastEventSeq]):null;}
export interface ManagedProject { id: string; name: string; room: string; cwd: string }
export interface ManagedSession { id: string; projectId: string; room: string; name: string; hostId: string; status: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'; title?: string; error?: string; execution?:ExecutionState }
export interface ManagedInventory { projects: ManagedProject[]; sessions: ManagedSession[]; maxActive: number }
export type ManagedRequest = { room: string; operation: 'list' } | { room: string; operation: 'create'; id: string; projectId: string; name: string } | { room: string; operation: 'open' | 'close'; id: string };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export function parseManagedSession(value: unknown, room: string): ManagedSession {
  if (!object(value) || !uuid(value.id) || value.room !== room || !text(value.projectId, 64) || !text(value.name, 256) || value.hostId !== 'managed-' + value.id || !['starting','ready','stopping','stopped','failed'].includes(String(value.status)) || (value.title !== undefined && !text(value.title,256)) || (value.error !== undefined && !text(value.error,128))) throw Error('INVALID_MANAGED_RESPONSE');
  if(value.execution!==undefined&&!isExecutionState(value.execution))throw Error('INVALID_MANAGED_RESPONSE');
  return {id:value.id,projectId:value.projectId,room,name:value.name,hostId:value.hostId,status:value.status as ManagedSession['status'],...(value.title===undefined?{}:{title:value.title as string}),...(value.error===undefined?{}:{error:value.error as string}),...(value.execution===undefined?{}:{execution:canonicalExecution(value.execution)})};
}
export function parseManagedInventory(value: unknown, room: string): ManagedInventory {
  if (!object(value) || !Array.isArray(value.projects) || value.projects.length > 16 || !Array.isArray(value.sessions) || value.sessions.length > 100 || value.maxActive !== 8) throw Error('INVALID_MANAGED_RESPONSE');
  for (const p of value.projects) if (!object(p) || p.room !== room || !text(p.id,64) || !text(p.name,256) || !text(p.cwd,16384)) throw Error('INVALID_MANAGED_RESPONSE');
  const sessions = value.sessions.map(s => parseManagedSession(s, room));
  if (new Set(sessions.map(s=>s.id)).size !== sessions.length || new Set(value.projects.map(p=>p.id)).size !== value.projects.length) throw Error('INVALID_MANAGED_RESPONSE');
  return { projects: value.projects as ManagedProject[], sessions, maxActive: 8 };
}
// Fixed same-origin XHR only: never put credentials in query strings and never
// retry writes after timeout/disconnect. Registry IDs make manual reconciliation safe.
const client = axios.create({ adapter:'xhr', timeout:10000, withCredentials:false, responseType:'text', transformResponse:[], headers:{'Content-Type':'application/json',Accept:'application/json'} });
export async function managedRequest(token: string, request: ManagedRequest, signal?: AbortSignal): Promise<unknown> {
  try {
    const response = await client.post<string>('/api/workspace', request, { signal, headers:{Authorization:'Bearer '+token} });
    if (typeof response.data !== 'string' || response.data.length > 262144) throw Error('INVALID_MANAGED_RESPONSE');
    return JSON.parse(response.data);
  } catch (error) {
    if (axios.isCancel(error)) throw Error('REQUEST_CANCELLED');
    if (axios.isAxiosError(error) && error.response && typeof error.response.data === 'string' && error.response.data.length < 1024) {
      try { const data = JSON.parse(error.response.data); if (/^[A-Z_]{1,64}$/.test(data.error)) throw Error(data.error); } catch (parsed) { if (parsed instanceof Error && /^[A-Z_]{1,64}$/.test(parsed.message)) throw parsed; }
    }
    throw Error('RESULT_UNKNOWN');
  }
}
