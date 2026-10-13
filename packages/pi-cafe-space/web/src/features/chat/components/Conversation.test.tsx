import { render as renderReact, screen, fireEvent, act } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useAuiState, useAui } from '@assistant-ui/react';
import { I18nextProvider } from 'react-i18next';
import type { ReactElement } from 'react';
import { createI18n } from '../../../i18n';
const i18n = createI18n();
const render = (ui: ReactElement) => renderReact(ui, { wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider> });
import ordered from '../../../../../protocol/fixtures/parts/ordered.json';
import type { SessionSnapshot } from '../../../../../src/protocol/index';
import { Conversation, PiRelayRuntimeProvider } from './Conversation';
const scope = { roomId: 'r', hostId: 'h', streamId: 'stream', sessionId: 'session', cwd: 'C:/synthetic' };
const snapshot = ordered.expectedFinal as SessionSnapshot;
it('renders inline in order, keeps tool DOM and open state through updates, and never adds tool controls', async () => {
  await i18n.changeLanguage('en');
  const { container, rerender } = render(<Conversation snapshot={snapshot} scope={scope} />);
  const message = container.querySelector('[data-source-id="a1"]')!;
  const sequence = [...message.querySelectorAll('[data-tool-id], p')].filter(node => node.hasAttribute('data-tool-id') || !node.closest('[data-tool-id]')).map(node => node.getAttribute('data-tool-id') ?? node.textContent);
  expect(sequence).toEqual(['先检查', 't1', '再检查', 't2', '检查结束']);
  expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(2);
  const details = container.querySelector<HTMLDetailsElement>('[data-tool-id="t1"]')!;
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector('summary')!);
  const next = { ...snapshot, messages: snapshot.messages.map((m, index) => index ? m : { ...m, parts: m.parts!.map(p => p.type === 'text' && p.index === 4 ? { ...p, text: p.text + '。' } : p) }) };
  rerender(<Conversation snapshot={next} scope={scope} />);
  expect(container.querySelector('[data-tool-id="t1"]')).toBe(details);
  expect(details.open).toBe(true);
  expect(details).toHaveTextContent('Empty output');
  expect(container.querySelector('[data-tool-id="t2"]')).toHaveTextContent('Failed');
  expect(screen.queryByRole('button', { name: /edit|reload|approve|upload|branch|execute/i })).not.toBeInTheDocument();
  expect(container.querySelector('[style]')).toBeNull();
});
it('replaces partial tool output in place without losing disclosure or reading position', async () => {
  const s: SessionSnapshot = { ...snapshot, messages: snapshot.messages.slice(0, 1), tools: snapshot.tools.map(tool => ({ ...tool, status: 'running', output: 'partial' })) };
  const { container, rerender } = render(<Conversation snapshot={s} scope={scope} />);
  const details = container.querySelector<HTMLDetailsElement>('[data-tool-id="t1"]')!;
  const log = screen.getByRole('log'); log.scrollTop = 37;
  expect(details.open).toBe(false);
  fireEvent.click(details.querySelector('summary')!);
  rerender(<Conversation snapshot={{ ...s, tools: s.tools.map(tool => ({ ...tool, output: 'updated', status: 'complete' })) }} scope={scope} />);
  expect(container.querySelector('[data-tool-id="t1"]')).toBe(details);
  expect(details.open).toBe(true);
  expect(details).toHaveTextContent('updated');
  expect(log.scrollTop).toBe(37);
});
it('keeps orphan results at their transcript position with honest labels and separate adjacent assistants', async () => {
  await i18n.changeLanguage('en');
  const s: SessionSnapshot = { ...snapshot, tools: [], messages: [snapshot.messages[1]!, { ...snapshot.messages[0]!, id: 'second', parts: [{ index: 0, type: 'text', text: 'one' }] }, { ...snapshot.messages[0]!, id: 'third', parts: [{ index: 0, type: 'text', text: 'two' }] }] };
  const { container } = render(<Conversation snapshot={s} scope={scope} readOnly />);
  expect([...container.querySelectorAll('[data-source-id]')].map(n => n.getAttribute('data-source-id'))).toEqual([s.messages[0]!.id, 'second', 'third']);
  expect(screen.getByText('The calling message is outside this view; the tool execution is retained.')).toBeInTheDocument();
});
it('renders nested tool failures inside codemode and keeps child disclosure stable through updates', async () => {
  await i18n.changeLanguage('en');
  const s: SessionSnapshot = { ...snapshot, historyTruncated: false, messages: [{ ...snapshot.messages[0]!, partsTruncated: false, parts: [{ index: 0, type: 'tool-call', toolCallId: 'code', toolName: 'codemode', argsText: '{}' }] }], tools: [
    { toolCallId: 'code', toolName: 'codemode', argsText: '{}', output: '', status: 'complete' },
    { toolCallId: 'code/1', toolName: 'read', argsText: '{"path":"missing.md"}', output: 'ENOENT: missing.md', status: 'error' },
    { toolCallId: 'code/2', toolName: 'ls', argsText: '{}', output: 'file.md', status: 'complete' },
  ] };
  const { container, rerender } = render(<Conversation snapshot={s} scope={scope} />);
  const parent = container.querySelector<HTMLDetailsElement>('[data-tool-id="code"]')!;
  const child = parent.querySelector<HTMLDetailsElement>('[data-tool-id="code/1"]')!;
  expect(parent.open).toBe(true); expect(child.open).toBe(true);
  expect(child).toHaveTextContent('ENOENT: missing.md'); expect(child).toHaveTextContent('Failed');
  expect(container.querySelectorAll('[data-message-role="tool"]')).toHaveLength(0);
  expect(screen.queryByText(/calling message is outside/)).not.toBeInTheDocument();
  expect(screen.queryByText(/shortened history/)).not.toBeInTheDocument();
  fireEvent.click(child.querySelector('summary')!); expect(child.open).toBe(false);
  rerender(<Conversation snapshot={{ ...s, tools: s.tools.map(t => t.toolCallId === 'code/2' ? { ...t, output: 'updated file.md' } : t) }} scope={scope} />);
  expect(container.querySelector('[data-tool-id="code/1"]')).toBe(child); expect(child.open).toBe(false);
  expect(container.querySelectorAll('[data-tool-id]')).toHaveLength(3);
  const rawSummaries = [...parent.querySelectorAll('details:not([data-tool-id]) > summary')];
  expect(rawSummaries.length).toBeGreaterThan(0);
  for (const summary of rawSummaries) {
    expect(summary.firstElementChild?.tagName.toLowerCase()).toBe('svg');
    expect(summary.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(summary.firstElementChild).toHaveAttribute('focusable', 'false');
  }
});
it('shows one real truncation notice and does not label standalone execution as lost content', async () => {
  await i18n.changeLanguage('en');
  const s: SessionSnapshot = { ...snapshot, historyTruncated: true, messages: snapshot.messages.map(m => ({ ...m, partsTruncated: true })), tools: [] };
  const { rerender } = render(<Conversation snapshot={s} scope={scope} />);
  expect(screen.getAllByText(/This page shows a shortened history/)).toHaveLength(1);
  rerender(<Conversation snapshot={{ ...snapshot, historyTruncated: false, messages: [], tools: [{ toolCallId: 'orphan', toolName: 'read', argsText: '{}', output: 'retained', status: 'complete' }] }} scope={scope} />);
  expect(screen.queryByText(/shortened history/)).not.toBeInTheDocument();
  expect(screen.getAllByText(/calling message is outside/)).toHaveLength(1);
  expect(screen.queryByText('Association unavailable')).not.toBeInTheDocument();
});
it('renders markdown without raw HTML, unsafe links, remote image requests or inline styles', async () => {
  const text = '# Title\n\n<script>window.bad = true</script>\n\n[bad](javascript:alert%281%29) [good](https://example.com/) ![private](https://example.com/tracker.png)\n\n```js\nconst x = 1;\n```';
  const s: SessionSnapshot = { ...snapshot, tools: [], messages: [{ ...snapshot.messages[0]!, parts: [{ index: 0, type: 'text', text }] }] };
  const { container } = render(<Conversation snapshot={s} scope={scope} />);
  expect(screen.getByRole('heading', { name: 'Title' })).toBeInTheDocument();
  expect(container.querySelector('script,img,iframe,[style]')).toBeNull();
  expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
  expect(screen.getByRole('link', { name: 'good' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.getByRole('link', { name: 'good' })).toHaveAttribute('referrerpolicy', 'no-referrer');
  expect(container).toHaveTextContent('const x = 1;');
});
it('copies only message text on explicit action and reports clipboard rejection', async () => {
  await i18n.changeLanguage('en');
  const writeText = vi.fn(async (_text: string) => {});
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  try {
    const { container } = render(<Conversation snapshot={snapshot} scope={scope} />);
    const button = container.querySelector('[data-source-id="a1"] button')!;
    expect(writeText).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(button));
    expect(writeText).toHaveBeenCalledExactlyOnceWith('先检查\n\n再检查\n\n检查结束');
    expect(screen.getByText('Copied')).toBeInTheDocument();
    writeText.mockRejectedValueOnce(Error('denied'));
    await act(async () => fireEvent.click(button));
    expect(screen.getByText('Copy failed; select text manually')).toBeInTheDocument();
  } finally { if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor); else Reflect.deleteProperty(navigator, 'clipboard'); }
});
it('runtime reads phase, has no editing/tool-execution capabilities, and delegates one send without optimistic transcript', async () => {
  const send = vi.fn(async (_text: string) => {}); const abort = vi.fn(async () => {});
  function Probe() {
    const aui = useAui(); const running = useAuiState(s => s.thread.isRunning);
    const capabilities = useAuiState(s => s.thread.capabilities);
    const count = useAuiState(s => s.thread.messages.length);
    return <><output>{JSON.stringify({ running, capabilities, count })}</output><button onClick={() => aui.thread.append({ role: 'user', content: [{ type: 'text', text: 'send once' }] })}>probe send</button><button onClick={() => aui.thread.cancelRun()}>probe abort</button></>;
  }
  const { container, rerender } = render(<PiRelayRuntimeProvider snapshot={{ ...snapshot, phase: 'waiting_local_ui' }} scope={scope} onSend={send} onAbort={abort}><Probe /></PiRelayRuntimeProvider>);
  let state = JSON.parse(container.querySelector('output')!.textContent!);
  expect(state.running).toBe(true);
  expect(state.capabilities).toMatchObject({ edit: false, reload: false, attachments: false });
  await act(async () => fireEvent.click(screen.getByText('probe send')));
  expect(send).toHaveBeenCalledExactlyOnceWith('send once');
  expect(JSON.parse(container.querySelector('output')!.textContent!).count).toBe(state.count);
  await act(async () => fireEvent.click(screen.getByText('probe abort')));
  expect(abort).toHaveBeenCalledOnce();
  rerender(<PiRelayRuntimeProvider snapshot={snapshot} scope={scope} readOnly onSend={send} onAbort={abort}><Probe /></PiRelayRuntimeProvider>);
  state = JSON.parse(container.querySelector('output')!.textContent!);
  expect(state.running).toBe(false);
  expect(state.capabilities.cancel).toBe(false);
});
