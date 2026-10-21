import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {planLegacyDedupe,applyLegacyDedupe} from '../src/legacy-dedupe.mjs';
import {createMaintenance} from '../src/maintenance.mjs';
import {tmpDir,memoryStore,copy} from './support/audit-harness.mjs';

const line=(id,role,text,extra={})=>({id,role,text,legacy:true,createdAt:0,revisions:[],...extra});
const chat=(id,text)=>({id,role:'user',text,createdAt:Date.now(),status:'sent'});
const conversation=(id,createdAt,messages,extra={})=>({id,characterId:'claude',personaId:'default',lifeId:'life-1',title:id,archived:false,createdAt,updatedAt:createdAt,messages,...extra});
// What 1.9.0 left behind: the full legacy history copied into each newer conversation.
function duplicated(){
 return {cards:{claude:{id:'claude'}},lives:{claude:{id:'life-1',memory:{events:{
   'e-first':{id:'e-first',source:{id:'first',messageId:'a1'}},'e-copy':{id:'e-copy',source:{id:'second',messageId:'a2'}}}}}},
  conversations:{
   first:conversation('first',1,[line('a1','user','旧消息一'),line('b1','assistant','旧回复一'),chat('u1','今天好'),line('c1','narrator','（分别了太久……）')]),
   second:conversation('second',2,[chat('u2','新会话'),line('a2','user','旧消息一'),line('b2','assistant','旧回复一'),line('c2','narrator','（分别了太久……）'),line('d2','narrator','（又过了一周……）')]),
   third:conversation('third',3,[line('a3','user','旧消息一'),line('b3','assistant','旧回复一')],{archived:true}),
   lone:conversation('lone',4,[chat('u4','只是聊天'),line('x4','assistant','旧回复一'),chat('u5','继续')]),
   otherLife:conversation('otherLife',5,[line('a5','user','旧消息一'),line('b5','assistant','旧回复一')],{lifeId:'life-2'}),
  }};
}
const texts=(state,id)=>state.conversations[id].messages.map(m=>m.text);

test('T3: copies are matched by speaker, text and order; the earliest copy, chats and new lines stay',()=>{
 const state=duplicated(),plan=planLegacyDedupe(state);
 assert.equal(plan.total,5);assert.deepEqual(plan.characters,{claude:{duplicates:5,conversations:2}});
 assert.match(plan.planId,/^[a-f0-9]{32}$/);
 applyLegacyDedupe(state,plan.planId);
 assert.deepEqual(texts(state,'first'),['旧消息一','旧回复一','今天好','（分别了太久……）']);
 assert.deepEqual(texts(state,'second'),['新会话','（又过了一周……）']);
 assert.deepEqual(texts(state,'third'),[]);
 assert.deepEqual(texts(state,'lone'),['只是聊天','旧回复一','继续'],'one equal line alone is not treated as a copy');
 assert.deepEqual(texts(state,'otherLife'),['旧消息一','旧回复一'],'another life keeps its own copy');
 assert.equal(state.lives.claude.memory.events['e-copy'].duplicateOf,'e-first');assert.equal(state.lives.claude.memory.events['e-first'].duplicateOf,undefined);
 assert.equal(planLegacyDedupe(state).total,0,'a second run finds nothing');
});

test('T3: a stale planId is refused',()=>{
 const state=duplicated(),plan=planLegacyDedupe(state);state.conversations.second.messages.push(chat('u9','又说了一句'));
 assert.throws(()=>applyLegacyDedupe(state,plan.planId),error=>error.code==='MAINTENANCE_PLAN_CHANGED');
});

test('T3 through maintenance: plan is read-only, apply backs up first and refuses while busy',async t=>{
 const root=tmpDir('t3',{t}),store=memoryStore(duplicated()),before=copy(store.state),audit=[];let busy=true;
 const tool=createMaintenance({store,dataRoot:root,audit:row=>audit.push(row),isBusy:()=>busy,tasks:{'legacy-dedupe':{plan:planLegacyDedupe,apply:applyLegacyDedupe,summary:({removals,...rest})=>({...rest,conversations:removals.length})}}});
 const plan=tool.plan('legacy-dedupe');assert.equal(plan.total,5);assert.deepEqual(store.state,before);
 await assert.rejects(tool.apply('legacy-dedupe',plan.planId),error=>error.code==='MAINTENANCE_BUSY');
 busy=false;await assert.rejects(tool.apply('legacy-dedupe','0'.repeat(32)),error=>error.code==='MAINTENANCE_PLAN_CHANGED');
 assert.deepEqual(readdirSync(root),[],'nothing written before a valid plan');
 const result=await tool.apply('legacy-dedupe',plan.planId);
 assert.equal(result.total,5);assert.deepEqual(JSON.parse(readFileSync(result.backup,'utf8')),before);
 assert.deepEqual(texts(store.state,'third'),[]);assert.equal(audit[0].type,'maintenance-apply');
 assert.throws(()=>tool.plan('unknown'),/未知维护任务/);
});
