import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createCardGameService} from '../src/voice-games/game-service.mjs';
import {createGameEconomy} from '../src/voice-games/game-economy.mjs';
import * as rules from '../src/voice-games/rules/index.mjs';

async function setup(t,{missing=false}={}){
 const db=new DatabaseSync(':memory:');let wallet={balance:2000},sequence=0,requests=0,failure=null,personaId='persona',afterCommit=()=>{},beforeCommit=()=>{};
 const transaction=fn=>{const id='round2_'+sequence++;db.exec('SAVEPOINT '+id);let value;try{value=fn();beforeCommit(value);db.exec('RELEASE '+id);}catch(error){db.exec('ROLLBACK TO '+id);db.exec('RELEASE '+id);throw error;}afterCommit(value);return value;};
 const economy=createGameEconomy({db,transaction,wallet:()=>structuredClone(wallet),setWallet:value=>{wallet=value;},ledger:()=>{}});
 const profile={id:'fixture',kind:'openai',protocol:'openai',baseUrl:'http://fixture.invalid',model:'fixture-model',keyCiphertext:'before',enabled:true,capabilities:{chat:true}};
 const scope=characterId=>({characterId,personaId:'persona',lifeId:'life-'+characterId,operationId:'operation-'+characterId});
 const game={gameEconomy:economy,context:()=>({personaId,characterId:'a'}),hasCharacter:id=>id==='a',pluginScope:characterId=>scope(characterId),viewState:()=>({characters:[{id:'a',name:'A'}]}),gameContext:async()=>({modelBinding:null,character:{name:'A'}}),recordGameFact:async fact=>({recorded:true,eventId:fact.id})};
 const provider={enabled:true,state:{profiles:[profile]},captureConnection:()=>structuredClone(profile),runCaptured:async(_profile,fn)=>fn(),async *stream(){requests++;if(failure)throw failure;yield {type:'text-delta',text:'{"type":"fold","say":"","emotion":"neutral"}'};}};
 const service=createCardGameService({getGame:()=>game,getProvider:()=>provider});service.registerRuleArtifact({module:rules,sha256:'d03d283bdf6c748fcfbdcbcf4eca7f959ca29cbe4ebfbf87f3b53a51d94f16e4'});
 t.after(async()=>{afterCommit=()=>{};beforeCommit=()=>{};personaId='persona';await service.close();db.close();});
 let view;
 if(missing){assert.equal(service.describe().gamesReady,true);const created=economy.create({commandId:'legacy-create',tableId:'legacy-without-binding',type:'texas',players:[{id:'user',kind:'user',personaId:'persona'},{id:'ai-a',kind:'ai',...scope('a')}],buyIn:200});view=await service.invoke('games.table.read',{tableId:created.id});}
 else view=await service.invoke('games.table.create',{commandId:'create',type:'texas',players:[{kind:'user'},{kind:'ai',characterId:'a'}],buyIn:200});
 if(view.actorKind==='user')view=await service.invoke('games.table.action',{tableId:view.tableId,expectedVersion:view.version,commandId:'user-call',action:{type:'call'}});
 return {service,economy,profile,view,requests:()=>requests,setFailure:value=>{failure=value;},setPersona:value=>{personaId=value;},onCommit:fn=>{afterCommit=fn;},beforeCommit:fn=>{beforeCommit=fn;},request:(options={})=>service.invoke('games.model.request',{tableId:view.tableId,expectedVersion:view.version,requestId:'model-action'},options)};
}

test('a changed model binding returns the authorized paused recovery view without changing the hand or funds',async t=>{
 const f=await setup(t),before=f.economy.table(f.view.tableId),accounts=structuredClone(f.view.accounts);f.profile.keyCiphertext='after';
 const result=await f.request();assert.equal(result.status,'paused');assert.equal(result.version,f.view.version+1);assert.equal(result.bindingRecovery,true);
 assert.equal(result.model.status,'needs-retry');assert.equal(result.model.code,'GAME_BINDING_REVOKED');assert.equal(result.model.requestId,'model-action');
 assert.deepEqual(result.accounts,accounts);assert.deepEqual(f.economy.table(f.view.tableId).state,before.state);assert.deepEqual(result.history,f.view.history);assert.equal(f.requests(),0);
 const current=await f.service.invoke('games.table.read',{tableId:result.tableId});assert.deepEqual(result.projection,current.projection);assert.equal(current.modelStatus.code,'GAME_BINDING_REVOKED');
});

test('a legacy hand with a missing binding returns its current recovery view without a model submission',async t=>{
 const f=await setup(t,{missing:true}),before=f.economy.table(f.view.tableId),result=await f.request();
 assert.equal(result.status,'paused');assert.equal(result.bindingRecovery,true);assert.equal(result.model.status,'needs-retry');assert.equal(result.model.code,'GAME_BINDING_MISSING');
 assert.deepEqual(result.accounts,f.view.accounts);assert.deepEqual(f.economy.table(f.view.tableId).state,before.state);assert.equal(f.requests(),0);
});

test('ordinary model faults still reject rather than becoming a fulfilled recovery response',async t=>{
 const f=await setup(t);f.setFailure(Object.assign(Error('synthetic model connection failure'),{code:'NETWORK_CONNECT_FAILED'}));await assert.rejects(f.request(),{code:'NETWORK_CONNECT_FAILED'});
 const paused=await f.service.invoke('games.table.read',{tableId:f.view.tableId});assert.equal(paused.status,'paused');assert.equal(paused.bindingRecovery,false);assert.equal(paused.modelStatus.code,'NETWORK_CONNECT_FAILED');assert.deepEqual(paused.accounts,f.view.accounts);
});

test('cancelled requests and authorization failures keep their existing rejection boundary',async t=>{
 const f=await setup(t),controller=new AbortController();controller.abort(Object.assign(Error('cancelled'),{code:'GAME_MODEL_CANCELLED'}));await assert.rejects(f.request({signal:controller.signal}),{code:'GAME_MODEL_CANCELLED'});
 await assert.rejects(f.request({checkSync(){throw Object.assign(Error('authorization revoked'),{code:'GAME_AUTHORIZATION_DENIED'});}}),{code:'GAME_AUTHORIZATION_DENIED'});
 const current=await f.service.invoke('games.table.read',{tableId:f.view.tableId});assert.equal(current.status,'active');assert.equal(current.version,f.view.version);assert.deepEqual(current.accounts,f.view.accounts);assert.equal(f.requests(),0);
});

test('a binding fault cannot disclose the recovery view after current table authorization is revoked',async t=>{
 const f=await setup(t);f.profile.keyCiphertext='after';f.onCommit(value=>{if(value?.status==='paused')f.setPersona('foreign');});await assert.rejects(f.request(),{code:'GAME_PERSONA_DENIED'});
 f.onCommit(()=>{});f.setPersona('persona');const current=await f.service.invoke('games.table.read',{tableId:f.view.tableId});assert.equal(current.status,'paused');assert.deepEqual(current.accounts,f.view.accounts);
});

test('a failed pause transaction does not return a recovery view or change the hand',async t=>{
 const f=await setup(t),before=f.economy.table(f.view.tableId);f.profile.keyCiphertext='after';f.beforeCommit(value=>{if(value?.status==='paused')throw Object.assign(Error('synthetic commit failure'),{code:'SQL_COMMIT_FAILED'});});
 await assert.rejects(f.request(),{code:'SQL_COMMIT_FAILED'});assert.deepEqual(f.economy.table(f.view.tableId),before);assert.equal(f.requests(),0);
});

test('cancellation after the pause commit still rejects instead of returning a binding recovery view',async t=>{
 const f=await setup(t),controller=new AbortController();f.profile.keyCiphertext='after';f.onCommit(value=>{if(value?.status==='paused')controller.abort(Object.assign(Error('cancelled'),{code:'GAME_MODEL_CANCELLED'}));});
 await assert.rejects(f.request({signal:controller.signal}),{code:'GAME_MODEL_CANCELLED'});assert.equal(f.requests(),0);
});

test('a newer table state after the pause commit is never returned as this binding failure result',async t=>{
 const f=await setup(t);f.profile.keyCiphertext='after';f.onCommit(value=>{if(value?.status==='paused'){f.onCommit(()=>{});f.economy.control({tableId:value.id,expectedVersion:value.version,commandId:'concurrent-resume',op:'resume'});}});
 await assert.rejects(f.request(),{code:'GAME_BINDING_REVOKED'});const current=await f.service.invoke('games.table.read',{tableId:f.view.tableId});assert.equal(current.status,'active');assert.equal(current.version,f.view.version+2);assert.equal(f.requests(),0);
});
