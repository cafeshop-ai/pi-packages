import type { ExtensionContext, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import type { CafeConfig } from './cafe-client.js';
import { requestCafeApprovals, type CafeApprovals, type CafeDecision } from './cafe-owner-client.js';

type ApprovalClient = (config: CafeConfig, action: CafeDecision, signal?: AbortSignal) => Promise<CafeApprovals>;
export class CafeApprovalController {
  #abort = new AbortController(); #timer: ReturnType<typeof setTimeout> | undefined;
  #generation=0; #seen=new Map<string,number>();
  constructor(private readonly config:()=>CafeConfig, private readonly client:ApprovalClient=requestCafeApprovals) {}
  start(ctx:ExtensionContext):void {
    this.stop();if(ctx.mode!=='tui'||!ctx.hasUI)return;
    this.#abort=new AbortController();const signal=this.#abort.signal,generation=this.#generation;
    const tick=async()=>{
      let wait=8000;
      try{
        const state=await this.client(this.config(),{operation:'status'},signal);
        if(signal.aborted||generation!==this.#generation)return;
        const now=Date.now();for(const[id,expiry]of this.#seen)if(expiry<now)this.#seen.delete(id);
        const pending=state.requests.filter(q=>q.expiresAt>now);
        const fresh=pending.filter(q=>!this.#seen.has(q.id));
        for(const q of pending)this.#seen.set(q.id,q.expiresAt+60000);
        while(this.#seen.size>128)this.#seen.delete(this.#seen.keys().next().value!);
        if(fresh.length)ctx.ui.notify(`Café Space · ${fresh[0]!.name}${fresh.length>1?` 等${fresh.length}位访客`:''}申请操作当前 Pi · /cafe approvals`,'info');
      }catch{wait=15000;/* Optional background hint must not spam or interrupt Pi. */}
      if(!signal.aborted&&generation===this.#generation){this.#timer=setTimeout(()=>void tick(),wait);this.#timer.unref();}
    };
    this.#timer=setTimeout(()=>void tick(),2000);this.#timer.unref();
  }
  stop():void { this.#generation++;this.#abort.abort();clearTimeout(this.#timer);this.#timer=undefined; }
  async open(ctx:ExtensionCommandContext):Promise<void>{
    if(ctx.mode!=='tui'||!ctx.hasUI)return;
    if(this.#abort.signal.aborted)this.#abort=new AbortController();
    const signal=this.#abort.signal,generation=this.#generation;
    try{
      for(;;){
        const config=this.config(),state=await this.client(config,{operation:'status'},signal);
        if(signal.aborted||generation!==this.#generation)return;
        if(!state.enabled){ctx.ui.notify('Café Space · 房间审批未开启，访客无需申请。开关在本机网页的分享房间 → 房间设置。','info');return;}
        const pending=state.requests.filter(q=>q.expiresAt>Date.now());
        if(!pending.length){ctx.ui.notify('Café Space · 当前 Pi 暂无待审批申请。','info');return;}
        const labels=pending.map((q,i)=>`${i+1}. ${q.name} · 申请 ${q.id.slice(0,8)}`);
        const chosen=await ctx.ui.select('Café Space · 当前 Pi 的控制权申请',[...labels,'返回 Pi'],{signal});
        if(signal.aborted||generation!==this.#generation)return;
        const index=labels.indexOf(chosen??'');if(index<0)return;const application=pending[index]!;
        const action=await ctx.ui.select(`${application.name} · 选择操作`,['批准此申请','拒绝此申请','返回'],{signal});
        if(signal.aborted||generation!==this.#generation)return;
        if(action!=='批准此申请'&&action!=='拒绝此申请'){if(!action)return;continue;}
        const approved=action==='批准此申请';
        const yes=await ctx.ui.confirm(approved?'批准控制当前 Pi':'拒绝控制申请',`${application.name}\n申请编号：${application.id.slice(0,8)}\n${approved?'允许对当前 Pi 发送任务、打断和修改会话；不会自动发送草稿。':'拒绝本次申请，不影响当前任务。'}`,{signal});
        if(signal.aborted||generation!==this.#generation)return;if(!yes)continue;
        const latest=await this.client(config,{operation:'status'},signal);
        if(signal.aborted||generation!==this.#generation)return;
        const current=latest.requests.find(q=>q.id===application.id&&q.name===application.name&&q.hostId===application.hostId&&q.expiresAt>Date.now());
        if(!latest.enabled||latest.revision!==state.revision||!current){ctx.ui.notify('Café Space · 申请或房间设置已变化，没有提交决定，请重新查看。','warning');continue;}
        await this.client(config,{operation:approved?'approve':'deny',revision:latest.revision,applicationId:current.id},signal);
        if(signal.aborted||generation!==this.#generation)return;
        ctx.ui.notify(`Café Space · 已${approved?'批准':'拒绝'} ${current.name} 对当前 Pi 的申请。`,'info');
      }
    }catch(error){
      if(signal.aborted||generation!==this.#generation)return;
      const code=error instanceof Error?error.message:'';
      const message:Record<string,string>={RESULT_UNKNOWN:'审批结果未确认，勿重复提交；请重新打开 /cafe approvals 或在本机网页核对。',TERMINAL_APPROVAL_UPDATE_REQUIRED:'网关尚未支持终端审批，请更新网关或暂时使用本机网页。',LOCAL_OWNER_REQUIRED:'需要本机房主凭据；仅持有 Pi 连接凭据不能审批。',UNAUTHORIZED:'本机房主认证未通过，没有修改授权。',CONTROL_BUSY:'另一访客正持有此 Pi 控制权，请先在本机网页撤销旧授权。',CONTROL_REQUEST_GONE:'申请已处理或已撤回，没有重复审批。',CONTROL_REQUEST_EXPIRED:'申请已过期，没有授予控制权。',HOST_NOT_READY:'当前 Pi 或申请访客已离线，没有批准。',ROOM_CONTROL_CHANGED:'房间设置已变化，请重新查看申请。'};
      ctx.ui.notify('Café Space · '+(message[code]??'无法读取审批状态，请检查网关或使用本机网页。'),'warning');
    }
  }
}
