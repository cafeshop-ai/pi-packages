import { expect, it, vi } from 'vitest';
import { createHttpClient } from './client';
it('actually aborts the axios XHR adapter without sending a network request', async () => {
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => { });
    const abort = vi.spyOn(XMLHttpRequest.prototype, 'abort').mockImplementation(() => { });
    try {
        const controller = new AbortController();
        const promise = createHttpClient().health(controller.signal);
        const rejected = expect(promise).rejects.toMatchObject({ code: 'ERR_CANCELED' });
        expect(send).toHaveBeenCalledTimes(1);
        controller.abort();
        await rejected;
        expect(abort).toHaveBeenCalledTimes(1);
    }
    finally {
        send.mockRestore();
        abort.mockRestore();
    }
});
