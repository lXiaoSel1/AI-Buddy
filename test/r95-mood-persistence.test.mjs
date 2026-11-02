import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createAttentionService} from '../src/companion-attention.mjs';
import {createMoodService} from '../src/companion-mood.mjs';
import {createProactiveService} from '../src/companion-proactive.mjs';
import {createAutoService} from '../src/companion-auto.mjs';

const scope={characterId:'a',lifeId:'life-a',operationId:'op-a',personaId:'default',channel:'app',conversationId:'conversation-a'};
test('R95 actual snapshot storage survives reopen: attention, mood, candidates and paused Auto stay idempotent',async()=>{
 const parent=resolve('../test-data');await mkdir(parent,{recursive:true});const profile=await mkdtemp(resolve(parent,'r95-mood-persistence-'));
 let store=await openCompanionStore(profile);await store.mutate(state=>{state.cards.a={id:'a',name:'Fixture'};state.lives={a:{id:'life-a',operationId:'op-a'}};state.groups.g={id:'g',personaId:'default',memberIds:['a'],messages:[]};state.r95={settings:{proactive:true,auto:true,selfTalk:false}};});
 let attention=createAttentionService({store,now:()=>1000});await attention.record({scope,eventId:'real-user-touch',kind:'touch'});
 let modelCalls=0,mood=createMoodService({store,now:()=>1000,getEvidence:async()=>[{eventId:'real-user-touch'}],generate:async()=>{modelCalls++;return {overall:{label:'开心',summary:'看到用户回来',intensity:.5,recoveryHalfLifeMs:3600000,eventIds:['real-user-touch']},feelings:[]};}});await mood.evaluate({scope,eventIds:['real-user-touch']});
 let proactive=createProactiveService({store,now:()=>1000,getActiveContext:()=>scope,getEvidence:async()=>[{eventId:'real-user-touch'}]});const first=await proactive.offer({scope,kind:'share',eventIds:['real-user-touch'],sourceKey:'attention-real-user-touch'});
 let auto=createAutoService({store,now:()=>1000,dispatchTurn:async()=>{}});await auto.start({groupId:'g',scope,authorizationId:'actual-app-start'});const turn=await auto.next({groupId:'g'});await auto.commitOpportunity({groupId:'g',requestId:turn.requestId,status:'presented',messageId:'actual-shown-message'});await store.flush();
 store=await openCompanionStore(profile);attention=createAttentionService({store,now:()=>2000});assert.equal((await attention.record({scope,eventId:'real-user-touch',kind:'touch'})).results[0].duplicate,true);
 mood=createMoodService({store,now:()=>2000,getEvidence:async()=>[{eventId:'real-user-touch'}],generate:async()=>{throw Error('must not repeat an old mood model call');}});assert.equal((await mood.evaluate({scope,eventIds:['real-user-touch']})).duplicate,true);assert.equal(modelCalls,1);
 proactive=createProactiveService({store,now:()=>2000,getActiveContext:()=>scope,getEvidence:async()=>[{eventId:'real-user-touch'}]});assert.equal((await proactive.offer({scope,kind:'share',eventIds:['real-user-touch'],sourceKey:'attention-real-user-touch'})).candidate.id,first.candidate.id);
 auto=createAutoService({store,now:()=>2000,dispatchTurn:async()=>{throw Error('must not auto-start after restart');}});await auto.recover();assert.equal(auto.view({groupId:'g'}).auto.status,'paused');assert.equal((await auto.commitOpportunity({groupId:'g',requestId:turn.requestId,status:'presented',messageId:'actual-shown-message'})).duplicate,true);await store.flush();
});
