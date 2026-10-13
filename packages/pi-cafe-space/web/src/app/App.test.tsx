import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { AppOwner } from './owner';
import { createRelayStorage } from '../services/relay/storage';
import { createI18n } from '../i18n';
import { I18nextProvider } from 'react-i18next';
import styles from './App.module.scss';

describe('isolated Web shell', () => {
  it('renders HashRouter and translated, styled UI without opening a socket', async () => {
    const websocket = vi.spyOn(globalThis, 'WebSocket');
    const i18n = createI18n();
    render(<I18nextProvider i18n={i18n}><App createOwner={() => new AppOwner({ storage: createRelayStorage(() => { throw Error('isolated storage'); }), http: { config: async () => ({ protocolVersion: 1, wsPath: '/ws', defaultRoom: 'main' }) } })} /></I18nextProvider>);
    expect(screen.getByRole('heading', { name: 'Pi Cafe Space' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '连接你的 Pi 工作空间' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('未连接');
    expect(screen.getByRole('main')).toHaveClass(styles.shell!);
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(await screen.findByRole('heading', { name: 'Connect to your Pi workspace' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Disconnected');
    expect(websocket).not.toHaveBeenCalled();
    websocket.mockRestore();
  });
});
