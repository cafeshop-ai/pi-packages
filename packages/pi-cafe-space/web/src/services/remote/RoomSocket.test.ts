/// <reference types="node" />
import { webcrypto } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { RoomSocket } from './RoomSocket';
import { ChunkDecoder, encodeChunks } from './framing';
import { encodeRoomBase64, roomHash, roomNonce } from './roomCrypto';
class WS {
 readyState=0;bufferedAmount=0;sent:Record<string,unknown>[]=[];closed=false;
 onopen:(()=>void)|null=null;onmessage:((e:{data:string})=>void)|null=null;onerror:(()=>void)|null=null;onclose:((e:{code:number})=>void)|null=null;
 send(raw:string){this.sent.push(JSON.parse(raw));} close(){this.closed=true;this.readyState=3;}
 open(){this.readyState=1;this.onopen?.();} receive(value:object){this.onmessage?.({data:JSON.stringify(value)});}
}
class DC extends EventTarget {
 readyState='connecting';bufferedAmount=0;bufferedAmountLowThreshold=0;binaryType='';sent:ArrayBuffer[]=[];
 onopen:(()=>void)|null=null;onmessage:((e:{data:ArrayBuffer})=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;
 send(packet:ArrayBuffer){this.sent.push(packet);} close(){this.readyState='closed';}
 open(){this.readyState='open';this.onopen?.();}
}
class PC extends EventTarget {
 iceGatheringState='complete';connectionState='new';sctp={maxMessageSize:16384};localDescription:{sdp:string}|null=null;remoteCalls=0;dc=new DC();
 onconnectionstatechange:(()=>void)|null=null;
 createDataChannel(){return this.dc;} async createOffer(){return{type:'offer',sdp:'test offer'};}
 async setLocalDescription(offer:{sdp:string}){this.localDescription=offer;}
 async setRemoteDescription(){this.remoteCalls++;this.connectionState='connected';this.dc.open();}
 async getStats(){return new Map();} close(){this.connectionState='closed';}
}
const active:RoomSocket[]=[];
afterEach(()=>{for(const socket of active)socket.close();active.length=0;vi.unstubAllGlobals();vi.useRealTimers();});
async function fixture(){
 vi.stubGlobal('crypto',webcrypto);const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const room=encodeRoomBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey))),ws=new WS(),pc=new PC(),messages=vi.fn(),ended=vi.fn(),opened=vi.fn(),progress=vi.fn();
 const socket=new RoomSocket({roomKey:room,password:'123456',origin:'https://space.example',socketFactory:url=>{expect(url).toBe('wss://space.example/room/join');return ws as unknown as WebSocket;},peerFactory:()=>pc as unknown as RTCPeerConnection,onEnd:ended,onProgress:progress});active.push(socket);socket.onmessage=messages;socket.onopen=opened;
 ws.open();const nonce=String(ws.sent[0]!.nonce),id=roomNonce();ws.receive({type:'room_opened',id,roomKey:room,nonce,webRTC:true});
 await vi.waitFor(()=>expect(ws.sent.some(f=>f.type==='offer')).toBe(true));
 const offer=await roomHash('test offer'),sdp='test answer';const text=JSON.stringify(['cafe-room-answer-v1',room,id,nonce,offer,await roomHash(sdp)]);
 const signature=encodeRoomBase64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(text))));
 const answer={type:'answer',id,sdp,peerId:offer,signature};
 return{socket,ws,pc,messages,ended,opened,progress,room,id,nonce,answer};
}
it('authenticates the pinned endpoint before sending password only through DataChannel',async()=>{
 const f=await fixture();expect(f.pc.remoteCalls).toBe(0);expect(f.pc.dc.sent).toHaveLength(0);expect(f.socket.readyState).toBe(0);
 expect(()=>f.socket.send(JSON.stringify({type:'hello'}))).toThrow();
 f.ws.receive(f.answer);await vi.waitFor(()=>expect(f.pc.remoteCalls).toBe(1));
 f.ws.receive({type:'selected',id:f.id,mode:'webrtc'});await vi.waitFor(()=>expect(f.pc.dc.sent).toHaveLength(1));
 const decoder=new ChunkDecoder();const raw=decoder.push(f.pc.dc.sent[0]!);expect(JSON.parse(new TextDecoder().decode(raw!))).toEqual({type:'room.auth',id:f.id,nonce:f.nonce,password:'123456'});
 expect(JSON.stringify(f.ws.sent)).not.toContain('123456');expect(f.messages).not.toHaveBeenCalled();expect(f.opened).not.toHaveBeenCalled();
 const verified={type:'room.authenticated',id:f.id,roomKey:f.room,deviceId:'room',roomId:'main',userId:'guest-'+f.id,name:'Office',role:'operator',managed:false};
 for(const packet of encodeChunks(1,new TextEncoder().encode(JSON.stringify(verified))))f.pc.dc.onmessage?.({data:packet});
 expect(f.socket.readyState).toBe(1);expect(f.opened).toHaveBeenCalledOnce();
});
it('tampered answer fails before DTLS starts or password is sent',async()=>{
 const f=await fixture();f.ws.receive({...f.answer,sdp:'modified answer'});await vi.waitFor(()=>expect(f.ended).toHaveBeenCalledWith('ROOM_IDENTITY_FAILED'));
 expect(f.pc.remoteCalls).toBe(0);expect(f.pc.dc.sent).toHaveLength(0);expect(f.ws.closed).toBe(true);expect(JSON.stringify(f.ws.sent)).not.toContain('123456');
});
it('does not allow pre-auth inventory or silent cloud-relay fallback',async()=>{
 const f=await fixture();f.ws.receive(f.answer);await vi.waitFor(()=>expect(f.pc.remoteCalls).toBe(1));f.ws.receive({type:'selected',id:f.id,mode:'webrtc'});
 for(const packet of encodeChunks(1,new TextEncoder().encode(JSON.stringify({type:'host_status',hosts:[{hostId:'secret'}]}))))f.pc.dc.onmessage?.({data:packet});
 expect(f.ended).toHaveBeenCalledWith('INVALID_ROOM_DATA');expect(JSON.stringify(f.messages.mock.calls)).not.toContain('secret');
 expect(f.ws.sent.some(m=>m.type==='data'||m.mode==='relay')).toBe(false);
});
it.each([true,false])('bounded ICE gathering uses available candidates only: %s',async hasCandidate=>{
 vi.stubGlobal('crypto',webcrypto);const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);const room=encodeRoomBase64(new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey)));const nonceId=roomNonce();
 const ws=new WS(),pc=new PC(),ended=vi.fn();pc.iceGatheringState='gathering';pc.createOffer=async()=>({type:'offer',sdp:hasCandidate?'v=0\r\na=candidate:1 1 UDP 1 127.0.0.1 12345 typ host\r\n':'v=0\r\n'});
 vi.useFakeTimers();const socket=new RoomSocket({roomKey:room,password:'123456',origin:'https://space.example',socketFactory:()=>ws as unknown as WebSocket,peerFactory:()=>pc as unknown as RTCPeerConnection,onEnd:ended});active.push(socket);ws.open();ws.receive({type:'room_opened',id:nonceId,roomKey:room,nonce:ws.sent[0]!.nonce,webRTC:true});
 await vi.advanceTimersByTimeAsync(0);await vi.advanceTimersByTimeAsync(8000);
 if(hasCandidate)await vi.waitFor(()=>expect(ws.sent.some(f=>f.type==='offer')).toBe(true));else expect(ended).toHaveBeenCalledWith('ROOM_ICE_NO_CANDIDATE');
 expect(pc.dc.sent).toHaveLength(0);expect(JSON.stringify(ws.sent)).not.toContain('123456');
});
it('later signaling failure does not claim the room password was never sent',async()=>{
 const f=await fixture();f.ws.receive(f.answer);await vi.waitFor(()=>expect(f.pc.remoteCalls).toBe(1));f.ws.receive({type:'selected',id:f.id,mode:'webrtc'});await vi.waitFor(()=>expect(f.pc.dc.sent).toHaveLength(1));
 f.ws.receive({type:'answer',id:'invalid-session'});
 expect(f.ended).toHaveBeenCalledWith('ROOM_PROTOCOL_ERROR');expect(f.ended).not.toHaveBeenCalledWith('ROOM_IDENTITY_FAILED');
});
it('allows maxMessageSize zero as unlimited instead of rejecting a valid mobile channel',async()=>{
 const f=await fixture();f.pc.sctp.maxMessageSize=0;f.ws.receive(f.answer);await vi.waitFor(()=>expect(f.pc.remoteCalls).toBe(1));expect(f.ws.sent.some(m=>m.type==='select')).toBe(true);expect(f.ended).not.toHaveBeenCalled();
});
it('pre-auth DataChannel error preserves its transport cause and is not a wrong-password result',async()=>{
 const f=await fixture(),closed=vi.fn();f.socket.onclose=closed;
 Object.assign(f.pc,{iceConnectionState:'connected'});Object.assign(f.pc.sctp,{state:'connecting',transport:{state:'failed'}});
 (f.pc.dc.onerror as unknown as (e:unknown)=>void)({error:{errorDetail:'dtls-failure',sentAlert:40,message:'private detail'}});
 expect(f.ended).toHaveBeenCalledWith('ROOM_DTLS_FAILED');expect(f.messages).not.toHaveBeenCalled();expect(closed).toHaveBeenCalledOnce();expect(f.pc.dc.sent).toHaveLength(0);
 const final=f.progress.mock.calls.at(-1)![0];expect(final.transport).toMatchObject({ice:'connected',dtls:'failed',sctp:'connecting',channelOpened:false,errorDetail:'dtls-failure',sentAlert:40});expect(JSON.stringify(final)).not.toContain('private detail');
 const count=f.progress.mock.calls.length;f.pc.dispatchEvent(new Event('connectionstatechange'));expect(f.progress).toHaveBeenCalledTimes(count);
});
it('plain early data-channel close no longer injects UNAUTHORIZED',async()=>{
 const f=await fixture(),closed=vi.fn();f.socket.onclose=closed;f.pc.dc.onclose?.();expect(f.ended).toHaveBeenCalledWith('ROOM_DATA_CHANNEL_FAILED');expect(f.messages).not.toHaveBeenCalled();expect(closed).toHaveBeenCalledOnce();
});
it('actual room.denied still reports an authentication rejection',async()=>{
 const f=await fixture();f.ws.receive(f.answer);await vi.waitFor(()=>expect(f.pc.remoteCalls).toBe(1));f.ws.receive({type:'selected',id:f.id,mode:'webrtc'});
 for(const packet of encodeChunks(1,new TextEncoder().encode(JSON.stringify({type:'room.denied'}))))f.pc.dc.onmessage?.({data:packet});
 expect(f.ended).toHaveBeenCalledWith('ROOM_PASSWORD_REJECTED');expect(JSON.parse(f.messages.mock.calls.at(-1)![0].data).code).toBe('UNAUTHORIZED');
});
it.each(['ROOM_PASSWORD_REJECTED','ROOM_AUTH_BUSY','ROOM_AUTH_RATE_LIMITED','ROOM_ACCESS_CHANGED','ROOM_ACCOUNT_IDENTITY_FAILED','UNRECOGNIZED'])('keeps an explicit room denial distinct: %s',async code=>{
 const f=await fixture();f.ws.receive(f.answer);await vi.waitFor(()=>expect(f.pc.remoteCalls).toBe(1));f.ws.receive({type:'selected',id:f.id,mode:'webrtc'});
 for(const packet of encodeChunks(1,new TextEncoder().encode(JSON.stringify({type:'room.denied',code,retryAfterSeconds:1}))))f.pc.dc.onmessage?.({data:packet});
 expect(f.ended).toHaveBeenCalledExactlyOnceWith(code==='UNRECOGNIZED'?'ROOM_PROTOCOL_ERROR':code);
 if(code!=='ROOM_PASSWORD_REJECTED')expect(f.messages).not.toHaveBeenCalled();
});
it('offline room ends in a clear error without submitting a password',async()=>{
 const f=await fixture();f.ws.onclose?.({code:4004});expect(f.ended).toHaveBeenCalledWith('ROOM_OFFLINE');expect(f.pc.dc.sent).toHaveLength(0);
});
