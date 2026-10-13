import { afterEach, expect, it, vi } from 'vitest';
import { RemoteSocket, type RemoteSocketOptions } from './RemoteSocket';
import { FakeRemoteWebSocket, testAccessKey, testPeerId } from './testSocket';
import { MAX_BUSINESS_BYTES } from './framing';

const sockets:RemoteSocket[]=[];
afterEach(()=>{for(const socket of sockets)socket.close();sockets.length=0;vi.useRealTimers();});
function setup(extra:Partial<RemoteSocketOptions>={}) {
  const ws=new FakeRemoteWebSocket();const open=vi.fn(),message=vi.fn(),end=vi.fn();
  const socket=new RemoteSocket({token:testAccessKey,deviceId:'office',roomId:'main',mode:'relay',origin:'https://cafe.example',socketFactory:()=>ws as unknown as WebSocket,onEnd:end,...extra});
  socket.onopen=open;socket.onmessage=message;sockets.push(socket);return{socket,ws,open,message,end};
}
it('waits for route acknowledgement and does not forward the reusable access key to Pi',()=>{
  const {socket,ws,open,message}=setup();ws.open();expect(ws.frames[0]).toMatchObject({type:'connect',token:testAccessKey,deviceId:'office'});
  ws.opened();expect(open).not.toHaveBeenCalled();expect(socket.readyState).toBe(0);
  expect(()=>socket.send('{}')).toThrow('NOT_CONNECTED');
  ws.selected();expect(open).toHaveBeenCalledOnce();
  socket.send(JSON.stringify({type:'hello',token:testAccessKey,roomId:'main',peerRole:'client'}));
  expect(ws.data()[0]?.token).toBe('remote-session');
  expect(JSON.stringify(ws.data())).not.toContain(testAccessKey);
  ws.business({type:'welcome',roomId:'main'});expect(message).toHaveBeenCalledOnce();
});
it('falls back from failed WebRTC before business, but never replays or changes a live route',async()=>{
  const {socket,ws,end}=setup({mode:'auto',peerFactory:()=>{throw Error('unavailable');}});
  ws.open();ws.opened('operator',true);await Promise.resolve();await Promise.resolve();
  expect(ws.frames.filter(f=>f.type==='select')).toEqual([{type:'select',id:testPeerId,mode:'relay'}]);
  ws.selected();socket.send(JSON.stringify({type:'command',requestId:'once'}));
  ws.end();expect(ws.data()).toHaveLength(1);expect(socket.readyState).toBe(3);expect(end).toHaveBeenCalledOnce();
  expect(()=>socket.send(JSON.stringify({type:'command',requestId:'once'}))).toThrow();
});
it('WebRTC-only mode fails closed instead of silently sending data through cloud relay',async()=>{
  const {socket,ws}=setup({mode:'webrtc',peerFactory:()=>{throw Error('unavailable');}});
  ws.open();ws.opened('operator',true);await Promise.resolve();await Promise.resolve();
  expect(socket.readyState).toBe(3);expect(ws.frames.some(f=>f.type==='select')).toBe(false);expect(ws.data()).toHaveLength(0);
});
it('rejects a different device/room identity and oversized incoming frames',()=>{
  const one=setup();one.ws.open();one.ws.emit({type:'opened',id:testPeerId,deviceId:'other',room:'main',userId:'alice',name:'Alice',role:'admin'});
  expect(one.socket.readyState).toBe(3);
  const two=setup();two.ws.open();two.ws.opened();two.ws.selected();
  two.ws.onmessage?.({data:'x'.repeat(512*1024+1)});expect(two.socket.readyState).toBe(3);
});
it('enforces budgets and reports an authentication close without exposing secrets',()=>{
  const one=setup();one.ws.open();one.ws.opened();one.ws.selected();
  expect(()=>one.socket.send(JSON.stringify({type:'x',data:'a'.repeat(MAX_BUSINESS_BYTES)}))).toThrow('MESSAGE_TOO_LARGE');
  one.ws.bufferedAmount=2*1024*1024;
  expect(()=>one.socket.send(JSON.stringify({type:'command',requestId:'budget'}))).toThrow();
  const two=setup();two.ws.open();two.ws.end(4003);
  expect(two.message.mock.calls[0]?.[0].data).toContain('UNAUTHORIZED');
  expect(JSON.stringify(two.message.mock.calls)).not.toContain(testAccessKey);
});
it('does not deliver a late response after explicit close',()=>{
  const {socket,ws,message}=setup();ws.open();ws.opened();ws.selected();socket.close();ws.business({type:'event'});
  expect(message).not.toHaveBeenCalled();expect(ws.closed).toBe(true);
});
