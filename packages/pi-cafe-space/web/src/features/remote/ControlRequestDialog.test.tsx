import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi, beforeEach } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../i18n';
import type { AppOwner } from '../../app/owner';
import type { RemoteState } from '../../services/remote/RemoteAccess';
import { ControlRequestDialog } from './ControlRequestDialog';
let state:RemoteState;
vi.mock('../../services/remote/useRemoteState',()=>({useRemoteState:()=>state}));
beforeEach(()=>{state={enabled:true,phase:'ready',deviceId:'room',deviceName:'Room',mode:'webrtc',route:'webrtc',info:{id:'c'.repeat(43),userId:'guest',deviceId:'room',roomId:'main',name:'Room',role:'operator',managed:false},members:[],leases:[],error:null,controlPolicy:'approval',controlRequests:[]};});
async function setup(){const control=vi.fn(async()=>undefined),cancel=vi.fn(async()=>undefined),execute=vi.fn();const owner={execute,remote:{control,cancelControl:cancel,canWrite:()=>state.controlPolicy==='disabled'||state.leases.length>0}} as unknown as AppOwner;const i18n=createI18n();await i18n.changeLanguage('en');const onClose=vi.fn();const view=()=> <I18nextProvider i18n={i18n}><ControlRequestDialog owner={owner} hostId="pi-a" hostLabel="Example Pi" available restoreFocusTo={null} onClose={onClose}/></I18nextProvider>;return{...render(view()),control,cancel,execute,view,onClose};}
it('opens without sending a request, requires explicit click, and approval never sends a message',async()=>{
 const f=await setup();expect(screen.getByRole('dialog')).toHaveAccessibleName('Owner approval required');expect(f.control).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Request control'}));await waitFor(()=>expect(f.control).toHaveBeenCalledExactlyOnceWith('pi-a','acquire'));
 const q={id:'q'.repeat(43),hostId:'pi-a',applicant:state.info!.id,userId:'guest',name:'Guest#12345678',room:'main',state:'pending' as const,createdAt:1,expiresAt:Date.now()+90000};state={...state,controlRequests:[q]};f.rerender(f.view());expect(screen.getByRole('dialog')).toHaveAccessibleName('Waiting for owner approval');expect(screen.queryByRole('button',{name:'Request control'})).toBeNull();
 state={...state,controlRequests:[{...q,state:'approved'}],leases:[{hostId:'pi-a',holder:state.info!.id,userId:'guest',name:q.name,expiresAt:Date.now()+30000}]};f.rerender(f.view());expect(screen.getByRole('dialog')).toHaveAccessibleName('Control approved');expect(f.execute).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Back to conversation'}));expect(f.onClose).toHaveBeenCalledOnce();
});
it('unknown request outcomes do not create automatic retries',async()=>{const f=await setup();f.control.mockRejectedValueOnce(Error('RESULT_UNKNOWN'));fireEvent.click(screen.getByRole('button',{name:'Request control'}));await screen.findByRole('alert');expect(screen.getByRole('button',{name:'Request control'})).toBeDisabled();expect(f.control).toHaveBeenCalledOnce();expect(f.execute).not.toHaveBeenCalled();});
it('disabled policy or disconnection cannot submit a control request',async()=>{const f=await setup();state={...state,controlPolicy:'disabled'};f.rerender(f.view());expect(screen.queryByRole('button',{name:'Request control'})).toBeNull();state={...state,controlPolicy:'approval',phase:'disconnected',info:null};f.rerender(f.view());expect(screen.getByRole('dialog')).toHaveAccessibleName('Connection interrupted');expect(f.control).not.toHaveBeenCalled();});
