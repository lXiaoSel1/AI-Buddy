import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {DatabaseSync} from 'node:sqlite';
import {createEconomyStore,feedingScope} from '../src/companion-economy-store.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';
import {makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {createEconomyStore as createWorkerEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {createSnapshotStorage} from '../src/storage.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {syntheticEngine,companionFixture} from './support/audit-harness.mjs';

const before={characterId:'a',personaId:'default',lifeId:'life-one',operationId:'old-generation'};
const after={...before,operationId:'rollback-generation'};
const at=Date.UTC(2026,10,15);
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'buddy-r21-life-'));
 const economy=createEconomyStore(root,{now:()=>at});
 t.after(async()=>{await economy.close();rmSync(root,{recursive:true,force:true});});
 return economy;
}

test('same-life rollback carries hunger, settled meals, archived evidence and blocked auto session',t=>{
 const economy=setup(t);
 economy.ensureScope(before);
 const other={...before,personaId:'other'},ancient={...before,operationId:'ancient-generation'};
 economy.prepareLife({transactionId:'prime',scope:before,target:{scope:before,satiety:20,mealEvidence:[
  {id:'archive-meal',scope:before,foodId:'rice',before:8,after:20,automatic:false},
  {id:'other-persona-meal',scope:other,foodId:'rice',before:8,after:20,automatic:false},
  {id:'ancient-meal',scope:ancient,foodId:'rice',before:8,after:20,automatic:false}
 ]}});
 economy.applyLife({transactionId:'prime'});economy.finalizeLife({transactionId:'prime'});
 economy.initializeRewards({facts:[],cursor:'test'});
 economy.ingestUsageFact({canonicalRequestId:'fund',revision:1,basis:'actual',origin:'native-ledger',usage:{total:500000}},{trusted:true});
 economy.purchase({scope:before,foodId:'rice',requestId:'provisions',packages:2});
 for(const mealId of ['settled-one','settled-two']){
  const consumed=economy.consume({scope:before,foodId:'rice',requestId:mealId});
  assert.equal(consumed.consumed,true);
  economy.updateMeal(mealId,{affectionState:'settled',attentionDone:true,experienceDone:true,attempts:1});
 }
 economy.saveAuto({id:'auto-blocked',scope:before,state:'blocked',at});
 const old=economy.snapshot(before);
 const result=economy.rebindPendingMeals({transactionId:'rollback',beforeScope:before,rollbackScope:after});
 const next=economy.snapshot(after);
 assert.equal(result.rebound,2);
 assert.equal(next.satiety,old.satiety);
 assert.deepEqual(next.mealEvidence.map(row=>row.id),old.mealEvidence.map(row=>row.id));
 assert.deepEqual(Object.fromEntries(next.mealEvidence.map(row=>[row.id,row.scope.operationId])),{'archive-meal':after.operationId,'other-persona-meal':after.operationId,'ancient-meal':ancient.operationId,'settled-one':after.operationId,'settled-two':after.operationId});
 assert.equal(next.mealEvidence.find(row=>row.id==='other-persona-meal').scope.personaId,'other');
 for(const mealId of ['settled-one','settled-two']){const previous=old.mealEvidence.find(row=>row.id===mealId);assert.deepEqual(economy.getMeal(mealId),{...previous,scope:{...previous.scope,operationId:after.operationId}});}
 assert.equal(economy.autoSession(after)?.state,'blocked');
 assert.equal(economy.autoSession(after)?.scope.operationId,after.operationId);
 assert.deepEqual(economy.rebindPendingMeals({transactionId:'rollback',beforeScope:before,rollbackScope:after}).meals,[]);
 assert.throws(()=>economy.rebindPendingMeals({transactionId:'rollback',beforeScope:before,rollbackScope:{...after,operationId:'different-rollback'}}),{code:'FEEDING_ROLLBACK_SCOPE_INVALID'});
});

test('ordinary tick keeps a blocked auto meal blocked after same-life rollback',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-r21-blocked-auto-'));
 const old={characterId:'a',personaId:'default',lifeId:'same-life',operationId:'before-rollback'},rolled={...old,operationId:'after-rollback'};
 const now=()=>Date.UTC(2026,10,15,12),economy=createEconomyStore(root,{now});
 let active=old,choices=0;
 const feeding=createFeedingService({store:economy,now,monotonicNow:()=>0,
  assertScope:scope=>scope.operationId===active.operationId,
  chooseFood:async()=>{choices++;if(choices===1)throw Error('one transient model failure');return 'noodles';}});
 t.after(async()=>{await feeding.close();rmSync(root,{recursive:true,force:true});});
 economy.ensureScope(old);
 economy.prepareLife({transactionId:'prime-blocked',scope:old,target:{scope:old,satiety:10,mealEvidence:[]}});
 economy.applyLife({transactionId:'prime-blocked'});economy.finalizeLife({transactionId:'prime-blocked'});
 economy.initializeRewards({facts:[],cursor:'fixture'});
 economy.ingestUsageFact({canonicalRequestId:'fund-blocked',revision:1,basis:'actual',origin:'native-ledger',usage:{total:500000}},{trusted:true});
 economy.purchase({scope:old,foodId:'noodles',requestId:'stock-blocked',packages:2});
 economy.settings({autoEat:true,autoBuyRice:false,allowedFoods:['noodles']});
 await feeding.activeScope(old);await feeding.tick();
 const first=economy.autoSession(old),inventory=economy.view().inventory;
 assert.equal(first.state,'blocked');assert.equal(choices,1);
 await feeding.tick();assert.equal(choices,1,'ordinary unchanged tick does not retry before rollback');
 await feeding.lifeBridge.quiesce(old);
 await feeding.lifeBridge.rebindRollback({transactionId:'rollback-blocked',beforeScope:old,rollbackScope:rolled});
 active=rolled;await feeding.activeScope(rolled);await feeding.tick();
 assert.equal(choices,1,'ordinary tick must not retry the blocked decision after rollback');
 assert.deepEqual(economy.view().inventory,inventory);
 assert.deepEqual(economy.snapshot(rolled).mealEvidence,[]);
 assert.equal(economy.autoSession(rolled)?.state,'blocked');
 assert.deepEqual(JSON.parse(economy.autoSession(rolled).blockFingerprint),{...JSON.parse(first.blockFingerprint),scope:{...JSON.parse(first.blockFingerprint).scope,operationId:rolled.operationId}});
});

test('rollback leaves malformed and unrelated auto fingerprints untouched',t=>{
 for(const fingerprint of ['{malformed',JSON.stringify({scope:{...before,operationId:'earlier-life-token'},settings:{autoEat:true},inventory:{noodles:2},balance:6,day:[2026,10,15]})]){
  const economy=setup(t);economy.ensureScope(before);
  economy.saveAuto({id:'legacy-blocked',scope:before,state:'blocked',blockFingerprint:fingerprint,at});
  economy.rebindPendingMeals({transactionId:'rollback-'+fingerprint.length,beforeScope:before,rollbackScope:after});
  assert.equal(economy.autoSession(after)?.blockFingerprint,fingerprint);
 }
});

test('worker termination inside rollback transaction leaves old projection intact and replays once',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-r21-worker-crash-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 let economy=createEconomyStore(root,{now:()=>at});
 economy.ensureScope(before);
 economy.prepareLife({transactionId:'prime-crash',scope:before,target:{scope:before,satiety:41,mealEvidence:[{id:'archived-crash',scope:before,foodId:'rice',before:20,after:41,automatic:false}]}});
 economy.applyLife({transactionId:'prime-crash'});economy.finalizeLife({transactionId:'prime-crash'});
 economy.saveAuto({id:'blocked-crash',scope:before,state:'blocked',at});
 const old=economy.snapshot(before);await economy.close();
 const barrier=new SharedArrayBuffer(4),worker=new Worker(new URL('./fixtures/r21-rollback-crash-worker.mjs',import.meta.url),{workerData:{root,before,after,barrier},execArgv:[]});
 t.after(()=>worker.terminate());
 const stage=await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>reject(Error('worker exited before transaction pause: '+code)));});
 assert.equal(stage,'paused-after-hunger-update');
 await worker.terminate();
 economy=createEconomyStore(root,{now:()=>at});
 assert.deepEqual(economy.snapshot(before).mealEvidence,old.mealEvidence);
 assert.equal(economy.snapshot(before).satiety,41);
 assert.equal(economy.autoSession(before)?.state,'blocked');
 assert.throws(()=>economy.snapshot(after),{code:'FEEDING_STALE_SCOPE'});
 economy.rebindPendingMeals({transactionId:'worker-crash-rollback',beforeScope:before,rollbackScope:after});
 const migrated=economy.snapshot(after);
 assert.equal(migrated.satiety,41);
 assert.equal(migrated.mealEvidence[0].scope.operationId,after.operationId);
 assert.equal(economy.autoSession(after)?.state,'blocked');
 assert.equal(economy.rebindPendingMeals({transactionId:'worker-crash-rollback',beforeScope:before,rollbackScope:after}).rebound,0);
 await economy.close();
});

test('rollback of a non-current character keeps two settled meals without activation',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-r21-non-current-'));
 const economy=createEconomyStore(root,{now:()=>at});
 t.after(async()=>{await economy.close();rmSync(root,{recursive:true,force:true});});
 let state={schema:2,cards:{a:makeCard({id:'a',name:'A'}),b:makeCard({id:'b',name:'B'})},personas:{default:{id:'default',name:'Default',relationships:{}}},relationships:{},conversations:{},groups:{},activeCharacterId:'b',activePersonaId:'default',lifeArchives:{},draftCards:{}};
 ensureLives(state,at);
 const store={get state(){return state;},snapshot:()=>structuredClone(state),async mutate(fn){const next=structuredClone(state),result=await fn(next);state=next;return result;}};
 const oldScope={characterId:'a',personaId:'default',lifeId:state.lives.a.id,operationId:state.lives.a.operationId};
 economy.ensureScope(oldScope);
 economy.prepareLife({transactionId:'prime-other',scope:oldScope,target:{scope:oldScope,satiety:20,mealEvidence:[]}});
 economy.applyLife({transactionId:'prime-other'});economy.finalizeLife({transactionId:'prime-other'});
 economy.initializeRewards({facts:[],cursor:'test'});
 economy.ingestUsageFact({canonicalRequestId:'fund-other',revision:1,basis:'actual',origin:'native-ledger',usage:{total:500000}},{trusted:true});
 economy.purchase({scope:oldScope,foodId:'rice',requestId:'provisions-other',packages:2});
 for(const mealId of ['other-settled-one','other-settled-two']){assert.equal(economy.consume({scope:oldScope,foodId:'rice',requestId:mealId}).consumed,true);economy.updateMeal(mealId,{affectionState:'settled',attentionDone:true,experienceDone:true,attempts:1});}
 const old=economy.snapshot(oldScope);let projectFailures=1,rebindFailures=1,activated=0;
 const feedingSnapshot=value=>economy.snapshot(value);
 const bridge={quiesce:async()=>{},snapshot:async value=>({version:1,characterId:value.characterId,lifeId:value.lifeId,feeding:feedingSnapshot(value)}),validate:()=>true,
  initial:value=>({version:1,characterId:value.characterId,lifeId:value.lifeId,feeding:{format:'ai-buddy-feeding-state',version:1,scope:value,satiety:100,mealEvidence:[]}}),
  prepare:value=>economy.prepareLife({transactionId:value.transactionId,scope:value.beforeScope,target:{...value.coreState.feeding,scope:value.targetScope}}),
  apply:value=>economy.applyLife(value),finalize:value=>economy.finalizeLife(value),
  recover:value=>economy.view().pendingLifeTransactions.some(row=>row.id===value.transactionId)?economy.recoverLife(value):{recovered:false},
  rebindRollback:value=>{if(rebindFailures-->0)throw Error('economy temporarily unavailable');return economy.rebindPendingMeals(value);},activate:async value=>{if(value.characterId==='a')activated++;}};
 const service=await createCompanionLives({store,dataRoot:root,coreStateBridge:bridge,call:async action=>{if(action==='companion-life-content')return {ok:true,content:{}};if(action==='companion-life-project'&&projectFailures-->0)throw Error('project failed');return {ok:true};},syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{},now:()=>at});
 await assert.rejects(service.reset('a'),/project failed/);
 assert.ok(state.pendingLifeRollbacks?.a);
 assert.deepEqual(await service.retryPendingRollbacks(),{a:true});
 const rolled={...oldScope,operationId:state.lives.a.operationId},next=economy.snapshot(rolled);
 assert.equal(state.activeCharacterId,'b');
 assert.equal(activated,0,'non-current rollback must not depend on feeding activation');
 assert.equal(next.satiety,old.satiety);
 assert.deepEqual(next.mealEvidence.map(row=>row.id),old.mealEvidence.map(row=>row.id));
 assert.deepEqual(next.mealEvidence.map(row=>row.scope.operationId),[rolled.operationId,rolled.operationId]);
});

async function lifeFixture(t,{recoverFails=0,rebindFails=0,projectFailures=1}={}){
 const root=mkdtempSync(join(tmpdir(),'buddy-r21-life-service-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 let state={schema:2,cards:{a:makeCard({id:'a',name:'A'})},personas:{default:{id:'default',name:'Default',relationships:{}}},relationships:{},conversations:{},groups:{},activeCharacterId:'a',activePersonaId:'default',lifeArchives:{},draftCards:{}};
 ensureLives(state,at);
 const original=structuredClone(state.lives.a);
 const store={get state(){return state;},snapshot:()=>structuredClone(state),async mutate(fn){const next=structuredClone(state);const result=await fn(next);state=next;return result;}};
 let unavailable=recoverFails,rebindingUnavailable=rebindFails;
 const scope=()=>({characterId:'a',personaId:'default',lifeId:state.lives.a.id,operationId:state.lives.a.operationId});
 const feedingSnapshot=value=>({format:'ai-buddy-feeding-state',version:1,scope:value,satiety:42,mealEvidence:[]});
 const bridge={quiesce:async()=>{},snapshot:async value=>({version:1,characterId:'a',lifeId:value.lifeId,feeding:feedingSnapshot(value)}),validate:()=>true,
  initial:value=>({version:1,characterId:'a',lifeId:value.lifeId,feeding:feedingSnapshot(value)}),prepare:async()=>{},apply:async()=>{},finalize:async()=>{},
  async recover(){if(unavailable-->0)throw Error('economy unavailable');return {recovered:false};},
  async rebindRollback(value){feedingScope(value.beforeScope);feedingScope(value.rollbackScope);if(rebindingUnavailable-->0)throw Error('economy unavailable');return {meals:[]};},activate:async()=>{}};
 const audits=[],options={store,dataRoot:root,coreStateBridge:bridge,call:async action=>{if(action==='companion-life-content')return {ok:true,content:{}};if(action==='companion-life-project'&&projectFailures-->0)throw Error('project failed');return {ok:true};},syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{},now:()=>at,audit:event=>audits.push(event)};
 const service=await createCompanionLives(options);
 return {root,audits,store,service,scope,original,restart:()=>createCompanionLives(options),recoverAvailable:()=>{unavailable=0;rebindingUnavailable=0;},projectAvailable:()=>{projectFailures=0;}};
}

test('economy recover outage leaves completed life rollback unlocked with a durable feeding fence',async t=>{
 const f=await lifeFixture(t,{recoverFails:1});
 await assert.rejects(f.service.reset('a'),/project failed/);
 assert.equal(f.store.state.lifeTransaction,undefined);
 assert.equal(f.store.state.lives.a.id,f.original.id);
 assert.ok(f.store.state.pendingLifeRollbacks?.a);
 f.recoverAvailable();await f.service.retryPendingRollbacks();
 assert.equal(f.store.state.pendingLifeRollbacks?.a,undefined);
});

for(const action of ['rollback','abandon','replay'])test('legacy missing beforeScope completes '+action+' from verified archive',async t=>{
 const f=await lifeFixture(t,{projectFailures:2});
 await assert.rejects(f.service.reset('a'),/恢复待完成/);
 await f.store.mutate(state=>{delete state.lifeTransaction.beforeScope;delete state.pendingLifeRollbacks;});
 f.projectAvailable();
 if(action==='replay')await f.restart();else await f.service.recover('a',action);
 assert.equal(f.store.state.lifeTransaction,undefined);
 assert.equal(f.store.state.lives.a.id,f.original.id);
});

test('verified rollback content without archive skips unknown beforeScope and records audit',async t=>{
 const f=await lifeFixture(t,{projectFailures:2});
 await assert.rejects(f.service.reset('a'),/恢复待完成/);
 const archiveId=f.store.state.lifeTransaction.archiveId;
 await f.store.mutate(state=>{delete state.lifeTransaction.beforeScope;delete state.pendingLifeRollbacks;});
 rmSync(join(f.root,'galgame','life-archives',archiveId+'.zip'));
 f.projectAvailable();await f.service.recover('a','rollback');
 assert.equal(f.store.state.lifeTransaction,undefined);
 assert.equal(f.store.state.pendingLifeRollbacks?.a,undefined);
 assert.ok(f.audits.some(row=>row.type==='life-rollback-rebind-skipped'&&row.reason==='verified-before-scope-unavailable'));
});

for(const failureStep of ['recover','rebind','activate'])test('persistent R95 host fences feeding after '+failureStep+' outage and resumes after restart',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-r21-persistent-pending-'));
 let live,blocked=false,projectFailures=1;
 const provider={enabled:true,currentSelection:()=>({provider:'fixture',model:'fixture'}),resolveContextCapacity:()=>({tokens:272000,source:'fixture',verified:true}),captureConnection:()=>({id:'fixture',model:'fixture',kind:'custom',contextTokens:272000}),runCaptured:(_profile,fn)=>fn(),runTurn:fn=>fn(),async *stream(options){yield {type:'text-delta',text:options.purpose==='meal'?'{"manualEquivalentAffection":1}':'{"changed":false}'};yield {type:'finish',reason:{kind:'stop'}};}};
 const launch=async()=>{
  const store=await openCompanionStore(root),economy=await createWorkerEconomyStore(root);
  const outage=()=>Promise.reject(Object.assign(Error('economy unavailable'),{code:'ECONOMY_WORKER_REOPEN'}));
  const feedingStore={...economy,
   recoverLife:value=>blocked&&failureStep==='recover'?outage():economy.recoverLife(value),
   rebindPendingMeals:value=>blocked&&failureStep==='rebind'?outage():economy.rebindPendingMeals(value),
   ensureScope:value=>blocked&&failureStep==='activate'?outage():economy.ensureScope(value)};
  const {engine}=syntheticEngine({getStore:()=>store,hooks:{call(action){if(action==='companion-life-project'&&projectFailures-->0)throw Error('project failed');}}});
  engine.flushSaves=async()=>{};
  const service=await createCompanionService({store,engine,provider,dataRoot:root,r95Options:{feedingStore,tickAllowed:()=>false}});
  return {store,economy,service,async close(){await service.close();await store.close();}};
 };
 t.after(async()=>{await live?.close();rmSync(root,{recursive:true,force:true});});
 await createSnapshotStorage(join(root,'galgame','companion.json')).writeText(JSON.stringify(await companionFixture({now:at})));
 live=await launch();
 const original=live.service.r95.activeScope();
 await live.service.r95.feeding.lifeBridge.prepare({transactionId:'prime-pending',scope:original,target:{scope:original,satiety:42,mealEvidence:failureStep==='rebind'?[{id:'archived-u2-meal',scope:original,foodId:'rice',before:20,after:42,automatic:false}]:[]}});
 await live.service.r95.feeding.lifeBridge.apply({transactionId:'prime-pending'});
 await live.service.r95.feeding.lifeBridge.finalize({transactionId:'prime-pending'});
 await live.service.r95.feeding.activeScope(original);
 let expectedSatiety=42;
 const pendingGameFact={id:'pending-game-fact',kind:'experience',scope:original,type:'texas',handId:'completed-before-rollback',completed:true};
 if(failureStep==='rebind'){
  const feeding=live.service.r95.feeding;
  await feeding.ingestUsageFact({canonicalRequestId:'fund-two-settled',revision:1,basis:'actual',origin:'native-ledger',usage:{total:500000}},{trusted:true});
  await feeding.action('buy',{foodId:'rice',requestId:'provisions-two-settled',packages:2});
  for(const requestId of ['settled-r21-one','settled-r21-two'])assert.equal((await feeding.action('feed',{foodId:'rice',requestId})).meal.affectionState,'settled');
  expectedSatiety=(await feeding.lifeBridge.snapshot(original)).satiety;
  await live.economy.saveAuto({id:'blocked-u2-session',scope:original,state:'blocked',at});
  // A completed hand leaves this durable fact for the game service to deliver.
  const db=new DatabaseSync(live.economy.path);
  try{db.prepare('INSERT INTO game_outbox(id,state,value,receipt) VALUES(?,?,?,NULL)').run(pendingGameFact.id,'pending',JSON.stringify(pendingGameFact));}finally{db.close();}
 }
 blocked=true;
 await assert.rejects(live.service.action('companion-life-reset',{characterId:original.characterId,mode:'blank'}),/project failed/);
 assert.equal(live.store.state.lifeTransaction,undefined);
 assert.ok(live.store.state.pendingLifeRollbacks?.[original.characterId]);
 const rolled={...original,operationId:live.store.state.lives[original.characterId].operationId};
 const conversation=live.store.state.conversations[live.store.state.activeConversationId];
 await live.service.action('companion-conversation-update',{id:conversation.id,title:'Usable during economy recovery'});
 assert.equal(live.store.state.conversations[conversation.id].title,'Usable during economy recovery');
 await assert.rejects(live.service.action('companion-life-save',{characterId:original.characterId}),{code:'FEEDING_ROLLBACK_PENDING'});
 assert.throws(()=>live.service.r95.feeding.lifeBridge.snapshot(rolled),{code:'FEEDING_ROLLBACK_PENDING'});
 await assert.rejects(live.service.r95.feeding.action('feed',{foodId:'rice',requestId:'fenced'}),{code:'FEEDING_ROLLBACK_PENDING'});
 if(failureStep==='recover'){
  blocked=false;await live.service.r95.bindActive();
  assert.equal(live.store.state.pendingLifeRollbacks?.[original.characterId],undefined);
  assert.ok((await live.service.r95.feeding.lifeBridge.snapshot(rolled)).satiety>41.9);
 }
 await live.close();live=null;blocked=false;
 live=await launch();
 assert.equal(live.store.state.lifeTransaction,undefined);
 assert.equal(live.store.state.pendingLifeRollbacks?.[original.characterId],undefined);
 const recovered=await live.service.r95.feeding.lifeBridge.snapshot(rolled);
 assert.ok(recovered.satiety>expectedSatiety-0.1&&recovered.satiety<=expectedSatiety);
 assert.equal(recovered.scope.operationId,rolled.operationId);
 if(failureStep==='rebind')for(const requestId of ['settled-r21-one','settled-r21-two']){
  assert.equal(live.economy.getMeal(requestId).affectionState,'settled');
  assert.equal(recovered.mealEvidence.find(row=>row.id===requestId)?.scope.operationId,rolled.operationId);
  assert.equal(live.store.records.get('life.r95.evidence',original.characterId,'feeding:'+requestId+':experience')?.scope.operationId,rolled.operationId);
 }
 if(failureStep==='rebind'){
  assert.equal(recovered.mealEvidence.find(row=>row.id==='archived-u2-meal')?.scope.operationId,rolled.operationId);
  assert.equal(live.economy.autoSession(rolled)?.state,'blocked');
 }
 await assert.rejects(live.economy.consume({scope:original,foodId:'rice',requestId:'stale-after-r21'}),{code:'FEEDING_STALE_SCOPE'});
 if(failureStep==='rebind'){
  assert.deepEqual(live.economy.games.outbox(),[pendingGameFact]);
  const receipt=await live.service.recordGameFact(pendingGameFact);
  assert.deepEqual(receipt.sourceScope,original);
  assert.deepEqual(receipt.effectiveScope,rolled);
  await live.economy.games.acknowledge(pendingGameFact.id,receipt);
  assert.deepEqual(live.economy.games.outbox(),[]);
 }
});
