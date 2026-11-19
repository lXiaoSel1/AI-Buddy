import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {setTimeout as wait} from 'node:timers/promises';
import {promisify} from 'node:util';
import {createAutoService} from '../src/companion-auto.mjs';
import {lifeToken} from '../src/companion-life.mjs';
import {createCompanionMemory} from '../src/companion-memory.mjs';
import {groupAutoNamespace,groupAutoOwner} from '../src/companion-partitions.mjs';
import {saveGroupAutoRecord} from '../src/companion-record-access.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createMediaStore} from '../src/media-store.mjs';
import {companionFixture,syntheticEngine} from './support/audit-harness.mjs';

test('ordinary settings save persists the avatar through the companion media worker',{timeout:10000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r19-settings-media-')),diskMedia=createMediaStore(root);
 let store,service,mainPuts=0;
 const media={...diskMedia,put(value){mainPuts++;return diskMedia.put(value);}};
 const source=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nWQAAAAASUVORK5CYII=','base64');
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 try{
  store=await openCompanionStore(root,{media});
  const initial=await companionFixture();
  await store.mutate(state=>Object.assign(state,initial));
  const {engine}=syntheticEngine({getStore:()=>store});
  const provider={enabled:false,currentSelection:()=>({provider:'fixture',model:'fixture'})};
  service=await createCompanionService({store,media,engine,provider,dataRoot:root});
  mainPuts=0;
  const result=await service.action('companion-character-save',{id:'claude',avatar:'data:image/png;base64,'+source.toString('base64')});
  assert.equal(result.ok,true);
  const locator=store.state.cards.claude.avatar;
  assert.equal(locator,'buddy-media://'+sha(source)+'.png');
  assert.equal(sha(diskMedia.read(locator)),sha(source));
  assert.equal(mainPuts,0,'this save must not call media.put on the main thread');
 }finally{
  try{await service?.close();}finally{
   try{await store?.close();}finally{await rm(root,{recursive:true,force:true});}
  }
 }
});

async function runArchiveFaultTest(t,name,receipt){
 const root=await mkdtemp(join(tmpdir(),'buddy-r19-archive-'));
 const {NODE_TEST_CONTEXT,...env}=process.env;
 const fixture=new URL('./fixtures/evidence-archive-full-commit-stall.mjs',import.meta.url);
 try{
  const {stdout}=await promisify(execFile)(process.execPath,['--test','--test-name-pattern='+name,import.meta.filename],{
   env:{...env,NODE_OPTIONS:'--import='+fixture.href,AI_BUDDY_R19_ARCHIVE_FAULT_ROOT:root},
   signal:t.signal,windowsHide:true
  });
  assert.match(stdout,receipt);
  t.diagnostic(stdout.trim());
 }catch(error){assert.fail(error.stdout??error.message);}
 finally{await rm(root,{recursive:true,force:true});}
}

async function waitForArchiveCommit(root,signal){
 for(let i=0;i<500;i++){
  try{return JSON.parse(await readFile(join(root,'commit-entered.json'),'utf8'));}
  catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;await wait(5,undefined,{signal});}
 }
 assert.fail('the worker did not enter the actual archive COMMIT with a held write lock');
}

const concurrentArchiveTest='memory checkpoints and Auto eviction share a FULL archive writer';
test(concurrentArchiveTest,{timeout:15000},async t=>{
 const archiveRoot=process.env.AI_BUDDY_R19_ARCHIVE_FAULT_ROOT;
 if(!archiveRoot)return runArchiveFaultTest(t,concurrentArchiveTest,/FULL COMMIT .* was held/);

 const at=Date.UTC(2026,10,15,12),now=()=>at,day='2026-11-14',groupId='group',characterId='claude',personaId='default';
 const characterStorage=join(archiveRoot,'galgame');
 await mkdir(characterStorage,{recursive:true});
 const initial=await companionFixture({now:at});
 initial.groups[groupId]={id:groupId,personaId,memberIds:[characterId]};
 initial.r95={settings:{auto:true}};
 await writeFile(join(characterStorage,'companion.json'),JSON.stringify(initial));
 const store=await openCompanionStore(archiveRoot);
 const admitted=Promise.withResolvers(),dispatch=Promise.withResolvers();
 let consolidation,opportunity,entry,memoryCalls=0;
 const summaryText='Confirmed evidence for both sources.';
 const namespace='daily-memory-checkpoint-v1';
 const memory=createCompanionMemory({store,autoStart:false,now,
  getCapacity:()=>({tokens:13000,verified:true,source:'fixed-fixture'}),
  runModel:async(_characterId,request)=>{
   memoryCalls++;
   assert.equal(request.purpose,'memory-daily');
   assert.equal(store.archive.get(namespace,entry.id).state,'started');
   const input=JSON.parse(request.messages[0].text);
   return JSON.stringify({coverageHash:input.coverageHash,summary:{text:summaryText,eventIds:input.todayEventIds},guide:{text:'',eventIds:[]},core:[],branches:[],growthCandidates:[]});
  }
 });
 try{
  const scope={characterId,personaId,conversationId:groupId,channel:'app-group',...lifeToken(store.state,characterId)};
  const auto=createAutoService({store,now,dispatchTurn:async reservation=>{
   admitted.resolve();
   await dispatch.promise;
   return auto.commitOpportunity({groupId,requestId:reservation.requestId,status:'silent',evidenceId:'new-receipt'});
  }});
  const session=await auto.start({groupId,scope,authorizationId:'initial',mode:'until-stopped'});
  const archived={requestId:'old-0',status:'silent',evidenceId:'receipt-0',at:at-200};
  await store.mutate((state,tx)=>{
   for(let i=0;i<200;i++)saveGroupAutoRecord(store,state.groups[groupId].auto,groupId,session.id,'completed','old-'+i,
    {requestId:'old-'+i,status:'silent',evidenceId:'receipt-'+i,at:at-200+i},tx);
  });
  opportunity=Promise.allSettled([auto.next({groupId})]);
  await Promise.race([admitted.promise,opportunity]);
  consolidation=memory.consolidate({characterId,personaId,day});
  entry=await waitForArchiveCommit(archiveRoot,t.signal);
  assert.equal(memoryCalls,0,'the model waits for durable dispatch acknowledgement');
  dispatch.resolve();
  const [[autoResult],memoryResult]=await Promise.all([opportunity,consolidation]);
  const {elapsedMs}=JSON.parse(await readFile(join(archiveRoot,'commit-finished.json'),'utf8'));
  const autoStatus=auto.view({groupId}).auto.status;
  t.diagnostic('FULL COMMIT '+entry.lane+' was held '+elapsedMs.toFixed(2)+' ms; Auto '+autoStatus+'; memory '+memoryResult.status);
  if(autoResult.status==='rejected')t.diagnostic(JSON.stringify({message:autoResult.reason.message,code:autoResult.reason.code}));
  assert.ok(elapsedMs>=1500);
  assert.equal(autoResult.status,'fulfilled',autoResult.reason?.message);
  assert.equal(autoStatus,'active');
  assert.equal(entry.lane,'auto-archive-publisher');
  const liveNamespace=groupAutoNamespace('completed'),owner=groupAutoOwner(groupId,session.id);
  assert.equal(store.records.count(liveNamespace,owner),200);
  assert.equal(store.records.get(liveNamespace,owner,'old-0'),undefined);
  assert.deepEqual(store.archive.get('auto-completed:'+session.id,'old-0'),archived);
  assert.equal(store.records.get(liveNamespace,owner,autoResult.value.requestId)?.evidenceId,'new-receipt');
  assert.equal(memoryResult.status,'committed',memoryResult.error);
  assert.equal(memoryCalls,1);
  assert.deepEqual(store.archive.get(namespace,entry.id),{state:'started'});
  assert.deepEqual(store.archive.get(namespace,entry.id.replace(/:started$/,':settled')),{state:'settled'});
  const accepted=store.archive.get(namespace,entry.id.replace(/:\d+:started$/,':result'));
  assert.equal(accepted.state,'accepted');
  assert.equal(accepted.value.summary.text,summaryText);
  assert.equal(accepted.value.summary.eventIds.length,2);
 }finally{
  dispatch.resolve();
  await Promise.allSettled([opportunity,consolidation]);
  try{await memory.close();}finally{await store.close();}
 }
});

const concurrentCheckpointTest='concurrent same-profile memory consolidation submits one checkpoint request';
test(concurrentCheckpointTest,{timeout:15000},async t=>{
 const root=process.env.AI_BUDDY_R19_ARCHIVE_FAULT_ROOT;
 if(!root)return runArchiveFaultTest(t,concurrentCheckpointTest,/model submissions:/);
 const at=Date.UTC(2026,10,15,12),now=()=>at;
 const directory=join(root,'galgame'),data=await companionFixture({now:at});
 await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'companion.json'),JSON.stringify(data));

 const stores=[],services=[],flights=[],submissions=[];
 const args={characterId:'claude',personaId:'default',day:'2026-11-14'};
 try{
  for(const lease of ['first','second']){
   const store=await openCompanionStore(root);
   stores.push(store);
   services.push(createCompanionMemory({store,now,autoStart:false,
    getCapacity:()=>({tokens:13000,verified:true,source:'fixed-fixture'}),
    runModel:async(_characterId,request)=>{
     assert.equal(request.purpose,'memory-daily');
     submissions.push(lease);
     const input=JSON.parse(request.messages[0].text);
     return JSON.stringify({coverageHash:input.coverageHash,summary:{text:'Summary of the two sources.',eventIds:input.todayEventIds},guide:{text:'',eventIds:[]},core:[],branches:[],growthCandidates:[]});
    }
   }));
  }
  flights.push(services[0].consolidate(args));
  void flights[0].catch(()=>{});
  const entry=await waitForArchiveCommit(root,t.signal);
  assert.equal(entry.lane,'auto-archive-publisher');
  assert.deepEqual(submissions,[],'the first dispatch marker is awaiting its owner ACK');
  flights.push(services[1].consolidate(args));
  const outcomes=await Promise.allSettled(flights);
  t.diagnostic('model submissions: '+submissions.join(', ')+'; outcomes: '+outcomes.map(row=>row.value?.status??row.reason?.code??row.status).join(', '));
  assert.deepEqual(submissions,['first']);
  assert.equal(outcomes[0].status,'fulfilled',outcomes[0].reason?.message);
  assert.equal(outcomes[0].value.status,'committed',outcomes[0].value.error);
  if(outcomes[1].status==='rejected')assert.equal(outcomes[1].reason.code,'MEMORY_VALIDATION');
  else assert.equal(outcomes[1].value.status,'committed');
  const namespace='daily-memory-checkpoint-v1';
  const accepted=stores[0].archive.get(namespace,entry.id.replace(/:\d+:started$/,':result'));
  assert.equal(accepted.state,'accepted');
  assert.equal(accepted.value.summary.text,'Summary of the two sources.');
  assert.equal(accepted.value.summary.eventIds.length,2);
 }finally{
  await Promise.allSettled(flights);
  try{await Promise.all(services.map(memory=>memory.close()));}
  finally{await Promise.all(stores.map(store=>store.close()));}
 }
});
