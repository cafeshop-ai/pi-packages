import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { CafeApprovalController } from './cafe-approvals.js';
import type { CafeApprovals, CafeDecision } from './cafe-owner-client.js';
const config={relayUrl:'ws://127.0.0.1:37891/ws',roomId:'main',peerId:'pi-a',token:'test',credentialsFile:null};
const context=()=>({mode:'tui',hasUI:true,ui:{notify:vi.fn(),select:vi.fn(),confirm:vi.fn()}});
const state=():CafeApprovals=>({version:1,enabled:true,revision:2,hostId:'pi-a',requests:[{id:'a'.repeat(43),name:'拿铁#1234abcd',hostId:'pi-a',expiresAt:Date.now()+90000}]});
afterEach(()=>{vi.useRealTimers();});
it('new requests notify once, repeated polls never approve, stop clears all timers',async()=>{
 vi.useFakeTimers();const value=state(),client=vi.fn(async()=>value),ctx=context(),controller=new CafeApprovalController(()=>config,client);
 controller.start(ctx as unknown as ExtensionCommandContext);await vi.advanceTimersByTimeAsync(18000);expect(ctx.ui.notify).toHaveBeenCalledOnce();expect(ctx.ui.notify.mock.calls[0]?.[0]).toContain('/cafe approvals');expect(client.mock.calls.length).toBeGreaterThan(1);controller.stop();expect(vi.getTimerCount()).toBe(0);
});
it.each([true,false])('approve/deny requires explicit final human confirmation: approve=%s',async approve=>{
 let value=state();const effects:CafeDecision[]=[];const client=vi.fn(async(_c:unknown,action:CafeDecision)=>{effects.push(action);if(action.operation!=='status')value={...value,requests:[]};return value;});const ctx=context();ctx.ui.select.mockImplementationOnce(async(_title,choices)=>choices[0]).mockResolvedValueOnce(approve?'批准此申请':'拒绝此申请');ctx.ui.confirm.mockResolvedValue(true);const controller=new CafeApprovalController(()=>config,client);
 await controller.open(ctx as unknown as ExtensionCommandContext);expect(ctx.ui.confirm).toHaveBeenCalledOnce();expect(effects.filter(a=>a.operation!=='status')).toEqual([{operation:approve?'approve':'deny',revision:2,applicationId:'a'.repeat(43)}]);controller.stop();
});
it('cancel or changed request never commits a decision',async()=>{
 const initial=state();let count=0;const effects:CafeDecision[]=[];const client=vi.fn(async(_c:unknown,action:CafeDecision)=>{effects.push(action);return ++count===1?initial:{...initial,requests:[]};});const ctx=context();ctx.ui.select.mockImplementationOnce(async(_t,c)=>c[0]).mockResolvedValueOnce('批准此申请');ctx.ui.confirm.mockResolvedValue(true);const controller=new CafeApprovalController(()=>config,client);await controller.open(ctx as unknown as ExtensionCommandContext);expect(effects.every(a=>a.operation==='status')).toBe(true);expect(ctx.ui.notify.mock.calls.some(c=>c[0].includes('已变化'))).toBe(true);controller.stop();
});
it('unknown result is not retried and RPC cannot perform approvals',async()=>{
 const initial=state();let writes=0;const client=vi.fn(async(_c:unknown,action:CafeDecision)=>{if(action.operation!=='status'){writes++;throw Error('RESULT_UNKNOWN');}return initial;});const ctx=context();ctx.ui.select.mockImplementationOnce(async(_t,c)=>c[0]).mockResolvedValueOnce('批准此申请');ctx.ui.confirm.mockResolvedValue(true);const controller=new CafeApprovalController(()=>config,client);await controller.open(ctx as unknown as ExtensionCommandContext);expect(writes).toBe(1);expect(ctx.ui.notify.mock.calls.at(-1)?.[0]).toContain('勿重复提交');client.mockClear();await controller.open({...ctx,mode:'rpc'} as unknown as ExtensionCommandContext);expect(client).not.toHaveBeenCalled();controller.stop();
});
it('declining the final confirmation preserves the pending request',async()=>{const initial=state(),client=vi.fn(async()=>initial),ctx=context();ctx.ui.select.mockImplementationOnce(async(_t,c)=>c[0]).mockResolvedValueOnce('批准此申请').mockResolvedValueOnce(undefined);ctx.ui.confirm.mockResolvedValue(false);const controller=new CafeApprovalController(()=>config,client);await controller.open(ctx as unknown as ExtensionCommandContext);expect(client.mock.calls).toHaveLength(2);expect(ctx.ui.notify).not.toHaveBeenCalled();controller.stop();});
