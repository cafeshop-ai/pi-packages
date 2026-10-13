import { canonicalExecution, isCompactionReason, isPromptKind, type CompactionReason, type ExecutionState, type PromptKind, type RunOutcome } from '../protocol/execution.js';

/** Observes public extension events only. It never dispatches, approves or retries work. */
export class ExecutionTracker {
  private state: ExecutionState = {version:1,runId:null,activity:'idle',outcome:'none'};
  private active = false;
  private settledOutcome: Exclude<RunOutcome,'none'> | null = null;
  private lastAssistant: Exclude<RunOutcome,'none'> | null = null;
  private boundary: Exclude<RunOutcome,'none'> | null = null;
  private waits: Array<PromptKind | undefined> = [];
  private compacting: {reason?:CompactionReason} | null = null;
  constructor(private readonly id: () => string) {}
  snapshot(): ExecutionState { return canonicalExecution(this.state); }
  reset(idle = true): void {
    this.active = !idle; this.settledOutcome=null; this.waits=[]; this.compacting=null; this.lastAssistant=null; this.boundary=null;
    this.state={version:1,runId:idle?null:this.id(),activity:idle?'idle':'working',outcome:'none'};
  }
  private paint(idle = !this.active): void {
    if (this.waits.length) {
      const kind=this.waits[this.waits.length-1];
      this.state={version:1,runId:this.state.runId,activity:'waiting',outcome:'none',...(kind?{waitKind:kind}:{})};
    } else if (this.compacting) {
      this.state={version:1,runId:this.state.runId,activity:'compacting',outcome:'none',...this.compacting};
    } else {
      this.state={version:1,runId:this.state.runId,activity:idle?'idle':'working',outcome:idle?(this.settledOutcome??this.state.outcome):'none'};
    }
  }
  begin(): void {
    // Automatic continuations may emit another agent_start before final settlement.
    if (!this.active) this.state={version:1,runId:this.id(),activity:'working',outcome:'none'};
    this.active=true; this.settledOutcome=null; this.lastAssistant=null; this.boundary=null; this.paint(false);
  }
  assistantStarted(): void { if (!this.active) this.begin(); this.lastAssistant=null; this.boundary=null; }
  assistantEnded(stopReason: unknown): void {
    if (!this.active) return;
    this.lastAssistant = stopReason==='error'?'error':stopReason==='aborted'?'aborted':stopReason==='stop'||stopReason==='length'?'completed':null;
  }
  beforeSettle(outcome: unknown): void {
    if (this.active && (outcome==='completed'||outcome==='error'||outcome==='aborted')) this.boundary=outcome;
  }
  settled(aborted: unknown): void {
    if (!this.active && this.settledOutcome!==null) return;
    const outcome = aborted===true ? 'aborted' : this.boundary ?? this.lastAssistant ?? 'unknown';
    this.state={version:1,runId:this.state.runId??this.id(),activity:'idle',outcome};
    this.active=false;this.settledOutcome=outcome;this.waits=[];this.compacting=null;this.lastAssistant=null;this.boundary=null;
  }
  wait(waiting: boolean, kind: unknown, idle: boolean): void {
    if (waiting) { if(this.waits.length>=16) this.waits.shift();this.waits.push(isPromptKind(kind)?kind:undefined); }
    else {
      const normalized=isPromptKind(kind)?kind:undefined;
      const index=normalized===undefined?this.waits.length-1:this.waits.lastIndexOf(normalized);
      if(index>=0)this.waits.splice(index,1);
    }
    this.paint(idle);
  }
  compactionStart(reason: unknown): void { this.compacting=isCompactionReason(reason)?{reason}:{};this.paint(); }
  compactionEnd(idle: boolean): void { this.compacting=null;this.paint(idle); }
  /** Recover activity after invalid callbacks without manufacturing a final result. */
  uncertain(idle: boolean): void {
    this.active=!idle;this.settledOutcome=null;this.waits=[];this.compacting=null;this.lastAssistant=null;this.boundary=null;
    this.state={version:1,runId:this.state.runId,activity:idle?'idle':'working',outcome:idle&&this.state.runId?'unknown':'none'};
  }
}
