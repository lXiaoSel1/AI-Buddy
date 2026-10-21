import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {CompanionManager,CompanionGroupStage,CompanionGroupDialogue,companionCardDraft,companionImage,groupCurrentMessage} from '../src/companion-ui.mjs';

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
