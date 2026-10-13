import { useMemo } from 'react';
import { useExternalStoreRuntime, type AppendMessage, type ThreadMessageLike } from '@assistant-ui/react';
import type { SessionSnapshot } from '../../../../../src/protocol/index';
import type { HostScope } from '../../../state/CollabStore';
import { convertMessages } from './convertMessages';
export interface PiRelayRuntimeOptions {
  snapshot: SessionSnapshot;
  scope: HostScope;
  readOnly?: boolean;
  disabled?: boolean;
  onSend?: (text: string) => Promise<void>;
  onAbort?: () => Promise<void>;
}
const identity = (message: ThreadMessageLike) => message;
export function usePiRelayRuntime({ snapshot, scope, readOnly = false, disabled = false, onSend, onAbort }: PiRelayRuntimeOptions) {
  const messages = useMemo(() => convertMessages(snapshot, scope), [snapshot.messages, snapshot.tools, scope]);
  const onNew = async (message: AppendMessage) => {
    if (readOnly || disabled || !onSend) throw new Error('This conversation is read-only');
    if (message.role !== 'user' || message.attachments?.length || message.content.some(part => part.type !== 'text')) throw new Error('Only plain text prompts are supported');
    const text = message.content.map(part => part.type === 'text' ? part.text : '').join('\n');
    if (!text.trim() || text.length > 65536) throw new Error('Invalid prompt length');
    // Delegate to the same handler as the sole application Composer. No local
    // append, optimistic message, provider call, or second command is created.
    await onSend(text);
  };
  return useExternalStoreRuntime({
    messages, convertMessage: identity, onNew,
    isRunning: !readOnly && (snapshot.phase === 'running' || snapshot.phase === 'waiting_local_ui'),
    isDisabled: readOnly || disabled || !onSend,
    ...(readOnly || !onAbort ? {} : { onCancel: onAbort }),
    unstable_enableToolInvocations: false,
    // Direct conversion does not use useExternalMessageConverter (whose
    // default concat-content strategy would merge separate Pi messages).
  });
}
