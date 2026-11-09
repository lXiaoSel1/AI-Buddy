import React from 'react';
import {locale,t} from '../i18n.mjs';
import {StatusPill,Switch,Menu} from '../ui-controls.mjs';
import {Dialog} from '../ui-dialog.mjs';
import {legacyUpdateKey} from '../plugin-update-policy.mjs';
import {VoiceIcon} from './design-icons.mjs';
import {voiceComponentSummary} from './component-state.mjs';

const h=React.createElement;
const L=(zh,en)=>locale()==='en'?en:zh;
export const VOICE_PAGES=Object.freeze([
 {id:'ai-buddy.voice-breeze',short:'Breeze',icon:'voice-breeze',kind:'breeze',gpu:'9.5 GB'},
 {id:'ai-buddy.voice-gpt-sovits',short:'GPT-SoVITS',icon:'voice-gpt',kind:'gpt',gpu:'4 GB'}
]);
export const voicePackageLabel=id=>{const value=VOICE_PAGES.find(row=>row.id===id);return value?value.short+L(' 语音',' Voice'):L('语音','Voice');};
export function VoiceLogo({packageId,size=44}){
 const value=VOICE_PAGES.find(row=>row.id===packageId);
 return h('span',{className:'ext-logo vx-logo vx-logo-'+(value?.kind??'breeze'),style:{'--pl':size+'px'},'aria-hidden':true},VoiceIcon(value?.icon??'wave',{size:Math.round(size*.5)}));
}
export function voicePackagePresentation(snapshot,packageId,record){
 const state=snapshot?.state,current=record??state?.packages?.find(row=>row.id===packageId),selected=state?.selectedPackageId===packageId,phase=state?.preparation?.state??snapshot?.preparation?.state??'idle';
 const disabled=current&&(current.enabled===false||current.usable===false);
 const components=snapshot?.componentStatuses?.[packageId]??state?.componentStatuses?.[packageId]??(selected&&state?.assets?voiceComponentSummary(state.assets):null),needsParts=components&&!components.ready;
 const status=disabled?'disabled':needsParts?(components.state==='preparing'?'starting':components.state==='verification-needed'?'verification-needed':'needsSetup'):!selected?'idleOther':!state?.settings?.enabled?'off':['checking','verifying','loading','stopping'].includes(phase)?'starting':phase==='ready'?'ready':phase==='failed'?'failed':'off';
 const labels={ready:['ok',L('已就绪','Ready')],starting:['busy',L('启动中','Starting')],failed:['err',L('没能启动','Could not start')],off:['idle',L('未启动','Not started')],idleOther:['idle',L('没在使用','Not in use')],disabled:['idle',L('已停用','Disabled')],'verification-needed':['warn',L('需要校验','Needs verification')],needsSetup:['warn',L('需要准备','Needs setup')]};
 return {status,selected,tone:labels[status][0],label:labels[status][1]};
}
// This is the installed row used by CommunityCenter. It deliberately keeps legacy
// package actions and keys; its appearance does not turn it into a DSH package.
export function VoicePackageRow({row,record,snapshot,session,call,run=fn=>fn(),busy=false,menuOpen=false,onMenu,onOpen,onConfirm,onUpdate}){
 const m=row.manifest,value=VOICE_PAGES.find(value=>value.id===m.id),key=legacyUpdateKey(row.sourceId??'legacy',m.id),policy=row.updatePolicy??'manual',view=voicePackagePresentation(snapshot,m.id,record),active=view.status==='ready',openParts=['verification-needed','needsSetup'].includes(view.status),phaseBusy=view.status==='starting',enabled=!!row.enabled;
 const unavailable=record?.usable!==true,canEnable=row.compatible!==false&&row.activation?.supported===true;
 const action=action=>run(()=>call({action,id:m.id,sourceId:row.sourceId}));
 const label=active?view.label+L(' · 聊天在用',' · used in chat'):view.status==='idleOther'?L('未启动','Not started'):view.label;
 const provider=snapshot?.state?.settings?.packages?.[m.id]?.ttsProvider==='minimax';
 const situation=!enabled?L('配音设置和角色资料会保留。','Voices and settings are kept.'):provider?L('MiniMax 云配音 · 不占本机显卡','MiniMax cloud voice · no local GPU needed'):L('本机配音','On this PC')+(active?'':' · '+L('需要 ','needs ')+value.gpu+L(' 显存',' GPU memory'));
 const items=[
  {label:L('更新方式：手动更新','Update policy: manual'),icon:'sliders',checked:policy==='manual',disabled:busy,onSelect:()=>run(()=>call({action:'community-set-update-policy',packageKey:key,policy:'manual'}))},
  {label:L('更新方式：自动更新兼容补丁','Update policy: automatic compatible patches'),icon:'sliders',checked:policy==='auto',disabled:busy,onSelect:()=>run(()=>call({action:'community-set-update-policy',packageKey:key,policy:'auto'}))},
  'separator',
  row.previous&&{label:L('回退到上一个版本…','Roll back to the previous version…'),icon:'retry',disabled:busy,onSelect:()=>onConfirm?.({kind:'rollback',record:{...record,packageName:m.id,sourceId:row.sourceId,backend:'legacy'}})},
  {label:L('卸载（保留角色声音和设置）…','Uninstall (keep voices and settings)…'),icon:'close',danger:true,disabled:busy,onSelect:()=>onConfirm?.({kind:'uninstall',record:{...record,packageName:m.id,sourceId:row.sourceId,backend:'legacy'}})}
 ].filter(Boolean);
 return h('article',{className:'ws-card ext-irow',key,'data-voice-installed':m.id},h(VoiceLogo,{packageId:m.id}),
  h('div',{className:'ext-ir-main'},h('div',{className:'ext-row'},h('b',null,voicePackageLabel(m.id)),h('span',{className:'ext-cap'},m.version),h(StatusPill,{tone:view.tone},label),onUpdate&&h('button',{type:'button',className:'ws-tag ext-tagbtn',onClick:onUpdate},t('有更新'))),h('small',{className:'ext-cap'},situation)),
  h('div',{className:'ext-row'},h('span',{className:'ext-cap'},L('启用','Enabled')),h(Switch,{checked:enabled,disabled:busy||!enabled&&!canEnable,label:t(enabled?'停用':'启用')+' · '+voicePackageLabel(m.id),'data-voice-enable':m.id,onChange:()=>action(enabled?'disable':'enable')}),
   h('button',{type:'button',className:'ui-btn'+(!active?' primary':''),disabled:busy||!enabled||unavailable||phaseBusy||!session,'data-voice-start':!active&&!openParts?m.id:undefined,'data-voice-open':active||openParts?m.id:undefined,onClick:()=>active||openParts?onOpen?.(m.id):run(()=>session.configure({enabled:true,selectedPackageId:m.id}))},VoiceIcon(active||openParts?'external':'play',{size:16}),active||openParts?L('打开','Open'):phaseBusy?L('启动中','Starting'):L('启动','Start')),
   h('div',{className:'ext-menuwrap'},h('button',{type:'button',className:'ui-icon-btn','aria-haspopup':'menu','aria-expanded':menuOpen,'aria-label':t('更多')+' · '+voicePackageLabel(m.id),title:t('更多'),onClick:()=>onMenu?.(!menuOpen)},VoiceIcon('more',{size:16})),menuOpen&&h(Menu,{label:t('更多'),className:'ext-menu-r vx-menu',onClose:()=>onMenu?.(false),items}))));
}

export function CommunityMaintenanceConfirmation({confirm,busy=false,run=fn=>fn(),call,onClose}){
 const uninstall=confirm.kind==='uninstall',record=confirm.record,legacy=record.backend==='legacy',name=legacy?voicePackageLabel(record.packageName):record.displayName??record.packageName;
 return h(Dialog,{title:t(uninstall?'卸载 {name}？':'回退 {name}？').replace('{name}',name),onClose,busy,footer:h(React.Fragment,null,h('span',{className:'spacer'}),h('button',{type:'button',className:'ui-btn ghost',disabled:busy,onClick:onClose},t('取消')),h('button',{type:'button',className:'ui-btn '+(uninstall?'danger':'primary'),disabled:busy,'data-community-maintenance-confirm':true,onClick:()=>run(async()=>{await call(legacy?{action:uninstall?'uninstall':'rollback',id:record.packageName,sourceId:record.sourceId}:{action:uninstall?'dsh-uninstall':'dsh-rollback',packageKey:record.packageKey});onClose?.();})},t(uninstall?'卸载，保留数据':'回退代码')))},h('p',null,t(uninstall?'插件会停用并删除，个人数据、聊天记录和账号连接都保留，以后重新安装可以接着用。':'回到上一个版本的代码，个人数据不变。')));
}

export function VoiceGeneralSettingsPanel({snapshot,session,onOpen,onPlugins}){
 const state=snapshot?.state,installed=state?.packages?.filter(row=>row.installed)??[],id=state?.selectedPackageId??installed[0]?.id,view=voicePackagePresentation(snapshot,id),provider=state?.settings?.packages?.[id]?.ttsProvider==='minimax';
 const row=(title,note,control)=>h('div',{className:'ws-srow'},h('div',null,h('b',null,title),note&&h('small',null,note)),control);
 return h('section',{className:'ws-card ws-set vx-setcard','data-voice-general-settings':true},h('h2',{className:'ws-sec'},L('语音','Voice')),
  row(L('语音','Voice'),L('她的回复会读出来，也能用 Live 轮流说话。','Her replies are read aloud, and Live lets you take turns talking.'),h(Switch,{checked:state?.settings?.enabled===true,label:L('语音','Voice'),disabled:!state||!installed.length||snapshot?.working,'data-voice-master':true,onChange:enabled=>session?.configure({enabled})})),
  row(L('聊天配音','Chat voice'),installed.length?voicePackageLabel(id)+' · '+(provider?L('MiniMax 云端','MiniMax cloud'):L('这台电脑','this PC'))+' · '+view.label:L('去扩展中心安装语音插件','Install a voice plugin in Extensions'),h('button',{type:'button',className:'ui-btn sm','data-voice-settings-open':true,onClick:()=>installed.length?onOpen?.(id):onPlugins?.()},VoiceIcon(installed.length?(VOICE_PAGES.find(row=>row.id===id)?.icon??'wave'):'nav-plugins',{size:16}),installed.length?L('打开 ','Open ')+voicePackageLabel(id):L('打开扩展中心','Open Extensions'))),
  h('p',{className:'settings-note'},L('角色声音、本机组件和云配音都在语音插件页里。','Character voices, local parts and cloud voice are on the voice plugin page.')),snapshot?.error&&h('p',{className:'settings-error',role:'alert'},snapshot.error));
}
