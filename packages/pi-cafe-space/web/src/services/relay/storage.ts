import { nanoid } from 'nanoid';
const keys = { token: 'pi-collab-token', room: 'pi-collab-room', peer: 'pi-collab-peer-id', host: 'pi-collab-host-id' } as const;
type Key = keyof typeof keys;
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const limits: Record<Key, number> = { token: 4096, room: 64, peer: 128, host: 128 };
function valid(key: Key, value: string): boolean { return value.length > 0 && value.length <= limits[key] && (key !== 'room' || /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)); }
// Access is lazy: even reading window.sessionStorage may throw SecurityError.
export function createRelayStorage(access: () => StoragePort = () => window.sessionStorage) {
    const memory = new Map<Key, string | null>();
    const get = (key: Key): string | null => {
        if (memory.has(key))
            return memory.get(key) ?? null;
        try {
            const value = access().getItem(keys[key]);
            const safe = value !== null && valid(key, value) ? value : null;
            memory.set(key, safe);
            return safe;
        }
        catch {
            return null;
        }
    };
    const set = (key: Key, value: string): void => { if (!valid(key, value))
        throw new Error('Invalid stored relay setting'); memory.set(key, value); try {
        access().setItem(keys[key], value);
    }
    catch { /* memory is authoritative */ } };
    const remove = (key: Key): void => { memory.set(key, null); try {
        access().removeItem(keys[key]);
    }
    catch { /* do not resurrect an old token */ } };
    return { get, set, remove, peerId: () => { let id = get('peer'); if (!id) {
            id = nanoid();
            set('peer', id);
        } return id; }, logout: () => { remove('token'); remove('host'); } };
}
export type RelayStorage = ReturnType<typeof createRelayStorage>;
