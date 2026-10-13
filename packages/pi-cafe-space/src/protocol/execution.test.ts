import { expect, it } from 'vitest';
import fixture from '../../protocol/fixtures/execution/lifecycle.json';
import { applyEvent, decodeWireMessage, type EventEnvelope, type SessionSnapshot } from './index.js';
import { canonicalExecution, isExecutionState, type ExecutionState } from './execution.js';
const working:ExecutionState={version:1,runId:'r1',activity:'working',outcome:'none'};
it('shares lifecycle and immutable reconnect projection with Go',()=>{
 let snapshot=fixture.initial as SessionSnapshot;
 for(const raw of fixture.events){const event=decodeWireMessage(JSON.stringify(raw)) as EventEnvelope;const previous=snapshot,before=JSON.stringify(previous),eventBefore=JSON.stringify(event);snapshot=applyEvent(snapshot,event);expect(JSON.stringify(previous)).toBe(before);expect(JSON.stringify(event)).toBe(eventBefore);if(raw.seq===2)expect(snapshot.execution).toMatchObject({activity:'waiting',waitKind:'confirm'});}
 expect(snapshot).toEqual(fixture.expectedFinal);expect(decodeWireMessage(JSON.stringify({type:'snapshot',hostId:'host-a',snapshot}))).toEqual({type:'snapshot',hostId:'host-a',snapshot});
 const legacy={...fixture.events[4],seq:6,event:{kind:'session_state',phase:'idle',hasPendingMessages:false}};snapshot=applyEvent(snapshot,decodeWireMessage(JSON.stringify(legacy)) as EventEnvelope);expect(snapshot.execution).toBeUndefined();
});
it('rejects invalid combinations and bounded numeric fields',()=>{
 const invalid:unknown[]=[{...working,version:2},{...working,runId:'bad\n'},{...working,outcome:'completed'},{...working,activity:'idle',runId:null,outcome:'completed'},{...working,waitKind:'confirm'},{...working,activity:'waiting',waitKind:'login-password'},{...working,activity:'retrying',attempt:0},{...working,activity:'retrying',attempt:3,maxAttempts:2},{...working,activity:'retrying',delayMs:86400001},{...working,activity:'compacting',reason:'arbitrary'}];
 for(const value of invalid){expect(isExecutionState(value)).toBe(false);expect(()=>decodeWireMessage(JSON.stringify({type:'snapshot',snapshot:{...fixture.initial,execution:value}}))).toThrow();}
});
it('whitelists execution metadata, deep copies it and preserves sequence/scope checks',()=>{
 const raw={...working,token:'not-forwarded',title:'not-forwarded',errorMessage:'not-forwarded'};expect(canonicalExecution(raw)).toEqual(working);
 const start=fixture.initial as SessionSnapshot;const event=decodeWireMessage(JSON.stringify(fixture.events[0])) as EventEnvelope;
 const before=JSON.stringify(start),next=applyEvent(start,event);expect(JSON.stringify(start)).toBe(before);if(event.event.kind==='session_state')event.event.execution!.activity='idle';expect(next.execution?.activity).toBe('working');
 expect(()=>applyEvent(next,{...event,sessionId:'another',seq:2})).toThrow();expect(()=>applyEvent(next,{...event,seq:3})).toThrow();
});
