// One install page per plugin (approved design B3). The page only shows and collects; every step is still the
// community service's own action: dsh-plan → (runtime component) → dsh-install with the ticked ids → dsh-enable.
import React from 'react';
import {t as coreT,locale} from './i18n.mjs';
import {communityMessages,communityCount} from './community/messages.mjs';
import {Icon} from './ui-icons.mjs';
import {StatusPill} from './ui-controls.mjs';
import {capabilityView,officialProfile,pluginIcon,workText,formatBytes} from './community-capabilities.mjs';
import {isVoiceEnginePackage} from './voice/package-contract.mjs';
const h=React.createElement;
const t=value=>locale()==='en'?communityMessages[value]??coreT(value):coreT(value);
const tn=(key,n)=>communityCount(key,n,t);
export const PluginLogo=({packageName,size=44})=>h('span',{className:'ext-logo',style:{'--pl':size+'px'},'aria-hidden':true},Icon(pluginIcon(packageName),{size:Math.round(size*.5)}));
const list=rows=>h('ul',{className:'ext-ilist'},...rows.map((row,i)=>h('li',{key:i},h('span',{className:'ext-cap-ic'},Icon(row.icon,{size:16})),h('span',null,row.text))));
// stage: plan | runtime | installing | installed | unavailable (no signed plan can be read yet: catalog not online, no file imported)
export function installStage({plan,runtimeNeeded,job,record,unavailable=false}){
 if(record)return 'installed';
 if(job&&['queued','running','failed','needs-user','interrupted-needs-user'].includes(job.state))return 'installing';
 if(runtimeNeeded)return 'runtime';
 if(unavailable&&!plan)return 'unavailable';
 return 'plan';
}
// Work engines found on this PC (丙7). Missing engines are left out; Kimi 1.0.0 is shown as it is: not compatible.
const ENGINE_STATE={'signed-in':['ok','已登录'],'signed-out':['warn','还没登录'],ready:['ok','可以用'],incompatible:['warn','不兼容'],installed:['ok','已安装'],available:['idle','可以安装']};
export function engineRows(engines){
 return (engines??[]).filter(row=>ENGINE_STATE[row.state]).map(row=>({engine:row.engine,name:row.engine==='codex'?'Codex':row.engine==='claude'?'Claude':row.engine==='dsh'?t('DeepSeek（DSH）'):'Kimi'+(row.version?' '+row.version:''),tone:ENGINE_STATE[row.state][0],label:t(ENGINE_STATE[row.state][1]),sub:row.engine==='dsh'&&row.connections?tn('{n} 个 API 连接',row.connections):null}));
}
function Engines({engines}){
 const rows=engineRows(engines);
 if(!engines)return h('p',{className:'ext-cap',role:'status'},t('正在查看这台电脑上的工作引擎…'));
 if(!rows.length)return h('p',{className:'ext-cap'},t('这台电脑上还没找到工作引擎。装好并登录 Codex 或 Claude，或在「API 连接」里加一个 DeepSeek 连接。'));
 return h('div',{className:'ext-col','data-work-engines':true},...rows.map(row=>h('div',{key:row.engine,className:'ext-ieng'},h('span',{className:'ext-logo',style:{'--pl':'28px'},'aria-hidden':true},Icon(row.engine==='kimi'?'bolt':'terminal',{size:14})),h('span',{className:'ext-ir-main'},h('b',null,row.name),row.sub&&h('small',{className:'ext-cap'},row.sub)),h(StatusPill,{tone:row.tone},row.label))));
}
const NEXT={'@ai-buddy/bilibili-companion':['下一步连接 B站账号。连好后，观看和发评论在插件设置里分别打开。','启用并连接 B站账号','link'],'@ai-buddy/qq-connect':['下一步扫码登录 QQ，再选一位替你回复的角色。第一次扫码会下载 QQ 登录组件。','启用并扫码登录','qr'],'@ai-buddy/work-collaboration':[null,'启用并打开工作窗口','external']};
export function InstallPage({work,source,official:officialSource,plan,planError,requestedVersion,granted,onGrant,keepsEnabled,stage,runtime,job,record,busy,engines,catalogOnline=false,storageNotice,onBack,onInstall,onCancelPlan,onEnable,onOpen,onNext,onRetry,onImport,onAddCatalog}){
 // Review 低-4: the official texts only for the official source (by source and name), or on the A3 page that has no plan yet.
 const packageName=plan?.packageRef?.packageName??work?.packageName??'',official=officialSource??!!source?.official,profile=official||stage==='unavailable'?officialProfile(packageName):null,text=workText(work??{packageName},{official:!!profile});
 const declared=plan?.declaredCapabilities??[],added=new Set(plan?.addedCapabilities??[]),locked=!['plan','unavailable'].includes(stage),upgrade=plan?.priorDataSchemaVersion!=null;
 const shown=locked&&record?.grantedCapabilities?record.grantedCapabilities:granted;
 const n=shown.filter(id=>declared.includes(id)).length;
 const order=['plan','runtime','installing','installed'],at=Math.max(1,order.indexOf(stage)+1);
 const voice=isVoiceEnginePackage(packageName),steps=voice?[t('核对来源'),t('校验共享依赖'),t('安装'),t('启用')]:[t('勾选权限'),t('准备运行组件'),t('安装'),profile&&!storageNotice?profile.next:t('启用')];
 const stepper=h('ol',{className:'ext-isteps'},...steps.map((label,i)=>h('li',{key:i,className:i+1<at||stage==='installed'&&i<3?'done':i+1===at||stage==='installed'&&i===3?'cur':''},h('span',null,i+1<at||stage==='installed'&&i<3?Icon('check',{size:12}):i+1),h('b',null,label),i===1&&h('small',null,t('只在第一次')))));
 const installedVersion=record?.packageRef?.exactVersion??record?.exactVersion??record?.current??record?.version;
 const plannedVersion=plan?.packageRef?.exactVersion??plan?.packages?.find(row=>row.manifest?.id===packageName)?.manifest.version;
 const version=(stage==='installed'?installedVersion:null)??plannedVersion??requestedVersion??work?.installationVersion??installedVersion,size=formatBytes(plan?.packageBytes??plan?.downloadBytes);
 const head=h('div',{className:'ext-ihead'},
  h('button',{type:'button',className:'ui-btn ghost sm ext-back',onClick:onBack},Icon('chevron',{size:14}),t('扩展中心 · 发现')),
  h('div',{className:'ext-ih-main'},h(PluginLogo,{packageName,size:64}),h('div',{className:'ext-ih-text'},h('h2',{className:'ws-ptitle'},profile?.name??text.name??packageName),
   h('div',{className:'ext-meta'},official&&h('span',{className:'ws-tag'},t('官方')),h('span',{'data-install-meta':true},[work?.authorName??work?.authorLogin??work?.authorId,version,size].filter(Boolean).join(' · ')),source&&h('span',null,'· '+(official?t('来自已信任的来源'):t(source.name))),plan?.offline&&h('span',null,'· '+t('从文件导入'))),
   (profile?.description??text.description)&&h('p',{className:'ext-ih-d'},profile?.description??text.description))));
 const row=id=>{const cap=capabilityView(id),on=shown.includes(id);
  return h('li',{key:id,title:id,className:(cap.tag==='review'?'review':cap.tag==='model'?'model':'')+(locked&&!on?' off':'')},
   locked?h('span',{className:'ext-cap-ic'},Icon(cap.icon,{size:16})):h('input',{type:'checkbox',id:'cap-'+id,checked:on,disabled:busy,onChange:e=>onGrant(e.target.checked?[...granted,id]:granted.filter(value=>value!==id))}),
   h('label',{htmlFor:locked?undefined:'cap-'+id,className:'ext-cap-tx'},!locked&&h('span',{className:'ext-cap-ic'},Icon(cap.icon,{size:16})),h('span',null,cap.label)),
   upgrade&&added.has(id)&&h('span',{className:'ws-tag'},t('新增')),
   cap.tagLabel&&h(StatusPill,{tone:cap.tag==='review'?'warn':'info'},cap.tagLabel),
   locked&&h('span',{className:'ext-grant'},on?t('授予'):t('不授予')));};
 // An update lists what it adds; what was granted before stays ticked and folds away (B5 「安装页只列新增的权限」).
 const kept=upgrade&&!locked?declared.filter(id=>!added.has(id)):[],open=upgrade&&!locked?declared.filter(id=>added.has(id)):declared;
 const rows=h(React.Fragment,null,open.length>0&&h('ul',{className:'ext-caps'+(locked?' locked':'')},...open.map(row)),kept.length>0&&h('details',{className:'ext-fold ext-kept'},h('summary',null,h('span',null,tn('已授予 {n} 项，保持不变',kept.filter(id=>granted.includes(id)).length))),h('ul',{className:'ext-caps'},...kept.map(row))));
 const perms=h('section',{className:'ws-card ext-card ext-iperm'},h('div',{className:'ext-between'},h('h3',{className:'ws-sec'},t('权限')),plan&&h('span',{className:'ws-tag'},locked?t('授予 {n} 项 · 不授予 {m} 项').replace('{n}',n).replace('{m}',declared.length-n):t('已勾选 {n} / {m}').replace('{n}',n).replace('{m}',declared.length))),
  h('p',{className:'ext-cap'},stage==='unavailable'?t('有了签名插件包，这里会逐项列出它要的权限。'):locked?t('点了安装以后，这里锁住，只显示授予了哪些。'):upgrade&&open.length?t('这次更新新增了下面这些权限，只勾选你允许的。'):t(keepsEnabled?'升级将保留启用设置；请仅勾选本次允许的能力。':'安装不会自动启用；请仅勾选本次允许的能力。')),
  voice?h('p',{className:'ext-cap'},t('语音引擎只在陪伴页使用；麦克风和云端服务需要分别开启。')):!plan?null:declared.length?rows:h('p',{className:'ext-cap'},t('这个插件没有声明额外的能力。')));
 const tech=h('details',{className:'ext-tech'},h('summary',null,t('技术详情')),h('code',null,[packageName+' '+(version??''),plan?.packageRef?.sourceDigest&&(plan.packageRef.digestType??'sha256')+':'+plan.packageRef.sourceDigest,source&&(t(source.name)+' · '+(source.sourceId??'')),plan?.packageRef?.spec?.kind&&'spec: '+plan.packageRef.spec.kind,declared.length&&t('能力')+': '+declared.join(', ')].filter(Boolean).join('\n')));
 let state;
 if(stage==='unavailable')state=h('div',{className:'ext-col','data-install-unavailable':true},h('div',{className:'ui-alert warn',role:'status'},Icon('archive',{size:16}),h('div',null,h('b',null,catalogOnline?t('目录里还没有这个插件'):t('官方目录还没有上线')),h('p',null,t('可以从文件安装：选一个已签名的插件包，核对签名后会显示这个插件的安装计划。')))),
  h('button',{type:'button',className:'ui-btn primary',disabled:busy,onClick:onImport},Icon('file',{size:16}),t('从文件安装…')),h('button',{type:'button',className:'ui-btn ghost sm',disabled:busy,onClick:onAddCatalog},t('添加社区目录地址')));
 else if(stage==='plan'){const none=declared.length>0&&n===0;state=h('div',{className:'ext-col'},
  h('button',{type:'button',className:'ui-btn primary',disabled:busy||none||!plan&&!planError,onClick:!plan&&planError?onRetry:onInstall},busy?h('span',{className:'ui-spinner','aria-hidden':true}):Icon('download',{size:16}),!plan?t(planError?'重新查看安装计划':'正在读取安装计划…'):none?t('先勾选要授予的权限'):declared.length?t('安装，只授予勾选的 {n} 项').replace('{n}',n):t('安装')),
  h('p',{className:'ext-cap'},t('勾几项，按钮就写授予几项。安装后不会自动启用。')),plan&&h('button',{type:'button',className:'ui-btn ghost sm',disabled:busy,onClick:onCancelPlan},t('取消')));}
 else if(stage==='runtime')state=runtime;
 else if(stage==='installing'){const failed=['failed','needs-user','interrupted-needs-user'].includes(job?.state);state=failed?h('div',{className:'ext-col'},h('div',{className:'ui-alert warn',role:'status'},Icon('alert',{size:16}),h('div',null,h('b',null,job.state==='failed'?t('安装没有完成'):t('需要你再确认一次')),job.error&&h('p',null,job.error.text??job.error.message))),h('button',{type:'button',className:'ui-btn',disabled:busy,onClick:onRetry},Icon('refresh',{size:16}),t('重新查看安装计划'))):
  h('div',{className:'ext-col',role:'status','aria-live':'polite'},h('div',{className:'ext-row'},h('span',{className:'ui-spinner','aria-hidden':true}),h('b',null,job?.state==='queued'?t('已排队'):t('正在安装插件…'))),h('p',{className:'ext-cap'},job?.state==='queued'?t('工作繁忙时会排队，忙完后自动继续。'):t('装好后会显示在「已安装」里。')));}
 else{const next=storageNotice?null:NEXT[packageName],enabled=!!record?.enabled;state=h('div',{className:'ext-col','data-install-next':packageName},h('div',{className:'ui-alert ext-okalert',role:'status'},Icon('check',{size:16}),h('div',null,h('b',null,enabled?t('已安装，已启用'):t('已安装，还没启用')))),
  storageNotice&&h('p',{className:'ext-cap',role:'status'},storageNotice),
  profile&&next?.[0]&&h('p',{className:'ext-cap'},t(next[0])),
  profile?.nextAction==='work'&&h(React.Fragment,null,h('b',{className:'ext-sm'},t('选一个工作引擎')),h(Engines,{engines})),
  h('div',{className:'ws-row-btns'},enabled?h('button',{type:'button',className:'ui-btn primary',disabled:busy,onClick:onOpen},Icon('external',{size:16}),t(voice?'语音设置':'打开')):h('button',{type:'button',className:'ui-btn primary',disabled:busy,onClick:onEnable},profile&&next?h(React.Fragment,null,Icon(next[2],{size:16}),t(next[1])):t('启用')),
   !enabled&&h('button',{type:'button',className:'ui-btn ghost',onClick:onBack},t('稍后')),enabled&&!storageNotice&&profile?.nextAction==='accounts'&&h('button',{type:'button',className:'ui-btn ghost',onClick:onNext},profile.next)));}
 const side=h('aside',{className:'ws-card ext-card ext-iside'},h('h3',{className:'ws-sec'},t('安装')),stepper,h('hr',{className:'ext-hr'}),state,profile&&h(React.Fragment,null,h('hr',{className:'ext-hr'}),h('div',{className:'ext-ineed'},h('b',null,t('还需要')),...profile.need.map((row,i)=>h('div',{key:i,className:'ext-row top'},h('span',{className:'ext-cap-ic'},Icon(row.icon,{size:16})),h('span',null,h('b',null,row.text),h('small',null,row.sub)))))));
 return h('div',{className:'ext-ipage','data-community-install-page':packageName,'data-install-stage':stage},head,h('div',{className:'ext-ibody'},
  h('div',{className:'ext-col'},profile&&h('section',{className:'ws-card ext-card'},h('h3',{className:'ws-sec'},t('装好以后')),list(profile.does)),perms,profile&&h('section',{className:'ws-card ext-card'},h('h3',{className:'ws-sec'},t('以后还会单独问你')),list(profile.later)),tech),side));
}
