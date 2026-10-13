import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isThinkingLevel, type CommandPayload } from '../../../../src/protocol/index';
import type { AppOwner } from '../../app/owner';
import { useCollabStore } from '../../state/useCollabStore';
import styles from './ModelControls.module.scss';
import { Icon } from '../../components/ui/Icon';
import { Button, Input } from '../../components/ui/Controls';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/shadcn/field';
export function ModelControls({ owner, readOnly, expanded = false }: { owner: AppOwner; readOnly: boolean; expanded?: boolean }) {
  const id = useId();
  const { t, i18n } = useTranslation(); const zh = i18n.language.startsWith('zh'); const state = useCollabStore(owner.store, s => s);
  const scope = owner.store.scope(); const host = state.selectedHostId ? state.hosts.get(state.selectedHostId) : undefined;
  const snapshot = host?.snapshot;
  const thinkingDisabled = snapshot?.model?.reasoning === false;
  const reportedLevels = snapshot?.model?.thinkingLevels;
  const availableLevels = thinkingDisabled ? ['off'] : reportedLevels ?? ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const currentLevel = snapshot?.thinkingLevel ?? 'off';
  const choices = availableLevels.includes(currentLevel) ? availableLevels : [currentLevel, ...availableLevels];
  const enabled = !readOnly && state.connection.status === 'authenticated' && !!scope && !!host && !host.stale && host.info.connected && host.info.ready !== false;
  const [provider, setProvider] = useState(snapshot?.model?.provider ?? ''); const [model, setModel] = useState(snapshot?.model?.id ?? '');
  const [resultCode, setResultCode] = useState('');
  const [busy, setBusy] = useState(false); const latch = useRef(false); const active = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async (payload: CommandPayload) => {
    if (!enabled || !scope || latch.current) return;
    latch.current = true; setBusy(true); setResultCode('');
    try { const result = await owner.execute(payload, scope); if (active.current && (result.status === 'unknown' || result.status === 'rejected')) setResultCode(result.code ?? 'COMMAND_ERROR'); }
    catch { if (active.current) setResultCode('RESULT_UNKNOWN'); }
    finally { latch.current = false; if (active.current) setBusy(false); }
  };
  return <details className={styles.controls} open={expanded || undefined}><summary><Icon name="settings" />{t('modelSettings')}</summary>
    <p>{t('currentModel')}: {snapshot?.model ? `${snapshot.model.provider}/${snapshot.model.id}` : '—'}</p>
    <ChoiceSelect label={t('thinking')} value={snapshot?.thinkingLevel ?? 'off'} disabled={!enabled || busy || thinkingDisabled || availableLevels.length < 2}
      items={choices.map(level => ({ value: level, label: level }))}
      onValueChange={level => { if (isThinkingLevel(level)) void run({ name: 'set_thinking', level }); }} />
    {thinkingDisabled && <p role="status">{zh ? '当前 Pi 模型配置禁用了思考（reasoning: false），不能切换强度。请在本机核对模型配置后重新加载；这不代表该系列模型本身不支持思考。' : 'This Pi model configuration disables reasoning (reasoning: false). Review the local model configuration and reload. This is not a claim about the model family’s capabilities.'}</p>}
    {!thinkingDisabled && !reportedLevels && <p>{zh ? '当前 Pi 尚未上报支持的等级；实际生效值以 Pi 回传为准。更新扩展后可在空闲时 /reload。' : 'This Pi has not reported supported levels. The native Pi response determines the effective value; reload the updated extension when idle.'}</p>}
    {resultCode && <p role="alert">{resultCode === 'THINKING_UNSUPPORTED' ? (zh ? '当前 Pi 配置未启用此模型的思考能力，未修改强度。' : 'Reasoning is disabled in this Pi model configuration. Nothing was changed.') : resultCode === 'THINKING_LEVEL_UNAVAILABLE' ? (zh ? '当前模型不接受这个等级，请选择 Pi 上报的支持等级。' : 'This level is not supported by the configured model.') : resultCode === 'THINKING_NOT_APPLIED' ? (zh ? 'Pi 未采用所选等级，已同步实际值。请检查本机模型能力配置。' : 'Pi did not apply the requested level. Its actual value is synchronized; review the model capabilities.') : resultCode === 'CONTROL_APPROVAL_REQUIRED' || resultCode === 'CONTROL_REQUIRED' ? (zh ? '尚未获得控制权，思考强度未修改。请先向房主申请。' : 'Control is required. The setting was not changed; request approval first.') : resultCode === 'RESULT_UNKNOWN' ? (zh ? '修改结果未确认，请以同步后的思考强度为准。' : 'The result is unconfirmed. Check the synchronized value.') : t(`errors.${resultCode}`, { defaultValue: t('commandRejected') })}</p>}
    <form onSubmit={event => { event.preventDefault(); void run({ name: 'set_model', provider, modelId: model }); }}><FieldGroup>
      <Field data-disabled={!enabled || busy}><FieldLabel htmlFor={`${id}-provider`}>{t('provider')}</FieldLabel><Input id={`${id}-provider`} value={provider} maxLength={128} disabled={!enabled || busy} onChange={event => setProvider(event.target.value.slice(0, 128))} /></Field>
      <Field data-disabled={!enabled || busy}><FieldLabel htmlFor={`${id}-model`}>{t('modelId')}</FieldLabel><Input id={`${id}-model`} value={model} maxLength={256} disabled={!enabled || busy} onChange={event => setModel(event.target.value.slice(0, 256))} /></Field>
      <Button type="submit" aria-label={t('applyModel')} loading={busy} disabled={!enabled || busy || !provider || !model}>{t('applyModel')}</Button>
    </FieldGroup></form>
  </details>;
}
