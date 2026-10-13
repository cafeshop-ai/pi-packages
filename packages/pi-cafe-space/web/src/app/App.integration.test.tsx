import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../i18n';
import { RelayClient, type SocketLike } from '../services/relay/RelayClient';
import { createRelayStorage } from '../services/relay/storage';
import fixture from '../../../protocol/fixtures/parts/ordered.json';
import { AppOwner } from './owner';
import { App } from './App';
// Keep protocol integration independent of JSDOM layout. The actual shadcn
// Select + Gateway path is also exercised in cafe-ui-browser.mjs --shadcn.
vi.mock('../components/ui/ChoiceSelect', () => ({ ChoiceSelect: ({ label, value, items, disabled, onValueChange }: React.ComponentProps<typeof import('../components/ui/ChoiceSelect').ChoiceSelect>) =>
  <label>{label}<select aria-label={label} value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}>{items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label> }));
class Socket implements SocketLike {
  readyState = 1; bufferedAmount = 0; onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  frames: string[] = []; closed = false; send(value: string) { this.frames.push(value); } close() { this.closed = true; }
  emit(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
it('StrictMode owns one live socket; login, host selection and Composer dispatch real fenced Gateway commands', async () => {
  window.location.hash = '#/';
  const sockets: Socket[] = []; const owners: AppOwner[] = [];
  const storage = createRelayStorage(() => { throw Error('isolated memory'); });
  const createOwner = () => {
    const owner = new AppOwner({ storage, client: new RelayClient({ origin: 'http://localhost', socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } }), http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'main' }) } });
    owners.push(owner); return owner;
  };
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const mounted = render(<StrictMode><I18nextProvider i18n={i18n}><App createOwner={createOwner} /></I18nextProvider></StrictMode>);
  expect(sockets).toHaveLength(0);
  fireEvent.change(await screen.findByLabelText('Client token'), { target: { value: 'synthetic-secret' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  expect(sockets).toHaveLength(1); const socket = sockets[0]!;
  await act(async () => { socket.onopen?.(); socket.emit({ type: 'welcome', protocolVersion: 1, connectionId: 'c', peerRole: 'client', roomId: 'main', hostConnected: true }); });
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  const hosts = ['h1', 'h2'].map(hostId => ({ hostId, connected: true, ready: true, streamId: 'stream', sessionId: 'session', cwd: 'C:/synthetic', sessionName: null }));
  await act(async () => { socket.emit({ type: 'host_status', connected: true, hostId: 'h1', streamId: 'stream', sessionId: 'session', hosts }); for (const hostId of ['h1', 'h2']) socket.emit({ type: 'snapshot', hostId, snapshot: { ...fixture.expectedFinal, phase: 'idle' } }); });
  expect(screen.getByText('Select a host')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /h2/ }));
  const input = await screen.findByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'one command' } }); fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(socket.frames.map(frame => JSON.parse(frame)).filter(frame => frame.payload?.name === 'prompt')).toHaveLength(1));
  const command = JSON.parse(socket.frames.at(-1)!);
  expect(command).toMatchObject({ type: 'command', targetHostId: 'h2', expectedStreamId: 'stream', expectedSessionId: 'session', expectedCwd: 'C:/synthetic', payload: { name: 'prompt', content: 'one command' } });
  await act(async () => socket.emit({ type: 'command_result', requestId: command.requestId, hostId: 'h2', status: 'dispatched', code: null, message: null }));
  expect(input).toHaveValue('');
  const latest = () => JSON.parse(socket.frames.at(-1)!);
  const answer = async (request: { requestId: string }, data: object) => act(async () => socket.emit({ type: 'command_result', requestId: request.requestId, hostId: 'h2', status: 'applied', code: null, message: null, data }));
  const historyRead = socket.frames.map(frame => JSON.parse(frame)).reverse().find(frame => frame.payload?.name === 'list_sessions');
  await answer(historyRead, { kind: 'sessions', currentSessionId: 'session', sessions: [], historyTruncated: false });
  fireEvent.click(screen.getByRole('button', { name: 'Model and thinking' }));
  fireEvent.change(screen.getByLabelText('Thinking level'), { target: { value: 'high' } });
  expect(latest().payload).toEqual({ name: 'set_thinking', level: 'high' });
  await answer(latest(), {});
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'synthetic' } });
  fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'offline-test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply model' }));
  expect(latest().payload).toEqual({ name: 'set_model', provider: 'synthetic', modelId: 'offline-test' });
  await answer(latest(), {});
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  fireEvent.click(screen.getByRole('button', { name: 'Project files' }));
  fireEvent.click(screen.getByRole('button', { name: 'Load files' }));
  await waitFor(() => expect(latest().payload.name).toBe('list_dir'));
  await answer(latest(), { kind: 'directory', path: '.', truncated: false, entries: [{ name: 'a.txt', kind: 'file' }, { name: 'b.txt', kind: 'file' }] });
  fireEvent.click(screen.getByRole('button', { name: 'a.txt' })); const readA = latest();
  fireEvent.click(screen.getByRole('button', { name: 'b.txt' })); const readB = latest();
  await answer(readB, { kind: 'file', path: 'b.txt', offset: 0, bytesRead: 4, size: 4, content: 'BBBB', truncated: false });
  await answer(readA, { kind: 'file', path: 'a.txt', offset: 0, bytesRead: 4, size: 4, content: 'AAAA', truncated: false });
  expect(screen.getByLabelText('File preview')).toHaveTextContent('BBBB');
  expect(screen.getByLabelText('File preview')).not.toHaveTextContent('AAAA');
  expect(window.location.hash).not.toContain('.txt');
  // An offline host may still serve history from Relay cache, never files/writes.
  await act(async () => socket.emit({ type: 'host_status', connected: true, hostId: 'h1', streamId: 'stream', sessionId: 'session', hosts: hosts.map(h => h.hostId === 'h2' ? { ...h, connected: false, ready: false } : h) }));
  expect(screen.getByRole('button', { name: 'Load files' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Load history' }));
  await waitFor(() => expect(latest().payload.name).toBe('list_sessions'));
  const savedId = 'saved/%2F:id';
  await answer(latest(), { kind: 'sessions', currentSessionId: 'session', sessions: [{ sessionId: savedId, name: 'Archived', cwd: 'C:/synthetic', created: '2026-01-01', modified: '2026-01-01', messageCount: 3, firstMessage: '' }], historyTruncated: false });
  fireEvent.click(screen.getByRole('link', { name: 'Archived' }));
  const historyRequest = () => socket.frames.map(frame => JSON.parse(frame)).reverse().find(frame => frame.payload?.name === 'get_session');
  await waitFor(() => expect(historyRequest()?.payload).toEqual({ name: 'get_session', sessionId: savedId }));
  expect(historyRequest().expectedSessionId).toBe('session');
  await answer(historyRequest(), { kind: 'session', sessionId: savedId, name: 'Archived', cwd: 'C:/synthetic', activeLeafId: null, model: null, thinkingLevel: 'off', messages: fixture.expectedFinal.messages, historyTruncated: false, modified: '2026-01-01' });
  await screen.findByText('Read-only history');
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  expect(owners.at(-1)!.store.scope()?.sessionId).toBe('session');
  expect(screen.queryByRole('button', { name: 'Model and thinking' })).toBeNull();
  expect(screen.queryByLabelText('Provider')).toBeNull();
  expect(window.location.hash).not.toContain('synthetic-secret');
  expect(JSON.stringify(owners.at(-1)!.store.getSnapshot())).not.toContain('synthetic-secret');
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  await screen.findByLabelText('Client token');
  expect(storage.get('token')).toBeNull(); expect(storage.get('host')).toBeNull();
  mounted.unmount(); expect(sockets.every(s => s.closed && !s.onmessage)).toBe(true);
  expect(owners.every(owner => owner.gateway.stats().count === 0)).toBe(true);
});
