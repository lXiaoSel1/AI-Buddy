// Real R95 action/view, GroupStage ACK effect/frames, and rendered dialogue.
// Only model/dispatch and browser timing are synthetic; no real model is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {CompanionGroupStage} from '../src/group-stage-ui.mjs';
import {CompanionGroupDialogue} from '../src/companion-ui.mjs';
import {scheduleRenderedAck} from '../src/r95-core-page.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {companionFixture,memoryStore} from './support/audit-harness.mjs';
import {makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {setLocale} from '../src/i18n.mjs';
setLocale('zh-CN');
const defaultReply={id:'old-gpt',autoRequestId:'old-auto-request',text:'Historical GPT reply.'},reply=defaultReply;
const settle=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
function target(){const listeners=new Map();return {listeners,addEventListener(event,callback){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event).add(callback);},removeEventListener(event,callback){listeners.get(event)?.delete(callback);},signal(event){for(const fn of listeners.get(event)??[])fn();}};}
function frames({ready=true,send=()=>({acknowledged:true})}={}){
 const previousWindow=globalThis.window,win={...target(),innerWidth:1000,innerHeight:800,getComputedStyle:()=>({display:'block',visibility:'visible',opacity:'1'})};globalThis.window=win;
 let modal=false,next=1,sendCount=0,errorCount=0;const jobs=new Map(),timers=new Map(),observers=new Set(),errors=[],timerDelays=[];
 const node={dataset:ready?{groupMessageId:reply.id,autoRequestId:reply.autoRequestId}:{},textContent:reply.text,isConnected:true,parentElement:null,getClientRects:()=>[{}],getBoundingClientRect:()=>({width:200,height:50,top:20,left:20,right:220,bottom:70}),getAttribute:()=>null};
 const doc={...target(),hidden:false,documentElement:{},defaultView:win,querySelector:()=>modal?{}:null,querySelectorAll:()=>node.dataset.groupMessageId?[node]:[]};node.ownerDocument=doc;
 class Observer{constructor(callback){this.callback=callback;observers.add(this);}observe(root,options){this.options=options;}disconnect(){observers.delete(this);}}
 const requestFrame=callback=>{const id=next++;jobs.set(id,callback);return id;},cancelFrame=id=>jobs.delete(id),setTimer=(callback,delay)=>{const id=next++;timerDelays.push(delay);timers.set(id,callback);return id;},clearTimer=id=>timers.delete(id);
 let cancel=()=>{};
 return {doc,node,win,jobs,timers,timerDelays,Observer,requestFrame,cancelFrame,setTimer,clearTimer,
  start(extra={}){cancel=scheduleRenderedAck({document:doc,requestFrame,cancelFrame,Observer,setTimer,clearTimer,isReady:()=>!!node.dataset.groupMessageId&&!!node.dataset.autoRequestId&&node.textContent===reply.text,send:()=>{sendCount++;return send(sendCount);},onError:error=>{errorCount++;errors.push(error);},...extra});return cancel;},
  get sent(){return sendCount;},get failed(){return errorCount;},errors,
  frame(){const callbacks=[...jobs.values()];jobs.clear();for(const fn of callbacks)fn();},
  timer(){const callbacks=[...timers.values()];timers.clear();for(const fn of callbacks)fn();},
  mutate(type,attributeName){for(const observer of observers){const options=observer.options,accepted=type==='attributes'?options.attributes&&(!options.attributeFilter||options.attributeFilter.includes(attributeName)):type==='characterData'?options.characterData:options.childList;if(accepted)observer.callback([{type,attributeName,target:node}],observer);}},
  data(){node.dataset.groupMessageId=reply.id;node.dataset.autoRequestId=reply.autoRequestId;this.mutate('attributes','data-group-message-id');this.mutate('attributes','data-auto-request-id');},
  setModal(value){modal=value;},close(){cancel();globalThis.window=previousWindow;}
 };
}
// Persistent extension of the existing captureStage dispatcher: keeps refs/state
// and applies only the actual auto-rendered effect and its cleanup on dependency change.
function stageRenderer(){
 const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,slots=[];
 let cursor=0,effect,tree;
 return {
  render(state,request){
   const previous=internals.H;cursor=0;let nextEffect;
   internals.H={
    useRef(initial){const i=cursor++;return slots[i]??=( {current:initial});},
    useState(initial){const i=cursor++;slots[i]??={value:typeof initial==='function'?initial():initial};return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},
    useEffect(callback,dependencies){cursor++;if(callback.toString().includes('auto-rendered'))nextEffect={callback,dependencies};}
   };
   try{tree=CompanionGroupStage({state,request});}finally{internals.H=previous;}
   assert.ok(nextEffect,'The actual GroupStage rendered ACK effect must be captured');
   const changed=!effect||nextEffect.dependencies.some((value,i)=>!Object.is(value,effect.dependencies[i]));
   if(changed){effect?.cleanup?.();effect={...nextEffect,cleanup:nextEffect.callback()};}
   return {html:renderToStaticMarkup(tree),effectChanged:changed};
  },
  close(){effect?.cleanup?.();}
 };
}
async function fixture(t,{ended=true}={}){
 const seed=await companionFixture({now:1700000000000});seed.cards.gpt.name='GPT';seed.cards.hunyuan=makeCard({id:'hunyuan',name:'混元'});ensureLives(seed,1700000000000);
 const old={...defaultReply,role:'assistant',characterId:'gpt',characterName:'GPT',personaId:'default',status:'presented',lifeId:seed.lives.gpt.id,createdAt:1699999999000};
 const auto={id:'new-auto',status:'active',mode:'rounds',roundLimit:6,roundIndex:0,opportunityIndex:0,members:['gpt','hunyuan'],completed:{},pending:{requestId:'new-hunyuan-request',characterId:'hunyuan',status:'generating'}};
 if(ended)Object.assign(auto,{status:'ended',endedReason:'user-stopped',pending:null});
 seed.groups['probe-group']={id:'probe-group',name:'Synthetic group',personaId:'default',entryCharacterId:'gpt',memberIds:['gpt','hunyuan'],mutedIds:[],messages:[old],auto};
 const store=memoryStore(seed),dataRoot=mkdtempSync(join(tmpdir(),'group-first-ack-'));
 let modelCalls=0;const dispatches=[];
 const service=await createCompanionR95({store,dataRoot,provider:{enabled:false,resolveSearchCapability:()=>({supported:false}),stream(){modelCalls++;throw Error('Real or synthetic model execution is forbidden in this probe');}},dispatchAuto:async reservation=>{dispatches.push(structuredClone(reservation));},memory:{context:async()=>({text:''})},getContext:()=>({characterId:'gpt',personaId:'default',groupId:'probe-group'}),getRuntimeState:()=>({sleepPhase:'awake',canPresent:true,sleepIntentVersion:1}),delta:()=>{},now:()=>1700000000000});
 const f=frames(),renderer=stageRenderer(),calls=[];
 const keys=['document','requestAnimationFrame','cancelAnimationFrame','MutationObserver','setTimeout','clearTimeout'];
 const saved=Object.fromEntries(keys.map(key=>[key,globalThis[key]]));
 Object.assign(globalThis,{document:f.doc,requestAnimationFrame:f.requestFrame,cancelAnimationFrame:f.cancelFrame,MutationObserver:f.Observer,setTimeout:f.setTimer,clearTimeout:f.clearTimer});
 t.after(async()=>{renderer.close();Object.assign(globalThis,saved);f.close();await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});assert.equal(modelCalls,0);});
 const request=async(action,payload)=>{assert.equal(action,'companion-r95');const receipt=await service.action(payload.action,payload.args);calls.push({args:payload.args,receipt});return {ok:true,r95Result:receipt};};
 const ui=(runtime={})=>{const messages=structuredClone(store.state.groups['probe-group'].messages);return {activeGroupId:'probe-group',groups:[structuredClone(store.state.groups['probe-group'])],characters:Object.values(store.state.cards).map(c=>({id:c.id,name:c.name})),personas:[{id:'default',nickname:'你'}],groupMessages:messages,groupRuntime:{mode:'auto',status:'idle',queue:[],currentMessage:messages.at(-1),streaming:null,canRetry:false,canContinue:false,...runtime},r95:service.view()};};
 const show=state=>renderer.render(state,request);
 const paint=()=>{f.frame();f.frame();};
 return {store,service,f,renderer,calls,old,ui,request,show,paint,dispatches};
}


async function startAfterColdEnter(p){
 const before=p.ui();p.show(before);p.paint();await settle();
 assert.equal(p.calls.length,0,'An explicitly stopped historical session sends no ACK');
 await p.service.action('social-settings',{auto:true});
 await p.service.action('auto-start',{requestId:'explicit-auto-after-restart',mode:'rounds',rounds:6,memberIds:['hunyuan','gpt']});
 const state=p.ui({status:'generating',queue:['hunyuan'],streaming:null});
 assert.equal(state.r95.auto.status,'active');assert.equal(state.r95.auto.pending.status,'reserved');assert.equal(state.r95.auto.pending.characterId,'hunyuan');assert.equal(p.dispatches.length,1);
 return state;
}

test('cold enter stopped group then explicit Auto start never confirms the historical reply',async t=>{
 const p=await fixture(t),state=await startAfterColdEnter(p);
 assert.equal(state.groupRuntime.currentMessage.id,'old-gpt');
 assert.equal(p.service.presentation.presentation(p.service.activeScope(),p.old.id),null);
 p.show(state);p.paint();await settle();const html=p.show(state).html;
 assert.equal(p.calls.length,0,'The old persisted message is not a new presentation target');
 assert.doesNotMatch(html,/显示确认已失效|重新检查显示状态/);
});

test('changing only Auto session identity cancels a delayed terminal ACK response',async t=>{
 const p=await fixture(t,{ended:false}),scope=p.service.activeScope();
 p.service.presentation.beginPresentation(scope,{id:p.old.id,autoRequestId:p.old.autoRequestId,characterId:'gpt'});
 let release,calls=0;const gate=new Promise(resolve=>release=resolve);
 // The bridge may return an old terminal receipt after its session has changed.
 // Keep the real live target unchanged so only the Auto identity can cancel it.
 const delayed=async(action,payload)=>{calls++;if(calls===1){await gate;return {ok:true,r95Result:{acknowledged:false,retryable:false,reason:'not-ready'}};}return p.request(action,payload);};
 const first=p.ui();assert.equal(first.r95.autoPresentation.messageId,p.old.id);
 p.renderer.render(first,delayed);p.paint();await settle();assert.equal(calls,1);
 await p.store.mutate(s=>{s.groups['probe-group'].auto.id='another-auto';});
 const refreshed=p.ui();assert.deepEqual(refreshed.r95.autoPresentation,first.r95.autoPresentation);
 const commit=p.renderer.render(refreshed,delayed);p.paint();await settle();release();await settle();const html=p.renderer.render(refreshed,delayed).html;
 assert.doesNotMatch(html,/buddy-ack-error/,'A terminal response from the old Auto must not become the new session error');
 assert.equal(commit.effectChanged,true,'An Auto identity change cancels the old controller even when the visible target is unchanged');
 assert.equal(calls,2,'The new controller must issue a fresh ACK, never reuse the old pending receipt');
 assert.equal(p.calls[0]?.receipt.acknowledged,true,'The new generation confirms the actual live barrier');
});

test('the Auto strip and stage name the current request while historical text keeps its speaker',async t=>{
 const p=await fixture(t),state=await startAfterColdEnter(p),stage=p.show(state).html;
 const html=renderToStaticMarkup(React.createElement(CompanionGroupDialogue,{state,request:p.request,chat:{enabled:true}}));
 assert.match(stage,/混元<small>正在发言/);
 assert.match(html,/<b>混元<\/b> 正在说/,'The strip must follow the current request, matching the stage roster');
 assert.doesNotMatch(html,/<b>GPT<\/b> 正在说/);
 assert.match(html,/class="whg-plate gx-plate"[^>]*>GPT<\/div>/,'The historical text nameplate must still name GPT');
 assert.match(html,/data-group-message-id="old-gpt" data-auto-request-id="old-auto-request">Historical GPT reply\.<\/div>/);
});

test('cold recovery of a presented historical Auto reply has no presentation to confirm',async t=>{
 const p=await fixture(t,{ended:false}),state=p.ui();assert.equal(state.r95.auto.status,'paused');
 assert.equal(state.r95.autoPresentation,null);p.show(state);p.paint();await settle();
 assert.equal(p.calls.length,0);assert.doesNotMatch(p.show(state).html,/buddy-ack-error/);
 const result=await p.service.action('auto-rendered',{groupId:'probe-group',messageId:p.old.id,autoRequestId:p.old.autoRequestId,scope:state.r95.scope});
 assert.equal(result.acknowledged,false);assert.equal(result.retryable,false,'Unrelated historical rejection must remain a rejection');
});
async function publishCurrent(p,{hasAudio=false,status='presented'}={}){
 const pending=p.service.view().auto.pending,message={...p.old,id:'current-hunyuan',autoRequestId:pending?.requestId??'current-request',characterId:'hunyuan',characterName:'混元',lifeId:p.store.state.lives.hunyuan.id,status,text:'Current Hunyuan reply.'};
 await p.store.mutate(s=>{s.groups['probe-group'].messages.push(message);});
 const scope=p.service.activeScope();p.service.presentation.beginPresentation(scope,{id:message.id,autoRequestId:message.autoRequestId,characterId:message.characterId,hasAudio});
 Object.assign(p.f.node,{dataset:{groupMessageId:message.id,autoRequestId:message.autoRequestId},textContent:message.text});
 return {scope,message};
}
test('a real current barrier is ACKed after two frames while a new request and earlier audio are pending',async t=>{
 const p=await fixture(t);await startAfterColdEnter(p);const scope=p.service.activeScope();
 p.service.presentation.beginPresentation(scope,{id:'unrelated-speech',hasAudio:true});
 const {message}=await publishCurrent(p,{hasAudio:true}),state=p.ui();
 assert.equal(state.r95.autoWait,null,'A reserved next opportunity hides autoWait but must not hide the current real target');
 assert.deepEqual(state.r95.autoPresentation,{scope,messageId:message.id,autoRequestId:message.autoRequestId,characterId:'hunyuan'});
 assert.equal(p.store.state.groups['probe-group'].autoPresentation,undefined,'Presentation identity is runtime state only');
 p.show(state);p.f.frame();await settle();assert.equal(p.calls.length,0,'One visible frame is insufficient');
 p.f.frame();await settle();assert.equal(p.calls.length,1);assert.equal(p.calls[0].receipt.acknowledged,true);
 assert.equal(p.service.presentation.presentation(scope,message.id).textDone,true);assert.ok(p.service.presentation.presentation(scope,'unrelated-speech'));
 const refreshed=p.ui();assert.equal(refreshed.r95.autoPresentation,null,'Text already confirmed must not re-ACK while its audio continues');p.show(refreshed);p.paint();await settle();assert.equal(p.calls.length,1);
 assert.doesNotMatch(p.show(refreshed).html,/buddy-ack-error/);
});
for(const [status,endedReason] of [['paused',null],['ended','round-limit'],['ended','topic-ended']])test('the current presentation still ACKs when Auto is '+status+(endedReason?' by '+endedReason:''),async t=>{
 const p=await fixture(t);await startAfterColdEnter(p);await publishCurrent(p);
 await p.store.mutate(s=>{Object.assign(s.groups['probe-group'].auto,{status,endedReason,pending:null});});
 const state=p.ui();assert.ok(state.r95.autoPresentation);p.show(state);p.paint();await settle();assert.equal(p.calls[0]?.receipt.acknowledged,true);
 assert.doesNotMatch(p.show(p.ui()).html,/buddy-ack-error/);
});
test('an unpublished message cannot ACK even if it has an actual presentation barrier',async t=>{
 const p=await fixture(t);await startAfterColdEnter(p);await publishCurrent(p,{status:'pending-presentation'});const state=p.ui();
 assert.equal(state.r95.autoPresentation,null);p.show(state);p.paint();await settle();assert.equal(p.calls.length,0);assert.doesNotMatch(p.show(state).html,/buddy-ack-error/);
});
test('a delayed stale-scope ACK cannot surface after the scope changes and the new target ACKs',async t=>{
 const p=await fixture(t,{ended:false}),scope=p.service.activeScope();p.service.presentation.beginPresentation(scope,{id:p.old.id,autoRequestId:p.old.autoRequestId,characterId:'gpt'});
 let release,calls=0;const gate=new Promise(resolve=>release=resolve),delayed=async(action,payload)=>{calls++;await gate;return p.request(action,payload);};
 p.renderer.render(p.ui(),delayed);p.paint();await settle();assert.equal(calls,1);
 await p.store.mutate(s=>{s.groups['probe-group'].entryCharacterId='hunyuan';});
 const refreshedScope=p.service.activeScope();p.service.presentation.beginPresentation(refreshedScope,{id:p.old.id,autoRequestId:p.old.autoRequestId,characterId:'gpt'});
 const refreshed=p.ui();p.renderer.render(refreshed,p.request);p.paint();await settle();release();await settle();
 assert.ok(p.calls.some(call=>call.receipt.reason==='stale-scope'));assert.ok(p.calls.some(call=>call.receipt.acknowledged===true));
 assert.doesNotMatch(p.renderer.render(p.ui(),p.request).html,/buddy-ack-error/);
});
test('changing only the presentation target cancels the old delayed ACK response',async t=>{
 const p=await fixture(t,{ended:false}),scope=p.service.activeScope();p.service.presentation.beginPresentation(scope,{id:p.old.id,autoRequestId:p.old.autoRequestId,characterId:'gpt'});
 let release,calls=0;const gate=new Promise(resolve=>release=resolve),delayed=async()=>{calls++;await gate;return {ok:true,r95Result:{acknowledged:false,retryable:false,reason:'not-ready'}};};
 p.renderer.render(p.ui(),delayed);p.paint();await settle();assert.equal(calls,1);await publishCurrent(p);
 const refreshed=p.ui({currentMessage:p.old});p.renderer.render(refreshed,delayed);p.paint();release();await settle();
 assert.equal(calls,1,'A projected target not yet rendered must not be confirmed');assert.doesNotMatch(p.renderer.render(refreshed,delayed).html,/buddy-ack-error/);
});
