import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
const fail=code=>Object.assign(Error(code),{code});
export const BILIBILI_LOGIN_URL='https://passport.bilibili.com/login';
export function bilibiliLoginNavigation(value){try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&(url.hostname==='bilibili.com'||url.hostname.endsWith('.bilibili.com'));}catch{return false;}}
export function bilibiliVerifiedAccount(nav,cookies){
 if(nav?.code!==0||nav.data?.isLogin!==true||!/^\d{1,20}$/.test(String(nav.data.mid)))throw fail('SOCIAL_LOGIN_NOT_VERIFIED');
 const selected=cookies.filter(c=>['bilibili.com','.bilibili.com'].includes(c.domain)&&['SESSDATA','bili_jct','DedeUserID','DedeUserID__ckMd5'].includes(c.name));
 const value=Object.fromEntries(selected.map(c=>[c.name,c.value]));
 if(!value.SESSDATA||!value.bili_jct||value.DedeUserID!==String(nav.data.mid)||Object.values(value).some(v=>/[;\r\n\0]/.test(v)))throw fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');
 return {accountId:String(nav.data.mid),label:String(nav.data.uname||nav.data.mid).slice(0,180),avatar:nav.data.face,secret:{cookie:Object.entries(value).map(([k,v])=>k+'='+v).join('; ')}};
}
export function createBilibiliLoginDriver({BrowserWindow,session,now=Date.now}={}){
 let live=null,closed=false;
 async function dispose(row){if(!row)return;row.abort.abort();if(!row.window.isDestroyed())row.window.destroy();await row.session.clearStorageData();await row.session.clearCache();if(live===row)live=null;}
 async function start({attemptId,signal,update}){
  if(closed)throw fail('SOCIAL_LOGIN_CLOSED');await dispose(live);signal.throwIfAborted();
  const privateSession=session.fromPartition('buddy-bilibili-login-'+randomUUID(),{cache:false});
  privateSession.setPermissionRequestHandler((_web,_permission,callback)=>callback(false));privateSession.setPermissionCheckHandler(()=>false);
  privateSession.on('will-download',event=>event.preventDefault());
  const window=new BrowserWindow({width:900,height:740,title:'登录 B站 · AI 酱',autoHideMenuBar:true,webPreferences:{session:privateSession,sandbox:true,nodeIntegration:false,contextIsolation:true,webSecurity:true,navigateOnDragDrop:false}});
  const row={attemptId,window,session:privateSession,abort:new AbortController()};live=row;
  const combined=AbortSignal.any([signal,row.abort.signal]);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  for(const eventName of ['will-navigate','will-redirect'])window.webContents.on(eventName,(event,url)=>{if(!bilibiliLoginNavigation(url))event.preventDefault();});
  window.on('closed',()=>row.abort.abort());
  try{
   await window.loadURL(BILIBILI_LOGIN_URL);update({phase:'waiting-qr'});const deadline=now()+10*60*1000;
   while(!combined.aborted&&now()<deadline){
    let result;
    try{const response=await privateSession.fetch('https://api.bilibili.com/x/web-interface/nav',{credentials:'include',redirect:'error',signal:AbortSignal.any([combined,AbortSignal.timeout(6000)])});if(response.ok)result=await response.json();}catch(cause){if(combined.aborted)throw cause;}
    if(result?.code===0&&result.data?.isLogin===true){update({phase:'verifying'});const account=bilibiliVerifiedAccount(result,await privateSession.cookies.get({url:'https://www.bilibili.com/'}));combined.throwIfAborted();return account;}
    await delay(2000,undefined,{signal:combined});
   }
   throw fail(combined.aborted?'SOCIAL_LOGIN_CANCELLED':'SOCIAL_LOGIN_EXPIRED');
  }catch(cause){if(combined.aborted)throw fail('SOCIAL_LOGIN_CANCELLED');throw cause;}
  finally{await dispose(row);}
 }
 return {start,async check(account,secret,{signal}={}){signal?.throwIfAborted();const response=await fetch('https://api.bilibili.com/x/web-interface/nav',{headers:{cookie:secret.cookie??'',referer:'https://www.bilibili.com/'},redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(8000)].filter(Boolean))});if(!response.ok)throw fail('SOCIAL_LOGIN_NETWORK_ERROR');const value=await response.json();if(value.code===-101||value.code===0&&value.data?.isLogin===false)throw fail('SOCIAL_LOGIN_EXPIRED');if(value.code!==0||value.data?.isLogin!==true)throw fail('SOCIAL_LOGIN_NETWORK_ERROR');if(String(value.data.mid)!==account.accountId)throw fail('SOCIAL_LOGIN_IDENTITY_MISMATCH');return {connected:true};},stop:async({attemptId}={})=>{if(live&&(!attemptId||live.attemptId===attemptId))await dispose(live);},refresh:async()=>{if(live&&!live.window.isDestroyed())await live.window.loadURL(BILIBILI_LOGIN_URL);},close:async()=>{closed=true;await dispose(live);}};
}
