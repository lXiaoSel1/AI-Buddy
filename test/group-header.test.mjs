import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GroupHeader,groupHeaderContext} from '../src/group-header.mjs';
import {setLocale} from '../src/i18n.mjs';
const state=()=>({activeCharacterId:'claude',activeGroupId:'dinner',characters:[{id:'claude',name:'Claude',effectiveConnection:{mode:'character',name:'Grok connection',model:'grok-test'}},{id:'deepseek',name:'DeepSeek',effectiveConnection:{mode:'character',name:'DeepSeek connection',model:'deepseek-test'}},{id:'chatgpt',name:'GPT',effectiveConnection:{mode:'global',name:'Global',model:'future-gpt'}},{id:'kimi',name:'Kimi',effectiveConnection:{model:'not-in-group'}}],personas:[{id:'a',name:'Dinner persona'},{id:'b',name:'Private persona'}],activePersonaId:'b',groups:[{id:'dinner',name:'今晚吃什么',personaId:'a',memberIds:['claude','deepseek','chatgpt']}],groupMessages:[],groupRuntime:{status:'idle',currentMessage:{id:'reply',role:'assistant',characterId:'chatgpt',request:{connectionId:'previous-api',model:'actual-gpt'}}}});
test('group header uses group title, bound persona, only present members and recorded reply model',()=>{
 setLocale('zh-CN');const s=state(),c=groupHeaderContext(s);assert.equal(c.group.name,'今晚吃什么');assert.equal(c.persona.name,'Dinner persona');assert.deepEqual(c.members.map(x=>x.id),['claude','deepseek','chatgpt']);assert.equal(c.speaker.id,'chatgpt');assert.equal(c.model,'actual-gpt');
 const html=renderToStaticMarkup(React.createElement(GroupHeader,{state:s,request(){},onBrowse(){},petEnabled:true,onPetToggle(){}}));assert.match(html,/今晚吃什么/);assert.match(html,/role="toolbar"/);assert.match(html,/data-group-connections/);assert.match(html,/buddy-group-stage-controls/);assert.match(html,/buddy-cg-chip/);assert.doesNotMatch(html,/角色来源|与Claude的galgame|Private persona|not-in-group|重置|角色立绘/);
});
test('in-flight member route is used instead of previous speaker; user message never becomes an AI identity',()=>{
 const s=state();s.groupRuntime.status='generating';s.groupRuntime.queue=['deepseek'];let c=groupHeaderContext(s);assert.equal(c.speaker.id,'deepseek');assert.equal(c.model,'deepseek-test');assert.equal(c.recorded,undefined);
 s.groupRuntime.pendingMessage={characterId:'deepseek',request:{model:'captured-deepseek'}};assert.equal(groupHeaderContext(s).model,'captured-deepseek');
 s.groupRuntime={status:'idle',currentMessage:{role:'user',characterId:'claude',text:'Hello'}};assert.equal(groupHeaderContext(s).speaker,undefined);assert.equal(groupHeaderContext({...s,activeGroupId:null}),null);
});
test('group header follows membership changes without changing global or private context',()=>{
 const s=state(),before=structuredClone(s);s.groups[0].memberIds=['claude','deepseek'];const c=groupHeaderContext(s);assert.equal(c.speaker,undefined);assert.equal(c.members.length,2);assert.equal(s.activeCharacterId,before.activeCharacterId);assert.deepEqual(s.characters,before.characters);
});
