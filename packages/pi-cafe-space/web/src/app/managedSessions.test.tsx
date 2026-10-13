import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../i18n';
import { RelayClient, type SocketLike } from '../services/relay/RelayClient';
import { createRelayStorage } from '../services/relay/storage';
import { managedRequest, parseManagedInventory, type ManagedRequest, type ManagedSession } from '../services/http/workspace';
import fixture from '../../../protocol/fixtures/parts/ordered.json';
import { AppOwner } from './owner';
import { App } from './App';
vi.mock('../services/http/workspace', async importOriginal => ({ ...await importOriginal<typeof import('../services/http/workspace')>(), managedRequest: vi.fn() }));
class Socket implements SocketLike {
  readyState=1;bufferedAmount=0;onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((e:{data:unknown})=>void)|null=null;
  frames:string[]=[];send(value:string){this.frames.push(value);}close(){}emit(value:object){this.onmessage?.({data:JSON.stringify(value)});}
}
afterEach(()=>{vi.resetAllMocks();window.history.replaceState(null,'','/');});
async function mount(withHost=true){
  window.history.replaceState(null,'','/#/rooms/managed-test');
  const socket=new Socket();const sessions:ManagedSession[]=[];
  const inventory=()=>({projects:[{id:'project',name:'Allowed project',room:'managed-test',cwd:'C:/synthetic'}],sessions:[...sessions],maxActive:8});
  vi.mocked(managedRequest).mockImplementation(async(_token,q)=>{
    if(q.operation==='list')return inventory();
    if(q.operation==='create'){const record:ManagedSession={id:q.id,hostId:'managed-'+q.id,room:q.room,projectId:q.projectId,name:q.name,status:'starting'};sessions.push(record);return record;}
    const record=sessions.find(s=>s.id===q.id)!;record.status=q.operation==='close'?'stopped':'ready';return record;
  });
  const owner=new AppOwner({storage:createRelayStorage(()=>{throw Error('isolated');}),client:new RelayClient({origin:'http://localhost',socketFactory:()=>socket}),http:{config:async()=>({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',managedSessions:true})}});
  const i18n=createI18n();await i18n.changeLanguage('en');const app=render(<I18nextProvider i18n={i18n}><App createOwner={()=>owner}/></I18nextProvider>);
  fireEvent.change(await screen.findByLabelText('Client token'),{target:{value:'synthetic-client-token'}});fireEvent.click(screen.getByRole('button',{name:'Connect'}));
  const old={hostId:'h1',connected:true,ready:true,streamId:'stream',sessionId:'session',cwd:'C:/synthetic',sessionName:'Original working Pi'};
  await act(async()=>{socket.onopen?.();socket.emit({type:'welcome',protocolVersion:1,connectionId:'c',peerRole:'client',roomId:'managed-test',hostConnected:withHost});socket.emit({type:'host_status',hostId:withHost?'h1':null,connected:withHost,streamId:withHost?'stream':null,sessionId:withHost?'session':null,hosts:withHost?[old]:[]});if(withHost)socket.emit({type:'snapshot',hostId:'h1',snapshot:{...fixture.expectedFinal,phase:'running',sessionControl:true,inputAssist:true}});});
  await waitFor(()=>expect(vi.mocked(managedRequest).mock.calls.some(([,q])=>q.operation==='list')).toBe(true));
  return {...app,owner,socket,sessions,old,inventory};
}
async function create(){fireEvent.click(screen.getByRole('button',{name:'Start independent Pi instance'}));await screen.findByText('Allowed project');fireEvent.change(screen.getByLabelText('Session name'),{target:{value:'Independent Pi'}});const button=screen.getByRole('button',{name:'Create'});await act(async()=>{fireEvent.click(button);fireEvent.click(button);});}
it('creates independently while the original Pi is working; selects only after a new authoritative snapshot, retains room and original session',async()=>{
  const app=await mount();const original=app.owner.store.getSnapshot().hosts.get('h1')?.snapshot;
  fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'original draft'}});
  await create();const writes=vi.mocked(managedRequest).mock.calls.filter(([,q])=>q.operation==='create');expect(writes).toHaveLength(1);
  const request=writes[0]![1] as Extract<ManagedRequest,{operation:'create'}>;expect(Object.keys(request).sort()).toEqual(['id','name','operation','projectId','room']);
  expect(app.owner.store.getSnapshot().selectedHostId).toBe('h1');expect(screen.getByRole('textbox',{name:'Message'})).toHaveValue('original draft');expect(app.socket.frames.map(f=>JSON.parse(f)).some(m=>m.payload?.name==='new_session')).toBe(false);
  const record=app.sessions[0]!;record.status='ready';
  fireEvent.click(screen.getByRole('button',{name:'Refresh background sessions'}));
  await act(async()=>{app.socket.emit({type:'host_status',hostId:record.hostId,connected:true,streamId:'new-stream',sessionId:record.id,hosts:[app.old,{...app.old,hostId:record.hostId,streamId:'new-stream',sessionId:record.id,sessionName:record.name}]});app.socket.emit({type:'snapshot',hostId:record.hostId,snapshot:{...fixture.expectedFinal,phase:'idle',sessionId:record.id,streamId:'new-stream',sessionName:record.name,messages:[],tools:[]}});});
  await waitFor(()=>expect(app.owner.store.getSnapshot().selectedHostId).toBe(record.hostId));expect(app.owner.store.getSnapshot().hosts.get('h1')?.snapshot).toBe(original);expect(window.location.hash).toBe('#/rooms/managed-test');expect(screen.getByRole('textbox',{name:'Message'})).toHaveValue('');app.unmount();
});
it('works without any live client and closing requires explicit confirmation; unknown result is never retried',async()=>{
  const app=await mount(false);await create();expect(app.sessions).toHaveLength(1);expect(app.socket.frames.map(f=>JSON.parse(f)).some(m=>m.type==='command')).toBe(false);
  await screen.findByRole('button',{name:'Close instance'});fireEvent.click(screen.getByRole('button',{name:'Close instance'}));fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(vi.mocked(managedRequest).mock.calls.some(([,q])=>q.operation==='close')).toBe(false);
  vi.mocked(managedRequest).mockImplementation(async(_token,q)=>{if(q.operation==='list')return app.inventory();throw Error('RESULT_UNKNOWN');});
  fireEvent.click(screen.getByRole('button',{name:'Close instance'}));const buttons=screen.getAllByRole('button',{name:'Close instance'});await act(async()=>fireEvent.click(buttons.at(-1)!));expect(await screen.findByText(/Outcome unknown/)).toBeInTheDocument();expect(buttons.at(-1)).toBeDisabled();expect(vi.mocked(managedRequest).mock.calls.filter(([,q])=>q.operation==='close')).toHaveLength(1);app.unmount();
});
it('discards a late create result after logout and never replays the write',async()=>{
  const app=await mount();let resolve!:(value:unknown)=>void;let request:ManagedRequest|undefined;
  vi.mocked(managedRequest).mockImplementation(async(_token,q)=>{if(q.operation==='list')return app.inventory();request=q;return new Promise(yes=>{resolve=yes;});});
  await create();expect(request?.operation).toBe('create');
  await act(async()=>app.owner.logout());
  const q=request as Extract<ManagedRequest,{operation:'create'}>;
  await act(async()=>resolve({id:q.id,projectId:q.projectId,room:q.room,name:q.name,hostId:'managed-'+q.id,status:'ready'}));
  expect(screen.getByLabelText('Client token')).toBeInTheDocument();expect(screen.queryByRole('dialog')).not.toBeInTheDocument();expect(app.owner.store.getSnapshot().selectedHostId).toBeNull();
  expect(vi.mocked(managedRequest).mock.calls.filter(([,q])=>q.operation==='create')).toHaveLength(1);app.unmount();
});
it('validates inventory room, bounds, duplicates and host identity',()=>{
  const record={id:'12345678-1234-4123-8123-123456789abc',room:'r',projectId:'p',name:'name',hostId:'managed-12345678-1234-4123-8123-123456789abc',status:'ready'};
  expect(parseManagedInventory({projects:[],sessions:[record],maxActive:8},'r').sessions).toHaveLength(1);
  for(const sessions of [[{...record,room:'other'}],[{...record,hostId:'manual-host'}],[record,record],Array(101).fill(record)])expect(()=>parseManagedInventory({projects:[],sessions,maxActive:8},'r')).toThrow();
});
