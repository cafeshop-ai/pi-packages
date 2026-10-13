export type RoomControlPolicy = 'legacy' | 'disabled' | 'approval';
export type ApplicationState = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'revoked' | 'released';
export interface ControlApplication { id:string; hostId:string; applicant:string; userId:string; name:string; identityKind?:'account'|'guest'; room:string; state:ApplicationState; createdAt:number; expiresAt:number }
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const bounded=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
export const controlToken=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(value);
export function parseControlApplications(value:unknown,room:string,applicant?:string):ControlApplication[]{
 if(!Array.isArray(value)||value.length>64)throw Error('INVALID_CONTROL_STATE');
 const rows=value.map((q):ControlApplication=>{
  if(!object(q)||!controlToken(q.id)||!controlToken(q.applicant)||applicant!==undefined&&q.applicant!==applicant||!bounded(q.hostId,256)||!bounded(q.userId,64)||!bounded(q.name,128)||q.room!==room||!['pending','approved','denied','cancelled','expired','revoked','released'].includes(String(q.state))||!Number.isSafeInteger(q.createdAt)||Number(q.createdAt)<0||!Number.isSafeInteger(q.expiresAt)||Number(q.expiresAt)<0)throw Error('INVALID_CONTROL_STATE');
  if(q.identityKind!==undefined&&q.identityKind!==''&&q.identityKind!=='account'&&q.identityKind!=='guest')throw Error('INVALID_CONTROL_STATE');
  return{...q.identityKind==='account'?{identityKind:'account' as const}:{},id:q.id,hostId:q.hostId,applicant:q.applicant,userId:q.userId,name:q.name,room,state:q.state as ApplicationState,createdAt:Number(q.createdAt),expiresAt:Number(q.expiresAt)};
 });
 if(new Set(rows.map(q=>q.id)).size!==rows.length)throw Error('INVALID_CONTROL_STATE');return rows;
}
