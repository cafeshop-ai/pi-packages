import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useCollabStore } from '../../state/useCollabStore';
import { useRemoteState } from '../../services/remote/useRemoteState';
import { executionScope, parseManagedInventory, parseManagedSession, type ManagedInventory, type ManagedRequest, type ManagedSession } from '../../services/http/workspace';
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
  const [inventory,setInventory] = useState<ManagedInventory>({projects:[],sessions:[],maxActive:8});
  const [error,setError] = useState<string|null>(null);
  const [executionFences,setExecutionFences]=useState<Map<string,string|null>>(new Map());
  const executionReadKey=useRef<string|null>(null);
  const [busy,setBusy] = useState(false); const latch = useRef(false);
  const [dialog,setDialog] = useState<{mode:'create'|'close';trigger:HTMLElement;key:string;id:string}|null>(null);
  const [name,setName] = useState(''); const [project,setProject] = useState('');
  const [pending,setPending] = useState<{hostId:string;id:string;key:string;selected:string|null}|null>(null);
  const [revision,setRevision] = useState(0);
  const refresh = useCallback(()=>setRevision(n=>n+1),[]);
  useEffect(()=>{setDialog(null);setError(null);setPending(null);},[key]);
  useEffect(()=>{setInventory({projects:[],sessions:[],maxActive:8});setExecutionFences(new Map());},[room,state.connection.generation,state.connection.status]);
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
  const openNew=(trigger:HTMLElement)=>{
    setError(remote.enabled && !canManage && available ? 'FORBIDDEN' : null);setName('');
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
  return { observedExecution,owner,room,enabled,supported:available,canManage,canClose,inventory,error,busy,dialog,name,project,pending,setName,setProject,setDialog,openNew,closeSession,operate,viewSession,refresh,key };
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
      return <li key={s.id}><div className={styles.managedIdentity}><strong>{host?.snapshot?.sessionName||s.title||s.name}</strong><small>{t(`managedStatus.${s.status}`)}</small>{execution&&executionView(execution).kind&&<small data-managed-execution={execution.activity} title={i18n.language.startsWith('zh')?'当前托管进程的结构化RPC观察；不是任务验收':'Structured observations from this owned RPC process; not task verification'}>{executionLabel(executionView(execution),i18n.language.startsWith('zh'))}</small>}</div>
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
  return <Drawer compact label={t(creating?'newSession':'closeManaged')} closeLabel={t('close')} restoreFocusTo={dialog.trigger} onClose={()=>c.setDialog(null)}>
    <form className={styles.actionForm} onSubmit={e=>{e.preventDefault();if(creating&&valid)void c.operate({room:c.room,operation:'create',id:dialog.id,projectId:c.project,name:c.name.trim()});else if(!creating)void c.operate({room:c.room,operation:'close',id:dialog.id});}}><FieldGroup>
      {creating?<>
        <p>{t('independentSessionHint')}</p>
        <p className={styles.hint}>{zh ? '这里会在办公电脑启动另一个 Pi 进程，不会切换当前实例的会话。若只需要当前 Pi 开始新会话，请使用聊天区域的「新建会话」或 /new。' : 'This starts another Pi process on the office computer. For a new session in the current Pi, use New session in the conversation or /new.'}</p>
        {!c.supported?<p role="alert">{zh ? '房主尚未启用独立实例管理。请在办公电脑配置允许的项目目录和 Pi 启动参数；不会默认开放任意目录或把访客升级为管理员。' : 'Independent instances are not enabled by the owner. Configure approved project directories and Pi startup paths on the office computer. Arbitrary paths and administrator privileges are not granted by default.'}</p>:<>
          <ChoiceSelect label={t('project')} value={c.project} disabled={c.busy} items={c.inventory.projects.map(p=>({value:p.id,label:p.name}))} onValueChange={c.setProject}/>
          <p className={styles.hint}>{c.inventory.projects.find(p=>p.id===c.project)?.cwd||t('managedNoProject')}</p>
          <Field><FieldLabel htmlFor={id}>{t('sessionTitle')}</FieldLabel><Input id={id} maxLength={256} required value={c.name} disabled={c.busy} onChange={e=>c.setName(e.target.value)}/></Field>
        </>}
      </>:<><p>{c.inventory.sessions.find(s=>s.id===dialog.id)?.name}</p><p>{t('closeManagedHint')}</p></>}
      {c.error&&<p role="alert">{c.error==='RESULT_UNKNOWN'?t('managedUnknown'):t(`errors.${c.error}`,{defaultValue:t('managedFailed')})}</p>}
      <div className={styles.formActions}><Button variant="quiet" onClick={()=>c.setDialog(null)}>{t('cancel')}</Button><Button type="submit" variant="primary" loading={c.busy} disabled={!c.enabled||!c.canManage||c.busy||c.error==='RESULT_UNKNOWN'||(creating&&(!valid||!c.inventory.projects.some(p=>p.id===c.project)))}>{t(creating?'createSession':'closeManaged')}</Button></div>
    </FieldGroup></form>
  </Drawer>;
}
