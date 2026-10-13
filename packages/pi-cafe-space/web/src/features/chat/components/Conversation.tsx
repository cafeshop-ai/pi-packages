import { useEffect, useState, type PropsWithChildren, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../../components/ui/Controls';
import { AssistantRuntimeProvider, ThreadPrimitive, MessagePrimitive, useAuiState, type ToolCallMessagePartProps, type DataMessagePartProps, type ReasoningMessagePartProps } from '@assistant-ui/react';
import { scopeKey } from '../../../state/CollabStore';
import { usePiRelayRuntime, type PiRelayRuntimeOptions } from '../runtime/usePiRelayRuntime';
import { CollapseProvider, useDisclosure } from './CollapseState';
import { ToolPart, isToolView } from './ToolPart';
import { SafeMarkdown } from './SafeMarkdown';
import { useChatLabels } from './labels';
import styles from './Conversation.module.scss';
import { Icon } from '../../../components/ui/Icon';
import { AgentActivity } from './AgentActivity';
import type { SessionSnapshot } from '../../../../../src/protocol/index';

export function PiRelayRuntimeProvider({ children, ...options }: PropsWithChildren<PiRelayRuntimeOptions>) {
  const runtime = usePiRelayRuntime(options);
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
function ToolRenderer({ artifact }: ToolCallMessagePartProps) { return isToolView(artifact) ? <ToolPart view={artifact} /> : null; }
function DataRenderer({ name, data }: DataMessagePartProps) { return name === 'pi-tool' && isToolView(data) ? <ToolPart view={data} /> : null; }
function Reasoning({ text, providerMetadata }: ReasoningMessagePartProps) {
  const labels = useChatLabels();
  const messageId = useAuiState(s => s.message.id);
  const disclosure = useDisclosure(JSON.stringify([messageId, 'reasoning', providerMetadata?.pi?.index ?? -1]));
  const running = useAuiState(s => s.message.status?.type === 'running');
  return <details className={styles.reasoning} data-streaming={running} open={disclosure.open}><summary onClick={event => { event.preventDefault(); disclosure.setOpen(!disclosure.open); }}>{labels.reasoning}</summary><pre>{text}</pre></details>;
}
const parts = { Text: SafeMarkdown, Reasoning, tools: { Override: ToolRenderer }, data: { by_name: { 'pi-tool': DataRenderer } } };
function Message() {
  const labels = useChatLabels(); const { t } = useTranslation();
  const text = useAuiState(s => s.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n\n'));
  const [copy, setCopy] = useState<'copied' | 'copyFailed' | null>(null);
  useEffect(() => { setCopy(null); }, [text]);
  const id = useAuiState(s => s.message.metadata.custom.sourceId);
  const role = useAuiState(s => s.message.metadata.custom.sourceRole);
  const label = role === 'user' ? labels.user : role === 'system' ? labels.system : role === 'tool' ? labels.tool : labels.assistant;
  return <MessagePrimitive.Root className={styles.message} data-source-id={typeof id === 'string' ? id : undefined} data-message-role={typeof role === 'string' ? role : undefined}>
    <header className={styles.messageHeader}>{label}</header>
    <MessagePrimitive.Parts components={parts} unstable_showEmptyOnNonTextEnd={false} />
    {text && <footer className={styles.messageActions}><Button variant="quiet" aria-label={t('copyMessage')} onClick={() => { void navigator.clipboard?.writeText(text).then(() => setCopy('copied'), () => setCopy('copyFailed')); if (!navigator.clipboard) setCopy('copyFailed'); }}><Icon name={copy === 'copied' ? 'check' : 'copy'} />{t('copyMessage')}</Button>{copy && <span role="status">{t(copy)}</span>}</footer>}
  </MessagePrimitive.Root>;
}
function Transcript({ readOnly, empty, snapshot, connected, navigation }: { readOnly: boolean; empty: boolean; snapshot: SessionSnapshot; connected: boolean; navigation?: ReactNode }) {
  const labels = useChatLabels();
  return <ThreadPrimitive.Root className={styles.thread}>
    {readOnly && <p className={styles.notice}>{labels.history}</p>}
    {(snapshot.historyTruncated || snapshot.messages.some(message => message.partsTruncated)) && <p className={styles.notice}>{labels.incomplete}</p>}
    {empty && <div className={styles.empty}><Icon name="message" /><h2>{labels.emptyConversation}</h2><p>{labels.emptyConversationHelp}</p></div>}
    <div className={styles.transcriptArea} data-empty={empty}>
    <div className={styles.messages} data-empty={empty} role="log" aria-label={labels.conversation} aria-live="off">
      <ThreadPrimitive.Messages>{() => <Message />}</ThreadPrimitive.Messages>
    </div>
    {navigation && <div className={styles.transcriptNavigation} data-jump-latest>{navigation}</div>}
    </div>
    {!readOnly && <AgentActivity snapshot={snapshot} connected={connected} />}
  </ThreadPrimitive.Root>;
}
export function Conversation({ connected = true, navigation, ...props }: PiRelayRuntimeOptions & { connected?: boolean; navigation?: ReactNode }) {
  return <PiRelayRuntimeProvider key={JSON.stringify([scopeKey(props.scope), !!props.readOnly])} {...props}>
    <CollapseProvider><Transcript readOnly={!!props.readOnly} snapshot={props.snapshot} connected={connected} navigation={navigation} empty={!props.readOnly && props.snapshot.phase !== 'running' && props.snapshot.phase !== 'waiting_local_ui' && props.snapshot.messages.length === 0 && props.snapshot.tools.length === 0} /></CollapseProvider>
  </PiRelayRuntimeProvider>;
}
