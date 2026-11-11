import React,{useEffect,useRef,useState} from 'react';
import {locale} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {Dialog} from './ui-dialog.mjs';
import {pluginResult} from './plugin-center-helpers.mjs';
import {socialLoginErrorText} from './social-login-errors.mjs';
const h=React.createElement;
const stages={
 'not-connected':['未连接','Not connected'],preparing:['正在准备连接…','Preparing connection…'],
 'waiting-qr':['请用手机 App 扫码','Scan with the mobile app'],'waiting-confirmation':['请在手机上确认登录','Confirm login on your phone'],
 verifying:['正在检查账号和连接…','Verifying account and connection…'],connected:['账号已连接','Account connected'],
 'cleaning-up':['正在关闭本次连接，请稍候…','Closing this connection. Please wait…'],
 'needs-login':['登录已失效，请重新扫码','Login expired. Please scan again.'],cancelled:['已取消','Cancelled'],failed:['连接未完成，请重试','Connection failed. Please retry'],
};
export const ACTIVE_LOGIN=['preparing','waiting-qr','waiting-confirmation','verifying','cleaning-up'];
export const loginStageLabel=phase=>stages[phase]?.[locale()==='en'?1:0]??phase;
/** B7: opening the dialog starts the scan, unless a login for that platform is already running. */
export const loginAutoStarts=phase=>!ACTIVE_LOGIN.includes(phase);
export const bilibiliLoginHint=(en=locale()==='en')=>en?'Connect a Bilibili account before watching. Scan in the official Bilibili login window; comments still need a separate permission in the plugin':'先连接一个 B站账号才能看。在 B站官方登录窗口扫码；发表评论仍需插件中的单独授权';
// A QQ login code is valid for about two minutes; a new code from the connector restarts the count.
export const QR_LIFETIME_MS=120000;
export const qrSecondsLeft=(since,now=Date.now())=>Number.isFinite(since)?Math.max(0,Math.ceil((QR_LIFETIME_MS-(now-since))/1000)):null;
export function qrExpiryText(seconds,en=locale()==='en'){
 if(seconds==null)return '';if(seconds<=0)return en?'This code may have expired. Refresh it.':'二维码可能已过期，请刷新。';
 const m=Math.floor(seconds/60),s=seconds%60;
 return en?`Expires in ${m}:${String(s).padStart(2,'0')}`:(m?`${m} 分 ${s} 秒后过期`:`${s} 秒后过期`);
}
/** Polls the login state of both platforms (unchanged cadence: every 1.5 s while the page is open). */
export function useSocialLogin(api,onAccountsChanged=()=>{}){
 const en=locale()==='en',t=(a,b)=>en?b:a;
 const [snapshot,setSnapshot]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[errorCode,setErrorCode]=useState(''),[requested,setRequested]=useState(null);
 const alive=useRef(false),actions=useRef(0),actionSequence=useRef(0),seenRequest=useRef(null),seenConnected=useRef(new Set()),changed=useRef(onAccountsChanged);changed.current=onAccountsChanged;
 const call=async request=>pluginResult(await api.action(request));
 useEffect(()=>{
  alive.current=true;let timer,pending=false;
  const update=async()=>{if(pending||!alive.current)return;pending=true;try{const value=await call({action:'social-login-status'});if(!alive.current)return;setSnapshot(value);
   if(value.requestId&&seenRequest.current!==value.requestId){seenRequest.current=value.requestId;setRequested(value.requestedPlatform);}
   for(const row of value.states)if(row.phase==='connected'&&!seenConnected.current.has(row.attemptId)){seenConnected.current.add(row.attemptId);changed.current();}
  }catch{if(alive.current)setError(t('无法读取登录状态，请重新打开连接页。','Unable to read login status. Reopen this page.'));}finally{pending=false;if(alive.current)timer=setTimeout(update,1500);}};
  void update();return()=>{alive.current=false;clearTimeout(timer);};
 },[api]);
 // the error code stays out of the sentence; the dialog shows it under 技术详情
 async function act(action,platform,payload={}){
  // Closing a rescan can revoke its restart before the start IPC returns.
  if(actions.current&&action!=='social-login-cancel')return;
  actions.current++;
  const sequence=++actionSequence.current,canUpdate=()=>alive.current&&sequence===actionSequence.current;
  if(alive.current){setBusy(true);setError('');setErrorCode('');}try{
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['official','retryAttemptId'].includes(key))||Object.keys(payload).length&&action!=='social-login-start'||payload.official!==undefined&&typeof payload.official!=='boolean'||payload.retryAttemptId!==undefined&&(typeof payload.retryAttemptId!=='string'||payload.retryAttemptId.length>100))throw Object.assign(Error('Invalid login retry'),{code:'SOCIAL_LOGIN_RETRY_STALE'});
  const result=await call({action,platform,...(payload.official!==undefined?{official:payload.official}:{}),...(payload.retryAttemptId!==undefined?{retryAttemptId:payload.retryAttemptId}:{})});if(canUpdate())setSnapshot(old=>({...old,states:(old?.states??[]).map(row=>row.platform===platform?result:row)}));
 }catch(cause){if(canUpdate()){setError(socialLoginErrorText(cause?.code,en,cause?.host??cause?.details?.host??''));setErrorCode(typeof cause?.code==='string'?cause.code:'SOCIAL_LOGIN_FAILED');}}finally{
  actions.current--;if(alive.current&&!actions.current)setBusy(false);
 }}
 const stateOf=platform=>snapshot?.states?.find(row=>row.platform===platform)??{phase:'not-connected'};
 return {snapshot,stateOf,component:snapshot?.component,busy,error,errorCode,act,requested,clearRequested:()=>setRequested(null)};
}
/** Scan-to-connect as a four-step modal (approved design B7). Closing while a login is running cancels it. */
export function SocialLoginDialog({platform,login,onClose,onOpenPlugin,autoStart=true}){
 const en=locale()==='en',t=(a,b)=>en?b:a;
 const state=login.stateOf(platform),active=ACTIVE_LOGIN.includes(state.phase),qq=platform==='qq',component=login.component;
 // B7: one click on 「扫码连接」 is enough; the dialog starts the scan as soon as it knows nothing is running yet
 const started=useRef(false);
 useEffect(()=>{if(!autoStart||started.current||!login.snapshot)return;started.current=true;const current=login.stateOf(platform);if(loginAutoStarts(current.phase)&&!(platform==='qq'&&current.phase==='failed'))void login.act('social-login-start',platform);},[login.snapshot]);
 // QR expiry countdown, from when this code appeared
 const [qrSince,setQrSince]=useState(()=>state.qr?Date.now():null),[clock,setClock]=useState(()=>Date.now());
 useEffect(()=>{setQrSince(state.qr?Date.now():null);},[state.qr]);
 useEffect(()=>{if(!qrSince)return;const timer=setInterval(()=>setClock(Date.now()),1000);return()=>clearInterval(timer);},[qrSince]);
 const left=state.phase==='waiting-qr'&&state.qr?qrSecondsLeft(qrSince,Math.max(clock,qrSince??0)):null;
 const at={preparing:0,'waiting-qr':1,'waiting-confirmation':2,verifying:2,connected:3}[state.phase]??-1;
 const steps=[qq?t('准备连接组件','Prepare'):t('打开登录窗口','Open login'),t('手机扫码','Scan'),t('手机上确认','Confirm'),t('完成','Done')];
 const canCancel=state.phase!=='cleaning-up'||state.rescanPending;
 const close=()=>{if(active&&canCancel||qq&&login.busy&&state.errorCode==='SOCIAL_LOGIN_STOP_PENDING')void login.act('social-login-cancel',platform);onClose();};
 const failed=['needs-login','cancelled','failed'].includes(state.phase);
 const officialRetry=qq&&state.phase==='failed'&&state.errorCode==='NETWORK_MIRROR_MISMATCH'&&state.retryOfficial===true&&typeof state.attemptId==='string';
 const safety=qq?t('扫码本身不会自动发消息、发表评论或调用模型。不会读取你日常 QQ 的资料。','Scanning does not send messages, post comments or call a model, and does not read your everyday QQ data.'):t('扫码本身不会自动发表评论或调用模型。','Scanning does not post comments or call a model.');
 return h(Dialog,{title:qq?t('连接 QQ 账号','Connect a QQ account'):t('连接 B站账号','Connect a Bilibili account'),subtitle:qq?t('用来让角色在 QQ 里回复你允许的人','So a character can answer the people you allow'):bilibiliLoginHint(en),onClose:close,'data-social-login':platform,
  footer:h(React.Fragment,null,active&&h('button',{type:'button',className:'ui-btn ghost',disabled:login.busy||!canCancel,onClick:close},t('取消','Cancel')),h('span',{className:'spacer'}),
   state.phase==='connected'?h(React.Fragment,null,onOpenPlugin&&h('button',{type:'button',className:'ui-btn primary',onClick:()=>{onClose();onOpenPlugin(qq?'@ai-buddy/qq-connect':'@ai-buddy/bilibili-companion');}},Icon('external',{size:16}),qq?t('去设置 QQ连接','Set up QQ Connect'):t('去设置 B站陪伴','Set up Bilibili Companion')),h('button',{type:'button',className:'ui-btn ghost',onClick:onClose},t('完成','Done')))
   :!active&&h(React.Fragment,null,officialRetry&&h('button',{type:'button',className:'ui-btn primary',disabled:login.busy,'data-social-login-official-retry':true,onClick:()=>void login.act('social-login-start',platform,{official:true,retryAttemptId:state.attemptId})},t('改用官方地址重试','Retry using official addresses')),h('button',{type:'button',className:'ui-btn '+(officialRetry?'ghost':'primary'),disabled:login.busy,onClick:()=>void login.act('social-login-start',platform)},Icon('qr',{size:16}),failed?t('重新扫码','Scan again'):t('开始连接','Start'))))},
  h('ol',{className:'ext-steps'},...steps.map((label,i)=>h('li',{key:i,className:i<at||state.phase==='connected'?'done':i===at?'cur':''},h('span',null,i<at||state.phase==='connected'?Icon('check',{size:12}):i+1),label))),
  h('p',{role:'status','aria-live':'polite',className:'ext-login-status'},active&&h('span',{className:'ui-spinner','aria-hidden':true}),h('b',null,stages[state.phase]?.[en?1:0]??state.phase)),
  !['waiting-qr','connected'].includes(state.phase)&&h('p',{className:'ext-cap'},safety),
  state.phase==='preparing'&&qq&&h('div',{className:'ext-col'},h('p',{className:'ext-cap'},t('第一次连接 QQ 会自动准备独立的连接组件，不用装 Node，也不用填端口和 Token。','The first QQ connection prepares a separate connector automatically. No Node, ports or tokens to enter.')),state.totalBytes>0&&h('progress',{className:'ext-progress',max:state.totalBytes,value:state.downloadedBytes??0,'aria-label':t('组件下载进度','Component download progress')}),state.totalBytes>0&&h('small',{className:'ext-cap'},((state.downloadedBytes??0)/1e6).toFixed(1)+' / '+(state.totalBytes/1e6).toFixed(1)+' MB')),
  state.phase==='waiting-qr'&&h('div',{className:'ext-qrwrap'},state.qr?h('img',{className:'ext-qr',src:state.qr,alt:qq?t('使用手机QQ扫描此二维码','Scan this code with mobile QQ'):t('用手机 B站扫这个二维码','Scan with the Bilibili app')}):null,h('div',{className:'ext-col'},h('b',null,qq?t('用手机 QQ 扫这个二维码','Scan with QQ on your phone'):state.qr?t('用手机 B站扫这个二维码','Scan with the Bilibili app'):t('在弹出的 B站官方登录窗口里扫码','Scan in the official Bilibili login window')),h('p',{className:'ext-cap'},safety),h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn sm',disabled:login.busy,onClick:()=>void login.act('social-login-refresh',platform)},Icon('refresh',{size:14}),t('刷新二维码','Refresh QR code')),left!=null&&h('span',{className:'ext-cap','data-qr-expiry':left},qrExpiryText(left,en))))),
  state.phase==='waiting-confirmation'&&h('p',{className:'ext-cap'},t('需要设备验证时，在手机上完成，确认后会自动检查连接。','If device verification appears, finish it on your phone; the connection is checked automatically.')),
  state.phase==='connected'&&h('div',{className:'ui-alert ext-okalert'},Icon('check',{size:16}),h('div',null,h('b',null,state.account?state.account.label+' · '+state.account.accountId:t('账号已连接','Account connected')),h('p',null,qq?t('下一步在 QQ连接 里选角色和允许的联系人，然后启用。','Next, choose a character and allowed contacts in QQ Connect, then enable it.'):t('下一步在 B站陪伴 里选角色和观看设置，然后启用。','Next, choose a character and viewing settings in Bilibili Companion, then enable it.')))),
  state.errorCode&&h('div',{className:'ui-alert warn',role:'alert'},Icon('alert',{size:16}),h('div',null,socialLoginErrorText(state.cleanupErrorCode==='QQ_COMPONENT_STOP_RECEIPT_WRITE_FAILED'?state.cleanupErrorCode:state.errorCode,en,state.errorHost??''),h('details',{className:'ext-tech'},h('summary',null,t('技术详情','Technical details')),h('code',null,state.errorCode+(state.errorHost?' · '+state.errorHost:'')+(state.errorDiagnostic?' · '+state.errorDiagnostic.systemCode+' · '+state.errorDiagnostic.syscall+' · '+state.errorDiagnostic.source+' → '+state.errorDiagnostic.target:'')),
   qq&&state.attemptId&&h('div',null,t('尝试编号','Attempt ID'),' · ',h('code',null,state.attemptId)),
   (state.startErrorCode||state.startStage)&&h('div',null,t('连接失败','Connection error'),' · ',h('code',null,[state.startStage,state.startErrorCode??state.errorCode].filter(Boolean).join(' · '))),
   state.cleanupErrorCode&&h('div',null,t('清理失败','Cleanup error'),' · ',h('code',null,[state.cleanupStage,state.cleanupErrorCode].filter(Boolean).join(' · ')))))),
  login.error&&h('div',{role:'alert',className:'ext-err'},h('p',null,login.error),login.errorCode&&h('details',{className:'ext-tech'},h('summary',null,t('技术详情','Technical details')),h('code',null,login.errorCode))),
  qq&&component&&h('details',{className:'ext-tech'},h('summary',null,t('连接组件','Connection component')),h('code',null,`NapCat ${component.version} · ${(component.bytes/1e6).toFixed(1)} MB · Windows x64\n`+t('首次点击连接即从 NapCat 固定发行版下载。第三方连接组件，保留其 Limited Redistribution License。','First connection downloads the pinned NapCat release. This third-party component retains its Limited Redistribution License.')),h('a',{href:component.url,target:'_blank',rel:'noreferrer'},t('查看固定下载来源','View pinned download source'))));
}
/** C-4 / B7: the scan dialog the main window shows over the page it is on when a plugin page asks for a login. */
export function SocialLoginRequest({api,platform,onClose,onOpenPlugin}){
 const login=useSocialLogin(api);
 return h(SocialLoginDialog,{platform,login,onClose,onOpenPlugin});
}
