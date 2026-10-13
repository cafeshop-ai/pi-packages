import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { AppOwner } from '../../app/owner';
import { createI18n } from '../../i18n';
import { RoomLogin } from './RoomEntry';
vi.mock('../../services/http/roomStatus', () => ({ roomOnline: vi.fn(async () => true) }));
const clipboardDescriptor=Object.getOwnPropertyDescriptor(navigator,'clipboard');
const owners:AppOwner[]=[];afterEach(()=>{owners.splice(0).forEach(o=>o.dispose());vi.restoreAllMocks();if(clipboardDescriptor)Object.defineProperty(navigator,'clipboard',clipboardDescriptor);else Reflect.deleteProperty(navigator,'clipboard');});
it.each([true,false])('copy diagnostics gives honest success/fallback feedback: %s',async success=>{
 const writeText=vi.fn((_:string)=>success?Promise.resolve():Promise.reject(Error('denied')));Object.defineProperty(navigator,'clipboard',{value:{writeText},configurable:true});
 const owner=new AppOwner();owners.push(owner);owner.roomFailure='ROOM_SCTP_FAILED';owner.roomLastProgress={stage:'transport',localRelay:true,remoteRelay:true,iceErrorCode:null,signalCloseCode:null,transport:{event:'data-error',elapsedMs:12900,ice:'connected',peer:'closed',dtls:'closed',sctp:'closed',channel:'closing',channelOpened:false,errorDetail:'sctp-failure'}};
 const i18n=createI18n();await i18n.changeLanguage('en');render(<I18nextProvider i18n={i18n}><RoomLogin owner={owner} roomKey={'B'+'A'.repeat(86)}/></I18nextProvider>);
 fireEvent.change(await screen.findByLabelText('Room password',{exact:true}),{target:{value:'SecretTyped42'}});expect(writeText).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Copy diagnostic log'}));
 await waitFor(()=>expect(writeText).toHaveBeenCalledOnce());const text=writeText.mock.calls[0]![0];expect(text).toContain('ROOM_SCTP_FAILED');expect(text).not.toContain('SecretTyped42');expect(text).not.toContain('B'+'A'.repeat(86));
 if(success)expect(await screen.findByRole('button',{name:'Diagnostic log copied'})).toBeInTheDocument();else{expect(await screen.findByLabelText('Diagnostic log text')).toHaveValue(text);expect(screen.queryByRole('button',{name:'Diagnostic log copied'})).not.toBeInTheDocument();}
});
it.each([['ROOM_PASSWORD_REJECTED','Incorrect room password.'],['ROOM_AUTH_BUSY','verifying another connection'],['ROOM_AUTH_RATE_LIMITED','many verification requests'],['ROOM_ACCESS_CHANGED','room link or password just changed']])('room entry explains %s without automatic retries',async(code,text)=>{
 const owner=new AppOwner();owners.push(owner);owner.roomFailure=code;const connect=vi.spyOn(owner,'connectRoomLink');const i18n=createI18n();await i18n.changeLanguage('en');render(<I18nextProvider i18n={i18n}><RoomLogin owner={owner} roomKey={'B'+'A'.repeat(86)}/></I18nextProvider>);await screen.findByLabelText('Room password',{exact:true});expect(document.body.textContent).toContain(text);expect(connect).not.toHaveBeenCalled();
});
it('compatibility mode is an explicit user choice passed to the room connection',async()=>{
 const owner=new AppOwner({http:{config:async()=>({protocolVersion:1,wsPath:'/ws',defaultRoom:'main',roomAccess:true,remoteAccess:true})}});owners.push(owner);await owner.initialize();
 const connect=vi.spyOn(owner,'connectRoomLink').mockImplementation(()=>{});const i18n=createI18n();await i18n.changeLanguage('en');
 const key='B'+'A'.repeat(86);render(<I18nextProvider i18n={i18n}><RoomLogin owner={owner} roomKey={key}/></I18nextProvider>);
 const choice=await screen.findByRole('checkbox',{name:'Compatibility connection (relay only)'});expect(choice).not.toBeChecked();
 fireEvent.change(screen.getByLabelText('Your nickname',{exact:true}),{target:{value:'拿铁'}});
 fireEvent.click(choice);expect(choice).toBeChecked();fireEvent.change(screen.getByLabelText('Room password',{exact:true}),{target:{value:'Synthetic42'}});fireEvent.click(screen.getByRole('button',{name:'Join room'}));
 expect(connect).toHaveBeenCalledExactlyOnceWith(key,'Synthetic42','relay-tcp','拿铁');expect(screen.getByLabelText('Room password',{exact:true})).toHaveValue('');expect(document.body.textContent).not.toContain('Synthetic42');
});
