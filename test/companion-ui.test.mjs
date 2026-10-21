import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {CompanionManager,CompanionGroupStage,CompanionGroupDialogue,companionCardDraft,companionImage,groupCurrentMessage,GroupPhotoPlannerFields,groupPhotoPlannerBinding} from '../src/companion-ui.mjs';

const state=()=>({
 characters:[{id:'qwen',name:'Qwen',builtin:true,fields:{tone:{mode:'empty'},personality:{mode:'custom',value:'第一段\n\n第二段'}},effective:{tone:'',personality:'第一段\n\n第二段'}},{id:'custom-a',name:'新朋友',builtin:false,fields:{},effective:{}}],
 personas:[{id:'default',name:'日常',nickname:'我'},{id:'other',name:'工作',nickname:'同事'}],
 activeCharacterId:'qwen',activePersonaId:'default',activeConversationId:'one',conversations:[{id:'one',title:'完整原文',characterId:'qwen',personaId:'default',draft:'保留的草稿'}],
 messages:[{id:'user',role:'user',text:'用户原文\n第二行',characterId:'qwen',personaId:'default',createdAt:1},{id:'reply',role:'assistant',text:'角色台词',characterId:'qwen',personaId:'default',createdAt:2}],settings:{allowUserMessageEdit:true},relationship:{mode:'independent',level:3,affection:10},groups:[],activeGroupId:null,
});
const manager=(panel,value=state())=>renderToStaticMarkup(React.createElement(CompanionManager,{panel,state:value,request:async()=>({ok:true}),onClose(){}}));

test('character form preserves multiline custom values, explicit empty, and inherited fields separately',()=>{
 setLocale('zh-CN');const value=state().characters[0],draft=companionCardDraft(value);
 assert.equal(draft.fields.personality.value,'第一段\n\n第二段');
 assert.equal(draft.fields.personality.mode,'custom');assert.equal(draft.fields.tone.mode,'empty');assert.equal(draft.fields.greeting.mode,'inherit');
 const html=manager('characters');assert.match(html,/第一段\n\n第二段/);assert.match(html,/主动清空/);assert.match(html,/示例对话/);assert.match(html,/保存草稿/);assert.match(html,/保存并聊天/);assert.match(html,/模型关联/);
 assert.equal(value.fields.personality.value,'第一段\n\n第二段');
});

test('history exposes user corrections only when enabled, and keeps original revisions visible',()=>{
 const current=state();current.messages[0].originalText='原始内容';current.messages[0].revisions=[{at:4,text:'原始内容'}];
 let html=manager('history',current);assert.match(html,/用户原文\n第二行/);assert.match(html,/原文与更正记录/);assert.equal((html.match(/>更正<\/button>/g)||[]).length,1);
 current.settings.allowUserMessageEdit=false;html=manager('history',current);assert.equal((html.match(/>更正<\/button>/g)||[]).length,0);assert.match(html,/归档/);assert.match(html,/恢复会话/);
});

test('group view renders only committed message and all selected members, including a text-only role',()=>{
 const current=state();current.groups=[{id:'group',name:'夜聊',memberIds:['qwen','custom-a'],personaId:'default',mode:'natural',mutedIds:[],talkativeness:{}}];current.activeGroupId='group';current.groupRuntime={status:'awaiting-continue',queue:[{text:'不得显示的未发表草稿'}],currentMessage:{id:'published',role:'assistant',characterId:'qwen',text:'已呈现台词'},canContinue:true};
 assert.equal(groupCurrentMessage(current).text,'已呈现台词');
 const stage=renderToStaticMarkup(React.createElement(CompanionGroupStage,{state:current,resolveArt:key=>'assets/'+key+'.png'}));assert.match(stage,/Qwen/);assert.match(stage,/新朋友/);assert.doesNotMatch(stage,/🐋/);
 const html=renderToStaticMarkup(React.createElement(CompanionGroupDialogue,{state:current,request:async()=>({ok:true}),onManage(){}}));assert.match(html,/已呈现台词/);assert.match(html,/继续 ▸/);assert.match(html,/停止本轮/);assert.doesNotMatch(html,/不得显示的未发表草稿/);assert.match(html,/textarea[^>]+disabled/);
 current.characters[0].resourceInstalled=false;current.characters[1].resourceInstalled=true;
 const members=manager('groups',current);assert.match(members,/Qwen · 待安装/);assert.match(members,/补装角色/);assert.doesNotMatch(members,/新朋友 · 待安装/);
 current.groupRuntime.currentMessage={id:'user-old',role:'user',personaName:'发送时昵称',text:'我说的'};current.personas[0].nickname='后来改的昵称';
 const oldSender=renderToStaticMarkup(React.createElement(CompanionGroupDialogue,{state:current,request:async()=>({ok:true}),onManage(){}}));assert.match(oldSender,/发送时昵称/);assert.doesNotMatch(oldSender,/后来改的昵称/);
});

test('English management panels translate new controls without replacing character names',()=>{
 try{setLocale('en');for(const panel of ['characters','personas','history','groups']){const html=manager(panel);assert.match(html,/Characters and conversations/);assert.match(html,/Manage characters/);assert.match(html,/My personas/);assert.match(html,/Group chat/);}const html=manager('characters');assert.match(html,/Qwen/);assert.match(html,/Save draft/);assert.match(html,/Explicitly empty/);}finally{setLocale('zh-CN');}
});

test('image references reject remote executable and traversing paths while accepting registered assets',()=>{
 assert.equal(companionImage('javascript:alert(1)'),null);assert.equal(companionImage('https://untrusted.invalid/person.png'),null);assert.equal(companionImage('assets/../secret.png'),null);assert.equal(companionImage('assets/characters/qwen/portrait.png'),'assets/characters/qwen/portrait.png');assert.equal(companionImage('known',key=>key==='known'?'assets/known.webp':null),'assets/known.webp');
});

const photoPlanner=()=>({binding:{enabled:false,connectionId:null},enabled:true,effective:{connectionId:'grok',name:'Grok',model:'grok-4.6',reasoningEffort:'low',error:null},options:[{id:'grok',name:'Grok',model:'grok-4.6',reasoningEffort:'low',available:true},{id:'codex',name:'本机 Codex',model:'gpt-6.1-sol',reasoningEffort:'high',available:true},{id:'broken',name:'Broken',model:'old-model',available:false,error:'连接已停用'}]});
const plannerFields=(planner,value='')=>renderToStaticMarkup(React.createElement(GroupPhotoPlannerFields,{planner,value,onChange(){}}));
test('group photo planner defaults to automatic, identifies the actual chat model, and separates image generation',()=>{
 setLocale('zh-CN');const before=photoPlanner(),html=plannerFields(before);
 assert.match(html,/data-group-photo-planner-select/);assert.match(html,/<option value="" selected="">自动（沿用入口角色／全局规则）/);
 assert.match(html,/本次策划模型：Grok · grok-4.6 · 推理强度（effort）: low/);
 assert.match(html,/本机 Codex · gpt-6.1-sol · 推理强度（effort）: high/);assert.match(html,/实际出图仍使用 CG 绘图连接/);
 assert.match(html,/已有任务和重试保留原任务的模型与提示词/);assert.equal(before.binding.enabled,false);
 assert.deepEqual(groupPhotoPlannerBinding(''),{enabled:false,connectionId:null});assert.deepEqual(groupPhotoPlannerBinding('codex'),{enabled:true,connectionId:'codex'});
});
test('planner draft shows its selected model, keeps missing selections visible and never reports an old custom model as automatic',()=>{
 setLocale('zh-CN');let html=plannerFields(photoPlanner(),'codex');assert.match(html,/<option value="codex" selected="">/);assert.match(html,/本次策划模型：本机 Codex · gpt-6.1-sol · 推理强度（effort）: high/);
 html=plannerFields(photoPlanner(),'deleted');assert.match(html,/已失效的连接 · deleted/);assert.match(html,/所选提示词连接已不存在/);assert.match(html,/aria-invalid="true"/);
 html=plannerFields(photoPlanner(),'broken');assert.match(html,/连接已停用/);assert.match(html,/aria-invalid="true"/);
 const planner=photoPlanner();planner.binding={enabled:true,connectionId:'codex'};planner.effective=planner.options[1];html=plannerFields(planner,'');assert.match(html,/保存或生成时按入口角色／全局规则解析/);assert.doesNotMatch(html,/data-group-photo-effective-planner/);
});
test('planner offline and English states explain local fallback while leaving character/model names intact',()=>{
 const planner=photoPlanner();planner.enabled=false;setLocale('zh-CN');assert.match(plannerFields(planner),/联网聊天未开启：本次使用本地提示词/);
 const explicitOffline=plannerFields(planner,'codex');assert.match(explicitOffline,/联网聊天未开启：请先开启后再使用指定的策划模型/);assert.doesNotMatch(explicitOffline,/本次使用本地提示词/);
 try{setLocale('en');const html=plannerFields(planner);assert.match(html,/Prompt planning model/);assert.match(html,/Automatic \(entry character \/ global connection\)/);assert.match(html,/Online chat is off/);assert.match(plannerFields(planner,'codex'),/enable it before using the selected planning model/);assert.match(html,/Grok · grok-4.6/);assert.doesNotMatch(html,/提示词策划模型/);}finally{setLocale('zh-CN');}
});
