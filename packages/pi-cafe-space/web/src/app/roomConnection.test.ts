/// <reference types="node" />
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { AppOwner } from './owner';
import { RemoteAccess } from '../services/remote/RemoteAccess';
import { createRelayStorage } from '../services/relay/storage';
const key = 'B' + 'A'.repeat(86);
class WS {
  readyState=0; bufferedAmount=0;
  onopen:(()=>void)|null=null; onmessage:((e:{data:string})=>void)|null=null; onerror:(()=>void)|null=null; onclose:((e:{code:number})=>void)|null=null;
  send(){} close(){this.readyState=3;}
}
const owners: AppOwner[]=[];
afterEach(()=>{for(const owner of owners)owner.dispose();owners.length=0;vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function setup(factory:()=>WebSocket){
  vi.stubGlobal('crypto',webcrypto);
  const remote=new RemoteAccess({socketOptions:{origin:'http://localhost',socketFactory:factory,peerFactory:()=>({}) as RTCPeerConnection}});
  const owner=new AppOwner({remote,storage:createRelayStorage(()=>{throw Error('isolated');}),http:{config:async()=>({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',roomAccess:true,remoteAccess:true})}});
  owners.push(owner);await owner.initialize();return owner;
}
it('synchronous socket construction failure stops with a useful error rather than endless connection lost',async()=>{
  vi.useFakeTimers();const factory=vi.fn(()=>{throw Error('browser restrictions');});const owner=await setup(factory);
  owner.connectRoomLink(key,'TestPass42');
  expect(owner.client.getState().status).toBe('stopped');expect(owner.roomFailure).toBe('ROOM_SIGNAL_START_FAILED');
  await vi.advanceTimersByTimeAsync(120000);expect(factory).toHaveBeenCalledOnce();
});
it('unsupported browser capabilities stop before opening signaling or sending a password',async()=>{
  vi.useFakeTimers();const factory=vi.fn(()=>new WS() as unknown as WebSocket),owner=await setup(factory);
  vi.stubGlobal('crypto',{getRandomValues:()=>new Uint8Array(32)});
  owner.connectRoomLink(key,'TestPass42');expect(owner.roomFailure).toBe('ROOM_BROWSER_UNSUPPORTED');expect(owner.client.getState().status).toBe('stopped');expect(factory).not.toHaveBeenCalled();
});
it('WebSocket SecurityError is distinct and retains only safe initialization metadata',async()=>{
  vi.useFakeTimers();const factory=vi.fn(()=>{throw new DOMException('synthetic private URL and token','SecurityError');});const owner=await setup(factory);
  owner.connectRoomLink(key,'TestPass42');expect(owner.roomFailure).toBe('ROOM_SIGNAL_POLICY_DENIED');expect(owner.roomLastProgress?.initialization).toEqual({step:'websocket',exception:'SecurityError'});expect(JSON.stringify(owner.roomLastProgress)).not.toContain('synthetic private');
  await vi.advanceTimersByTimeAsync(60000);expect(factory).toHaveBeenCalledOnce();
});
it('secure random failure is not mislabeled as blocked WebSocket',async()=>{
  vi.useFakeTimers();const factory=vi.fn(()=>new WS() as unknown as WebSocket),owner=await setup(factory);
  vi.stubGlobal('crypto',{subtle:webcrypto.subtle,getRandomValues(){throw new DOMException('private detail','OperationError');}});
  owner.connectRoomLink(key,'TestPass42');expect(owner.roomFailure).toBe('ROOM_RANDOM_UNAVAILABLE');expect(owner.roomLastProgress?.initialization).toEqual({step:'random',exception:'OperationError'});expect(factory).not.toHaveBeenCalled();
});
it('visibility and online events do not destroy a connecting room',async()=>{
  vi.useFakeTimers();const factory=vi.fn(()=>new WS() as unknown as WebSocket),owner=await setup(factory);owner.connectRoomLink(key,'TestPass42');
  expect(owner.client.getState().status).toBe('connecting');const generation=owner.client.getState().generation;
  document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('online'));
  expect(factory).toHaveBeenCalledOnce();expect(owner.client.getState().generation).toBe(generation);
});
it('signal failure preserves safe diagnostics, stops initial retry, and permits an explicit new attempt',async()=>{
  vi.useFakeTimers();const sockets:WS[]=[];const factory=vi.fn(()=>{const ws=new WS();sockets.push(ws);return ws as unknown as WebSocket;});const owner=await setup(factory);
  owner.connectRoomLink(key,'TestPass42');sockets[0]!.onclose?.({code:1006});
  expect(owner.roomFailure).toBe('ROOM_SIGNAL_DISCONNECTED');expect(owner.roomLastProgress).toMatchObject({stage:'signaling',signalCloseCode:1006});expect(owner.client.getState().status).toBe('stopped');
  await vi.advanceTimersByTimeAsync(60000);expect(factory).toHaveBeenCalledOnce();
  owner.connectRoomLink(key,'TestPass42');expect(factory).toHaveBeenCalledTimes(2);expect(owner.roomFailure).toBeNull();
});
