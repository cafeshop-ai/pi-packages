export type RoomConnectionPolicy = 'auto' | 'relay-tcp';
export type RoomTransportEvent = 'ice-state' | 'peer-state' | 'dtls-state' | 'sctp-state' | 'dtls-error' | 'data-open' | 'data-close' | 'data-error' | 'send-error' | 'timeout';
export interface RoomTransportDiagnostic {
  event: RoomTransportEvent; elapsedMs: number;
  ice: string; peer: string; dtls: string; sctp: string; channel: string; channelOpened: boolean;
  errorDetail?: string; sctpCauseCode?: number; sentAlert?: number; receivedAlert?: number;
}
const state = (value: unknown, allowed: string[]): string => typeof value === 'string' && allowed.includes(value) ? value : 'unavailable';
export function roomPeerConfiguration(servers: RTCIceServer[], policy: RoomConnectionPolicy): RTCConfiguration {
  if (policy === 'auto') return { iceServers: servers };
  if (policy !== 'relay-tcp') throw Error('INVALID_ROOM_TRANSPORT_POLICY');
  const iceServers = servers.map(server => ({ ...server, urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(url => /^(turn|turns):[^\s]+\?transport=tcp$/i.test(url)) })).filter(server => server.urls.length);
  if (!iceServers.length) throw Error('ROOM_TCP_RELAY_UNAVAILABLE');
  return { iceTransportPolicy: 'relay', iceServers };
}
export function captureRoomTransport(pc: RTCPeerConnection | null, dc: RTCDataChannel | null, event: RoomTransportEvent, channelOpened: boolean, elapsedMs: number, error?: unknown): RoomTransportDiagnostic {
  const result: RoomTransportDiagnostic = {
    event, elapsedMs: Math.max(0,Math.min(600000,Math.round(elapsedMs))),
    ice: state(pc?.iceConnectionState,['new','checking','connected','completed','disconnected','failed','closed']),
    peer: state(pc?.connectionState,['new','connecting','connected','disconnected','failed','closed']),
    dtls: state(pc?.sctp?.transport?.state,['new','connecting','connected','failed','closed']),
    sctp: state(pc?.sctp?.state,['connecting','connected','closed']),
    channel: state(dc?.readyState,['connecting','open','closing','closed']),channelOpened,
  };
  // Preserve only standard machine-readable fields, never message/name/stack.
  try {
    if (error && typeof error === 'object') {
      const e = error as Record<string,unknown>;
      if (typeof e.errorDetail === 'string' && ['data-channel-failure','dtls-failure','fingerprint-failure','sctp-failure'].includes(e.errorDetail)) result.errorDetail=e.errorDetail;
      for (const name of ['sctpCauseCode','sentAlert','receivedAlert'] as const) {
        const value=e[name];if(typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=(name==='sctpCauseCode'?65535:255))result[name]=value;
      }
    }
  } catch { /* Host errors are diagnostic data, not application exceptions. */ }
  return result;
}
export function roomTransportFailure(diagnostic: RoomTransportDiagnostic): string {
  if (diagnostic.errorDetail === 'dtls-failure' || diagnostic.errorDetail === 'fingerprint-failure' || diagnostic.dtls === 'failed') return 'ROOM_DTLS_FAILED';
  if (diagnostic.ice === 'failed') return 'ROOM_ICE_CONNECTION_FAILED';
  if (diagnostic.errorDetail === 'sctp-failure' || diagnostic.dtls === 'connected' && diagnostic.sctp === 'closed') return 'ROOM_SCTP_FAILED';
  return 'ROOM_DATA_CHANNEL_FAILED';
}
