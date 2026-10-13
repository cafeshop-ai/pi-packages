import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useRemoteState } from '../../services/remote/useRemoteState';
import { Drawer } from '../../components/ui/Drawer';
import { Button } from '../../components/ui/Controls';
import { Icon } from '../../components/ui/Icon';
import styles from './ControlRequestDialog.module.scss';

/** No command or draft is accepted here: approval cannot replay a message. */
export function ControlRequestDialog({owner,hostId,hostLabel,available,restoreFocusTo,onClose}:{owner:AppOwner;hostId:string;hostLabel:string;available:boolean;restoreFocusTo:HTMLElement|null;onClose:()=>void}) {
 const remote=useRemoteState(owner.remote),{i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
 const [busy,setBusy]=useState(false),[sent,setSent]=useState(false),[error,setError]=useState('');
 const latch=useRef(false),live=useRef(true);const key=JSON.stringify([remote.info?.id,hostId]),current=useRef(key);current.current=key;
 useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const application=remote.controlRequests?.find(q=>q.hostId===hostId);
 const granted=owner.remote.canWrite(hostId),ready=available&&remote.phase==='ready'&&!!remote.info;
 const disabled=remote.controlPolicy==='disabled',pending=application?.state==='pending',waiting=pending||sent;
 useEffect(()=>{if(application){setSent(false);setError('');}},[application?.id,application?.state]);
 const request=async(cancel=false)=>{
  if(latch.current||!ready||remote.info?.role==='viewer'||remote.controlPolicy!=='approval'||granted||(!cancel&&(waiting||error==='RESULT_UNKNOWN'))||cancel&&!pending)return;
  const captured=key;latch.current=true;setBusy(true);setError('');
  try{
   if(cancel)await owner.remote.cancelControl(hostId,application!.id);else await owner.remote.control(hostId,'acquire');
   if(live.current&&current.current===captured)setSent(!cancel);
  }catch(e){if(live.current&&current.current===captured)setError(e instanceof Error&&['RESULT_UNKNOWN','CONTROL_LIMIT','NOT_CONNECTED','HOST_NOT_READY','CONTROL_REQUEST_GONE'].includes(e.message)?e.message:'CONTROL_REQUEST_FAILED');}
  finally{latch.current=false;if(live.current&&current.current===captured)setBusy(false);}
 };
 const title=!ready?(zh?'连接已中断':'Connection interrupted'):disabled?(zh?'当前无需审批':'Approval is not required'):granted?(zh?'已获得控制权':'Control approved'):waiting?(zh?'等待房主批准':'Waiting for owner approval'):(zh?'需要房主批准':'Owner approval required');
 const description=!ready?(zh?'当前连接不可用，没有发送消息或新的申请。':'The connection is unavailable. No message or new request was sent.'):disabled?(zh?'房主已关闭审批。返回对话后可以自行发送消息。':'The owner disabled approval. Return to the conversation and send when ready.'):granted?(zh?'房主已批准你操作这个 Pi。请返回对话，自行点击发送。':'The owner approved this Pi. Return to the conversation and press Send yourself.'):waiting?(zh?'申请已提交，请等待房主处理。关闭弹窗不会取消申请。':'Your request is pending the owner’s decision. Closing this dialog does not cancel it.'):(zh?'这个房间已开启控制权审批。获得房主同意后，才能向此 Pi 发送消息。':'This room requires owner approval before you can send messages to this Pi.');
 const outcome=application?.state==='denied'?(zh?'房主拒绝了上一次申请。':'The owner denied the previous request.'):['expired','revoked','released','cancelled'].includes(application?.state??'')?(zh?'上一次申请或授权已结束，需要重新申请。':'The previous request or grant ended. Request control again.'):'';
 const canApply=ready&&!disabled&&!granted&&!waiting&&!busy&&remote.controlPolicy==='approval'&&remote.info?.role!=='viewer'&&error!=='RESULT_UNKNOWN';
 return <Drawer compact label={title} closeLabel={zh?'关闭':'Close'} restoreFocusTo={restoreFocusTo} onClose={onClose}>
  <div className={styles.body} data-control-request-dialog>
   <div className={styles.target}><Icon name="lock"/><span>{hostLabel}</span></div>
   <p role="status" aria-live="polite">{description}</p>
   <p className={styles.draft}>{zh?'消息未发送，草稿已保留。':'Nothing was sent. Your draft is preserved.'}</p>
   {outcome&&!granted&&!disabled&&<p>{outcome}</p>}
   {pending&&<small>{zh?'申请编号':'Request'} <code>{application.id.slice(0,6)}</code> · {zh?'90秒内未处理将失效':'Expires if unanswered for 90 seconds'}</small>}
   {error&&<p role="alert" className={styles.error}>{error==='RESULT_UNKNOWN'?(zh?'申请结果暂未确认，请等待状态更新，不要重复提交。':'The request outcome is not yet confirmed. Wait for an update rather than resubmitting.'):(zh?'申请未成功，请检查连接或稍后重试。':'The request failed. Check the connection or retry later.')}</p>}
   <div className={styles.actions}>
    <Button variant={canApply?'quiet':'primary'} onClick={onClose}>{zh?'返回对话':'Back to conversation'}</Button>
    {pending&&<Button variant="quiet" disabled={busy||!ready} loading={busy} onClick={()=>void request(true)}>{zh?'撤回申请':'Withdraw request'}</Button>}
    {!waiting&&!disabled&&!granted&&ready&&<Button variant="primary" disabled={!canApply} loading={busy} onClick={()=>void request()}>{zh?'申请控制权':'Request control'}</Button>}
   </div>
  </div>
 </Drawer>;
}
