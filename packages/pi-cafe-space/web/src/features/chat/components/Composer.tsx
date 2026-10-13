import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useImmer } from 'use-immer';
import { useTranslation } from 'react-i18next';
import type { AgentPhase } from '../../../../../src/protocol/index';
import type { GatewayResult } from '../../../services/relay/CommandGateway';
import styles from './Composer.module.scss';
import { Icon } from '../../../components/ui/Icon';
import { Button, Textarea } from '../../../components/ui/Controls';
import { ChoiceSelect } from '../../../components/ui/ChoiceSelect';
import { Field, FieldGroup, FieldLabel } from '../../../components/ui/shadcn/field';
import { completedText, referencedFiles, useInputAssist, type CompletionItem, type CompletionRead } from './useInputAssist';
type Delivery = 'steer' | 'followUp';
export interface ComposerProps {
  scopeId: string;
  enabled: boolean;
  phase: AgentPhase;
  readOnly?: boolean;
  context?: ReactNode;
  navigation?: ReactNode;
  inputAssist?: boolean;
  readCompletions?: CompletionRead;
  localCommands?: CompletionItem[];
  send: (text: string, delivery?: Delivery, files?: string[]) => Promise<GatewayResult>;
  abort: () => Promise<GatewayResult>;
  onApprovalRequired?: (trigger: HTMLElement | null) => void;
}
const initial = () => ({ text: '', delivery: '' as '' | Delivery, sending: false, aborting: false, result: null as GatewayResult | null });
function boundedText(value: string) {
  let end = Math.min(value.length, 65536);
  if (end < value.length && end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!)) end--;
  return value.slice(0, end);
}
export function Composer({ scopeId, enabled, phase, readOnly = false, send, abort, context, navigation, inputAssist = false, readCompletions, localCommands = [], onApprovalRequired }: ComposerProps) {
  const { t, i18n } = useTranslation(); const hintId = useId();
  const zh = i18n.language.startsWith('zh');
  const [draft, update] = useImmer(initial);
  const lifecycle = useRef(0);
  const currentScope = useRef(scopeId); currentScope.current = scopeId;
  const sending = useRef(false); const aborting = useRef(false); const composing = useRef(false);
  useEffect(() => {
    lifecycle.current++; sending.current = false; aborting.current = false; composing.current = false; update(initial());
    return () => { lifecycle.current++; };
  }, [scopeId, readOnly, update]);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const resize = () => { const node = input.current; if (!node) return; node.style.height = 'auto'; node.style.height = `${Math.min(160,Math.max(48,node.scrollHeight))}px`; };
    resize(); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, [draft.text, scopeId]);
  const nextCursor = useRef<number | null>(null);
  const [cursor, setCursor] = useState(0); const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false); const [active, setActive] = useState(0);
  const completions = useInputAssist({ text: draft.text, cursor, enabled: enabled && inputAssist && focused && !readOnly && !dismissed && !draft.sending, scopeId, read: readCompletions, localCommands });
  useEffect(() => { setActive(0); setDismissed(false); }, [draft.text, cursor, scopeId]);
  useLayoutEffect(() => { if (nextCursor.current !== null) { input.current?.focus(); input.current?.setSelectionRange(nextCursor.current, nextCursor.current); setCursor(nextCursor.current); nextCursor.current = null; } }, [draft.text]);
  const selected = Math.min(active, Math.max(0, completions.items.length - 1));
  useEffect(() => { input.current?.ownerDocument.getElementById(`${hintId}-option-${selected}`)?.scrollIntoView?.({ block: 'nearest' }); }, [selected, hintId]);
  const pick = (item: CompletionItem) => {
    if (!completions.target) return;
    const next = completedText(draft.text, completions.target, item);
    if (next.text.length > 65536) return;
    nextCursor.current = next.cursor; update(d => { d.text = next.text; });
  };
  const running = phase === 'running' || phase === 'waiting_local_ui';
  const command = draft.text.trimStart().startsWith('/');
  const files = command ? [] : referencedFiles(draft.text);
  const canSend = enabled && !readOnly && !draft.sending && !!draft.text.trim() && files.length <= 8 && (!running || !!draft.delivery && !command);
  const execute = async (operation: 'send' | 'abort') => {
    if (!enabled || readOnly) return;
    const latch = operation === 'send' ? sending : aborting;
    if (latch.current || operation === 'send' && (!canSend || composing.current) || operation === 'abort' && !running) return;
    latch.current = true;
    const generation = lifecycle.current; const capturedScope = scopeId; const text = draft.text;
    update(d => { if (operation === 'send') d.sending = true; else d.aborting = true; d.result = null; });
    let result: GatewayResult;
    try { result = await (operation === 'send' ? files.length ? send(text, running && draft.delivery ? draft.delivery : undefined, files) : send(text, running && draft.delivery ? draft.delivery : undefined) : abort()); }
    catch { result = { status: 'unknown', code: 'RESULT_UNKNOWN', message: null }; }
    if (generation !== lifecycle.current || currentScope.current !== capturedScope) return;
    latch.current = false;
    update(d => {
      if (operation === 'send') { d.sending = false; if ((result.status === 'applied' || result.status === 'dispatched') && d.text === text) d.text = ''; }
      else d.aborting = false;
      d.result = result;
    });
    if (result.status === 'rejected' && ['CONTROL_APPROVAL_REQUIRED','CONTROL_REQUIRED'].includes(result.code ?? '')) onApprovalRequired?.(input.current);
  };
  if (readOnly) return <p className={styles.readonly}>{t('readOnlyHistory')}</p>;
  return <form className={styles.composer} data-running={running} onSubmit={event => { event.preventDefault(); void execute('send'); }}>
    {navigation && <div className={styles.navigation}>{navigation}</div>}
    {completions.target && <div className={styles.completions}>
      <p>{t(completions.target.kind === 'command' ? 'commandCompletionHint' : 'fileCompletionHint')}</p>
      <ul id={`${hintId}-completions`} role="listbox" aria-label={t(completions.target.kind === 'command' ? 'commands' : 'fileReferences')}>
        {completions.items.map((item, index) => <li key={item.value} id={`${hintId}-option-${index}`} role="option" aria-selected={selected === index} onPointerDown={event => event.preventDefault()} onClick={() => pick(item)}><strong>{item.label}</strong><small>{item.description}</small></li>)}
      </ul>
      {completions.loading && <p role="status">{t('loading')}</p>}
      {completions.error && <p role="alert">{t(`errors.${completions.error}`, { defaultValue: t('readFailed') })}</p>}
      {!completions.loading && !completions.error && !completions.items.length && <p role="status">{t('noCompletions')}</p>}
      {completions.truncated && <p>{t('completionTruncated')}</p>}
    </div>}
    <FieldGroup className={styles.inputShell} data-focused={focused} data-composer-surface><Field data-disabled={!enabled}><FieldLabel className="sr-only" htmlFor={`${hintId}-input`}>{t('message')}</FieldLabel><Textarea ref={input} id={`${hintId}-input`} aria-autocomplete="list" aria-haspopup="listbox" aria-controls={completions.target ? `${hintId}-completions` : undefined} aria-activedescendant={completions.target && completions.items.length ? `${hintId}-option-${selected}` : undefined} aria-label={t('message')} aria-describedby={hintId} placeholder={t('composerPlaceholder')} value={draft.text} maxLength={65536} disabled={!enabled} rows={1}
      onChange={event => { setCursor(event.target.selectionStart); update(d => { d.text = boundedText(event.target.value); }); }}
      onSelect={event => setCursor(event.currentTarget.selectionStart)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing || composing.current || event.keyCode === 229) return;
        if (completions.target && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (event.key === 'Escape') { event.preventDefault(); setDismissed(true); return; }
          if (completions.items.length && ['ArrowDown', 'ArrowUp', 'Enter', 'Tab'].includes(event.key)) {
            event.preventDefault();
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') setActive((selected + (event.key === 'ArrowDown' ? 1 : -1) + completions.items.length) % completions.items.length);
            else pick(completions.items[selected]!);
            return;
          }
          if (event.key === 'Enter' && completions.loading) { event.preventDefault(); return; }
        }
        const touchInput = window.innerWidth < 768 || window.matchMedia?.('(pointer: coarse)').matches;
        if (event.key === 'Enter' && !event.shiftKey && (!touchInput || event.ctrlKey || event.metaKey)) { event.preventDefault(); void execute('send'); }
      }} />
    </Field>
    <div className={styles.controls}>
      {context && <div className={styles.context}>{context}</div>}
      {running && !!draft.text.trim() && <div className={styles.delivery}><ChoiceSelect labelHidden label={t('delivery')} value={draft.delivery} disabled={!enabled || draft.sending}
        items={[{ value: '', label: t('chooseDelivery') }, { value: 'steer', label: t('steer') }, { value: 'followUp', label: t('followUp') }]}
        onValueChange={value => { if (value === '' || value === 'steer' || value === 'followUp') update(d => { d.delivery = value; }); }} /></div>}
      <div className={styles.actions}>{running && <Button variant="quiet" aria-label={t('abort')} loading={draft.aborting} disabled={!enabled || !running || draft.aborting} onClick={() => void execute('abort')}><Icon name="stop" /><span className={styles.actionLabel}>{t('abort')}</span></Button>}
      <Button type="submit" variant="primary" aria-label={t('send')} loading={draft.sending} disabled={!canSend}><Icon name="send" /><span className={styles.actionLabel}>{t('send')}</span></Button></div>
    </div></FieldGroup>
    <p id={hintId} className={styles.hint}>{t('composerHint')} · {t('inputAssistHint')}</p>
    {!inputAssist && (command || files.length > 0) && <p>{t('inputReloadHint')}</p>}
    {command && running && <p>{t('slashIdleHint')}</p>}
    {files.length > 0 && <p>{t('attachedFiles', { count: files.length })} {files.join(' · ')}</p>}
    {files.length > 8 && <p role="alert">{t('errors.TOO_MANY_FILES')}</p>}
    {draft.result && <p className={draft.result.status === 'unknown' || draft.result.status === 'rejected' ? undefined : 'sr-only'} role={draft.result.status === 'unknown' || draft.result.status === 'rejected' ? 'alert' : 'status'}>
      {draft.result.code === 'CONTROL_APPROVAL_REQUIRED' ? (zh ? '任务未发送。请先申请控制权，房主批准后再点击发送；草稿已保留。' : 'Nothing was sent. Request control first, then press Send after the owner approves. Your draft is preserved.') : draft.result.code === 'CONTROL_BUSY' ? (zh ? '另一设备正在操作这个 Pi，未发送。草稿已保留。' : 'Another device controls this Pi. Nothing was sent; your draft is preserved.') : draft.result.code === 'CONTROL_UNCONFIRMED' ? (zh ? '尚未确认操作权，任务没有发送。请先查看协作状态，草稿已保留。' : 'Control was not confirmed. No task was sent; check the controller before retrying. Your draft is preserved.') : draft.result.status === 'unknown' ? t('unknownOutcome') : draft.result.status === 'rejected' ? t(`errors.${draft.result.code}`, { defaultValue: t('commandRejected') }) : draft.result.data && typeof draft.result.data === 'object' && !Array.isArray(draft.result.data) && draft.result.data.kind === 'local_action' ? t('localActionOpened') : (zh ? '已发送' : 'Sent')}
      {draft.result.code && <code> {draft.result.code}</code>}
    </p>}
  </form>;
}
