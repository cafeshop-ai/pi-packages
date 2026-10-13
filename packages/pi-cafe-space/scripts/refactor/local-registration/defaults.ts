export type LocalConnection = { relayUrl: string; room: string; hostToken: string; clientToken: string };
export function localDefaults(connection: LocalConnection, env: Record<string, string | undefined>, flagRelay?: unknown, flagRoom?: unknown): Record<string, string> {
  const raw = env.PI_COLLAB_RELAY_URL;
  // Keep the candidate's raw-input limits and explicit endpoint choices.
  if ((typeof flagRelay === 'string' && flagRelay.length > 8192) || (raw !== undefined && raw.length > 8192)) return {};
  const flag = typeof flagRelay === 'string' && flagRelay.trim() ? flagRelay.trim() : undefined;
  const explicit = flag ?? raw?.trim();
  if (explicit && explicit !== connection.relayUrl) return {};
  const values: Record<string, string> = {};
  if (!flag && !raw?.trim()) values.PI_COLLAB_RELAY_URL = connection.relayUrl;
  if (env.PI_COLLAB_ROOM === undefined && flagRoom === undefined) values.PI_COLLAB_ROOM = connection.room;
  if (env.PI_COLLAB_HOST_TOKEN === undefined) values.PI_COLLAB_HOST_TOKEN = connection.hostToken;
  if (env.PI_COLLAB_CLIENT_TOKEN === undefined) values.PI_COLLAB_CLIENT_TOKEN = connection.clientToken;
  return values;
}
