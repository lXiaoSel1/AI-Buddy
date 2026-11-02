import test from 'node:test';
import assert from 'node:assert/strict';
import {createMoodService,projectedMood,rebaseMoodSnapshot} from '../src/companion-mood.mjs';
import {createAttentionService} from '../src/companion-attention.mjs';
import {createPresentationState} from '../src/companion-presentation-state.mjs';
function fixture(){let state={lives:{a:{id:'life-a',operationId:'op-a'},b:{id:'life-b',operationId:'op-b'}},personas:{p:{},q:{}}};let tail=Promise.resolve();return {get state(){return state;},mutate(fn){const task=tail.then(async()=>{const next=structuredClone(state),result=await fn(next);state=next;return result;});tail=task.catch(()=>{});return task;}};}
const scope={characterId:'a',lifeId:'life-a',operationId:'op-a',personaId:'p',channel:'app',conversationId:'conv-p'};
const feeling=(eventId='event-1')=>({label:'关心',summary:'关心用户刚才的经历',intensity:.8,recoveryHalfLifeMs:3600000,eventIds:[eventId]});
test('R95 mood is an independent character feeling, not a user anger label',async()=>{
 const store=fixture();let at=1000,calls=0;const service=createMoodService({store,now:()=>at,getEvidence:async()=>[{eventId:'event-1',text:'用户很生气'}],generate:async()=>{calls++;return {overall:feeling(),feelings:[]};}});
 await service.evaluate({scope,eventIds:['event-1']});assert.equal(service.view({scope}).overall.label,'关心');assert.equal(calls,1);
 await service.evaluate({scope,eventIds:['event-1']});assert.equal(calls,1);at+=3600000;assert.equal(service.view({scope}).overall.intensity,.4);assert.equal(store.state.lives.a.r95.mood.overall.anchorIntensity,.8);
});
test('R95 mood privacy hides another Persona reason while retaining the character mood',async()=>{
 const store=fixture(),service=createMoodService({store,now:()=>1000,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>({overall:feeling(),feelings:[{...feeling(),target:'private-person'}]})});
 await service.evaluate({scope,eventIds:['event-1']});const other=service.view({scope:{...scope,personaId:'q',conversationId:'conv-q'}});assert.equal(other.overall.label,'关心');assert.equal(other.overall.summary,'');assert.deepEqual(other.overall.eventIds,[]);assert.deepEqual(other.feelings,[]);
});
test('R95 mood invalid output does not replace the previous state',async()=>{
 const store=fixture();let invalid=false;const service=createMoodService({store,now:()=>1000,getEvidence:async({eventIds})=>eventIds.map(eventId=>({eventId})),generate:async({events})=>({overall:{...feeling(events[0].eventId),intensity:invalid?NaN:.8},feelings:[]})});
 await service.evaluate({scope,eventIds:['event-1']});invalid=true;await assert.rejects(service.evaluate({scope,eventIds:['event-2']}),{code:'MOOD_OUTPUT_INVALID'});assert.equal(service.view({scope}).overall.intensity,.8);
});
test('R95 stale mood evaluation cannot commit into a reset life',async()=>{
 const store=fixture();let release;const waiting=new Promise(resolve=>{release=resolve;});const service=createMoodService({store,now:()=>1000,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>{await waiting;return {overall:feeling(),feelings:[]};}});
 const job=service.evaluate({scope,eventIds:['event-1']});await new Promise(resolve=>setImmediate(resolve));await store.mutate(state=>{state.lives.a.operationId='new-op';});release();await assert.rejects(job,{code:'SOCIAL_STALE_LIFE'});assert.equal(store.state.lives.a.r95?.mood,undefined);
});
test('R95 archive restores saved mood progress instead of decaying through archive storage',async()=>{
 const store=fixture(),service=createMoodService({store,now:()=>1000,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>({overall:feeling(),feelings:[]})});await service.evaluate({scope,eventIds:['event-1']});
 const archive=structuredClone(store.state.lives.a);rebaseMoodSnapshot(archive,1000000000,3601000);assert.equal(projectedMood(archive.r95.mood,1000000000).overall.intensity,.4);assert.equal(projectedMood(archive.r95.mood,1003600000).overall.intensity,.2);assert.equal(projectedMood(archive.r95.mood,999000000).overall.intensity,.4);
});
test('R95 all actual group participants receive one attention event; autonomous output does not count',async()=>{
 const store=fixture(),attention=createAttentionService({store,now:()=>500});const b={...scope,characterId:'b',lifeId:'life-b',operationId:'op-b'};
 await attention.record({eventId:'group-user-1',scope,participantScopes:[scope,b],kind:'chat'});await attention.record({eventId:'group-user-1',scope,participantScopes:[scope,b],kind:'chat'});
 assert.equal(Object.keys(store.state.lives.a.r95.attention.events).length,1);assert.equal(Object.keys(store.state.lives.b.r95.attention.events).length,1);
 assert.equal((await attention.record({eventId:'dream-1',scope,source:'model'})).recorded,false);
});
test('R95 busy and DND remain independent; attention does not imply the user is available',async()=>{
 const store=fixture();let at=1000;const attention=createAttentionService({store,now:()=>at});await attention.setAvailability({busyForMs:3600000,doNotDisturb:true});await attention.record({scope,eventId:'touch-1',kind:'touch'});assert.equal(attention.view({scope}).busy,true);assert.equal(attention.view({scope}).doNotDisturb,true);
 assert.equal((await attention.noteBusyQuestion({scope,eventId:'ask-1',text:'忙完了吗？'})).duplicate,undefined);assert.equal((await attention.noteBusyQuestion({scope,eventId:'ask-2',text:'忙完了吗？'})).duplicate,true);
 await attention.resolveBusy({scope,eventId:'ask-1',answer:'unknown'});assert.equal(attention.view({scope}).busy,true);await attention.resolveBusy({scope,eventId:'ask-1',answer:'finished'});assert.equal(attention.view({scope}).busy,false);assert.equal(attention.view({scope}).doNotDisturb,true);
});
test('R95 presentation waits for actual text and audio completion, not a fixed timer',()=>{
 const barrier=createPresentationState(),id=barrier.beginPresentation(scope,{hasAudio:true});assert.equal(barrier.snapshot(scope).canPresent,false);barrier.finishText(scope,id);assert.equal(barrier.snapshot(scope).canPresent,false);barrier.finishAudio(scope,id);assert.equal(barrier.snapshot(scope).canPresent,true);assert.equal(barrier.finishAudio(scope,id),false);
 const input=barrier.beginInput(scope);assert.equal(barrier.snapshot(scope).typing,true);barrier.endInput(scope,input);barrier.setAwaitingUser(scope,true);assert.equal(barrier.snapshot(scope).canPresent,false);
});
test('R95 scheduled mood review reuses real evidence only when the stored review time is due',async()=>{
 const store=fixture();let at=1000,calls=0;const service=createMoodService({store,now:()=>at,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>{calls++;return {overall:feeling(),feelings:[],nextReviewAt:at+1000};}});await service.evaluate({scope,eventIds:['event-1']});assert.equal((await service.evaluate({scope,eventIds:['event-1'],reason:'scheduled-review'})).reason,'review-not-due');assert.equal(calls,1);at=2000;await service.evaluate({scope,eventIds:['event-1'],reason:'scheduled-review'});assert.equal(calls,2);assert.equal(service.view({scope}).version,2);
});
test('R95 newer Persona evaluation retains but does not disclose previous private feelings',async()=>{
 const store=fixture();let at=1000;const service=createMoodService({store,now:()=>at,getEvidence:async({eventIds})=>eventIds.map(eventId=>({eventId})),generate:async({scope,events})=>({overall:feeling(events[0].eventId),feelings:[{...feeling(events[0].eventId),target:scope.personaId}]})});await service.evaluate({scope,eventIds:['event-1']});at+=3600000;const other={...scope,personaId:'q',conversationId:'conv-q'};await service.evaluate({scope:other,eventIds:['event-q']});const original=service.view({scope});assert.equal(original.feelings.length,1);assert.equal(original.feelings[0].target,'p');assert.equal(original.feelings[0].intensity,.4);assert.equal(store.state.lives.a.r95.mood.feelings.length,2);
});
test('R95 mood projections accept an epoch-zero anchor without resetting decay',()=>{const mood={anchorAt:0,overall:{...feeling(),anchorIntensity:.8},feelings:[]};assert.equal(projectedMood(mood,3600000).overall.intensity,.4);});
test('R95 model may choose no mood change without fabricating a feeling',async()=>{const store=fixture(),service=createMoodService({store,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>({changed:false})});assert.equal((await service.evaluate({scope,eventIds:['event-1']})).unchanged,true);assert.equal((await service.evaluate({scope,eventIds:['event-1']})).duplicate,true);assert.equal(service.view({scope}).available,false);});
test('R95 mood close is bounded and a late uncancellable model result cannot commit',async()=>{const store=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});const service=createMoodService({store,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>{await gate;return {overall:feeling(),feelings:[]};}});const job=service.evaluate({scope,eventIds:['event-1']});job.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));assert.equal((await service.close({timeoutMs:1})).settled,false);release();await assert.rejects(job,{code:'MOOD_CANCELLED'});assert.equal(store.state.lives.a.r95?.mood,undefined);assert.equal((await service.evaluate({scope,eventIds:['event-1']})).reason,'closing');});

test('R95 legacy mood reasons stay APP-private and unscoped reasons are hidden',async()=>{
 const store=fixture(),service=createMoodService({store,now:()=>1000,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>({overall:feeling(),feelings:[]})});
 await service.evaluate({scope,eventIds:['event-1']});
 assert.equal(service.view({scope:{...scope,channel:'app-private'}}).overall.summary,feeling().summary,'legacy app channel alias is preserved');
 await store.mutate(state=>{delete state.lives.a.r95.mood.overall.visibility.channel;});
 assert.equal(service.view({scope}).overall.summary,feeling().summary);
 assert.equal(service.view({scope:{...scope,channel:'qq-private'}}).overall.summary,'');
 assert.equal(service.view({scope:{...scope,channel:'app-private',conversationId:'different'}}).overall.summary,'');
 await store.mutate(state=>{delete state.lives.a.r95.mood.overall.visibility;});
 assert.equal(service.view({scope}).overall.summary,'');assert.equal(service.view({scope}).overall.label,'关心');await service.close();
});

test('R95 rebasing an already committed review preserves logical deduplication',async()=>{
 const store=fixture();let at=1000,calls=0;const service=createMoodService({store,now:()=>at,getEvidence:async()=>[{eventId:'event-1'}],generate:async()=>{calls++;return calls===1?{overall:feeling(),feelings:[],nextReviewAt:2000}:{changed:false};}});
 await service.evaluate({scope,eventIds:['event-1']});at=2000;await service.evaluate({scope,eventIds:['event-1'],reason:'scheduled-review'});assert.equal(calls,2);
 await store.mutate(state=>rebaseMoodSnapshot(state.lives.a,100000,3000));at=100000;
 assert.equal((await service.evaluate({scope,eventIds:['event-1'],reason:'scheduled-review'})).duplicate,true);assert.equal(calls,2);
 assert.equal(store.state.lives.a.r95.moodReviewEvaluations['1:2000'].status,'committed');await service.close();
});
