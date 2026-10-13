import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import type { DeviceCatalog } from '../../services/remote/RemoteAccess';
import type { RemoteMode } from '../../services/remote/RemoteSocket';
import { Button, Input } from '../../components/ui/Controls';
import { ChoiceSelect } from '../../components/ui/ChoiceSelect';
import { Field, FieldGroup, FieldLabel } from '../../components/ui/shadcn/field';
import { Icon } from '../../components/ui/Icon';
import styles from './Remote.module.scss';

export function RemoteLogin({owner,roomId,onLogin}:{owner:AppOwner;roomId?:string;onLogin:(room:string)=>void}) {
  const {i18n}=useTranslation(); const zh=i18n.language.startsWith('zh'); const id=useId();
  const [token,setToken]=useState(owner.storage.get('token')??'');
  const [catalog,setCatalog]=useState<DeviceCatalog|null>(null);
  const [deviceId,setDeviceId]=useState(''); const [room,setRoom]=useState('');
  const [mode,setMode]=useState<RemoteMode>(owner.remote.savedSelection()?.mode??'auto');
  const [busy,setBusy]=useState(false); const [error,setError]=useState<string|null>(null);
  const pending=useRef<AbortController|null>(null);
  useEffect(()=>()=>{pending.current?.abort();},[]);
  const device=catalog?.devices.find(d=>d.id===deviceId);
  const select=(next:string,data=catalog)=>{
    const target=data?.devices.find(d=>d.id===next);setDeviceId(next);
    setRoom(target?.rooms.find(r=>r.id===(roomId??owner.storage.get('room')))?.id??target?.rooms[0]?.id??'');
  };
  const discover=async()=>{
    pending.current?.abort();const controller=new AbortController();pending.current=controller;
    setBusy(true);setError(null);setCatalog(null);
    try {
      const result=await owner.remote.discover(token,controller.signal);
      if(controller.signal.aborted)return;
      setCatalog(result);
      const saved=owner.remote.savedSelection();
      select(result.devices.find(d=>d.id===saved?.deviceId)?.id??result.devices.find(d=>d.online)?.id??result.devices[0]?.id??'',result);
    } catch(e) { if(!controller.signal.aborted)setError(e instanceof Error?e.message:'DEVICE_DISCOVERY_FAILED'); }
    finally {if(!controller.signal.aborted)setBusy(false);}
  };
  const connect=()=>{
    if(!device?.rooms.some(r=>r.id===room))return;
    setError(null);
    try{owner.connectRemote(token,deviceId,room,mode);onLogin(room);setToken('');}
    catch(e){setError(e instanceof Error?e.message:'CONNECTION_FAILED');}
  };
  const roleLabel=(role:string)=>zh?({viewer:'只读查看',operator:'协作操作',admin:'管理员'}[role]??role):role;
  return <div className={styles.login}>
    <p className={styles.hint}>{zh?'从笔记本、手机或另一台电脑访问你的办公电脑。任务始终在原来的 Pi 中执行。':'Access your office computer from a laptop, phone or another computer. Tasks stay in the original Pi runtime.'}</p>
    <form onSubmit={e=>{e.preventDefault();void discover();}}><FieldGroup>
      <Field><FieldLabel htmlFor={id}>{zh?'访问密钥':'Access key'}</FieldLabel><Input id={id} type="password" maxLength={128} required autoComplete="off" value={token} disabled={busy} onChange={e=>{pending.current?.abort();setBusy(false);setCatalog(null);setToken(e.target.value);setError(null);}}/></Field>
      <Button type="submit" variant="primary" loading={busy} disabled={busy||!/^[A-Za-z0-9_-]{43,128}$/.test(token)}>{zh?'查找我的电脑':'Find my computers'}</Button>
    </FieldGroup></form>
    {catalog&&<section className={styles.selection} aria-label={zh?'选择办公电脑':'Choose an office computer'}>
      <p className={styles.hint}>{zh?'已登录':'Signed in as'} <strong>{catalog.user.name}</strong></p>
      {!catalog.devices.length?<p role="status">{zh?'当前账户尚未获准访问任何电脑。':'This account has no authorized computers.'}</p>:<>
        <div className={styles.devices}>{catalog.devices.map(d=><Button key={d.id} variant="quiet" className={styles.device} aria-pressed={d.id===deviceId} onClick={()=>select(d.id)}><span><Icon name="hosts"/><strong>{d.name}</strong></span><small data-online={d.online}>{zh?(d.online?'在线':'离线'):(d.online?'Online':'Offline')}</small></Button>)}</div>
        {device&&<FieldGroup>
          <ChoiceSelect label={zh?'工作空间':'Workspace'} value={room} items={device.rooms.map(r=>({value:r.id,label:r.id+' · '+roleLabel(r.role)}))} onValueChange={setRoom}/>
          <ChoiceSelect label={zh?'连接方式':'Connection'} value={mode} items={[
            {value:'auto',label:zh?'自动：直连优先':'Auto: prefer direct'},
            {value:'relay',label:zh?'云端中继':'Cloud relay'},
            {value:'webrtc',label:zh?'仅 WebRTC / TURN':'WebRTC / TURN only'},
          ]} onValueChange={value=>setMode(value as RemoteMode)}/>
          <p className={styles.hint}>{zh?'自动模式仅在开始传输业务数据前回退；断线不会重复提交任务。':'Automatic fallback happens only before business data starts. Reconnecting never resubmits a task.'}</p>
          {!device.online&&<p role="status" className={styles.hint}>{zh?'办公电脑离线。请保持该电脑开机，并运行设备网关。':'The office computer is offline. Keep it powered on and run its device gateway.'}</p>}
          {mode==='webrtc'&&!device.webRTC&&<p role="alert">{zh?'此电脑尚未启用 WebRTC。':'WebRTC is not enabled for this computer.'}</p>}
          <Button variant="primary" disabled={!room||!device.online||mode==='webrtc'&&!device.webRTC} onClick={connect}>{zh?'连接电脑':'Connect to computer'}<Icon name="chevron"/></Button>
        </FieldGroup>}
      </>}
    </section>}
    {error&&<p role="alert" className={styles.error}>{error==='UNAUTHORIZED'?(zh?'访问密钥无效、过期或已被撤销。':'The access key is invalid, expired or revoked.'):(zh?'连接未完成，请核对配置后重试。':'Connection was not completed. Check the configuration and try again.')} <code>{error}</code></p>}
    <p className={styles.hint}>{zh?'每位协作者使用独立密钥，权限由办公电脑再次校验。不要分享管理员密钥。':'Give every collaborator a separate key. Permissions are checked again on the office computer. Do not share an administrator key.'}</p>
  </div>;
}
