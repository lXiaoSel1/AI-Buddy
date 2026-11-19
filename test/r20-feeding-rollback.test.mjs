import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {syntheticEngine,companionFixture} from './support/audit-harness.mjs';

const clone=value=>structuredClone(value);
async function fixture(t,{holdAck=false,failProject=true,failExperienceOnce=false}={}){
 const dataRoot=mkdtempSync(join(tmpdir(),'buddy-r20-rollback-'));
 let state={schema:2,cards:{a:makeCard({id:'a',name:'A'})},personas:{default:{id:'default',name:'Default',relationships:{}},other:{id:'other',name:'Other',relationships:{}}},relationships:{},conversations:{},groups:{},activeCharacterId:'a',activePersonaId:'default',lifeArchives:{},draftCards:{}};
 ensureLives(state,1000);
 const store={get state(){return state;},snapshot:()=>clone(state),async mutate(fn){const next=clone(state);const result=await fn(next);state=next;return result;}};
 const scope=(personaId='default')=>({characterId:'a',personaId,lifeId:state.lives.a.id,operationId:state.lives.a.operationId});
 const before=scope();let time=Date.UTC(2026,10,15);const now=()=>time,seen=[];
 const economy=await createEconomyStore(dataRoot,{now});
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),quiesceEntered=Promise.withResolvers(),stages=[];
 const writer={...economy,async consume(...args){const result=await economy.consume(...args);if(holdAck&&result.newlyConsumed&&result.meal.id==='held'){entered.resolve();await release.promise;}return result;}};
 let experienceFailures=failExperienceOnce?1:0;
 const settlement=kind=>async value=>{if(kind==='experience'&&experienceFailures-->0)throw Error('experience delayed');seen.push({kind,eventId:value.eventId,scope:value.scope});return {eventId:value.eventId};};
 const feeding=createFeedingService({store:writer,now,monotonicNow:()=>0,assertScope:value=>value.lifeId===state.lives[value.characterId]?.id&&value.operationId===state.lives[value.characterId]?.operationId,onAttention:settlement('attention'),onExperience:settlement('experience'),evaluateMeal:async()=>({manualEquivalentAffection:1}),settleAffection:settlement('relationship')});
 await feeding.initializeRewards({facts:[],cursor:'initial'});
 await feeding.activeScope(before);
 await feeding.ingestUsageFact({canonicalRequestId:'fund',revision:1,basis:'actual',origin:'native-ledger',usage:{total:500000}},{trusted:true});
 await feeding.action('buy',{foodId:'rice',requestId:'provisions',packages:3});
 await feeding.lifeBridge.prepare({transactionId:'prime-hunger',scope:before,target:{scope:before,satiety:42}});
 await feeding.lifeBridge.apply({transactionId:'prime-hunger'});
 await feeding.lifeBridge.finalize({transactionId:'prime-hunger'});
 await feeding.activeScope(before);
 let failures=failProject?1:0;
 const bridge={
  quiesce:value=>{const task=feeding.lifeBridge.quiesce(value);stages.push('quiesce');quiesceEntered.resolve();return task;},
  snapshot:async value=>({version:1,characterId:value.characterId,lifeId:value.lifeId,feeding:await feeding.lifeBridge.snapshot(value)}),
  validate:()=>true,
  initial:value=>({version:1,characterId:value.characterId,lifeId:value.lifeId,feeding:{format:'ai-buddy-feeding-state',version:1,scope:value,satiety:100,mealEvidence:[]}}),
  prepare:value=>{stages.push('prepare');return feeding.lifeBridge.prepare({transactionId:value.transactionId,scope:value.beforeScope,target:{...value.coreState.feeding,scope:value.targetScope}});},
  apply:value=>feeding.lifeBridge.apply(value),finalize:value=>feeding.lifeBridge.finalize(value),
  recover:value=>feeding.lifeBridge.pending().some(row=>row.id===value.transactionId)?feeding.lifeBridge.recover(value):{recovered:false,reason:'not-prepared'},
  rebindRollback:value=>feeding.lifeBridge.rebindRollback(value),
  activate:async value=>{if(value.characterId===state.activeCharacterId)await feeding.activeScope(value);}
 };
 const options={store,dataRoot,coreStateBridge:bridge,call:async(action)=>{if(action==='companion-life-content')return {ok:true,content:{}};if(action==='companion-life-project'){stages.push('project');if(failures-->0)throw Error('project failed');}return {ok:true};},syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{},now};
 const service=await createCompanionLives(options);
 t.after(async()=>{release.resolve();await feeding.close();rmSync(dataRoot,{recursive:true,force:true});});
 return {before,scope,store,economy,feeding,service,options,entered,release,quiesceEntered,stages,seen,advance:ms=>{time+=ms;}};
}
test('failed life change retains committed meal with withheld ACK and settles it once',async t=>{
 const f=await fixture(t,{holdAck:true});
 const eat=f.feeding.action('feed',{foodId:'rice',requestId:'held'});
 await Promise.race([f.entered.promise,eat]);
 assert.equal(f.economy.getMeal('held').attempts,0);
 const change=f.service.reset('a');
 await f.quiesceEntered.promise;
 assert.deepEqual(f.stages,['quiesce'],'complete/prepare and project cannot run before the held ACK is released');
 assert.equal(f.store.state.lifeTransaction,undefined,'reset is still waiting at quiesce');
 assert.deepEqual(f.seen,[],'quiesce must not settle the meal');
 f.release.resolve();
 await eat;
 await assert.rejects(change,/project failed/);
 assert.equal(f.scope().lifeId,f.before.lifeId);
 assert.notEqual(f.scope().operationId,f.before.operationId);
 await assert.rejects(f.economy.consume({scope:f.before,foodId:'rice',requestId:'stale-after-rollback'}),{code:'FEEDING_STALE_SCOPE'});
 await f.feeding.tick({auto:false});
 assert.equal(f.economy.getMeal('held').affectionState,'settled');
 assert.equal(f.economy.getMeal('held').attempts,1);
 assert.deepEqual(f.seen,['attention','experience','relationship'].map(kind=>({kind,eventId:'feeding:held:'+kind,scope:f.scope()})));
 await f.feeding.tick({auto:false});
 assert.equal(f.seen.length,3);
});
test('retry waiting and another persona meal retain their markers across rollback',async t=>{
 const f=await fixture(t,{failExperienceOnce:true});
 const first=await f.feeding.action('feed',{foodId:'rice',requestId:'retry'});
 assert.equal(first.meal.attempts,1);
 assert.equal(first.meal.affectionState,'pending');
 assert.equal(first.meal.attentionDone,true);
 const other={...f.before,personaId:'other'};
 const second=await f.economy.consume({scope:other,foodId:'rice',requestId:'other-persona'});
 assert.equal(second.newlyConsumed,true);
 await assert.rejects(f.service.reset('a'),/project failed/);
 const retry=f.economy.getMeal('retry'),otherMeal=f.economy.getMeal('other-persona');
 assert.equal(retry.attempts,1);assert.equal(retry.retryAt,first.meal.retryAt);
 assert.equal(retry.attentionDone,true);assert.equal(retry.scope.operationId,f.scope().operationId);
 assert.equal(otherMeal.scope.personaId,'other');assert.equal(otherMeal.scope.operationId,f.scope().operationId);
 const repeated=await f.economy.rebindPendingMeals({transactionId:f.store.state.lastLifeTransaction.id,beforeScope:f.before,rollbackScope:f.scope()});
 assert.equal(repeated.rebound,0);
 assert.deepEqual(repeated.meals.map(row=>[row.id,row.personaId]),[['retry','default'],['other-persona','other']]);
 await f.feeding.tick({auto:false});
 assert.equal(f.economy.getMeal('retry').affectionState,'pending','retryAt remains effective');
 f.advance(1000);await f.feeding.tick({auto:false});
 await f.feeding.activeScope(f.scope('other'));await f.feeding.tick({auto:false});
 assert.equal(f.economy.getMeal('retry').affectionState,'settled');
 assert.equal(f.economy.getMeal('other-persona').affectionState,'settled');
 assert.deepEqual(f.seen.map(row=>row.eventId),['feeding:retry:attention','feeding:retry:experience','feeding:retry:relationship','feeding:other-persona:attention','feeding:other-persona:experience','feeding:other-persona:relationship']);
 assert.equal(f.seen[3].scope.personaId,'other');
});
test('a successful new life cancels the former pending meal',async t=>{
 const f=await fixture(t,{failProject:false});
 const meal=await f.economy.consume({scope:f.before,foodId:'rice',requestId:'old-life'});
 assert.equal(meal.newlyConsumed,true);
 await f.service.reset('a');
 assert.notEqual(f.scope().lifeId,f.before.lifeId);
 assert.equal(f.economy.getMeal('old-life').affectionState,'cancelled');
 await f.feeding.tick({auto:false});assert.deepEqual(f.seen,[]);
});
test('reopened persistent host replays rollback before binding and keeps one committed R95 experience',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-r20-persistent-'));let time=Date.UTC(2026,10,15),live;
 const now=()=>time;
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),resolveContextCapacity:()=>({tokens:272000,source:'fixture',verified:true}),captureConnection:()=>({id:'fixture',model:'fixture',kind:'custom',contextTokens:272000}),runCaptured:(_profile,fn)=>fn(),runTurn:fn=>fn(),
  async *stream(options){yield {type:'text-delta',text:options.purpose==='meal'?'{"manualEquivalentAffection":1}':'{"changed":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const launch=async({failMarker=false,failPrepare=false,failRollbackProject=false}={})=>{
  const store=await openCompanionStore(root),economy=await createEconomyStore(root,{now});
  let markerFailures=failMarker?1:0,prepareFailures=0,projectFailures=failRollbackProject?1:0;
  const feedingStore={...economy,
   updateMeal:(id,patch,...rest)=>{if(patch.experienceDone===true&&markerFailures-->0)throw Error('experience marker ACK lost');return economy.updateMeal(id,patch,...rest);},
   prepareLife:(value,...rest)=>{if(prepareFailures-->0)throw Error('prepare unavailable');return economy.prepareLife(value,...rest);}};
  const {engine}=syntheticEngine({getStore:()=>store,hooks:{call(action){if(action==='companion-life-project'&&projectFailures-->0)throw Error('rollback projection unavailable');}}});
  const service=await createCompanionService({store,engine,provider,dataRoot:root,now,r95Options:{feedingStore,tickAllowed:()=>false}});
  return {store,economy,service,armPrepare(){prepareFailures=failPrepare?1:0;},async close(){await service.close();await store.close();}};
 };
 t.after(async()=>{await live?.close();rmSync(root,{recursive:true,force:true});});
 await createSnapshotStorage(join(root,'galgame','companion.json')).writeText(JSON.stringify(await companionFixture({now:time})));
 live=await launch({failMarker:true,failPrepare:true,failRollbackProject:true});
 const original=live.service.r95.activeScope(),feeding=live.service.r95.feeding;
 await feeding.lifeBridge.prepare({transactionId:'prime-persistent-hunger',scope:original,target:{scope:original,satiety:42}});
 await feeding.lifeBridge.apply({transactionId:'prime-persistent-hunger'});
 await feeding.lifeBridge.finalize({transactionId:'prime-persistent-hunger'});
 await feeding.activeScope(original);
 await feeding.ingestUsageFact({canonicalRequestId:'fund-persistent',revision:1,basis:'actual',origin:'native-ledger',usage:{total:500000}},{trusted:true});
 await feeding.action('buy',{foodId:'rice',requestId:'persistent-provisions'});
 const first=await feeding.action('feed',{foodId:'rice',requestId:'persistent-meal'});
 assert.equal(first.meal.affectionState,'pending');assert.equal(first.meal.attempts,1);
 assert.equal(first.meal.experienceDone,false);
 assert.ok(live.store.records.get('life.r95.evidence',original.characterId,'feeding:persistent-meal:experience'));
 live.armPrepare();
 await assert.rejects(live.service.action('companion-life-reset',{characterId:original.characterId,mode:'blank'}),/恢复待完成/);
 const rollbackToken=live.store.state.lifeTransaction.rollbackOperationId;
 assert.equal(live.store.state.lifeTransaction.phase,'rolling-back');assert.ok(rollbackToken);
 assert.equal(live.economy.view().pendingLifeTransactions.length,0,'complete failed before economy.prepare');
 await live.close();live=null;
 time+=2000;
 live=await launch();
 assert.equal(live.store.state.lifeTransaction,undefined);
 assert.equal(live.store.state.lives[original.characterId].operationId,rollbackToken);
 await live.close();live=null;
 live=await launch();
 assert.equal(live.store.state.lifeTransaction,undefined);
 assert.equal(live.store.state.lives[original.characterId].operationId,rollbackToken);
 await assert.rejects(live.service.r95.feeding.lifeBridge.snapshot(original),/旧人生|代次|失效/);
 await live.service.r95.feeding.tick({auto:false});
 const settled=live.economy.getMeal('persistent-meal');
 assert.equal(settled.affectionState,'settled',settled.error);
 assert.equal(settled.experienceDone,true);
 const relation=live.store.records.get('root.events','','feeding:persistent-meal:relationship');assert.ok(relation);
 const experience=live.store.records.get('life.r95.evidence',original.characterId,'feeding:persistent-meal:experience');
 assert.equal(experience.scope.operationId,rollbackToken);
 await live.service.r95.feeding.tick({auto:false});
 assert.equal(live.economy.getMeal('persistent-meal').attempts,2);
 assert.deepEqual(live.store.records.get('root.events','','feeding:persistent-meal:relationship'),relation);
 assert.deepEqual(live.store.records.get('life.r95.evidence',original.characterId,'feeding:persistent-meal:experience'),experience);
});
