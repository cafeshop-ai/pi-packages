import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useCollabStore } from '../../state/useCollabStore';
import { Button } from '../../components/ui/Controls';
import { Drawer } from '../../components/ui/Drawer';
import { roomControlRequest, type OwnerControlAction, type OwnerControlState } from '../../services/http/roomControl';
import styles from './RoomControlPanel.module.scss';

export function useRoomControlOwner(owner:AppOwner,active:boolean){
 const [data,setData]=useState<OwnerControlState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const token=active?owner.storage.get('token')??'':'';
 const generation=useRef(0),cancel=useRef<AbortController|null>(null),working=useRef(false),live=useRef(false);
 const run=useCallback(async(action:OwnerControlAction,quiet=false)=>{
  if(!active||!token||!live.current||working.current)return false;
  const version=generation.current;working.current=true;const controller=new AbortController();cancel.current=controller;if(!quiet)setBusy(true);
  try{
   const value=await roomControlRequest(token,action,controller.signal);
   if(!live.current||generation.current!==version)return false;
   setData(value);if(!quiet){setError('');setUncertain(false);}else setError(previous=>previous==='RESULT_UNKNOWN'?previous:'');return true;
  }catch(e){if(live.current&&generation.current===version){const message=e instanceof Error?e.message:'ROOM_CONTROL_UNAVAILABLE';setError(message);if(message==='RESULT_UNKNOWN')setUncertain(true);}return false;}
  finally{if(generation.current===version){working.current=false;cancel.current=null;setBusy(false);}}
 },[active,token]);
 useEffect(()=>{
  generation.current++;live.current=true;working.current=false;setData(null);setError('');setUncertain(false);setBusy(false);
  if(active&&token)void run({operation:'status'});
  const timer=active&&token?setInterval(()=>{if(document.visibilityState!=='hidden')void run({operation:'status'},true);},2500):undefined;
  const visible=()=>{if(document.visibilityState!=='hidden')void run({operation:'status'},true);};document.addEventListener('visibilitychange',visible);
  return()=>{live.current=false;generation.current++;cancel.current?.abort();cancel.current=null;working.current=false;clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
 },[active,token,run]);
 return{data,error,busy,uncertain,run};
}
export type RoomControlOwner = ReturnType<typeof useRoomControlOwner>;
export function RoomControlPanel({owner,control,trigger,onClose}:{owner:AppOwner;control:RoomControlOwner;trigger:HTMLElement;onClose:()=>void}){
 const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
 return <Drawer label={zh?'房间设置':'Room settings'} closeLabel={zh?'关闭':'Close'} restoreFocusTo={trigger} onClose={onClose}><RoomControlContent owner={owner} control={control}/></Drawer>;
}
export function RoomControlContent({owner,control}:{owner:AppOwner;control:RoomControlOwner}){
 const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh');const {data,error,busy,uncertain,run}=control;
 const hosts=useCollabStore(owner.store,s=>s.hosts);
 const [changing,setChanging]=useState<boolean|null>(null);
 const revision=data?.revision;useEffect(()=>{setChanging(null);},[revision]);
 const name=(hostId:string)=>hosts.get(hostId)?.info.sessionName||hostId;
 const pending=data?.requests.filter(q=>q.state==='pending')??[];
 const messages:Record<string,string>=zh?{
  RESULT_UNKNOWN:'操作结果未确认。请点击刷新核对，勿重复审批。',UNAUTHORIZED:'本机登录已失效，请重新登录。',LOCAL_OWNER_REQUIRED:'只有房主的办公电脑本机页面可以设置与审批。',ROOM_CONTROL_CHANGED:'设置已在另一页面修改，请刷新后再操作。',CONTROL_REQUEST_GONE:'申请已被处理、撤回或连接已离线，请刷新。',CONTROL_REQUEST_EXPIRED:'申请已过期，未授予控制权。',CONTROL_BUSY:'已有访客持有该实例控制权。请先撤销原授权，再批准。',HOST_NOT_READY:'申请的访客或Pi实例已离线，不能批准。',CONTROL_DISABLED:'控制权功能已经关闭。',CONTROL_LIMIT:'当前申请或授权数量已达上限。'
 }:{RESULT_UNKNOWN:'The outcome is unconfirmed. Refresh before another decision.',UNAUTHORIZED:'Local sign-in expired.',LOCAL_OWNER_REQUIRED:'Only the local page on the office computer can manage approvals.',ROOM_CONTROL_CHANGED:'Settings changed in another page. Refresh first.',CONTROL_REQUEST_GONE:'Request already handled, withdrawn, or disconnected.',CONTROL_REQUEST_EXPIRED:'The request expired. No control was granted.',CONTROL_BUSY:'Another visitor holds this instance. Revoke that grant before approving.',HOST_NOT_READY:'The visitor or Pi is no longer available.',CONTROL_DISABLED:'Control approval is now disabled.',CONTROL_LIMIT:'Request or grant limit reached.'};
 return <div className={styles.panel}>
   {!data&&<p role="status">{zh?'正在读取房间设置…':'Loading room settings…'}</p>}
   {data&&<>
    <section className={styles.setting}>
     <label className={styles.toggle}><span><strong>{zh?'启用控制权审批':'Require owner approval'}</strong><small>{zh?'默认关闭 · 设置仅影响本房间':'Off by default · applies to this room only'}</small></span><input role="switch" aria-label={zh?'启用控制权审批':'Require owner approval'} type="checkbox" checked={changing??data.enabled} disabled={busy||uncertain||!!error} onChange={e=>setChanging(e.target.checked)}/></label>
     <p>{data.enabled?(zh?'访客先申请，你在本机批准后才可操作。未处理申请不会自动同意。':'Visitors request control; you approve here on this computer. Unanswered requests are never approved automatically.'):(zh?'所有通过房间密码验证的访客都可以直接操作 Pi，无需申请。':'Everyone who enters with the room password can operate Pi directly, without requesting control.')}</p>
     {changing!==null&&changing!==data.enabled&&<div className={styles.confirm}>
      <p>{changing?(zh?'开启后，现有访客的新操作也需要批准。已经运行的任务不会被取消。':'Enabling also requires current visitors to request approval for new actions. Running tasks are not cancelled.'):(zh?'关闭后，所有通过房间密码验证的访客都可直接操作。申请与授权将清空，运行中的任务不受影响。':'Disabling lets everyone in the room operate Pi directly. Requests and grants are cleared; running tasks continue.')}</p>
      <div className={styles.actions}><Button variant="quiet" disabled={busy} onClick={()=>setChanging(null)}>{zh?'取消':'Cancel'}</Button><Button variant="primary" loading={busy} disabled={busy||uncertain} onClick={()=>void run({operation:'configure',revision:data.revision,enabled:changing})}>{zh?'确认修改':'Confirm setting'}</Button></div>
     </div>}
    </section>
    {data.enabled&&<>
     <section className={styles.section}><h3>{zh?'待审批':'Pending requests'} <span>{pending.length}</span></h3>
      {pending.length===0&&<p className={styles.empty}>{zh?'暂无申请。访客点击申请后会出现在这里。':'No pending requests. Visitor requests will appear here.'}</p>}
      {pending.map(q=><article className={styles.request} key={q.id} data-application-id={q.id}>
       <header><strong>{q.name}<small>{q.identityKind==='account'?(zh?'Café 账号':'Café account'):(zh?'访客':'Guest')}</small></strong><small>{zh?'申请编号':'Request'} <code>{q.id.slice(0,6)}</code></small></header><p>{zh?'请求操作':'Requests control of'} <b>{name(q.hostId)}</b></p>
       <small>{zh?'批准可发送任务、打断及修改此Pi会话；你可以随时撤销。请与访客核对申请编号。':'Approval allows prompts, interruption and session changes for this Pi. Revoke at any time; verify the request code with the visitor.'}</small>
       <div className={styles.actions}><Button variant="quiet" disabled={busy||uncertain||!!error} onClick={()=>void run({operation:'deny',applicationId:q.id,revision:data.revision})}>{zh?'拒绝':'Deny'}</Button><Button variant="primary" disabled={busy||uncertain||!!error} onClick={()=>void run({operation:'approve',applicationId:q.id,revision:data.revision})}>{zh?'批准':'Approve'}</Button></div>
      </article>)}
     </section>
     <section className={styles.section}><h3>{zh?'当前授权':'Active grants'}</h3>{data.leases.length===0&&<p className={styles.empty}>{zh?'目前无人持有控制权。':'No active grants.'}</p>}
      {data.leases.map(lease=><article className={styles.request} key={lease.approvalId}><strong>{lease.name}</strong><p>{name(lease.hostId)}</p><Button variant="quiet" disabled={busy||uncertain||!!error} onClick={()=>void run({operation:'revoke',hostId:lease.hostId,applicationId:lease.approvalId!,revision:data.revision})}>{zh?'撤销控制权':'Revoke control'}</Button></article>)}
     </section><details className={styles.rules}><summary>{zh?'审批规则与有效期':'Approval rules and expiry'}</summary><p className={styles.footnote}>{zh?'申请90秒未处理会失效。同一浏览器通过身份验证后，可在断线5分钟内恢复原批准；你随时可以撤销。撤销、授权到期、改密码或网关重启后需要重新申请。启用时新增/打开独立Pi实例请在本机进行。':'Unanswered requests expire after 90 seconds. The same verified browser can restore an existing grant within 5 minutes of disconnecting; you can revoke it at any time. Revocation, grant expiry, password changes or gateway restarts require new approval. Create or open independent Pi instances locally while approval is enabled.'}</p></details>
    </>}
   </>}
   {error&&<p role="alert" className={styles.error}>{messages[error]||(zh?'无法刷新本机房间状态，请检查网关。':'Local room state could not be refreshed.')}</p>}
   <Button variant="quiet" disabled={busy} onClick={()=>void run({operation:'status'})}>{zh?'刷新设置与申请':'Refresh settings and requests'}</Button>
 </div>;
}
