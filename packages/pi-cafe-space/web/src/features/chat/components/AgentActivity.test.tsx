import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { I18nextProvider } from 'react-i18next';
import { createI18n } from '../../../i18n';
import type { SessionSnapshot, TranscriptMessage } from '../../../../../src/protocol/index';
import { AgentActivity, agentActivity } from './AgentActivity';
const base:SessionSnapshot={protocolVersion:1,streamId:'stream',sessionId:'session',sessionName:null,cwd:'/test',activeLeafId:null,model:null,thinkingLevel:'high',phase:'running',hasPendingMessages:false,messages:[],tools:[],lastEventSeq:0,historyTruncated:false};
const message:TranscriptMessage={id:'a',role:'assistant',text:'',thinking:'',timestamp:1,status:'streaming',toolCallId:null,toolName:null};
afterEach(()=>vi.useRealTimers());
it('uses only the ordered Pi snapshot and never infers completion from connectivity',()=>{
 const done:SessionSnapshot={...base,phase:'idle',execution:{version:1,runId:'r1',activity:'idle',outcome:'aborted'}};
 expect(agentActivity(done,true).kind).toBe('aborted');expect(agentActivity(done,false).kind).toBe('offline');
 expect(agentActivity({...base,execution:{version:1,runId:'r1',activity:'working',outcome:'none'}},true)).toMatchObject({kind:'working'});
 expect(agentActivity({...base,execution:{version:1,runId:'r1',activity:'waiting',outcome:'none',waitKind:'select'}},true)).toMatchObject({kind:'waiting',waitKind:'select'});
 expect(agentActivity({...base,execution:{version:1,runId:'r1',activity:'compacting',outcome:'none',reason:'overflow'}},true).kind).toBe('compacting');
 for(const outcome of ['completed','error','unknown'] as const)expect(agentActivity({...done,execution:{...done.execution!,outcome}}).kind).toBe(outcome);
 expect(agentActivity({...done,execution:undefined}).kind).toBeNull();
});
it('run timer follows run identity, stops at settlement and never animates final results',async()=>{
 vi.useFakeTimers();const i18n=createI18n();await i18n.changeLanguage('en');let s:SessionSnapshot={...base,execution:{version:1,runId:'r1',activity:'working',outcome:'none'}};
 const view=()=> <I18nextProvider i18n={i18n}><AgentActivity snapshot={s}/></I18nextProvider>;const {rerender,container,unmount}=render(view());act(()=>vi.advanceTimersByTime(3000));expect(screen.getByText('3s')).toBeInTheDocument();
 s={...s,streamId:'after-compaction',execution:{...s.execution!,activity:'compacting',reason:'manual'}};rerender(view());expect(screen.getByText('3s')).toBeInTheDocument();expect(screen.getByRole('status')).toHaveTextContent('Compacting');
 s={...s,phase:'idle',execution:{version:1,runId:'r1',activity:'idle',outcome:'completed'}};rerender(view());expect(screen.queryByText('3s')).toBeNull();expect(screen.getByRole('status')).toHaveTextContent('Run finished');expect(container.querySelector('svg')).toHaveAttribute('data-steaming','false');expect(vi.getTimerCount()).toBe(0);
 s={...s,phase:'running',execution:{version:1,runId:'r2',activity:'working',outcome:'none'}};rerender(view());expect(screen.queryByText('3s')).toBeNull();act(()=>vi.advanceTimersByTime(1000));expect(screen.getByText('1s')).toBeInTheDocument();unmount();expect(vi.getTimerCount()).toBe(0);
});
it('prompt kinds use explicit local-action wording, never invent a login state',async()=>{
 const i18n=createI18n();await i18n.changeLanguage('en');const {rerender}=render(<I18nextProvider i18n={i18n}><AgentActivity snapshot={{...base,phase:'waiting_local_ui',execution:{version:1,runId:'r1',activity:'waiting',outcome:'none',waitKind:'input'}}}/></I18nextProvider>);expect(screen.getByRole('status')).toHaveTextContent('Waiting for local input');
 rerender(<I18nextProvider i18n={i18n}><AgentActivity snapshot={{...base,phase:'idle',execution:{version:1,runId:'r1',activity:'idle',outcome:'unknown'}}}/></I18nextProvider>);expect(screen.getByRole('status')).toHaveTextContent('Run outcome unconfirmed');
});
it('uses real latest activity, not configuration or old thinking content',()=>{
 expect(agentActivity(base).kind).toBe('working');
 expect(agentActivity({...base,messages:[{...message,thinking:'reasoning text'}]}).kind).toBe('thinking');
 expect(agentActivity({...base,messages:[{...message,parts:[{index:0,type:'thinking',text:'thought'},{index:1,type:'text',text:'reply'}]}]}).kind).toBe('responding');
 expect(agentActivity({...base,tools:[{toolCallId:'x',toolName:'read',status:'running',argsText:'{}',output:''}]})).toEqual({kind:'tool',tool:'read'});
 expect(agentActivity({...base,phase:'idle',messages:[{...message,thinking:'old'}]}).kind).toBeNull();
 expect(agentActivity({...base,phase:'waiting_local_ui'}).kind).toBe('waiting');expect(agentActivity(base,false).kind).toBe('offline');
});
it('uses a stable decorative SVG coffee mark and stops steam while waiting/offline',async()=>{
 const i18n=createI18n();await i18n.changeLanguage('en');
 const {container,rerender}=render(<I18nextProvider i18n={i18n}><AgentActivity snapshot={base}/></I18nextProvider>);
 const svg=container.querySelector('svg[data-coffee-indicator]');expect(svg).not.toBeNull();expect(svg).toHaveAttribute('aria-hidden','true');expect(svg).toHaveAttribute('data-steaming','true');expect(container.textContent).not.toContain('✳');expect(container.textContent).not.toContain('☕');expect(svg?.querySelectorAll('path').length).toBeGreaterThan(3);
 rerender(<I18nextProvider i18n={i18n}><AgentActivity snapshot={{...base,phase:'waiting_local_ui'}}/></I18nextProvider>);expect(svg).toHaveAttribute('data-steaming','false');
 rerender(<I18nextProvider i18n={i18n}><AgentActivity snapshot={base} connected={false}/></I18nextProvider>);expect(svg).toHaveAttribute('data-steaming','false');
});
it('activity clock stops while offline and is cleaned on unmount',async()=>{
 vi.useFakeTimers();const i18n=createI18n();await i18n.changeLanguage('en');
 const {rerender,unmount}=render(<I18nextProvider i18n={i18n}><AgentActivity snapshot={base}/></I18nextProvider>);
 expect(screen.getByRole('status')).toHaveTextContent('Working');act(()=>vi.advanceTimersByTime(3000));expect(screen.getByText('3s')).toBeInTheDocument();
 rerender(<I18nextProvider i18n={i18n}><AgentActivity snapshot={base} connected={false}/></I18nextProvider>);expect(screen.getByRole('status')).toHaveTextContent('status is not live');expect(screen.queryByText('3s')).toBeNull();unmount();expect(vi.getTimerCount()).toBe(0);
});
