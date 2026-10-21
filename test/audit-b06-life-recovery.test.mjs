import test from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createSnapshotStorage} from '../src/storage.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {tmpDir,syntheticEngine,companionFixture} from './support/audit-harness.mjs';

const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),runTurn:async fn=>fn(),resolveContextCapacity:()=>({tokens:8192,source:'fixture',verified:true})};
async function launch(root,project,audit=[]){
 const store=await openCompanionStore(root);
 const {engine}=syntheticEngine({getStore:()=>store,hooks:{call(action,args){if(action==='companion-life-project')return project(args);}}});
 const service=await createCompanionService({store,engine,provider,dataRoot:root,now:Date.now,audit:entry=>audit.push(entry)});
 return {service,store,audit};
}
async function failedSwitch(t,{keepArchive}){
 const root=tmpDir('b06',{t});
 await createSnapshotStorage(join(root,'galgame','companion.json')).writeText(JSON.stringify(await companionFixture()));
 const archives=join(root,'galgame','life-archives');
 const first=await launch(root,()=>{if(!keepArchive)for(const name of readdirSync(archives))rmSync(join(archives,name));throw Error('人生内容无效');});
 await assert.rejects(first.service.action('companion-life-reset',{characterId:'claude',mode:'blank'}),/人生切换失败，恢复待完成/);
 first.service.close();await first.store.flush();
 assert.ok(first.store.state.lifeTransaction);
 return root;
}

test('a replay that keeps failing starts the service, locks only that character and survives restarts',async t=>{
 const root=await failedSwitch(t,{keepArchive:false});
 for(const attempt of [1,2]){
  const {service,store,audit}=await launch(root,()=>{throw Error('人生内容无效');});
  const view=(await service.action('companion-state')).companion;
  assert.deepEqual([view.lifeRecovery.characterId,view.lifeRecovery.attempts,view.lifeRecovery.archiveAvailable],['claude',attempt,false]);
  assert.ok(audit.some(entry=>entry.type==='life-transaction-replay-failed'));
  await assert.rejects(service.action('companion-growth-mode',{characterId:'claude',mode:'seed'}),/人生切换没有完成/);
  await service.action('companion-character-select',{id:'gpt'});
  if(attempt===1)await service.action('companion-growth-mode',{characterId:'gpt',mode:'seed'});
  // The single transaction slot is still held, so another character's switch says what to do.
  await assert.rejects(service.action('companion-life-reset',{characterId:'gpt',mode:'blank'}),/另一个角色（claude）的人生切换还没有处理/);
  service.close();await store.flush();
 }
});

test('retry, abandon and rollback resolve a failed replay',async t=>{
 const root=await failedSwitch(t,{keepArchive:false});
 let healthy=false;
 const {service,store,audit}=await launch(root,()=>{if(!healthy)throw Error('人生内容无效');return {ok:true};});
 await assert.rejects(service.action('companion-life-transaction-retry',{characterId:'claude'}),/人生内容无效/);
 assert.equal((await service.action('companion-state')).companion.lifeRecovery.attempts,2);
 await service.action('companion-life-transaction-abandon',{characterId:'claude'});
 assert.equal(store.state.lifeTransaction,undefined);assert.equal(store.state.lastLifeTransaction.status,'abandoned');
 assert.equal((await service.action('companion-state')).companion.lifeRecovery,null);
 await service.action('companion-growth-mode',{characterId:'claude',mode:'seed'});
 assert.ok(audit.some(entry=>entry.type==='life-transaction-abandon'));
 service.close();await store.flush();

 const rollbackRoot=await failedSwitch(t,{keepArchive:true});
 const rolled=await launch(rollbackRoot,args=>{if(args.content?.reset)throw Error('人生内容无效');return {ok:true};});
 assert.equal((await rolled.service.action('companion-state')).companion.lifeRecovery.archiveAvailable,true);
 await rolled.service.action('companion-life-transaction-rollback',{characterId:'claude'});
 assert.equal(rolled.store.state.lifeTransaction,undefined);assert.equal(rolled.store.state.lastLifeTransaction.status,'rolled-back');
 rolled.service.close();

 const retryRoot=await failedSwitch(t,{keepArchive:false});
 healthy=false;let ok=false;
 const retried=await launch(retryRoot,()=>{if(!ok)throw Error('人生内容无效');return {ok:true};});
 ok=true;await retried.service.action('companion-life-transaction-retry',{characterId:'claude'});
 assert.equal(retried.store.state.lifeTransaction,undefined);assert.equal(retried.store.state.lastLifeTransaction.status,'committed');
 retried.service.close();
});
