import { StrictMode, useEffect } from 'react';
import { render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { RelayClient, type SocketLike } from './RelayClient';
it('owns one active socket through StrictMode mount/cleanup/remount', () => {
    vi.useFakeTimers();
    const sockets: SocketLike[] = [];
    const closes: ReturnType<typeof vi.fn>[] = [];
    const client = new RelayClient({ origin: 'http://localhost', socketFactory: () => { const close = vi.fn(); closes.push(close); const s: SocketLike = { readyState: 0, bufferedAmount: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: vi.fn(), close }; sockets.push(s); return s; } });
    function Owner() { useEffect(() => { client.start({ roomId: 'main', peerId: 'peer', token: 'secret' }); return () => client.stop(); }, []); return null; }
    const view = render(<StrictMode><Owner /></StrictMode>);
    expect(sockets).toHaveLength(2);
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();
    view.unmount();
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
});
