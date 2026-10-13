import { expect, it } from 'vitest';
import { captureRoomTransport, roomPeerConfiguration, roomTransportFailure } from './roomTransport';
const servers:RTCIceServer[]=[{urls:['stun:server.example:3478','turn:server.example:3478?transport=udp','turn:server.example:3478?transport=tcp'],username:'ephemeral-user',credential:'synthetic-secret'},{urls:'turns:tls.example:443?transport=tcp',username:'u',credential:'c'}];
it('compatibility mode uses only provisioned TURN TCP routes and requires relay candidates',()=>{
 const before=JSON.stringify(servers),cfg=roomPeerConfiguration(servers,'relay-tcp');
 expect(cfg.iceTransportPolicy).toBe('relay');expect(cfg.iceServers).toEqual([{urls:['turn:server.example:3478?transport=tcp'],username:'ephemeral-user',credential:'synthetic-secret'},{urls:['turns:tls.example:443?transport=tcp'],username:'u',credential:'c'}]);expect(JSON.stringify(servers)).toBe(before);
 expect(roomPeerConfiguration(servers,'auto')).toEqual({iceServers:servers});
 expect(()=>roomPeerConfiguration([{urls:'stun:server.example:3478'}],'relay-tcp')).toThrow('ROOM_TCP_RELAY_UNAVAILABLE');
});
it('diagnostics contain standard states/codes but never arbitrary error text or addresses',()=>{
 const pc={iceConnectionState:'connected',connectionState:'connecting',sctp:{state:'connecting',transport:{state:'connecting'}}} as RTCPeerConnection;
 const dc={readyState:'closing'} as RTCDataChannel;
 const d=captureRoomTransport(pc,dc,'data-error',false,1234,{errorDetail:'dtls-failure',sctpCauseCode:12,sentAlert:40,receivedAlert:42,message:'PRIVATE-PASSWORD',name:'PRIVATE-ADDRESS',stack:'PRIVATE-KEY'});
 expect(d).toMatchObject({ice:'connected',dtls:'connecting',sctp:'connecting',channel:'closing',event:'data-error',elapsedMs:1234,channelOpened:false,errorDetail:'dtls-failure',sctpCauseCode:12,sentAlert:40,receivedAlert:42});
 expect(JSON.stringify(d)).not.toContain('PRIVATE');expect(roomTransportFailure(d)).toBe('ROOM_DTLS_FAILED');
});
it('invalid optional error values do not become diagnostic output',()=>{
 const d=captureRoomTransport(null,null,'data-error',false,0,{errorDetail:'private value',sctpCauseCode:-1,sentAlert:999,receivedAlert:'private'});
 expect(d).toEqual({event:'data-error',elapsedMs:0,ice:'unavailable',peer:'unavailable',dtls:'unavailable',sctp:'unavailable',channel:'unavailable',channelOpened:false});
 expect(()=>captureRoomTransport(null,null,'data-error',false,0,Object.defineProperty({},'errorDetail',{get(){throw Error('private');}}))).not.toThrow();
 expect(roomTransportFailure({...d,ice:'failed'})).toBe('ROOM_ICE_CONNECTION_FAILED');expect(roomTransportFailure({...d,dtls:'connected',sctp:'closed'})).toBe('ROOM_SCTP_FAILED');expect(roomTransportFailure(d)).toBe('ROOM_DATA_CHANNEL_FAILED');
});
