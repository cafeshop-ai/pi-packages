import type { ExecutionState, PromptKind } from '../../../../../src/protocol/execution';

export type ExecutionLabelKind = 'thinking'|'responding'|'tool'|'working'|'waiting'|'offline'|'compacting'|'retrying'|'completed'|'aborted'|'error'|'unknown'|null;
export interface ActivityView { kind:ExecutionLabelKind; tool?:string; waitKind?:PromptKind; attempt?:number; maxAttempts?:number; source?:'rpc' }
export function executionLabel(view:ActivityView,zh:boolean):string {
 const labels=zh?{thinking:'正在思考',responding:'正在回复',tool:'正在执行',working:'正在处理',waiting:'等待办公电脑上的操作',offline:'连接已中断，状态暂未更新',compacting:'正在整理上下文',retrying:'等待自动重试',completed:'本轮已结束',aborted:'本轮已取消',error:'本轮执行失败',unknown:'本轮结果未确认'}:{thinking:'Thinking',responding:'Responding',tool:'Running',working:'Working',waiting:'Waiting on the office computer',offline:'Disconnected · status is not live',compacting:'Compacting context',retrying:'Waiting to retry',completed:'Run finished',aborted:'Run cancelled',error:'Run failed',unknown:'Run outcome unconfirmed'};
 if(!view.kind)return '';
 if(view.kind==='waiting'&&view.waitKind){const prompt=zh?{confirm:'等待办公电脑确认',select:'等待办公电脑选择',input:'等待办公电脑输入',editor:'等待办公电脑编辑',custom:'等待办公电脑上的操作'}:{confirm:'Waiting for local confirmation',select:'Waiting for local selection',input:'Waiting for local input',editor:'Waiting for local editing',custom:'Waiting for local interaction'};return prompt[view.waitKind];}
 const retry=view.kind==='retrying'&&view.attempt?` · ${view.attempt}${view.maxAttempts?'/'+view.maxAttempts:''}`:'';
 return labels[view.kind]+retry;
}
export function executionView(state:ExecutionState):ActivityView {
 if(state.activity==='idle')return {kind:state.outcome==='none'?null:state.outcome};
 return {kind:state.activity, ...(state.waitKind?{waitKind:state.waitKind}:{}), ...(state.attempt?{attempt:state.attempt}:{}), ...(state.maxAttempts?{maxAttempts:state.maxAttempts}:{})};
}
export function isLiveActivity(kind:ExecutionLabelKind):boolean {return kind!==null&&['thinking','responding','tool','working','waiting','compacting','retrying'].includes(kind);}
