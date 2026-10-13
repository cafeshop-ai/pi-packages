import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { AppOwner } from '../../app/owner';
import { Button } from '../../components/ui/Controls';
import { Drawer } from '../../components/ui/Drawer';
import { Icon } from '../../components/ui/Icon';
import styles from './CafeIdentity.module.scss';
export function useCafeAccount(owner:AppOwner){return useSyncExternalStore(owner.account.subscribe,owner.account.getSnapshot,owner.account.getSnapshot);}
const copy=(error:string|null,zh:boolean)=>{
 const messages:Record<string,[string,string]>={ACCOUNT_LOGIN_REQUIRED:['Café 账号登录已过期，请重新登录；房间密码没有改变。','Your Café login expired. Sign in again; the room password is unchanged.'],ACCOUNT_LOGIN_CANCELLED:['已取消账号登录，可以重新登录或选择访客。','Account login was cancelled. Try again or continue as a guest.'],ACCOUNT_LOGIN_FAILED:['账号登录没有完成，原房间已保留。','Account login did not finish. Your original room is preserved.'],ACCOUNT_LOGIN_STORAGE_UNAVAILABLE:['浏览器无法保存返回位置，请允许本站存储，或以访客继续。','The browser cannot save your return location. Enable storage for this site or continue as a guest.'],ACCOUNT_LOGIN_TRANSACTION_EXPIRED:['这次登录请求已失效，请重新打开原房间链接。','This login request expired. Reopen the original room link.']};
 return error?(messages[error]?.[zh?0:1]??(zh?'暂时无法验证 Café 账号。可以重试，或明确选择访客继续。':'Café identity is temporarily unavailable. Retry or explicitly choose guest access.')):null;
};
export function CafeIdentityChoice({owner,returnPath,onChosen}:{owner:AppOwner;returnPath:string;onChosen?:()=>void}){
 const state=useCafeAccount(owner),{i18n}=useTranslation(),zh=i18n.language.startsWith('zh');const [error,setError]=useState<string|null>(null);
 const start=async()=>{setError(null);try{if(state.account&&state.status==='ready'){owner.account.choose('account');onChosen?.();}else await owner.account.start(returnPath);}catch(e){setError(e instanceof Error?e.message:'ACCOUNT_SERVICE_UNAVAILABLE');}};
 return <div className={styles.choice} data-identity-choice>
  <div><p className={styles.eyebrow}>{zh?'先选择身份':'CHOOSE YOUR IDENTITY'}</p><h3>{zh?'以什么身份进入？':'How would you like to enter?'}</h3></div>
  <Button variant="primary" className={styles.primary} type="button" disabled={state.busy||state.status==='loading'} onClick={()=>void start()} aria-label={zh?'使用 Café 账号登录':'Sign in with Café'}><span className={styles.mark} aria-hidden="true">C</span><span>{state.account&&state.status==='ready'?(zh?'以 '+state.account.displayName+' 继续':'Continue as '+state.account.displayName):(zh?'使用 Café 账号登录':'Sign in with Café')}<small>{zh?'复用 cafecode.work 的登录状态':'Use your existing cafecode.work login'}</small></span><Icon name="chevron"/></Button>
  <Button variant="quiet" className={styles.guest} type="button" disabled={state.busy} onClick={()=>{owner.account.choose('guest');onChosen?.();}}>{zh?'以访客身份继续':'Continue as guest'}<small>{zh?'自定义昵称，无需注册账号':'Choose a nickname. No account required.'}</small></Button>
  {state.status==='loading'&&<p role="status">{zh?'正在读取 Space 登录状态…':'Checking your Space login…'}</p>}
  {copy(error??state.error,zh)&&<p role="alert" className={styles.error}>{copy(error??state.error,zh)}</p>}
  <p className={styles.note}><Icon name="lock"/>{zh?'登录只用于识别身份。无论账号还是访客，进入房间都需要房间密码。':'Login identifies you only. Both accounts and guests need the room password.'}</p>
 </div>;
}
export function CafeIdentityChip({owner,onSwitch}:{owner:AppOwner;onSwitch:()=>void}){
 const state=useCafeAccount(owner),{i18n}=useTranslation(),zh=i18n.language.startsWith('zh');
 return <div className={styles.chip} data-identity-kind={state.mode}><div><strong>{state.mode==='account'?state.account?.displayName:(zh?'访客身份':'Guest identity')}</strong><small>{state.mode==='account'?(zh?'Café 账号':'Café account'):(zh?'昵称只用于显示，不需要注册':'Choose your display nickname below')}</small></div><Button variant="quiet" type="button" onClick={onSwitch}>{zh?'切换身份':'Change identity'}</Button></div>;
}
export function CafeIdentityMenu({owner}:{owner:AppOwner}){
 const state=useCafeAccount(owner),{i18n}=useTranslation(),zh=i18n.language.startsWith('zh'),location=useLocation();const [trigger,setTrigger]=useState<HTMLElement|null>(null),[error,setError]=useState<string|null>(null);
 if(!state.enabled)return null;
 const switchTo=(mode:'choose'|'guest')=>{owner.disconnectRemote();owner.account.choose(mode);setTrigger(null);};
 const logout=async(all=false)=>{setError(null);owner.disconnectRemote();try{if(all)await owner.account.logoutAll(location.pathname);else{await owner.account.logout();setTrigger(null);}}catch(e){setError(e instanceof Error?e.message:'ACCOUNT_SERVICE_UNAVAILABLE');}};
 return <><Button variant="quiet" type="button" className={styles.identityButton} onClick={event=>setTrigger(event.currentTarget)} aria-label={zh?'身份与账号':'Identity and account'}>{state.mode==='account'&&state.account?state.account.displayName:zh?'访客身份':'Guest identity'}<small>{state.mode==='account'?'Café':zh?'访客':'Guest'}</small></Button>
 {trigger&&<Drawer label={zh?'身份与账号':'Identity and account'} closeLabel={zh?'关闭':'Close'} restoreFocusTo={trigger} onClose={()=>setTrigger(null)}><div className={styles.menu}>
  <CafeIdentityChip owner={owner} onSwitch={()=>switchTo('choose')}/>
  <p>{zh?'切换身份或退出将断开当前房间连接，不会取消已经运行的 Pi 任务。新身份仍须输入房间密码，控制权不会自动转移。':'Changing identity or signing out disconnects this room, without cancelling running Pi tasks. The new identity still needs the room password and does not inherit control.'}</p>
  {state.mode==='account'?<><Button disabled={state.busy} onClick={()=>void logout()}>{zh?'仅退出 Space':'Sign out of Space only'}</Button><Button variant="quiet" disabled={state.busy} onClick={()=>void logout(true)}>{zh?'退出所有 Café 应用…':'Sign out of all Café apps…'}</Button><Button variant="quiet" disabled={state.busy} onClick={()=>switchTo('guest')}>{zh?'改用访客身份':'Switch to guest identity'}</Button></>:<Button disabled={state.busy} onClick={()=>switchTo('choose')}>{zh?'使用 Café 账号':'Use a Café account'}</Button>}
  {copy(error??state.error,zh)&&<p role="alert" className={styles.error}>{copy(error??state.error,zh)}</p>}
 </div></Drawer>}
 </>;
}
export function CafeLoginCallback({owner}:{owner:AppOwner}){
 const {i18n}=useTranslation(),zh=i18n.language.startsWith('zh'),location=useLocation(),navigate=useNavigate(),[error,setError]=useState<string|null>(null);
 useEffect(()=>{let active=true;const timer=setTimeout(()=>{const query=new URLSearchParams(location.search),cancelled=location.pathname.endsWith('/cancelled'),signedOut=location.pathname.endsWith('/signed-out');void (async()=>{if(signedOut){owner.disconnectRemote();owner.account.choose('choose');await owner.account.refresh();navigate('/',{replace:true});return;}const path=await owner.account.complete(query.get('transaction'),cancelled?'cancelled':query.get('error'));if(active)navigate(path,{replace:true});})().catch(e=>{if(active)setError(e instanceof Error?e.message:'ACCOUNT_LOGIN_FAILED');});},0);return()=>{active=false;clearTimeout(timer);};},[owner,location.pathname,location.search,navigate]);
 return <section className={styles.callback}><p className={styles.eyebrow}>CAFÉ SPACE</p><h2>{error?(zh?'登录未完成':'Login did not finish'):(zh?'正在返回原来的房间':'Returning to your room')}</h2><p role={error?'alert':'status'}>{copy(error,zh)??(zh?'正在核对登录结果，房间密码仍由办公电脑验证。':'Checking the login result. The room password is still verified by the office computer.')}</p>{error&&<Button onClick={()=>{owner.account.choose('choose');navigate('/',{replace:true});}}>{zh?'返回 Space':'Back to Space'}</Button>}</section>;
}
