import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../i18n';
import { AppOwner } from '../../app/owner';
import { RoomShare } from './RoomShare';
import { roomShareRequest } from '../../services/http/roomShare';
import type { RoomControlOwner } from './RoomControlPanel';
vi.mock('../../services/http/roomShare',async original=>({...await original<typeof import('../../services/http/roomShare')>(),roomShareRequest:vi.fn()}));
const request=vi.mocked(roomShareRequest),key='B'+'A'.repeat(86),url='https://space.example/#/room/'+key;
const info={roomKey:key,url,name:'Office room',online:true,revision:1,visitorRole:'operator' as const};
const owners:AppOwner[]=[],clipboardDescriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
afterEach(()=>{owners.splice(0).forEach(o=>o.dispose());vi.resetAllMocks();if(clipboardDescriptor)Object.defineProperty(navigator,'clipboard',clipboardDescriptor);else Reflect.deleteProperty(navigator,'clipboard');});
async function mount(settings=false,remote=false){
 const owner=new AppOwner();owner.roomControl=true;owner.publicRoomMode=remote;owners.push(owner);owner.storage.set('token','private-local-token');
 const control:RoomControlOwner={data:{version:1,enabled:false,revision:1,requestLifetimeSeconds:90,requests:[],leases:[]},error:'',busy:false,uncertain:false,run:vi.fn(async()=>true)};
 request.mockResolvedValue(info);const i18n=createI18n();await i18n.changeLanguage('en');
 render(<I18nextProvider i18n={i18n}><RoomShare owner={owner} control={control} initialTab={settings?'settings':'share'} trigger={document.createElement('button')} onClose={()=>{}}/></I18nextProvider>);
 await waitFor(()=>expect(screen.getByRole('tab',{name:'Share'})).not.toBeDisabled());await waitFor(()=>expect(request).toHaveBeenCalled());return{control,owner};
}
it('share is primary and room settings stay in the same dialog without hidden write effects',async()=>{
 const {control}=await mount();expect(screen.getAllByRole('dialog')).toHaveLength(1);expect(screen.getByRole('tabpanel',{name:'Share'})).toBeVisible();expect(screen.queryByRole('switch')).toBeNull();expect(screen.queryByRole('button',{name:'Reset room link'})).toBeNull();
 fireEvent.keyDown(screen.getByRole('tab',{name:'Share'}),{key:'ArrowRight'});expect(screen.getByRole('tab',{name:'Room settings'})).toHaveFocus();expect(screen.getByRole('switch',{name:'Require owner approval'})).not.toBeChecked();expect(screen.getAllByRole('dialog')).toHaveLength(1);expect(control.run).not.toHaveBeenCalled();expect(request.mock.calls.every(c=>c[1].operation==='status')).toBe(true);
 fireEvent.click(screen.getByRole('tab',{name:'Share'}));fireEvent.click(screen.getByRole('button',{name:/Room settings.*Approval off/}));expect(screen.getByRole('tabpanel',{name:'Room settings'})).toBeVisible();
});
it.each([true,false])('copy is explicit, exact-link only and reports success honestly: %s',async ok=>{
 const writeText=vi.fn(()=>ok?Promise.resolve():Promise.reject(Error('denied')));Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText}});await mount();expect(writeText).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Copy link'}));await waitFor(()=>expect(writeText).toHaveBeenCalledWith(url));expect(JSON.stringify(writeText.mock.calls)).not.toContain('private-local-token');expect(await screen.findByText(ok?'Room link copied.':'Clipboard unavailable. Select and copy the link above.')).toBeVisible();
});
it('opening settings/reset or cancelling a password draft does not mutate anything',async()=>{
 await mount(true);fireEvent.click(screen.getByRole('button',{name:'Change room password'}));fireEvent.change(screen.getByLabelText('New room password',{exact:true}),{target:{value:'PrivateDraft42'}});fireEvent.click(screen.getByRole('tab',{name:'Share'}));fireEvent.click(screen.getByRole('tab',{name:'Room settings'}));expect(screen.queryByLabelText('New room password',{exact:true})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Reset room link'}));fireEvent.click(screen.getByRole('button',{name:'Cancel'}));expect(screen.queryByRole('button',{name:'Confirm link reset'})).toBeNull();expect(request.mock.calls.every(c=>c[1].operation==='status')).toBe(true);
});
it('unconfirmed reset hides the potentially stale QR and requires a read refresh',async()=>{
 await mount(true);fireEvent.click(screen.getByRole('button',{name:'Reset room link'}));request.mockRejectedValueOnce(Error('RESULT_UNKNOWN'));fireEvent.click(screen.getByRole('button',{name:'Confirm link reset'}));await screen.findByRole('alert');fireEvent.click(screen.getByRole('tab',{name:'Share'}));expect(screen.getByRole('button',{name:'Copy link'})).toBeDisabled();expect(screen.getByText('Refresh room information to show the QR code')).toBeVisible();expect(document.querySelector('svg title')?.textContent).not.toBe('Room QR code');request.mockResolvedValue(info);fireEvent.click(screen.getByRole('button',{name:'Refresh room information'}));await waitFor(()=>expect(screen.getByRole('button',{name:'Copy link'})).not.toBeDisabled());expect(request.mock.calls.filter(c=>c[1].operation==='reset-link')).toHaveLength(1);
});
it('public-room context cannot obtain owner approval controls from an injected prop',async()=>{
 const {control}=await mount(true,true);expect(screen.queryByRole('switch')).toBeNull();expect(control.run).not.toHaveBeenCalled();
});
