import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../../i18n';
import { Composer } from './Composer';
import type { GatewayResult } from '../../../services/relay/CommandGateway';
// Business-unit test: exercise delivery gates without pretending JSDOM has
// Floating UI geometry. Real shadcn interactions/payloads are browser-tested.
vi.mock('../../../components/ui/ChoiceSelect', () => ({ ChoiceSelect: ({ label, value, items, disabled, onValueChange }: React.ComponentProps<typeof import('../../../components/ui/ChoiceSelect').ChoiceSelect>) =>
  <label>{label}<select value={value} disabled={disabled} onChange={e => onValueChange(e.target.value)}>{items.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label> }));
const i18n = createI18n(); void i18n.changeLanguage('en');
const applied: GatewayResult = { status: 'dispatched', code: null, message: null };
const wrapper = ({ children }: { children: React.ReactNode }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
it('completion selects instead of sending; scoped reads cancel, escaped email is not attached, rejected file sends keep drafts', async () => {
  const send = vi.fn(async (): Promise<GatewayResult> => ({ status: 'rejected', code: 'SENSITIVE_PATH', message: null }));
  const read = vi.fn(async (_payload: unknown, _signal: AbortSignal): Promise<GatewayResult> => ({ status: 'applied', code: null, message: null, data: { kind: 'commands', truncated: false, commands: [{ name: 'review', description: 'Review code', source: 'extension' }] } }));
  const props = { enabled: true, inputAssist: true, phase: 'idle' as const, send, abort: send, readCompletions: read };
  const { rerender } = render(<Composer {...props} scopeId="a" />, { wrapper });
  const input = screen.getByRole('textbox'); fireEvent.focus(input);
  fireEvent.change(input, { target: { value: '/rev', selectionStart: 4 } });
  await screen.findByRole('option', { name: '/review Review code' });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.compositionEnd(input);
  expect(input).toHaveValue('/rev');
  fireEvent.keyDown(input, { key: 'Tab' }); expect(input).toHaveValue('/review '); expect(send).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: '/rev', selectionStart: 4 } });
  await screen.findByRole('option'); fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByRole('listbox')).toBeNull(); expect(input).toHaveValue('/rev');
  fireEvent.change(input, { target: { value: 'read @"secret note.txt" a@b.com', selectionStart: 29 } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
  expect(send).toHaveBeenCalledExactlyOnceWith('read @"secret note.txt" a@b.com', undefined, ['secret note.txt']);
  expect(input).toHaveValue('read @"secret note.txt" a@b.com');
  expect(screen.getByRole('alert')).toHaveTextContent('sensitive');
  fireEvent.change(input, { target: { value: '/rev', selectionStart: 4 } });
  await screen.findByRole('option');
  const signal = read.mock.calls.at(-1)![1];
  rerender(<Composer {...props} scopeId="b" />);
  expect(input).toHaveValue(''); expect(signal.aborted).toBe(true); expect(screen.queryByRole('listbox')).toBeNull();
});
it('Enter sends exactly once, Shift+Enter and IME never send; acknowledgement is not agent phase', async () => {
  const send = vi.fn(async () => applied); const abort = vi.fn(async () => applied);
  render(<Composer scopeId="a" enabled phase="idle" send={send} abort={abort} />, { wrapper });
  const input = screen.getByRole('textbox', { name: 'Message' });
  fireEvent.change(input, { target: { value: 'hello' } });
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
  fireEvent.compositionStart(input); fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.compositionEnd(input);
  expect(send).not.toHaveBeenCalled();
  await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); fireEvent.keyDown(input, { key: 'Enter' }); });
  expect(send).toHaveBeenCalledExactlyOnceWith('hello', undefined);
  expect(input).toHaveValue('');
  expect(screen.queryByRole('button', { name: 'Abort' })).not.toBeInTheDocument();
});
it('focus tracks only the input surface and an empty running draft has no delivery row',()=>{
 const send=vi.fn(async()=>applied);const {container}=render(<Composer scopeId="a" enabled phase="running" send={send} abort={send}/>,{wrapper});
 const input=screen.getByRole('textbox');const surface=container.querySelector('[data-composer-surface]');expect(surface).toHaveAttribute('data-focused','false');expect(screen.queryByRole('combobox')).toBeNull();fireEvent.focus(input);expect(surface).toHaveAttribute('data-focused','true');fireEvent.blur(input);expect(surface).toHaveAttribute('data-focused','false');expect(send).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'additional detail'}});expect(screen.getByRole('combobox')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Send'})).toBeDisabled();expect(send).not.toHaveBeenCalled();
});
it('requires explicit delivery while running and permits independent abort while send waits', async () => {
  let settle!: (result: GatewayResult) => void;
  const send = vi.fn(() => new Promise<GatewayResult>(resolve => { settle = resolve; }));
  const abort = vi.fn(async () => applied);
  render(<Composer scopeId="a" enabled phase="waiting_local_ui" send={send} abort={abort} />, { wrapper });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'next' } });
  expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'followUp' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(send).toHaveBeenCalledExactlyOnceWith('next', 'followUp');
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Abort' })));
  expect(abort).toHaveBeenCalledOnce();
  await act(async () => settle(applied));
  expect(screen.getByRole('button', { name: 'Abort' })).toBeEnabled();
});
it('scope changes clear drafts and old acknowledgements cannot overwrite a new draft', async () => {
  let settle!: (result: GatewayResult) => void;
  const send = vi.fn(() => new Promise<GatewayResult>(resolve => { settle = resolve; }));
  const props = { enabled: true, phase: 'idle' as const, send, abort: vi.fn(async () => applied) };
  const { rerender } = render(<Composer {...props} scopeId="a" />, { wrapper });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'old' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  rerender(<Composer {...props} scopeId="b" />);
  expect(screen.getByRole('textbox')).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } });
  await act(async () => settle(applied));
  expect(screen.getByRole('textbox')).toHaveValue('new');
});
it('approval denial opens the request dialog and keeps the unsent draft',async()=>{
 const onApprovalRequired=vi.fn();const send=vi.fn(async():Promise<GatewayResult>=>({status:'rejected',code:'CONTROL_APPROVAL_REQUIRED',message:null}));
 render(<Composer scopeId="a" enabled phase="idle" send={send} abort={send} onApprovalRequired={onApprovalRequired}/>,{wrapper});const input=screen.getByRole('textbox');fireEvent.change(input,{target:{value:'preserve my draft'}});await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Send'})));expect(onApprovalRequired).toHaveBeenCalledExactlyOnceWith(input);expect(input).toHaveValue('preserve my draft');expect(send).toHaveBeenCalledOnce();
});
it('unknown write outcomes keep the draft and warn honestly without replay', async () => {
  const send = vi.fn(async (): Promise<GatewayResult> => ({ status: 'unknown', code: 'RESULT_UNKNOWN', message: 'TIMEOUT' }));
  render(<Composer scopeId="a" enabled phase="idle" send={send} abort={vi.fn(async () => applied)} />, { wrapper });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'do work' } });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
  expect(screen.getByRole('textbox')).toHaveValue('do work');
  expect(screen.getByRole('alert')).toHaveTextContent('Unknown outcome');
  expect(send).toHaveBeenCalledOnce();
});
it('disabled contexts and length limits are enforced before delegation', () => {
  const send = vi.fn(async () => applied);
  const { rerender } = render(<Composer scopeId="a" enabled={false} phase="idle" send={send} abort={send} />, { wrapper });
  const input = screen.getByRole('textbox');
  fireEvent.change(input, { target: { value: 'x'.repeat(70000) } });
  expect((input as HTMLTextAreaElement).value.length).toBe(65536);
  fireEvent.keyDown(input, { key: 'Enter' }); expect(send).not.toHaveBeenCalled();
  rerender(<Composer scopeId="b" enabled phase="idle" send={send} abort={send} readOnly />);
  expect(screen.queryByRole('textbox')).toBeNull();
});
