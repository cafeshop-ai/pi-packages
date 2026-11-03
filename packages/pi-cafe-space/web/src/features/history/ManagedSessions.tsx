import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useCollabStore } from '../../state/useCollabStore';
import { useRemoteState } from '../../services/remote/useRemoteState';
import { executionScope, parseManagedInventory, parseManagedSession, parseManagedTargets, type ManagedAgent, type ManagedInventory, type ManagedRequest, type ManagedSession, type ManagedThread } from '../../services/http/workspace';
import { Button, Input } from '../../components/ui/Controls';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { Drawer } from '../../components/ui/Drawer';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/shadcn/field';
import { Icon } from '../../components/ui/Icon';
import styles from './History.module.scss';
import { executionLabel, executionView } from '../chat/components/executionPresentation';

export function useManagedSessions(owner: AppOwner, room: string, roomBase: string, supported: boolean) {
  const state = useCollabStore(owner.store, s=>s); const navigate = useNavigate();
  const remote = useRemoteState(owner.remote);
  const available = supported && (!remote.enabled || remote.info?.managed === true);
  const canManage = owner.remote.canManage();
  const canClose = owner.remote.canCloseManaged();
  const liveKey = () => { const s=owner.store.getSnapshot(); return JSON.stringify([room,s.connection.roomId,s.connection.generation,s.connection.status,s.viewGeneration]); };
  const key = liveKey();
  const current = useRef(key); current.current = key;
  const enabled = available && state.connection.status === 'authenticated';
  const [inventory,setInventory] = useState<ManagedInventory>({projects:[],sessions:[],agents:['pi'],acpAttach:false,maxActive:8});
  const [error,setError] = useState<string|null>(null);
  const [agent,setAgent] = useState<ManagedAgent>('pi');
  const [attachExisting,setAttachExisting] = useState(false);
  const [targetKey,setTargetKey] = useState('');
  const [threads,setThreads] = useState<ManagedThread[]>([]);
  const [threadsTruncated,setThreadsTruncated] = useState(false);
  const [threadsLoading,setThreadsLoading] = useState(false);
  const [threadsError,setThreadsError] = useState<string|null>(null);
  const [threadRevision,setThreadRevision] = useState(0);
  const projectKey=JSON.stringify(inventory.projects.map(p=>[p.id,p.cwd]));
  const [executionFences,setExecutionFences]=useState<Map<string,string|null>>(new Map());
  const executionReadKey=useRef<string|null>(null);
  const [busy,setBusy] = useState(false); const latch = useRef(false);
  const [dialog,setDialog] = useState<{mode:'create'|'close';trigger:HTMLElement;key:string;id:string}|null>(null);
  const [name,setName] = useState(''); const [project,setProject] = useState('');
  const [pending,setPending] = useState<{hostId:string;id:string;key:string;selected:string|null}|null>(null);
  const [revision,setRevision] = useState(0);
  const refresh = useCallback(()=>setRevision(n=>n+1),[]);
  useEffect(()=>{setDialog(null);setError(null);setPending(null);},[key]);
  useEffect(()=>{setInventory({projects:[],sessions:[],agents:['pi'],acpAttach:false,maxActive:8});setExecutionFences(new Map());},[room,state.connection.generation,state.connection.status]);
  useEffect(()=>{
    if(!enabled)return;
    const controller=new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll=async()=>{
      const before=new Map([...owner.store.getSnapshot().hosts].map(([id,host])=>[id,executionScope(host.snapshot)]));
      try {const data=parseManagedInventory(await owner.workspace({room,operation:'list'},controller.signal),room);if(!controller.signal.aborted&&current.current===key&&liveKey()===key){executionReadKey.current=key;setInventory(data);setExecutionFences(before);}}
      catch(e){if(!controller.signal.aborted&&current.current===key&&liveKey()===key){setExecutionFences(new Map());setError(e instanceof Error?e.message:'MANAGER_UNAVAILABLE');}}
      if(!controller.signal.aborted)timer=setTimeout(poll,3000);
    };
    void poll();return()=>{controller.abort();clearTimeout(timer);};
  },[owner,enabled,room,key,revision]);
  useEffect(()=>{
    if(!pending||pending.key!==key)return;
    const host=state.hosts.get(pending.hostId);
    const record=inventory.sessions.find(s=>s.id===pending.id);
    if(record?.status==='failed'){setError(record.error??'MANAGED_START_FAILED');setPending(null);return;}
    if(record?.status==='ready'&&host?.info.connected&&host.info.ready!==false&&!host.stale&&host.snapshot){
      if(state.selectedHostId===pending.selected||state.selectedHostId===null||state.selectedHostId===pending.hostId){owner.selectHost(pending.hostId);navigate(roomBase||'/');}
      setPending(null);
    }
  },[pending,key,state.hosts,state.selectedHostId,inventory,owner,navigate,roomBase]);
  useEffect(()=>{if(dialog?.mode==='create'&&!project&&inventory.projects[0])setProject(inventory.projects[0].id);},[dialog,project,inventory.projects]);
  useEffect(()=>{if(!inventory.acpAttach){setAttachExisting(false);setTargetKey('');}},[inventory.acpAttach]);
  useEffect(()=>{
    if(!enabled||dialog?.mode!=='create'||agent!=='codex-acp'||!attachExisting||!inventory.acpAttach)return;
    const controller=new AbortController();setThreadsLoading(true);setThreadsError(null);
    void owner.workspace({room,operation:'threads'},controller.signal).then(value=>{
      if(controller.signal.aborted||current.current!==key)return;
      const result=parseManagedTargets(value,inventory);setThreads(result.threads);setThreadsTruncated(result.truncated);
      setTargetKey(current=>result.threads.some(thread=>thread.key===current)?current:'');
    }).catch(e=>{if(!controller.signal.aborted&&current.current===key)setThreadsError(e instanceof Error?e.message:'ACP_LIST_UNAVAILABLE');})
      .finally(()=>{if(!controller.signal.aborted)setThreadsLoading(false);});
    return()=>controller.abort();
  },[owner,enabled,room,key,dialog?.mode,agent,attachExisting,projectKey,inventory.acpAttach,threadRevision]);
  const openNew=(trigger:HTMLElement)=>{
    setError(remote.enabled && !canManage && available ? 'FORBIDDEN' : null);setName('');setAgent('pi');setAttachExisting(false);setTargetKey('');setThreads([]);setThreadsError(null);
    const cwd=owner.store.scope()?.cwd;
    setProject(inventory.projects.find(p=>p.cwd===cwd)?.id??inventory.projects[0]?.id??'');
    setDialog({mode:'create',trigger,key,id:crypto.randomUUID()});refresh();
  };
  const closeSession=(id:string,trigger:HTMLElement)=>{setError(null);setDialog({mode:'close',id,trigger,key});};
  const operate=async(request:ManagedRequest)=>{
    if(!enabled||!canManage||request.operation==='close'&&!canClose||latch.current||request.room!==room||liveKey()!==key)return;
    const fence=key, selected=state.selectedHostId;
    latch.current=true;setBusy(true);setError(null);
    try {
      const record=parseManagedSession(await owner.workspace(request),room);
      if(current.current!==fence||liveKey()!==fence)return;
      if(record.status==='failed'){setError(record.error??'MANAGED_START_FAILED');refresh();return;}
      setDialog(null);refresh();
      if(request.operation!=='close')setPending({hostId:record.hostId,id:record.id,key:fence,selected});
    }catch(e){if(current.current===fence&&liveKey()===fence){setError(e instanceof Error?e.message:'RESULT_UNKNOWN');refresh();}}
    finally{latch.current=false;setBusy(false);}
  };
  const viewSession = (hostId: string) => {
    if (!enabled || !owner.store.getSnapshot().hosts.has(hostId)) return;
    owner.selectHost(hostId); navigate(roomBase || '/');
  };
  const observedExecution=(hostId:string)=>{
    const host=owner.store.getSnapshot().hosts.get(hostId),record=inventory.sessions.find(s=>s.hostId===hostId);
    if(executionReadKey.current!==key||!enabled||!host||host.stale||!host.info.connected||host.info.ready===false||record?.status!=='ready'||!record.execution)return undefined;
    const fence=executionScope(host.snapshot);
    return fence!==null&&executionFences.get(hostId)===fence?record.execution:undefined;
  };
  return { observedExecution,owner,room,enabled,supported:available,canManage,canClose,inventory,error,busy,dialog,name,project,pending,agent,attachExisting,targetKey,threads,threadsTruncated,threadsLoading,threadsError,setAgent,setAttachExisting,setTargetKey,setProject,setName,setDialog,setThreadsError,setThreadRevision:()=>setThreadRevision(n=>n+1),openNew,closeSession,operate,viewSession,refresh,key };
}
export type ManagedController = ReturnType<typeof useManagedSessions>;
export function ManagedSessionList({control:c,query=''}:{control:ManagedController;query?:string}) {
  const {t,i18n}=useTranslation();
  if(!c.supported)return null;
  return <section className={styles.managed} aria-label={t('managedSessions')}>
    <div className={styles.heading}><h2>{t('managedSessions')}</h2><Button variant="quiet" aria-label={t('loadManaged')} onClick={c.refresh}><Icon name="refresh"/></Button></div>
    {c.pending&&<p role="status" className={styles.hint}>{t('managedStarting')}</p>}
    {c.error&&!c.dialog&&<p role="alert" className={styles.hint}>{t(`errors.${c.error}`,{defaultValue:t('managedFailed')})}</p>}
    <ul>{c.inventory.sessions.filter(s=>[s.name,s.title,c.inventory.projects.find(p=>p.id===s.projectId)?.cwd,c.owner.store.getSnapshot().hosts.get(s.hostId)?.snapshot?.sessionName].some(value=>value?.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))).map(s=>{
      const host=c.owner.store.getSnapshot().hosts.get(s.hostId);
      const active=['starting','ready','stopping'].includes(s.status);
      const execution=c.observedExecution(s.hostId);
      return <li key={s.id}><div className={styles.managedIdentity}><strong>{host?.snapshot?.sessionName||s.title||s.name}</strong><small>{t(`managedStatus.${s.status}`)}</small></div><div className={styles.managedMeta}>{s.agent==='codex-acp'&&<small>{t(s.agentMode==='attach'?'codexAttached':'codexOwned')}</small>}{execution&&executionView(execution).kind&&<small data-managed-execution={execution.activity} title={i18n.language.startsWith('zh')?'当前托管进程的结构化RPC观察；不是任务验收':'Structured observations from this owned RPC process; not task verification'}>{executionLabel(executionView(execution),i18n.language.startsWith('zh'))}</small>}</div>
        <div className={styles.managedActions}>
          <Button variant="quiet" disabled={!c.enabled||c.busy||s.status==='stopping'||!!c.pending||(!active&&!c.canManage)||(active&&!host?.info.connected)} onClick={()=>active?c.viewSession(s.hostId):void c.operate({room:c.room,operation:'open',id:s.id})}>{t(active?'viewSession':'openSession')}</Button>
          {active&&c.canClose&&<Button variant="quiet" disabled={!c.enabled||c.busy||s.status==='stopping'} onClick={e=>c.closeSession(s.id,e.currentTarget)}>{t('closeManaged')}</Button>}
        </div>
        {s.error&&<small role="status">{t(`errors.${s.error}`,{defaultValue:t('managedFailed')})}</small>}
      </li>;
    })}</ul>
  </section>;
}
export function ManagedSessionDialog({control:c}:{control:ManagedController}) {
  const {t,i18n}=useTranslation();
  const zh=i18n.language.startsWith('zh');
  const dialog=c.dialog;
  if(!dialog||dialog.key!==c.key)return null;
  const creating=dialog.mode==='create';const id='managed-session-name';
  const valid=c.name.trim().length>0&&c.name.length<=256&&!/[\u0000-\u001f\u007f]/.test(c.name);
  const selectedThread=c.threads.find(thread=>thread.key===c.targetKey);
  const createValid=valid&&c.inventory.projects.some(p=>p.id===c.project)&&(!c.attachExisting||!!c.inventory.acpAttach&&!c.threadsLoading&&!c.threadsError&&selectedThread?.status==='idle'&&selectedThread.projectId===c.project);
  const closingSession=c.inventory.sessions.find(s=>s.id===dialog.id);
  return <Drawer compact label={t(creating?'newSession':'closeManaged')} closeLabel={t('close')} restoreFocusTo={dialog.trigger} onClose={()=>c.setDialog(null)}>
    <form className={styles.actionForm} onSubmit={e=>{e.preventDefault();if(creating&&createValid)void c.operate({room:c.room,operation:'create',id:dialog.id,projectId:c.project,name:c.name.trim(),...(c.agent==='codex-acp'?{agent:c.agent}:{}),...(c.agent==='codex-acp'&&c.attachExisting?{targetKey:c.targetKey}:{})});else if(!creating)void c.operate({room:c.room,operation:'close',id:dialog.id});}}><FieldGroup>
      {creating?<>
        <p>{c.agent==='codex-acp'?t('codexManagedReadOnlyHint'):t('independentSessionHint')}</p>
        <p className={styles.hint}>{c.agent==='codex-acp'?t('codexManagedHostHint'):(zh ? '这里会在办公电脑启动另一个 Pi 进程，不会切换当前实例的会话。若只需要当前 Pi 开始新会话，请使用聊天区域的「新建会话」或 /new。' : 'This starts another Pi process on the office computer. For a new session in the current Pi, use New session in the conversation or /new.')}</p>
        {!c.supported?<p role="alert">{zh ? '房主尚未启用独立实例管理。请在办公电脑配置允许的项目目录和 Pi 启动参数；不会默认开放任意目录或把访客升级为管理员。' : 'Independent instances are not enabled by the owner. Configure approved project directories and Pi startup paths on the office computer. Arbitrary paths and administrator privileges are not granted by default.'}</p>:<>
          {c.inventory.agents.length>1&&<ChoiceSelect label={t('managedRuntime')} value={c.agent} disabled={c.busy||!c.canManage} items={c.inventory.agents.map(agent=>({value:agent,label:agent==='pi'?'Pi':'Codex ACP'}))} onValueChange={value=>{c.setAgent(value as ManagedAgent);c.setAttachExisting(false);c.setTargetKey('');c.setThreadsError(null);}}/>}
          {c.agent==='codex-acp'&&c.inventory.acpAttach&&<ChoiceSelect label={t('codexSessionSource')} value={c.attachExisting?'attach':'new'} disabled={c.busy||!c.canManage} items={[{value:'new',label:t('codexNewSession')},{value:'attach',label:t('codexAttachSession')}]} onValueChange={value=>{c.setAttachExisting(value==='attach');c.setTargetKey('');c.setThreadsError(null);}}/>}
          {!c.attachExisting&&<ChoiceSelect label={t('project')} value={c.project} disabled={c.busy||!c.canManage} items={c.inventory.projects.map(p=>({value:p.id,label:p.name}))} onValueChange={value=>{c.setProject(value);if(c.threads.find(thread=>thread.key===c.targetKey)?.projectId!==value)c.setTargetKey('');}}/>}
          {c.attachExisting&&<>
            <div className={styles.heading}><span>{t('codexLoadedSessions')}</span><Button variant="quiet" aria-label={t('loadManaged')} disabled={c.threadsLoading||c.busy} onClick={c.setThreadRevision}><Icon name="refresh"/></Button></div>
            {c.threadsLoading&&<p role="status" className={styles.hint}>{t('codexLoadingSessions')}</p>}
            {c.threadsError&&<p role="alert" className={styles.hint}>{t(`errors.${c.threadsError}`,{defaultValue:t('managedFailed')})}</p>}
            {c.threadsTruncated&&<p className={styles.hint}>{t('codexSessionsTruncated')}</p>}
            <ChoiceSelect label={t('codexSessionTarget')} value={c.targetKey} disabled={c.busy||c.threadsLoading||c.threads.length===0} items={[{value:'',label:t('codexChooseSession')},...c.threads.map(thread=>({value:thread.key,disabled:thread.status!=='idle',label:`${thread.name} · ${t(`codexThreadStatus.${thread.status}`)}`,description:thread.cwd}))]} onValueChange={value=>{c.setTargetKey(value);const target=c.threads.find(thread=>thread.key===value);if(target)c.setProject(target.projectId);}}/>
            {c.targetKey&&<p className={styles.hint}>{c.threads.find(thread=>thread.key===c.targetKey)?.cwd}</p>}
            <p className={styles.hint}>{t('codexAttachNoHistory')}</p>
          </>}
          {!c.attachExisting&&<p className={styles.hint}>{c.inventory.projects.find(p=>p.id===c.project)?.cwd||t('managedNoProject')}</p>}
          <Field><FieldLabel htmlFor={id}>{t('sessionTitle')}</FieldLabel><Input id={id} maxLength={256} required value={c.name} disabled={c.busy} onChange={e=>c.setName(e.target.value)}/></Field>
        </>}
      </>:<><p>{closingSession?.name}</p><p>{t(closingSession?.agent==='codex-acp'?(closingSession.agentMode==='attach'?'closeAttachedAcpHint':'closeAcpHint'):'closeManagedHint')}</p></>}
      {c.error&&<p role="alert">{c.error==='RESULT_UNKNOWN'?t('managedUnknown'):t(`errors.${c.error}`,{defaultValue:t('managedFailed')})}</p>}
      <div className={styles.formActions}><Button variant="quiet" onClick={()=>c.setDialog(null)}>{t('cancel')}</Button><Button type="submit" variant="primary" loading={c.busy} disabled={!c.enabled||!c.canManage||c.busy||c.error==='RESULT_UNKNOWN'||(creating&&!createValid)}>{t(creating?'createSession':'closeManaged')}</Button></div>
    </FieldGroup></form>
  </Drawer>;
}
