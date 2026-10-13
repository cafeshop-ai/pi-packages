import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { App } from './App';
import { AppOwner } from './owner';
import { createI18n } from '../i18n';
import { createRelayStorage } from '../services/relay/storage';
import { RemoteAccess } from '../services/remote/RemoteAccess';
import { catalog, FakeRemoteWebSocket, testAccessKey, testPeerId } from '../services/remote/testSocket';
import type { RemoteRole } from '../services/remote/RemoteSocket';

afterEach(()=>{cleanup();sessionStorage.clear();window.location.hash='';});
async function mount(role:RemoteRole) {
  window.location.hash='#/rooms/main';const ws=new FakeRemoteWebSocket();
  const remote=new RemoteAccess({discover:async()=>({...catalog,devices:catalog.devices.map(d=>({...d,rooms:[{id:'main',role}]}))}),socketOptions:{origin:'http://localhost',socketFactory:()=>ws as unknown as WebSocket}});
  const owner=new AppOwner({remote,storage:createRelayStorage(()=>{throw Error('isolated');}),http:{config:async()=>({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',remoteAccess:true,managedSessions:true})}});
  const i18n=createI18n();await i18n.changeLanguage('en');
  const app=render(<I18nextProvider i18n={i18n}><App createOwner={()=>owner}/></I18nextProvider>);
  fireEvent.change(await screen.findByLabelText('Access key'),{target:{value:testAccessKey}});
  fireEvent.click(screen.getByRole('button',{name:'Find my computers'}));
  fireEvent.click(await screen.findByRole('button',{name:'Connect to computer'}));
  const hosts=['pi-a','pi-b'].map(hostId=>({hostId,connected:true,ready:true,streamId:'stream-'+hostId,sessionId:'session-'+hostId,cwd:'/fixture/project',sessionName:hostId}));
  await act(async()=>{
    ws.open();ws.opened(role);ws.selected();
    ws.business({type:'welcome',protocolVersion:1,connectionId:'cloud-fixture',peerRole:'client',roomId:'main',hostConnected:true});
    ws.business({type:'host_status',connected:true,streamId:'stream-pi-a',sessionId:'session-pi-a',hostId:'pi-a',hosts});
    for(const host of hosts)ws.business({type:'snapshot',hostId:host.hostId,snapshot:{protocolVersion:1,streamId:host.streamId,sessionId:host.sessionId,sessionName:host.sessionName,cwd:host.cwd,activeLeafId:'leaf',model:null,thinkingLevel:'off',phase:'idle',hasPendingMessages:false,sessionControl:true,messages:[{id:'message-'+host.hostId,role:'assistant',text:'Synthetic conversation '+host.hostId,thinking:'',status:'complete',timestamp:1,toolName:null,toolCallId:null}],tools:[],lastEventSeq:0,historyTruncated:false}});
    ws.presence(role);
  });
  expect({connection:owner.client.getState(),remote:owner.remote.getSnapshot(),hosts:[...owner.store.getSnapshot().hosts.keys()],notices:owner.store.getSnapshot().notices}, JSON.stringify({remote:owner.remote.getSnapshot(),notices:owner.store.getSnapshot().notices})).toMatchObject({connection:{status:'authenticated'},hosts:['pi-a','pi-b']});
  fireEvent.click(screen.getByRole('button',{name:/pi-a/,pressed:false}));
  await screen.findByLabelText('Message');
  // Satisfy the normal background-session inventory read; no native manager or
  // provider is called by this UI fixture.
  await act(async()=>{for(const q of ws.data())if(q.type==='remote.workspace')ws.result(q.requestId,{projects:[],sessions:[],maxActive:8});});
  return{app,owner,ws};
}
it('connects a remote computer, shows two Pi instances and sends only after acquiring control',async()=>{
  const{owner,ws}=await mount('operator');
  expect(screen.getByText('Office computer')).toBeInTheDocument();expect(screen.getByText('Cloud relay')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:/pi-a/,pressed:true})).toBeInTheDocument();expect(screen.getByRole('button',{name:/pi-b/,pressed:false})).toBeInTheDocument();
  expect(screen.getByLabelText('Message')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Message'),{target:{value:'One remote task'}});
  expect(ws.data().some(q=>q.type==='remote.control')).toBe(false);
  fireEvent.click(screen.getByRole('button',{name:'Send'}));
  const take=ws.data().find(q=>q.type==='remote.control'&&q.action==='acquire')!;expect(take.hostId).toBe('pi-a');expect(take.force).toBeUndefined();
  await act(async()=>ws.result(take.requestId));
  expect(ws.data().filter(q=>q.type==='command'&&q.payload.name==='prompt')).toHaveLength(0);
  await act(async()=>ws.presence('operator',[{hostId:'pi-a',holder:testPeerId,userId:'alice',name:'Alice',expiresAt:Date.now()+30000}]));
  await waitFor(()=>expect(ws.data().filter(q=>q.type==='command'&&q.payload.name==='prompt')).toHaveLength(1));
  const prompts=ws.data().filter(q=>q.type==='command'&&q.payload.name==='prompt');expect(prompts).toHaveLength(1);expect(prompts[0]).toMatchObject({targetHostId:'pi-a',expectedSessionId:'session-pi-a',expectedStreamId:'stream-pi-a',expectedCwd:'/fixture/project'});
  await act(async()=>ws.business({type:'command_result',hostId:'pi-a',requestId:prompts[0]!.requestId,status:'dispatched',code:null,message:null}));
  fireEvent.click(screen.getByRole('button',{name:/pi-b/,pressed:false}));await waitFor(()=>expect(screen.getByLabelText('Message')).toBeEnabled());expect(ws.data().filter(q=>q.type==='remote.control'&&q.action==='acquire')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button',{name:'Switch computer'}));await screen.findByLabelText('Access key');expect(ws.closed).toBe(true);expect(owner.remote.getSnapshot().members).toHaveLength(0);
});
it('a control conflict preserves the draft and never sends or retries a task',async()=>{
 const{ws}=await mount('operator');const input=screen.getByLabelText('Message');fireEvent.change(input,{target:{value:'Keep my draft'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));
 const q=ws.data().find(q=>q.type==='remote.control')!;await act(async()=>ws.result(q.requestId,undefined,'CONTROL_BUSY'));
 await screen.findByText(/Another device controls this Pi/);expect(input).toHaveValue('Keep my draft');expect(ws.data().filter(q=>q.type==='command'&&q.payload.name==='prompt')).toHaveLength(0);expect(ws.data().filter(q=>q.type==='remote.control')).toHaveLength(1);
});
it('switching Pi while control is pending does not deliver the old draft to either Pi',async()=>{
 const{ws}=await mount('operator');fireEvent.change(screen.getByLabelText('Message'),{target:{value:'Old scope only'}});fireEvent.click(screen.getByRole('button',{name:'Send'}));const q=ws.data().find(q=>q.type==='remote.control')!;
 fireEvent.click(screen.getByRole('button',{name:/pi-b/,pressed:false}));await act(async()=>{ws.result(q.requestId);ws.presence('operator',[{hostId:'pi-a',holder:testPeerId,userId:'alice',name:'Alice',expiresAt:Date.now()+30000}]);});
 expect(ws.data().filter(q=>q.type==='command'&&q.payload.name==='prompt')).toHaveLength(0);expect(screen.getByRole('button',{name:/pi-b/,pressed:true})).toBeInTheDocument();
});
it('viewer can see native conversations but cannot take control or create sessions',async()=>{
  const{ws}=await mount('viewer');
  expect(screen.getByText('Synthetic conversation pi-a')).toBeInTheDocument();expect(screen.getByLabelText('Message')).toBeDisabled();
  expect(screen.queryByRole('button',{name:'Take control'})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:'New session'})).toBeDisabled();
  expect(ws.data().filter(q=>q.type==='command'&&q.payload.name==='prompt')).toHaveLength(0);
});
it('does not show either credential form until server mode is known and allows a failed config retry',async()=>{
  const config=vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',remoteAccess:true});
  const i18n=createI18n();await i18n.changeLanguage('en');
  render(<I18nextProvider i18n={i18n}><App createOwner={()=>new AppOwner({storage:createRelayStorage(()=>{throw Error('isolated');}),http:{config}})}/></I18nextProvider>);
  expect(screen.queryByLabelText('Access key')).not.toBeInTheDocument();expect(screen.queryByLabelText('Client token')).not.toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button',{name:'Retry'}));await screen.findByLabelText('Access key');expect(config).toHaveBeenCalledTimes(2);
  await waitFor(()=>expect(screen.queryByLabelText('Client token')).not.toBeInTheDocument());
});
