import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createAutoService} from '../src/companion-auto.mjs';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'voice-r8-auto-')),store=await openCompanionStore(root);
 t.after(async()=>{await store.flush();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});});
 const scope={characterId:'a',lifeId:'life-a',operationId:'op-a',personaId:'default',channel:'app-group',conversationId:'g'};
 await store.mutate(state=>{state.r95={settings:{auto:true}};state.lives={a:{id:'life-a',operationId:'op-a'},b:{id:'life-b',operationId:'op-b'}};state.groups.g={id:'g',personaId:'default',memberIds:['a','b'],mutedIds:[],messages:[]};});
 const dispatched=[],cancelled=[],runtime={};
 const service=createAutoService({store,now:()=>1000,getRuntimeState:()=>runtime,dispatchTurn:async value=>{dispatched.push(value);},cancelTurn:async value=>{cancelled.push(value);}});
 return {root,store,scope,service,dispatched,cancelled,runtime,start:(options={})=>service.start({groupId:'g',scope,authorizationId:'human-1',...options})};
}

test('R8 a conditional transaction observes the latest committed queue state before choosing to skip',async t=>{
 const f=await fixture(t);let release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 const before=f.store.state.revision;
 const first=f.store.mutate(async state=>{entered();await gate;state.settings.queueMarker='first';});
 await ready;
 const skipped=f.store.mutate(state=>{state.settings.queueMarker='must-not-run';},{guard:state=>state.settings.queueMarker!=='first'});
 release();await first;await skipped;
 assert.equal(f.store.state.settings.queueMarker,'first');
 assert.equal(f.store.state.revision,before+1);
 await f.store.flush();const reopened=await openCompanionStore(f.root);
 assert.equal(reopened.state.settings.queueMarker,'first');
});
async function queuedChange(f,change){
 let release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 const before=f.store.mutate(async state=>{entered();await gate;change(state);});
 await ready;const next=f.service.next({groupId:'g'});release();await before;return next;
}

test('R8 conditional transactions cannot write through their read-only decision view and a rejected decision does not poison the queue',async t=>{
 const f=await fixture(t),before=f.store.state.revision;
 for(const change of [state=>{state.settings.changed=true;},state=>{state.groups.g.memberIds.push('extra');},state=>{Object.getOwnPropertyDescriptor(state,'groups').value.g.memberIds=[];}]){
  await assert.rejects(f.store.mutate(state=>{state.settings.changed=true;},{guard:state=>{change(state);return false;}}),/read-only/);
 }
 await assert.rejects(f.store.mutate(state=>{state.settings.changed=true;},{guard:async()=>false}),/synchronously/);
 assert.equal(f.store.state.revision,before);assert.deepEqual(f.store.state.groups.g.memberIds,['a','b']);assert.equal(f.store.state.settings.changed,undefined);
 await f.store.mutate(state=>{state.settings.afterRejectedGuard=true;},{guard:()=>true});
 assert.equal(f.store.state.settings.afterRejectedGuard,true);assert.equal(f.store.state.revision,before+1);
});

test('R8 pending Auto waits return the current request without another dispatch or persisted change',async t=>{
 const f=await fixture(t);await f.start();const first=await f.service.next({groupId:'g'}),before=f.store.snapshot();
 for(let i=0;i<10;i++)assert.deepEqual(await f.service.next({groupId:'g'}),{skipped:'pending',requestId:first.requestId});
 assert.deepEqual(f.store.state,before);assert.equal(f.dispatched.length,1);assert.equal(f.cancelled.length,0);
 await f.store.flush();const reopened=await openCompanionStore(f.root);assert.deepEqual(reopened.state,before);
});

test('R8 each actual runtime presentation barrier waits without reserving or changing the Auto session',async t=>{
 const f=await fixture(t);await f.start();const before=f.store.snapshot();
 for(const [key,value]of [['typing',true],['presenting',true],['audioPlaying',true],['waitingForReply',true],['awaitingUserAnswer',true],['canPresent',false]]){
  f.runtime[key]=value;assert.deepEqual(await f.service.next({groupId:'g'}),{skipped:'presentation-barrier'});delete f.runtime[key];
 }
 assert.deepEqual(f.store.state,before);assert.equal(f.dispatched.length,0);
 assert.equal((await f.service.next({groupId:'g'})).dispatched,true);assert.equal(f.dispatched.length,1);
});

test('R8 a setting disabled ahead of a pending tick in the store queue still pauses Auto',async t=>{
 const f=await fixture(t);await f.start();const first=await f.service.next({groupId:'g'});
 assert.deepEqual(await queuedChange(f,state=>{state.r95.settings.auto=false;}),{skipped:'disabled'});
 const auto=f.service.view({groupId:'g'}).auto;assert.equal(auto.status,'paused');assert.equal(auto.pauseReason,'disabled');assert.equal(auto.pending.requestId,first.requestId);assert.equal(f.dispatched.length,1);
 await f.store.flush();const reopened=await openCompanionStore(f.root);assert.equal(reopened.state.groups.g.auto.pauseReason,'disabled');
});

test('R8 members changed ahead of a pending tick retire and cancel the original request exactly once',async t=>{
 const f=await fixture(t);await f.start();const first=await f.service.next({groupId:'g'}),generation=first.generation;
 assert.deepEqual(await queuedChange(f,state=>{state.groups.g.memberIds=['a'];}),{skipped:'members-changed'});
 const auto=f.service.view({groupId:'g'}).auto;assert.equal(auto.status,'ended');assert.equal(auto.generation,generation+1);assert.equal(auto.pending,null);assert.equal(auto.retiredRequests[first.requestId].status,'cancelled');
 assert.equal(f.cancelled.length,1);assert.equal(f.cancelled[0].requestId,first.requestId);assert.equal(f.dispatched.length,1);
 assert.equal((await f.service.commitOpportunity({groupId:'g',requestId:first.requestId,status:'presented',messageId:'late-message'})).retired,true);
 assert.deepEqual(await f.service.next({groupId:'g'}),{skipped:'ended'});assert.equal(f.cancelled.length,1);
});

test('R8 pending waits validate the current queued scope before returning a request',async t=>{
 const f=await fixture(t);await f.start();await f.service.next({groupId:'g'});
 await assert.rejects(queuedChange(f,state=>{state.lives.a.operationId='new-op';}),{code:'SOCIAL_STALE_LIFE'});
 assert.equal(f.dispatched.length,1);assert.equal(f.cancelled.length,0);assert.equal(f.service.view({groupId:'g'}).auto.pending.operationId,'op-a');
});

test('R8 a queued pause and a current runtime change are observed before a reservation',async t=>{
 const f=await fixture(t);await f.start();
 assert.deepEqual(await queuedChange(f,()=>{f.runtime.audioPlaying=true;}),{skipped:'presentation-barrier'});
 delete f.runtime.audioPlaying;
 const pause=f.service.pauseForUser({groupId:'g'}),next=f.service.next({groupId:'g'});await pause;
 assert.deepEqual(await next,{skipped:'paused'});assert.equal(f.dispatched.length,0);assert.equal(f.service.view({groupId:'g'}).auto.pending,null);
});

test('R8 a completion queued ahead of next releases the current opportunity before reserving the following member',async t=>{
 const f=await fixture(t);await f.start();const first=await f.service.next({groupId:'g'});
 const commit=f.service.commitOpportunity({groupId:'g',requestId:first.requestId,status:'silent',evidenceId:'silence-decision'}),next=f.service.next({groupId:'g'});
 await commit;const second=await next;
 assert.equal(second.characterId,'b');assert.notEqual(second.requestId,first.requestId);assert.equal(f.dispatched.length,2);
 const auto=f.service.view({groupId:'g'}).auto;assert.equal(auto.completed[first.requestId].status,'silent');assert.equal(auto.opportunityIndex,1);assert.equal(auto.pending.requestId,second.requestId);
});

test('R8 concurrent Auto services share the real transaction queue and stopping a pending request never resends it',async t=>{
 const f=await fixture(t);await f.start();
 const second=createAutoService({store:f.store,now:()=>1000,dispatchTurn:async value=>{f.dispatched.push(value);}});
 const results=await Promise.all([f.service.next({groupId:'g'}),second.next({groupId:'g'}),f.service.next({groupId:'g'})]);
 assert.equal(f.dispatched.length,1);assert.equal(results.filter(result=>result.skipped==='pending').length,1);
 const requestId=f.dispatched[0].requestId;
 await f.service.stop({groupId:'g'});assert.deepEqual(await second.next({groupId:'g'}),{skipped:'ended'});
 assert.equal(f.dispatched.length,1);assert.equal(f.cancelled.length,1);assert.equal(f.cancelled[0].requestId,requestId);
});