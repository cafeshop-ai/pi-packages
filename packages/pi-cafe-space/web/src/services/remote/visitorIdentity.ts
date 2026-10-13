import { encodeRoomBase64, roomHash, validRoomKey } from './roomCrypto';
export interface VisitorIdentity { publicKey:string; privateKey:CryptoKey; persistent:boolean }
const retained=new Map<string,Promise<VisitorIdentity>>();
export function validNickname(value:string):boolean{return value.length>0&&Array.from(value).length<=24&&value.trim()===value&&!/[\p{Cc}\p{Cf}\p{Cs}#]/u.test(value);}
export function savedNickname(room:string):string{try{const value=localStorage.getItem('cafe.nickname.'+room);return value&&validNickname(value)?value:'Guest';}catch{return 'Guest';}}
export function rememberNickname(room:string,name:string):void{if(!validRoomKey(room)||!validNickname(name))return;try{localStorage.setItem('cafe.nickname.'+room,name);}catch{/* The live nickname still works. */}}
async function generated():Promise<VisitorIdentity>{const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},false,['sign','verify']);return{publicKey:encodeRoomBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))),privateKey:pair.privateKey,persistent:false};}
function usable(value:unknown):value is VisitorIdentity{if(!value||typeof value!=='object')return false;const v=value as VisitorIdentity;return validRoomKey(v.publicKey)&&!!v.privateKey&&v.privateKey.type==='private'&&!v.privateKey.extractable&&v.privateKey.algorithm.name==='ECDSA'&&(v.privateKey.algorithm as EcKeyAlgorithm).namedCurve==='P-256'&&v.privateKey.usages.includes('sign');}
async function database():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{const request=indexedDB.open('cafe-visitors-v1',1);const timer=setTimeout(()=>reject(Error('IDENTITY_STORAGE_TIMEOUT')),2000);request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains('identities'))request.result.createObjectStore('identities');};request.onerror=()=>{clearTimeout(timer);reject(request.error)};request.onblocked=()=>{clearTimeout(timer);reject(Error('IDENTITY_STORAGE_BLOCKED'))};request.onsuccess=()=>{clearTimeout(timer);resolve(request.result)};});}
async function load(room:string):Promise<VisitorIdentity>{
 const candidate=await generated();let db:IDBDatabase|undefined;
 try{db=await database();return await new Promise<VisitorIdentity>((resolve,reject)=>{
  const tx=db!.transaction('identities','readwrite'),store=tx.objectStore('identities'),get=store.get(room);let chosen:VisitorIdentity=candidate;
  get.onsuccess=()=>{if(usable(get.result)){chosen={...get.result,persistent:true};}else if(get.result===undefined){chosen={...candidate,persistent:true};store.put(chosen,room);}else{tx.abort();}};
  tx.oncomplete=()=>resolve(chosen);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
 });}catch{return candidate;}finally{db?.close();}
}
export function visitorIdentity(room:string):Promise<VisitorIdentity>{if(!validRoomKey(room))return Promise.reject(Error('INVALID_ROOM_KEY'));let result=retained.get(room);if(!result){result=load(room);retained.set(room,result);void result.catch(()=>{if(retained.get(room)===result)retained.delete(room)});}return result;}
export async function visitorProof(identity:VisitorIdentity,room:string,id:string,nonce:string,nickname:string):Promise<{publicKey:string;signature:string;userId:string;displayName:string}>{
 if(!validNickname(nickname)||!validRoomKey(room)||!/^[-_A-Za-z0-9]{43}$/.test(id)||!/^[-_A-Za-z0-9]{43}$/.test(nonce))throw Error('INVALID_VISITOR_PROFILE');
 const digest=await roomHash(room+':'+identity.publicKey),message=JSON.stringify(['cafe-visitor-v1',room,id,nonce,await roomHash(nickname),identity.publicKey]);
 const signature=await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},identity.privateKey,new TextEncoder().encode(message));
 return{publicKey:identity.publicKey,signature:encodeRoomBase64(new Uint8Array(signature)),userId:'visitor-'+digest.slice(0,24),displayName:nickname+'#'+digest.slice(0,8)};
}
