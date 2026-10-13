import { decodeBase64, encodeBase64 } from './framing';

export const testAccessKey = 'b'.repeat(43);
export const testPeerId = 'c'.repeat(43);
export class FakeRemoteWebSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onclose: ((event: {code:number}) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event:{data:unknown}) => void) | null = null;
  frames: Record<string,unknown>[] = [];
  closed = false;
  send(raw:string): void { if (this.readyState !== 1) throw Error('closed'); this.frames.push(JSON.parse(raw)); }
  close(): void { this.closed = true; this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  emit(frame:Record<string,unknown>): void { this.onmessage?.({data:JSON.stringify(frame)}); }
  end(code=1006): void { this.readyState=3; this.onclose?.({code}); }
  opened(role:'viewer'|'operator'|'admin'='operator',webRTC=false): void { this.emit({type:'opened',id:testPeerId,deviceId:'office',room:'main',userId:'alice',name:'Alice',role,webRTC,managed:true}); }
  selected(): void { this.emit({type:'selected',id:testPeerId,mode:'relay'}); }
  business(value:unknown): void { this.emit({type:'data',id:testPeerId,payload:encodeBase64(new TextEncoder().encode(JSON.stringify(value)))}); }
  data(): Record<string,any>[] { return this.frames.filter(frame=>frame.type==='data').map(frame=>JSON.parse(new TextDecoder().decode(decodeBase64(String(frame.payload))))); }
  presence(role:'viewer'|'operator'|'admin'='operator',leases:unknown[]=[]):void {
    this.business({type:'remote.presence',self:testPeerId,role,members:[{id:testPeerId,userId:'alice',name:'Alice',room:'main',role}],leases});
  }
  result(requestId:string,data?:unknown,code?:string):void { this.business({type:'remote.result',requestId,ok:!code,...code?{code}:{},...data===undefined?{}:{data}}); }
}
export const catalog = {user:{id:'alice',name:'Alice'},devices:[{id:'office',name:'Office computer',online:true,webRTC:false,rooms:[{id:'main',role:'admin'}]}]};
