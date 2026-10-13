import { controlToken, parseControlApplications, type ControlApplication } from '../remote/roomControlPolicy';
import type { ControlLease } from '../remote/RemoteAccess';
export interface OwnerControlState { version:1; enabled:boolean; revision:number; requestLifetimeSeconds:number; requests:ControlApplication[]; leases:ControlLease[] }
export type OwnerControlAction = {operation:'status'} | {operation:'configure';revision:number;enabled:boolean} | {operation:'approve'|'deny';revision:number;applicationId:string} | {operation:'revoke';revision:number;hostId:string;applicationId:string};
const errors=new Set(['UNAUTHORIZED','LOCAL_OWNER_REQUIRED','ROOM_CONTROL_CHANGED','CONTROL_REQUEST_GONE','CONTROL_REQUEST_EXPIRED','CONTROL_BUSY','CONTROL_DISABLED','HOST_NOT_READY','CONTROL_LIMIT','INVALID_REQUEST']);
export function parseOwnerControl(value:unknown):OwnerControlState{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('INVALID_CONTROL_STATE');const v=value as Record<string,unknown>;
 if(v.version!==1||typeof v.enabled!=='boolean'||!Number.isSafeInteger(v.revision)||Number(v.revision)<1||v.requestLifetimeSeconds!==90||!Array.isArray(v.leases)||v.leases.length>64)throw Error('INVALID_CONTROL_STATE');
 const requests=parseControlApplications(v.requests,'main');
 const leases=v.leases.map((raw):ControlLease=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('INVALID_CONTROL_STATE');const l=raw as Record<string,unknown>;
  if(typeof l.hostId!=='string'||!l.hostId||l.hostId.length>256||!controlToken(l.holder)||!controlToken(l.approvalId)||typeof l.userId!=='string'||l.userId.length>64||typeof l.name!=='string'||l.name.length>128||!Number.isSafeInteger(l.expiresAt)||Number(l.expiresAt)<0)throw Error('INVALID_CONTROL_STATE');
  return{hostId:l.hostId,holder:l.holder,approvalId:l.approvalId,userId:l.userId,name:l.name,expiresAt:Number(l.expiresAt)};
 });
 if(new Set(leases.map(l=>l.hostId)).size!==leases.length||!v.enabled&&(requests.length||leases.length))throw Error('INVALID_CONTROL_STATE');
 return{version:1,enabled:v.enabled,revision:Number(v.revision),requestLifetimeSeconds:90,requests,leases};
}
export async function roomControlRequest(token:string,action:OwnerControlAction,signal?:AbortSignal):Promise<OwnerControlState>{
 const cancel=new AbortController(),abort=()=>cancel.abort();if(signal?.aborted)throw Error('CANCELLED');signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,10000);
 try{
  const response=await fetch('/api/room/control',{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',signal:cancel.signal,headers:{'Content-Type':'application/json',Accept:'application/json','X-Cafe-Room':'1'},body:JSON.stringify({token,...action})});
  const text=await response.text();if(text.length>131072)throw Error('INVALID_CONTROL_STATE');const value:unknown=JSON.parse(text);
  if(!response.ok){const code=value&&typeof value==='object'&&!Array.isArray(value)?(value as Record<string,unknown>).error:null;throw Error(typeof code==='string'&&errors.has(code)?code:response.status===401?'UNAUTHORIZED':'ROOM_CONTROL_UNAVAILABLE');}
  return parseOwnerControl(value);
 }catch(error){if(error instanceof Error&&(errors.has(error.message)||['INVALID_CONTROL_STATE','ROOM_CONTROL_UNAVAILABLE'].includes(error.message)))throw error;throw Error(action.operation==='status'?'ROOM_CONTROL_UNAVAILABLE':'RESULT_UNKNOWN');}
 finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
