import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../i18n';
import { WorkspaceLayout } from './WorkspaceLayout';
import { UiProvider } from '../components/ui/UiProvider';
it('uses the fixed 1440/1024/390 breakpoints and restores drawer focus with Escape/Tab trapping', async () => {
  const original = window.innerWidth;
  const i18n = createI18n(); await i18n.changeLanguage('en');
  const width = (value: number) => act(() => { Object.defineProperty(window, 'innerWidth', { configurable: true, value }); window.dispatchEvent(new Event('resize')); });
  width(1440);
  const { container, unmount } = render(<I18nextProvider i18n={i18n}><WorkspaceLayout sidebar={<button>host fixture</button>} files={<p>file fixture</p>}><p>conversation fixture</p></WorkspaceLayout></I18nextProvider>);
  try {
    expect(container.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'desktop');
    width(1024); expect(container.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'desktop');
    width(900); expect(container.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'tablet');
    width(390); expect(container.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'mobile');
    expect(screen.queryByText('host fixture')).toBeNull();
    const trigger = screen.getByRole('button', { name: 'Pi hosts' }); trigger.focus(); fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Pi hosts' });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); await waitFor(() => expect(trigger).toHaveFocus());
  } finally { unmount(); width(original); }
});
it('cycles only visible focusable controls, including closed details summaries', async () => {
  const original = window.innerWidth;
  const i18n = createI18n(); await i18n.changeLanguage('en');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  const { unmount } = render(<I18nextProvider i18n={i18n}><WorkspaceLayout sidebar={<>
    <button>host</button><details><summary>Settings</summary><input aria-label="Model" /><button>Apply</button></details>
    <button hidden>Hidden</button><div style={{ display: 'none' }}><button>CSS hidden</button></div><button disabled>Disabled</button><a href="#" tabIndex={-1}>Not tabbable</a>
  </>} files={<p>file</p>}><p>conversation</p></WorkspaceLayout></I18nextProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Pi hosts' }));
    const close = screen.getByRole('button', { name: 'Close' });
    const summary = screen.getByText('Settings');
    summary.focus(); expect(summary).toHaveFocus();
    fireEvent.keyDown(summary, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(summary).toHaveFocus();
    summary.parentElement!.setAttribute('open', '');
    const apply = screen.getByRole('button', { name: 'Apply' }); apply.focus();
    fireEvent.keyDown(apply, { key: 'Tab' }); expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true }); expect(apply).toHaveFocus();
  } finally { unmount(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: original }); }
});
it('shadcn sheet inherits Chinese/light context, hides background from AT and cleans up on unmount', async () => {
  const original = window.innerWidth; const i18n = createI18n();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  const { unmount } = render(<I18nextProvider i18n={i18n}><main lang="zh-CN" data-theme="light"><UiProvider><header><button>outside</button></header>
    <WorkspaceLayout sidebar={<button>host</button>} files={<p>file</p>}><p>conversation</p></WorkspaceLayout>
  </UiProvider></main></I18nextProvider>);
  try {
    fireEvent.click(screen.getByRole('button', { name: i18n.t('hosts') }));
    const dialog = screen.getByRole('dialog', { name: i18n.t('hosts') });
    expect(dialog).toHaveAttribute('data-open'); expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog.closest('[data-theme]')).toHaveAttribute('data-theme', 'light'); expect(dialog.closest('[lang]')).toHaveAttribute('lang', 'zh-CN');
    expect(screen.queryByRole('button', { name: 'outside' })).toBeNull();
    expect(document.querySelectorAll('style')).toHaveLength(0);
    unmount(); await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
    expect(document.querySelector('[data-base-ui-focus-guard]')).toBeNull();
  } finally { unmount(); Object.defineProperty(window, 'innerWidth', { configurable: true, value: original }); }
});
