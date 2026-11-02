import test from 'node:test';
import assert from 'node:assert/strict';
import {PetActivityClock} from '../src/pet-interactions.mjs';
import {createActivityOriginRegistry} from '../src/activity-origin.mjs';

test('R95 sleep-preserving request does not wake a sleeping pet',()=>{
 let at=0;const clock=new PetActivityClock({now:()=>at,durations:{enter:1},resolveOrigin:id=>id==='dream'?{kind:'dream',sleepPolicy:'preserve',sleepIntentGeneration:0}:null});
 at=300000;clock.tick();at++;clock.tick();assert.equal(clock.phase,'asleep');
 clock.request('dream-1',true,{originId:'dream'});assert.equal(clock.phase,'asleep');
 clock.request('dream-1',false,{originId:'dream'});assert.equal(clock.phase,'asleep');
});
test('R95 ordinary work concurrent with a dream still wakes immediately',()=>{
 let at=0;const clock=new PetActivityClock({now:()=>at,durations:{enter:1},resolveOrigin:id=>id==='dream'?{kind:'dream',sleepPolicy:'preserve',sleepIntentGeneration:0}:null});
 at=300001;clock.tick();at++;clock.tick();clock.request('dream',true,{originId:'dream'});assert.equal(clock.phase,'asleep');
 clock.request('real-work',true);assert.equal(clock.phase,'waking');assert.equal(clock.busy.has('real-work'),true);
});
const scope={characterId:'a',personaId:'p',lifeId:'life-a',operationId:'op-a',channel:'app',conversationId:'conv'};
test('R95 activity registry authenticates its summary and deduplicates canonical cumulative corrections',()=>{
 const registry=createActivityOriginRegistry(),id=registry.issue({scope,kind:'dream',sleepIntentGeneration:0});assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:100,live:true}).added,100);
 assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:100,live:true}).added,0);assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:90,live:true}).added,0);assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:95,live:true}).added,0);
 const summary=registry.summary();assert.equal(summary.sleepPreservingTokens,100);assert.equal(registry.verifySummary(summary).wakeTokens,0);assert.equal(registry.verifySummary({...summary,wakeTokens:1}),null);assert.equal(registry.recordUsage({originId:id,requestKey:'r2',totalTokens:10000,live:false}).added,0);
});
test('R95 signed aggregate preserves dream sleep while an unrelated simultaneous real task still wakes',()=>{
 let at=0;const registry=createActivityOriginRegistry(),clock=new PetActivityClock({now:()=>at,durations:{enter:1},resolveOrigin:registry.resolve,verifyActivitySummary:registry.verifySummary});clock.observeExternal({activitySummary:registry.summary(),workSinceStart:0});at=300000;clock.tick();at++;clock.tick();const dream=registry.issue({scope,kind:'dream',sleepIntentGeneration:clock.sleepIntentVersion});registry.recordUsage({originId:dream,requestKey:'dream',totalTokens:400,live:true});clock.observeExternal({activitySummary:registry.summary(),workSinceStart:400});assert.equal(clock.phase,'asleep');
 registry.recordUsage({requestKey:'external-work',totalTokens:100,live:true});clock.observeExternal({activitySummary:registry.summary(),workSinceStart:500});assert.equal(clock.phase,'waking');
});
test('R95 temporary feeding returns to sleep only when the original sleep intention is unchanged',()=>{
 let at=0;const registry=createActivityOriginRegistry(),clock=new PetActivityClock({now:()=>at,durations:{enter:1,wake:1},resolveOrigin:registry.resolve});at=300000;clock.tick();at++;clock.tick();const feeding=registry.issue({scope,kind:'feeding-temporary',sleepIntentGeneration:clock.sleepIntentVersion});assert.equal(clock.beginTemporaryWake(feeding),true);clock.request('eating',true,{originId:feeding});at++;clock.tick();assert.equal(clock.phase,'awake');clock.request('eating',false,{originId:feeding});assert.equal(clock.endTemporaryWake(feeding),true);assert.equal(clock.phase,'sleep-enter');
 at++;clock.tick();const again=registry.issue({scope,kind:'feeding-temporary',sleepIntentGeneration:clock.sleepIntentVersion});clock.beginTemporaryWake(again);clock.wake('touch');assert.equal(clock.endTemporaryWake(again),false);assert.equal(clock.phase,'waking');
});
test('R95 forged sleep policy and cross-Persona inherited origins cannot conceal real activity',()=>{
 const registry=createActivityOriginRegistry(),id=registry.issue({scope,kind:'dream',sleepIntentGeneration:0});assert.throws(()=>registry.issue({scope:{...scope,personaId:'other'},kind:'search',parentOriginId:id}),{code:'ACTIVITY_ORIGIN_INVALID'});
 let at=0;const clock=new PetActivityClock({now:()=>at,durations:{enter:1},resolveOrigin:registry.resolve});at=300000;clock.tick();at++;clock.tick();clock.activity('token',{originId:'forged',sleepPolicy:'preserve'});assert.equal(clock.phase,'waking');
});
test('R95 revoked life activity cannot refresh sleep or double-consume increment samples',()=>{
 const registry=createActivityOriginRegistry(),id=registry.issue({scope,kind:'dream',sleepIntentGeneration:0});assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:50,cumulative:false,sampleId:'chunk-1',live:true}).added,50);assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:50,cumulative:false,sampleId:'chunk-1',live:true}).added,0);registry.revokeScope(scope);assert.equal(registry.resolve(id),null);assert.equal(registry.recordUsage({originId:id,requestKey:'r',totalTokens:80,live:true}).added,0);
});
