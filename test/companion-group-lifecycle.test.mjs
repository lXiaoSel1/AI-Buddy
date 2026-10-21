import {presentedState} from './support/presented-state.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGalgame} from '../src/galgame-host.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
const until=async fn=>{for(let n=0;n<300;n++){if(await fn())return;await new Promise(r=>setTimeout(r,4));}throw Error('fixture timeout');};
const state=presentedState;
async function fixture(){
 const root=mkdtempSync(join(tmpdir(),'buddy-group-leave-')),activity=new Set(),events=[],calls=[];let blocked=false,release,entered=false,aborted=false;const gate=new Promise(r=>release=r);
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[{id:'fixture'}],listModels:()=>[{id:'fixture'}],runTurn:async fn=>fn(),async *stream(o){calls.push(o);if(o.purpose==='group-chat'){const wait=blocked;if(wait){entered=true;await Promise.race([gate,new Promise(r=>{if(o.signal.aborted){aborted=true;r();}else o.signal.addEventListener('abort',()=>{aborted=true;r();},{once:true});})]);}yield{type:'text-delta',text:JSON.stringify({text:wait?'未展示草稿':'已提交台词',emotion:'normal',affection:1})};}else yield{type:'text-delta',text:/情绪分类器/.test(o.system)?'normal':/选项生成器/.test(o.system)?'{"positive":"好","neutral":"继续","negative":"暂停"}':'私聊回复'};yield{type:'finish',reason:{kind:'stop'}};}};
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',onActivity:e=>e.active?activity.add(e.id):activity.delete(e.id),onChatCommitted:e=>events.push(e)});
 return {root,game,activity,events,calls,get entered(){return entered;},get aborted(){return aborted;},block(){blocked=true;},unblock(){release();}};
}

for(const exit of ['character','persona','another-group'])test(`Leaving a generating group via ${exit} stops its draft and queue but retains already displayed lines`,async()=>{
 const f=await fixture();try{const first=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude'],mode:'list'})).group,other=(await f.game.action('companion-group-save',{memberIds:['qwen'],mode:'list'})).group,persona=(await f.game.action('companion-persona-save',{name:'新身份'})).persona;
  await f.game.action('companion-group-select',{id:first.id});await f.game.action('companion-group-send',{id:first.id,text:'第一轮'});await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');f.block();await f.game.action('companion-group-continue',{id:first.id});await until(()=>f.entered);assert.equal(f.activity.size,1);
  if(exit==='character')await f.game.action('companion-character-select',{id:'kimi'});else if(exit==='persona')await f.game.action('companion-persona-select',{id:persona.id});else await f.game.action('companion-group-select',{id:other.id});await until(()=>f.activity.size===0);f.unblock();assert.equal(f.aborted,true);assert.equal(f.events.filter(e=>e.group).length,1);
  const disk=await openCompanionStore(f.root),saved=disk.state.groups[first.id];assert.equal(saved.pending,undefined);assert.equal(saved.messages.filter(m=>m.role==='assistant').length,1);assert.equal(saved.messages.at(-1).text,'已提交台词');await f.game.action('companion-group-select',{id:first.id});const s=await state(f.game);assert.equal(s.groupRuntime.status,'idle');assert.deepEqual(s.groupRuntime.queue,[]);assert.ok(!JSON.stringify(s.groupMessages).includes('未展示草稿'));
 }finally{f.unblock();f.game.close();}
});

test('Selecting the same group again preserves its in-flight request and remaining turn',async()=>{
 const f=await fixture();try{const group=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude'],mode:'list'})).group;await f.game.action('companion-group-select',{id:group.id});f.block();await f.game.action('companion-group-send',{id:group.id,text:'留在原群'});await until(()=>f.entered);await f.game.action('companion-group-select',{id:group.id});assert.equal(f.aborted,false);assert.equal((await state(f.game)).groupRuntime.status,'generating');f.unblock();await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');assert.equal(f.events.filter(e=>e.group).length,1);assert.deepEqual((await state(f.game)).groupRuntime.queue,['claude']);}finally{f.unblock();f.game.close();}
});

test('Removing the final queued member returns to idle and permits a new turn',async()=>{
 const f=await fixture();try{const group=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude'],mode:'list'})).group;await f.game.action('companion-group-select',{id:group.id});await f.game.action('companion-group-send',{id:group.id,text:'第一轮'});await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');await f.game.action('companion-group-member',{id:group.id,characterId:'claude',op:'leave'});let s=await state(f.game);assert.equal(s.groupRuntime.status,'idle');assert.deepEqual(s.groupRuntime.queue,[]);await f.game.action('companion-group-send',{id:group.id,text:'可正常开始下一轮'});await until(async()=>(await state(f.game)).groupRuntime.status==='idle');assert.equal((await state(f.game)).groupMessages.filter(m=>m.role==='assistant').length,2);assert.equal(f.calls.filter(o=>o.purpose==='group-chat').length,2);}finally{f.game.close();}
});

test('Editing members while awaiting filters the existing queue without inserting newly joined members into that turn',async()=>{
 const f=await fixture();try{const group=(await f.game.action('companion-group-save',{memberIds:['deepseek','claude','kimi'],mode:'list'})).group;await f.game.action('companion-group-select',{id:group.id});await f.game.action('companion-group-send',{id:group.id,text:'新成员不应知道的旧开场'});await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');await f.game.action('companion-group-save',{id:group.id,memberIds:['deepseek','kimi','qwen']});let s=await state(f.game);assert.equal(s.groupRuntime.status,'awaiting-continue');assert.deepEqual(s.groupRuntime.queue,['kimi']);await f.game.action('companion-group-save',{id:group.id,memberIds:['deepseek','qwen']});s=await state(f.game);assert.equal(s.groupRuntime.status,'idle');assert.deepEqual(s.groupRuntime.queue,[]);assert.equal(f.calls.filter(o=>o.purpose==='group-chat').length,1);await f.game.action('companion-group-send',{id:group.id,text:'新成员加入后的下一轮'});await until(async()=>(await state(f.game)).groupRuntime.status==='awaiting-continue');await f.game.action('companion-group-continue',{id:group.id});await until(async()=>(await state(f.game)).groupRuntime.status==='idle');assert.ok(!JSON.stringify(f.calls.filter(o=>o.purpose==='group-chat').at(-1).messages).includes('新成员不应知道的旧开场'));
 }finally{f.game.close();}
});
