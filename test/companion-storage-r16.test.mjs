import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {Session} from 'node:inspector/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {Worker} from 'node:worker_threads';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {ensureLives} from '../src/companion-life.mjs';
import {writeLifeRestoreSource} from '../src/companion-life-restore-source.mjs';
import {createLifeArchiveRepository} from '../src/companion-life-archive.mjs';
import {createCompanionLives} from '../src/companion-life-service.mjs';
import {createCompanionMemory} from '../src/companion-memory.mjs';
import {makeCard,openCompanionStore} from '../src/companion-store.mjs';

const characterId='synthetic-character',personaId='default',at=1730000060000;
const owner=index=>'synthetic-chat-'+index;
const messageId=index=>'synthetic-message-'+index;

async function fixture(t,{owners=1,perOwner=20,options={},core=true,prepare=()=>{},savedOptions={},mutateSource}={}){
 const root=await mkdtemp(join(tmpdir(),'buddy-storage-r16-'));
 const stores=[],audit=[];
 t.after(async()=>{
  for(const store of stores.reverse())await store.close();
  await rm(root,{recursive:true,force:true});
 });
 const dir=join(root,'galgame');
 const state={
  schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:0,
  activeCharacterId:characterId,activePersonaId:personaId,activeConversationId:owner(0),
  conversations:Object.fromEntries(Array.from({length:owners},(_,i)=>{
   const id=owner(i);
   const messages=Array.from({length:perOwner},(_,j)=>{
    const index=i*perOwner+j;
    return {id:messageId(index),characterId,personaId,role:j%2?'assistant':'user',status:'presented',
     text:'仅用于性能采样 '+i+' '+j+'。'+'用合成对话重建原问题中的大存档。'.repeat(59),createdAt:at-20000+index};
   });
   return [id,{id,characterId,personaId,messages}];
  })),
  cards:{[characterId]:makeCard({id:characterId,name:'Synthetic character'})},
  personas:{[personaId]:{id:personaId,name:'Synthetic persona'}},
  relationships:{[characterId]:{mode:'independent',byPersona:{[personaId]:{level:4,affection:17}}}},
  groups:{},lives:{},settings:{},draftCards:{},memorySettings:{timeZone:'UTC'}
 };
 ensureLives(state,at);
 mutateSource?.(state);
 await mkdir(dir);
 await writeFile(join(dir,'companion.json'),JSON.stringify(state));
 const open=async()=>{
  const store=await openCompanionStore(root,{audit:event=>audit.push(event),...options});
  stores.push(store);
  return store;
 };
 const coreState=scope=>({version:1,characterId:scope.characterId,lifeId:scope.lifeId,feeding:{
  format:'ai-buddy-feeding-state',version:1,scope,satiety:100,gameBalance:0,mealEvidence:[]
 }});
 const coreStateBridge=core?{quiesce(){},activate(){},snapshot:coreState,initial:coreState,validate:()=>true,
  projectLife:({life})=>({...life,r95:{...life.r95,rebasedAt:at}}),prepare,apply(){},finalize(){},recover(){}}:null;
 const boot=store=>createCompanionLives({store,dataRoot:root,call:async()=>({ok:true,content:{}}),coreStateBridge,
  now:()=>at,syncCard:async()=>{},projectPersona:async()=>{},audit:event=>audit.push(event),...savedOptions});
 const store=await open(),life=await boot(store);
 return {root,path:join(dir,'companion.sqlite'),store,open,boot,life,audit};
}

function heartbeat(){
 const samples=[];
 let last=performance.now(),phase='restore';
 const timer=setInterval(()=>{
  const now=performance.now();
  samples.push({at:now,phase,elapsedMs:now-last});
  last=now;
 },1);
 return {mark(value){phase=value;},stop(){clearInterval(timer);return samples;}};
}

test('A1 restore and queued receipts yield to the main event loop', {skip:process.env.AI_BUDDY_R16_STORAGE_TIMING!=='1'}, async t=>{
 const {store,life,audit}=await fixture(t,{owners:20,perOwner:250});
 const memory=createCompanionMemory({store,now:()=>at,autoStart:false,runModel:async()=>{throw Error('Unexpected memory model request');}});
 try{await memory.sync(characterId);}finally{await memory.close();}
 const saved=await life.save(characterId);
 await store.mutate((_,tx)=>tx.messages.update('private',owner(0),messageId(1),row=>{row.text='post archive write';}));
 assert.equal(store.records.count('memory.events',characterId),5000);
 audit.length=0;
 const stages=[],receipts=[];
 const mutate=store.mutate.bind(store);
 store.mutate=(fn,options)=>{
  const started=performance.now();
  return mutate(fn,options).then(value=>{
   if(options?.operation?.startsWith('life-restore'))stages.push({operation:options.operation,started,ended:performance.now()});
   if(options?.operation==='receipt')receipts.push(performance.now());
   return value;
  });
 };
 const memoryPatch={batches:0,puts:0,largestBatch:0};
 const readMemory=store.readMemory.bind(store);
 store.readMemory=(method,args,options,onModel,onBatch)=>readMemory(method,args,options,onModel,onBatch?(batch,assertCurrent)=>{
  memoryPatch.batches++;
  memoryPatch.puts+=batch.changes.filter(row=>row.type==='put').length;
  memoryPatch.largestBatch=Math.max(memoryPatch.largestBatch,batch.changes.length);
  return onBatch(batch,assertCurrent);
 }:undefined);
 const session=new Session();
 session.connect();
 await session.post('Profiler.enable');
 await session.post('Profiler.setSamplingInterval',{interval:1000});
 await session.post('Profiler.start');
 const probe=heartbeat(),marks={restoreStart:performance.now()};
 let samples,profile,receiptProgress;
 try{
  await life.restore(saved.id);
  marks.restoreEnd=performance.now();
  await delay(10);
  probe.mark('receipts');
  marks.receiptsStart=performance.now();
  const observe=new Promise(resolve=>setImmediate(()=>{receiptProgress=receipts.length;resolve();}));
  await Promise.all(Array.from({length:20},(_,index)=>store.mutate((_,tx)=>{
   tx.messages.update('private',owner(0),messageId(index),row=>{row.voicePresentation=[{segmentId:'receipt-'+index,status:'played'}];});
  },{storeImages:false,receipt:true,operation:'receipt'})));
  marks.receiptsEnd=performance.now();
  await observe;
  await delay(10);
  probe.mark('memory');
  marks.memoryStart=performance.now();
  const afterRestore=createCompanionMemory({store,now:()=>at,autoStart:false,
   runModel:async()=>{throw Error('Unexpected memory model request');}});
  try{await afterRestore.tick();}
  finally{await afterRestore.close();}
  marks.memoryEnd=performance.now();
  await delay(10);
 }finally{
  samples=probe.stop();
  ({profile}=await session.post('Profiler.stop'));
  session.disconnect();
 }
 const phases=Object.fromEntries(['restore','receipts','memory'].map(phase=>[phase,samples.filter(row=>row.phase===phase)
  .sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,15)]));
 const summary={marks,phases,stages,receipts,receiptProgress,memoryPatch,slow:audit.filter(event=>event.type.startsWith('companion-slow')),audit};
 if(process.env.AI_BUDDY_R16_STORAGE_RECEIPT){
  const target=process.env.AI_BUDDY_R16_STORAGE_RECEIPT;
  await writeFile(target+'.json',JSON.stringify(summary,null,2));
  await writeFile(target+'-main.json',JSON.stringify(profile));
 }
 t.diagnostic(JSON.stringify({marks,restore:phases.restore[0],receipts:phases.receipts[0],memory:phases.memory[0],receiptProgress,memoryPatch,slow:summary.slow}));
 for(let index=0;index<20;index++)assert.equal(store.messages.get('private',owner(0),messageId(index)).voicePresentation[0].segmentId,'receipt-'+index);
 assert.equal(store.records.count('memory.events',characterId),5000);
 assert.ok(phases.restore[0].elapsedMs<=50,'5,000-message restore yields within 50 ms');
 assert.ok(phases.receipts[0].elapsedMs<=50,'20 queued voice receipts yield within 50 ms');
 assert.ok(receiptProgress<20,'a main-loop turn runs before all 20 writes finish');
 assert.ok(memoryPatch.puts>=5000,'the post-restore worker streams at least 5,000 actual record changes');
 assert.ok(phases.memory[0].elapsedMs<=50,'the post-restore 5,000-message memory patch yields within 50 ms');
 assert.deepEqual(summary.slow,[],'the desktop database produces no statements or transactions over 15 ms');
});

test('B5 restore recognizes a committed worker result with an absent optional JSON field',async t=>{
 const {store,life}=await fixture(t);
 const saved=await life.save(characterId);
 await store.mutate((state,tx)=>{
  state.optionalR16Fixture=undefined;
  tx.messages.update('private',owner(0),messageId(1),row=>{row.text='pre-restore edit';});
 });
 const on=Worker.prototype.on,starts=channel('ai-buddy.companion.worker-start');
 let publishing=false,dropped=false;
 const start=operation=>{publishing=operation==='publish-life-restore';};
 starts.subscribe(start);
 Worker.prototype.on=function(event,callback){
  if(!publishing||event!=='message')return on.call(this,event,callback);
  return on.call(this,event,message=>{
   if(message.result?.revision){dropped=true;return;}
   callback(message);
  });
 };
 try{await life.restore(saved.id);}
 finally{Worker.prototype.on=on;starts.unsubscribe(start);}
 assert.equal(dropped,true);
 assert.equal(store.state.lastLifeTransaction.status,'committed');
 assert.match(store.messages.get('private',owner(0),messageId(1)).text,/仅用于性能采样/);
});

test('A6 stalled publication completion is bounded and reconciles only after worker termination',{timeout:10_000},async t=>{
 const {store,life}=await fixture(t,{options:{publishLifeRestoreTimeoutMs:350}});
 const saved=await life.save(characterId);
 const once=Worker.prototype.once,terminate=Worker.prototype.terminate;
 const starts=channel('ai-buddy.companion.worker-start');
 const deadline=Promise.withResolvers();
 const abort=()=>deadline.reject(t.signal.reason);
 let watchdog;
 let capturePublicationExit=false,terminationRequested=false,exitBlocked=false,releaseExit,trackedWorker;
 const start=operation=>{
  if(operation!=='publish-life-restore'||trackedWorker)return;
  capturePublicationExit=true;
  watchdog=setTimeout(()=>deadline.reject(Error('publication never returned')),1000);
 };
 starts.subscribe(start);
 Worker.prototype.once=function(event,callback){
  if(!capturePublicationExit||event!=='exit')return once.call(this,event,callback);
  // The storage client emits worker-start just before registering this exit
  // callback. Later registrations can belong to independent WAL workers.
  capturePublicationExit=false;
  trackedWorker=this;
  return once.call(this,event,code=>{
   exitBlocked=true;
   if(terminationRequested)callback(code);
   else releaseExit=()=>{releaseExit=undefined;callback(code);};
  });
 };
 Worker.prototype.terminate=function(...args){
  if(this!==trackedWorker)return terminate.apply(this,args);
  terminationRequested=true;
  return terminate.apply(this,args).then(code=>{releaseExit?.();return code;});
 };
 t.signal.addEventListener('abort',abort,{once:true});
 try{
  await Promise.race([life.restore(saved.id),deadline.promise]);
  assert.equal(exitBlocked,true);
  assert.equal(terminationRequested,true);
  assert.equal(store.state.lastLifeTransaction.status,'committed');
  assert.equal(store.messages.count('private',owner(0)),20);
 }finally{
  clearTimeout(watchdog);
  t.signal.removeEventListener('abort',abort);
  releaseExit?.();
  Worker.prototype.once=once;
  Worker.prototype.terminate=terminate;
  starts.unsubscribe(start);
 }
});

test('B6 startup removes only unreferenced restore-source files it owns',async t=>{
 const {store,path,open}=await fixture(t);
 await store.close();
 const orphan=path+'.life-restore-'+randomUUID()+'.json';
 const partial=path+'.life-restore-'+randomUUID()+'.json.'+randomUUID()+'.partial';
 const unrelated=path+'.life-restore-invalid.json';
 const otherDb=path+'.other.life-restore-'+randomUUID()+'.json';
 const directory=path+'.life-restore-'+randomUUID()+'.json';
 for(const target of [orphan,partial,unrelated,otherDb])await writeFile(target,'synthetic retained bytes');
 await mkdir(directory);
 await open();
 for(const target of [orphan,partial])await assert.rejects(readFile(target),{code:'ENOENT'});
 for(const target of [unrelated,otherDb])assert.equal(await readFile(target,'utf8'),'synthetic retained bytes');
 await writeFile(join(directory,'kept'),'directory retained');
});


test('A6 memory worker waits for acknowledgement before sending another bounded patch',async t=>{
 const {store}=await fixture(t,{owners:1,perOwner:130});
 let release,started;
 const first=new Promise(resolve=>{started=resolve;});
 const wait=new Promise(resolve=>{release=resolve;});
 const batches=[];
 const pending=store.readMemory('sync',{characterId},{at,capacity:4096},undefined,async batch=>{
  batches.push(batch);
  if(batches.length===1){started();await wait;}
 });
 try{
  assert.equal(await Promise.race([first.then(()=>true),pending.then(()=>false)]),true,'worker sends patch data before returning');
  await delay(10);
  assert.equal(batches.length,1);
 }finally{release();}
 const result=await pending;
 assert.equal(result.patch.records,undefined);
 assert.equal(batches.flatMap(({changes})=>changes).filter(row=>row.type==='put'&&row.namespace==='memory.events').length,130);
 for(const {changes} of batches){
  assert.ok(changes.length<=64);
  assert.ok(changes.reduce((sum,{value})=>sum+(value===undefined?0:Buffer.byteLength(JSON.stringify(value))),0)<=48*1024);
 }
});


test('A6 failed restoration rolls its staged rows back without a desktop transaction deleting them',async t=>{
 const {store,life,open,boot}=await fixture(t,{prepare(){throw Error('fixture core prepare failed');}});
 const saved=await life.save(characterId);
 await store.mutate((_,tx)=>tx.messages.update('private',owner(0),messageId(1),row=>{row.text='pre-restore edit';}));
 const prepare=DatabaseSync.prototype.prepare,deletedOnMain=[];
 DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(!/^DELETE FROM (messages|records) WHERE /.test(sql.trim()))return statement;
  const run=statement.run;
  statement.run=function(...bindings){
   if(String(bindings[0]).startsWith('transaction-')||String(bindings[0]).startsWith('staged.'))deletedOnMain.push(bindings[0]);
   return run.apply(this,bindings);
  };
  return statement;
 };
 try{
  await store.close();
  const reopened=await open(),service=await boot(reopened);
  await assert.rejects(service.restore(saved.id),/fixture core prepare failed/);
  assert.equal(reopened.state.lastLifeTransaction.status,'rolled-back');
  assert.equal(reopened.messages.get('private',owner(0),messageId(1)).text,'pre-restore edit');
  assert.deepEqual(deletedOnMain,[]);
 }finally{DatabaseSync.prototype.prepare=prepare;}
});


test('A6 rollback of 5,000 staged messages yields to the main event loop', {skip:process.env.AI_BUDDY_R16_STORAGE_TIMING!=='1'},async t=>{
 const {store,life,audit}=await fixture(t,{owners:20,perOwner:250,prepare(){throw Error('timed fixture core failure');}});
 const memory=createCompanionMemory({store,now:()=>at,autoStart:false,
  runModel:async()=>{throw Error('Unexpected memory model request');}});
 try{await memory.sync(characterId);}finally{await memory.close();}
 const saved=await life.save(characterId);
 await store.mutate((_,tx)=>tx.messages.update('private',owner(0),messageId(1),row=>{row.text='pre-restore edit';}));
 audit.length=0;
 const session=new Session();
 session.connect();
 await session.post('Profiler.enable');
 await session.post('Profiler.setSamplingInterval',{interval:1000});
 await session.post('Profiler.start');
 const probe=heartbeat();
 let samples,profile;
 try{
  await assert.rejects(life.restore(saved.id),/timed fixture core failure/);
  await delay(10);
 }finally{
  samples=probe.stop();
  ({profile}=await session.post('Profiler.stop'));
  session.disconnect();
 }
 const max=samples.reduce((largest,row)=>row.elapsedMs>largest.elapsedMs?row:largest,{elapsedMs:0});
 const slow=audit.filter(event=>event.type.startsWith('companion-slow'));
 const summary={max,slow,audit};
 if(process.env.AI_BUDDY_R16_STORAGE_RECEIPT){
  const target=process.env.AI_BUDDY_R16_STORAGE_RECEIPT+'-rollback';
  await writeFile(target+'.json',JSON.stringify(summary,null,2));
  await writeFile(target+'-main.json',JSON.stringify(profile));
 }
 t.diagnostic(JSON.stringify({max,slow}));
 assert.equal(store.state.lastLifeTransaction.status,'rolled-back');
 assert.equal(store.messages.get('private',owner(0),messageId(1)).text,'pre-restore edit');
 assert.equal(store.records.count('memory.events',characterId),5000);
 assert.equal(audit.find(event=>event.type==='companion-life-restore-stage').messageRows,5000);
 assert.ok(max.elapsedMs<=50);
 assert.deepEqual(slow,[]);
});

test('B1 restore waits for its checkpoint without holding unrelated writes or replacing an explicit flush',async t=>{
 const {store,life}=await fixture(t,{core:false});
 const saved=await life.save(characterId);
 const post=Worker.prototype.postMessage,on=Worker.prototype.on;
 let checkpointWorker,releaseReceipt,seenReceipt,receiptHeld=false,restoreSettled=false;
 let holdReplies=true;
 const checkpoint=new Promise(resolve=>{seenReceipt=resolve;});
 Worker.prototype.postMessage=function(message,...transfer){
  if(message.reason==='restore-finish')checkpointWorker=this;
  return post.call(this,message,...transfer);
 };
 Worker.prototype.on=function(event,callback){
  if(event!=='message')return on.call(this,event,callback);
  return on.call(this,event,message=>{
   if(holdReplies&&this===checkpointWorker&&message.result?.reason==='restore-finish'&&!receiptHeld){
    receiptHeld=true;
    releaseReceipt=()=>{releaseReceipt=undefined;callback(message);};
    seenReceipt();
   }else callback(message);
  });
 };
 const restoring=life.restore(saved.id).finally(()=>{restoreSettled=true;});
 void restoring.catch(()=>{});
 let watchdog;
 try{
  const timedOut=new Promise((_,reject)=>{
   watchdog=setTimeout(()=>reject(Error('Restore checkpoint ordering did not complete')),3000);
  });
  assert.equal(await Promise.race([checkpoint.then(()=>true),restoring.then(()=>false),timedOut]),true);
  await Promise.race([store.mutate(state=>{state.settings.independentCheckpointFixture=true;}),timedOut]);
  assert.equal(store.state.settings.independentCheckpointFixture,true);
  assert.equal(restoreSettled,false);
  const explicitFlush=store.flush();
  await new Promise(resolve=>setImmediate(resolve));
  releaseReceipt();
  assert.equal((await Promise.race([explicitFlush,timedOut])).checkpoint.reason,'flush');
  await Promise.race([restoring,timedOut]);
 }finally{
  // Restoring the methods leaves the wrapper already registered on the worker.
  holdReplies=false;
  clearTimeout(watchdog);
  releaseReceipt?.();
  Worker.prototype.postMessage=post;
  Worker.prototype.on=on;
 }
});


function holdScheduledCheckpointReply(){
 const post=Worker.prototype.postMessage,on=Worker.prototype.on;
 const arrived=Promise.withResolvers();
 let armed=true,checkpointWorker,deliver;
 Worker.prototype.postMessage=function(message,...transfer){
  if(message.reason==='scheduled')checkpointWorker=this;
  return post.call(this,message,...transfer);
 };
 Worker.prototype.on=function(event,callback){
  if(event!=='message')return on.call(this,event,callback);
  return on.call(this,event,message=>{
   if(armed&&this===checkpointWorker&&message.result?.reason==='scheduled'&&!deliver){
    deliver=error=>callback(error?{error}:message);
    arrived.resolve(message.result);
   }else callback(message);
  });
 };
 return {
  arrived:arrived.promise,
  release(error){
   armed=false;
   try{deliver?.(error);}finally{
    deliver=undefined;
    Worker.prototype.postMessage=post;
    Worker.prototype.on=on;
   }
  }
 };
}

test('B1 a queued memory tick waits outside the writer tail and rechecks its source',async t=>{
 const traces=channel('ai-buddy.companion.write-latency'),events=[];
 const record=event=>events.push(event);
 const previousTrace=process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE;
 process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE='1';
 traces.subscribe(record);
 t.after(()=>{
  traces.unsubscribe(record);
  if(previousTrace===undefined)delete process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE;
  else process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE=previousTrace;
 });
 const {store}=await fixture(t,{core:false});
 const checkpoint=holdScheduledCheckpointReply();
 const entered=Promise.withResolvers(),releaseWriter=Promise.withResolvers();
 const deadline=AbortSignal.timeout(5000),timedOut=new Promise((_,reject)=>{
  deadline.addEventListener('abort',()=>reject(Error('Scheduled checkpoint ordering did not complete')),{once:true});
 });
 const bounded=promise=>Promise.race([promise,timedOut]);
 let tick;
 try{
  const body='L'.repeat(100000);
  await store.mutate((_,tx)=>{
   for(let index=0;index<180;index++)tx.messages.append('private',owner(0),{
    id:'timer-flight-'+index,characterId,personaId,role:'user',text:body,createdAt:at
   });
  },{storeImages:false});
  const writer=store.mutate(async()=>{entered.resolve();await releaseWriter.promise;});
  await bounded(entered.promise);
  const revision=store.state.revision;
  let guardCalls=0,recipeCalls=0;
  tick=store.mutate(state=>{recipeCalls++;state.settings.timerTick=true;},{
   operation:'memory.tick',waitForScheduledCheckpoint:true,
   guard(state){
    guardCalls++;
    if(state.revision!==revision)throw Error('Synthetic tick source became stale');
    return true;
   }
  });
  void tick.catch(()=>{});
  assert.equal((await bounded(checkpoint.arrived)).status,'checkpointed');
  releaseWriter.resolve();
  await bounded(writer);
  await bounded(store.mutate(state=>{state.settings.unrelatedTimerWrite=true;}));
  assert.equal(store.state.revision,revision+1);
  assert.equal(store.state.settings.unrelatedTimerWrite,true);
  assert.equal(guardCalls,0);
  assert.equal(recipeCalls,0);
  const ordinary=events.at(-1);
  assert.equal(ordinary.status,'committed');
  let freshCalls=0;
  const fresh=store.mutate(state=>{freshCalls++;state.settings.timerTick=true;},{
   operation:'memory.tick',waitForScheduledCheckpoint:true,
   guard:state=>state.settings.unrelatedTimerWrite===true
  });
  void fresh.catch(()=>{});
  await bounded(store.mutate(()=>{}));
  assert.equal(freshCalls,0);
  assert.deepEqual(events.filter(event=>event.operation==='memory.tick'),[]);
  checkpoint.release();
  await assert.rejects(bounded(tick),/Synthetic tick source became stale/);
  await bounded(fresh);
  assert.equal(guardCalls,1);
  assert.equal(recipeCalls,0);
  assert.equal(freshCalls,1);
  assert.equal(store.state.settings.timerTick,true);
  const ticks=events.filter(event=>event.operation==='memory.tick');
  assert.deepEqual(ticks.map(event=>event.status),['failed','committed']);
  assert.equal(ticks[0].acceptedToCommitMs,null);
  assert.ok(ticks[0].acceptedAt<=ordinary.acceptedAt);
  assert.ok(ticks[0].acceptedAt+ticks[0].queueMs>=ordinary.committedAt);
  assert.ok(ticks[1].acceptedToCommitMs>=ticks[1].queueMs+ticks[1].commitMs);
 }finally{
  releaseWriter.resolve();
  checkpoint.release();
 }
});

test('B1 closing the store cannot resume a parked memory tick after maintenance fails',async t=>{
 const {store,audit}=await fixture(t,{core:false});
 const checkpoint=holdScheduledCheckpointReply();
 let ran=false;
 const deadline=AbortSignal.timeout(5000),timedOut=new Promise((_,reject)=>{
  deadline.addEventListener('abort',()=>reject(Error('Closing a parked memory tick did not complete')),{once:true});
 });
 const bounded=promise=>Promise.race([promise,timedOut]);
 try{
  await store.mutate(state=>{state.settings.timerFlight=true;});
  await bounded(checkpoint.arrived);
  const tick=store.mutate(state=>{ran=true;state.settings.cancelledTimerTick=true;},{
   operation:'memory.tick',waitForScheduledCheckpoint:true
  });
  void tick.catch(()=>{});
  await bounded(store.mutate(state=>{state.settings.closeAfterTimerFlight=true;}));
  assert.equal(ran,false);
  const closed=store.close();
  checkpoint.release({message:'Synthetic maintenance reply failure',code:'SQLITE_IOERR'});
  await assert.rejects(bounded(tick),/Companion store is closing/);
  assert.equal((await bounded(closed)).checkpoint.status,'truncated');
  assert.equal(store.state.settings.cancelledTimerTick,undefined);
  assert.ok(audit.some(event=>event.type==='companion-wal-checkpoint'&&event.reason==='scheduled'&&event.status==='failed'&&event.code==='SQLITE_IOERR'));
 }finally{
  checkpoint.release();
 }
});

test('B1 close drains an admitted memory tick batch that has never parked',async t=>{
 const {store,open}=await fixture(t,{core:false});
 const entered=Promise.withResolvers(),releaseWriter=Promise.withResolvers();
 const writer=store.mutate(async()=>{entered.resolve();await releaseWriter.promise;});
 try{
  await entered.promise;
  const tick=store.mutate(state=>{state.settings.drainedTickBatch=true;},{
   operation:'memory.tick',waitForScheduledCheckpoint:true
  });
  void tick.catch(()=>{});
  const closed=store.close();
  await assert.rejects(store.mutate(()=>{},{operation:'memory.tick',waitForScheduledCheckpoint:true}),
   /Companion store is closing/);
  releaseWriter.resolve();
  await writer;
  await tick;
  await closed;
  const reopened=await open();
  assert.equal(reopened.state.settings.drainedTickBatch,true);
 }finally{
  releaseWriter.resolve();
 }
});

test('B1 the final memory tick patch remains visible to drain before a scheduled checkpoint reply',async t=>{
 const {store}=await fixture(t,{core:false});
 const memory=createCompanionMemory({store,now:()=>at,autoStart:false,
  runModel:async()=>{throw Error('Unexpected memory model request');}});
 await memory.sync(characterId);
 const checkpoint=holdScheduledCheckpointReply();
 const accepted=Promise.withResolvers(),readMemory=store.readMemory,mutate=store.mutate;
 const deadline=AbortSignal.timeout(5000),timedOut=new Promise((_,reject)=>{
  deadline.addEventListener('abort',()=>reject(Error('Final memory patch ordering did not complete')),{once:true});
 });
 const bounded=promise=>Promise.race([promise,timedOut]);
 let streamed=0;
 store.readMemory=async(method,args,options,onModel,onBatch)=>{
  const result=await readMemory(method,args,options,onModel,(...batch)=>{
   streamed++;
   return onBatch(...batch);
  });
  result.patch.memorySettings={...result.patch.memorySettings,finalTickFixture:true};
  return result;
 };
 store.mutate=(fn,options)=>{
  const task=mutate(fn,options);
  if(options?.operation==='memory.tick')accepted.resolve();
  return task;
 };
 try{
  await store.mutate(state=>{state.settings.finalTickTimerFlight=true;});
  await bounded(checkpoint.arrived);
  const tick=memory.tick();
  void tick.catch(()=>{});
  await bounded(accepted.promise);
  assert.equal(streamed,0);
  await bounded(store.drain());
  assert.equal(store.state.memorySettings.finalTickFixture,true);
  const flushing=store.flush();
  void flushing.catch(()=>{});
  checkpoint.release();
  assert.equal((await bounded(flushing)).checkpoint.reason,'flush');
  await bounded(tick);
 }finally{
  checkpoint.release();
  store.mutate=mutate;
  store.readMemory=readMemory;
  await memory.close();
 }
});


for(const rows of [63,64])test('completed memory patch publishes atomically with '+rows+' rows and a new owner',async t=>{
 const {store}=await fixture(t,{core:false,perOwner:0});
 const memory=createCompanionMemory({store,now:()=>at,autoStart:false,
  runModel:async()=>{throw Error('Unexpected memory model request');}});
 const acknowledged=Promise.withResolvers(),release=Promise.withResolvers(),receipts=[],settled=[];
 const on=Worker.prototype.on,namespace='memory.syntheticHeaders';
 const descriptor={array:false,at:['lives',characterId,'memory','syntheticHeaders']};
 const ownerId='synthetic-header-owner',expected=Object.fromEntries(
  Array.from({length:rows},(_,index)=>['header-'+index,{status:'failed',attempt:index}]));
 let final=false,revision,sourceRevision,beforeReadDrain,afterReadDrain;
 t.mock.method(Worker.prototype,'on',function(event,listener){
  if(event!=='message')return on.call(this,event,listener);
  return on.call(this,event,message=>{
   if(final&&message.result?.recordBytes!==undefined){
    receipts.push(message.result);
    if(rows===63){
     acknowledged.resolve(message.result);
     void release.promise.then(()=>listener(message));
     return;
    }
   }
   listener(message);
  });
 });
 try{
  await memory.sync(characterId);
  await store.mutate((_,tx)=>tx.messages.append('private',owner(0),{
   id:messageId(0),characterId,personaId,role:'assistant',status:'presented',text:'Synthetic final ordering source',createdAt:at-1
  }));
  const readMemory=store.readMemory;
  store.readMemory=async(...args)=>{
   const reading=readMemory(...args);
   if(rows===63)beforeReadDrain=store.drain().then(()=>settled.push('before read result'));
   const result=await reading;
   // A completed-read patch at the logical batch limit can also add a descriptor.
   result.patch.changes=Object.entries(expected).map(([key,value])=>({
    type:'put',namespace,owner:ownerId,key,value,descriptor
   }));
   revision=store.state.revision;sourceRevision=store.memorySourceRevision;
   if(rows===63)afterReadDrain=new Promise(resolve=>setImmediate(resolve)).then(()=>store.drain()).then(()=>settled.push('after read'));
   final=true;
   return result;
  };
  const syncing=memory.sync(characterId);
  if(rows===63){
   const ack=await Promise.race([acknowledged.promise,syncing.then(()=>{throw Error('Missing final worker acknowledgement');})]);
   assert.equal(ack.rows,64);
   const draining=store.drain().then(()=>settled.push('drain'));
   const flushing=store.flush().then(()=>settled.push('flush'));
   const snapshot=store.snapshotAsync({characterId}).then(value=>{settled.push('snapshot');return value;});
   await new Promise(resolve=>setImmediate(resolve));
   assert.deepEqual([...settled],[]);
   assert.equal(store.records.hasOwner(namespace,ownerId),false);
   assert.equal(store.state.revision,revision);
   assert.equal(store.memorySourceRevision,sourceRevision);
   release.resolve();
   await Promise.all([beforeReadDrain,afterReadDrain,draining,flushing]);
   const observed=await snapshot;
   assert.equal(observed.revision,revision+1);
   assert.deepEqual(observed.lives[characterId].memory.syntheticHeaders,expected);
  }
  await syncing;
  assert.equal(store.records.count('memory.events',characterId),1);
  assert.equal(receipts.length,rows===63?1:0);
  assert.equal(store.state.revision,revision+1);
  assert.equal(store.memorySourceRevision,revision+1);
  assert.deepEqual(store.records.object(namespace,ownerId),expected);
 }finally{
  release.resolve();
  await memory.close();
 }
});


test('B1 reader drain cancels a parked streamed memory batch before it can publish',async t=>{
 const {store}=await fixture(t,{core:false});
 const published=[],events=channel('ai-buddy.companion.memory-publisher'),record=event=>published.push(event);
 events.subscribe(record);
 t.after(()=>events.unsubscribe(record));
 const memory=createCompanionMemory({store,now:()=>at,autoStart:false,
  runModel:async()=>{throw Error('Unexpected memory model request');}});
 const checkpoint=holdScheduledCheckpointReply();
 const accepted=Promise.withResolvers(),mutate=store.mutate;
 store.mutate=(fn,options)=>{
  const task=mutate(fn,options);
  if(options?.operation==='memory.tick'){
   void task.catch(()=>{});
   accepted.resolve({task});
  }
  return task;
 };
 const deadline=AbortSignal.timeout(5000),timedOut=new Promise((_,reject)=>{
  deadline.addEventListener('abort',()=>reject(Error('Streamed memory cancellation did not complete')),{once:true});
 });
 const bounded=promise=>Promise.race([promise,timedOut]);
 const retriable={code:'COMPANION_WORKER_RETRY'};
 try{
  await store.mutate(state=>{state.settings.streamTimerFlight=true;});
  await bounded(checkpoint.arrived);
  const revision=store.state.revision;
  const tick=memory.tick();
  void tick.catch(()=>{});
  const {task:batch}=await bounded(accepted.promise);
  await bounded(store.drainReads());
  await assert.rejects(bounded(tick),retriable);
  assert.equal(store.state.revision,revision);
  checkpoint.release();
  await assert.rejects(bounded(batch),retriable);
  assert.equal(store.state.revision,revision);
  assert.equal(store.records.count('memory.events',characterId),0);
  assert.equal(published.length,0);
  await bounded(memory.tick());
  assert.equal(store.records.count('memory.events',characterId),20);
  assert.ok(published.some(event=>event.rows>=20));
 }finally{
  checkpoint.release();
  store.mutate=mutate;
  await memory.close();
 }
});


test('B1 store close stops a live tick publisher even when reader close fails',async t=>{
 const {store,open}=await fixture(t,{core:false});
 const memory=createCompanionMemory({store,now:()=>at,autoStart:false,
  runModel:async()=>{throw Error('Unexpected memory model request');}});
 const post=Worker.prototype.postMessage;
 let reader,publisher,publisherExited=false,readerExit;
 Worker.prototype.postMessage=function(message,...args){
  if(message.data?.operation==='memory')reader=this;
  if(message.data?.plan?.recordStages&&!publisher){
   publisher=this;
   this.once('exit',()=>{publisherExited=true;});
  }
  if(message.close&&this===reader){
   readerExit=this.terminate();
   throw Error('Injected reader close failure');
  }
  return post.call(this,message,...args);
 };
 try{
  await memory.tick();
  await memory.close();
  assert.ok(publisher&&!publisherExited,'the publisher is still available for the next tick');
  const closing=store.close();
  // The fixture cleanup encounters the same memoized close result.
  store.close=()=>closing.catch(()=>{});
  await assert.rejects(closing,/Injected reader close failure/);
  assert.equal(publisherExited,true);
  await readerExit;
 }finally{
  Worker.prototype.postMessage=post;
  await memory.close();
 }
 const reopened=await open();
 assert.equal(reopened.records.count('memory.events',characterId),20);
});

test('B1 flush runs PASSIVE and only quiescent last close truncates',async t=>{
 const {store,path,audit}=await fixture(t);
 for(let index=1;index<=12;index++)await store.mutate((_,tx)=>{
  tx.messages.update('private',owner(0),messageId(index),row=>{row.text='SYNTHETIC'.repeat(1200)+index;});
 });
 const walBefore=(await readFile(path+'-wal')).length;
 assert.ok(walBefore>0);
 const result=await store.flush();
 assert.equal(result.checkpoint.status,'checkpointed');
 const checkpoint=audit.find(event=>event.type==='companion-wal-checkpoint'&&event.reason==='flush');
 assert.ok(checkpoint,'worker produced a PASSIVE flush receipt');
 assert.ok(checkpoint.log>0);
 assert.equal(checkpoint.checkpointed,checkpoint.log);
 assert.ok((await stat(path+'-wal')).size>0,'an ordinary flush leaves a reusable WAL');
 assert.equal((await store.close()).checkpoint.status,'truncated');
 assert.equal(await stat(path+'-wal').then(value=>value.size,error=>{if(error.code==='ENOENT')return 0;throw error;}),0);
});


test('B2 sustained writes above the WAL high-water mark checkpoint without waiting for idle',{skip:process.env.AI_BUDDY_R16_STORAGE_TIMING!=='1'},async t=>{
 const {store,path,audit}=await fixture(t);
 const body='L'.repeat(100000);
 let writes=0;
 const deadline=Date.now()+2500;
 while(!audit.some(row=>row.type==='companion-wal-checkpoint'&&row.status==='checkpointed')&&Date.now()<deadline){
  for(let index=0;index<32;index++)await store.mutate((_,tx)=>{
   tx.messages.append('private',owner(0),{id:'wal-write-'+writes++,characterId,personaId,role:'user',text:body,createdAt:at});
  },{storeImages:false});
  await delay(15);
 }
 const checkpoint=audit.find(row=>row.type==='companion-wal-checkpoint'&&row.status==='checkpointed');
 assert.ok(checkpoint,'high-water PASSIVE runs during active writes');
 assert.ok(checkpoint.log>=4000);
 assert.equal(checkpoint.log,checkpoint.checkpointed);
 assert.match(checkpoint.walGeneration,/^[a-f0-9]{16}$/);
 assert.ok(checkpoint.commits>0);
 // The active checkpoint covered its snapshot. Finish covering the last
 // writes in the burst before testing how the next write reuses the WAL.
 const {checkpoint:quiescent}=await store.flush();
 assert.equal(quiescent.reason,'flush');
 assert.equal(quiescent.status,'checkpointed');
 assert.equal(quiescent.checkpointed,quiescent.log);
 await store.mutate((_,tx)=>tx.messages.append('private',owner(0),{id:'after-checkpoint',characterId,personaId,
  role:'user',text:'post-checkpoint reuse',createdAt:at}),{storeImages:false});
 const reusedBytes=(await stat(path+'-wal')).size;
 assert.ok(reusedBytes<=8*1024*1024);
 assert.equal(store.messages.count('private',owner(0)),20+writes+1);
 t.diagnostic(JSON.stringify({writes,checkpoint,quiescent,reusedBytes}));
});


test('A1 legacy unversioned restore source resumes from an r15 cursor without reordering its coverage rows',async t=>{
 const {root,path,store,open,boot,life}=await fixture(t,{core:false,perOwner:80,mutateSource(state){
  const cutoff=[{id:'one',hash:'cutoff hash',revision:0}],memory=state.lives[characterId].memory;
  memory.events={'synthetic-evidence':{id:'synthetic-evidence',text:'evidence'}};
  memory.jobs={'2024-10-27':{status:'failed',cutoff}};
  memory.summaries={'2024-10-27':{text:'summary',cutoff,eventIds:['one'],segments:[{text:'segment'}]}};
 }});
 const archived=await life.save(characterId),repository=createLifeArchiveRepository({dataRoot:root});
 const {snapshot:target}=repository.read(archived.id,archived.sha256);
 const id=randomUUID(),operationId=randomUUID(),staging={cursor:32,complete:false,sha256:writeLifeRestoreSource(path,id,target)};
 const messageOwner=JSON.stringify([id,owner(0)]);
 const owners=['life.personalEvents','memory.events','memory.jobs','memory.summaries'];
 const recordOwner=JSON.stringify([id,characterId]);
 await store.mutate((state,tx)=>{
  // An older companion store wrote these rows and this cursor together.
  tx.messages.define('transaction-private',messageOwner,['lifeTransaction','staged','conversations',owner(0)]);
  for(const namespace of owners){
   const field=namespace.split('.').at(-1),base=['lifeTransaction','staged','lives',characterId];
   tx.records.define('staged.'+namespace,recordOwner,{
    at:namespace.startsWith('memory.')?[...base,'memory',field]:[...base,field],
    array:namespace.startsWith('life.')
   });
  }
  for(const row of target.conversations[0].messages.slice(0,27))
   tx.messages.append('transaction-private',messageOwner,row,{preserveDuplicate:true});
  state.lifeTransaction={id,characterId,operationId,kind:'restore',archiveId:archived.id,target:{},staging};
 });
 await store.close();
 const reopened=await open(),service=await boot(reopened);
 assert.equal(service.recovery(),null);
 assert.equal(reopened.state.lastLifeTransaction.status,'committed');
 const restored=await reopened.snapshotAsync({characterId});
 assert.equal(restored.conversations[owner(0)].messages.length,80);
 assert.deepEqual(restored.conversations[owner(0)].messages.map(row=>row.id),target.conversations[0].messages.map(row=>row.id));
 assert.deepEqual(restored.lives[characterId].memory,target.life.memory);
});

test('A1 reconciles a lost stage acknowledgement before rolling back the interrupted restore',async t=>{
 const {store,life,open,boot}=await fixture(t,{perOwner:85});
 const saved=await life.save(characterId);
 await store.close();
 const reopened=await open(),service=await boot(reopened);
 const on=Worker.prototype.on,post=Worker.prototype.postMessage;
 const batches=new WeakMap();
 let missed=false;
 Worker.prototype.on=function(event,callback){
  if(event!=='message')return on.call(this,event,callback);
  return on.call(this,event,message=>{
   if(!missed&&message.id!==undefined&&message.id===batches.get(this)&&message.result?.revision){
    missed=true;
    void this.terminate();
   }else callback(message);
  });
 };
 Worker.prototype.postMessage=function(message,...transfer){
  if(message.data?.operation==='write-life-restore-batch')batches.set(this,message.id);
  return post.call(this,message,...transfer);
 };
 try{
  // A dead producer has to be re-opened/resumed. The committed cursor and rows
  // must agree even when the original acknowledgement and producer were lost.
  const mutate=reopened.mutate;
  let cursor;
  reopened.mutate=async(...args)=>{
   const receipt=await mutate.apply(reopened,args);
   if(missed&&args[1]?.operation==='life-restore-stage')cursor=reopened.state.lifeTransaction.staging.cursor;
   return receipt;
  };
  await assert.rejects(service.restore(saved.id),/retry the request/);
  assert.equal(missed,true);
  assert.equal(cursor,32);
  assert.equal(reopened.state.lastLifeTransaction.status,'rolled-back');
  assert.equal(reopened.messages.count('private',owner(0)),85);
 }finally{Worker.prototype.on=on;Worker.prototype.postMessage=post;}
});


test('A1 archive restore validates each image using the host codec and preserves projected content',async t=>{
 const avatar='data:image/png;base64,AQIDBA==',decoded=[];
 let valid=true,restoredContent;
 const storedContent={cgs:[{id:'synthetic-cg',status:'available',image:avatar}],projectionLabel:'saved'};
 const {life,store}=await fixture(t,{core:false,mutateSource(state){state.cards[characterId].avatar=avatar;},savedOptions:{
  imageCodec:bytes=>{decoded.push(Buffer.from(bytes).toString('hex'));return valid;},
  call:async(action,{content}={})=>{
   if(action==='companion-life-content')return {ok:true,content:storedContent};
   if(action==='companion-life-project')restoredContent=content;
   return {ok:true};
  }
 }});
 const saved=await life.save(characterId);
 await store.mutate(state=>{state.cards[characterId].avatar='';});
 valid=false;
 await assert.rejects(life.restore(saved.id),/存档图片无法解码/);
 assert.equal(store.state.cards[characterId].avatar,'');
 assert.equal(store.state.lifeTransaction,undefined);
 assert.equal(restoredContent,undefined);
 valid=true;
 await life.restore(saved.id);
 assert.deepEqual(restoredContent,storedContent);
 assert.equal(store.state.cards[characterId].avatar,avatar);
 assert.ok(decoded.length>=3&&decoded.every(bytes=>bytes==='01020304'));
});


test('A6 an older rolling-back transaction clears its materialized target off the desktop',async t=>{
 const {root,store,life,open,boot}=await fixture(t,{core:false});
 const saved=await life.save(characterId),repository=createLifeArchiveRepository({dataRoot:root});
 const {snapshot:target}=repository.read(saved.id,saved.sha256),id=randomUUID();
 const messageOwner=JSON.stringify([id,0]),path=['lifeTransaction','target','conversations','0'];
 await store.mutate((state,tx)=>{
  const [{messages,...conversation}]=target.conversations;
  state.lifeTransaction={id,characterId,phase:'rolling-back',archiveId:saved.id,kind:'restore',
   target:{...target,conversations:[conversation]}};
  tx.messages.define('transaction-private',messageOwner,path);
  for(const row of messages)tx.messages.append('transaction-private',messageOwner,row,{preserveDuplicate:true});
 });
 await store.close();
 const deleted=[],prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(!/^DELETE FROM messages WHERE /.test(sql.trim()))return statement;
  const run=statement.run;
  statement.run=function(...bindings){
   if(bindings[0]==='transaction-private')deleted.push(bindings[0]);
   return run.apply(this,bindings);
  };
  return statement;
 };
 try{
  const reopened=await open(),service=await boot(reopened);
  assert.equal(service.recovery(),null);
  assert.equal(reopened.state.lastLifeTransaction.status,'rolled-back');
  assert.equal(reopened.messages.count('private',owner(0)),20);
  assert.deepEqual(deleted,[]);
 }finally{DatabaseSync.prototype.prepare=prepare;}
});


test('restore reports the exact missing CG list from the automatic before-restore archive',async t=>{
 let before=[];
 const {store,life}=await fixture(t,{core:false,savedOptions:{
  call:async(action)=>{
   if(action!=='companion-life-content')return {ok:true};
   return {ok:true,content:{cgs:before}};
  }
 }});
 const saved=await life.save(characterId);
 const assetRef='cg-assets/missing-before-restore.png';
 before=[{id:'missing-before-restore',label:'before-restore CG',at,level:2,kind:'private',assetRef}];
 await assert.rejects(life.restore(saved.id),{
  code:'LIFE_ARCHIVE_MISSING_CG',
  missing:[{cgId:'missing-before-restore',label:'before-restore CG',at,level:2,kind:'private',groupId:null,ref:assetRef}]
 });
 assert.equal(store.state.lifeTransaction,undefined);
});


test('replay prepares an old SQLite transaction without transporting its historical rows through the desktop',async t=>{
 const {root,store,life,open,boot}=await fixture(t);
 const saved=await life.save(characterId),repository=createLifeArchiveRepository({dataRoot:root});
 const {snapshot:target}=repository.read(saved.id,saved.sha256),id=randomUUID(),operationId=randomUUID();
 const [{messages,...conversation}]=target.conversations;
 target.life.memory={events:{legacy:{id:'legacy',text:'legacy derived row'}}};
 const {events,...memory}=target.life.memory;
 const scope=target.coreState.feeding.scope;
 await store.mutate((state,tx)=>{
  state.lifeTransaction={id,characterId,operationId,phase:'prepared',kind:'restore',archiveId:saved.id,
   beforeScope:scope,targetScope:{...scope,operationId},target:{...target,conversations:[conversation],life:{...target.life,memory}}};
  const messageOwner=JSON.stringify([id,0]),recordOwner='transaction:'+id;
  tx.messages.define('transaction-private',messageOwner,['lifeTransaction','target','conversations','0']);
  for(const row of messages)tx.messages.append('transaction-private',messageOwner,row,{preserveDuplicate:true});
  tx.records.define('memory.events',recordOwner,{at:['lifeTransaction','target','life','memory','events']});
  for(const [key,row] of Object.entries(events))tx.records.put('memory.events',recordOwner,key,row);
  tx.messages.update('private',owner(0),messageId(1),row=>{row.text='pre-replay edit';});
  state.lives[characterId].operationId=operationId;
 });
 await store.close();
 const reopened=await open();
 const oldSnapshot=reopened.snapshotAsync,oldSeal=reopened.sealLifeRestoreSource;
 const relays=[];
 reopened.snapshotAsync=function(scope){
  if(scope?.transaction)relays.push('target returned to desktop');
  return oldSnapshot.call(this,scope);
 };
 reopened.sealLifeRestoreSource=function(id,target){
  if(target.conversations?.some(row=>Array.isArray(row.messages)))relays.push('target sent back to worker');
  return oldSeal.call(this,id,target);
 };
 const service=await boot(reopened);
 assert.equal(service.recovery(),null);
 assert.equal(reopened.state.lastLifeTransaction.status,'committed');
 const snapshot=await reopened.snapshotAsync({characterId});
 assert.deepEqual(snapshot.conversations[owner(0)].messages,messages);
 assert.deepEqual(snapshot.lives[characterId].memory.events,events);
 assert.deepEqual(relays,[]);
});

test('an old core-enabled rollback does not rewrite the legacy target on the desktop',async t=>{
 const {root,store,life,open,boot}=await fixture(t);
 const saved=await life.save(characterId),repository=createLifeArchiveRepository({dataRoot:root});
 const {snapshot:target}=repository.read(saved.id,saved.sha256),id=randomUUID();
 const operationId=randomUUID(),beforeScope=target.coreState.feeding.scope;
 const [{messages,...conversation}]=target.conversations;
 await store.mutate((state,tx)=>{
  state.lifeTransaction={id,characterId,operationId,phase:'rolling-back',kind:'restore',archiveId:saved.id,
   beforeScope,targetScope:{...beforeScope,operationId},target:{...target,conversations:[conversation]}};
  const messageOwner=JSON.stringify([id,0]);
  tx.messages.define('transaction-private',messageOwner,['lifeTransaction','target','conversations','0']);
  for(const row of messages)tx.messages.append('transaction-private',messageOwner,row,{preserveDuplicate:true});
 });
 await store.close();
 const deleted=[],prepare=DatabaseSync.prototype.prepare;
 DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  if(!/^DELETE FROM messages WHERE /.test(sql.trim()))return statement;
  const run=statement.run;
  statement.run=function(...bindings){
   if(bindings[0]==='transaction-private')deleted.push(bindings[0]);
   return run.apply(this,bindings);
  };
  return statement;
 };
 try{
  const reopened=await open(),service=await boot(reopened);
  assert.equal(service.recovery(),null);
  assert.equal(reopened.state.lastLifeTransaction.status,'rolled-back');
  assert.equal(reopened.messages.count('private',owner(0)),20);
  assert.deepEqual(deleted,[]);
 }finally{DatabaseSync.prototype.prepare=prepare;}
});
