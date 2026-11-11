import React,{useEffect,useRef,useState} from 'react';
import {locale} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
import {StatusPill,Menu,Segmented,Switch} from './ui-controls.mjs';
import {Dialog} from './ui-dialog.mjs';
import {pluginResult,pluginErrorText} from './plugin-center-helpers.mjs';
import {useSocialLogin,SocialLoginDialog,SocialStorageNotice,ACTIVE_LOGIN,loginStageLabel,bilibiliLoginHint} from './social-login-ui.mjs';
import {SOCIAL_STORAGE_UNAVAILABLE,socialLoginErrorText} from './social-login-errors.mjs';

const h=React.createElement;
// B8: a new advanced connection starts on QQ (it is mostly for a self-run OneBot service).
const empty=()=>({pluginId:'@ai-buddy/qq-connect',accountId:'',label:'',httpUrl:'http://127.0.0.1:3000',webSocketUrl:'ws://127.0.0.1:3001',enabled:true});
export function socialAccountPayload(form,credential){
 const value={...form};delete value.platform;delete value.generation;
 if(credential)value.secret=form.pluginId==='@ai-buddy/qq-connect'?{accessToken:credential}:{cookie:credential};
 return value;
}
const PLATFORMS=[['bilibili','@ai-buddy/bilibili-companion','tv'],['qq','@ai-buddy/qq-connect','chats']];
const PLUGIN_NAMES={'@ai-buddy/bilibili-companion':['B站陪伴','Bilibili Companion'],'@ai-buddy/qq-connect':['QQ连接','QQ Connect']};
const clock=at=>{const d=new Date(at),today=new Date(),hm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');return d.toDateString()===today.toDateString()?hm:(d.getMonth()+1)+'/'+d.getDate()+' '+hm;};
/** B7: who uses this account (its plugin and whether that plugin is on) and how its last check went. */
export function accountUsage(account,record,check,en=locale()==='en'){
 const t=(zh,english)=>en?english:zh,[zh,english]=PLUGIN_NAMES[account?.pluginId]??[account?.pluginId??'',account?.pluginId??''],name=en?english:zh;
 const who=!account?.enabled?t('这个连接已停用','This connection is disabled'):!record?t('还没装 '+name,name+' is not installed'):record.enabled?t(name+'正在使用','In use by '+name):t(name+'已停用，暂时不用','Not in use while '+name+' is disabled');
 const last=check?.at?check.ok?t('上次检查 '+clock(check.at)+' 通过','checked '+clock(check.at)):t('上次检查 '+clock(check.at)+' 没通过','check failed at '+clock(check.at)):t('还没检查过','not checked yet');
 return who+' · '+last;
}
/** Only the trusted APP renderer can edit these bindings. Credentials are never
 * loaded back into the form, plugin iframe, account listing or diagnostic log. */
export function socialAccountSaveNotice({pluginId,checked,en=false}){
 const tr=(zh,english)=>en?english:zh;
 if(pluginId==='@ai-buddy/bilibili-companion'&&checked?.checked!==true)return tr('连接已保存，尚未验证登录。请扫码或提供 Cookie 完成验证；保存不代表能观看。','Connection saved; login is not yet verified. Scan or provide a cookie to verify. Saving does not mean you can watch.');
 return checked?.checked?tr('已检查并保存，连接正常。','Checked and saved; the connection works.'):tr('已保存，没有检查。','Saved without a check.');
}
export function SocialAccounts({api,onOpenPlugin,openLogin,socialStorage}){
 const en=locale()==='en',t=(zh,english)=>en?english:zh;
 const [accounts,setAccounts]=useState([]),[checks,setChecks]=useState({}),[installed,setInstalled]=useState([]),[form,setForm]=useState(null),[credential,setCredential]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dialog,setDialog]=useState(null),[menu,setMenu]=useState(null),[confirm,setConfirm]=useState(null),[advanced,setAdvanced]=useState(false),[checkFailed,setCheckFailed]=useState(false);
 const alive=useRef(false),running=useRef(false);
 const [storageFailed,setStorageFailed]=useState(false);
 async function call(request){return pluginResult(await api.action(request));}
 const listed=v=>{if(!alive.current)return;setAccounts(v.accounts);setChecks(v.checks??{});};
 const reload=()=>call({action:'social-accounts-list'}).then(listed,e=>{if(alive.current){if(e.code===SOCIAL_STORAGE_UNAVAILABLE)setStorageFailed(true);else setError(pluginErrorText(e));}});
 useEffect(()=>{alive.current=true;if(socialStorage?.state!=='unavailable')void reload();return()=>{alive.current=false;};},[api,socialStorage?.state]);
 // which plugin uses each account (B7)
 useEffect(()=>{let live=true;const take=value=>{if(live&&Array.isArray(value?.dsh?.installed))setInstalled(value.dsh.installed);};call({action:'community-status'}).then(take,()=>{});const off=api?.onUpdate?.(take);return()=>{live=false;off?.();};},[api]);
 const login=useSocialLogin(api,()=>void reload());
 const storage=socialStorage?.state==='unavailable'?socialStorage:login.snapshot?.socialStorage;
 const unavailable=storage?.state==='unavailable'||storageFailed;
 // B3: 「启用并扫码登录」 on an install page opens the scan dialog for that platform here.
 useEffect(()=>{if(!unavailable&&['bilibili','qq'].includes(openLogin?.platform))setDialog(openLogin.platform);},[openLogin?.at,unavailable]);
 // A plugin page's scan request is shown by the main window over that page (dashboard.mjs), not here: this tab
 // used to pop the dialog again on every later visit. A login still running reopens its dialog.
 // (not while the main window's own scan dialog for a plugin page is already showing that login)
 useEffect(()=>{if(!unavailable&&!dialog&&!globalThis.document?.querySelector?.('dialog[data-social-login][open]'))for(const [platform] of PLATFORMS)if(ACTIVE_LOGIN.includes(login.stateOf(platform).phase)&&login.stateOf(platform).phase!=='cleaning-up'){setDialog(platform);break;}},[login.snapshot,unavailable]);
 if(unavailable)return h('div',{className:'ext-col','data-social-accounts':true},h(SocialStorageNotice,{storage}));
 function edit(value){setForm({...value});setCredential('');setNotice('');setError('');setAdvanced(true);}
 async function accountAction(action,account){if(running.current||!account?.ref)return;running.current=true;setBusy(true);setError('');try{await call({action,ref:account.ref});const next=await call({action:'social-accounts-list'});if(alive.current){listed(next);if(form?.ref===account.ref)setForm(next.accounts.find(a=>a.ref===account.ref)??null);setNotice(action==='social-login-check'?t('账号和连接检查通过。','Account and connection verified.'):t('操作已完成。已有聊天记录保留。','Done. Existing conversation records are preserved.'));}}catch(cause){if(alive.current)setError(pluginErrorText(cause));if(action==='social-login-check')void reload();}finally{running.current=false;if(alive.current){setBusy(false);setConfirm(null);}}}
 // B8 「检查并保存」: the connection is checked first (OneBot answers as that bot / the cookie is that account) and saved only
 // when the check passes; after a failed check the user may still choose 「只保存，不检查」. Checking stores and sends nothing.
 async function save(event,{skipCheck=false}={}){
  event?.preventDefault?.();if(running.current||!form)return;running.current=true;setBusy(true);setError('');setNotice('');setCheckFailed(false);
  const payload=socialAccountPayload(form,credential);let checked=null;
  try{
   if(!skipCheck){try{checked=await call({action:'social-accounts-check',account:payload});}catch(e){if(alive.current){setError(t('连接检查没有通过：','The connection check did not pass: ')+socialLoginErrorText(e.code,en)+t(' 没有保存。',' Nothing was saved.'));setCheckFailed(true);}return;}}
   const result=await call({action:'social-accounts-save',account:payload});const next=await call({action:'social-accounts-list'});
   if(alive.current){listed(next);setForm(result.account);setCredential('');setNotice(socialAccountSaveNotice({pluginId:payload.pluginId,checked,en})+' '+t('到插件页选择此连接；保存不会自动连接、调用模型或发消息。','Select this connection in the plugin. Saving does not connect, call a model or send messages.'));}
  }
  catch(e){if(alive.current)setError(pluginErrorText(e));}finally{running.current=false;if(alive.current)setBusy(false);}
 }
 const accountMenu=(account,key)=>h('div',{className:'ext-menuwrap'},h('button',{type:'button',className:'ui-icon-btn','aria-haspopup':'menu','aria-expanded':menu===key,'aria-label':t('更多','More')+' · '+account.label,title:t('更多','More'),onClick:()=>setMenu(menu===key?null:key)},Icon('more',{size:16})),
  menu===key&&h(Menu,{label:t('更多','More'),className:'ext-menu-r',onClose:()=>setMenu(null),items:[{label:t('编辑连接','Edit connection'),icon:'pencil',onSelect:()=>edit(account)},{label:t('检查连接','Check connection'),icon:'refresh',onSelect:()=>void accountAction('social-login-check',account)},'separator',{label:t('断开并停用…','Disconnect and disable…'),icon:'power',onSelect:()=>setConfirm({action:'social-login-disconnect',account})},{label:t('移除连接（保留聊天）…','Remove connection (keep conversations)…'),icon:'close',danger:true,onSelect:()=>setConfirm({action:'social-account-remove',account})}]}));
 const tile=([platform,pluginId,icon])=>{
  const state=login.stateOf(platform),account=accounts.find(a=>a.pluginId===pluginId&&a.enabled)??accounts.find(a=>a.pluginId===pluginId),active=ACTIVE_LOGIN.includes(state.phase),connected=!!account?.enabled;
  const tone=active?'busy':connected?'ok':state.phase==='needs-login'?'warn':'idle',status=active||state.phase==='needs-login'?loginStageLabel(state.phase):connected?t('已连接','Connected'):account?t('已停用','Disabled'):t('未连接','Not connected');
  return h('article',{key:platform,className:'ws-card ext-acct','data-social-account-tile':platform},h('span',{className:'ext-logo',style:{'--pl':'48px'},'aria-hidden':true},Icon(icon,{size:24})),
   h('div',{className:'ext-ir-main'},h('div',{className:'ext-row'},h('b',null,platform==='qq'?'QQ':t('B站','Bilibili')),h(StatusPill,{tone},status)),h('span',null,account?account.label+' · '+account.accountId:t('还没有连接','Not connected')),
    account&&h('small',{className:'ext-cap','data-account-usage':platform},accountUsage(account,installed.find(r=>r.packageName===pluginId),checks[account.ref],en)),
    h('small',{className:'ext-cap'},platform==='qq'?t('在 QQ连接 里选一位角色替你回复允许的人。扫码不会自动发消息或调用模型。','QQ Connect uses it to answer the people you allow. Scanning does not send messages or call models.'):bilibiliLoginHint(en))),
   h('div',{className:'ext-row'},account?h(React.Fragment,null,h('button',{type:'button',className:'ui-btn ghost sm',disabled:busy||active,onClick:()=>void accountAction('social-login-check',account)},t('检查连接','Check')),h('button',{type:'button',className:'ui-btn sm',disabled:login.busy,title:t('换账号或重新登录','Switch account or log in again'),onClick:()=>setDialog(platform)},Icon('qr',{size:14}),t('换账号','Switch')),accountMenu(account,'tile-'+platform)):h('button',{type:'button',className:'ui-btn primary',disabled:login.busy,onClick:()=>setDialog(platform)},Icon('qr',{size:16}),t('扫码连接','Connect'))));};
 const field=(key,zh,english,type='text',hint)=>h('label',{key,className:'ws-fld'},h('span',null,t(zh,english)),h('input',{name:key,type,value:form[key]??'',required:true,disabled:busy,onChange:e=>setForm(v=>({...v,[key]:e.target.value}))}),hint&&h('small',null,hint));
 const qqForm=form?.pluginId?.includes('qq');
 return h('div',{className:'ext-col','data-social-accounts':true},
  h('p',{className:'ext-cap'},t('每个插件同时只用一个账号。账号凭据由本机系统加密保管，插件只拿到连接引用，页面上不显示凭据。切换账号会让旧活动失效。','One active managed account per plugin. Credentials are encrypted by this computer; plugins receive only a reference and pages never show them. Changing an account invalidates previous activity.')),
  error&&h('div',{role:'alert',className:'ui-alert warn'},Icon('alert',{size:16}),h('div',null,error)),notice&&h('div',{role:'status',className:'ui-note'},Icon('info',{size:16}),h('div',null,notice)),
  ...PLATFORMS.map(tile),
  h('details',{className:'ws-card ext-card ext-fold',open:advanced,onToggle:e=>setAdvanced(e.currentTarget.open)},h('summary',null,h('b',null,t('高级连接','Advanced connections')),h('span',{className:'ext-cap'},t('只有自己运行 OneBot 服务、或手动填 B站 Cookie 时才需要','Only for your own OneBot service or a manual Bilibili cookie'))),
   accounts.length>0&&h('div',{className:'ext-advtbl',role:'table','aria-label':t('已有连接','Existing connections')},h('div',{className:'ext-advhead',role:'row'},...[t('连接','Connection'),t('插件','Plugin'),t('账号','Account'),t('状态','Status'),''].map((x,i)=>h('span',{key:i,role:'columnheader'},x))),
    ...accounts.map(a=>h('div',{key:a.ref,className:'ext-advrow',role:'row'},h('span',{role:'cell'},a.label),h('span',{role:'cell'},a.pluginId.includes('qq')?'QQ':t('B站','Bilibili')),h('span',{role:'cell'},a.accountId),h('span',{role:'cell'},h(StatusPill,{tone:a.enabled?'ok':'idle'},a.enabled?t('启用','Enabled'):t('停用','Disabled'))),h('span',{role:'cell'},accountMenu(a,'row-'+a.ref))))),
   !form?h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn',disabled:busy,onClick:()=>edit(empty())},Icon('plus',{size:16}),t('新增连接','New connection'))):
   h('form',{onSubmit:save,className:'ext-col'},h('h4',{className:'ws-sub-h'},form.ref?t('编辑连接','Edit connection'):t('新增连接','New connection')),
    h('div',{className:'ext-advform'},h('div',{className:'ws-fld'},h('span',null,t('插件','Plugin')),h(Segmented,{label:t('插件','Plugin'),value:form.pluginId,disabled:busy||!!form.ref,onChange:pluginId=>{setForm({...empty(),pluginId});setCredential('');},options:[['@ai-buddy/qq-connect','QQ'],['@ai-buddy/bilibili-companion',t('B站','Bilibili')]]})),
     field('label','连接名称','Connection name'),field('accountId',qqForm?'机器人 QQ 号':'B站账号 UID',qqForm?'Bot QQ number':'Bilibili account UID'),
     qqForm&&field('httpUrl','本机 OneBot HTTP 地址','Local OneBot HTTP URL','url',t('只能是本机地址','Local addresses only')),qqForm&&field('webSocketUrl','本机 OneBot WebSocket 地址','Local OneBot WebSocket URL','url',t('只能是本机地址','Local addresses only')),
     h('label',{className:'ws-fld'},h('span',null,qqForm?t('访问令牌','Access token'):t('B站 Cookie','Bilibili cookie')),h('input',{type:'password',autoComplete:'off',value:credential,disabled:busy,placeholder:t('留空保留已保存的','Leave blank to keep the saved one'),onChange:e=>setCredential(e.target.value),'aria-label':qqForm?t('访问令牌','Access token'):t('B站 Cookie','Bilibili cookie')}),h('small',null,t('保存后加密保管，页面上不再显示','Encrypted after saving; never shown again')))),
    h('div',{className:'ext-row'},h(Switch,{checked:form.enabled!==false,disabled:busy,label:t('启用此账号连接','Enable this account connection'),onChange:value=>setForm(v=>({...v,enabled:value}))}),h('span',null,t('启用此账号连接','Enable this account connection'))),
    h('div',{className:'ws-row-btns'},h('button',{type:'submit',className:'ui-btn primary',disabled:busy},busy?t('正在检查…','Checking…'):t('检查并保存','Check and save')),checkFailed&&h('button',{type:'button',className:'ui-btn ghost',disabled:busy,onClick:()=>void save(null,{skipCheck:true})},t('只保存，不检查','Save without checking')),h('button',{type:'button',className:'ui-btn ghost',disabled:busy,onClick:()=>setForm(null)},t('取消','Cancel')),h('span',{className:'ext-cap'},t('保存不会自动连接、调用模型或发消息。','Saving does not connect, call models or send messages.'))))),
  dialog&&h(SocialLoginDialog,{platform:dialog,login,onClose:()=>setDialog(null),onOpenPlugin}),
  confirm&&h(Dialog,{title:confirm.action==='social-account-remove'?t('移除这个连接？','Remove this connection?'):t('断开并停用这个连接？','Disconnect and disable this connection?'),subtitle:confirm.account.label+' · '+confirm.account.accountId,onClose:()=>setConfirm(null),busy,
   footer:h(React.Fragment,null,h('span',{className:'spacer'}),h('button',{type:'button',className:'ui-btn ghost',disabled:busy,onClick:()=>setConfirm(null)},t('取消','Cancel')),h('button',{type:'button',className:'ui-btn danger',disabled:busy,onClick:()=>void accountAction(confirm.action,confirm.account)},confirm.action==='social-account-remove'?t('移除连接（保留聊天）','Remove connection (keep conversations)'):t('断开并停用','Disconnect and disable')))},
   h('p',null,confirm.action==='social-account-remove'?t('移除后插件就用不了这个账号了。聊天记录保留，以后重新连接可以接着用。','The plugin can no longer use this account. Conversations are kept for when you reconnect.'):t('连接会断开并停用，凭据仍加密保存，之后可以重新启用。','The connection is closed and disabled. The credential stays encrypted so you can enable it again.'))));
}
