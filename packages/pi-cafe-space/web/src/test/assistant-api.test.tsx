import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AssistantRuntimeProvider, useExternalStoreRuntime, ThreadPrimitive, MessagePrimitive, ComposerPrimitive, type ThreadMessageLike, type AppendMessage } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';

const messages: ThreadMessageLike[] = [{ id: 'fixture', role: 'assistant', content: [{ type: 'text', text: 'Installed API smoke' }] }];
function Smoke() {
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (message: ThreadMessageLike) => message, isRunning: false, onNew: async (_message: AppendMessage) => {}, onCancel: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root>
    <ThreadPrimitive.Messages>{() => <MessagePrimitive.Root>
      <MessagePrimitive.Parts>{({ part }) => part.type === 'text' ? <span>{part.text}</span> : null}</MessagePrimitive.Parts>
    </MessagePrimitive.Root>}</ThreadPrimitive.Messages>
  </ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
it('published external-store/provider/parts exports work with installed React', () => {
  expect(ComposerPrimitive.Send).toBeDefined(); expect(ComposerPrimitive.Cancel).toBeDefined(); expect(MarkdownTextPrimitive).toBeDefined();
  render(<Smoke />);
  expect(screen.getByText('Installed API smoke')).toBeInTheDocument();
});
