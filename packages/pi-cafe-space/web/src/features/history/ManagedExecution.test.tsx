import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { PropsWithChildren } from 'react';
import type { AppOwner } from '../../app/owner';
import { useManagedSessions } from './ManagedSessions';
import { parseManagedInventory } from '../../services/http/workspace';
let state:any;
vi.mock('../../state/useCollabStore',()=>({useCollabStore:(_store:unknown,select:(s:any)=>unknown)=>select(state)}));
vi.mock('../../services/remote/useRemoteState',()=>({useRemoteState:()=>({enabled:false})}));
const id='11111111-1111-4111-8111-111111111111',hostId='managed-'+id;
const execution={version:1,runId:'rpc-run',activity:'retrying',outcome:'none',attempt:1,maxAttempts:3};
const inventory=()=>({projects:[{id:'project',room:'main',name:'Fixture',cwd:'/fixture'}],maxActive:8,sessions:[{id,projectId:'project',room:'main',hostId,name:'Example',status:'ready',execution}]});
const wrapper=({children}:PropsWithChildren)=><MemoryRouter>{children}</MemoryRouter>;
beforeEach(()=>{vi.useFakeTimers();state={connection:{status:'authenticated',roomId:'main',generation:1},viewGeneration:0,selectedHostId:hostId,hosts:new Map([[hostId,{stale:false,info:{connected:true,ready:true},snapshot:{streamId:'stream',sessionId:'session',lastEventSeq:1,phase:'running'}}]])};});
afterEach(()=>vi.useRealTimers());
function setup(workspace:any){const owner={store:{getSnapshot:()=>state},remote:{canManage:()=>true,canCloseManaged:()=>true},workspace} as unknown as AppOwner;return renderHook(()=>useManagedSessions(owner,'main','',true),{wrapper});}
it('an inventory response cannot override events that arrived while it was being fetched',async()=>{
 let finish!:(v:unknown)=>void;const workspace=vi.fn(()=>new Promise(r=>{finish=r;}));const h=setup(workspace);state.hosts.get(hostId).snapshot={streamId:'stream',sessionId:'session',lastEventSeq:2,phase:'idle'};h.rerender();await act(async()=>finish(inventory()));expect(h.result.current.observedExecution(hostId)).toBeUndefined();h.unmount();expect(vi.getTimerCount()).toBe(0);
});
it('fresh observations disappear on new event, read failure, disconnection or generation change',async()=>{
 const workspace=vi.fn().mockResolvedValue(inventory());const h=setup(workspace);await act(async()=>{});expect(h.result.current.observedExecution(hostId)?.activity).toBe('retrying');
 state.hosts.get(hostId).snapshot={...state.hosts.get(hostId).snapshot,lastEventSeq:2};h.rerender();expect(h.result.current.observedExecution(hostId)).toBeUndefined();
 await act(async()=>vi.advanceTimersByTimeAsync(3000));expect(h.result.current.observedExecution(hostId)?.activity).toBe('retrying');workspace.mockRejectedValueOnce(Error('offline'));await act(async()=>vi.advanceTimersByTimeAsync(3000));expect(h.result.current.observedExecution(hostId)).toBeUndefined();
 await act(async()=>vi.advanceTimersByTimeAsync(3000));expect(h.result.current.observedExecution(hostId)).toBeDefined();state={...state,connection:{...state.connection,status:'disconnected'}};h.rerender();expect(h.result.current.observedExecution(hostId)).toBeUndefined();h.unmount();expect(vi.getTimerCount()).toBe(0);
});
it('a late response from a previous connection is discarded and unmount aborts polling',async()=>{
 let finish!:(v:unknown)=>void;const signals:AbortSignal[]=[];const workspace=vi.fn((_request:unknown,signal:AbortSignal)=>{signals.push(signal);return new Promise(r=>{finish=r;});});const h=setup(workspace),old=finish;state={...state,connection:{...state.connection,generation:2}};h.rerender();await act(async()=>old(inventory()));expect(h.result.current.observedExecution(hostId)).toBeUndefined();expect(signals[0]!.aborted).toBe(true);h.unmount();expect(signals.every(s=>s.aborted)).toBe(true);
});
it('inventory validation strips unrelated execution fields and rejects contradictory state',()=>{const data=inventory();data.sessions[0]!.execution={...execution,token:'not-forwarded'} as any;expect(JSON.stringify(parseManagedInventory(data,'main'))).not.toContain('not-forwarded');data.sessions[0]!.execution={...execution,outcome:'completed'};expect(()=>parseManagedInventory(data,'main')).toThrow();});
