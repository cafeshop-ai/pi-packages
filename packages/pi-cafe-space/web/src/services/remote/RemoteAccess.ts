import axios from 'axios';
import type { CafeAccount } from './cafeAccount';
import { savedNickname, rememberNickname, validNickname } from './visitorIdentity';
import { nanoid } from 'nanoid';
import { RoomSocket, type RoomProgress } from './RoomSocket';
import { roomInitializationFailure } from './roomInitialization';
import type { RoomConnectionPolicy } from './roomTransport';
import { controlToken, parseControlApplications, type ControlApplication, type RoomControlPolicy } from './roomControlPolicy';
import { roomPasswordValid, validRoomKey } from './roomCrypto';
import type { ManagedRequest } from '../http/workspace';
import { isRole, RemoteSocket, type RemoteInfo, type RemoteMode, type RemoteRole, type RemoteRoute, type RemoteSocketOptions } from './RemoteSocket';

export interface RemoteDevice { id:string; name:string; online:boolean; webRTC:boolean; rooms:{id:string;role:RemoteRole}[] }
export interface DeviceCatalog { user:{id:string;name:string}; devices:RemoteDevice[] }
export interface Member { id:string;userId:string;name:string;room:string;role:RemoteRole }
export interface ControlLease { hostId:string;holder:string;userId:string;name:string;expiresAt:number;approvalId?:string }
export interface RemoteState {
  enabled:boolean; phase:'idle'|'connecting'|'ready'|'disconnected';
  deviceId:string|null; deviceName:string|null; mode:RemoteMode; route:RemoteRoute|null;
  info:RemoteInfo|null; members:Member[]; leases:ControlLease[]; error:string|null;
  roomProgress?:RoomProgress|null;
  visitorName?:string|null; visitorPersistent?:boolean; visitorKind?:'account'|'guest';
  controlPolicy?:RoomControlPolicy|null; controlRequests?:ControlApplication[];
}
type ActiveSocket = RemoteSocket | RoomSocket;
interface Pending { socket:ActiveSocket; write:boolean; resolve:(value:unknown)=>void; reject:(error:Error)=>void; timer:ReturnType<typeof setTimeout>; cleanup:()=>void }
interface Selection { token:string;deviceId:string;roomId:string;mode:RemoteMode;roomKey?:string;password?:string;nickname?:string;account?:CafeAccount;connectionPolicy?:RoomConnectionPolicy }
interface Options { discover?:(token:string,signal?:AbortSignal)=>Promise<unknown>; socketOptions?:Pick<RemoteSocketOptions,'origin'|'socketFactory'|'peerFactory'> }
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(v);
const peer=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9_-]{43,128}$/.test(v);
const text=(v:unknown,n:number):v is string=>typeof v==='string'&&v.length>0&&v.length<=n;
const http=axios.create({adapter:'xhr',timeout:10000,withCredentials:false,responseType:'text',transformResponse:[],headers:{'Content-Type':'application/json',Accept:'application/json'}});
async function discoverHTTP(token:string,signal?:AbortSignal):Promise<unknown>{
  try {
    const response=await http.post<string>('/api/remote/devices',{}, {signal,headers:{Authorization:'Bearer '+token}});
    if(typeof response.data!=='string'||response.data.length>262144)throw Error('INVALID_DEVICE_CATALOG');
    return JSON.parse(response.data);
  } catch(error) {
    if(axios.isCancel(error))throw Error('REQUEST_CANCELLED');
    if(axios.isAxiosError(error)&&error.response?.status===401)throw Error('UNAUTHORIZED');
    throw Error('DEVICE_DISCOVERY_FAILED');
  }
}
export function parseCatalog(value:unknown):DeviceCatalog{
  if(!object(value)||!object(value.user)||!id(value.user.id)||!text(value.user.name,128)||!Array.isArray(value.devices)||value.devices.length>64)throw Error('INVALID_DEVICE_CATALOG');
  const devices=value.devices.map((d):RemoteDevice=>{
    if(!object(d)||!id(d.id)||!text(d.name,128)||typeof d.online!=='boolean'||typeof d.webRTC!=='boolean'||!Array.isArray(d.rooms)||!d.rooms.length||d.rooms.length>128)throw Error('INVALID_DEVICE_CATALOG');
    const rooms=d.rooms.map(r=>{if(!object(r)||!id(r.id)||!isRole(r.role))throw Error('INVALID_DEVICE_CATALOG');return{id:r.id,role:r.role};});
    if(new Set(rooms.map(r=>r.id)).size!==rooms.length)throw Error('INVALID_DEVICE_CATALOG');
    return{id:d.id,name:d.name,online:d.online,webRTC:d.webRTC,rooms};
  });
  if(new Set(devices.map(d=>d.id)).size!==devices.length)throw Error('INVALID_DEVICE_CATALOG');
  return{user:{id:value.user.id,name:value.user.name},devices};
}
export function parsePresence(value:Record<string,unknown>,info:RemoteInfo):{members:Member[];leases:ControlLease[];controlPolicy:RoomControlPolicy;controlRequests:ControlApplication[]}{
  if(value.self!==info.id||value.role!==info.role||!Array.isArray(value.members)||value.members.length>32||!Array.isArray(value.leases)||value.leases.length>64)throw Error('INVALID_PRESENCE');
  const members=value.members.map((m):Member=>{if(!object(m)||!peer(m.id)||!id(m.userId)||!text(m.name,128)||m.room!==info.roomId||!isRole(m.role))throw Error('INVALID_PRESENCE');return{id:m.id,userId:m.userId,name:m.name,room:info.roomId,role:m.role};});
  if(new Set(members.map(m=>m.id)).size!==members.length||!members.some(m=>m.id===info.id&&m.userId===info.userId))throw Error('INVALID_PRESENCE');
  const leases=value.leases.map((l):ControlLease=>{if(!object(l)||!text(l.hostId,256)||!peer(l.holder)||!id(l.userId)||!text(l.name,128)||!Number.isSafeInteger(l.expiresAt)||Number(l.expiresAt)<0||!members.some(m=>m.id===l.holder&&m.userId===l.userId))throw Error('INVALID_PRESENCE');return{hostId:l.hostId,holder:l.holder,userId:l.userId,name:l.name,expiresAt:Number(l.expiresAt)};});
  if(new Set(leases.map(l=>l.hostId)).size!==leases.length)throw Error('INVALID_PRESENCE');
  const controlPolicy=value.controlPolicy===undefined?'legacy':value.controlPolicy;
  if(!['legacy','disabled','approval'].includes(String(controlPolicy)))throw Error('INVALID_PRESENCE');
  const controlRequests=parseControlApplications(value.controlRequests??[],info.roomId,info.id);
  if(controlRequests.some(q=>q.userId!==info.userId)||controlPolicy!=='approval'&&controlRequests.length||controlPolicy==='disabled'&&leases.length)throw Error('INVALID_PRESENCE');
  if(controlPolicy==='approval')for(let index=0;index<leases.length;index++){const raw=value.leases[index] as Record<string,unknown>;if(!controlToken(raw.approvalId))throw Error('INVALID_PRESENCE');leases[index]={...leases[index]!,approvalId:raw.approvalId};}
  return{members,leases,controlPolicy:controlPolicy as RoomControlPolicy,controlRequests};
}
export class RemoteAccess {
  #state:RemoteState={enabled:false,phase:'idle',deviceId:null,deviceName:null,mode:'auto',route:null,info:null,members:[],leases:[],error:null,controlPolicy:null,controlRequests:[]};
  #listeners=new Set<()=>void>(); #socket:ActiveSocket|null=null; #selection:Selection|null=null;
  #catalog:DeviceCatalog|null=null; #catalogToken=''; #discovery=0; #disposed=false;
  #pending=new Map<string,Pending>(); #renew:ReturnType<typeof setInterval>|undefined;
  readonly #options:Options;
  constructor(options:Options={}){this.#options=options;}
  getSnapshot=():RemoteState=>this.#state;
  subscribe=(fn:()=>void):(()=>void)=>{this.#listeners.add(fn);return()=>{this.#listeners.delete(fn)};};
  #update(change:Partial<RemoteState>):void{if(this.#disposed)return;this.#state={...this.#state,...change};for(const fn of this.#listeners)fn();}
  get enabled():boolean{return this.#state.enabled;}
  get roomKey():string|null{return this.#selection?.roomKey??null;}
  get accountSession():string|null{return this.#selection?.account?.sessionId??null;}
  prepareRoomLink(roomKey:string,password:string,connectionPolicy:RoomConnectionPolicy='auto',nickname=savedNickname(roomKey),account?:CafeAccount):void{
    if(connectionPolicy!=='auto'&&connectionPolicy!=='relay-tcp')throw Error('INVALID_ROOM_TRANSPORT_POLICY');
    if(!this.enabled||!validRoomKey(roomKey)||!roomPasswordValid(password)||!validNickname(nickname))throw Error('INVALID_ROOM_CREDENTIALS');
    this.#selection={token:'room-session',deviceId:'room',roomId:'main',mode:'webrtc',roomKey,password,connectionPolicy,nickname,...account?{account}:{}};if(!account)rememberNickname(roomKey,nickname);
    this.#update({deviceId:'room',deviceName:'Café Space',mode:'webrtc',error:null,roomProgress:{stage:'signaling',localRelay:false,remoteRelay:false,iceErrorCode:null,signalCloseCode:null}});
  }
  enable(enabled:boolean):void{this.#update({enabled});}
  async discover(token:string,signal?:AbortSignal):Promise<DeviceCatalog>{
    if(!/^[A-Za-z0-9_-]{43,128}$/.test(token))throw Error('INVALID_ACCESS_KEY');
    const revision=++this.#discovery;
    const catalog=parseCatalog(await(this.#options.discover??discoverHTTP)(token,signal));
    if(this.#disposed||signal?.aborted||revision!==this.#discovery)throw Error('REQUEST_CANCELLED');
    this.#catalog=catalog;this.#catalogToken=token;return catalog;
  }
  savedSelection():{deviceId:string;roomId:string;mode:RemoteMode}|null{
    try{const value:unknown=JSON.parse(sessionStorage.getItem('pi-cafe.remote.selection')??'null');if(!object(value)||!id(value.deviceId)||!id(value.roomId)||!['auto','relay','webrtc'].includes(String(value.mode)))return null;return{deviceId:value.deviceId,roomId:value.roomId,mode:value.mode as RemoteMode};}catch{return null;}
  }
  prepare(token:string,deviceId:string,roomId:string,mode:RemoteMode):void{
    if(!this.enabled||token!==this.#catalogToken||!['auto','relay','webrtc'].includes(mode))throw Error('REMOTE_AUTH_REQUIRED');
    const device=this.#catalog?.devices.find(d=>d.id===deviceId);if(!device||!device.rooms.some(r=>r.id===roomId))throw Error('FORBIDDEN');
    this.#selection={token,deviceId,roomId,mode};
    try{sessionStorage.setItem('pi-cafe.remote.selection',JSON.stringify({deviceId,roomId,mode}));}catch{/* Memory-only operation remains available. */}
    this.#update({deviceId,deviceName:device.name,mode,error:null});
  }
  prepareRoom(token:string,roomId:string):void{const selected=this.#selection;if(!selected)throw Error('SELECT_DEVICE');if(selected.roomKey){if(roomId!=='main')throw Error('FORBIDDEN');return;}this.prepare(token,selected.deviceId,roomId,selected.mode);}
  createSocket=():ActiveSocket=>{
    const selected=this.#selection;if(!selected||!this.enabled||this.#disposed)throw Error('SELECT_DEVICE');
    this.#socket?.close();this.#update({phase:'connecting',route:null,info:null,members:[],leases:[],controlPolicy:null,controlRequests:[],error:null});
    let socket:ActiveSocket;
    const callbacks={
      onVisitor:(visitorName:string,visitorPersistent:boolean,visitorKind:'account'|'guest'='guest')=>{if(this.#socket===socket)this.#update({visitorName,visitorPersistent,visitorKind});},
      onProgress:(roomProgress:RoomProgress)=>{if(this.#socket===socket)this.#update({roomProgress});},
      onInfo:(info:RemoteInfo)=>{if(this.#socket===socket)this.#update({info,...selected.roomKey?{deviceName:info.name}:{}});},
      onRoute:(route:RemoteRoute)=>{if(this.#socket===socket)this.#update({route});},
      onAuxiliary:(value:Record<string,unknown>)=>{if(this.#socket===socket)this.#auxiliary(value);},
      onEnd:(code:string)=>{if(this.#socket!==socket)return;this.#socket=null;this.#settleAll();clearInterval(this.#renew);this.#renew=undefined;this.#update({phase:'disconnected',info:null,members:[],leases:[],controlPolicy:null,controlRequests:[],route:null,error:code==='CLOSED'?null:code});},
    };
    try {
      socket=selected.roomKey ? new RoomSocket({roomKey:selected.roomKey,password:selected.password!,nickname:selected.nickname,account:selected.account,connectionPolicy:selected.connectionPolicy,...this.#options.socketOptions,...callbacks}) : new RemoteSocket({...selected,...this.#options.socketOptions,...callbacks});
    } catch(error) {
      if(selected.roomKey){const {code,diagnostic}=roomInitializationFailure(error);this.#socket=null;this.#update({phase:'disconnected',error:code,roomProgress:{stage:'signaling',localRelay:false,remoteRelay:false,iceErrorCode:null,signalCloseCode:null,initialization:diagnostic}});throw Error(code);}
      throw error;
    }
    this.#socket=socket;return socket;
  };
  authenticated(value:boolean):void{
    if(!this.enabled)return;
    clearInterval(this.#renew);this.#renew=undefined;
    if(!value){this.#update({phase:this.#socket?'connecting':'disconnected',members:[],leases:[],controlPolicy:null,controlRequests:[]});return;}
    this.#update({phase:'ready',...(this.#selection?.roomKey&&this.#state.roomProgress?{roomProgress:{...this.#state.roomProgress,stage:'connected' as const}}:{})});
    this.#renew=setInterval(()=>{
      if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
      const info=this.#state.info;if(!info||this.#state.phase!=='ready')return;
      for(const lease of this.#state.leases){if(lease.holder===info.id&&lease.expiresAt>Date.now())void this.control(lease.hostId,'renew').catch(()=>{/* No acquire/retry after lost control. */});}
    },10000);
  }
  #acquisitions = new Map<string,Promise<void>>();
  canRequestWrite():boolean{return !this.enabled||this.#state.phase==='ready'&&!!this.#state.info&&this.#state.info.role!=='viewer';}
  ensureControl(hostId:string):Promise<void>{
    if(!this.enabled||this.canWrite(hostId))return Promise.resolve();
    if(!this.canRequestWrite())return Promise.reject(Error(this.#state.info?.role==='viewer'?'READ_ONLY':'NOT_CONNECTED'));
    if(this.#state.controlPolicy==='approval')return Promise.reject(Error('CONTROL_APPROVAL_REQUIRED'));
    const identity=this.#state.info!.id,socket=this.#socket;
    const lease=this.#state.leases.find(l=>l.hostId===hostId&&l.expiresAt>Date.now());
    if(lease&&lease.holder!==identity)return Promise.reject(Error('CONTROL_BUSY'));
    const key=JSON.stringify([identity,hostId]);const existing=this.#acquisitions.get(key);if(existing)return existing;
    const pending=(async()=>{
      await this.control(hostId,'acquire',false);
      if(this.#socket!==socket||this.#state.info?.id!==identity||this.#state.phase!=='ready')throw Error('NOT_CONNECTED');
      if(this.canWrite(hostId))return;
      // A result precedes the authoritative presence frame on this channel.
      // Never pretend the lease is ours before that frame has arrived.
      await new Promise<void>((resolve,reject)=>{
        let finished=false;let unsubscribe=()=>{};
        const finish=(error?:string)=>{if(finished)return;finished=true;clearTimeout(timer);unsubscribe();error?reject(Error(error)):resolve();};
        const check=()=>{if(this.#socket!==socket||this.#state.info?.id!==identity||this.#state.phase!=='ready')finish('NOT_CONNECTED');else if(this.canWrite(hostId))finish();else if(this.#state.leases.some(l=>l.hostId===hostId&&l.holder!==identity&&l.expiresAt>Date.now()))finish('CONTROL_BUSY');};
        const timer=setTimeout(()=>finish('CONTROL_UNCONFIRMED'),2500);
        unsubscribe=this.subscribe(check);check();
      });
    })();
    this.#acquisitions.set(key,pending);
    void pending.then(()=>{if(this.#acquisitions.get(key)===pending)this.#acquisitions.delete(key);},()=>{if(this.#acquisitions.get(key)===pending)this.#acquisitions.delete(key);});
    return pending;
  }
  canWrite(hostId:string):boolean{
    if(!this.enabled)return true;
    const {info,phase,leases}=this.#state;
    return phase==='ready'&&!!info&&info.role!=='viewer'&&(this.#state.controlPolicy==='disabled'||leases.some(l=>l.hostId===hostId&&l.holder===info.id&&l.expiresAt>Date.now()));
  }
  canManage():boolean{return !this.enabled||this.#state.controlPolicy!=='approval'&&this.#state.phase==='ready'&&!!this.#state.info?.managed&&(this.#state.info.role==='admin'||!!this.#selection?.roomKey&&this.#state.info.role==='operator');}
  canCloseManaged():boolean{return !this.enabled||this.#state.phase==='ready'&&this.#state.info?.role==='admin'&&this.#state.info.managed;}
  #auxiliary(value:Record<string,unknown>):void{
    if(value.type==='remote.presence'){
      if(!this.#state.info)throw Error('INVALID_PRESENCE');
      this.#update(parsePresence(value,this.#state.info));return;
    }
    if(value.type!=='remote.result'||typeof value.requestId!=='string'||!/^[-_A-Za-z0-9]{1,128}$/.test(value.requestId)||typeof value.ok!=='boolean'||(value.code!==undefined&&(typeof value.code!=='string'||!/^[_A-Z]{1,64}$/.test(value.code))))throw Error('INVALID_REMOTE_RESULT');
    const p=this.#pending.get(value.requestId);if(!p||p.socket!==this.#socket)return;
    this.#pending.delete(value.requestId);clearTimeout(p.timer);p.cleanup();
    if(value.ok)p.resolve(value.data);else p.reject(Error(typeof value.code==='string'?value.code:'COMMAND_REJECTED'));
  }
  #request(message:Record<string,unknown>,write:boolean,signal?:AbortSignal):Promise<unknown>{
    const socket=this.#socket;
    if(!socket||socket.readyState!==1||this.#state.phase!=='ready')return Promise.reject(Error('NOT_CONNECTED'));
    if(signal?.aborted)return Promise.reject(Error('REQUEST_CANCELLED'));
    if(this.#pending.size>=32)return Promise.reject(Error('COMMAND_QUEUE_FULL'));
    const requestId=nanoid(),raw=JSON.stringify({...message,requestId});if(new TextEncoder().encode(raw).length>4096)return Promise.reject(Error('INVALID_REQUEST'));
    return new Promise((resolve,reject)=>{
      const finish=(code:string)=>{const p=this.#pending.get(requestId);if(!p)return;this.#pending.delete(requestId);clearTimeout(p.timer);p.cleanup();reject(Error(code));};
      const onAbort=()=>finish(write?'RESULT_UNKNOWN':'REQUEST_CANCELLED');
      const timer=setTimeout(()=>finish(write?'RESULT_UNKNOWN':'REQUEST_TIMEOUT'),12000);
      this.#pending.set(requestId,{socket,write,resolve,reject,timer,cleanup:()=>signal?.removeEventListener('abort',onAbort)});
      signal?.addEventListener('abort',onAbort,{once:true});
      try{socket.send(raw);}catch{finish(write?'RESULT_UNKNOWN':'SEND_FAILED');}
    });
  }
  control(hostId:string,action:'acquire'|'renew'|'release',force=false):Promise<unknown>{
    if(this.#state.info?.role==='viewer')return Promise.reject(Error('READ_ONLY'));
    if(force&&(this.#state.info?.role!=='admin'||this.#state.controlPolicy==='approval'||this.#state.controlPolicy==='disabled'||!!this.#selection?.roomKey))return Promise.reject(Error('FORBIDDEN'));
    return this.#request({type:'remote.control',hostId,action,...force?{force}:{}},true);
  }
  cancelControl(hostId:string,applicationId:string):Promise<unknown>{
    if(!controlToken(applicationId)||!this.#state.controlRequests?.some(q=>q.id===applicationId&&q.hostId===hostId&&q.applicant===this.#state.info?.id&&q.state==='pending'))return Promise.reject(Error('CONTROL_REQUEST_GONE'));
    return this.#request({type:'remote.control',hostId,action:'cancel',applicationId},true);
  }
  workspace(request:ManagedRequest,signal?:AbortSignal):Promise<unknown>{
    if(request.room!==this.#state.info?.roomId)return Promise.reject(Error('FORBIDDEN'));
    if(!this.#state.info?.managed)return Promise.reject(Error('MANAGED_UNAVAILABLE'));
    if(request.operation==='close'&&!this.canCloseManaged())return Promise.reject(Error('FORBIDDEN'));
    const write=request.operation!=='list';if(write&&!this.canManage())return Promise.reject(Error('FORBIDDEN'));
    return this.#request({type:'remote.workspace',request},write,signal);
  }
  #settleAll():void{for(const p of this.#pending.values()){clearTimeout(p.timer);p.cleanup();p.reject(Error(p.write?'RESULT_UNKNOWN':'CONNECTION_LOST'));}this.#pending.clear();}
  logout():void{
    this.#socket?.close();this.#socket=null;this.#selection=null;this.#catalog=null;this.#catalogToken='';this.#discovery++;clearInterval(this.#renew);this.#renew=undefined;this.#settleAll();
    this.#update({phase:'idle',visitorName:null,visitorPersistent:undefined,deviceId:null,deviceName:null,route:null,info:null,members:[],leases:[],controlPolicy:null,controlRequests:[],error:null,roomProgress:null});
  }
  dispose():void{if(this.#disposed)return;this.logout();this.#disposed=true;this.#listeners.clear();}
}
