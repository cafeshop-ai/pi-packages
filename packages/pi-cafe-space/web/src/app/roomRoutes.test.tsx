import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
async function setup(path: string, cached = false) {
  window.history.replaceState(null, '', '/#' + path);
  const sockets: Socket[] = []; const owners: AppOwner[] = [];
  const storage = createRelayStorage(() => { throw Error('isolated'); });
  if (cached) { storage.set('token', 'private-test-token'); storage.set('room', 'previous'); storage.set('host', 'h2'); }
  const createOwner = () => {
    const owner = new AppOwner({ storage, client: new RelayClient({ origin: 'http://localhost', socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } }), http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'server-default' }) } });
    owners.push(owner); return owner;
  };
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const mounted = render(<StrictMode><I18nextProvider i18n={i18n}><App createOwner={createOwner} /></I18nextProvider></StrictMode>);
  await waitFor(() => expect(screen.queryByText('Connecting to your workspace…')).not.toBeInTheDocument());
  const owner = () => owners.at(-1)!;
  const active = () => sockets.filter(s => !s.closed);
  const join = async (room: string) => {
    const socket = active()[0]!;
    await act(async () => {
      socket.onopen?.(); socket.emit({ type: 'welcome', protocolVersion: 1, connectionId: 'c', peerRole: 'client', roomId: room, hostConnected: true });
      socket.emit({ type: 'host_status', hostId: 'h1', connected: true, streamId: 'stream', sessionId: 'session', hosts: ['h1', 'h2'].map(hostId => ({ hostId, connected: true, ready: true, streamId: 'stream', sessionId: 'session', cwd: 'C:/synthetic', sessionName: null })) });
      for (const hostId of ['h1', 'h2']) socket.emit({ type: 'snapshot', hostId, snapshot: { ...fixture.expectedFinal, phase: 'idle' } });
    });
    return socket;
  };
  return { ...mounted, sockets, storage, owner, active, join };
}
async function go(path: string) { await act(async () => { window.location.hash = '#' + path; await new Promise(resolve => setTimeout(resolve, 20)); }); }

it('room bookmark needs only token, uses room in hello, and retains room across history/live/logout', async () => {
  const app = await setup('/rooms/manual-trial');
  expect(screen.queryByRole('textbox', { name: 'Room' })).toBeNull();
  expect(screen.getByText('manual-trial')).toBeInTheDocument();
  expect(app.sockets).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Client token'), { target: { value: 'private-test-token' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  const socket = await app.join('manual-trial');
  expect(JSON.parse(socket.frames[0]!)).toMatchObject({ type: 'hello', roomId: 'manual-trial' });
  expect(screen.queryByRole('link', { name: 'Live conversation' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Return to live conversation' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /h2/ }));
  expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Load history' }));
  const request = JSON.parse(socket.frames.at(-1)!);
  const id = 'saved/%2F:id';
  await act(async () => socket.emit({ type: 'command_result', requestId: request.requestId, hostId: 'h2', status: 'applied', code: null, message: null, data: { kind: 'sessions', currentSessionId: 'session', sessions: [{ sessionId: id, name: 'Archived', cwd: 'C:/synthetic', created: '2026-01-01', modified: '2026-01-01', messageCount: 1, firstMessage: '' }], historyTruncated: false } }));
  expect(screen.getByRole('link', { name: 'Archived' })).toHaveAttribute('href', '#/rooms/manual-trial/history/' + encodeURIComponent(id));
  fireEvent.click(screen.getByRole('link', { name: 'Archived' }));
  await waitFor(() => expect(socket.frames.map(frame => JSON.parse(frame)).reverse().find(frame => frame.payload?.name === 'get_session')?.payload).toEqual({ name: 'get_session', sessionId: id }));
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  expect(app.owner().store.scope()?.sessionId).toBe('session');
  fireEvent.click(screen.getByRole('link', { name: 'Return to live conversation' }));
  expect(window.location.hash).toBe('#/rooms/manual-trial');
  expect(app.active()).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
  expect(await screen.findByLabelText('Client token')).toBeInTheDocument();
  expect(window.location.hash).toBe('#/rooms/manual-trial');
  expect(app.storage.get('token')).toBeNull();
  expect(window.location.href).not.toContain('private-test-token');
  expect(JSON.stringify(app.owner().store.getSnapshot())).not.toContain('private-test-token');
  app.unmount();
});

it('URL overrides cached room before any socket; hash room changes cancel pending and fence drafts/inventory', async () => {
  const app = await setup('/rooms/alpha', true);
  expect(app.storage.get('room')).toBe('alpha');
  expect(app.storage.get('host')).toBeNull();
  expect(app.active()).toHaveLength(1);
  const first = await app.join('alpha');
  expect(JSON.parse(first.frames[0]!).roomId).toBe('alpha');
  fireEvent.click(screen.getByRole('button', { name: /h2/ }));
  fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'do not leak draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Load history' }));
  expect(app.owner().gateway.stats().count).toBe(1);
  const stale = first.onmessage;
  await go('/rooms/beta');
  expect(first.closed).toBe(true);
  expect(app.owner().gateway.stats().count).toBe(0);
  expect(app.owner().store.getSnapshot().hosts.size).toBe(0);
  expect(app.owner().store.getSnapshot().history.size).toBe(0);
  expect(app.storage.get('host')).toBeNull();
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  const second = await app.join('beta');
  expect(JSON.parse(second.frames[0]!).roomId).toBe('beta');
  expect(app.owner().store.getSnapshot().selectedHostId).toBeNull();
  await act(async () => stale?.({ data: JSON.stringify({ type: 'snapshot', hostId: 'h2', snapshot: { ...fixture.expectedFinal, lastEventSeq: 999 } }) }));
  expect(app.owner().store.getSnapshot().hosts.get('h2')?.snapshot?.lastEventSeq).not.toBe(999);
  fireEvent.click(screen.getByRole('button', { name: /h2/ }));
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('');
  expect(second.frames.map(frame => JSON.parse(frame)).filter(frame => frame.type === 'command').every(frame => frame.payload.name === 'list_sessions' && frame.targetHostId === 'h2')).toBe(true);
  await act(async () => { window.history.back(); });
  await waitFor(() => expect(app.storage.get('room')).toBe('alpha'));
  expect(second.closed).toBe(true);
  expect(app.active()).toHaveLength(1);
  app.unmount();
  expect(app.sockets.every(s => s.closed && !s.onmessage)).toBe(true);
});

it('invalid room URL never connects to cached/default room and suspends an already connected room', async () => {
  const app = await setup('/rooms/%252F', true);
  expect(await screen.findByRole('alert')).toHaveTextContent('Page not found');
  expect(app.sockets).toHaveLength(0);
  expect(screen.queryByLabelText('Client token')).toBeNull();
  await go('/rooms/valid');
  expect(app.active()).toHaveLength(1);
  await app.join('valid');
  await go('/rooms/');
  expect(app.active()).toHaveLength(0);
  expect(app.owner().store.getSnapshot().hosts.size).toBe(0);
  expect(screen.getByRole('alert')).toHaveTextContent('Page not found');
  app.unmount();
});

it('a refreshed history bookmark waits for inventory and preserves opaque ID and current-session fence', async () => {
  const id = 'saved/%2F:id';
  const app = await setup('/rooms/alpha/history/' + encodeURIComponent(id), true);
  expect(app.active()).toHaveLength(1);
  expect(app.active()[0]!.frames).toHaveLength(0);
  const socket = await app.join('alpha');
  expect(socket.frames.every(frame => JSON.parse(frame).type !== 'command')).toBe(true);
  // A history bookmark does not select a same-named host from another room.
  await act(async () => { app.owner().selectHost('h1'); });
  await waitFor(() => expect(socket.frames.map(frame => JSON.parse(frame)).reverse().find(frame => frame.payload?.name === 'get_session')).toMatchObject({ type: 'command', expectedSessionId: 'session', targetHostId: 'h1', payload: { name: 'get_session', sessionId: id } }));
  expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull();
  expect(screen.getByRole('link', { name: 'Return to live conversation' })).toHaveAttribute('href', '#/rooms/alpha');
  app.unmount();
});

it('auth failure keeps the room URL but removes the token and requires explicit login', async () => {
  const app = await setup('/rooms/alpha', true);
  const socket = app.active()[0]!;
  await act(async () => { socket.onopen?.(); socket.emit({ type: 'error', code: 'UNAUTHORIZED', message: 'test rejection' }); });
  expect(await screen.findByLabelText('Client token')).toHaveValue('');
  expect(screen.queryByRole('textbox', { name: 'Room' })).toBeNull();
  expect(window.location.hash).toBe('#/rooms/alpha');
  expect(app.storage.get('token')).toBeNull();
  expect(app.active()).toHaveLength(0);
  app.unmount();
});

it('legacy login still offers a room and converts successful submission to a room bookmark', async () => {
  const app = await setup('/');
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Room' })).toHaveValue('server-default'));
  fireEvent.change(screen.getByLabelText('Client token'), { target: { value: 'private-test-token' } });
  fireEvent.change(screen.getByLabelText('Room'), { target: { value: 'chosen' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
  await waitFor(() => expect(window.location.hash).toBe('#/rooms/chosen'));
  expect(app.active()).toHaveLength(1);
  app.unmount();
});
