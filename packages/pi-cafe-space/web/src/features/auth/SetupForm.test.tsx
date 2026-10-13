import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../i18n';
import { SetupForm } from './SetupForm';

const nonce = 'n'.repeat(43);
const token = 'Cafe-Test_9Yx2pL!';
const json = (value: object, status = 200) => ({ ok: status < 400, text: async () => JSON.stringify(value) });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
async function mount(post = async () => json({ initialized: true }, 201)) {
  const request = vi.fn(async (_url: string, init: RequestInit) => init.method === 'GET' ? json({ required: true, nonce }) : post());
  vi.stubGlobal('fetch', request);
  const onComplete = vi.fn(), onRefresh = vi.fn();
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const app = render(<I18nextProvider i18n={i18n}><SetupForm onComplete={onComplete} onRefresh={onRefresh} /></I18nextProvider>);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save and open Café Space' })).toBeEnabled());
  return { ...app, request, onComplete, onRefresh };
}
function fill(value = token, confirm = value) {
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value } });
  fireEvent.change(screen.getByLabelText('Confirm token'), { target: { value: confirm } });
}
it('never generates or submits a token on mount; posts only the confirmed user value', async () => {
  const { request, onComplete } = await mount();
  expect(screen.getByLabelText('Access token')).toHaveValue(''); expect(request).toHaveBeenCalledTimes(1);
  fill(); fireEvent.click(screen.getByRole('button', { name: 'Save and open Café Space' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledExactlyOnceWith(token));
  const [, init] = request.mock.calls[1]!;
  expect(init.headers).toMatchObject({ 'X-Cafe-Setup': nonce });
  expect(JSON.parse(String(init.body))).toEqual({ token, confirmToken: token });
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(['abcdef', '123456', 'aaaaaa', '我的访问令牌', 'a'.repeat(20)])('accepts a custom token without a complexity rule: %s', async value => {
  const { request, onComplete } = await mount(); fill(value);
  expect(screen.getByLabelText('Access token')).toHaveAttribute('minlength', '6');
  expect(screen.getByLabelText('Access token')).toHaveAttribute('maxlength', '20');
  fireEvent.click(screen.getByRole('button', { name: 'Save and open Café Space' }));
  await waitFor(() => expect(onComplete).toHaveBeenCalledExactlyOnceWith(value));
  expect(request).toHaveBeenCalledTimes(2);
});
it.each(['a', '12345', 'a'.repeat(21)])('rejects a token outside the 6–20 character range: %s', async value => {
  const { request, onComplete } = await mount(); fill(value);
  fireEvent.submit(screen.getByLabelText('Access token').closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('6–20');
  expect(onComplete).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(1);
});
it('inline visibility toggle keeps the entered values and does not submit', async () => {
  const { request } = await mount(); fill('123');
  fireEvent.click(screen.getByRole('button', { name: 'Show token' }));
  expect(screen.getByLabelText('Access token')).toHaveAttribute('type', 'text');
  expect(screen.getByLabelText('Confirm token')).toHaveAttribute('type', 'text');
  expect(screen.getByLabelText('Access token')).toHaveValue('123');
  fireEvent.click(screen.getByRole('button', { name: 'Hide token' }));
  expect(screen.getByLabelText('Access token')).toHaveAttribute('type', 'password');
  expect(request).toHaveBeenCalledTimes(1);
});
it('mismatched confirmation is rejected without a POST', async () => {
  const { request } = await mount(); fill(token, 'Other_Test_8Qz!');
  fireEvent.click(screen.getByRole('button', { name: 'Save and open Café Space' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('do not match'); expect(request).toHaveBeenCalledTimes(1);
});
it('random generation needs a click and still requires explicit save', async () => {
  const { request } = await mount(); fireEvent.click(screen.getByRole('button', { name: 'Generate random token' }));
  const value = (screen.getByLabelText('Access token') as HTMLInputElement).value;
  expect(value).toMatch(/^[a-f0-9]{20}$/); expect(screen.getByLabelText('Confirm token')).toHaveValue(value);
  expect(request).toHaveBeenCalledTimes(1);
});
it('a lost save acknowledgement does not replay and requires a state refresh', async () => {
  const { request, onComplete, onRefresh } = await mount(async () => { throw Error('network lost'); });
  fill(); fireEvent.click(screen.getByRole('button', { name: 'Save and open Café Space' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('acknowledgement was not received');
  expect(screen.getByRole('button', { name: 'Save and open Café Space' })).toBeDisabled();
  expect(request).toHaveBeenCalledTimes(2); expect(onComplete).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh setup state' })); expect(onRefresh).toHaveBeenCalledOnce();
});
it('another page winning setup cannot overwrite the saved token', async () => {
  const { request, onComplete } = await mount(async () => json({ error: 'ALREADY_INITIALIZED' }, 409));
  fill(); fireEvent.click(screen.getByRole('button', { name: 'Save and open Café Space' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Another page');
  expect(screen.getByRole('button', { name: 'Save and open Café Space' })).toBeDisabled(); expect(onComplete).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledTimes(2);
});
it('one pending submission cannot be duplicated', async () => {
  let resolve!: (value: ReturnType<typeof json>) => void;
  const { request, onComplete } = await mount(() => new Promise(r => { resolve = r; })); fill();
  const form = screen.getByLabelText('Access token').closest('form')!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => resolve(json({ initialized: true }, 201)));
  expect(onComplete).toHaveBeenCalledOnce();
});
