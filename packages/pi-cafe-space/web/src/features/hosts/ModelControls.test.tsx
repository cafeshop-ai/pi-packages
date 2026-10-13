import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../i18n';
import { UiProvider } from '../../components/ui/UiProvider';
import { ModelControls } from './ModelControls';
import type { AppOwner } from '../../app/owner';
let state:any;
type ChoiceProps = Parameters<typeof import('../../components/ui/ChoiceSelect').ChoiceSelect>[0];
let choiceProps: ChoiceProps;
// JSDOM has no popup geometry. Keep the real trigger, exercise the same
// selection callback here, and test open/select/focus with the browser suite.
vi.mock('../../components/ui/ChoiceSelect',async importOriginal=>{
 const original=await importOriginal<typeof import('../../components/ui/ChoiceSelect')>();
 return {...original,ChoiceSelect:(props:ChoiceProps)=>{choiceProps=props;return <original.ChoiceSelect {...props}/>;}};
});
vi.mock('../../state/useCollabStore',()=>({useCollabStore:(_store:unknown,select:(s:any)=>unknown)=>select(state)}));
beforeEach(()=>{state={selectedHostId:'pi-a',connection:{status:'authenticated'},hosts:new Map([['pi-a',{stale:false,info:{connected:true,ready:true},snapshot:{model:{provider:'cafeshop',id:'gemini-3.8-flash',reasoning:false,thinkingLevels:['off']},thinkingLevel:'off'}}]])};});
async function show(){const execute=vi.fn(async()=>({status:'applied',code:null as string|null}));const owner={store:{scope:()=>({hostId:'pi-a',streamId:'s',sessionId:'session',cwd:'/test'})},execute} as unknown as AppOwner;const i18n=createI18n();await i18n.changeLanguage('en');render(<UiProvider><I18nextProvider i18n={i18n}><ModelControls owner={owner} readOnly={false} expanded/></I18nextProvider></UiProvider>);return execute;}
it('reasoning false explains native configuration instead of offering dead choices',async()=>{const execute=await show();expect(screen.getByRole('combobox',{name:'Thinking level'})).toBeDisabled();expect(screen.getByRole('status')).toHaveTextContent('reasoning: false');expect(screen.queryByRole('option',{name:'high'})).toBeNull();expect(execute).not.toHaveBeenCalled();});
it('supported choices come from native metadata and clamping rejection is visible',async()=>{state.hosts.get('pi-a').snapshot.model={provider:'cafeshop',id:'gemini-3.8-flash',reasoning:true,thinkingLevels:['off','low','high']};const execute=await show();execute.mockResolvedValueOnce({status:'rejected',code:'THINKING_NOT_APPLIED'});const input=screen.getByRole('combobox',{name:'Thinking level'});expect(input).toBeEnabled();expect(input.tagName).toBe('BUTTON');expect(input).toHaveAttribute('data-slot','select-trigger');expect(document.querySelector('[data-native-choice]')).toBeNull();expect(choiceProps.items.map(option=>option.value)).toEqual(['off','low','high']);expect(choiceProps.native).not.toBe(true);await act(async()=>choiceProps.onValueChange('high'));await waitFor(()=>expect(execute).toHaveBeenCalledOnce());expect(await screen.findByRole('alert')).toHaveTextContent('Pi did not apply');expect(input).toHaveTextContent('off');});
