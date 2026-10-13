import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SessionSnapshot } from '../../../../../src/protocol/index';
import styles from './Conversation.module.scss';
import { CoffeeActivityMark } from './CoffeeActivityMark';
import { executionLabel, executionView, isLiveActivity, type ActivityView, type ExecutionLabelKind } from './executionPresentation';

export type AgentActivityKind = ExecutionLabelKind;
function lastMatch<T>(items: T[], match: (item: T) => boolean): T | undefined { for (let i = items.length - 1; i >= 0; i--) if (match(items[i]!)) return items[i]; return undefined; }
export function agentActivity(snapshot: SessionSnapshot, connected = true): ActivityView {
  if (!connected) return { kind: snapshot.execution || snapshot.phase === 'running' || snapshot.phase === 'waiting_local_ui' ? 'offline' : null };
  const execution=snapshot.execution;
  if (snapshot.phase === 'waiting_local_ui' || execution?.activity==='waiting') return { kind: 'waiting', ...(execution?.waitKind?{waitKind:execution.waitKind}:{}) };
  if (execution?.activity==='compacting') return {kind:'compacting'};
  if (snapshot.phase === 'idle') return execution?.activity==='idle'?executionView(execution):{kind:null};
  // Chat uses the Pi extension's ordered stream only. Independent managed RPC
  // observations remain in the instance list and cannot override this run.
  if (execution?.activity==='retrying') return executionView(execution);
  const tool = lastMatch(snapshot.tools, item => item.status === 'running');
  if (tool) return { kind: 'tool', tool: tool.toolName.slice(0, 64) };
  const message = lastMatch(snapshot.messages, item => item.role === 'assistant' && item.status === 'streaming');
  const last = message?.parts?.at(-1);
  if (last?.type === 'thinking' || !message?.parts && message?.thinking && !message.text) return { kind: 'thinking' };
  if (last?.type === 'text' && last.text || message?.text) return { kind: 'responding' };
  return { kind: 'working' };
}
export function AgentActivity({ snapshot, connected = true }: { snapshot: SessionSnapshot; connected?: boolean }) {
  const { i18n } = useTranslation(), zh = i18n.language.startsWith('zh');
  const activity = agentActivity(snapshot, connected);
  const active = isLiveActivity(activity.kind);
  const observationKey=snapshot.execution?.runId??snapshot.streamId;
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    setSeconds(0); if (!active) return;
    const started = Date.now(); const timer = setInterval(() => setSeconds(Math.max(0, Math.floor((Date.now() - started) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [active, observationKey, snapshot.sessionId]);
  if (!activity.kind) return null;
  const text=executionLabel(activity,zh);
  const hint=!active&&activity.kind!=='offline'?(zh?'仅表示Pi本轮生命周期结果，不等于任务目标已验收':'Pi run lifecycle outcome, not verification that the task goal was achieved'):undefined;
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <div className={styles.activity} data-activity={activity.kind} data-result={!active && activity.kind!=='offline'} title={hint}>
    <CoffeeActivityMark steaming={active && activity.kind !== 'waiting' && activity.kind !== 'retrying'} />
    <span role="status" aria-live="polite" className={styles.activityLabel}>{text}{activity.tool && <code>{activity.tool}</code>}</span>
    {active && seconds > 0 && <small aria-hidden="true" title={zh ? '从本次观察开始计时，不是计费时间' : 'Time since this activity was observed, not billing duration'}>{elapsed}</small>}
  </div>;
}
