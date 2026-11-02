import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLifeArchiveRepository,workEvidenceHash} from '../src/companion-life-archive.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {makeCard} from '../src/companion-store.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {createFeedingService} from '../src/companion-feeding.mjs';

const clone=value=>structuredClone(value);
function root(t){const value=mkdtempSync(join(tmpdir(),'buddy-r95-life-'));return value;}
function raw(){return {format:'ai-buddy-life-state',version:3,requiredCapabilities:['social-core-state-v1'],characterId:'a',savedAt:100,card:{id:'a',name:'A'},life:{id:'life-a',operationId:'old-op',mode:'normal'},relationships:{mode:'independent',byPersona:{}},personas:{default:{id:'default',name:'default'}},conversations:[],content:{},dependencies:[],coreState:{version:1,characterId:'a',lifeId:'life-a',feeding:{format:'ai-buddy-feeding-state',version:1,scope:{characterId:'a',personaId:'default',lifeId:'life-a',operationId:'old-op'},satiety:42,mealEvidence:[]}}};}
test('R95 life ZIP v3 preserves core facets, combines declared work and refuses account data',t=>{
 const dataRoot=root(t),repo=createLifeArchiveRepository({dataRoot,worker:false});t.after(()=>rmSync(dataRoot,{recursive:true,force:true}));
 const source=raw(),decoded=repo.decode(repo.prepare(source));assert.deepEqual(decoded.snapshot.coreState,source.coreState);assert.deepEqual(decoded.manifest.requiredCapabilities,['social-core-state-v1']);
 const work={version:1,characterId:'a',lifeId:'life-a',tasks:[{id:'task',scope:{characterId:'a',lifeId:'life-a',personaId:'default'},workspace:{id:'project',path:'E:/fixture-only'},events:[]}]};work.sha256=workEvidenceHash(work);source.workEvidence=work;source.requiredCapabilities.push('work-task-evidence-v1');assert.equal(repo.decode(repo.prepare(source)).snapshot.workEvidence.tasks[0].id,'task');
 source.coreState.wallet={balance:5};assert.throws(()=>repo.prepare(source),/钱包|本体状态|账户/);
});
test('R95 v3 unknown or missing capability is rejected; valid v1/v2 stay readable',t=>{
 const dataRoot=root(t),repo=createLifeArchiveRepository({dataRoot,worker:false});t.after(()=>rmSync(dataRoot,{recursive:true,force:true}));const source=raw();source.requiredCapabilities=['unknown'];assert.throws(()=>repo.prepare(source),/能力/);source.requiredCapabilities=[];assert.throws(()=>repo.prepare(source),/能力/);
 const old=raw();old.version=1;delete old.requiredCapabilities;delete old.coreState;assert.equal(repo.decode(repo.prepare(old)).snapshot.version,1);
 const work={version:1,characterId:'a',lifeId:'life-a',tasks:[]};work.sha256=workEvidenceHash(work);old.version=2;old.requiredCapabilities=['work-task-evidence-v1'];old.workEvidence=work;assert.equal(repo.decode(repo.prepare(old)).snapshot.version,2);
});

async function fixture(t,{core=true,failProjection=false,failFinalize=false,projectLife=null}={}){
 const dataRoot=root(t);let state={schema:2,cards:{a:makeCard({id:'a',name:'A'}),b:makeCard({id:'b',name:'B'})},personas:{default:{id:'default',name:'Default',relationships:{}}},relationships:{},conversations:{},groups:{},activeCharacterId:'a',activePersonaId:'default',lifeArchives:{},draftCards:{},accountLedger:{unchanged:99}};ensureLives(state,100);
 const store={get state(){return state;},snapshot:()=>clone(state),async mutate(fn){const next=clone(state);const result=await fn(next);state=next;return result;}},scope=()=>({characterId:'a',personaId:'default',lifeId:state.lives.a.id,operationId:state.lives.a.operationId});
 const feeding=createFeedingService({dataRoot,now:()=>1000,monotonicNow:()=>0,assertScope(value){if(value.lifeId!==state.lives[value.characterId]?.id||value.operationId!==state.lives[value.characterId]?.operationId)throw Error('旧人生');}});feeding.initializeRewards({facts:[],cursor:'init'});feeding.activeScope(scope());feeding.ingestUsageFact({canonicalRequestId:'fund',revision:1,totalTokens:100000},{trusted:true});await feeding.action('buy',{foodId:'rice',requestId:'before-rice'});
 let projectionFailures=Number.isInteger(failProjection)?failProjection:failProjection?1:0,finalizeFailures=failFinalize?1:0;const bridge={
  quiesce:value=>feeding.lifeBridge.quiesce(value),snapshot:value=>({version:1,characterId:value.characterId,lifeId:value.lifeId,feeding:feeding.lifeBridge.snapshot(value)}),validate:()=>true,
  initial:value=>({version:1,characterId:value.characterId,lifeId:value.lifeId,feeding:{format:'ai-buddy-feeding-state',version:1,scope:value,satiety:100,mealEvidence:[]}}),
  prepare:value=>feeding.lifeBridge.prepare({transactionId:value.transactionId,scope:value.beforeScope,target:{...value.coreState.feeding,scope:value.targetScope}}),apply:value=>feeding.lifeBridge.apply(value),
  finalize(value){if(finalizeFailures-->0)throw Error('finalize unavailable');return feeding.lifeBridge.finalize(value);},
  recover(value){if(feeding.lifeBridge.pending().some(row=>row.id===value.transactionId))return feeding.lifeBridge.recover(value);return {state:'not-prepared'};},activate:value=>{if(value.characterId===state.activeCharacterId)feeding.activeScope(value);},
 };
 if(projectLife)bridge.projectLife=projectLife;
 const options={store,dataRoot,coreStateBridge:core?bridge:null,call:async(action,args)=>{if(action==='companion-life-content')return {ok:true,content:{}};if(action==='companion-life-project'&&projectionFailures-->0)throw Error('projection unavailable');return {ok:true};},syncCard:async()=>{},projectPersona:async()=>{},enableGrowth:()=>{},now:()=>1000};
 const service=await createCompanionLives(options);t.after(async()=>{await feeding.close();rmSync(dataRoot,{recursive:true,force:true});});return {dataRoot,store,feeding,service,scope,options,restart:()=>createCompanionLives(options)};
}
test('R95 life reset archives role feeding; restore rebases it without wallet or stock rollback',async t=>{
 const f=await fixture(t),old=f.scope(),tx='lower';f.feeding.lifeBridge.prepare({transactionId:tx,scope:old,target:{scope:old,satiety:42}});f.feeding.lifeBridge.apply({transactionId:tx});f.feeding.lifeBridge.finalize({transactionId:tx});f.feeding.activeScope(old);
 const archive=await f.service.save('a');assert.equal(f.service.preview(archive.id).version,3);assert.equal(f.service.preview(archive.id).coreState.feeding.satiety,42);
 await f.service.reset('a');assert.notEqual(f.scope().lifeId,old.lifeId);assert.equal(f.feeding.view().hunger.satiety,100);await f.feeding.action('buy',{foodId:'biscuit',requestId:'new-life-buy'});const wallet=f.feeding.view().wallet.balance;
 await f.service.restore(archive.id);assert.equal(f.scope().lifeId,old.lifeId);assert.equal(f.feeding.view().hunger.satiety,42);assert.equal(f.feeding.view().wallet.balance,wallet);assert.equal(f.feeding.view().inventory.biscuit,3);assert.deepEqual(f.store.state.accountLedger,{unchanged:99});
});
test('R95 projection failure rolls back prepared core facet and rebinds a rotated original life',async t=>{
 const f=await fixture(t,{failProjection:true}),before=f.scope();await assert.rejects(f.service.reset('a'),/projection unavailable/);assert.equal(f.scope().lifeId,before.lifeId);assert.notEqual(f.scope().operationId,before.operationId);assert.equal(f.feeding.lifeBridge.pending().length,0);assert.equal(f.feeding.view().hunger.satiety,100);assert.equal(f.feeding.view().wallet.balance,8);
});
test('R95 failed core finalize leaves a published transaction for restart, never rolls current life back',async t=>{
 const f=await fixture(t,{failFinalize:true}),before=f.scope();await assert.rejects(f.service.reset('a'),/收尾|finalize/);assert.notEqual(f.scope().lifeId,before.lifeId);assert.equal(f.store.state.lifeTransaction.phase,'character-published');assert.equal(f.feeding.lifeBridge.pending().length,1);await f.restart();assert.equal(f.store.state.lifeTransaction,undefined);assert.equal(f.feeding.lifeBridge.pending().length,0);assert.equal(f.feeding.view().wallet.balance,8);
});
test('R95 optional core bridge remains compatible with original v1 behavior',async t=>{
 const f=await fixture(t,{core:false});const archive=await f.service.save('a');assert.equal(f.service.preview(archive.id).version,1);await f.service.reset('a');assert.equal(f.store.state.lifeTransaction,undefined);
});
test('R95 interrupted rollback resumes rollback after restart rather than republishing target',async t=>{
 const f=await fixture(t,{failProjection:2}),before=f.scope();await assert.rejects(f.service.reset('a'),/恢复待完成/);assert.equal(f.store.state.lifeTransaction.phase,'rolling-back');await f.restart();assert.equal(f.scope().lifeId,before.lifeId);assert.equal(f.store.state.lifeTransaction,undefined);assert.equal(f.store.state.lastLifeTransaction.status,'rolled-back');assert.equal(f.feeding.view().wallet.balance,8);
});
test('R95 original v2 archives whose body omitted capability array remain readable',t=>{
 const dataRoot=root(t),repo=createLifeArchiveRepository({dataRoot,worker:false});t.after(()=>rmSync(dataRoot,{recursive:true,force:true}));const source=raw();source.version=2;delete source.coreState;delete source.requiredCapabilities;const work={version:1,characterId:'a',lifeId:'life-a',tasks:[]};work.sha256=workEvidenceHash(work);source.workEvidence=work;assert.equal(repo.decode(repo.prepare(source)).snapshot.version,2);
});
test('R95 pure archived-time projection is persisted exactly once across finalize failure and restart',async t=>{
 let projections=0;const f=await fixture(t,{failFinalize:true,projectLife:({life,at})=>{projections++;return {...life,r95:{rebasedAt:at}};}});await assert.rejects(f.service.reset('a'),/收尾/);assert.equal(projections,1);assert.equal(f.store.state.lifeTransaction.coreLifeProjected,true);await f.restart();assert.equal(projections,1);assert.equal(f.store.state.lives.a.r95.rebasedAt,1000);
});
test('R95 a published new life cannot be rolled back or abandoned while core finalization is pending',async t=>{
 const f=await fixture(t,{failFinalize:true});await assert.rejects(f.service.reset('a'),/收尾/);const target=f.scope().lifeId;assert.equal(f.service.recovery().canRollback,false);await assert.rejects(f.service.recover('a','rollback'),/已经提交|已提交/);await assert.rejects(f.service.recover('a','abandon'),/已经提交|已提交/);assert.equal(f.scope().lifeId,target);await f.service.recover('a','retry');assert.equal(f.store.state.lifeTransaction,undefined);
});
test('R95 missing archive uses hashed prepared rollback content after the engine becomes available',async t=>{
 const f=await fixture(t,{failProjection:2}),before=f.scope();await assert.rejects(f.service.reset('a'),/恢复待完成/);for(const archive of Object.values(f.store.state.lifeArchives))rmSync(join(f.dataRoot,'galgame','life-archives',archive.fileName));assert.equal(f.service.recovery().archiveAvailable,false);assert.equal(f.service.recovery().rollbackContentAvailable,true);
 await f.service.recover('a','abandon');assert.equal(f.scope().lifeId,before.lifeId);assert.equal(f.store.state.lifeTransaction,undefined);assert.equal(f.store.state.lastLifeTransaction.status,'abandoned');assert.equal(f.feeding.view().wallet.balance,8);
});
test('R95 corrupted fallback rollback content cannot silently release the life lock',async t=>{
 const f=await fixture(t,{failProjection:2});await assert.rejects(f.service.reset('a'),/恢复待完成/);for(const archive of Object.values(f.store.state.lifeArchives))rmSync(join(f.dataRoot,'galgame','life-archives',archive.fileName));await f.store.mutate(state=>{state.lifeTransaction.rollbackContent={tampered:true};});await assert.rejects(f.service.recover('a','abandon'),/可校验回退内容/);assert.ok(f.store.state.lifeTransaction);assert.deepEqual(f.store.state.accountLedger,{unchanged:99});
});
