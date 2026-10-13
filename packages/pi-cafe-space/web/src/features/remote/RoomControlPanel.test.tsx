import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { AppOwner } from '../../app/owner';
import { createI18n } from '../../i18n';
import { RoomControlPanel, useRoomControlOwner } from './RoomControlPanel';
import { roomControlRequest, type OwnerControlState } from '../../services/http/roomControl';
vi.mock('../../services/http/roomControl',async original=>({...await original<typeof import('../../services/http/roomControl')>(),roomControlRequest:vi.fn()}));
const read=vi.mocked(roomControlRequest);const owners:AppOwner[]=[];
afterEach(()=>{owners.splice(0).forEach(o=>o.dispose());vi.resetAllMocks();vi.useRealTimers();});
const initial:OwnerControlState={version:1,enabled:false,revision:1,requestLifetimeSeconds:90,requests:[],leases:[]};
async function mount(){const owner=new AppOwner();owners.push(owner);owner.storage.set('token','synthetic-local-token');const i18n=createI18n();await i18n.changeLanguage('en');function Harness(){const control=useRoomControlOwner(owner,true);return <RoomControlPanel owner={owner} control={control} trigger={document.createElement('button')} onClose={()=>{}}/>;}return render(<I18nextProvider i18n={i18n}><Harness/></I18nextProvider>);}
it('requires explicit confirmation to change the default-off setting',async()=>{
 read.mockResolvedValue(initial);await mount();const toggle=await screen.findByRole('switch',{name:'Require owner approval'});await waitFor(()=>expect(toggle).not.toBeDisabled());expect(toggle).not.toBeChecked();fireEvent.click(toggle);expect(read.mock.calls.every(call=>call[1].operation==='status')).toBe(true);
 read.mockResolvedValue({...initial,enabled:true,revision:2});fireEvent.click(screen.getByRole('button',{name:'Confirm setting'}));await waitFor(()=>expect(read).toHaveBeenCalledWith('synthetic-local-token',{operation:'configure',enabled:true,revision:1},expect.any(AbortSignal)));
});
it('does not approve by rendering a pending request and targets only explicit clicked request',async()=>{
 const q={id:'q'.repeat(43),hostId:'pi-a',applicant:'p'.repeat(43),userId:'guest',name:'Guest example',room:'main',state:'pending' as const,createdAt:Date.now(),expiresAt:Date.now()+90000};
 read.mockResolvedValue({...initial,enabled:true,revision:2,requests:[q]});await mount();const approve=await screen.findByRole('button',{name:/^Approve$/});await waitFor(()=>expect(approve).not.toBeDisabled());expect(read.mock.calls.every(call=>call[1].operation==='status')).toBe(true);fireEvent.click(approve);await waitFor(()=>expect(read).toHaveBeenCalledWith('synthetic-local-token',{operation:'approve',applicationId:q.id,revision:2},expect.any(AbortSignal)));
});
it('an unconfirmed setting write never auto-retries and requires explicit refresh',async()=>{
 read.mockResolvedValue(initial);await mount();const toggle=await screen.findByRole('switch');await waitFor(()=>expect(toggle).not.toBeDisabled());fireEvent.click(toggle);read.mockRejectedValueOnce(Error('RESULT_UNKNOWN'));fireEvent.click(screen.getByRole('button',{name:'Confirm setting'}));expect(await screen.findByRole('alert')).toHaveTextContent('unconfirmed');expect(toggle).toBeDisabled();expect(read.mock.calls.filter(call=>call[1].operation==='configure')).toHaveLength(1);read.mockResolvedValue({...initial,enabled:true,revision:2});fireEvent.click(screen.getByRole('button',{name:'Refresh settings and requests'}));await waitFor(()=>expect(toggle).not.toBeDisabled());
});
it('remote/public config cannot enable the local owner control panel',async()=>{
 const owner=new AppOwner({http:{config:async()=>({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',remoteAccess:true,roomAccess:true,roomControl:true})}});owners.push(owner);await owner.initialize();expect(owner.roomControl).toBe(false);expect(read).not.toHaveBeenCalled();
});
