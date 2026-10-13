import { useEffect, useRef, useState } from 'react';
import type { CommandPayload } from '../../../../../src/protocol/index';
import type { GatewayResult } from '../../../services/relay/CommandGateway';
import { childPath, parseDirectory, record } from '../../files/data';

export type CompletionRead = (payload: CommandPayload, signal: AbortSignal) => Promise<GatewayResult>;
export interface CompletionItem { value: string; label: string; description: string; directory?: boolean }
export function completionAt(text: string, cursor: number) {
  const before = text.slice(0, cursor);
  const slash = /^\/([^\s]*)$/.exec(before);
  if (slash) return { kind: 'command' as const, start: 0, end: cursor + (text.slice(cursor).match(/^\S*/)?.[0].length ?? 0), query: slash[1]!, directory: '.' };
  const file = /(?:^|\s)@(?:"([^"\r\n]*)|([^\s"@]*))$/.exec(before);
  if (!file) return null;
  const path = (file[1] ?? file[2] ?? '').replaceAll('\\', '/');
  const split = path.lastIndexOf('/');
  const quote = file[1] !== undefined ? text.indexOf('"', cursor) : -1;
  const end = quote >= 0 ? quote + 1 : cursor + (text.slice(cursor).match(/^[^\s"]*/)?.[0].length ?? 0);
  return { kind: 'file' as const, start: before.length - file[0].length + (file[0].startsWith('@') ? 0 : 1), end, query: path.slice(split + 1), directory: split < 0 ? '.' : path.slice(0, split) || '/' };
}
export function referencedFiles(text: string): string[] {
  return [...new Set([...text.matchAll(/(?:^|\s)@(?:"([^"\r\n]+)"|([^\s"@]+))/g)].map(m => (m[1] ?? m[2]!).replaceAll('\\', '/')))];
}
export function completedText(text: string, target: NonNullable<ReturnType<typeof completionAt>>, item: CompletionItem) {
  const inserted = target.kind === 'command' ? `/${item.value} ` : `@"${item.value}${item.directory ? '/' : '" '}`;
  return { text: text.slice(0, target.start) + inserted + text.slice(target.end), cursor: target.start + inserted.length };
}
export function useInputAssist({ text, cursor, enabled, scopeId, read, localCommands }: { text: string; cursor: number; enabled: boolean; scopeId: string; read?: CompletionRead; localCommands: CompletionItem[] }) {
  const target = enabled ? completionAt(text, cursor) : null;
  const request = useRef(read); request.current = read;
  const kind = target?.kind; const directory = target?.directory;
  const key = JSON.stringify([scopeId, kind, directory]);
  const [data, setData] = useState<{ key: string; items: CompletionItem[]; error?: string; truncated?: boolean } | null>(null);
  useEffect(() => {
    if (!kind || !request.current) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void request.current!(kind === 'command' ? { name: 'list_commands' } : { name: 'list_dir', path: directory! }, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        if (result.status !== 'applied') { setData({ key, items: [], error: result.code ?? 'COMMAND_ERROR' }); return; }
        let items: CompletionItem[] = [];
        let truncated = false;
        if (kind === 'command') {
          const value = record(result.data); truncated = value?.truncated === true;
          if (Array.isArray(value?.commands)) items = value.commands.flatMap(entry => {
            const c = record(entry);
            return c && typeof c.name === 'string' && typeof c.description === 'string' ? [{ value: c.name, label: '/' + c.name, description: c.description }] : [];
          });
        } else {
          const value = parseDirectory(result.data); truncated = value?.truncated === true;
          items = value?.entries.flatMap(entry => {
            const path = childPath(directory!, entry.name);
            return path && path.length <= 4096 && entry.kind !== 'link' && !/["\u0000-\u001f\u007f]/.test(path) ? [{ value: path, label: entry.name + (entry.kind === 'directory' ? '/' : ''), description: path, directory: entry.kind === 'directory' }] : [];
          }) ?? [];
        }
        setData({ key, items, truncated });
      }).catch(() => { if (!controller.signal.aborted) setData({ key, items: [], error: 'COMMAND_ERROR' }); });
    }, 120);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, kind, directory]);
  const current = data?.key === key ? data : null;
  const all = [...(kind === 'command' ? localCommands : []), ...(current?.items ?? []).filter(item => kind !== 'command' || !localCommands.some(local => local.value === item.value))];
  const matches = target ? all.filter(item => (item.label + ' ' + item.description).toLocaleLowerCase().includes(target.query.toLocaleLowerCase())) : [];
  return { target, items: matches.slice(0, 30), loading: !!target && !current, error: current?.error, truncated: current?.truncated || matches.length > 30 };
}
