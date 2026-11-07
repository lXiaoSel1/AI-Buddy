import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {setLocale} from '../src/i18n.mjs';
import {CompanionGroupDialogue,groupCurrentMessage} from '../src/companion-ui.mjs';

setLocale('zh-CN');
const previous={id:'previous-message',role:'assistant',characterId:'deepseek',characterName:'DeepSeek',text:'Previous dialogue',status:'presented'};
const received={requestId:'same-request',characterId:'claude',characterName:'Claude',text:'Current dialogue'};
const committed={...received,id:'same-request',role:'assistant',autoRequestId:'auto-turn',status:'presented'};
const state=runtime=>({
 characters:[{id:'claude',name:'Claude'},{id:'deepseek',name:'DeepSeek'}],
 personas:[{id:'default',nickname:'我'}],activeGroupId:'group',
 groups:[{id:'group',name:'Group',personaId:'default',memberIds:['claude','deepseek'],mutedIds:[]}],
 settings:{},groupMessages:[previous],groupRuntime:{mode:'auto',queue:['claude'],currentMessage:previous,...runtime},
});
// Exercise the selected display identity and the actual dialogue body, without a host/model connection.
const view=runtime=>{
 const current=state(runtime),message=groupCurrentMessage(current);
 const html=renderToStaticMarkup(React.createElement(CompanionGroupDialogue,{state:current,request:async()=>({ok:true}),onManage(){},chat:{enabled:true}}));
 const line=html.match(/<div class="whg-line-now(?: narrator)?"[^>]*>([\s\S]*?)<\/div>/);
 assert.ok(line,'the group dialogue has a visible line');
 return {id:message?.id??null,text:message?.text??null,body:line[1],html};
};

test('one received reply keeps its display identity and body through generation, presentation wait, and commit',()=>{
 const phases=[
  {status:'generating',streaming:received},
  {status:'awaiting-presentation',streaming:received,pendingMessage:{...committed,status:'pending-presentation'}},
  {status:'idle',streaming:null,currentMessage:committed,queue:[]},
 ].map(view);
 assert.deepEqual(phases.map(({id,text,body})=>({id,text,body})),[
  {id:'same-request',text:'Current dialogue',body:'Current dialogue'},
  {id:'same-request',text:'Current dialogue',body:'Current dialogue'},
  {id:'same-request',text:'Current dialogue',body:'Current dialogue'},
 ]);
 for(const phase of phases.slice(0,2))assert.doesNotMatch(phase.html,/data-group-message-id|data-auto-request-id/);
 assert.match(phases[2].html,/data-group-message-id="same-request"/);
 assert.match(phases[2].html,/data-auto-request-id="auto-turn"/);
});

test('paragraph appends update the received body without changing the reply identity',()=>{
 const phases=['First paragraph','First paragraph\n\nSecond paragraph','First paragraph\n\nSecond paragraph\n\nThird paragraph']
  .map(text=>view({status:'generating',streaming:{...received,text}}));
 assert.deepEqual(phases.map(({id,text,body})=>({id,text,body})),[
  {id:'same-request',text:'First paragraph',body:'First paragraph'},
  {id:'same-request',text:'First paragraph\n\nSecond paragraph',body:'First paragraph\n\nSecond paragraph'},
  {id:'same-request',text:'First paragraph\n\nSecond paragraph\n\nThird paragraph',body:'First paragraph\n\nSecond paragraph\n\nThird paragraph'},
 ]);
});

test('a pending draft without received streaming text stays hidden until presentation',()=>{
 const pendingMessage={...committed,text:'Unreceived pending draft',status:'pending-presentation'};
 const withPrevious=view({status:'awaiting-presentation',streaming:null,pendingMessage});
 assert.deepEqual({id:withPrevious.id,text:withPrevious.text,body:withPrevious.body},
  {id:'previous-message',text:'Previous dialogue',body:'Previous dialogue'});
 assert.doesNotMatch(withPrevious.html,/Unreceived pending draft|data-auto-request-id="auto-turn"/);
 const withoutPrevious=view({status:'awaiting-presentation',streaming:{...received,text:''},pendingMessage,currentMessage:null});
 assert.equal(withoutPrevious.id,null);
 assert.equal(withoutPrevious.text,null);
 assert.doesNotMatch(withoutPrevious.html,/Unreceived pending draft|Current dialogue|data-group-message-id|data-auto-request-id/);
});

test('saved messages and interrupted received previews keep their existing display behavior',()=>{
 for(const status of ['idle','awaiting-continue','failed','awaiting-presentation']){
  const saved=view({status,streaming:null});
  assert.deepEqual({id:saved.id,text:saved.text,body:saved.body},
   {id:'previous-message',text:'Previous dialogue',body:'Previous dialogue'});
 }
 for(const status of ['failed','idle']){
  const partial=view({status,streaming:{...received,text:'Interrupted received text',interrupted:true}});
  assert.deepEqual({id:partial.id,text:partial.text,body:partial.body},
   {id:'same-request',text:'Interrupted received text',body:'Interrupted received text'});
 }
});
