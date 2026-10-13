import { afterEach, expect, it, vi } from 'vitest';
import { RemoteAccess, parseCatalog, parsePresence } from './RemoteAccess';
import { catalog, FakeRemoteWebSocket, testAccessKey, testPeerId } from './testSocket';
import type { RemoteRole } from './RemoteSocket';
const owners:RemoteAccess[]=[];
afterEach(()=>{for(const owner of owners)owner.dispose();owners.length=0;sessionStorage.clear();vi.useRealTimers();});
async function setup(role:RemoteRole='operator') {
  const ws=new FakeRemoteWebSocket();
  const remote=new RemoteAccess({discover:async()=>({...catalog,devices:catalog.devices.map(d=>({...d,rooms:[{id:'main',role}]}))}),socketOptions:{origin:'http://localhost',socketFactory:()=>ws as unknown as WebSocket}});
  owners.push(remote);remote.enable(true);await remote.discover(testAccessKey);remote.prepare(testAccessKey,'office','main','relay');
  remote.createSocket();ws.open();ws.opened(role);ws.selected();remote.authenticated(true);ws.presence(role);
  return{remote,ws};
}
it('auto acquisition coalesces and waits for authoritative presence, not merely request success',async()=>{
 const{remote,ws}=await setup();const first=remote.ensureControl('pi-a'),second=remote.ensureControl('pi-a');expect(first).toBe(second);const done=vi.fn();void first.then(done);
 const q=ws.data().at(-1)!;expect(q).toMatchObject({type:'remote.control',hostId:'pi-a',action:'acquire'});expect(q.force).toBeUndefined();ws.result(q.requestId);await Promise.resolve();await Promise.resolve();expect(done).not.toHaveBeenCalled();expect(remote.canWrite('pi-a')).toBe(false);
 ws.presence('operator',[{hostId:'pi-a',holder:testPeerId,userId:'alice',name:'Alice',expiresAt:Date.now()+30000}]);await first;await second;expect(done).toHaveBeenCalledOnce();expect(ws.data()).toHaveLength(1);
});
it('missing presence confirmation fails closed rather than inventing a lease',async()=>{
 vi.useFakeTimers();const{remote,ws}=await setup();const result=remote.ensureControl('pi-a').catch(e=>e.message);ws.result(ws.data().at(-1)!.requestId);await vi.advanceTimersByTimeAsync(2501);expect(await result).toBe('CONTROL_UNCONFIRMED');expect(remote.canWrite('pi-a')).toBe(false);expect(ws.data()).toHaveLength(1);
});
it('viewer acquisition and disconnected acquisitions do not send additional control requests',async()=>{
 const viewer=await setup('viewer');await expect(viewer.remote.ensureControl('pi-a')).rejects.toThrow('READ_ONLY');expect(viewer.ws.data()).toHaveLength(0);
 const{remote,ws}=await setup();const result=remote.ensureControl('pi-a').catch(e=>e.message);ws.end();expect(await result).toBe('RESULT_UNKNOWN');expect(ws.data()).toHaveLength(1);expect(remote.canWrite('pi-a')).toBe(false);
});
it('catalogs and presence cannot claim duplicate identities or cross-room leases',()=>{
  expect(parseCatalog(catalog).devices[0]?.id).toBe('office');
  expect(()=>parseCatalog({...catalog,devices:[...catalog.devices,...catalog.devices]})).toThrow();
  expect(()=>parseCatalog({...catalog,devices:[{...catalog.devices[0],rooms:[{id:'main',role:'root'}]}]})).toThrow();
  expect(()=>parsePresence({self:testPeerId,role:'operator',members:[{id:testPeerId,userId:'alice',name:'Alice',room:'private',role:'operator'}],leases:[]},{id:testPeerId,deviceId:'office',roomId:'main',userId:'alice',name:'Alice',role:'operator',managed:true})).toThrow();
});
it('requires a discovered authorized device and room, and stores no credential in selection hints',async()=>{
  const{remote}=await setup();
  expect(()=>remote.prepare(testAccessKey,'other','main','relay')).toThrow('FORBIDDEN');
  expect(()=>remote.prepare(testAccessKey,'office','private','relay')).toThrow('FORBIDDEN');
  expect(()=>remote.prepare('z'.repeat(43),'office','main','relay')).toThrow('REMOTE_AUTH_REQUIRED');
  expect(sessionStorage.getItem('pi-cafe.remote.selection')).not.toContain(testAccessKey);
});
it('viewer cannot acquire control or create a background session',async()=>{
  const{remote,ws}=await setup('viewer');const count=ws.frames.length;
  await expect(remote.control('pi-a','acquire')).rejects.toThrow('READ_ONLY');
  await expect(remote.workspace({operation:'create',room:'main',id:'13572468-1234-4123-8123-123456789abc',projectId:'project',name:'New'})).rejects.toThrow('FORBIDDEN');
  expect(ws.frames).toHaveLength(count);expect(remote.canWrite('pi-a')).toBe(false);
});
it('requires a live per-instance lease and removes it when disconnected',async()=>{
  const{remote,ws}=await setup('operator');expect(remote.canWrite('pi-a')).toBe(false);
  ws.presence('operator',[{hostId:'pi-a',holder:testPeerId,userId:'alice',name:'Alice',expiresAt:Date.now()+30000}]);
  expect(remote.canWrite('pi-a')).toBe(true);expect(remote.canWrite('pi-b')).toBe(false);
  ws.end();expect(remote.canWrite('pi-a')).toBe(false);expect(remote.getSnapshot().members).toHaveLength(0);
});
it('round trips a management read and does not expose an ungranted room',async()=>{
  const{remote,ws}=await setup('viewer');
  const promise=remote.workspace({room:'main',operation:'list'});const q=ws.data().at(-1)!;
  expect(q.type).toBe('remote.workspace');ws.result(q.requestId,{projects:[],sessions:[],maxActive:8});
  await expect(promise).resolves.toEqual({projects:[],sessions:[],maxActive:8});
  await expect(remote.workspace({room:'private',operation:'list'})).rejects.toThrow('FORBIDDEN');
});
it('a sent write becomes unknown on disconnect, without replay',async()=>{
  const{remote,ws}=await setup('admin');
  const promise=remote.workspace({room:'main',operation:'close',id:'13572468-1234-4123-8123-123456789abc'});
  const result=expect(promise).rejects.toThrow('RESULT_UNKNOWN');
  expect(ws.data()).toHaveLength(1);ws.end();await result;expect(ws.data()).toHaveLength(1);
});
it('aborting an in-flight write is unknown and a late acknowledgement is ignored',async()=>{
  const{remote,ws}=await setup('admin');const cancel=new AbortController();
  const promise=remote.workspace({room:'main',operation:'close',id:'13572468-1234-4123-8123-123456789abc'},cancel.signal);
  const result=expect(promise).rejects.toThrow('RESULT_UNKNOWN');const id=ws.data().at(-1)!.requestId;
  cancel.abort();await result;ws.result(id,{});expect(remote.getSnapshot().phase).toBe('ready');expect(ws.data()).toHaveLength(1);
});
it('configuration must finish before the old local transport can receive a cloud credential',async()=>{
  const {AppOwner}=await import('../../app/owner');const {RelayClient}=await import('../relay/RelayClient');const {createRelayStorage}=await import('../relay/storage');
  const factory=vi.fn(()=>{throw Error('must not connect')});
  let resolve!: (value:{protocolVersion:1;wsPath:'/ws';defaultRoom:string;remoteAccess:true})=>void;
  const owner=new AppOwner({client:new RelayClient({origin:'http://localhost',socketFactory:factory}),storage:createRelayStorage(()=>{throw Error('isolated');}),http:{config:()=>new Promise(r=>{resolve=r;})}});
  const initializing=owner.initialize();expect(()=>owner.login(testAccessKey,'main')).toThrow('CONFIG_UNAVAILABLE');expect(factory).not.toHaveBeenCalled();
  resolve({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',remoteAccess:true});await initializing;expect(owner.remote.enabled).toBe(true);expect(factory).not.toHaveBeenCalled();owner.dispose();
});
