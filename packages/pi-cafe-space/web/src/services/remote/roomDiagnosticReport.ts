import type { RoomProgress } from './RoomSocket';

const errors=new Set(['INVALID_ROOM_CREDENTIALS','ROOM_BROWSER_UNSUPPORTED','ROOM_SIGNAL_START_FAILED','ROOM_SIGNAL_POLICY_DENIED','ROOM_RANDOM_UNAVAILABLE','ROOM_INVALID_ORIGIN','ROOM_INITIALIZATION_FAILED','ROOM_SIGNAL_UNAVAILABLE','ROOM_SIGNAL_DISCONNECTED','ROOM_CONNECTION_INTERRUPTED','ROOM_ICE_NO_CANDIDATE','ROOM_ICE_CONNECTION_FAILED','ROOM_WEBRTC_NEGOTIATION_FAILED','ROOM_DTLS_FAILED','ROOM_SCTP_FAILED','ROOM_DATA_CHANNEL_FAILED','ROOM_TCP_RELAY_UNAVAILABLE','ROOM_CONNECTION_LOST','ROOM_BUSY','ROOM_PROTOCOL_ERROR','ROOM_PASSWORD_REJECTED','ROOM_OFFLINE','ROOM_IDENTITY_FAILED','ROOM_WEBRTC_UNAVAILABLE','ROOM_CONNECTION_TIMEOUT','INVALID_ROOM_DATA','ROOM_MESSAGE_TIMEOUT']);
const safe=(value:unknown,allow:readonly string[])=>typeof value==='string'&&allow.includes(value)?value:'unavailable';
const number=(value:unknown,max:number)=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=max?value:null;
const states=['new','checking','connecting','connected','completed','disconnected','failed','open','closing','closed','unavailable'];
export function roomDiagnosticReport(code:string|null|undefined,connection:string,progress:RoomProgress|null|undefined,compatible=false):string {
 const t=progress?.transport,i=progress?.initialization;
 return JSON.stringify({
  format:'cafe-room-diagnostic-v1',revision:'sctp-observe-20261004',
  error:code?(errors.has(code)?code:'UNKNOWN_ERROR'):null,
  connection:safe(connection,['stopped','connecting','reconnecting','authenticated','auth-failed']),
  stage:safe(progress?.stage,['signaling','gathering','waiting-office','identity','transport','password','synchronizing','connected']),
  mode:progress?.policy==='relay-tcp'||compatible?'TURN/TCP':'auto',
  browserRelayAvailable:progress?.localRelay===true,officeRelayAvailable:progress?.remoteRelay===true,
  iceErrorCode:number(progress?.iceErrorCode,999),signalCloseCode:number(progress?.signalCloseCode,4999),
  ...(i?{initialization:{step:safe(i.step,['runtime','random','credentials','origin','websocket']),exception:safe(i.exception,['Error','TypeError','RangeError','SyntaxError','SecurityError','NotSupportedError','InvalidStateError','AbortError','QuotaExceededError','OperationError','OtherError'])}}:{}),
  ...(t?{transport:{
   event:safe(t.event,['ice-state','peer-state','dtls-state','sctp-state','dtls-error','data-open','data-close','data-error','send-error','timeout']),
   elapsedMs:number(t.elapsedMs,600000),ice:safe(t.ice,states),peer:safe(t.peer,states),dtls:safe(t.dtls,states),sctp:safe(t.sctp,states),channel:safe(t.channel,states),channelOpened:t.channelOpened===true,
   errorDetail:safe(t.errorDetail,['data-channel-failure','dtls-failure','fingerprint-failure','sctp-failure']),
   sctpCauseCode:number(t.sctpCauseCode,65535),sentAlert:number(t.sentAlert,255),receivedAlert:number(t.receivedAlert,255)
  }}:{})
 },null,2);
}
