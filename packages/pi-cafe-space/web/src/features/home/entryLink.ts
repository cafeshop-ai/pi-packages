import { roomKeyFromInput } from '../../services/remote/roomCrypto';

/**
 * Where a pasted link belongs. Classification is purely local: it never sends the
 * input anywhere, and a collaboration invite can only ever route to the
 * collaboration page, never to the remote-device flow.
 */
export type EntryLink =
  | { kind: 'device'; path: string }
  | { kind: 'collab'; path: string }
  | { kind: 'invalid' };

const collabHash = /^#\/collab\/([a-f0-9]{32})(?:\?invite=([a-f0-9]{64}))?$/;

export function classifyEntryLink(input: string, origin: string): EntryLink {
  const value = input.trim();
  if (!value || value.length > 2048) return { kind: 'invalid' };
  const key = roomKeyFromInput(value, origin);
  if (key) return { kind: 'device', path: '/room/' + key };
  try {
    const url = new URL(value);
    if (url.origin !== new URL(origin).origin || url.username || url.password || url.search || url.pathname !== '/') return { kind: 'invalid' };
    const match = collabHash.exec(url.hash);
    if (!match) return { kind: 'invalid' };
    return { kind: 'collab', path: '/collab/' + match[1] + (match[2] ? '?invite=' + match[2] : '') };
  } catch {
    return { kind: 'invalid' };
  }
}
