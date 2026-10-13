import { afterEach, expect, it } from 'vitest';
import { RemoteAccess, parsePresence } from './RemoteAccess';
import { FakeRemoteWebSocket, catalog, testAccessKey, testPeerId } from './testSocket';
import { parseOwnerControl } from '../http/roomControl';
const owners:RemoteAccess[]=[];afterEach(()=>owners.splice(0).forEach(o=>o.dispose()));
const info={id:testPeerId,deviceId:'office',roomId:'main',userId:'alice',name:'Alice',role:'operator' as const,managed:true};
const q={id:'q'.repeat(43),hostId:'pi-a',applicant:testPeerId,userId:'alice',name:'Alice',room:'main',state:'pending',createdAt:Date.now(),expiresAt:Date.now()+90000};
const presence=(controlPolicy:string,controlRequests:unknown[]=[],leases:unknown[]=[])=>({type:'remote.presence',self:testPeerId,role:'operator',members:[{id:testPeerId,userId:'alice',name:'Alice',room:'main',role:'operator'}],leases,controlPolicy,controlRequests});
async function setup(){const ws=new FakeRemoteWebSocket();const remote=new RemoteAccess({discover:async()=>catalog,socketOptions:{origin:'http://localhost',socketFactory:()=>ws as unknown as WebSocket}});owners.push(remote);remote.enable(true);await remote.discover(testAccessKey);remote.prepare(testAccessKey,'office','main','relay');remote.createSocket();ws.open();ws.opened();ws.selected();remote.authenticated(true);return{remote,ws};}
it('disabled rooms allow operator writes without any acquisition or lease',async()=>{const{remote,ws}=await setup();ws.business(presence('disabled'));expect(remote.canWrite('pi-a')).toBe(true);await remote.ensureControl('pi-a');expect(ws.data()).toHaveLength(0);ws.end();expect(remote.canWrite('pi-a')).toBe(false);});
it('approval never auto-acquires, and a queued request never means approved',async()=>{
 const{remote,ws}=await setup();ws.business(presence('approval'));await expect(remote.ensureControl('pi-a')).rejects.toThrow('CONTROL_APPROVAL_REQUIRED');expect(ws.data()).toHaveLength(0);
 const request=remote.control('pi-a','acquire');const frame=ws.data().at(-1)!;ws.result(frame.requestId);await request;ws.business(presence('approval',[q]));expect(remote.canWrite('pi-a')).toBe(false);await expect(remote.ensureControl('pi-a')).rejects.toThrow('CONTROL_APPROVAL_REQUIRED');expect(ws.data()).toHaveLength(1);
 const lease={hostId:'pi-a',holder:testPeerId,userId:'alice',name:'Alice',expiresAt:Date.now()+30000,approvalId:q.id};ws.business(presence('approval',[{...q,state:'approved'}],[lease]));expect(remote.canWrite('pi-a')).toBe(true);expect(remote.canWrite('pi-b')).toBe(false);expect(ws.data()).toHaveLength(1);
 ws.business(presence('approval',[{...q,state:'revoked'}]));expect(remote.canWrite('pi-a')).toBe(false);expect(remote.canManage()).toBe(false);await expect(remote.control('pi-a','acquire',true)).rejects.toThrow('FORBIDDEN');
});
it('cancellation sends exactly the own active application identifier',async()=>{const{remote,ws}=await setup();ws.business(presence('approval',[q]));const pending=remote.cancelControl('pi-a',q.id);const frame=ws.data().at(-1)!;expect(frame).toMatchObject({action:'cancel',applicationId:q.id,hostId:'pi-a'});ws.result(frame.requestId);await pending;await expect(remote.cancelControl('pi-b',q.id)).rejects.toThrow('CONTROL_REQUEST_GONE');expect(ws.data()).toHaveLength(1);});
it('rejects conflicting, foreign, duplicated and falsely disabled presence',()=>{
 expect(()=>parsePresence(presence('approval',[{...q,applicant:'z'.repeat(43)}]),info)).toThrow();expect(()=>parsePresence(presence('approval',[q,q]),info)).toThrow();expect(()=>parsePresence(presence('approval',[{...q,room:'private'}]),info)).toThrow();expect(()=>parsePresence(presence('disabled',[q]),info)).toThrow();expect(()=>parsePresence(presence('unrecognized'),info)).toThrow();
 expect(()=>parseOwnerControl({version:1,enabled:false,revision:1,requestLifetimeSeconds:90,requests:[q],leases:[]})).toThrow();expect(parseOwnerControl({version:1,enabled:false,revision:1,requestLifetimeSeconds:90,requests:[],leases:[]}).enabled).toBe(false);
});
