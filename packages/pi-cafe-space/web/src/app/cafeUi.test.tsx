import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../i18n';
import { RelayClient, type SocketLike } from '../services/relay/RelayClient';
import { createRelayStorage } from '../services/relay/storage';
import fixture from '../../../protocol/fixtures/parts/ordered.json';
import { AppOwner } from './owner';
import { App } from './App';
class Socket implements SocketLike {
  readyState = 1; bufferedAmount = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  frames: string[] = []; closed = false;
  send(value: string) { this.frames.push(value); }
  close() { this.closed = true; }
  emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
afterEach(() => { window.history.replaceState(null, '', '/'); });
async function mount() {
  window.history.replaceState(null, '', '/#/rooms/design-review');
  const sockets: Socket[] = [];
  const owner = new AppOwner({ storage: createRelayStorage(() => { throw Error('isolated'); }), client: new RelayClient({ origin: 'http://localhost', socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } }), http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'main' }) } });
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const app = render(<I18nextProvider i18n={i18n}><App createOwner={() => owner} /></I18nextProvider>);
  await screen.findByLabelText('Client token');
  const connect = async (empty = false, sessionControl = false) => {
    fireEvent.change(screen.getByLabelText('Client token'), { target: { value: 'synthetic-design-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    const socket = sockets[0]!;
    await act(async () => {
      socket.onopen?.(); socket.emit({ type: 'welcome', protocolVersion: 1, connectionId: 'c', peerRole: 'client', roomId: 'design-review', hostConnected: true });
      socket.emit({ type: 'host_status', hostId: 'h1', connected: true, streamId: 'stream', sessionId: 'session', hosts: [{ hostId: 'h1', connected: true, ready: true, streamId: 'stream', sessionId: 'session', cwd: 'C:/synthetic', sessionName: 'Design review' }] });
      socket.emit({ type: 'snapshot', hostId: 'h1', snapshot: { ...fixture.expectedFinal, phase: 'idle', sessionControl, ...(empty ? { messages: [], tools: [] } : {}) } });
    });
    return socket;
  };
  return { ...app, owner, sockets, connect };
}
it('current-session actions require capability and confirmation; independent instances stay separate', async () => {
  const legacy = await mount(); await legacy.connect();
  expect(screen.getByRole('button', { name: 'Rename current session' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'New session' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Start independent Pi instance' }));
  expect(screen.getByText(/Independent instances are not enabled by the owner/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText(/Run \/reload in the selected Pi/)).toBeInTheDocument();
  legacy.unmount();
  const app = await mount(); const socket = await app.connect(false, true);
  const input = screen.getByRole('textbox', { name: 'Message' });
  const header = screen.getByRole('banner', { name: 'Current session' });
  expect(within(header).getByRole('button', { name: 'New session' })).toBeEnabled();
  expect(within(header).queryByRole('button', { name: 'Rename current session' })).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Client instances' })).toBeInTheDocument();
  expect(within(screen.getByRole('complementary', { name: 'Pi hosts' })).getByRole('button', { name: 'Start independent Pi instance' })).toBeEnabled();
  expect(within(screen.getByRole('complementary', { name: 'Pi hosts' })).getByRole('button', { name: 'Rename current session' })).toBeEnabled();
  fireEvent.change(input, { target: { value: 'draft survives cancelled switch' } });
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(input).toHaveValue('draft survives cancelled switch');
  expect(socket.frames.map(frame => JSON.parse(frame)).some(m => m.payload?.name === 'new_session')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Rename current session' }));
  fireEvent.change(screen.getByLabelText('Session name'), { target: { value: '  Café title  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  let request = socket.frames.map(frame => JSON.parse(frame)).filter(m => m.payload?.name === 'rename_session').at(-1);
  expect(request.payload).toEqual({ name: 'rename_session', title: 'Café title' });
  expect(request.expectedSessionId).toBe('session');
  await act(async () => socket.emit({ type: 'command_result', requestId: request.requestId, hostId: 'h1', status: 'applied', code: null, message: null }));
  expect(input).toHaveValue('draft survives cancelled switch');
  fireEvent.click(screen.getByRole('button', { name: 'Start independent Pi instance' }));
  expect(screen.getByText(/without switching or interrupting existing clients/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  expect(socket.frames.map(frame => JSON.parse(frame)).filter(m => m.payload?.name === 'new_session')).toHaveLength(0);
  expect(input).toHaveValue('draft survives cancelled switch');
  expect(window.location.hash).toBe('#/rooms/design-review');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(window.location.hash).toBe('#/rooms/design-review');
  app.unmount();
});
it('Cafe login defaults to workspace dark, explains credential handling, and changing appearance does not connect', async () => {
  const app = await mount();
  expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'dark');
  expect(screen.getByRole('main')).toHaveAttribute('data-surface', 'workspace');
  expect(screen.getByLabelText('Client token')).toHaveAccessibleDescription(/never included in the URL/);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  expect(screen.getByRole('main')).toHaveAttribute('data-theme', 'light');
  expect(app.sockets).toHaveLength(0);
  expect(window.location.hash).toBe('#/rooms/design-review');
  app.unmount();
});
it('theme and language changes preserve the draft, tool DOM/disclosure, selected host, and single connection', async () => {
  const app = await mount(); const socket = await app.connect();
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'keep this draft' } });
  const tool = document.querySelector<HTMLDetailsElement>('[data-tool-id="t1"]')!;
  fireEvent.click(tool.querySelector('summary')!);
  expect(tool.open).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
  fireEvent.click(screen.getByRole('button', { name: '中文' }));
  expect(screen.getByRole('textbox', { name: '消息' })).toBe(input);
  expect(input).toHaveValue('keep this draft');
  expect(screen.getByRole('main')).toHaveAttribute('lang', 'zh-CN');
  expect(document.querySelector('[data-tool-id="t1"]')).toBe(tool);
  expect(tool.open).toBe(true);
  expect(app.owner.store.getSnapshot().selectedHostId).toBe('h1');
  expect(app.sockets).toHaveLength(1);
  expect(socket.frames.map(frame => { const m = JSON.parse(frame); return m.payload?.name ?? m.type; })).toEqual(['hello', 'list_sessions']);
  app.unmount();
});
it('empty conversation is an honest empty state, not sample messages or suggested commands', async () => {
  const app = await mount(); const socket = await app.connect(true);
  expect(screen.getByText('Start a conversation')).toBeInTheDocument();
  expect(screen.getByRole('log')).toBeEmptyDOMElement();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  expect(socket.frames.map(frame => { const m = JSON.parse(frame); return m.payload?.name ?? m.type; })).toEqual(['hello', 'list_sessions']);
  app.unmount();
});
it('loads fenced history automatically, searches locally and collapses panels without replacing the composer', async () => {
  const app = await mount(); const socket = await app.connect();
  const request = JSON.parse(socket.frames.at(-1)!);
  expect(request).toMatchObject({ type: 'command', targetHostId: 'h1', expectedSessionId: 'session', payload: { name: 'list_sessions' } });
  await act(async () => socket.emit({ type: 'command_result', requestId: request.requestId, hostId: 'h1', status: 'applied', code: null, message: null, data: { kind: 'sessions', currentSessionId: 'session', sessions: [{ sessionId: 'saved/%2F:id', name: 'Archived review', cwd: 'C:/synthetic', created: '2026-01-01', modified: '2026-01-01', messageCount: 4, firstMessage: 'Investigate controls' }] } }));
  const count = socket.frames.length;
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Investigate' } });
  expect(screen.getByRole('link', { name: 'Archived review' })).toHaveAttribute('href', '#/rooms/design-review/history/saved%2F%252F%3Aid');
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'no match' } });
  expect(screen.getByText('No matching sessions')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  expect(screen.getByRole('link', { name: 'Archived review' })).toBeInTheDocument();
  expect(socket.frames).toHaveLength(count);
  await act(async () => { app.owner.store.changeView(); });
  // A fresh view refreshes in the background without blanking the same-scope list.
  expect(screen.getByRole('link', { name: 'Archived review' })).toBeInTheDocument();
  expect(socket.frames).toHaveLength(count + 1);
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'draft stays here' } });
  expect(screen.getByRole('button', { name: 'Project files' })).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(screen.getByRole('button', { name: 'Pi hosts' }));
  expect(screen.queryByRole('searchbox')).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Message' })).toBe(input);
  expect(input).toHaveValue('draft stays here');
  app.unmount();
});
it('send keeps its accessible label while busy; decorative icons are hidden from assistive technology', async () => {
  const app = await mount(); const socket = await app.connect();
  fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'explicit synthetic action' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  const send = screen.getByRole('button', { name: 'Send' });
  expect(send).toHaveAttribute('aria-busy', 'true');
  expect(send).toBeDisabled();
  expect(document.querySelectorAll('svg').length).toBeGreaterThan(0);
  expect([...document.querySelectorAll('svg')].every(svg => svg.getAttribute('aria-hidden') === 'true')).toBe(true);
  expect(socket.frames.map(frame => JSON.parse(frame)).filter(frame => frame.payload?.name === 'prompt')).toHaveLength(1);
  app.unmount();
});
