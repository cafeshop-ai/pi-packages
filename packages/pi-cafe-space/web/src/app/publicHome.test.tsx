import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../i18n';
import { createRelayStorage } from '../services/relay/storage';
import { AppOwner } from './owner';
import { App } from './App';

const key = 'B' + 'A'.repeat(86);
const room = 'a'.repeat(32), invite = 'd'.repeat(64);
let fetcher: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
    const q = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    if (q.op === 'status') return json({ enabled: true });
    if (q.op === 'preview') return json({ roomId: room, title: '多人讨论', inviter: '创建者', inviterVerified: false, humans: 1, ais: 0, messages: 0, tasks: 0, aiPaused: false, expires: '2030-01-01T00:00:00Z', visibleAfterJoin: [], allowedAfterJoin: [] });
    return json({});
  });
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

async function show(path: string, language = 'en') {
  window.history.replaceState(null, '', '/#' + path);
  const storage = createRelayStorage(() => { throw Error('isolated'); });
  const createOwner = () => new AppOwner({ storage, http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'main', roomAccess: true }) } });
  const i18n = createI18n(); await i18n.changeLanguage(language);
  render(<StrictMode><I18nextProvider i18n={i18n}><App createOwner={createOwner} /></I18nextProvider></StrictMode>);
  await waitFor(() => expect(screen.queryByText('Connecting to your workspace…')).not.toBeInTheDocument());
}
const linkBox = () => screen.getByLabelText('Have a link? Paste it here');
const paste = (value: string) => { fireEvent.change(linkBox(), { target: { value } }); fireEvent.click(screen.getByRole('button', { name: /^Open/ })); };

it('offers two clear entry points and site navigation on the public home', async () => {
  await show('/');
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Your computer and your team, in one space.');
  expect(screen.getByRole('heading', { level: 2, name: 'Remote device' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { level: 2, name: 'Collaboration room' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Open a shared device' })).toHaveAttribute('href', '#/devices');
  expect(screen.getByRole('link', { name: 'Share this computer' })).toHaveAttribute('href', '#/devices/share');
  expect(screen.getByRole('link', { name: 'Create a room' })).toHaveAttribute('href', '#/collab');
  const nav = screen.getByRole('navigation', { name: 'Site' });
  expect(nav).toContainElement(screen.getAllByRole('link', { name: 'Remote device' })[0]!);
  expect(screen.getByRole('link', { name: 'Café Space' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getByText(/AIs join over HTTPS with their own tools/)).toBeInTheDocument();
});

it('rejects an unrecognized link locally without calling any endpoint or navigating', async () => {
  await show('/');
  const before = fetcher.mock.calls.length;
  paste(`https://evil.example/#/collab/${room}?invite=${invite}`);
  expect(await screen.findByRole('alert')).toHaveTextContent('This link was not recognized');
  expect(linkBox()).toHaveAttribute('aria-invalid', 'true');
  expect(fetcher.mock.calls.length).toBe(before);
  expect(window.location.hash).toBe('#/');
});

it('opens a pasted invite on the collaboration page and only sends it to the collaboration API', async () => {
  await show('/');
  const before = fetcher.mock.calls.length;
  paste(`${window.location.origin}/#/collab/${room}?invite=${invite}`);
  await waitFor(() => expect(window.location.hash).toBe(`#/collab/${room}?invite=${invite}`));
  // The collaboration page received the invite (its AI invitation embeds it) and joins only after confirmation.
  expect(await screen.findByRole('region', { name: '邀请 AI' })).toHaveTextContent(invite);
  for (const [url, init] of fetcher.mock.calls.slice(before)) {
    expect(url).toMatch(/\/api\/collaboration$/);
    expect(url).not.toContain(invite);
    expect(JSON.parse(String(init?.body)).op).not.toBe('join');
  }
});

it('routes a pasted device room key to the device room page', async () => {
  await show('/');
  paste(key);
  await waitFor(() => expect(window.location.hash).toBe('#/room/' + key));
});

it('keeps the existing device landing under Remote device and adds the setup guide', async () => {
  await show('/devices');
  expect(screen.getByRole('heading', { level: 1, name: 'Remote device' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Join your room' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'See the setup steps' })).toHaveAttribute('href', '#/devices/share');
  fireEvent.click(screen.getByRole('link', { name: 'See the setup steps' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Share this computer' })).toBeInTheDocument();
  expect(screen.getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getByText(new RegExp(`installer against ${window.location.origin.replace(/[.:/]/g, '\\$&')}`))).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Remote device' })).toHaveAttribute('aria-current', 'page');
});

it('lets the collaboration page navigate back and open an invite, but not a device link', async () => {
  await show('/collab');
  expect(screen.getByRole('link', { name: '首页' })).toHaveAttribute('href', '#/');
  expect(screen.getByRole('link', { name: '远程电脑' })).toHaveAttribute('href', '#/devices');
  const field = screen.getByLabelText('邀请链接');
  fireEvent.change(field, { target: { value: key } });
  fireEvent.click(screen.getByRole('button', { name: '打开邀请' }));
  expect(await screen.findByText(/这是远程电脑的房间链接/)).toBeInTheDocument();
  expect(window.location.hash).toBe('#/collab');
  fireEvent.change(field, { target: { value: `${window.location.origin}/#/collab/${room}?invite=${invite}` } });
  fireEvent.click(screen.getByRole('button', { name: '打开邀请' }));
  await waitFor(() => expect(window.location.hash).toBe(`#/collab/${room}?invite=${invite}`));
});
