import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync,existsSync,cpSync,mkdirSync,writeFileSync,rmSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {dirname,join,resolve,sep} from 'node:path';
import {exportCompanionForRollback,openCompanionStore} from '../src/companion-store.mjs';
import {readCompanionSqliteSnapshot} from '../src/companion-sqlite.mjs';
import {materializeCompanionData} from '../src/companion-partitions.mjs';
import {closeAppServices,closePluginServices,recoverAppShutdown,shutdownFailureDetail} from '../src/plugin-shutdown.mjs';
import {createNativeGlobalStorage,createNativeWorkspaceStorage} from '../src/adapted/game-core.ts';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
const ownedRoots=[];
const temp=()=>{const root=mkdtempSync(join(tmpdir(),'buddy-r14-lifecycle-'));ownedRoots.push(root);return root;};
function ownedTest(name,fn){test(name,async t=>{const before=ownedRoots.length;await fn(t);for(const root of ownedRoots.slice(before)){assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep+'buddy-r14-lifecycle-'));rmSync(root,{recursive:true,force:true});}});}
const companionDatabase=root=>join(root,'galgame/companion.sqlite');
const readCompanion=root=>materializeCompanionData(readCompanionSqliteSnapshot(companionDatabase(root)));
const commits=path=>existsSync(path+'.snapshots/commits.jsonl')?readFileSync(path+'.snapshots/commits.jsonl','utf8').trim().split(/\r?\n/).filter(Boolean).length:0;

ownedTest('companion commits immediately in WAL while keeping snapshots and no-op revisions stable',async()=>{
 const root=temp(),path=join(root,'galgame/companion.json'),store=await openCompanionStore(root);
 try{
  const before=commits(path),old=store.snapshot(),revision=store.state.revision;
  await store.mutate(state=>{state.settings.allowUserMessageEdit=true;});
  assert.equal(store.state.settings.allowUserMessageEdit,true);
  assert.equal(old.settings.allowUserMessageEdit,false);
  assert.equal(store.state.revision,revision+1);
  assert.equal(readCompanion(root).settings.allowUserMessageEdit,true,'readers see the committed change before checkpoint');
  await store.mutate(()=>{});
  assert.equal(store.state.revision,revision+1);
  assert.equal(readCompanion(root).revision,revision+1);
  assert.equal(commits(path),before,'ordinary mutation leaves the legacy fence in place');
  await store.flush();
  await store.flush();
  assert.equal(commits(path),before,'checkpoint does not publish another legacy snapshot');
  assert.equal(readCompanion(root).settings.allowUserMessageEdit,true);
 }finally{await store.close();}
});

ownedTest('native global defers writes while the workspace fallback remains immediate',async()=>{
 const root=temp(),path=join(root,'global.json'),global=createNativeGlobalStorage(path);
 await global.writeText('{"saved":1}');assert.equal(await global.readText(),'{"saved":1}');assert.equal(commits(path),0);
 await global.flush();assert.equal(commits(path),1);
 const workspace=createNativeWorkspaceStorage(root);await workspace.writeText('{"workspace":1}');
 assert.equal(commits(join(root,'.whale-girl-save.json')),1);
});

import vm from 'node:vm';
import {createGalgame} from '../src/galgame-host.mjs';
import {createDeferredSaves,deferredSaves} from '../src/deferred-saves.mjs';
import {createDataImportService,inspectSnapshot,importInventory} from '../src/data-import.mjs';
const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'}),listProviders:()=>[],listModels:()=>[]};
const globalPath=root=>join(root,'galgame/storages/dsh-whale-galgame/global.json');
const companionPath=root=>join(root,'galgame/companion.json');
const until=async fn=>{for(let i=0;i<1000;i++){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,5));}throw Error('fixture timeout');};

test('companion does not initialize a default save when its committed snapshot fails verification',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-companion-recovery-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const path=companionPath(root),store=await openCompanionStore(root);
 try{await store.mutate(state=>{state.settings.allowUserMessageEdit=true;});}
 finally{await store.close();}
 const journal=join(path+'.snapshots','commits.jsonl'),before=readFileSync(journal);
 const {file}=JSON.parse(before.toString().trim());
 const snapshot=join(path+'.snapshots',file);
 writeFileSync(snapshot,'damaged companion snapshot');
 await assert.rejects(async()=>{const reopened=await openCompanionStore(root);await reopened.flush();},{code:'SNAPSHOT_RECOVERY_REQUIRED'});
 assert.deepEqual(readFileSync(journal),before);
 assert.equal(readFileSync(snapshot,'utf8'),'damaged companion snapshot');
 assert.equal(readdirSync(path+'.snapshots').length,2);
});

test('Galgame does not create a replacement global save when the journal is missing but snapshots remain',async t=>{
 const root=mkdtempSync(join(tmpdir(),'buddy-global-recovery-'));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const make=()=>createGalgame({dataRoot:root,provider,model:'fixture',deferredSaveRegistry:createDeferredSaves()});
 const game=await make();
 await game.action('pet-set',{enabled:false});
 await game.close();
 const directory=globalPath(root)+'.snapshots',journal=join(directory,'commits.jsonl');
 const backup=join(root,'held-global-journal');
 renameSync(journal,backup);
 const before=readdirSync(directory);
 assert.ok(before.length);
 await assert.rejects(async()=>{const reopened=await make();await reopened.close();},error=>error.cause?.code==='SNAPSHOT_RECOVERY_REQUIRED');
 assert.deepEqual(readdirSync(directory),before);
 renameSync(backup,journal);
 const reopened=await make();
 try{assert.equal((await reopened.action('settings-get')).petEnabled,false);}finally{await reopened.close();}
});

test('Galgame reads original values from valid legacy JSON when no snapshot history exists',async t=>{
 const source=mkdtempSync(join(tmpdir(),'buddy-legacy-save-source-'));
 const target=mkdtempSync(join(tmpdir(),'buddy-legacy-save-target-'));
 t.after(()=>{rmSync(source,{recursive:true,force:true});rmSync(target,{recursive:true,force:true});});
 const make=dataRoot=>createGalgame({dataRoot,provider,model:'fixture',deferredSaveRegistry:createDeferredSaves()});
 const initial=await make(source);
 try{
  await initial.action('pet-set',{enabled:false});
  await initial.action('companion-character-save',{id:'deepseek',name:'Legacy save fixture'});
 }finally{await initial.close();}
 // Produce the complete legacy document, not the SQLite writer fence.
 await assert.doesNotReject(exportCompanionForRollback(source),'A closed legacy export keeps empty conversation owners');
 const saved=[companionPath,globalPath];
 const original=await Promise.all(saved.map(path=>createSnapshotStorage(path(source)).readText()));
 for(const [index,path] of saved.entries()){
  const file=path(target);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,original[index]);
 }
 const game=await make(target);
 try{
  assert.equal((await game.action('settings-get')).petEnabled,false);
  assert.equal(readCompanion(target).cards.deepseek.name,'Legacy save fixture');
 }finally{await game.close();}
 const dir=dirname(companionPath(target));
 const preserved=readdirSync(dir).filter(name=>name.startsWith('companion.pre-sqlite-'));
 assert.equal(preserved.length,1);
 assert.equal(readFileSync(join(dir,preserved[0]),'utf8'),original[0]);
 assert.equal(readFileSync(globalPath(target),'utf8'),original[1]);
});

ownedTest('close persists both archives, releases registration and a later close adds no snapshot',async()=>{
 const root=temp(),registry=createDeferredSaves(),make=()=>createGalgame({dataRoot:root,provider,model:'fixture',deferredSaveRegistry:registry});
 const game=await make(),before=commits(companionPath(root));
 try{
  await game.action('companion-character-save',{id:'deepseek',name:'R14 close fixture'});
  assert.equal(commits(companionPath(root)),before);
  assert.equal(commits(globalPath(root)),0);
 }finally{await game.close();}
 assert.equal(readCompanion(root).cards.deepseek.name,'R14 close fixture');
 const counts=[commits(companionPath(root)),commits(globalPath(root))],revision=readCompanion(root).revision;
 await game.close();
 assert.deepEqual([commits(companionPath(root)),commits(globalPath(root))],counts);
 assert.equal(readCompanion(root).revision,revision);
 const reopened=await make();
 try{assert.equal(readCompanion(root).cards.deepseek.name,'R14 close fixture');}
 finally{await reopened.close();}
});

ownedTest('an engine ACK cannot reach disk before its companion event, including a crash between the two writes',async()=>{
 const root=temp(),initial=await createGalgame({dataRoot:root,provider,model:'fixture'});await initial.close();
 const disk=createSnapshotStorage(globalPath(root)),saved=await readJson(disk),event={eventId:'skit:r14-durable-event',characterId:'deepseek',personaId:'default',source:'skit',at:Date.now(),level:1,affection:2,delivered:false};
 saved.characters.deepseek.affection=2;saved.characters.deepseek.companionEvents={[event.eventId]:event};await disk.writeText(JSON.stringify(saved));
 const registry=createDeferredSaves(),mirror=temp();let crash=true;
 const register=registry.register.bind(registry);registry.register=(kind,options)=>register(kind,{...options,flushSync(){const result=options.flushSync();if(kind==='companion'&&crash){cpSync(root,mirror,{recursive:true});throw Error('SIMULATED_POWER_LOSS');}return result;}});
 const game=await createGalgame({dataRoot:root,provider,model:'fixture',deferredSaveRegistry:registry});
 try{
  await game.action('view');await assert.rejects(game.flushSaves(),/SIMULATED_POWER_LOSS/);
  const companion=readCompanion(mirror),engine=await inspectSnapshot(globalPath(mirror));
  assert.equal(companion.events[event.eventId].affection,2);assert.equal(engine.characters.deepseek.companionEvents[event.eventId].delivered,false);
  const reopened=await createGalgame({dataRoot:mirror,provider,model:'fixture'});try{await reopened.action('view');await reopened.close();const recovered=readCompanion(mirror);assert.equal(recovered.relationships.deepseek.byPersona.default.affection,2);assert.equal(Object.keys(recovered.events).filter(id=>id===event.eventId).length,1);assert.equal((await inspectSnapshot(globalPath(mirror))).characters.deepseek.companionEvents[event.eventId].delivered,true);}finally{await reopened.close();}
 }finally{crash=false;await game.close();}
});

function shutdownFixture(overrides={}){
 const source=readFileSync(new URL('../src/main.mjs',import.meta.url),'utf8'),start=source.indexOf('let shuttingDown=false,shutdownInFlight;'),end=source.indexOf('app.whenReady()',start),events=new Map(),calls=[];
 assert(start>=0&&end>start,'Locate the production shutdown functions');
 const context={quitting:false,shutdownRecoveryFailed:false,pluginClientStateOff:null,petDiagnostics:null,dataImport:null,
  buttonObserver:null,trajectoryWindow:null,quotas:null,settingsTail:null,settingsWriteTail:null,provider:null,cg:null,
  game:null,workSourceRegistry:null,async drainModelConnectionTests(){},apiUsageJournal:{async drain(){}},worker:null,appUpdates:null,network:null,
  closeAppServices,closePluginServices,recoverAppShutdown,shutdownFailureDetail,t:value=>value,
  dataRoot:temp(),deferredSaves:{async flushAll(){calls.push('flush');},flushSyncAll(){calls.push('flush-sync');},stop(){calls.push('timer-stop');}},agents:{busy:()=>false,async close(){calls.push('agents-close');}},dailyCgScheduler:null,rewardTail:Promise.resolve(),monitorProfile:{cancel(){}},mainProfile:{cancel(){}},closePetFullscreen(){},applyPetVisibility(){},syncPetFullscreenObserver(){},pluginEmbed:null,plugins:null,voiceHost:{async quiesce(){},async close(){calls.push('voice-close');throw Object.assign(Error('blocked'),{code:'VOICE_CARD_STOP_FAILED'});}},updateReservation:{committed:()=>false,reopenAfterFailedShutdown(){calls.push('reopen-update');}},dialog:{async showMessageBox(){calls.push('dialog');return {response:2};}},panel:null,pet:null,audit:value=>calls.push(value.type),app:{on:(name,fn)=>events.set(name,fn)},};
 Object.assign(context,overrides);
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);return {context,calls,events};
}

ownedTest('normal and update shutdown checkpoint before a failing voice close',async()=>{
 for(const forUpdate of [false,true]){const f=shutdownFixture();await f.context.shutdown(forUpdate);assert.deepEqual(f.calls.slice(0,3),['flush-sync','agents-close','voice-close']);assert.ok(f.calls.includes('flush'));assert.ok(f.calls.includes('shutdown-blocked'));assert.equal(f.context.quitting,false);}
});

ownedTest('Windows session-end invokes the synchronous save before returning',()=>{
 const f=shutdownFixture(),windowEvents=new Map();assert.equal(typeof f.events.get('browser-window-created'),'function');f.events.get('browser-window-created')({}, {on:(name,fn)=>windowEvents.set(name,fn)});assert.equal(typeof windowEvents.get('session-end'),'function');windowEvents.get('session-end')();assert.deepEqual(f.calls,['flush-sync']);
 f.events.get('session-end')();assert.deepEqual(f.calls,['flush-sync','flush-sync']);
});

ownedTest('return from normal quit preserves the dirty engine save without a SQLite checkpoint',async t=>{
 const dataRoot=temp(),registry=createDeferredSaves(),enginePath=join(dataRoot,'engine.json');
 const prepare=DatabaseSync.prototype.prepare;
 const checkpoints=[],audit=[];
 t.mock.method(DatabaseSync.prototype,'prepare',function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(sql==='PRAGMA wal_checkpoint(PASSIVE)'||sql==='PRAGMA wal_checkpoint(TRUNCATE)'){
   const get=statement.get;
   statement.get=function(...values){checkpoints.push(sql);return get.apply(this,values);};
  }
  return statement;
 });
 const store=await openCompanionStore(dataRoot,{deferredSaveRegistry:registry,audit:event=>audit.push(event)});
 const engine=createNativeGlobalStorage(enginePath);
 const unregister=registry.register('engine',{target:enginePath,scope:dataRoot,drain:engine.drain,flushSync:engine.flushSync});
 try{
  await store.mutate(state=>{state.settings.allowUserMessageEdit=true;});
  await engine.writeText('{"unflushed":1}');
  assert.equal(commits(enginePath),0);
  const {context,events}=shutdownFixture({
   dataRoot,deferredSaves:registry,agents:{busy:()=>true,async prepareExit(){assert.fail('Return must not stop the active task');}}
  });
  await context.shutdown();
  assert.deepEqual(checkpoints,[],'normal preliminary save leaves the committed SQLite WAL alone');
  assert.ok(!audit.some(event=>event.type==='companion-wal-checkpoint'&&event.reason==='flush'));
  assert.equal(commits(enginePath),1);
  assert.equal(context.quitting,false);
  assert.equal((await readJson(createSnapshotStorage(enginePath),null)).unflushed,1);
  assert.equal(readCompanion(dataRoot).settings.allowUserMessageEdit,true);

  await engine.writeText('{"unflushed":2}');
  events.get('session-end')();
  assert.deepEqual(checkpoints,['PRAGMA wal_checkpoint(PASSIVE)'],'Windows session-end checkpoints synchronously');
  assert.equal(commits(enginePath),2);
  await engine.writeText('{"unflushed":3}');
  const receipts=await registry.flushAll({scope:dataRoot});
  const {checkpoint}=receipts.find(row=>row.kind==='companion').receipt;
  assert.equal(checkpoint.status,'checkpointed');
  assert.equal(checkpoint.checkpointed,checkpoint.log);
  assert.deepEqual(audit.filter(event=>event.type==='companion-wal-checkpoint'&&event.reason==='flush'),
   [{type:'companion-wal-checkpoint',...checkpoint}]);
  assert.deepEqual(checkpoints,['PRAGMA wal_checkpoint(PASSIVE)'],'async flush uses the worker checkpoint');
  assert.equal(commits(enginePath),3);
 }finally{unregister();await store.close();}
});

test('an invalid deferred-save kind fails instead of reporting an empty successful save',()=>{
 const registry=createDeferredSaves();
 assert.throws(()=>registry.flushSyncAll({kind:'wrong'}),{code:'DEFERRED_SAVE_KIND_INVALID'});
});

ownedTest('snapshot inspection and export see the authoritative stores and imported profiles survive old-instance shutdown',async()=>{
 const root=temp(),dataRoot=join(root,'local/data-v003'),build=join(root,'builds/candidate'),source=temp();mkdirSync(build,{recursive:true});mkdirSync(dataRoot,{recursive:true});
 const record={schemaVersion:1,version:'2.0.8',build:'builds/candidate',runtime:'runtime/fixture',manager:'maintenance/setup.exe',edition:'30fps',characters:['deepseek'],dataPath:null,pipe:'fixture-current'};writeFileSync(join(root,'local/installation.json'),JSON.stringify(record));
 const old=await createGalgame({dataRoot,provider,model:'fixture'}),incoming=await openCompanionStore(source);await incoming.mutate(state=>{state.settings.allowUserMessageEdit=true;});await incoming.close();
 await old.action('companion-character-save',{id:'deepseek',name:'latest before inspect'});
 await inspectSnapshot(globalPath(dataRoot));
 assert.equal(readCompanion(dataRoot).cards.deepseek.name,'latest before inspect');
 await old.action('companion-character-save',{id:'deepseek',name:'latest before export'});await importInventory(dataRoot);assert.equal((readCompanion(dataRoot)).cards.deepseek.name,'latest before export');
 let target,phase=[],commit;const originalPause=deferredSaves.pause;deferredSaves.pause=options=>{phase.push('pause');const resume=originalPause(options);return ()=>{phase.push('resume');resume();};};
 const service=createDataImportService({root,dataRoot,build,pipe:'fixture-current',manager:null,chooseSource:async()=>source,freeBytes:async()=>10n**12n,copyCheckpoint:()=>{assert.equal(phase.at(-1),'pause');},launchCommit:async value=>{commit=value;target=join(root,value.targetDataPath);writeFileSync(join(root,'local/installation.json'),JSON.stringify({...record,dataPath:value.targetDataPath}));}});
 try{
  await old.action('companion-character-save',{id:'deepseek',name:'latest before import'});const chosen=await service.choose(),preview=await service.preview({source:chosen.source,sourceClosed:true});await service.start({planId:preview.planId,sourceClosed:true});await until(()=>['complete','failed'].includes(service.state().phase));assert.equal(service.state().phase,'complete',service.state().error);assert.deepEqual(phase,['pause','resume']);
  assert.equal((readCompanion(dataRoot)).cards.deepseek.name,'latest before import');const bytes=readFileSync(companionDatabase(target));await old.action('companion-character-save',{id:'deepseek',name:'old instance final state'});await old.close();assert.deepEqual(readFileSync(companionDatabase(target)),bytes);assert.equal((readCompanion(target)).settings.allowUserMessageEdit,true);assert.equal(JSON.parse(readFileSync(join(root,'local/installation.json'))).dataPath,commit.targetDataPath);
 }finally{deferredSaves.pause=originalPause;service.close();await old.close();}
});

ownedTest('synchronous session-end saves a pending work counter before bank/workFolded and reopens exactly once',async()=>{
 const root=temp(),registry=createDeferredSaves(),game=await createGalgame({dataRoot:root,provider,model:'fixture',deferredSaveRegistry:registry});
 try{await game.flushSaves();const bank0=(await readJson(createSnapshotStorage(globalPath(root)))).tokens.bank;game.workTokens(8123);registry.flushSyncAll({scope:root});
  assert.equal(JSON.parse(readFileSync(join(root,'galgame/storages/dsh-whale-galgame/work-tokens.json'),'utf8')).total,8123);const tokens=(await readJson(createSnapshotStorage(globalPath(root)))).tokens;assert.deepEqual([tokens.bank,tokens.workFolded],[bank0+8123,8123]);
  const mirror=temp();cpSync(root,mirror,{recursive:true});const reopened=await createGalgame({dataRoot:mirror,provider,model:'fixture'});try{await reopened.flushSaves();assert.deepEqual((await readJson(createSnapshotStorage(globalPath(mirror)))).tokens,tokens);}finally{await reopened.close();}
 }finally{await game.close();}
});

ownedTest('import reserves start during its save boundary and resumes the timer after failure or cancellation',async()=>{
 for(const mode of ['failed','cancelled']){
  const root=temp(),dataRoot=join(root,'local/data-v003'),build=join(root,'builds/candidate'),source=temp();mkdirSync(build,{recursive:true});mkdirSync(dataRoot,{recursive:true});writeFileSync(join(root,'local/installation.json'),JSON.stringify({schemaVersion:1,version:'2.0.8',build:'builds/candidate',dataPath:null,pipe:'fixture'}));
  const incoming=await openCompanionStore(source);await incoming.close();let service,resumes=0,pauses=0,cancelled=false;const pause=deferredSaves.pause;deferredSaves.pause=options=>{pauses++;const resume=pause(options);return ()=>{resumes++;resume();};};
  service=createDataImportService({root,dataRoot,build,pipe:'fixture',manager:null,chooseSource:async()=>source,freeBytes:async()=>10n**12n,copyCheckpoint:async()=>{if(mode==='cancelled'&&!cancelled){cancelled=true;await service.cancel();}},launchCommit:async()=>{throw Error('fixture commit failed');}});
  try{const chosen=await service.choose(),preview=await service.preview({source:chosen.source,sourceClosed:true}),args={planId:preview.planId,sourceClosed:true},starting=service.start(args);await assert.rejects(service.start(args),/已有导入/);await starting;await until(()=>['failed','cancelled'].includes(service.state().phase));assert.equal(service.state().phase,mode);assert.equal(pauses,1);assert.equal(resumes,1);}finally{service.close();deferredSaves.pause=pause;}
 }
});

ownedTest('a crash-time work ledger replays 12000 tokens into two affection exactly once',async()=>{
 const root=temp(),crashed=await createGalgame({dataRoot:root,provider,model:'fixture'});
 try{await crashed.flushSaves();const original=await readJson(createSnapshotStorage(globalPath(root)));assert.equal(original.tokens.bank,0);const oldCompanion=readCompanion(root);assert.equal(oldCompanion.relationships.deepseek.byPersona.default.affection,0);
  crashed.workTokens(12000);await new Promise(resolve=>setTimeout(resolve,2150));assert.equal(JSON.parse(readFileSync(join(root,'galgame/storages/dsh-whale-galgame/work-tokens.json'),'utf8')).total,12000);assert.equal((await readJson(createSnapshotStorage(globalPath(root)))).tokens.workFolded,0);
  const mirror=temp();cpSync(root,mirror,{recursive:true});const recovered=await createGalgame({dataRoot:mirror,provider,model:'fixture'});try{await recovered.action('view');await until(async()=>(await recovered.action('view')).affection===2);await recovered.flushSaves();const saved=await readJson(createSnapshotStorage(globalPath(mirror)));assert.deepEqual([saved.tokens.bank,saved.tokens.workFolded],[2000,12000]);assert.equal((readCompanion(mirror)).relationships.deepseek.byPersona.default.affection,2);}finally{await recovered.close();}
  const again=await createGalgame({dataRoot:mirror,provider,model:'fixture'});try{assert.equal((await again.action('view')).affection,2);await again.flushSaves();const saved=await readJson(createSnapshotStorage(globalPath(mirror)));assert.deepEqual([saved.tokens.bank,saved.tokens.workFolded],[2000,12000]);}finally{await again.close();}
 }finally{await crashed.close();}
});

ownedTest('a crash between companion token affection and its engine checkpoint never redeems the same work twice',async()=>{
 const root=temp(),mirror=temp(),registry=createDeferredSaves();let crash=false;const register=registry.register.bind(registry);registry.register=(kind,options)=>register(kind,{...options,flushSync(){const receipt=options.flushSync();if(kind==='companion'&&crash){cpSync(root,mirror,{recursive:true});throw Error('SIMULATED_POWER_LOSS');}return receipt;}});
 const original=await createGalgame({dataRoot:root,provider,model:'fixture',deferredSaveRegistry:registry});
 try{await original.flushSaves();original.workTokens(12000);await original.action('view');await until(async()=>(await original.action('view')).affection===2);crash=true;await assert.rejects(original.flushSaves(),/SIMULATED_POWER_LOSS/);
  assert.equal((readCompanion(mirror)).relationships.deepseek.byPersona.default.affection,2);const oldEngine=await readJson(createSnapshotStorage(globalPath(mirror)));assert.deepEqual([oldEngine.characters.deepseek.affection,oldEngine.tokens.bank,oldEngine.tokens.workFolded],[0,0,0]);assert.equal(JSON.parse(readFileSync(join(mirror,'galgame/storages/dsh-whale-galgame/work-tokens.json'),'utf8')).total,12000);
  const recovered=await createGalgame({dataRoot:mirror,provider,model:'fixture'});try{await recovered.action('view');await recovered.flushSaves();const view=await recovered.action('view');assert.equal(view.affection,2,'companion projection and old work checkpoint must not redeem 12000 twice');await recovered.flushSaves();const state=await readJson(createSnapshotStorage(globalPath(mirror)));assert.deepEqual([state.tokens.bank,state.tokens.workFolded],[2000,12000]);}finally{await recovered.close();}
  const again=await createGalgame({dataRoot:mirror,provider,model:'fixture'});try{assert.equal((await again.action('view')).affection,2);await again.flushSaves();const state=await readJson(createSnapshotStorage(globalPath(mirror)));assert.deepEqual([state.tokens.bank,state.tokens.workFolded],[2000,12000]);}finally{await again.close();}
 }finally{crash=false;await original.close();}
});
