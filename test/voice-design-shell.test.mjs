import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {VoicePackageRow,VoiceGeneralSettingsPanel,CommunityMaintenanceConfirmation,voiceSidebarPresentation} from '../src/voice/shell-design.mjs';
import {VoiceEngineCard} from '../src/voice/design-ui.mjs';
import {VoicePluginHeader} from '../src/voice/plugin-page.mjs';
import {ensureVoiceSession} from '../src/voice/client.mjs';
import {createVoicePackageAuthority} from '../src/voice/package-authority.mjs';

setLocale('zh-CN');
const breeze='ai-buddy.voice-breeze',gpt='ai-buddy.voice-gpt-sovits';
const row={manifest:{id:gpt,version:'1.0.0'},sourceId:'official',enabled:true,current:'1.0.0',activation:{supported:true}};
const record={id:gpt,installed:true,enabled:true,usable:true,sourceId:'official'};
const snapshot={state:{settings:{enabled:true,packages:{[breeze]:{ttsProvider:'local'}}},selectedPackageId:breeze,preparation:{state:'ready'},packages:[record,{id:breeze,installed:true,enabled:true,usable:true}]}};
function elements(node){if(!node||typeof node!=='object')return [];return [node,...React.Children.toArray(node.props?.children).flatMap(elements),...React.Children.toArray(node.props?.footer).flatMap(elements)];}
test('an unstarted installed voice engine starts through its existing shared session',async()=>{
 const calls=[];let state=structuredClone(snapshot.state);
 const api={onEvent:()=>()=>{},action:async(op,payload)=>{calls.push({op,payload});if(op==='state')return state;if(op==='configure'){state={...state,selectedPackageId:payload.selectedPackageId,settings:{...state.settings,enabled:payload.enabled}};}if(op==='prepare')state={...state,preparation:{state:'ready'}};return {accepted:true};}};
 const session=ensureVoiceSession(api,{createContext:({sampleRate})=>({sampleRate,state:'running',resume:async()=>{},close:async()=>{}}),captureOptions:{workletURL:'fixture'}}),release=session.retain();
 await session.refresh();
 const component=VoicePackageRow({row,record,snapshot:session.snapshot(),session,run:fn=>fn(),call:async()=>{},onOpen:()=>{throw Error('Start should prepare voice');}});
 const start=elements(component).find(value=>value.props?.['data-voice-start']);
 assert.ok(start,'an installed unstarted engine needs Start');
 try{await start.props.onClick();
 assert.deepEqual(calls.filter(row=>!['state','component-status','profile-selections'].includes(row.op)),[{op:'configure',payload:{enabled:true,selectedPackageId:gpt}}]);
 assert.equal(session.snapshot().state.selectedPackageId,gpt);
 const html=renderToStaticMarkup(component);
 assert.match(html,/未启动/);
 assert.match(html,/vx-logo-gpt/);
 }finally{await release();}
});
test('Open only locates the current engine page and never prepares or changes settings',()=>{
 const calls=[],opened=[];
 const current={...snapshot,state:{...snapshot.state,selectedPackageId:gpt}};
 const component=VoicePackageRow({row,record,snapshot:current,session:{configure:()=>calls.push('configure')},onOpen:id=>opened.push(id)});
 elements(component).find(value=>value.props?.['data-voice-open']).props.onClick();
 assert.deepEqual(opened,[gpt]);assert.deepEqual(calls,[]);
});
test('voice row enable and maintenance keep the legacy action contract and confirmation',async()=>{
 const calls=[],confirmations=[];
 const component=VoicePackageRow({row:{...row,previous:'0.9.0'},record,snapshot,session:{},menuOpen:true,call:async request=>calls.push(request),onConfirm:value=>confirmations.push(value)});
 const toggle=elements(component).find(value=>value.props?.['data-voice-enable']);await toggle.props.onChange(false);
 assert.deepEqual(calls,[{action:'disable',id:gpt,sourceId:'official'}]);
 const menu=elements(component).find(value=>value.props?.items);
 assert.equal(menu.props.items.some(item=>item.label==='在浏览器打开'),false);
 await menu.props.items[1].onSelect();
 assert.deepEqual(calls.at(-1),{action:'community-set-update-policy',packageKey:'buddy-v1:official:'+gpt,policy:'auto'});
 menu.props.items.at(-1).onSelect();assert.equal(calls.length,2,'requesting uninstall must first ask for confirmation');
 assert.equal(confirmations[0].record.backend,'legacy');
 const dialog=CommunityMaintenanceConfirmation({confirm:confirmations[0],call:async request=>calls.push(request)});
 await elements(dialog).find(value=>value.props?.['data-community-maintenance-confirm']).props.onClick();
 assert.deepEqual(calls.at(-1),{action:'uninstall',id:gpt,sourceId:'official'});
 menu.props.items.find(item=>item?.icon==='retry').onSelect();
 const rollback=CommunityMaintenanceConfirmation({confirm:confirmations[1],call:async request=>calls.push(request)});
 await elements(rollback).find(value=>value.props?.['data-community-maintenance-confirm']).props.onClick();
 assert.deepEqual(calls.at(-1),{action:'rollback',id:gpt,sourceId:'official'});
});
test('disabled and unapproved voice packages preserve the existing enable restriction',()=>{
 const component=VoicePackageRow({row:{...row,enabled:false,activation:undefined},record:{...record,enabled:false,usable:false},snapshot,session:{}});
 assert.equal(elements(component).find(value=>value.props?.['data-voice-enable']).props.disabled,true);
 assert.equal(elements(component).find(value=>value.props?.['data-voice-start']).props.disabled,true);
});
test('single voice header changes the browsed tab without starting either engine',()=>{
 const selected=[],header=VoicePluginHeader({snapshot,selectedPackageId:breeze,onSelectPackage:id=>selected.push(id)});
 const tabs=elements(header).filter(value=>value.props?.role==='tab');
 assert.equal(tabs.length,2);assert.equal(tabs[0].props['aria-selected'],true);
 tabs[1].props.onClick();assert.deepEqual(selected,[gpt]);
 const html=renderToStaticMarkup(header);assert.match(html,/role="tablist"/);assert.match(html,/Breeze 语音/);assert.match(html,/GPT-SoVITS 语音/);
});
test('general settings only contain the master switch and current voice navigation',async()=>{
 const configured=[],opened=[];
 const panel=VoiceGeneralSettingsPanel({snapshot,session:{configure:async patch=>configured.push(patch)},onOpen:id=>opened.push(id)});
 const html=renderToStaticMarkup(panel);assert.match(html,/聊天配音/);assert.doesNotMatch(html,/<textarea|<select|录音输入|准备所选/);
 await elements(panel).find(value=>value.props?.['data-voice-master']).props.onChange(false);
 elements(panel).find(value=>value.props?.['data-voice-settings-open']).props.onClick();
 assert.deepEqual(configured,[{enabled:false}]);assert.deepEqual(opened,[breeze]);
});
test('general settings direct users without a voice engine to Extensions',()=>{
 let opened=0;
 const panel=VoiceGeneralSettingsPanel({snapshot:{state:{packages:[]}},onPlugins:()=>opened++});
 elements(panel).find(value=>value.props?.['data-voice-settings-open']).props.onClick();
 assert.equal(opened,1);assert.match(renderToStaticMarkup(panel),/去扩展中心安装语音插件/);
});

test('the five voice settings surfaces agree on preparation and engine state',()=>{
 const render=node=>renderToStaticMarkup(node);
 const fixtures=[
  ['ready',{ready:true,state:'ready'},'已就绪'],
  ['ready',{ready:false,state:'missing'},'需要准备'],
  ['idle',{ready:true,state:'ready'},'未启动'],
  ['loading',{ready:true,state:'ready'},'启动中'],
  ['failed',{ready:true,state:'ready'},'没能启动'],
 ];
 for(const [phase,components,label] of fixtures){
  const current={...snapshot,state:{...snapshot.state,selectedPackageId:gpt,preparation:{state:phase}},componentStatuses:{[gpt]:components}};
  const surfaces={
   header:render(React.createElement(VoicePluginHeader,{snapshot:current,selectedPackageId:gpt})),
   extensions:render(React.createElement(VoicePackageRow,{row,record,snapshot:current,session:{}})),
   settings:render(React.createElement(VoiceGeneralSettingsPanel,{snapshot:current,session:{}})),
   engine:render(React.createElement(VoiceEngineCard,{snapshot:current,id:gpt})),
   sidebar:render(React.createElement('span',null,voiceSidebarPresentation(current).label)),
  };
  for(const [surface,html] of Object.entries(surfaces)){
   assert.match(html,new RegExp('>'+label+'(?: · 聊天在用)?<| · '+label+'<'),surface+' for '+label);
  }
 }
});
test('installed voice rows open component verification instead of claiming ready or starting it',()=>{
 const calls=[],current={...snapshot,state:{...snapshot.state,selectedPackageId:gpt,assets:{asr:{state:'verification-needed'},tts:{state:'ready'}}}};
 const node=VoicePackageRow({row,record,snapshot:current,session:{configure:()=>calls.push('start')},onOpen:id=>calls.push(id)}),html=renderToStaticMarkup(node);
 assert.match(html,/需要校验/);assert.doesNotMatch(html,/已就绪/);elements(node).find(value=>value.props?.['data-voice-open']).props.onClick();assert.deepEqual(calls,[gpt]);
 const other=VoicePackageRow({row,record,snapshot:{...snapshot,componentStatuses:{[gpt]:{ready:false,state:'verification-needed'}}},session:{}});
 assert.match(renderToStaticMarkup(other),/需要校验/);
});

test('installed voice status follows the runtime snapshot when the Extensions record is stale',()=>{
 const current={...snapshot,state:{...snapshot.state,selectedPackageId:gpt}};
 const stale={...record,enabled:false,usable:false};
 const html=renderToStaticMarkup(React.createElement(VoicePackageRow,{row,record:stale,snapshot:current,session:{}}));
 assert.match(html,/data-voice-runtime-status="ready"/);
 const disabled={...current,state:{...current.state,packages:current.state.packages.map(value=>value.id===gpt?{...record,enabled:false}:value)}};
 assert.match(renderToStaticMarkup(React.createElement(VoicePackageRow,{row,record,snapshot:disabled,session:{}})),/data-voice-runtime-status="disabled"/);
});

const incompatibleManifest={...row.manifest,appRange:'>=9.0.0',apiRange:'*'};
const incompatiblePackages=createVoicePackageAuthority({manager:{snapshot:()=>({
 service:{usable:true},
 appVersion:'2.0.18',
 apiVersion:'1.0.0',
 installed:{[gpt]:{current:'1.0.0',enabled:true,versions:{'1.0.0':{manifest:incompatibleManifest}}}},
})}}).status();
const incompatibleSnapshot={...snapshot,state:{...snapshot.state,selectedPackageId:gpt,packages:incompatiblePackages}};
const incompatibleRecord=incompatiblePackages.find(value=>value.id===gpt);
const h=React.createElement;
const incompatibleSurfaces={
 'plugin header':()=>h(VoicePluginHeader,{snapshot:incompatibleSnapshot,selectedPackageId:gpt}),
 'Extensions':()=>h(VoicePackageRow,{row,record:incompatibleRecord,snapshot:incompatibleSnapshot,session:{}}),
 'general settings':()=>h(VoiceGeneralSettingsPanel,{snapshot:incompatibleSnapshot,session:{}}),
 'engine card':()=>h(VoiceEngineCard,{snapshot:incompatibleSnapshot,id:gpt}),
 'sidebar':()=>h('span',null,voiceSidebarPresentation(incompatibleSnapshot).label),
};
for(const [surface,render] of Object.entries(incompatibleSurfaces)){
 test('R4-4: '+surface+' shows incompatibility from package authority',()=>{
  assert.equal(incompatibleRecord.state,'incompatible');
  assert.equal(incompatibleRecord.enabled,true);
  for(const field of ['compatible','compatibility','activation'])assert.equal(Object.hasOwn(incompatibleRecord,field),false);
  const html=renderToStaticMarkup(render());
  assert.ok(/(?:>| · )不兼容</.test(html),html.includes('已停用')?'Rendered 已停用 instead of 不兼容':'Missing 不兼容');
  if(surface==='engine card'){
   assert.match(html,/在扩展中心查看/);
   assert.doesNotMatch(html,/打开语音时会自动启动/);
  }
 });
}

test('R4-4: Extensions preserves compatibility information from its installed record',()=>{
 const installedRecord={...record,usable:false,compatibility:{compatible:false,requiredAppRange:'>=9.0.0',currentAppVersion:'2.0.18'}};
 const current={...snapshot,state:{...snapshot.state,selectedPackageId:gpt}};
 const html=renderToStaticMarkup(h(VoicePackageRow,{row,record:installedRecord,snapshot:current,session:{}}));
 assert.match(html,/data-voice-runtime-status="incompatible"[^>]*>.*>不兼容</);
 assert.match(html,/这个版本需要 AI 酱 &gt;=9.0.0，现在是 2.0.18。/);
 assert.match(html,/<button[^>]*disabled[^>]*data-voice-start/);
});
