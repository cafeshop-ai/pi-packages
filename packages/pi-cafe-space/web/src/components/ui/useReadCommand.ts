import { useEffect, useRef, useState } from 'react';
import type { AppOwner } from '../../app/owner';
import { scopeKey, type HostScope } from '../../state/CollabStore';
import type { CommandPayload } from '../../../../src/protocol/index';
type ReadCommand = Extract<CommandPayload, { name: 'list_dir' | 'read_file' | 'list_sessions' | 'get_session' }>;
export function useReadCommand(owner: AppOwner, scope: HostScope | null) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const serial = useRef(0); const controller = useRef<AbortController | null>(null);
  const key = scope ? scopeKey(scope) : '';
  useEffect(() => {
    setError(null); setLoading(false);
    return () => { serial.current++; controller.current?.abort(); };
  }, [key, owner]);
  const run = async (payload: ReadCommand) => {
    const version = ++serial.current; controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setError(null); setLoading(true);
    try {
      if (!scope) { setError('HOST_REQUIRED'); return; }
      const result = await owner.gateway.execute(payload, scope, { signal: abort.signal });
      if (version === serial.current && result.status !== 'applied') setError(result.code ?? 'COMMAND_ERROR');
    } catch { if (version === serial.current) setError('READ_FAILED'); }
    finally { if (version === serial.current) setLoading(false); }
  };
  return { error, loading, run };
}
