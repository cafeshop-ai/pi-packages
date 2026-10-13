import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { useRemoteState } from '../../services/remote/useRemoteState';
import { Button } from '../../components/ui/Controls';
import { Drawer } from '../../components/ui/Drawer';
import { Icon } from '../../components/ui/Icon';
import styles from './Remote.module.scss';

export function RemoteDevicePanel({owner}:{owner:AppOwner}) {
  const remote=useRemoteState(owner.remote);const {i18n}=useTranslation();const zh=i18n.language.startsWith('zh');
  if(!remote.enabled)return null;
  const route=remote.route?({
    'cloud-relay':zh?'云端中继':'Cloud relay',
    'webrtc': 'WebRTC',
    'webrtc-direct':zh?'WebRTC 直连':'WebRTC direct',
    'webrtc-turn':zh?'WebRTC · TURN 中继':'WebRTC · TURN relay',
  }[remote.route]):(zh?'正在连接':'Connecting');
  return <section className={styles.devicePanel} aria-label={owner.publicRoomMode?(zh?'房间连接':'Room connection'):(zh?'远程电脑':'Remote computer')}>
    <div className={styles.row}><Icon name="hosts"/><strong>{remote.deviceName??remote.deviceId}</strong></div>
    <div className={styles.row}><small>{route}</small><small>{remote.info?(zh?({viewer:'只读',operator:'可操作',admin:'管理员'}[remote.info.role]):remote.info.role):''}</small></div>
    {remote.visitorName && <p data-visitor-name>{zh?'你：':'You: '}{remote.visitorName}</p>}
    {remote.visitorName && <small data-account-source>{remote.visitorKind==='account'?(zh?'Café 账号 · 已验证身份':'Café account · verified identity'):(zh?'访客身份':'Guest identity')}</small>}
    {remote.visitorName && remote.visitorPersistent===false && <p role="status" className={styles.error}>{zh?'此浏览器未能保存身份，刷新后可能需要重新申请。':'This browser could not save its identity; reloading may require approval again.'}</p>}
    <Button variant="quiet" onClick={()=>owner.disconnectRemote()}>{owner.publicRoomMode?(zh?'离开房间':'Leave room'):(zh?'切换电脑':'Switch computer')}</Button>
    {remote.members.length>0&&<details><summary>{zh?'在线协作者':'Online collaborators'} · {remote.members.length}</summary><ul>{remote.members.map(member=><li key={member.id}><span>{member.name}{member.id===remote.info?.id?(zh?'（此设备）':' (this device)'):''}</span><small>{zh?({viewer:'只读',operator:'可操作',admin:'管理员'}[member.role]):member.role}</small></li>)}</ul></details>}
    {remote.error&&<p className={styles.error} role="status"><code>{remote.error}</code></p>}
  </section>;
}
export function RemoteControlBar({owner,hostId,available,compact=false}:{owner:AppOwner;hostId:string;available:boolean;compact?:boolean}) {
  const remote=useRemoteState(owner.remote);const {i18n}=useTranslation();const zh=i18n.language.startsWith('zh');
  const [busy,setBusy]=useState(false);const [error,setError]=useState<string|null>(null);
  const [trigger,setTrigger]=useState<HTMLElement|null>(null);const latch=useRef(false);
  const key=JSON.stringify([remote.info?.id,hostId]);const current=useRef(key);current.current=key;
  useEffect(()=>{setError(null);setTrigger(null);},[key]);
  if(!remote.enabled)return null;
  const lease=remote.leases.find(item=>item.hostId===hostId&&item.expiresAt>Date.now());
  const mine=!!lease&&lease.holder===remote.info?.id;
  const viewer=!remote.info||remote.info.role==='viewer';const admin=remote.info?.role==='admin'&&remote.controlPolicy!=='approval'&&!owner.publicRoomMode;
  const application=remote.controlRequests?.find(q=>q.hostId===hostId);
  const operate=async(action:'acquire'|'release'|'cancel',force=false)=>{
    if(latch.current||!available||viewer)return;
    const fence=key;latch.current=true;setBusy(true);setError(null);
    try{if(action==='cancel'&&application)await owner.remote.cancelControl(hostId,application.id);else if(action!=='cancel')await owner.remote.control(hostId,action,force);if(current.current===fence)setTrigger(null);}
    catch(e){if(current.current===fence)setError(e instanceof Error?e.message:'RESULT_UNKNOWN');}
    finally{latch.current=false;setBusy(false);}
  };
  if(remote.controlPolicy==='disabled'&&!viewer)return null;
  if(remote.controlPolicy==='approval'&&!viewer){
    const pending=application?.state==='pending';
    const messages:Record<string,string>=zh?{denied:'房主拒绝了申请',expired:'申请或授权已过期',revoked:'房主已撤销控制权',released:'已释放控制权',cancelled:'已撤回申请'}:{denied:'The owner denied the request',expired:'The request or approval expired',revoked:'The owner revoked control',released:'Control released',cancelled:'Request withdrawn'};
    return <aside className={styles.control} data-mobile-hidden={compact&&mine&&!error} data-control-policy="approval" aria-label={zh?'协作控制':'Collaboration control'}>
      <div className={styles.controlText}><Icon name="lock"/><span>{mine?(zh?'房主已批准，你可以操作':'Approved by owner · you can operate'):pending?(zh?'等待房主在办公电脑页面同意':'Waiting for approval on the office computer'):(application&&messages[application.state]||(zh?'此房间需要房主批准控制权':'This room requires owner approval'))}</span></div>
      <div className={styles.actions}>{mine?<Button variant="quiet" disabled={!available||busy} loading={busy} onClick={()=>void operate('release')}>{zh?'释放控制权':'Release control'}</Button>:pending?<Button variant="quiet" disabled={!available||busy} loading={busy} onClick={()=>void operate('cancel')}>{zh?'撤回申请':'Withdraw request'}</Button>:<Button disabled={!available||busy} loading={busy} onClick={()=>void operate('acquire')}>{zh?'申请控制权':'Request control'}</Button>}</div>
      {!mine&&<p className={styles.approvalHint}>{pending?(zh?`申请编号 ${application.id.slice(0,6)} · 90秒内未批准将失效`:`Request ${application.id.slice(0,6)} · expires if not approved within 90 seconds`):(zh?'批准前仍可查看和编辑草稿；批准后请自行点击发送。':'You can read and draft before approval. Press Send yourself after approval.')}{lease&&!mine&&(zh?' 当前另一个访客持有控制权，需房主先撤销。':' Another visitor currently holds control; the owner must revoke it first.')}</p>}
      {error&&<p role="alert" className={styles.error}>{zh?'请求未确认，请核对当前状态后再操作。':'Request not confirmed. Check the current state before another action.'} <code>{error}</code></p>}
    </aside>;
  }
  const message=viewer?(zh?'只读访问':'Read-only access'):
    mine?(zh?'你正在操作':'You are in control'):
    lease?(zh?`${lease.name} 操作中`:`${lease.name} is in control`):
    (zh?'可操作':'Ready to use');
  return <aside className={styles.control} data-occupied={!!lease&&!mine} data-mobile-hidden={compact&&!viewer&&(!lease||mine)&&!error} aria-label={zh?'协作控制':'Collaboration control'}>
    <div className={styles.controlText}><Icon name="lock"/><span>{message}</span></div>
    {!viewer&&<details className={styles.controlMenu}><summary>{zh?'协作':'Control'}<Icon name="down" /></summary><div className={styles.actions}>
      {mine?<Button variant="quiet" loading={busy} disabled={!available||busy} onClick={()=>void operate('release')}>{zh?'释放控制权':'Release control'}</Button>:
        !lease?<Button loading={busy} disabled={!available||busy} onClick={()=>void operate('acquire')}>{zh?'取得控制权':'Take control'}</Button>:
        admin?<Button variant="quiet" disabled={!available||busy} onClick={e=>setTrigger(e.currentTarget)}>{zh?'接管控制权':'Take over control'}</Button>:null}
    </div><p>{zh?'发送时自动取得空闲实例的操作权，不抢占其他人。只协调远程操作，不锁住本机终端。':'Sending acquires available control without taking over another user. This coordinates remote actions, not the local terminal.'}</p></details>}
    {error&&<p role="alert" className={styles.error}>{error==='RESULT_UNKNOWN'?(zh?'结果未知，请先核对当前控制者，不要重复发送操作。':'Result unknown. Check the current controller before another operation.'):(zh?'控制请求未成功。':'Control request failed.')} <code>{error}</code></p>}
    {trigger&&<Drawer compact label={zh?'确认接管':'Confirm takeover'} closeLabel={zh?'关闭':'Close'} restoreFocusTo={trigger} onClose={()=>setTrigger(null)}>
      <p>{zh?'这会撤销另一设备对此实例的控制权，但不会自动取消当前任务。之后的操作由你负责。':'This revokes the other device’s control of this instance. It does not automatically cancel the current task. You will control subsequent actions.'}</p>
      <div className={styles.actions}><Button variant="quiet" onClick={()=>setTrigger(null)}>{zh?'取消':'Cancel'}</Button><Button variant="primary" disabled={!available||busy} loading={busy} onClick={()=>void operate('acquire',true)}>{zh?'确认接管':'Confirm takeover'}</Button></div>
    </Drawer>}
  </aside>;
}
