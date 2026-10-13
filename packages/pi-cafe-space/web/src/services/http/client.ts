import axios from 'axios';
export interface RelayConfig {
    protocolVersion: 1;
    wsPath: '/ws';
    defaultRoom: string;
    managedSessions?: boolean;
    remoteAccess?: boolean;
    roomAccess?: boolean;
    accountLogin?: boolean;
    roomShare?: boolean;
    roomControl?: boolean;
    setupRequired?: boolean;
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid relay HTTP response'); return value as Record<string, unknown>; }
// No public arbitrary-URL/config interceptor and no token header. XHR-only
// avoids Node proxy/redirect adapters; callers may only cancel a fixed request.
export function createHttpClient() {
    const client = axios.create({ timeout: 5000, adapter: 'xhr', withCredentials: false, responseType: 'text', transformResponse: [], headers: { Accept: 'application/json' } });
    async function get(path: '/api/config' | '/healthz', signal?: AbortSignal): Promise<Record<string, unknown>> {
        const response = await client.get<string>(path, { signal });
        if (typeof response.data !== 'string' || response.data.length > 4096)
            throw new Error('Invalid relay HTTP response');
        return object(JSON.parse(response.data));
    }
    return {
        async config(signal?: AbortSignal): Promise<RelayConfig> { const d = await get('/api/config', signal); if (d.protocolVersion !== 1 || d.wsPath !== '/ws' || typeof d.defaultRoom !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(d.defaultRoom))
            throw new Error('Invalid relay config'); return { protocolVersion: 1, wsPath: '/ws', defaultRoom: d.defaultRoom, ...(d.managedSessions === true ? { managedSessions: true } : {}), ...(d.remoteAccess === true ? { remoteAccess: true } : {}), ...(d.setupRequired === true ? { setupRequired: true } : {}), ...(d.roomAccess === true ? { roomAccess: true } : {}), ...(d.accountLogin === true ? { accountLogin: true } : {}), ...(d.roomShare === true ? { roomShare: true } : {}), ...(d.roomControl === true ? { roomControl: true } : {}) }; },
        async health(signal?: AbortSignal): Promise<boolean> { const d = await get('/healthz', signal); if (d.ok !== true || d.protocolVersion !== 1)
            throw new Error('Invalid relay health'); return true; },
    };
}
