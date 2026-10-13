import { expect, it } from 'vitest';
import { RoomInitializationError, roomInitializationFailure, roomInitializationStep, type RoomInitStep } from './roomInitialization';

it.each<[RoomInitStep,string,string]>([
 ['random','OperationError','ROOM_RANDOM_UNAVAILABLE'],
 ['origin','TypeError','ROOM_INVALID_ORIGIN'],
 ['credentials','Error','INVALID_ROOM_CREDENTIALS'],
 ['websocket','SecurityError','ROOM_SIGNAL_POLICY_DENIED'],
 ['websocket','SyntaxError','ROOM_SIGNAL_START_FAILED'],
 ['runtime','TypeError','ROOM_INITIALIZATION_FAILED'],
])('classifies %s without retaining a sensitive error message', (step,name,code)=>{
 const secret='synthetic-password-and-private-url';const original=new Error(secret);original.name=name;
 const error=new RoomInitializationError(step,original);
 expect(roomInitializationFailure(error)).toEqual({code,diagnostic:{step,exception:name}});
 expect(error.message).not.toContain(secret);expect(JSON.stringify(error)).not.toContain(secret);expect('cause' in error).toBe(false);
});
it('does not expose arbitrary names or access throwing getters',()=>{
 for(const error of [{name:'password:private'},Object.defineProperty({},'name',{get(){throw Error('private');}}),'private']){
  expect(roomInitializationFailure(error)).toEqual({code:'ROOM_INITIALIZATION_FAILED',diagnostic:{step:'runtime',exception:'OtherError'}});
 }
});
it('preserves known missing-capability errors and successful initialization',()=>{
 expect(roomInitializationFailure(Error('ROOM_BROWSER_UNSUPPORTED')).code).toBe('ROOM_BROWSER_UNSUPPORTED');
 expect(roomInitializationStep('random',()=>42)).toBe(42);
 expect(()=>roomInitializationStep('websocket',()=>{throw new DOMException('untrusted detail','SecurityError');})).toThrow('ROOM_SIGNAL_POLICY_DENIED');
});
