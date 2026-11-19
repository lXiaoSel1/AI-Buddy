import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {createSnapshotStorage} from '../src/storage.mjs';
import {exportCompanionForRollback,openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
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
 await first.service.close();await first.store.close();
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
  await service.close();await store.close();
 }
});

test('retry, abandon and rollback resolve a failed replay',async t=>{
 const root=await failedSwitch(t,{keepArchive:false});
 let healthy=false;
 const {service,store,audit}=await launch(root,()=>{if(!healthy)throw Error('人生内容无效');return {ok:true};});
 await assert.rejects(service.action('companion-life-transaction-retry',{characterId:'claude'}),/人生内容无效/);
 assert.equal((await service.action('companion-state')).companion.lifeRecovery.attempts,2);
 // R95 has a second durable state projection. A failed engine call can fail
 // after mutating memory, so abandoning while it remains unavailable must not
 // claim the stores agree. Once healthy, the frozen rollback content is used.
 await assert.rejects(service.action('companion-life-transaction-abandon',{characterId:'claude'}),/人生内容无效/);
 assert.ok(store.state.lifeTransaction);
 healthy=true;
 await service.action('companion-life-transaction-abandon',{characterId:'claude'});
 assert.equal(store.state.lifeTransaction,undefined);assert.equal(store.state.lastLifeTransaction.status,'abandoned');
 assert.equal((await service.action('companion-state')).companion.lifeRecovery,null);
 await service.action('companion-growth-mode',{characterId:'claude',mode:'seed'});
 assert.ok(audit.some(entry=>entry.type==='life-transaction-abandon'));
 await service.close();await store.close();
 assert.equal(JSON.parse(readFileSync((await exportCompanionForRollback(root)).exportPath,'utf8')).lastLifeTransaction.status,'abandoned');

 const rollbackRoot=await failedSwitch(t,{keepArchive:true});
 const rolled=await launch(rollbackRoot,args=>{if(args.content?.reset)throw Error('人生内容无效');return {ok:true};});
 // R95 persisted rollback, so healthy startup completes that same direction.
 assert.equal((await rolled.service.action('companion-state')).companion.lifeRecovery,null);
 assert.equal(rolled.store.state.lifeTransaction,undefined);assert.equal(rolled.store.state.lastLifeTransaction.status,'rolled-back');
 await rolled.service.close();await rolled.store.close();
 assert.equal(JSON.parse(readFileSync((await exportCompanionForRollback(rollbackRoot)).exportPath,'utf8')).lastLifeTransaction.status,'rolled-back');

 const retryRoot=await failedSwitch(t,{keepArchive:false});
 healthy=false;let ok=false;
 const retried=await launch(retryRoot,()=>{if(!ok)throw Error('人生内容无效');return {ok:true};});
 ok=true;await retried.service.action('companion-life-transaction-retry',{characterId:'claude'});
 assert.equal(retried.store.state.lifeTransaction,undefined);assert.equal(retried.store.state.lastLifeTransaction.status,'rolled-back');
 await retried.service.close();await retried.store.close();
 assert.equal(JSON.parse(readFileSync((await exportCompanionForRollback(retryRoot)).exportPath,'utf8')).lastLifeTransaction.status,'rolled-back');
});

test('SQLite life save, reset and restore replace only owned records and export after restart',async t=>{
 const root=tmpDir('b06-life-partitions',{t}),seed=await companionFixture();
 const characterId='claude',lifeId=seed.lives.claude.id;
 const oldEvent={id:'old-event',at:1700000000000,text:'Old life event'};
 const newerEvent={id:'new-event',at:1700000000001,text:'New life event'};
 const otherEvent={id:'other-event',at:1700000000002,text:'Other life event'};
 const groupMessage={id:'group-message',seq:1,role:'assistant',characterId:'gpt',text:'Shared group message',createdAt:1700000000000};
 seed.lives.claude.personalEvents=[oldEvent];
 seed.conversations.empty={...seed.conversations.conversation,id:'empty',title:'Empty retained conversation',archived:true,messages:[]};
 seed.lives.claude.memory.notices={};
 seed.lives.claude.gameExperiences=null;
 seed.lives.gpt.personalEvents=[otherEvent];
 seed.groups.shared={id:'shared',name:'Shared',scene:'',background:'',personaId:'default',memberIds:['claude','gpt'],mutedIds:[],seq:1,intervals:{claude:[{start:1,end:null}],gpt:[{start:1,end:null}]},messages:[groupMessage]};
 seed.lives.claude.groupIntervals={shared:[{start:1,end:null}]};
 seed.lives.gpt.groupIntervals={shared:[{start:1,end:null}]};
 await createSnapshotStorage(join(root,'galgame','companion.json')).writeText(JSON.stringify(seed));
 const first=await launch(root,()=>({ok:true}));
 let archiveId,expectedGroup,expectedPrivate;
 const coreSnapshot=scope=>({version:1,characterId:scope.characterId,lifeId:scope.lifeId,feeding:{
  format:'ai-buddy-feeding-state',version:1,scope,satiety:100,mealEvidence:[]
 }});
 let failFinalize=true;
 const lifeOptions={
  dataRoot:root,call:async()=>({ok:true,content:{}}),syncCard:async()=>{},projectPersona:async()=>{},
  coreStateBridge:{quiesce(){},snapshot:coreSnapshot,validate:()=>true,initial:coreSnapshot,prepare(){},apply(){},
   finalize(){if(failFinalize)throw Error('Synthetic finalization interrupted');}}
 };
 try{
  archiveId=(await first.service.action('companion-life-save',{characterId})).archive.id;
  const original=await first.store.snapshotAsync();
  expectedGroup=original.groups.shared.messages;
  expectedPrivate=original.conversations.conversation.messages;
  const preview=(await first.service.action('companion-life-preview',{id:archiveId})).preview;
  assert.deepEqual(preview.conversations.find(row=>row.id==='conversation').messages,
   expectedPrivate.map(({id,role,text})=>({id,role,text})));
  await first.service.action('companion-life-reset',{characterId,mode:'normal'});
  const reset=await first.store.snapshotAsync();
  assert.notEqual(reset.lives.claude.id,lifeId);
  assert.deepEqual(reset.lives.claude.personalEvents,[],'The reset does not rehydrate the preceding life event');
  assert.equal(reset.lives.claude.gameExperiences,undefined);
  assert.deepEqual(reset.lives.gpt.personalEvents,[otherEvent]);
  assert.deepEqual(reset.groups.shared.messages,expectedGroup);
  await first.store.mutate((_state,tx)=>tx.records.put('life.personalEvents',characterId,newerEvent.id,newerEvent,{array:true,at:['lives',characterId,'personalEvents']}));
 }finally{await first.service.close();await first.store.close();}
 const interrupted=await openCompanionStore(root);
 try{
  const lives=await createCompanionLives({...lifeOptions,store:interrupted});
  await assert.rejects(lives.restore(archiveId),/Synthetic finalization interrupted/);
  assert.equal(lives.recovery().phase,'character-published');
  assert.equal(interrupted.state.lives.claude.personalEvents,undefined,'Growing live collections stay partitioned');
  assert.equal(interrupted.state.lives.claude.restoredGroupEvidence[0].messages,undefined,'Nested evidence stays partitioned');
  const pending=await interrupted.snapshotAsync();
  assert.deepEqual(pending.lifeTransaction.target.conversations.find(row=>row.id==='conversation').messages,expectedPrivate);
  assert.deepEqual(pending.lifeTransaction.target.groupEvidence[0].messages,expectedGroup);
 }finally{await interrupted.close();}
 failFinalize=false;
 const reopened=await openCompanionStore(root);
 try{
  const lives=await createCompanionLives({...lifeOptions,store:reopened});
  assert.equal(lives.recovery(),null,'Startup completed the published transaction');
  const restored=await reopened.snapshotAsync();
  assert.equal(restored.lives.claude.id,lifeId);
  assert.deepEqual(restored.lives.claude.personalEvents,[oldEvent]);
  assert.deepEqual(restored.lives.claude.memory.notices,{});
  assert.equal(restored.lives.claude.gameExperiences,null);
  assert.deepEqual(restored.lives.claude.restoredGroupEvidence[0].messages,expectedGroup);
  assert.deepEqual(restored.conversations.conversation.messages,expectedPrivate);
  assert.deepEqual(restored.groups.shared.messages,expectedGroup);
  assert.deepEqual(restored.groups.shared.intervals.gpt,[{start:1,end:null}]);
  assert.deepEqual(restored.lives.gpt.groupIntervals.shared,[{start:1,end:null}]);
  assert.deepEqual(restored.conversations.empty.messages,[]);
  assert.deepEqual(restored.lives.gpt.personalEvents,[otherEvent]);
  assert.equal(restored.lifeArchives[archiveId].lifeId,lifeId);
  assert.equal(restored.lifeTransaction,undefined);
 }finally{await reopened.close();}
 const rollback=await exportCompanionForRollback(root),exported=JSON.parse(readFileSync(rollback.exportPath,'utf8'));
 assert.deepEqual(exported.lives.claude.personalEvents,[oldEvent]);
 assert.deepEqual(exported.lives.claude.restoredGroupEvidence[0].messages,expectedGroup);
 assert.deepEqual(exported.conversations.conversation.messages,expectedPrivate);
 assert.equal(exported.lifeTransaction,undefined);
});
