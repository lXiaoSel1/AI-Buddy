import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,rmSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {serialize} from 'node:v8';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createCompanionService} from '../src/companion-service.mjs';
import {createCompanionR95} from '../src/companion-r95.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {AutoEndedSummary,AutoRoundStrip} from '../src/chat-r95-ui.mjs';
import {ApiTransport} from '../src/api-transport.mjs';
import {estimateMemoryTokens} from '../src/companion-memory.mjs';
import {companionFixture,memoryStore,syntheticEngine,gate} from './support/audit-harness.mjs';

async function until(read,label){for(let i=0;i<500;i++){const value=await read();if(value)return value;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(label);}
async function fixture(t,{search=false,silent=false,wire=false,silentPeer=false}={}){
 const base=memoryStore(await companionFixture()),dataRoot=mkdtempSync(join(tmpdir(),'group-auto-backend-')),requests=[],bodies=[],audits=[],observed={sleepPhase:'awake',canPresent:true,sleepIntentVersion:1};let afterMutate=null,beforeMutate=null;
 const store={get state(){return base.state;},flush:()=>base.flush(),snapshot:()=>base.snapshot(),async mutate(fn){await beforeMutate?.();const result=await base.mutate(fn);await afterMutate?.();return result;}};
 const transport=new ApiTransport({audit:row=>audits.push(row),fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);bodies.push(body);const quiet=silentPeer&&body.messages[0].content.includes('当前角色ID：gpt\n');return new Response(JSON.stringify({choices:[{message:{content:quiet?'{"speak":false}':'{"text":"当前完整台词","affection":0}'},finish_reason:'stop'}]}),{headers:{'content-type':'application/json'}});}});
 const provider={enabled:true,resolveConnection:()=>({mode:'global',connectionId:'p',name:'p',model:'deepseek-flash',error:null}),currentSelection:()=>({provider:'p',model:'deepseek-flash'}),captureConnection:()=>({id:'p',model:'deepseek-flash',kind:'deepseek'}),resolveContextCapacity:()=>({tokens:272000,verified:false,source:'fixture'}),runTurn:async fn=>fn(),runCaptured:async(_profile,fn)=>fn(),async *stream(options){if(options.purpose==='group-chat'){requests.push(options);if(wire){yield* transport.stream({id:'p',kind:'deepseek',protocol:'chat-completions',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-flash',key:'fixture-key'}, {...options,nativeSearch:{allowed:search,check:()=>true}});return;}yield {type:'text-delta',text:silent?'{'+'"speak":false}':'{"text":"当前完整台词","affection":0}'};}else yield {type:'text-delta',text:'{"changed":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const {engine}=syntheticEngine({getStore:()=>store}),service=await createCompanionService({store,engine,provider,dataRoot,audit:row=>audits.push(row),r95Options:{getRuntimeState:()=>observed}});
 t.after(async()=>{afterMutate=null;beforeMutate=null;await service.close();await store.flush();rmSync(dataRoot,{recursive:true,force:true});});
 const group=(await service.action('companion-group-save',{name:'backend regression',memberIds:['claude','gpt'],mode:'list'})).group;await service.action('companion-group-select',{id:group.id});await service.r95.action('social-settings',{auto:true});
 return {store,service,group,requests,bodies,audits,observed,dataRoot,onMutate:fn=>afterMutate=fn,beforeMutate:fn=>beforeMutate=fn};
}
const pending=f=>until(()=>f.store.state.groups[f.group.id].pending?.message,'missing pending group message');
const start=f=>f.service.r95.action('auto-start',{requestId:'human-auto',mode:'rounds',rounds:2,memberIds:['claude']});

for(const search of [false,true])test('group initial '+(search?'search':'ordinary')+' wire ends with host scheduling after own assistant and a silent peer',async t=>{
 const f=await fixture(t,{search,wire:true,silentPeer:true});await f.store.mutate(state=>{const group=state.groups[f.group.id];group.seq=1;group.messages.push({id:'own-history',seq:1,role:'assistant',characterId:'claude',personaId:group.personaId,text:'自己上一句',createdAt:Date.now(),status:'presented',lifeId:state.lives.claude.id});});
 await f.service.r95.auto.start({groupId:f.group.id,scope:f.service.r95.activeScope(),authorizationId:'with-silent-peer',mode:'rounds',rounds:2,memberIds:['gpt','claude']});const peer=await f.service.r95.auto.next({groupId:f.group.id});await until(()=>f.store.state.groups[f.group.id].auto.completed[peer.requestId],'peer silence did not settle');await f.service.r95.auto.next({groupId:f.group.id});const message=await pending(f),request=f.requests.at(-1),body=f.bodies.at(-1),tail=request.messages.at(-1),index=JSON.parse(request.system.split('消息来源索引（与消息同序）：').at(-1));
 assert.ok(peer.requestId);assert.equal(tail.role,'user');assert.equal(tail.source.kind,'host-control');assert.match(tail.content[0].text,/host-control/);assert.equal(index.at(-1),'host');assert.equal(index.length,request.messages.length);assert.match(request.system,/host.*(?:调度|宿主)/);assert.ok(request.messages.some(row=>row.role==='assistant'&&row.content[0].text.includes('自己上一句')));assert.equal(body.messages.at(-1).role,'user');assert.match(body.messages.at(-1).content,/host-control/);assert.equal(f.store.state.groups[f.group.id].messages.length,1);assert.equal(f.store.state.groups[f.group.id].messages[0].id,'own-history');const {signal,...budgeted}=request;assert.equal(message.request.capacity.estimatedInputTokens,estimateMemoryTokens(budgeted));assert.equal(typeof request.traceId,'string');assert.ok(f.audits.some(row=>row.traceId===request.traceId));
});

for(const text of ['', '玩家真实新消息'])test('group initial host control stays separate from '+(text?'real user history':'an empty group'),async t=>{
 const f=await fixture(t);await f.service.action('companion-group-send',{id:f.group.id,text,forceCharacterId:'claude'});await pending(f);const request=f.requests[0],index=JSON.parse(request.system.split('消息来源索引（与消息同序）：').at(-1));assert.equal(request.messages.at(-1).source.kind,'host-control');assert.equal(index.at(-1),'host');assert.equal(index.filter(value=>value==='user').length,text?1:0);assert.equal(f.store.state.groups[f.group.id].messages.length,text?1:0);assert.equal(f.service.progress('claude','default').affection,35);
});

test('Auto rendered ACK during the first public store commit cannot be overwritten by a later begin',async t=>{
 const f=await fixture(t);await start(f);const message=await pending(f),scope=f.service.r95.activeScope(),published=gate(),release=gate();let entered=false,ack;
 f.onMutate(async()=>{if(entered||!f.store.state.groups[f.group.id].messages.some(row=>row.id===message.id))return;entered=true;published.resolve();await release.promise;});
 const presenting=f.service.action('companion-group-present',{id:f.group.id,requestId:message.id});await published.promise;
 try{assert.equal(f.service.r95.presentation.snapshot(scope).presenting,true);ack=await f.service.r95.action('auto-rendered',{groupId:f.group.id,messageId:message.id,autoRequestId:message.autoRequestId,scope});}finally{release.resolve();}
 await presenting;assert.equal(ack.acknowledged,true);assert.equal(f.service.r95.presentation.snapshot(scope).presenting,false);const duplicate=await f.service.r95.action('auto-rendered',{messageId:message.id,autoRequestId:message.autoRequestId,scope});assert.equal(duplicate.acknowledged,true);assert.equal(duplicate.duplicate,true);
});

test('Auto ACK reports retryability and rejects stale identity without clearing the next barrier',async t=>{
 const f=await fixture(t);await start(f);const message=await pending(f),scope=f.service.r95.activeScope();const early=await f.service.r95.action('auto-rendered',{messageId:message.id,autoRequestId:message.autoRequestId,scope});assert.equal(early.acknowledged,false);assert.equal(early.retryable,true);
 await f.service.action('companion-group-present',{id:f.group.id,requestId:message.id});const stale=await f.service.r95.action('auto-rendered',{messageId:message.id,autoRequestId:message.autoRequestId,scope:{...scope,operationId:'old-operation'}});assert.equal(stale.acknowledged,false);assert.notEqual(stale.retryable,true);assert.equal(f.service.r95.presentation.snapshot(scope).presenting,true);
 assert.equal((await f.service.r95.action('auto-rendered',{messageId:message.id,autoRequestId:message.autoRequestId,scope})).acknowledged,true);f.service.r95.presentation.beginPresentation(scope,{id:'new-message'});assert.equal((await f.service.r95.action('auto-rendered',{messageId:message.id,autoRequestId:message.autoRequestId,scope})).duplicate,true);assert.equal(f.service.r95.presentation.snapshot(scope).presenting,true);
});

test('a historical presented Auto message without a live barrier is not a successful ACK',async t=>{
 const f=await fixture(t),scope=f.service.r95.activeScope();await f.store.mutate(state=>state.groups[f.group.id].messages.push({id:'historic',autoRequestId:'old-auto',role:'assistant',status:'presented',personaId:scope.personaId,lifeId:scope.lifeId,lifeToken:{lifeId:scope.lifeId,operationId:scope.operationId},characterId:scope.characterId,text:'old'}));const result=await f.service.r95.action('auto-rendered',{messageId:'historic',autoRequestId:'old-auto',scope});assert.equal(result.acknowledged,false);assert.notEqual(result.retryable,true);
});

test('a rejected first presentation store write removes its unpublished barrier and permits explicit retry',async t=>{
 const f=await fixture(t);await start(f);const message=await pending(f),scope=f.service.r95.activeScope();let reject=true;f.beforeMutate(()=>{if(reject){reject=false;throw Error('synthetic presentation write failure');}});await assert.rejects(f.service.action('companion-group-present',{id:f.group.id,requestId:message.id}),/synthetic presentation write failure/);assert.equal(f.service.r95.presentation.snapshot(scope).presenting,false);assert.equal(f.store.state.groups[f.group.id].messages.length,0);await f.service.action('companion-group-present',{id:f.group.id,requestId:message.id});assert.equal((await f.service.r95.action('auto-rendered',{messageId:message.id,autoRequestId:message.autoRequestId,scope})).acknowledged,true);
});

test('successful ACK history is bounded and an evicted old ACK cannot clear a new barrier',async t=>{
 const f=await fixture(t),scope=f.service.r95.activeScope();await f.store.mutate(state=>{for(let i=0;i<129;i++)state.groups[f.group.id].messages.push({id:'ack-'+i,autoRequestId:'auto-'+i,role:'assistant',status:'presented',personaId:scope.personaId,lifeId:scope.lifeId,lifeToken:{lifeId:scope.lifeId,operationId:scope.operationId},characterId:scope.characterId,text:'line '+i});});
 for(let i=0;i<129;i++){f.service.r95.presentation.beginPresentation(scope,{id:'ack-'+i,autoRequestId:'auto-'+i});assert.equal((await f.service.r95.action('auto-rendered',{messageId:'ack-'+i,autoRequestId:'auto-'+i,scope})).acknowledged,true);}f.service.r95.presentation.beginPresentation(scope,{id:'new-barrier',autoRequestId:'new-auto'});assert.equal((await f.service.r95.action('auto-rendered',{messageId:'ack-0',autoRequestId:'auto-0',scope})).acknowledged,false);assert.equal((await f.service.r95.action('auto-rendered',{messageId:'ack-128',autoRequestId:'auto-128',scope})).duplicate,true);assert.equal(f.service.r95.presentation.snapshot(scope).messageId,'new-barrier');
});

test('Auto wait projection combines tracked and observed runtime without storing UI wait state',async t=>{
 const f=await fixture(t),scope=f.service.r95.activeScope();await f.service.r95.auto.start({groupId:f.group.id,scope,authorizationId:'wait-projection',mode:'rounds',rounds:2,memberIds:['claude']});const read=()=>f.service.r95.view().autoWait;
 assert.equal(read().reason,'ready');f.service.r95.presentation.beginInput(scope,'input');f.service.r95.presentation.beginRequest(scope,'model');f.service.r95.presentation.beginPresentation(scope,{id:'visible-line'});assert.equal(read().reason,'presenting');assert.equal(read().messageId,'visible-line');f.service.r95.presentation.finishText(scope,'visible-line');assert.equal(read().reason,'input');f.service.r95.presentation.endInput(scope,'input');assert.equal(read().reason,'model');f.service.r95.presentation.endRequest(scope,'model');f.service.r95.presentation.setAwaitingUser(scope,true);assert.equal(read().reason,'awaiting-user');f.service.r95.presentation.setAwaitingUser(scope,false);f.observed.canPresent=false;assert.equal(read().reason,'not-visible');assert.equal(f.store.state.groups[f.group.id].autoWait,undefined);await f.service.r95.auto.pauseForUser({groupId:f.group.id});assert.equal(read(),null);
});

test('a silent opportunity journal stays completed-silent after its delayed streaming timer',async t=>{
 const f=await fixture(t,{silent:true});await start(f);await until(()=>Object.values(f.store.state.groups[f.group.id].auto.completed).length,'silent opportunity did not settle');await new Promise(resolve=>setTimeout(resolve,140));const rows=readdirSync(join(f.dataRoot,'chat-requests')).filter(name=>name.endsWith('.json')).map(name=>JSON.parse(readFileSync(join(f.dataRoot,'chat-requests',name),'utf8'))).filter(row=>row.groupId===f.group.id);assert.equal(rows.length,1);assert.equal(rows[0].status,'completed-silent');assert.equal(f.store.state.groups[f.group.id].messages.length,0);
});

test('stopping a presented unacknowledged Auto line releases it for a new ordinary turn and a new Auto session',async t=>{
 const f=await fixture(t);await start(f);const line=await pending(f),scope=f.service.r95.activeScope();await f.service.action('companion-group-present',{id:f.group.id,requestId:line.id});assert.equal(f.service.r95.presentation.snapshot(scope).presenting,true);assert.equal(f.store.state.groups[f.group.id].auto.pending,null);await f.service.r95.action('auto-stop');assert.equal(f.service.r95.presentation.snapshot(scope).presenting,false);
 await f.service.action('companion-group-send',{id:f.group.id,text:'普通新话题',forceCharacterId:'claude'});const ordinary=await pending(f);assert.equal(ordinary.autoRequestId,undefined);await f.service.action('companion-group-present',{id:f.group.id,requestId:ordinary.id});await f.service.r95.action('auto-start',{requestId:'new-human-auto',mode:'rounds',rounds:2,memberIds:['claude']});const next=await pending(f);assert.ok(next.autoRequestId);assert.notEqual(next.autoRequestId,line.autoRequestId);assert.equal(f.requests.length,3);
});

test('Auto stop preserves other scopes and unrelated speech, input and request barriers',async t=>{
 const f=await fixture(t);await start(f);const line=await pending(f),scope=f.service.r95.activeScope(),other={...scope,conversationId:'another-group'};await f.service.action('companion-group-present',{id:f.group.id,requestId:line.id});f.service.r95.presentation.beginPresentation(other,{id:'other-auto',autoRequestId:line.autoRequestId});f.service.r95.presentation.beginPresentation(scope,{id:'unrelated-speech'});f.service.r95.presentation.beginPresentation(scope,{id:'unrelated-auto',autoRequestId:'another-auto-session'});f.service.r95.presentation.beginInput(scope,'input');f.service.r95.presentation.beginRequest(scope,'request');await f.service.r95.action('auto-stop');assert.equal(f.service.r95.presentation.presentation(scope,line.id),null);assert.ok(f.service.r95.presentation.presentation(scope,'unrelated-speech'));assert.ok(f.service.r95.presentation.presentation(scope,'unrelated-auto'));assert.ok(f.service.r95.presentation.presentation(other,'other-auto'));assert.equal(f.service.r95.presentation.snapshot(scope).typing,true);assert.equal(f.service.r95.presentation.snapshot(scope).waitingForReply,true);
});

test('a paused Auto user insertion keeps its ordinary list continuation and runtime ownership',async t=>{
 const f=await fixture(t);await start(f);const automatic=await pending(f),scope=f.service.r95.activeScope();await f.service.action('companion-group-send',{id:f.group.id,text:'请大家讨论新问题',clientRequestId:'ordinary-insertion'});await f.service.action('companion-group-present',{id:f.group.id,requestId:automatic.id});await f.service.r95.action('auto-rendered',{messageId:automatic.id,autoRequestId:automatic.autoRequestId,scope});const first=await pending(f);assert.equal(first.autoRequestId,undefined);await f.service.action('companion-group-present',{id:f.group.id,requestId:first.id});const runtime=f.service.viewState().groupRuntime;assert.equal(f.store.state.groups[f.group.id].auto.status,'paused');assert.equal(runtime.status,'awaiting-continue');assert.equal(runtime.mode,'list');assert.equal(typeof runtime.roundId,'string');await f.service.action('companion-group-continue',{id:f.group.id});const second=await pending(f);assert.equal(second.characterId,'gpt');assert.equal(second.autoRequestId,undefined);assert.equal(f.requests.length,3);assert.equal(f.store.state.groups[f.group.id].auto.status,'paused');
});


test('SQLite companion Auto view retains all 200 visible results without fetching its receipt payloads',async t=>{
 const dataRoot=mkdtempSync(join(tmpdir(),'group-auto-progress-view-'));
 let store,core;
 t.after(async()=>{await core?.close();await store?.close();rmSync(dataRoot,{recursive:true,force:true});});
 const state=await companionFixture(),groupId='projection-group',sessionId='projection-session',characterId='claude',personaId='default';
 const {id:lifeId,operationId}=state.lives[characterId];
 const scope={characterId,personaId,lifeId,operationId,channel:'app-group',conversationId:groupId};
 const evidence='synthetic-receipt-content-'.repeat(20);
 const members=['claude','gpt'];
 const completed=Object.fromEntries(Array.from({length:200},(_,i)=>['result-'+i,{
  requestId:'result-'+i,characterId:members[i%2],status:i%2?'silent':'presented',roundIndex:Math.floor(i/2),
  opportunityIndex:i%2,evidenceId:evidence,messageId:'message-'+i,lifeId,operationId
 }]));
 delete completed['result-1'].roundIndex;
 completed['result-2'].roundIndex=null;
 completed['result-2'].opportunityIndex=true;
 completed['result-3'].roundIndex=true;
 delete completed['result-3'].opportunityIndex;
 const retiredRequests=Object.fromEntries(Array.from({length:200},(_,i)=>['retired-'+i,{status:'cancelled',evidenceId:evidence}]));
 state.r95={settings:{auto:true}};
 state.activeGroupId=groupId;
 state.groups[groupId]={id:groupId,personaId,memberIds:members,entryCharacterId:characterId,messages:[],
  auto:{id:sessionId,scope,mode:'until-stopped',authorizationId:'private-authorization',members,groupMemberSnapshot:members,
   status:'active',generation:1,roundIndex:100,opportunityIndex:0,completed,retiredRequests,pending:{
    requestId:'current-request',characterId,lifeId,operationId,generation:1,status:'dispatched',roundIndex:100,opportunityIndex:0
   }}
 };
 const dir=join(dataRoot,'galgame');
 mkdirSync(dir);
 writeFileSync(join(dir,'companion.json'),JSON.stringify(state));
 store=await openCompanionStore(dataRoot);
 assert.equal(store.state.groups[groupId].auto.completed,undefined,'the fixture must exercise SQL records');
 core=await createCompanionR95({store,dataRoot,provider:{},getContext:()=>({characterId,personaId,groupId})});
 const privateAuto=core.auto.view({groupId}).auto;
 const rendered=await core.action('view'),auto=rendered.auto;
 assert.equal(Object.hasOwn(auto,'retiredRequests'),false,'routine renderer view should carry progress only');
 assert.deepEqual(Object.keys(auto.completed),Object.keys(completed));
 assert.deepEqual(auto.completed['result-0'],{characterId:'claude',status:'presented',roundIndex:0,opportunityIndex:0});
 assert.equal(Object.hasOwn(auto.completed['result-1'],'roundIndex'),false);
 assert.equal(auto.completed['result-2'].roundIndex,null);
 assert.equal(auto.completed['result-2'].opportunityIndex,true);
 assert.equal(auto.completed['result-3'].roundIndex,true);
 assert.equal(Object.hasOwn(auto.completed['result-3'],'opportunityIndex'),false);
 assert.deepEqual(auto.pending,{requestId:'current-request',characterId,status:'unknown',roundIndex:100});
 assert.equal(Object.hasOwn(auto,'authorizationId'),false);
 assert.equal(privateAuto.completed['result-0'].evidenceId,evidence);
 assert.deepEqual(privateAuto.retiredRequests,retiredRequests);
 const fullBytes=serialize(privateAuto).byteLength,progressBytes=serialize(auto).byteLength;
 assert.ok(progressBytes<fullBytes/3);
 t.diagnostic(JSON.stringify({fullBytes,progressBytes,completed:Object.keys(auto.completed).length}));
 const markup=(Component,view)=>renderToStaticMarkup(React.createElement(Component,{view,onAction:async()=>{}}));
 const paused=markup(AutoRoundStrip,rendered);
 assert.match(paused,/data-auto-round-index="99"/);
 assert.match(paused,/未标注轮次的记录/);
 assert.equal(paused,markup(AutoRoundStrip,{...rendered,auto:privateAuto}));

 await store.mutate(state=>{
  const active=state.groups[groupId].auto;
  active.status='active';
  active.pending.status='dispatched';
 });
 const active=await core.action('view'),fullActive=core.auto.view({groupId}).auto;
 assert.match(markup(AutoRoundStrip,active),/Auto .*暂停/);
 assert.equal(markup(AutoRoundStrip,active),markup(AutoRoundStrip,{...active,auto:fullActive}));

 // Retiring the pending request at capacity evicts the oldest retired row.
 core.presentation.beginPresentation(scope,{id:'stop-presentation',autoRequestId:'retired-199'});
 const stopped=await core.action('auto-stop');
 assert.equal(stopped.retiredRequests['retired-199'].evidenceId,evidence);
 assert.equal(core.presentation.presentation(scope,'stop-presentation'),null);
 const ended=await core.action('view'),fullEnded=core.auto.view({groupId}).auto;
 assert.equal(ended.auto.endedReason,'user-stopped');
 assert.equal(ended.auto.endedAt,fullEnded.endedAt);
 assert.deepEqual(fullEnded.completed,completed);
 assert.equal(markup(AutoEndedSummary,ended),markup(AutoEndedSummary,{...ended,auto:fullEnded}));
});
