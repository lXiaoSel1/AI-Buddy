import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,readdirSync,symlinkSync,realpathSync,renameSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {createSnapshotStorage,readJson} from '../src/storage.mjs';
import {createDataImportService,resolveImportSource,importInventory,inspectSnapshot,pauseImportedWork,IMPORT_GUARD} from '../src/data-import.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
const temp=()=>realpathSync.native(mkdtempSync(join(tmpdir(),'buddy-data-import-')));
const write=(path,bytes)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,bytes);};
const snapshot=async(path,value)=>createSnapshotStorage(path,{retention:false}).writeText(JSON.stringify(value));
const until=async fn=>{for(let i=0;i<1000;i++){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,5));}throw Error('Import fixture timeout');};
async function fixture(options={}){
 const base=temp(),root=join(base,'当前程序 with space'),source=join(base,'旧存档'),dataRoot=join(root,'local/data-v003'),build=join(root,'builds/candidate');
 mkdirSync(dataRoot,{recursive:true});mkdirSync(build,{recursive:true});mkdirSync(source,{recursive:true});
 const record={schemaVersion:1,version:'1.9.0',build:'builds/candidate',runtime:'runtime/fixture',manager:'maintenance/setup.exe',edition:'30fps',characters:['deepseek'],dataPath:null,pipe:'fixture-current'};
 write(join(root,'local/installation.json'),JSON.stringify(record));write(join(root,'local/current-build.json'),JSON.stringify({path:'builds/candidate',version:'1.9.0'}));write(join(dataRoot,'CURRENT-SENTINEL.txt'),'do not replace');
 await snapshot(join(source,'galgame/storages/dsh-whale-galgame/global.json'),{characters:{deepseek:{level:7,affection:123,chatLines:[{text:'完整旧聊天原文'}]}}});
 await snapshot(join(source,'model-connections.json'),{profiles:[{id:'mock',keyCiphertext:'not a real key'}]});
 await snapshot(join(source,'galgame/companion.json'),{version:1,cards:{deepseek:{name:'DeepSeek'}},personas:{a:{name:'身份A'},b:{name:'身份B'}},conversations:{a:{messages:[{id:'sent',status:'presented',text:'身份A的完整原文'},{id:'draft',status:'pending-presentation',text:'未呈现不得算经历'}]}},groups:{g:{members:['deepseek'],pending:{id:'pending-group',text:'未呈现群聊'}}},lives:{deepseek:{memory:{events:{e:{text:'不可淡忘的记忆',source:'msg1'}},guides:{g:'成长指南'}},personality:{version:3,text:'当前人格'},relationships:{a:{affection:3},b:{affection:8}}}}});
 await snapshot(join(source,'cg-jobs.json'),{version:1,jobs:[{id:'queued',status:'queued',prompt:'原提示A'},{id:'planning',status:'planning',themeBrief:{charId:'deepseek'}},{id:'remote',status:'generating',submittedAt:123,remoteTask:{id:'preserve-task'},prompt:'原提示B'},{id:'uncertain',status:'generating',submittedAt:456,prompt:'原提示C'},{id:'ready',status:'ready',assetRef:'cg-assets/ready/image.png'}]});
 write(join(source,'cg-assets/ready/image.png'),Buffer.from([137,80,78,71,0,1,2,3]));write(join(source,'lives/人生-archive.zip'),Buffer.from('opaque life ZIP bytes'));
 write(join(source,'chromium/Cache/ignored.bin'),'cache');write(join(source,'crash-reports/ignored.dmp'),'crash');write(join(source,'runtime-instance.lock'),'transient');write(join(source,'work-tokens.json.tmp'),'transient');
 write(join(source,'work-tokens.json'),'persist actual tokens');write(join(source,'captures/retained-image.webp'),'not a Chromium cache');
 const commits=[],barriers=[],states=[];let chosen=source;
 const service=createDataImportService({root,dataRoot,build,pipe:'fixture-current',manager:null,chooseSource:async()=>chosen,onState:s=>states.push(s),onBarrier:v=>barriers.push(v),freeBytes:async()=>10n**12n,launchCommit:async(commit,path)=>commits.push({commit,path}),...options});
 const prepare=async()=>{const selected=await service.choose();return service.preview({source:selected.source,sourceClosed:true});};
 const finish=()=>until(()=>['complete','failed','cancelled'].includes(service.state().phase)&&service.state());
 return {base,root,source,dataRoot,build,record,commits,barriers,states,service,prepare,finish,setChosen:value=>{chosen=value;},close:()=>service.close()};
}

test('preview is source-read-only, accurately summarizes complete data, and binds its source selection',async()=>{
 const f=await fixture();try{
  const before=await importInventory(f.source);await assert.rejects(()=>f.service.preview({source:f.source,sourceClosed:true}),/选择/);await f.service.choose();
  await assert.rejects(()=>f.service.preview({source:f.source}),/退出|关闭/);await assert.rejects(()=>f.service.preview({source:f.base,sourceClosed:true}),/选择/);
  const preview=await f.prepare();assert.equal((await importInventory(f.source)).sha256,before.sha256);assert.equal(preview.sourceDataRoot,f.source);assert.equal(preview.summary.personas,2);assert.equal(preview.summary.cgs,5);assert.equal(preview.summary.lifeArchives,1);assert.equal(preview.summary.memoryEvents,1);assert.ok(preview.exclusions.includes('chromium'));assert.ok(preview.exclusions.includes('crash-reports'));assert.equal(existsSync(preview.targetDataRoot),false);assert.equal(f.commits.length,0);
 }finally{f.close();}
});
test('full copy preserves original/current data, images, life archives and hashes while excluding transient caches',async()=>{
 const f=await fixture();try{
  const before=await importInventory(f.source),recordBefore=readFileSync(join(f.root,'local/installation.json')),p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'complete',state.error);assert.equal(f.commits.length,1);
  const {commit,path}=f.commits[0],target=join(f.root,commit.targetDataPath);assert.equal(commit.root,f.root);assert.equal(commit.expectedBuild,'builds/candidate');assert.equal(commit.expectedInstallationSha256,hash(recordBefore));assert.ok(commit.targetDataPath.startsWith('local/data-profiles/import-'));assert.deepEqual(JSON.parse(readFileSync(path,'utf8')),commit);
  assert.deepEqual(readFileSync(join(target,'cg-assets/ready/image.png')),readFileSync(join(f.source,'cg-assets/ready/image.png')));assert.deepEqual(readFileSync(join(target,'lives/人生-archive.zip')),readFileSync(join(f.source,'lives/人生-archive.zip')));assert.equal(readFileSync(join(target,'work-tokens.json'),'utf8'),'persist actual tokens');assert.equal(existsSync(join(target,'captures/retained-image.webp')),true);
  for(const path of ['chromium','crash-reports','runtime-instance.lock','work-tokens.json.tmp'])assert.equal(existsSync(join(target,path)),false,path);
  assert.equal((await importInventory(target)).sha256,commit.filesSha256);assert.equal((await importInventory(f.source)).sha256,before.sha256);assert.deepEqual(readFileSync(join(f.root,'local/installation.json')),recordBefore);assert.equal(readFileSync(join(f.dataRoot,'CURRENT-SENTINEL.txt'),'utf8'),'do not replace');assert.deepEqual(f.barriers,[true,false]);
  // A successful mocked commit must release the in-flight guard too.
  await f.service.choose();
 }finally{f.close();}
});
test('changing the source after preview rejects import without switching anything',async()=>{
 const f=await fixture();try{const p=await f.prepare();writeFileSync(join(f.source,'work-tokens.json'),'new data after preview');await f.service.start({planId:p.planId,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'failed');assert.match(state.error,/来源.*变化/);assert.equal(f.commits.length,0);assert.equal(existsSync(p.targetDataRoot),false);assert.equal(f.service.automaticWorkAllowed(),true);}finally{f.close();}
});
test('a source change during copy is rejected after copying, preserving the source and current root',async()=>{
 let source;const f=await fixture({copyCheckpoint:async({filesCopied})=>{if(filesCopied===1)writeFileSync(join(source,'work-tokens.json'),'changed while copying');}});source=f.source;
 try{const p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'failed');assert.match(state.error,/来源|校验/);assert.equal(f.commits.length,0);assert.equal(existsSync(p.targetDataRoot),false);assert.equal(readFileSync(join(f.dataRoot,'CURRENT-SENTINEL.txt'),'utf8'),'do not replace');}finally{f.close();}
});
test('insufficient disk fails before staging or commit',async()=>{
 const f=await fixture({freeBytes:async()=>0n});try{const p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'failed');assert.match(state.error,/空间不足/);assert.equal(f.commits.length,0);assert.equal(existsSync(join(f.root,'local/data-profiles/.import-'+p.planId+'.staging')),false);}finally{f.close();}
});
test('cancellation during copy retains the current pointer, source, and forensic staging',async()=>{
 let svc,pid;const f=await fixture({copyCheckpoint:async({filesCopied})=>{if(filesCopied===1)await svc.cancel({planId:pid});}});svc=f.service;
 try{const before=await importInventory(f.source),record=readFileSync(join(f.root,'local/installation.json')),p=await f.prepare();pid=p.planId;await f.service.start({planId:pid,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'cancelled');assert.equal(f.commits.length,0);assert.equal(existsSync(p.targetDataRoot),false);assert.equal((await importInventory(f.source)).sha256,before.sha256);assert.deepEqual(readFileSync(join(f.root,'local/installation.json')),record);assert.deepEqual(f.barriers,[true,false]);}finally{f.close();}
});
test('tampered copied bytes fail the independent final index check',async()=>{
 const f=await fixture({copyCheckpoint:async({file,stage,filesCopied})=>{if(filesCopied===1)writeFileSync(join(stage,file.path),'wrong bytes after stream hash');}});
 try{const p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'failed');assert.match(state.error,/副本校验/);assert.equal(f.commits.length,0);assert.equal(existsSync(p.targetDataRoot),false);}finally{f.close();}
});
test('an invalid snapshot hash is rejected at preview without writing a repaired source snapshot',async()=>{
 const f=await fixture();try{const folder=join(f.source,'galgame/storages/dsh-whale-galgame/global.json.snapshots'),file=readdirSync(folder).find(s=>s.endsWith('.json'));writeFileSync(join(folder,file),'{}');const before=await importInventory(f.source);await assert.rejects(()=>f.prepare(),/可验证|有效存档/);assert.equal((await importInventory(f.source)).sha256,before.sha256);assert.equal(f.commits.length,0);}finally{f.close();}
});
test('imported jobs and unfinished requests pause without losing submitted/remote evidence or presented history',async()=>{
 const f=await fixture();try{const result=await pauseImportedWork(f.source,{planId:'fixture-plan',sourceIdentity:'source-identity',now:555});assert.equal(result.pausedCgs,4);assert.equal(result.interruptedRequests,2);const jobs=(await inspectSnapshot(join(f.source,'cg-jobs.json'))).jobs;for(const j of jobs.filter(j=>j.id!=='ready')){assert.equal(j.status,'paused');assert.equal(j.pauseReason,'import');assert.equal(j.pausedAt,555);}assert.equal(jobs.find(j=>j.id==='remote').remoteTask.id,'preserve-task');assert.equal(jobs.find(j=>j.id==='uncertain').submittedAt,456);assert.equal(jobs.find(j=>j.id==='uncertain').prompt,'原提示C');assert.equal(jobs.find(j=>j.id==='ready').status,'ready');
  const c=await inspectSnapshot(join(f.source,'galgame/companion.json'));assert.equal(c.conversations.a.messages[0].status,'presented');assert.equal(c.conversations.a.messages[0].text,'身份A的完整原文');assert.equal(c.conversations.a.messages[1].status,'interrupted');assert.equal(c.groups.g.pending,null);assert.equal(c.groups.g.importedPending.id,'pending-group');assert.equal(c.lives.deepseek.personality.version,3);assert.equal(c.lives.deepseek.relationships.b.affection,8);const guard=JSON.parse(readFileSync(join(f.source,IMPORT_GUARD),'utf8'));assert.equal(guard.active,true);assert.equal(guard.planId,'fixture-plan');
 }finally{f.close();}
});
test('memory/CG automatic work stays blocked until a deliberate resumeWork call',async()=>{
 const f=await fixture();try{writeFileSync(join(f.dataRoot,IMPORT_GUARD),JSON.stringify({version:1,active:true,planId:'preserve',sourceIdentity:'source'}));assert.equal(f.service.automaticWorkAllowed(),false);assert.equal(f.service.state().importedWorkPaused,true);await f.service.resumeWork();assert.equal(f.service.automaticWorkAllowed(),true);const guard=JSON.parse(readFileSync(join(f.dataRoot,IMPORT_GUARD),'utf8'));assert.equal(guard.planId,'preserve');assert.equal(guard.sourceIdentity,'source');assert.equal(guard.active,false);assert.equal(typeof guard.resumedAt,'number');}finally{f.close();}
});

test('a damaged or invalid imported-work guard fails closed until deliberate resume',async()=>{
 const f=await fixture();try{
  for(const text of ['{broken',JSON.stringify({version:1}),JSON.stringify({version:2,active:false})]){
   writeFileSync(join(f.dataRoot,IMPORT_GUARD),text);assert.equal(f.service.automaticWorkAllowed(),false);assert.equal(f.service.state().importedWorkPaused,true);
  }
  await f.service.resumeWork();assert.equal(f.service.automaticWorkAllowed(),true);assert.equal(JSON.parse(readFileSync(join(f.dataRoot,IMPORT_GUARD),'utf8')).active,false);
 }finally{f.close();}
});

test('unseen private presentation is interrupted while an already-presented group settlement is retained',async()=>{
 const f=await fixture();try{
  const companion=await inspectSnapshot(join(f.source,'galgame/companion.json'));
  companion.conversations.a.messages.push({id:'real-private-draft',role:'assistant',presentation:'pending',text:'未展示的完整草稿',pendingAffection:1});
  const settlement={message:{id:'shown',status:'presented',text:'已经展示的台词',characterId:'deepseek',personaId:'a'},amount:1};
  companion.groups.shown={id:'shown',messages:[settlement.message],pending:{message:null,settlement}};
  await snapshot(join(f.source,'galgame/companion.json'),companion);
  await pauseImportedWork(f.source,{planId:'pause-fixture',sourceIdentity:'fixture'});
  const result=await inspectSnapshot(join(f.source,'galgame/companion.json')),draft=result.conversations.a.messages.at(-1);
  assert.equal(draft.text,'未展示的完整草稿');assert.equal(draft.status,'interrupted');assert.equal(draft.presentation,'discarded');
  assert.deepEqual(result.groups.shown.pending.settlement,settlement);assert.deepEqual(result.groups.shown.messages,[settlement.message]);
 }finally{f.close();}
});
test('repeated starts, unselected paths and mismatched plans cannot start arbitrary copies',async()=>{
 let release;const wait=new Promise(r=>release=r);const f=await fixture({copyCheckpoint:async({filesCopied})=>{if(filesCopied===1)await wait;}});
 try{await assert.rejects(()=>f.service.start({planId:'unknown',sourceClosed:true}),/过期/);const p=await f.prepare();await assert.rejects(()=>f.service.start({planId:p.planId}),/退出/);await f.service.start({planId:p.planId,sourceClosed:true});await assert.rejects(()=>f.service.start({planId:p.planId,sourceClosed:true}),/正在进行/);await assert.rejects(()=>f.service.choose(),/正在进行/);await assert.rejects(()=>f.service.cancel({planId:'wrong'}),/不匹配/);release();assert.equal((await f.finish()).phase,'complete');assert.equal(f.commits.length,1);}finally{release();f.close();}
});
test('changing installation identity after preview blocks commit before copying',async()=>{
 const f=await fixture();try{const p=await f.prepare();writeFileSync(join(f.root,'local/installation.json'),JSON.stringify({...f.record,dataPath:'C:\\Different'}));await f.service.start({planId:p.planId,sourceClosed:true});const state=await f.finish();assert.equal(state.phase,'failed');assert.match(state.error,/安装或资料选择已变化/);assert.equal(f.commits.length,0);assert.equal(existsSync(p.targetDataRoot),false);}finally{f.close();}
});
test('old application folder resolves its actual external data root and refuses a known live source instance',async()=>{
 const f=await fixture({query:async()=>({dataRoot:null,build:null})});try{const old=join(f.base,'旧版程序');write(join(old,'local/current-build.json'),JSON.stringify({path:'builds/old'}));write(join(old,'local/installation.json'),JSON.stringify({schemaVersion:1,version:'1.8.0',dataPath:f.source,pipe:'old-fixture'}));const selected=await resolveImportSource(old);assert.equal(selected.sourceRoot,old);assert.equal(selected.sourceDataRoot,f.source);assert.equal(selected.sourcePipe,'\\\\.\\pipe\\old-fixture');f.setChosen(old);assert.equal((await f.prepare()).sourceDataRoot,f.source);
  const g=createDataImportService({root:f.root,dataRoot:f.dataRoot,build:f.build,pipe:'fixture-current',chooseSource:async()=>old,query:async()=>({dataRoot:f.source})});try{await g.choose();await assert.rejects(()=>g.preview({source:old,sourceClosed:true}),/仍在运行/);}finally{g.close();}
 }finally{f.close();}
});
test('junctions and the active data root are rejected without following or modifying their contents',async()=>{
 const f=await fixture();try{const outside=temp();writeFileSync(join(outside,'precious.txt'),'outside');symlinkSync(outside,join(f.source,'linked'),'junction');await assert.rejects(()=>f.prepare(),/链接/);assert.equal(readFileSync(join(outside,'precious.txt'),'utf8'),'outside');f.setChosen(f.dataRoot);await assert.rejects(()=>f.prepare(),/正在使用/);}finally{f.close();}
});
test('mock commit failure retains an independently verified copy and leaves the old record unchanged',async()=>{
 const f=await fixture({launchCommit:async()=>{throw Error('injected startup verification failure');}});try{const record=readFileSync(join(f.root,'local/installation.json')),p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const s=await f.finish();assert.equal(s.phase,'failed');assert.match(s.error,/injected startup/);assert.equal(existsSync(p.targetDataRoot),true);assert.deepEqual(readFileSync(join(f.root,'local/installation.json')),record);assert.equal((JSON.parse(readFileSync(join(p.targetDataRoot,IMPORT_GUARD),'utf8'))).active,true);}finally{f.close();}
});
test('Windows short-path aliases cannot bypass the active data-root exclusion',async t=>{
 const f=await fixture();try{
  const alias=f.dataRoot.replace(/^C:\\Users\\Administrator\\/i,'C:\\Users\\ADMINI~1\\');
  if(alias===f.dataRoot||!existsSync(alias)||realpathSync.native(alias)!==f.dataRoot){t.skip('This machine does not provide the expected Windows 8.3 user alias');return;}
  writeFileSync(join(f.dataRoot,'settings.json'),'{}');
  const g=createDataImportService({root:f.root,dataRoot:alias,build:f.build,pipe:'fixture-current',chooseSource:async()=>f.dataRoot});
  try{const selected=await g.choose();await assert.rejects(()=>g.preview({source:selected.source,sourceClosed:true}),/正在使用/);}finally{g.close();}
 }finally{f.close();}
});
test('a junction in the destination profile parent cannot cause out-of-root writes',async()=>{
 const f=await fixture();try{const outside=temp();symlinkSync(outside,join(f.root,'local/data-profiles'),'junction');await assert.rejects(()=>f.prepare(),/链接|联接|路径/);assert.equal(f.commits.length,0);assert.deepEqual(readdirSync(outside),[],'must reject before making staging or copying bytes through junction');}finally{f.close();}
});
test('a source directory replaced by a junction while copying cannot become a committed profile',async()=>{
 let source;const outside=temp(),bytes=Buffer.from([137,80,78,71,0,1,2,3]);write(join(outside,'ready/image.png'),bytes);
 const f=await fixture({copyCheckpoint:async({filesCopied})=>{if(filesCopied===1){renameSync(join(source,'cg-assets'),join(source,'cg-assets-original'));symlinkSync(outside,join(source,'cg-assets'),'junction');}}});source=f.source;
 try{const p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const s=await f.finish();assert.equal(s.phase,'failed');assert.match(s.error,/链接|变化|校验/);assert.equal(f.commits.length,0);assert.equal(existsSync(p.targetDataRoot),false);assert.deepEqual(readFileSync(join(outside,'ready/image.png')),bytes);}finally{f.close();}
});
test('a source file that grows during copy is bounded by the previewed per-file length',async()=>{
 let source,stage,expected;const f=await fixture({copyCheckpoint:async info=>{stage=info.stage;if(info.filesCopied===1)writeFileSync(join(source,'work-tokens.json'),Buffer.alloc(1024*1024,97));}});source=f.source;expected=statSync(join(source,'work-tokens.json')).size;
 try{const p=await f.prepare();await f.service.start({planId:p.planId,sourceClosed:true});const s=await f.finish();assert.equal(s.phase,'failed');assert.equal(f.commits.length,0);const path=join(stage,'work-tokens.json');assert.ok(!existsSync(path)||statSync(path).size<=expected,'copy must stop before writing beyond the declared file length');}finally{f.close();}
});
test('a source pipe timeout is not proof that the old application stopped',async()=>{
 const f=await fixture({query:async()=>{throw Error('timeout waiting for a busy source');}});try{const old=join(f.base,'旧版程序');write(join(old,'local/current-build.json'),JSON.stringify({path:'builds/old'}));write(join(old,'local/installation.json'),JSON.stringify({schemaVersion:1,version:'1.8.0',dataPath:f.source,pipe:'old-fixture'}));f.setChosen(old);await assert.rejects(()=>f.prepare(),/timeout|超时|确认|退出/);assert.equal(f.commits.length,0);}finally{f.close();}
});
