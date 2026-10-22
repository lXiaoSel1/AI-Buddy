import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CompanionManager,LifeRecoveryBanner,modelErrorText,modelOutputTruncated,groupStatusText,GROUP_BUSY_STATUSES} from '../src/companion-ui.mjs';
import {MissingCgDialog,MemorySyncNotice} from '../src/companion-life-ui.mjs';
import {companionImage,isStoredImage,isMediaImage} from '../src/companion-image.mjs';
import {OutputLimitSetting,parseOutputLimit,OUTPUT_LIMIT,AboutCard} from '../src/general-settings.mjs';
import {SafeModePage} from '../src/safe-mode-page.mjs';
import {setLocale} from '../src/i18n.mjs';

const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));
const MEDIA='buddy-media://'+'a'.repeat(64)+'.png';
const DATA='data:image/png;base64,iVBORw0KGgo=';
const character=(id,extra={})=>({id,name:id,builtin:false,life:{id:'life-'+id,mode:'normal'},growth:{mode:'normal',history:[]},fields:{},effective:{name:id},...extra});

test('B4: stored pictures are recognised in both data and buddy-media form',()=>{
 for(const value of [MEDIA,MEDIA+'/',DATA])assert.equal(companionImage(value),value);
 assert.equal(isMediaImage(MEDIA),true);assert.equal(isStoredImage(DATA),true);
 for(const bad of ['buddy-media://../x.png','buddy-media://'+'A'.repeat(64)+'.png','buddy-media://'+'a'.repeat(64)+'.exe','file:///C:/x.png','data:text/html;base64,AAAA','javascript:alert(1)'])assert.equal(companionImage(bad),null,bad);
 assert.equal(companionImage('assets/group-thumbnails/claude.png'),'assets/group-thumbnails/claude.png');
 assert.equal(companionImage('bg-key',key=>key==='bg-key'?'resolved.webp':null),'resolved.webp');
});

test('B4: the card editor previews a buddy-media avatar and keeps the value for saving',()=>{
 const state={activeCharacterId:'custom-1',characters:[character('custom-1',{avatar:MEDIA})],personas:[],groups:[]};
 const html=render(CompanionManager,{panel:'characters',state,request:async()=>({ok:true}),onClose(){}});
 assert.match(html,new RegExp('<img src="'+MEDIA.replace(/[.*+?^${}()|[\]\\/]/g,'\\$&')+'"'));
 assert.doesNotMatch(html,/图片引用已保存/,'a stored picture is shown, not just named');
});

test('B6: the recovery banner names the locked character, gives the reason and three choices',()=>{
 const state={characters:[character('claude',{name:'Claude'}),character('gpt')],lifeRecovery:{characterId:'claude',kind:'restore',at:Date.now(),error:'磁盘已满',attempts:2,archiveAvailable:false}};
 const html=render(LifeRecoveryBanner,{state,request:async()=>({ok:true})});
 assert.match(html,/人生切换没有完成/);assert.match(html,/磁盘已满/);assert.match(html,/已尝试 2 次/);
 assert.match(html,/data-life-recovery="retry"/);assert.match(html,/data-life-recovery="abandon"/);
 assert.match(html,/<button[^>]*disabled=""[^>]*data-life-recovery="rollback"|<button[^>]*data-life-recovery="rollback"[^>]*disabled=""/,'rollback is disabled without a pre-switch archive');
 assert.equal(render(LifeRecoveryBanner,{state,request:async()=>({}),characterId:'gpt'}),'','other characters are not affected');
 assert.equal(render(LifeRecoveryBanner,{state:{...state,lifeRecovery:null},request:async()=>({})}),'');
 const ready=render(LifeRecoveryBanner,{state:{...state,lifeRecovery:{...state.lifeRecovery,archiveAvailable:true}},request:async()=>({})});
 assert.doesNotMatch(ready,/disabled=""[^>]*data-life-recovery="rollback"|data-life-recovery="rollback"[^>]*disabled=""/);
});

test('B6: the manager shows the recovery banner above every tab',()=>{
 const state={activeCharacterId:'gpt',characters:[character('claude',{name:'Claude'}),character('gpt')],personas:[],groups:[],lifeRecovery:{characterId:'claude',kind:'reset',at:1,error:'x',attempts:1,archiveAvailable:true}};
 for(const panel of ['characters','memory','lives'])assert.match(render(CompanionManager,{panel,state,request:async()=>({ok:true}),onClose(){}}),/data-life-recovery-banner="claude"/);
});

test('B6: the safe-mode page explains what stopped and why',()=>{
 const html=render(SafeModePage,{settings:{safeMode:true,startupFailure:{scope:'companion',message:'companion.json 无法解析',at:'2026-10-21T10:00:00Z'}},onPage(){}});
 assert.match(html,/陪伴功能已停用/);assert.match(html,/companion\.json 无法解析/);assert.match(html,/桌宠和用量监控照常可用/);
});

test('D2-3: missing CG records list name, time and conversation with a clean button',()=>{
 const failure={characterId:'claude',missing:[{cgId:'cg-1',label:'深夜的书房',at:Date.parse('2026-10-20T12:00:00Z'),level:3,kind:'private',groupId:null,ref:'a'},{cgId:'cg-2',label:null,at:null,level:null,kind:'group',groupId:'g1',ref:'b'}]};
 const html=render(MissingCgDialog,{state:{groups:[{id:'g1',name:'今晚的工作复盘'}]},request:async()=>({ok:true}),failure,onClose(){}});
 assert.match(html,/深夜的书房/);assert.match(html,/Lv\.3/);assert.match(html,/未命名 CG/);assert.match(html,/时间未记录/);
 assert.match(html,/今晚的工作复盘/);assert.match(html,/私聊/);assert.match(html,/data-missing-cg-clean="true"/);
});

test('B2: the output limit accepts auto or 256–65536 and explains truncation',()=>{
 assert.equal(parseOutputLimit('8192'),8192);assert.equal(parseOutputLimit(' 256 '),256);assert.equal(parseOutputLimit('65536'),65536);
 for(const bad of ['255','65537','1.5','-1','','auto','8e3'])assert.equal(parseOutputLimit(bad),null,bad);
 assert.equal(OUTPUT_LIMIT.fallback,8192);
 const custom=render(OutputLimitSetting,{value:8192,onSave(){}});
 assert.match(custom,/模型最多输出（tokens）/);assert.match(custom,/data-setting="maxOutputTokens"[^>]*value="8192"|value="8192"[^>]*data-setting="maxOutputTokens"/);
 const auto=render(OutputLimitSetting,{value:'auto',onSave(){}});
 assert.doesNotMatch(auto,/data-setting="maxOutputTokens"/,'no number box while automatic');
 const error=Object.assign(Error('回复被截断：模型输出达到上限'),{code:'MODEL_OUTPUT_TRUNCATED'});
 assert.equal(modelOutputTruncated(error),true);assert.equal(modelErrorText(error),'回复被截断，可以调高通用设置里的输出上限后重试');
 assert.equal(modelErrorText('网络错误'),'网络错误');
});

test('B3/B5: queued and life-save waits count as busy and say what is happening',()=>{
 for(const status of ['waiting-model','waiting-life-save'])assert.ok(GROUP_BUSY_STATUSES.includes(status));
 assert.match(groupStatusText({status:'waiting-model'},'Claude'),/排队中 · Claude/);
 assert.equal(groupStatusText({status:'waiting-life-save',waitDeadline:61000},'',1000),'正在保存人生存档，稍后自动发送 · 最多 60 秒');
 assert.equal(groupStatusText({status:'waiting-life-save'},''),'正在保存人生存档，稍后自动发送');
});

test('B7: a memory sync error shows a one-line notice',()=>{
 assert.match(render(MemorySyncNotice,{error:{at:1,message:'记录未标日期'}}),/日终整理已暂停[\s\S]*记录未标日期/);
 assert.equal(render(MemorySyncNotice,{error:null}),'');
});

test('About shows copyright, license, source as plain text, notices and the warranty line',()=>{
 const html=render(AboutCard,{});
 assert.ok(html.includes('© 2026 lXiaoSel1'));assert.ok(html.includes('Apache-2.0 + Commons Clause —— 可以免费使用、修改和转发，未经授权不得售卖'));
 assert.ok(html.includes('github.com/lXiaoSel1/AI-Buddy'));assert.doesNotMatch(html,/<a[\s>]/,'no link: the panel blocks external navigation');
 assert.ok(html.includes('LICENSE.md 和 THIRD_PARTY_NOTICES.md'));assert.ok(html.includes('按“原样”提供，不提供任何担保'));
 setLocale('en');
 try{const en=render(AboutCard,{});assert.match(en,/>About</);assert.match(en,/not for sale without permission/);assert.match(en,/without warranty of any kind/);assert.match(en,/© 2026 lXiaoSel1/);}
 finally{setLocale('zh-CN');}
});

test('new strings have English text',()=>{
 setLocale('en');
 try{assert.match(render(SafeModePage,{settings:{startupFailure:null},onPage(){}}),/Companion features are off/);}
 finally{setLocale('zh-CN');}
});
