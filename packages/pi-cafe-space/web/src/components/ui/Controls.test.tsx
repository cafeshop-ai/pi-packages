import { createRef, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { Button, IconButton, Input, Label, Textarea } from './Controls';
import { UiProvider } from './UiProvider';
import { Drawer } from './Drawer';

it('compact dialogs focus a usable field, never the hidden input of a preceding select', async () => {
  render(<UiProvider><Drawer compact label="Create" closeLabel="Close" onClose={()=>{}} restoreFocusTo={null}><input type="hidden" value="project" readOnly/><input hidden aria-label="Hidden field"/><Input aria-label="Visible name"/></Drawer></UiProvider>);
  await waitFor(()=>expect(screen.getByLabelText('Visible name')).toHaveFocus());
});

it('buttons do not submit accidentally; loading disables duplicate actions without losing the label', () => {
  const submit = vi.fn((e: React.FormEvent) => e.preventDefault());
  const click = vi.fn(); const ref = createRef<HTMLButtonElement>();
  const { rerender } = render(<form onSubmit={submit}><Button ref={ref} onClick={click}>Load files</Button></form>);
  fireEvent.click(screen.getByRole('button', { name: 'Load files' }));
  expect(click).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled(); expect(ref.current?.tagName).toBe('BUTTON');
  rerender(<form onSubmit={submit}><Button type="submit" loading onClick={click}>Load files</Button></form>);
  const busy = screen.getByRole('button', { name: 'Load files' });
  expect(busy).toBeDisabled(); expect(busy).toHaveAttribute('aria-busy', 'true');
  expect(busy.querySelector('.button-content')).toHaveTextContent('Load files');
  fireEvent.click(busy); expect(click).toHaveBeenCalledTimes(1); expect(submit).not.toHaveBeenCalled();
});

it('ordinary actions use a soft fill, while primary and quiet actions retain their hierarchy', () => {
  render(<><Button>Load files</Button><Button variant="primary">Send</Button><Button variant="quiet">Back</Button></>);
  expect(screen.getByRole('button', { name: 'Load files' })).toHaveClass('bg-secondary', 'border-transparent');
  expect(screen.getByRole('button', { name: 'Load files' })).not.toHaveClass('border-border');
  expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('bg-primary');
  expect(screen.getByRole('button', { name: 'Back' })).not.toHaveClass('bg-secondary', 'border-border');
});

it('fields keep native validation, labels, refs and composition events', () => {
  const ref = createRef<HTMLInputElement>(); const composing = vi.fn();
  render(<><Label htmlFor="token">Client token</Label><Input id="token" type="password" required maxLength={4096} ref={ref} />
    <Label>Message<Textarea onCompositionStart={composing} maxLength={65536} /></Label></>);
  expect(screen.getByLabelText('Client token')).toBe(ref.current); expect(ref.current?.checkValidity()).toBe(false);
  fireEvent.compositionStart(screen.getByLabelText('Message')); expect(composing).toHaveBeenCalledOnce();
});

// Focus/hover/Escape, portal inheritance and collision are exercised with the
// actual Floating UI engine in cafe-ui-browser.mjs --shadcn, not JSDOM layout.
it('icon buttons keep an accessible name and local actions inside the themed provider', () => {
  function Harness() { const [theme, setTheme] = useState('light'); return <main data-theme={theme}><UiProvider><IconButton label="Switch theme" onClick={() => setTheme('dark')}><span aria-hidden="true">☀</span></IconButton></UiProvider></main>; }
  const { container } = render(<Harness />);
  const button = screen.getByRole('button', { name: 'Switch theme' });
  expect(container.querySelector('[data-ui-portal]')?.closest('[data-theme]')).toHaveAttribute('data-theme', 'light');
  fireEvent.click(button); expect(container.querySelector('main')).toHaveAttribute('data-theme', 'dark');
  expect(button).toHaveAccessibleName('Switch theme'); expect(container.querySelectorAll('style')).toHaveLength(0);
});
