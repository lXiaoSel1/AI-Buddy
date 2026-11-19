import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {channel} from 'node:diagnostics_channel';
import {Worker} from 'node:worker_threads';
import {ensureLives} from '../src/companion-life.mjs';
import {createCompanionMemory} from '../src/companion-memory.mjs';
import {exportCompanionForRollback,makeCard,openCompanionStore} from '../src/companion-store.mjs';

const characterId='synthetic-character',otherId='other-character',personaId='default';
const owner='synthetic-chat',at=1730000060000;
const message=(index,character,text)=>({id:'message-'+index,role:'assistant',characterId:character,personaId,status:'presented',text,createdAt:at-20000+index});

async function fixture(t,{count=0,total=count,large=false,mutateSource,source,options}={}){
  const root=await mkdtemp(join(tmpdir(),'buddy-storage-r15-'));
  const stores=[],services=[];
  t.after(async()=>{
    for(const service of services.reverse())await service.close();
    for(const store of stores.reverse())await store.close();
    await rm(root,{recursive:true,force:true});
  });
  const folder=join(root,'galgame');
  await mkdir(folder);
  source??={
    schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:0,
    activeCharacterId:characterId,activePersonaId:personaId,
    conversations:Object.fromEntries([[owner,characterId,count],['other-chat',otherId,total-count]].map(([id,character,length])=>[id,{id,characterId:character,personaId,messages:Array.from({length},(_,index)=>message(index,character,large&&character===characterId?'synthetic history '.repeat(165)+index:'synthetic history '+index))}])),
    groups:{},relationships:{},cards:Object.fromEntries([characterId,otherId].map(id=>[id,makeCard({id,name:id})])),
    personas:{[personaId]:{id:personaId,name:'Synthetic persona'}},lives:{},settings:{},memorySettings:{timeZone:'UTC'}
  };
  ensureLives(source,at);
  mutateSource?.(source);
  await writeFile(join(folder,'companion.json'),JSON.stringify(source));
  const open=async()=>{const store=await openCompanionStore(root,options);stores.push(store);return store;};
  return {store:await open(),root,path:join(folder,'companion.sqlite'),open,source,services};
}

function memoryFor(store,options={}){
  return createCompanionMemory({store,now:()=>at,autoStart:false,runModel:async()=>{throw Error('Unexpected memory model request');},...options});
}

function traceWrites(t){
  const exec=DatabaseSync.prototype.exec;
  const prepare=DatabaseSync.prototype.prepare;
  const batches=[];
  let current=null,enabled=false,measureRecordBytes=false,readPhase;
  DatabaseSync.prototype.exec=function(sql,...args){
    if(enabled&&sql==='BEGIN IMMEDIATE'){
      const result=exec.call(this,sql,...args);
      current={started:performance.now(),recordWrites:0,recordBytes:0,messageInserts:0,execs:0,bulk:{}};
      if(readPhase)Object.assign(current,{phase:readPhase(),changed:false,namespaces:new Set()});
      return result;
    }
    if(sql==='ROLLBACK')current=null;
    if(sql!=='COMMIT'||!current)return exec.call(this,sql,...args);
    const startedCommit=performance.now(),result=exec.call(this,sql,...args);
    const end=performance.now();
    batches.push({...current,elapsedMs:end-current.started,commitMs:end-startedCommit});
    current=null;
    return result;
  };
  DatabaseSync.prototype.prepare=function(sql,...args){
    const stmt=prepare.call(this,sql,...args),run=stmt.run.bind(stmt);
    stmt.run=(...values)=>{
      const started=performance.now(),result=run(...values);
      if(current){
        const name=sql.trim();
        if(/^(?:DELETE FROM|UPDATE) (?:messages|records) SET |^DELETE FROM (?:messages|records) WHERE /.test(name))
          current.bulk[name]=(current.bulk[name]??0)+performance.now()-started;
        current.execs++;
        if(name.startsWith('INSERT INTO messages'))current.messageInserts+=Number(result.changes);
        if(measureRecordBytes&&name.startsWith('INSERT INTO records'))current.recordBytes+=Buffer.byteLength(values[4]);
        if(/^(?:INSERT(?: OR IGNORE)? INTO|DELETE FROM|UPDATE) (?:record_owners|records)\b/i.test(name)){
          current.recordWrites+=Number(result.changes);
          if(result.changes)current.namespaces?.add(values[0]);
        }
        if(current.namespaces&&/^UPDATE state(?:_sections)? SET (?:revision=\?,)?value=/.test(name))current.changed=true;
      }
      return result;
    };
    return stmt;
  };
  const stop=()=>{DatabaseSync.prototype.exec=exec;DatabaseSync.prototype.prepare=prepare;};
  t.after(stop);
  return {batches,stop,pause:()=>{enabled=false;},start:({recordBytes=false,phase}={})=>{
    enabled=true;measureRecordBytes=recordBytes;readPhase=phase;
  }};
}

function traceMemoryPublications(t){
  const publications=[],events=channel('ai-buddy.companion.memory-publisher');
  const record=event=>publications.push(event);
  events.subscribe(record);
  t.after(()=>events.unsubscribe(record));
  return publications;
}

test('first memory sync batches 1,200 derived rows from a 12,000-message database',async t=>{
  const {batches,start,stop}=traceWrites(t),publications=traceMemoryPublications(t);
  const {store}=await fixture(t,{count:1200,total:12000,large:true});
  const memory=memoryFor(store);
  start();
  try{await memory.sync(characterId);}finally{stop();await memory.close();}
  const sync=publications.filter(row=>row.operation==='memory.sync');
  assert.ok(sync.length>1);
  const maxRows=Math.max(...sync.map(row=>row.rows));
  const maxMs=Math.max(...batches.map(row=>row.elapsedMs),...sync.map(row=>row.mainThreadMs));
  t.diagnostic(JSON.stringify({batches:sync.length,maxRows,maxMs,maximumCommitMs:Math.max(...sync.map(row=>row.workerCommitMs))}));
  assert.equal(store.records.count('memory.events',characterId),1200);
  assert.equal(batches.reduce((sum,row)=>sum+row.recordWrites,0),0);
  assert.ok(maxRows<=64,'each worker transaction writes at most 64 record/owner rows');
  if(process.env.AI_BUDDY_R15_STORAGE_TIMING==='1')assert.ok(maxMs<15,'each transaction takes less than 15 ms in isolation');
});

test('streamed memory tick publishes durable records without main-thread record SQL',async t=>{
  const {batches,start,stop}=traceWrites(t);
  const audit=[],published=traceMemoryPublications(t),traces=[];
  const writeLatency=channel('ai-buddy.companion.write-latency'),recordTrace=trace=>traces.push(trace);
  const previousTrace=process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE;
  process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE='1';
  writeLatency.subscribe(recordTrace);
  t.after(()=>{
    writeLatency.unsubscribe(recordTrace);
    if(previousTrace===undefined)delete process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE;
    else process.env.AI_BUDDY_R17_COMPANION_WRITE_TRACE=previousTrace;
  });
  const {store,open}=await fixture(t,{count:130,options:{audit:event=>audit.push(event)}});
  const memory=memoryFor(store),post=Worker.prototype.postMessage,on=Worker.prototype.on;
  const publishers=new Set(),requests=[],inconsistent=[];
  const initialRevision=store.state.revision;
  let observations=0;
  Worker.prototype.postMessage=function(message,...args){
    if(message.data?.plan?.recordStages){
      publishers.add(this);
      const {data}=message;
      requests.push({fields:Object.keys(data).sort(),operation:data.operation,revision:data.currentRevision,
        bytes:[...data.plan.recordStages.values()].reduce((sum,{rows})=>sum+[...rows.values()].reduce(
          (total,row)=>total+(row?Buffer.byteLength(JSON.stringify(row.value)):0),0),0)});
    }
    return post.call(this,message,...args);
  };
  Worker.prototype.on=function(event,handler){
    if(event!=='message')return on.call(this,event,handler);
    return on.call(this,event,message=>{
      if(publishers.has(this)&&message.result?.id){
        const before=store.state.revision,count=store.records.count('memory.events',characterId);
        let checks=0;
        function observe(){
          const revision=store.state.revision,rows=store.records.count('memory.events',characterId);
          observations++;
          if(revision===before&&rows!==count)inconsistent.push({revision,count,rows});
          if(++checks<8)queueMicrotask(observe);
        }
        queueMicrotask(observe);
      }
      handler(message);
    });
  };
  start({recordBytes:true});
  try{await memory.tick();}finally{
    Worker.prototype.postMessage=post;Worker.prototype.on=on;stop();await memory.close();
  }
  assert.equal(batches.reduce((sum,row)=>sum+row.recordWrites,0),0,'streamed tick must perform zero record writes on the main thread');
  assert.ok(observations>0);
  assert.deepEqual(inconsistent,[],'synchronous readers see a consistent database and RAM revision around the worker acknowledgement');
  assert.ok(published.length>1,'a real tick sends multiple bounded record batches');
  assert.ok(audit.every(event=>event.operation!=='memory.tick'||event.type==='companion-slow-transaction'),
    'ordinary tick publisher batches do not write audit entries');
  assert.equal(publishers.size,1,'all batches use the same publisher');
  assert.equal(requests.length,published.length);
  assert.deepEqual(requests.map(row=>row.revision),published.map((_,index)=>initialRevision+index));
  assert.deepEqual(requests.map(row=>row.bytes),published.map(row=>row.recordBytes));
  assert.ok(requests.every(row=>row.operation==='memory.tick'&&row.fields.join(',')==='commitTrace,currentRevision,id,operation,plan,writeMemoryRevision'));
  assert.ok(published.every(row=>row.rows>0&&row.rows<=64&&row.recordBytes>0&&row.recordBytes<=48*1024));
  const commits=traces.filter(trace=>trace.operation==='memory.tick'&&trace.status==='committed');
  assert.equal(commits.length,published.length);
  assert.ok(commits.every(trace=>trace.workerWaitMs>0&&trace.commitMs>=0&&trace.workerMs>=trace.commitMs&&
    trace.acceptedToCommitMs>=trace.queueMs+trace.workerMs));
  assert.equal(store.records.count('memory.events',characterId),130);
  const revision=store.state.revision,sourceRevision=store.memorySourceRevision;
  assert.equal(sourceRevision,initialRevision+published.length);
  const persisted=await store.snapshotAsync();
  await store.close();
  const reopened=await open();
  assert.equal(reopened.state.revision,revision);
  assert.equal(reopened.memorySourceRevision,sourceRevision);
  assert.deepEqual(await reopened.snapshotAsync(),persisted);
});

for(const fault of ['missing','invalid'])test('streamed memory tick requires reopen when the acknowledgement of a committed batch is '+fault,async t=>{
  const {store,open,source}=await fixture(t,{count:20});
  const {count,get,growthRecords}=store.records;
  const initialRevision=store.state.revision,initialMemoryRevision=store.memorySourceRevision;
  const memory=memoryFor(store);
  const post=Worker.prototype.postMessage,on=Worker.prototype.on;
  let publisher,exited=false,committed,pinnedCount,pendingRead;
  Worker.prototype.postMessage=function(message,...args){
    if(message.data?.plan?.recordStages&&!publisher){
      publisher=this;
      this.once('exit',()=>{exited=true;});
    }
    return post.call(this,message,...args);
  };
  Worker.prototype.on=function(event,handler){
    if(event!=='message')return on.call(this,event,handler);
    return on.call(this,event,message=>{
      if(this!==publisher||!message.result?.id||committed)return handler(message);
      committed=message.result;
      pinnedCount=count('memory.events',characterId);
      pendingRead=store.snapshotAsync();
      void pendingRead.catch(()=>{});
      if(fault==='missing'){void this.terminate();return;}
      handler({...message,result:{...committed,id:'incorrect-acknowledgement'}});
    });
  };
  const reopen={code:'COMPANION_STORE_REOPEN_REQUIRED'};
  try{
    await assert.rejects(memory.tick(),reopen);
    assert.equal(exited,true,'the publisher has exited before the failure is exposed');
    assert.equal(committed.revision,initialRevision+1);
    assert.equal(pinnedCount,0,'the main connection sees the old snapshot until acknowledgement');
    assert.equal(store.state.revision,initialRevision);
    assert.equal(store.memorySourceRevision,initialMemoryRevision);
    let reopenError;
    await assert.rejects(pendingRead,error=>{
      reopenError=error;
      return error.code===reopen.code;
    });
    const sameReopenError=error=>error===reopenError;
    assert.throws(()=>count('memory.events',characterId),sameReopenError);
    assert.throws(()=>get('memory.events',characterId,'message-0'),sameReopenError);
    assert.throws(()=>growthRecords(characterId),sameReopenError);
    assert.throws(()=>store.records.object('memory.events',characterId),sameReopenError);
    await assert.rejects(store.mutate(()=>{}),sameReopenError);
  }finally{
    Worker.prototype.postMessage=post;
    Worker.prototype.on=on;
    await memory.close();
  }
  await store.close();
  const reopened=await open(),snapshot=await reopened.snapshotAsync();
  assert.equal(reopened.state.revision,initialRevision+1);
  assert.equal(reopened.memorySourceRevision,initialRevision+1);
  assert.equal(reopened.records.count('memory.events',characterId),20);
  assert.deepEqual(Object.values(snapshot.lives[characterId].memory.events).map(row=>row.text).sort(),
    source.conversations[owner].messages.map(row=>row.text).sort());
});

test('streamed memory tick rechecks its source before dispatching a batch',async t=>{
  const published=traceMemoryPublications(t),{store}=await fixture(t,{count:20});
  const memory=memoryFor(store),readMemory=store.readMemory;
  let changedSource=false;
  store.readMemory=(method,args,options,onModel,onBatch)=>readMemory(method,args,options,onModel,onBatch&&
    (async(...batch)=>{
      if(!changedSource){
        changedSource=true;
        await store.mutate((_,tx)=>tx.messages.update('private',owner,'message-0',row=>{row.text='edited source';}));
      }
      return onBatch(...batch);
    }));
  try{
    await assert.rejects(memory.tick(),/记忆来源在读取过程中已变化/);
    assert.equal(changedSource,true);
    assert.equal(published.length,0);
    assert.equal(store.records.count('memory.events',characterId),0);
    await memory.tick();
    assert.ok(published.length>0);
    const snapshot=await store.snapshotAsync();
    assert.ok(Object.values(snapshot.lives[characterId].memory.events).some(row=>row.text==='edited source'));
  }finally{store.readMemory=readMemory;await memory.close();}
});

test('streamed memory tick recovers after its idle publisher exits',async t=>{
  const {store}=await fixture(t,{count:1});
  const memory=memoryFor(store),post=Worker.prototype.postMessage,publishers=new Set();
  Worker.prototype.postMessage=function(message,...args){
    if(message.data?.plan?.recordStages)publishers.add(this);
    return post.call(this,message,...args);
  };
  try{
    await memory.tick();
    assert.equal(publishers.size,1);
    const [first]=publishers;
    await first.terminate();
    await store.mutate((_,tx)=>tx.messages.append('private',owner,message(1,characterId,'new synthetic history')));
    await memory.tick();
    assert.equal(publishers.size,2);
    assert.equal(store.records.count('memory.events',characterId),2);
  }finally{
    Worker.prototype.postMessage=post;
    await memory.close();
  }
});

test('deleting a middle record produces no changed records in the next memory tick',async t=>{
  const {store}=await fixture(t,{mutateSource:state=>{
    state.lives[characterId].personalEvents=[0,1,2].map(index=>({id:'personal-'+index,text:'synthetic event '+index,role:'user',createdAt:at-10+index}));
  }});
  const memory=memoryFor(store);
  try{
    await memory.tick();
    await store.mutate((_,tx)=>tx.records.delete('life.personalEvents',characterId,'personal-1'));
    const result=await store.readMemory('tick',{skip:null},{at});
    t.diagnostic(JSON.stringify({changedRecords:result.patch.records.length}));
    assert.deepEqual(result.patch.records,[]);
  }finally{await memory.close();}
});

test('interrupted batches remain committed and the next tick converges to an uninterrupted sync',async t=>{
  const reference=await fixture(t,{count:250}),interrupted=await fixture(t,{source:structuredClone(reference.source)});
  const normal=memoryFor(reference.store),retry=memoryFor(interrupted.store);
  try{
    await normal.tick();
    const post=Worker.prototype.postMessage;
    let batches=0,exited=false;
    Worker.prototype.postMessage=function(message,...args){
      if(message.data?.plan?.recordStages&&++batches===2){
        this.once('exit',()=>{exited=true;});
        const data={...message.data,plan:{...message.data.plan,messageMoves:[{}]}};
        return post.call(this,{...message,data},...args);
      }
      return post.call(this,message,...args);
    };
    try{
      await assert.rejects(retry.tick(),/Invalid companion memory record plan/);
      assert.equal(exited,true,'the failed publisher has already exited');
    }finally{Worker.prototype.postMessage=post;}
    const count=interrupted.store.records.count('memory.events',characterId);
    assert.ok(count>0&&count<250);
    await retry.tick();
    const {revision:before,...expected}=await reference.store.snapshotAsync();
    const {revision:after,...actual}=await interrupted.store.snapshotAsync();
    assert.deepEqual(actual,expected);
    assert.equal(interrupted.store.records.count('memory.events',characterId),250);
  }finally{await normal.close();await retry.close();}
});


test('many short statements emit slow transaction and total mutation receipts without message content',async t=>{
  const events=[];
  let clock=0,measuring=false;
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql,...args){
    const stmt=prepare.call(this,sql,...args),run=stmt.run.bind(stmt);
    stmt.run=(...values)=>{
      if(measuring&&sql.trim().startsWith('INSERT INTO records'))clock+=4;
      return run(...values);
    };
    return stmt;
  };
  t.after(()=>{DatabaseSync.prototype.prepare=prepare;});
  const {store}=await fixture(t,{options:{audit:event=>events.push(event),sqlClock:()=>clock}});
  measuring=true;
  await store.mutate((state,tx)=>{
    clock+=7;
    for(let i=0;i<5;i++)tx.records.put('memory.events',characterId,'probe-'+i,{text:'private synthetic content'},{at:['lives',characterId,'memory','events']});
  },{operation:'memory-diagnostic'});
  measuring=false;
  assert.deepEqual(events.filter(row=>row.type==='companion-slow-query'),[]);
  assert.deepEqual(events.filter(row=>row.type==='companion-slow-transaction'),[
    {type:'companion-slow-transaction',operation:'memory-diagnostic',rows:6,elapsedMs:20},
    {type:'companion-slow-transaction',operation:'memory-diagnostic',rows:6,elapsedMs:27,scope:'mutate'}
  ]);
  assert.ok(!JSON.stringify(events).includes('private synthetic content'));
});

test('life publication reports worker wait separately from slow main-thread mutations',async t=>{
  const audit=[];
  let clock=0,launchTime;
  const {store}=await fixture(t,{options:{audit:event=>audit.push(event),sqlClock:()=>clock}});
  const workerStart=channel('ai-buddy.companion.worker-start');
  const waitOnWriter=operation=>{
    if(operation!=='publish-life-restore')return;
    clock+=launchTime;
    queueMicrotask(()=>{clock+=100;});
  };
  workerStart.subscribe(waitOnWriter);
  try{
    for(launchTime of [4,16]){
      await store.mutate(state=>{state.settings.syntheticPublication=launchTime;},
        {operation:'life-restore-publish',publishLifeRestore:true});
      assert.equal(store.state.settings.syntheticPublication,launchTime);
    }
  }finally{workerStart.unsubscribe(waitOnWriter);}
  const publication=audit.filter(event=>event.operation==='life-restore-publish');
  const worker=publication.filter(event=>event.type==='companion-life-restore-worker');
  assert.deepEqual(worker.map(({elapsedMs,mainThreadMs,workerWaitMs})=>({elapsedMs,mainThreadMs,workerWaitMs})),[
    {elapsedMs:104,mainThreadMs:4,workerWaitMs:100},
    {elapsedMs:116,mainThreadMs:16,workerWaitMs:100}
  ]);
  assert.ok(worker.every(event=>Number.isFinite(event.workerElapsedMs)));
  assert.deepEqual(publication.filter(event=>event.type==='companion-slow-transaction'),[
    {type:'companion-slow-transaction',operation:'life-restore-publish',rows:0,elapsedMs:16,scope:'mutate',mainThreadMs:16,workerWaitMs:100}
  ]);
});

test('memory applies its own batch receipt and rejects an intervening source update',async t=>{
  const {store}=await fixture(t,{count:180});
  const memory=memoryFor(store);
  const mutate=store.mutate.bind(store);
  let inserted=false;
  store.mutate=async(fn,options)=>{
    const result=await mutate(fn,options);
    if(!inserted&&store.records.count('memory.events',characterId)>0&&store.records.count('memory.events',characterId)<180){
      inserted=true;
      await mutate((_,tx)=>tx.messages.update('private',owner,'message-175',row=>{row.text='new source while memory applied';}));
    }
    return result;
  };
  try{
    await assert.rejects(memory.sync(characterId),/记忆来源在读取过程中已变化/);
    assert.equal(inserted,true);
    await memory.tick();
    const result=await memory.view({characterId,personaId,conversationId:owner});
    assert.ok(result.events.some(event=>event.text==='new source while memory applied'));
  }finally{await memory.close();}
});

test('a large WAL checkpoints on the worker after two idle seconds',async t=>{
  const audits=[],configuration=[];
  const exec=DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec=function(sql,...args){
    const result=exec.call(this,sql,...args);
    if(sql.includes('PRAGMA journal_mode=WAL')){
      configuration.push(Object.fromEntries(['synchronous','busy_timeout','wal_autocheckpoint'].map(name=>[name,Object.values(this.prepare('PRAGMA '+name).get())[0]])));
    }
    return result;
  };
  t.after(()=>{DatabaseSync.prototype.exec=exec;});
  const {store}=await fixture(t,{options:{audit:event=>audits.push(event)}});
  const body='synthetic fixture body '.repeat(5000);
  for(let i=0;i<42;i++)await store.mutate((_,tx)=>tx.messages.append('private',owner,message(i,characterId,body)));
  assert.deepEqual(configuration,[{synchronous:1,busy_timeout:0,wal_autocheckpoint:0}]);
  const lastWrite=performance.now();
  assert.deepEqual(audits.filter(row=>row.type==='companion-wal-checkpoint'),[]);
  while(!audits.some(row=>row.type==='companion-wal-checkpoint')&&performance.now()-lastWrite<4500)
    await new Promise(resolve=>setTimeout(resolve,30));
  const checkpoint=audits.find(row=>row.type==='companion-wal-checkpoint');
  assert.ok(checkpoint,'idle WAL checkpoint was reported');
  assert.ok(checkpoint.log>=1000);
  assert.equal(checkpoint.log,checkpoint.checkpointed);
  assert.ok(performance.now()-lastWrite>=2000);
});

test('busy close and session-end flush preserve the committed WAL and open again',async t=>{
  let flush;
  const {store,path,open}=await fixture(t,{options:{deferredSaveRegistry:{register(_,options){flush=options.flushSync;return ()=>{};}}}});
  const reader=new DatabaseSync(path,{readOnly:true});
  let held=true;
  t.after(()=>{if(held)reader.close();});
  reader.exec('BEGIN');
  reader.prepare('SELECT revision FROM state').get();
  const item=message(1,characterId,'committed synthetic message');
  await store.mutate((_,tx)=>tx.messages.append('private',owner,item));
  const result=flush();
  assert.equal(result.checkpoint.status,'busy');
  const reading=store.messages.history('private',owner);
  const closed=await store.close();
  assert.equal(closed.checkpoint.status,'busy');
  assert.equal((await reading).messages[0].id,item.id);
  reader.close();held=false;
  const reopened=await open();
  assert.deepEqual(reopened.messages.get('private',owner,item.id),item);
});

test('one reader worker serves concurrent requests and recovers after a worker crash',async t=>{
  const {store}=await fixture(t,{count:3});
  const starts=[],readStarts=channel('ai-buddy.companion.worker-start'),track=operation=>starts.push(operation);
  readStarts.subscribe(track);
  t.after(()=>readStarts.unsubscribe(track));
  await Promise.all([store.messages.history('private',owner),store.snapshotAsync()]);
  await store.messages.history('private',owner);
  assert.equal(starts.length,1);
  const post=Worker.prototype.postMessage;
  let interrupted=false;
  Worker.prototype.postMessage=function(message,...args){
    if(!interrupted){
      interrupted=true;
      void this.terminate();
    }
    return post.call(this,message,...args);
  };
  try{await assert.rejects(store.messages.history('private',owner),{code:'COMPANION_WORKER_RETRY'});}
  finally{Worker.prototype.postMessage=post;}
  assert.equal((await store.messages.history('private',owner)).totalCount,3);
  assert.equal(starts.length,2);
});

test('three receipt-only writes during context reads keep the original memory snapshot valid',async t=>{
  const {store}=await fixture(t,{count:3});
  const memory=memoryFor(store);
  const read=store.readMemory.bind(store);
  let attempts=0;
  store.readMemory=async(...args)=>{
    const result=await read(...args);
    const start=attempts++===0?0:3;
    for(let i=start;i<(start===0?3:4);i++)await store.mutate((_,tx)=>{
      tx.messages.update('private',owner,'message-1',row=>{
        row.voicePresentation??=[];
        row.voicePresentation.push({segmentId:'synthetic-voice-'+i,status:'played',at:at+i});
      });
    });
    return result;
  };
  try{
    const before=store.memorySourceRevision;
    const result=await memory.context({characterId,personaId,conversationId:owner});
    assert.equal(attempts,1,'a context is not retried for playback receipts');
    assert.equal(store.memorySourceRevision,before);
    assert.equal(result.messages.length,3);
    assert.equal(store.messages.get('private',owner,'message-1').voicePresentation.length,3);
    await store.mutate((_,tx)=>tx.messages.update('private',owner,'message-1',row=>{row.text='edited synthetic text';}));
    assert.ok(store.memorySourceRevision>before);
    const beforePresented=store.memorySourceRevision;
    await store.mutate((_,tx)=>tx.messages.update('private',owner,'message-1',row=>{row.presentation='discarded';}));
    assert.ok(store.memorySourceRevision>beforePresented);
  }finally{await memory.close();}
});

test('restoring a 5,000-message life writes target rows once and only stages bounded batches',async t=>{
  const {createCompanionLives}=await import('../src/companion-life-service.mjs');
  const {batches,start,pause,stop}=traceWrites(t);
  const audit=[];
  const {store,root}=await fixture(t,{count:5000,options:{audit:event=>audit.push(event)},mutateSource:state=>{
   const seed=state.conversations[owner];
   delete state.conversations[owner];
   for(let i=0;i<20;i++){
    const id=owner+'-'+i;
    const messages=seed.messages.slice(i*250,(i+1)*250).map((row,j)=>({
      ...row,role:j%2?'assistant':'user',text:'仅用于性能采样 '+i+' '+j+'。'+'用合成对话重建原问题中的大存档。'.repeat(59)
    }));
    state.conversations[id]={...seed,id,messages};
   }
    state.draftCards={};
    state.activeConversationId=owner+'-0';
    state.relationships[characterId]={mode:'independent',byPersona:{[personaId]:{level:4,affection:17}}};
  }});
  const core=scope=>({version:1,characterId:scope.characterId,lifeId:scope.lifeId,feeding:{
    format:'ai-buddy-feeding-state',version:1,scope,satiety:100,gameBalance:0,mealEvidence:[]
  }});
  const bridge={quiesce(){},activate(){},snapshot:core,initial:core,validate:()=>true,
    projectLife:({life})=>({...life,r95:{rebasedAt:at}}),prepare(){},apply(){},finalize(){}};
  const life=await createCompanionLives({store,dataRoot:root,call:async()=>({ok:true,content:{}}),coreStateBridge:bridge,now:()=>at,
    syncCard:async()=>{},projectPersona:async()=>{},audit:event=>audit.push(event)});
  const memory=memoryFor(store);
  const publications=traceMemoryPublications(t),readMemory=store.readMemory;
  let streaming=false;
  store.readMemory=function(method,args,options,onModel,onBatch){
    return readMemory.call(this,method,args,options,onModel,async(...batchArgs)=>{
      streaming=true;
      try{return await onBatch(...batchArgs);}finally{streaming=false;}
    });
  };
  start({phase:()=>streaming?'stream':'final'});
  try{await memory.sync(characterId);}finally{pause();store.readMemory=readMemory;await memory.close();}
  const syncWrites=batches.splice(0).filter(batch=>batch.recordWrites>0);
  const syncPublications=publications.filter(event=>event.operation==='memory.sync');
  const syncPhases=new Set(syncWrites.map(({phase,changed,namespaces})=>JSON.stringify({phase,changed,namespaces:[...namespaces]})));
  t.diagnostic(JSON.stringify({syncMainBatches:syncWrites.length,syncPhases:[...syncPhases].map(JSON.parse),
    syncWorkerBatches:syncPublications.length,syncWorkerRows:syncPublications.reduce((total,event)=>total+event.rows,0)}));
  assert.equal(store.records.count('memory.events',characterId),5000);
  assert.equal(syncWrites.length,0,'streamed sync writes zero main-thread records');
  assert.ok(syncPublications.length>1&&syncPublications.reduce((total,event)=>total+event.rows,0)>=5000);
  assert.ok(syncPublications.every(({rows,recordBytes})=>rows>0&&rows<=64&&recordBytes>0&&recordBytes<=48*1024));
  const saved=await life.save(characterId);
  const messagesByConversation=state=>Object.fromEntries(Object.values(state.conversations).map(row=>[row.id,row.messages]));
  const original=messagesByConversation(await store.snapshotAsync({characterId}));
  await store.mutate((_,tx)=>tx.messages.update('private',owner+'-0','message-1',row=>{row.text='post archive write';}));
  audit.length=0;
  start();
  const postRestoreMemory=memoryFor(store),published=traceMemoryPublications(t);
  let restored,tickBatches,tickAudit;
  try{
    await life.restore(saved.id);
    const inserted=batches.reduce((sum,row)=>sum+row.messageInserts,0);
    const staged=audit.find(event=>event.type==='companion-life-restore-stage');
    const maxMs=Math.max(...batches.map(row=>row.elapsedMs));
    const stageSlow=audit.filter(event=>event.type==='companion-slow-transaction'&&event.operation==='life-restore-stage');
    t.diagnostic(JSON.stringify({batchCount:batches.length,inserted,staged,maxMs,stageSlow,slowest:batches.find(row=>row.elapsedMs===maxMs)}));
    assert.equal(inserted,0,'the desktop thread does not insert staged messages');
    assert.equal(staged.messageRows,5000);
    assert.ok(staged.maxBatchRows<=32,'the worker commits batches of at most 32 rows');
    restored=await store.snapshotAsync({characterId});
    assert.deepEqual(messagesByConversation(restored),original);
    assert.equal(store.records.count('memory.events',characterId),5000);
    assert.equal(Object.keys(restored.conversations).reduce((total,id)=>total+store.messages.count('private',id),0),5000);
    assert.equal(store.state.lives[characterId].r95.rebasedAt,at);
    if(process.env.AI_BUDDY_R15_STORAGE_TIMING==='1')assert.ok(maxMs<15&&stageSlow.length===0,'staging stays under 15 ms in isolation');

    const tickStart=batches.length,tickAuditStart=audit.length;
    start({recordBytes:true});
    await postRestoreMemory.tick();
    tickBatches=batches.slice(tickStart);
    tickAudit=audit.slice(tickAuditStart);
  }finally{
    stop();
    await postRestoreMemory.close();
  }
  const tickSlow=tickAudit.filter(event=>event.type==='companion-slow-transaction'&&event.operation==='memory.tick');
  assert.ok(published.length>1,'post-restore tick commits multiple worker batches');
  assert.ok(tickAudit.every(event=>event.operation!=='memory.tick'||event.type==='companion-slow-transaction'));
  assert.equal(tickBatches.reduce((sum,row)=>sum+row.recordWrites,0),0,'post-restore tick writes no records on main');
  assert.ok(published.every(row=>row.rows>0&&row.rows<=64&&row.recordBytes>0));
  assert.ok(published.every(row=>row.workerCommitMs>=0&&row.workerElapsedMs>=row.workerCommitMs&&row.workerWaitMs>=0));
  const maxTickRecordBytes=Math.max(...published.map(row=>row.recordBytes));
  const maxTickMs=Math.max(...published.map(row=>row.mainThreadMs),...tickBatches.map(row=>row.elapsedMs));
  const maxWorkerCommitMs=Math.max(...published.map(row=>row.workerCommitMs));
  const maxWorkerWaitMs=Math.max(...published.map(row=>row.workerWaitMs));
  t.diagnostic(JSON.stringify({tickBatches:published.length,mainBatches:tickBatches.length,maxTickRecordBytes,maxTickMs,maxWorkerCommitMs,maxWorkerWaitMs,tickSlow}));
  const {memory:restoredMemory,operationId}=restored.lives[characterId];
  const expected=Object.fromEntries(Object.entries(restoredMemory.events).map(([id,event])=>[id,{...event,operationId}]));
  assert.ok(Object.values(restoredMemory.events).every(event=>event.operationId!==operationId));
  const materialized=await store.snapshotAsync({characterId});
  assert.deepEqual(materialized.lives[characterId].memory.events,expected);
  assert.ok(maxTickRecordBytes>0&&maxTickRecordBytes<=48*1024,'post-restore memory tick limits the UTF-8 record payload per transaction');
  if(process.env.AI_BUDDY_R15_STORAGE_TIMING==='1')
    assert.ok(maxTickMs<15&&tickSlow.length===0,'post-restore memory tick stays under 15 ms in isolation');
});

test('portable conversation export returns a file receipt and respects host cancellation',async t=>{
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  const {store,root,services}=await fixture(t,{count:4,mutateSource:state=>{state.draftCards={};state.activeConversationId=owner;state.migrated=true;}});
  const {engine}=syntheticEngine({getStore:()=>store});
  const target=join(root,'synthetic-export.json'),chosen=[];
  const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:root,
    chooseConversationExportPath(options){chosen.push(options);return chosen.length===1?target:null;}});
  services.push(service);
  const output=await service.action('companion-conversation-export',{id:owner,target:join(root,'untrusted-renderer-path.json')});
  assert.equal(output.data,undefined);
  assert.equal(output.export.path,target);
  const bytes=await readFile(target);
  assert.equal(output.export.sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(output.export.ownerCounts,[{type:'private',ownerId:owner,messageCount:4}]);
  assert.equal(output.export.messageCount,4);
  const exported=JSON.parse(bytes);
  assert.equal(exported.format,'ai-buddy-conversations');
  assert.equal(exported.version,1);
  assert.equal(exported.conversations[0].messages.length,4);
  assert.deepEqual(await service.action('companion-conversation-export',{id:owner}),{ok:true,cancelled:true});
});

test('service shutdown bounds a stuck history read and still permits final relationship projection',async t=>{
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  const {store,root,services}=await fixture(t,{count:2,mutateSource:state=>{state.draftCards={};state.activeConversationId=owner;state.migrated=true;}});
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:root,closeDrainMs:2800});
  services.push(service);
  const post=Worker.prototype.postMessage;
  let held=false;
  Worker.prototype.postMessage=function(message,...args){
    if(message.data?.operation==='history'){held=true;return;}
    return post.call(this,message,...args);
  };
  try{
    const reading=service.action('companion-history-page',{ownerType:'private',ownerId:owner});
    const failed=assert.rejects(reading,{code:'COMPANION_WORKER_RETRY'});
    failed.catch(()=>{});
    assert.equal(held,true);
    try{await service.close();}
    catch(error){services.pop();await store.close();throw error;}
    await failed;
    await service.persistRelationshipProjections();
    Worker.prototype.postMessage=post;
    assert.equal((await store.messages.history('private',owner)).totalCount,2);
  }finally{Worker.prototype.postMessage=post;}
});

async function lifeRestoreFixture(t,{count=130,hooks,prepare=()=>{},options}={}){
  const {createCompanionLives}=await import('../src/companion-life-service.mjs');
  const f=await fixture(t,{count,options,mutateSource:state=>{
    state.draftCards={};state.activeConversationId=owner;
    state.relationships[characterId]={mode:'independent',byPersona:{[personaId]:{level:4,affection:17}}};
    state.lives[characterId].memory={notices:{first:{id:'first',text:'synthetic memory'}}};
  }});
  const core=scope=>({version:1,characterId:scope.characterId,lifeId:scope.lifeId,feeding:{
    format:'ai-buddy-feeding-state',version:1,scope,satiety:100,gameBalance:0,mealEvidence:[]
  }});
  const bridge={quiesce(){},activate(){},snapshot:core,initial:core,validate:()=>true,prepare,apply(){},finalize(){}};
  const boot=store=>createCompanionLives({store,dataRoot:f.root,call:async(action)=>{await hooks?.(action);return {ok:true,content:{}};},coreStateBridge:bridge,now:()=>at,
    syncCard:async()=>{},projectPersona:async()=>{}});
  const life=await boot(f.store),saved=await life.save(characterId);
  const original=(await f.store.snapshotAsync({characterId})).conversations[owner].messages;
  await f.store.mutate((_,tx)=>tx.messages.update('private',owner,'message-1',row=>{row.text='post archive write';}));
  return {...f,boot,life,saved,original};
}

test('life staging resumes from durable source after committing part of the target',async t=>{
  const {store,open,boot,life,saved,original}=await lifeRestoreFixture(t);
  const mutate=store.mutate.bind(store);
  let staged=0,closePromise;
  store.mutate=async(fn,options)=>{
    const result=await mutate(fn,options);
    if(options?.operation==='life-restore-stage'&&++staged===2){
      assert.equal(store.state.lifeTransaction.staging.cursor,64);
      assert.equal(store.messages.get('private',owner,'message-1').text,'post archive write');
      assert.equal((await store.snapshotAsync()).lifeTransaction.target,undefined,'partial staging is not published');
      closePromise=store.close();
      await closePromise;
      throw Error('Simulated exit after stage batch');
    }
    return result;
  };
  await assert.rejects(life.restore(saved.id),/恢复待完成|store is closing/);
  assert.ok(closePromise,'the second stage batch started closing the store');
  await closePromise;
  const reopened=await open(),service=await boot(reopened);
  assert.equal(service.recovery(),null);
  assert.deepEqual((await reopened.snapshotAsync({characterId})).conversations[owner].messages,original);
  assert.equal(reopened.messages.count('private',owner),130);
  assert.equal((await reopened.snapshotAsync()).lives[characterId].memory.notices.first.text,'synthetic memory');
});

test('life publication reconciles a worker that exits after committing before replying',async t=>{
  const {store,life,saved,original}=await lifeRestoreFixture(t);
  const subscribe=Worker.prototype.on;
  const starts=channel('ai-buddy.companion.worker-start');
  let publishing=false,interrupted=false;
  const listener=operation=>{publishing=operation==='publish-life-restore';};
  starts.subscribe(listener);
  t.after(()=>starts.unsubscribe(listener));
  Worker.prototype.on=function(event,handler){
    if(publishing&&!interrupted&&event==='message'){
      return subscribe.call(this,event,message=>{
        if(message.result?.revision){
          interrupted=true;
          void this.terminate();
        }else handler(message);
      });
    }
    return subscribe.call(this,event,handler);
  };
  try{await life.restore(saved.id);}finally{Worker.prototype.on=subscribe;}
  assert.equal(interrupted,true);
  assert.equal(store.state.lastLifeTransaction.status,'committed');
  assert.deepEqual((await store.snapshotAsync({characterId})).conversations[owner].messages,original);
});

test('rollback export expands a partial life stage and verifies physical and logical counts',async t=>{
  const {store,root,life,saved,original}=await lifeRestoreFixture(t);
  const mutate=store.mutate.bind(store);
  let closePromise,exportWhileOpen,closeSettled=false;
  store.mutate=async(fn,options)=>{
    const result=await mutate(fn,options);
    if(options?.operation==='life-restore-stage'){
      closePromise=store.close().finally(()=>{closeSettled=true;});
      exportWhileOpen=assert.rejects(exportCompanionForRollback(root),/Companion database is currently open/);
      await exportWhileOpen;
      await closePromise;
      throw Error('Simulated exit after first stage batch');
    }
    return result;
  };
  await assert.rejects(life.restore(saved.id),/恢复待完成|store is closing/);
  assert.ok(closePromise,'the first stage batch started closing the store');
  await exportWhileOpen;
  // Cancelling the stage read can reject restore before WAL maintenance closes.
  await closePromise;
  assert.equal(closeSettled,true);
  const receipt=await exportCompanionForRollback(root);
  const value=JSON.parse(await readFile(receipt.exportPath,'utf8'));
  assert.deepEqual(value.lifeTransaction.target.conversations[0].messages,original);
  assert.equal(value.lifeTransaction.staging,undefined);
  assert.equal(value.conversations[owner].messages[1].text,'post archive write');
  assert.equal(receipt.activeMessageCount,130);
  assert.equal(receipt.messageCount,260);
  assert.equal(receipt.sealedTargetMessageCount,130);
  assert.ok(receipt.stagedMessageCount>0&&receipt.stagedMessageCount<130);
  assert.equal(receipt.totalMessageCount-receipt.stagedMessageCount+receipt.sealedTargetMessageCount,260);
  assert.deepEqual(await exportCompanionForRollback(root),receipt);
});

test('failed worker publication before commit leaves the prior life readable and permits another restore',async t=>{
  const audit=[];
  let clock=0;
  const options={audit:event=>audit.push(event),sqlClock:()=>clock};
  const {store,life,saved,original}=await lifeRestoreFixture(t,{options});
  const on=Worker.prototype.on,starts=channel('ai-buddy.companion.worker-start');
  let publish=false,terminated=false;
  const listener=operation=>{
    publish=operation==='publish-life-restore';
    if(publish)queueMicrotask(()=>{clock+=100;});
  };
  starts.subscribe(listener);
  Worker.prototype.on=function(event,handler){
    if(publish&&!terminated&&event==='message'){
      terminated=true;
      void this.terminate();
    }
    return on.call(this,event,handler);
  };
  try{
    const restoring=life.restore(saved.id);
    await assert.rejects(restoring,/worker exited|恢复待完成/);
  }finally{starts.unsubscribe(listener);Worker.prototype.on=on;}
  assert.equal(store.messages.get('private',owner,'message-1').text,'post archive write');
  assert.equal(terminated,true);
  assert.deepEqual(audit.filter(event=>event.operation==='life-restore-publish'),[
    {type:'companion-life-restore-worker',operation:'life-restore-publish',rows:0,elapsedMs:100,
      mainThreadMs:0,workerElapsedMs:null,workerWaitMs:100}
  ]);
  if(life.recovery())await life.recover(characterId,'retry');
  else await life.restore(saved.id);
  assert.deepEqual((await store.snapshotAsync({characterId})).conversations[owner].messages,original);
});

test('shared reader shutdown cancels only the closing store lease',async t=>{
  const {store,open}=await fixture(t,{count:2});
  const second=await open();
  assert.equal((await second.messages.history('private',owner)).totalCount,2);
  const post=Worker.prototype.postMessage;
  let dropped=false;
  Worker.prototype.postMessage=function(message,...args){
    if(!dropped&&message.data?.operation==='history'){dropped=true;return;}
    return post.call(this,message,...args);
  };
  try{
    const pending=assert.rejects(store.messages.history('private',owner),{code:'COMPANION_WORKER_RETRY'});
    await store.close();
    await pending;
    assert.equal((await second.messages.history('private',owner)).totalCount,2);
  }finally{Worker.prototype.postMessage=post;}
});

test('replacing a record owner retains its new collection through reopen',async t=>{
  const {store,open}=await fixture(t,{mutateSource:state=>{
    state.lives[characterId].personalEvents=[{id:'old',text:'old synthetic event'}];
  }});
  const namespace='life.personalEvents',descriptor={at:['lives',characterId,'personalEvents'],array:true};
  const replacement={id:'new',text:'new synthetic event'};
  await store.mutate((_,tx)=>{
    tx.records.removeOwner(namespace,characterId);
    tx.records.define(namespace,characterId,descriptor);
    tx.records.put(namespace,characterId,replacement.id,replacement);
  });
  await store.close();
  const reopened=await open();
  assert.deepEqual((await reopened.snapshotAsync()).lives[characterId].personalEvents,[replacement]);
});

test('restore resumes before and after the external engine projection',async t=>{
  for(const boundary of ['pending','applied'])await t.test(boundary,async sub=>{
    const {store,open,boot,life,saved,original}=await lifeRestoreFixture(sub);
    const mutate=store.mutate.bind(store);
    let stopped=false;
    store.mutate=async(fn,options)=>{
      const result=await mutate(fn,options);
      if(!stopped&&store.state.lifeTransaction?.engineProjection===boundary){
        stopped=true;
        assert.equal(store.messages.get('private',owner,'message-1').text,'post archive write');
        await store.close();
        throw Error('Simulated exit at engine projection boundary');
      }
      return result;
    };
    await assert.rejects(life.restore(saved.id),/恢复待完成|store is closing/);
    assert.equal(stopped,true);
    const reopened=await open();
    assert.equal((await boot(reopened)).recovery(),null);
    assert.deepEqual((await reopened.snapshotAsync({characterId})).conversations[owner].messages,original);
    assert.equal(reopened.state.lastLifeTransaction.status,'committed');
  });
});

test('a memory tick leaves a staged life transaction available for recovery',async t=>{
  let failPrepare=true;
  const {store,open,boot,life,saved,original}=await lifeRestoreFixture(t,{prepare(){
    if(failPrepare)throw Error('Injected core prepare outage');
  }});
  const mutate=store.mutate.bind(store);
  store.mutate=async(fn,options)=>{
    const result=await mutate(fn,options);
    if(options?.operation==='life-restore-staged'){
      await store.close();
      throw Error('Simulated exit after staging');
    }
    return result;
  };
  await assert.rejects(life.restore(saved.id),/恢复待完成|store is closing/);
  const reopened=await open(),service=await boot(reopened);
  assert.ok(service.recovery());
  assert.equal(reopened.state.lifeTransaction.staging.complete,true);
  const memory=memoryFor(reopened);
  try{await memory.tick({skip:characterId});}finally{await memory.close();}
  failPrepare=false;
  await service.recover(characterId,'retry');
  assert.equal(service.recovery(),null);
  const restored=await reopened.snapshotAsync({characterId});
  assert.deepEqual(restored.conversations[owner].messages,original);
  assert.equal(restored.lives[characterId].memory.notices.first.text,'synthetic memory');
});

test('memory sync accepts intervening choices and mood commits on the same source revision',async t=>{
  const {store}=await fixture(t,{count:3});
  const read=store.readMemory.bind(store),memory=memoryFor(store);
  let attempts=0;
  store.readMemory=async(...args)=>{
    const result=await read(...args);
    attempts++;
    const source=store.memorySourceRevision;
    await store.mutate(state=>{state.conversations[owner].choicesStatus='ready';});
    await store.mutate(state=>{state.lives[characterId].r95={mood:{version:attempts}};});
    assert.equal(store.memorySourceRevision,source);
    return result;
  };
  try{
    await memory.sync(characterId);
    assert.equal(attempts,1);
    assert.equal(store.records.count('memory.events',characterId),3);
    assert.equal(store.state.conversations[owner].choicesStatus,'ready');
    assert.equal(store.state.lives[characterId].r95.mood.version,1);
  }finally{await memory.close();}
});

test('life save archives committed WAL rows without checkpointing on the desktop thread',async t=>{
  const {createCompanionService}=await import('../src/companion-service.mjs');
  const {syntheticEngine}=await import('./support/audit-harness.mjs');
  const {store,root,open,services}=await fixture(t,{count:40,mutateSource:state=>{
    state.activeConversationId=owner;state.draftCards={};state.migrated=true;
  }});
  const {engine}=syntheticEngine({getStore:()=>store});
  const service=await createCompanionService({store,engine,provider:{enabled:false},dataRoot:root,now:()=>at});
  services.push(service);
  const prepare=DatabaseSync.prototype.prepare,checkpoints=[];
  DatabaseSync.prototype.prepare=function(sql,...args){
    if(sql.includes('wal_checkpoint'))checkpoints.push(sql);
    return prepare.call(this,sql,...args);
  };
  let archive;
  try{({archive}=await service.action('companion-life-save',{characterId}));}
  finally{DatabaseSync.prototype.prepare=prepare;}
  const {createLifeArchiveRepository}=await import('../src/companion-life-archive.mjs');
  const {snapshot}=createLifeArchiveRepository({dataRoot:root}).read(archive.id,archive.sha256);
  assert.equal(snapshot.conversations[0].messages.length,40);
  assert.equal(Object.keys(snapshot.life.memory.events).length,40);
  await service.close();
  await store.close();
  const reopened=await open();
  assert.equal(reopened.messages.count('private',owner),40);
  assert.equal(reopened.records.count('memory.events',characterId),40);
  assert.deepEqual(checkpoints,[],'save should not checkpoint on the desktop thread');
});
