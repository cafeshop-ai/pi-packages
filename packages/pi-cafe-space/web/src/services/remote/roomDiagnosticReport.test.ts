import { expect, it } from 'vitest';
import type { RoomProgress } from './RoomSocket';
import { roomDiagnosticReport } from './roomDiagnosticReport';
it('copies the observed SCTP failure without pretending to know the missing cause',()=>{
 const progress:RoomProgress={stage:'transport',localRelay:true,remoteRelay:true,iceErrorCode:null,signalCloseCode:null,policy:'relay-tcp',transport:{event:'data-error',elapsedMs:14400,ice:'connected',peer:'closed',dtls:'closed',sctp:'closed',channel:'closing',channelOpened:false,errorDetail:'sctp-failure'}};
 const v=JSON.parse(roomDiagnosticReport('ROOM_SCTP_FAILED','stopped',progress));expect(v).toMatchObject({error:'ROOM_SCTP_FAILED',mode:'TURN/TCP',stage:'transport',transport:{elapsedMs:14400,dtls:'closed',sctp:'closed',sctpCauseCode:null,errorDetail:'sctp-failure'}});
});
it('never serializes unapproved fields or arbitrary string values',()=>{
 const privateValue='https://private.invalid/#/room/secret';
 const progress={stage:privateValue,localRelay:true,remoteRelay:false,policy:privateValue,iceErrorCode:privateValue,signalCloseCode:privateValue,password:'SECRET_TYPED',roomKey:'PRIVATE_KEY',transport:{event:privateValue,elapsedMs:Infinity,ice:privateValue,peer:privateValue,dtls:privateValue,sctp:privateValue,channel:privateValue,errorDetail:privateValue,sctpCauseCode:privateValue,message:'PRIVATE_MESSAGE'},initialization:{step:privateValue,exception:privateValue}} as unknown as RoomProgress;
 const text=roomDiagnosticReport('SECRET_TYPED','PRIVATE_MESSAGE',progress);for(const secret of [privateValue,'SECRET_TYPED','PRIVATE_KEY','PRIVATE_MESSAGE'])expect(text).not.toContain(secret);expect(JSON.parse(text).error).toBe('UNKNOWN_ERROR');
});
it('allows an empty diagnostic while an attempt has not started',()=>{expect(JSON.parse(roomDiagnosticReport(null,'stopped',null)).transport).toBeUndefined();});
