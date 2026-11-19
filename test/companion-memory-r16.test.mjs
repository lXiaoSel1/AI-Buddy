import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {channel} from 'node:diagnostics_channel';
import {DatabaseSync} from 'node:sqlite';
import {collectMemoryEvents,createCompanionMemory} from '../src/companion-memory.mjs';
import {createAutoService} from '../src/companion-auto.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {syntheticEngine} from './support/audit-harness.mjs';
import {ensureLives} from '../src/companion-life.mjs';
import {exportCompanionForRollback,makeCard,openCompanionStore} from '../src/companion-store.mjs';

const id='r16-daily-character',personaId='default',owner='r16-daily-private';
const day='2026-10-20',sourceAt=Date.parse(day+'T12:00:00Z');
const now=()=>Date.parse('2026-10-21T12:00:00Z');
const budget=48*1024;

async function fixture(t,count){
 const root=await mkdtemp(join(process.env.AI_BUDDY_R16_MEMORY_TMP??tmpdir(),'buddy-r16-memory-'));
 const folder=join(root,'galgame'),events=[];
 let store;
 t.after(async()=>{await store?.close();await rm(root,{recursive:true,force:true});});
 const state={
  schema:2,minimumWriter:'r95-social-core-v1',requiredCapabilities:['social-core-state-v1'],revision:0,
  migrated:true,activeCharacterId:id,activePersonaId:personaId,activeConversationId:owner,
  conversations:{[owner]:{id:owner,characterId:id,personaId,messages:Array.from({length:count},(_,index)=>({
   id:'r16-message-'+index,characterId:id,personaId,role:'assistant',status:'presented',
   text:'synthetic source '+index,createdAt:sourceAt+index
  }))}},
  groups:{},relationships:{},draftCards:{},cards:{[id]:makeCard({id,name:'Synthetic character'})},
  personas:{[personaId]:{id:personaId,name:'Synthetic persona'}},lives:{},settings:{},memorySettings:{timeZone:'UTC'}
 };
 ensureLives(state,sourceAt-1000);
 await mkdir(folder);
 await writeFile(join(folder,'companion.json'),JSON.stringify(state));
 const open=async()=>store=await openCompanionStore(root,{audit:event=>events.push(event)});
 await open();
 return {store,events,root,open,path:join(folder,'companion.sqlite')};
}

function monitorWrites(){
 const prepare=DatabaseSync.prototype.prepare;
 let store,mutate,readMemory,streaming=false;
 const stages=[];
 const publisher=channel('ai-buddy.companion.memory-publisher');
 const record=event=>{if(active)active.publications.push(event);};
 publisher.subscribe(record);
 let active,batch,previous=performance.now(),timer=setInterval(()=>{
  const ended=performance.now();
  if(active)active.heartbeatMaxMs=Math.max(active.heartbeatMaxMs,ended-previous);
  previous=ended;
 },1);
 DatabaseSync.prototype.prepare=function(sql,...args){
  const statement=prepare.call(this,sql,...args);
  const writesRecord=sql.startsWith('INSERT INTO records');
  const writesMetadata=/^UPDATE state(?:_sections)? SET (?:revision=\?,)?value=/.test(sql);
  if(!writesRecord&&!writesMetadata)return statement;
  const run=statement.run.bind(statement);
  statement.run=(...params)=>{
   const result=run(...params);
   if(batch&&writesMetadata)batch.changed=true;
   if(batch&&writesRecord){
    const [namespace,,key,,value]=params,bytes=Buffer.byteLength(value);
    batch.rows.push({namespace,key,bytes});
    batch.bytes+=bytes;
   }
   return result;
  };
  return statement;
 };
 function attach(target){
 store=target;mutate=store.mutate;readMemory=store.readMemory;
 store.readMemory=async function(method,args,options,onModel,onBatch){
  const result=await readMemory.call(this,method,args,options,onModel,onBatch&&(async(...batchArgs)=>{
   streaming=true;
   try{return await onBatch(...batchArgs);}finally{streaming=false;}
  }));
  if(active)active.finalNamespaces=result.patch?.changes?.map(({namespace})=>namespace)??[];
  return result;
 };
 store.mutate=async function(fn,options){
  if(!active)return mutate.call(this,fn,options);
  const current={operation:options?.operation,phase:streaming?'stream':'final',changed:false,rows:[],bytes:0};
  const result=await mutate.call(this,(state,tx)=>{
   batch=current;
   return fn(state,tx);
  },options).finally(()=>{batch=undefined;});
  active.writes.push(current);
  return result;
 };}
 return {attach,
  stages,begin(label){active={label,writes:[],publications:[],heartbeatMaxMs:0};stages.push(active);},
  end(){active=undefined;},
  close(){
   clearInterval(timer);publisher.unsubscribe(record);DatabaseSync.prototype.prepare=prepare;
   if(store){store.mutate=mutate;store.readMemory=readMemory;}
  }
 };
}

function dailyResponse(request,accept){
 const input=JSON.parse(request.messages[0].text);
 if(request.purpose==='memory-daily-segment'){
  return {coverageHash:input.coverageHash,items:[{text:'Fixture',eventIds:[input.events[0].id]}]};
 }
 if(request.purpose==='memory-daily-merge'){
  return {coverageHash:input.coverageHash,items:[input.parts[0].items[0]]};
 }
 assert.equal(request.purpose,'memory-daily');
 return {
  coverageHash:accept?input.coverageHash:'rejected synthetic coverage',
  summary:{text:'Synthetic daily summary',eventIds:[]},guide:{text:'',eventIds:[]},core:[],branches:[],growthCandidates:[]
 };
}

test('12,000 same-day sources survive three failed consolidations and a bounded successful retry',async t=>{
 const trace=monitorWrites();
 t.after(trace.close);
 const {store,events}=await fixture(t,12000);
 trace.attach(store);
 let finals=0,retryAt=now();
 const memory=createCompanionMemory({store,now:()=>retryAt,autoStart:false,getCapacity:()=>({tokens:32768,verified:true}),
  runModel:async(_,request)=>JSON.stringify(dailyResponse(request,request.purpose==='memory-daily'&&++finals===4))});
 await memory.sync(id);
 const auditStart=events.length,resultSizes=[],statuses=[],errors=[];
 try{
  for(let attempt=1;attempt<=4;attempt++){
   retryAt+=1000;
   trace.begin(attempt);
   const result=await memory.consolidate({characterId:id,personaId,day,retry:attempt!==1});
   trace.end();
   resultSizes.push(Buffer.byteLength(JSON.stringify(result)));
   statuses.push(result.status);errors.push(result.error);
  }
 }finally{trace.close();await memory.close();}
 const slow=events.slice(auditStart).filter(event=>event.type.startsWith('companion-slow-'));
 const maxRow=Math.max(0,...trace.stages.flatMap(stage=>stage.writes.flatMap(batch=>batch.rows.map(row=>row.bytes))));
 const maxBatch=Math.max(0,...trace.stages.flatMap(stage=>[
  ...stage.writes.map(batch=>batch.bytes),...stage.publications.map(batch=>batch.recordBytes)
 ]));
 const timeline={
  node:process.version,finals,statuses,errors,resultSizes,maxRow,maxBatch,slow,
  stages:trace.stages.map(({label,writes,heartbeatMaxMs,finalNamespaces,publications})=>({label,heartbeatMaxMs,finalNamespaces,publications,
   writes:writes.map(({operation,phase,changed,rows,bytes})=>({
   operation,phase,changed,bytes,rowCount:rows.length,namespaces:Object.fromEntries([...new Set(rows.map(row=>row.namespace))].map(name=>[name,rows.filter(row=>row.namespace===name).map(row=>row.bytes)]))
  }))}))
 };
 if(process.env.AI_BUDDY_R16_MEMORY_RECEIPT)await writeFile(process.env.AI_BUDDY_R16_MEMORY_RECEIPT,JSON.stringify(timeline,null,2).replace(/\n/g,'\r\n')+'\r\n');
 t.diagnostic(JSON.stringify({...timeline,stages:timeline.stages.map(({label,heartbeatMaxMs,writes})=>({label,heartbeatMaxMs,writeCount:writes.length}))}));
 assert.deepEqual(statuses,['failed','failed','failed','committed']);
 assert.equal(finals,4);
 const snapshot=await store.snapshotAsync({characterId:id});
 const {summaries,jobs}=snapshot.lives[id].memory,key='persona:'+personaId+'|'+day;
 assert.equal(jobs[key].status,'committed');
 assert.equal(jobs[key].cutoff.length,12000);
 assert.equal(summaries[key].cutoff.length,12000);
 assert.equal(summaries[key].eventIds.length,12000);
 assert.equal(new Set(summaries[key].eventIds).size,12000);
 assert.ok(summaries[key].segments.length>1);
 assert.deepEqual(summaries[key].segments.flatMap(segment=>segment.eventIds),summaries[key].eventIds);
 assert.equal(snapshot.conversations[owner].messages.length,12000);
 assert.ok(maxRow<=budget,'each row must fit the 48 KiB memory write budget');
 assert.ok(maxBatch>0&&maxBatch<=budget,'each batch must fit the 48 KiB memory write budget');
 assert.ok(resultSizes.every(bytes=>bytes<=budget),'the desktop receives a bounded result');
 const retries=timeline.stages.slice(1,3);
 t.diagnostic(JSON.stringify({statusOnlyRetries:retries}));
 for(const [index,stage] of trace.stages.slice(1,3).entries()){
  assert.deepEqual(retries[index].finalNamespaces,['memory.coverageHeader.jobs']);
  assert.deepEqual(stage.writes.map(({phase,changed})=>({phase,changed})),[{phase:'final',changed:false}]);
  assert.equal(stage.writes.flatMap(batch=>batch.rows).filter(row=>row.namespace.startsWith('memory.coverage.')).length,0,
   'a status-only retry must not rewrite unchanged coverage');
  assert.equal(stage.writes.flatMap(batch=>batch.rows).length,0,'a completed retry writes zero main-thread records');
  assert.equal(stage.publications.length,1);
  const [publication]=stage.publications;
  assert.equal(publication.operation,'memory.consolidate');
  assert.equal(publication.rows,1);
  assert.ok(publication.recordBytes>0&&publication.recordBytes<=budget);
 }
 assert.ok(trace.stages.every(stage=>stage.publications.length>0),'each daily attempt publishes worker records');
 if(process.env.AI_BUDDY_R16_MEMORY_TIMING==='1'){
  assert.deepEqual(slow,[]);
  assert.ok(trace.stages.every(stage=>stage.heartbeatMaxMs<=50),'the 1 ms main-thread heartbeat must not stall more than 50 ms');
 }
});

test('Auto evidence is partitioned through SQLite reopen and rollback',async t=>{
 const {root,store,open,path}=await fixture(t,0);
 const groupId='r16-auto-group',authorizationId='original-authorization';
 await store.mutate(state=>{
  state.groups[groupId]={id:groupId,personaId,memberIds:[id]};
  state.r95={settings:{auto:true}};
 });
 const scope={characterId:id,personaId,conversationId:groupId,channel:'app-group',
  lifeId:store.state.lives[id].id,operationId:store.state.lives[id].operationId};
 const bind=current=>createAutoService({store:current,now,dispatchTurn:async()=>{}});
 const auto=bind(store);
 let session=await auto.start({groupId,scope,authorizationId,mode:'until-stopped'});
 const first=await auto.next({groupId});
 assert.equal((await auto.commitOpportunity({groupId,requestId:first.requestId,status:'silent',evidenceId:'first'})).committed,true);
 const cancelled=await auto.next({groupId});
 await auto.stop({groupId});
 const visible=auto.view({groupId}).auto;
 assert.equal(visible.completed[first.requestId].evidenceId,'first');
 assert.equal(visible.retiredRequests[cancelled.requestId].status,'cancelled');
 assert.equal((await auto.commitOpportunity({groupId,requestId:first.requestId,status:'silent',evidenceId:'first'})).duplicate,true);
 assert.equal((await auto.commitOpportunity({groupId,requestId:cancelled.requestId,status:'silent',evidenceId:'late'})).retired,true);
 await auto.start({groupId,scope,authorizationId:'replacement-authorization'});
 await store.close();
 const reopened=await open(),after=bind(reopened);
 await after.recover();
 assert.equal(after.view({groupId}).auto.status,'paused');
 await assert.rejects(after.start({groupId,scope,authorizationId}),{code:'AUTO_AUTHORIZATION_REUSED'});
 const db=new DatabaseSync(path,{readOnly:true});
 const persisted=JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value).groups[groupId];
 db.close();
 assert.equal(persisted.auto.completed,undefined);
 assert.equal(persisted.autoHistory[0].completed,undefined);
 assert.equal(persisted.autoHistory[0].retiredRequests,undefined);
 assert.equal(persisted.autoAuthorizations,undefined);
 await reopened.close();
 const receipt=await exportCompanionForRollback(root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8')).groups[groupId];
 assert.equal(exported.autoHistory[0].id,session.id);
 assert.deepEqual(exported.autoHistory[0].completed,visible.completed);
 assert.deepEqual(exported.autoHistory[0].retiredRequests,visible.retiredRequests);
 assert.equal(exported.autoAuthorizations[authorizationId].id,session.id);
});

test('an interrupted first conversion leaves legacy daily jobs readable and exported intact',async t=>{
 const {root,store,open,path}=await fixture(t,1);
 const eventId=collectMemoryEvents(await store.snapshotAsync(),id)[0].id;
 await store.close();
 const key='persona:'+personaId+'|'+day;
 const cutoff=[{id:eventId,hash:'legacy-hash',revision:0}],unknown={suppliedBy:'legacy',kept:true};
 const rows=Object.fromEntries(Array.from({length:64},(_,index)=>{
  const key='persona:p'+index+'|'+day;
  return [key,{id:'legacy-job-'+index,scope:'persona:p'+index,day,status:'failed',attempts:3,cutoff,sqliteCoverageV1:unknown}];
 }));
 rows[key]={...rows['persona:p0|'+day],scope:'persona:'+personaId};
 delete rows['persona:p0|'+day];
 const db=new DatabaseSync(path);
 try{
  db.prepare('INSERT OR IGNORE INTO record_owners VALUES(?,?,?,?)')
   .run('memory.jobs',id,0,JSON.stringify(['lives',id,'memory','jobs']));
  const insert=db.prepare('INSERT INTO records VALUES(?,?,?,?,?)');
  Object.entries(rows).forEach(([key,value],index)=>insert.run('memory.jobs',id,key,index,JSON.stringify(value)));
 }finally{db.close();}
 const converting=await open(),mutate=converting.mutate.bind(converting);
 converting.mutate=(fn,options)=>mutate((state,tx)=>{
  if(options?.operation!=='memory.sync')return fn(state,tx);
  const underlying=tx.records;
  const rejecting={...underlying,put(namespace,...args){
   if(namespace==='memory.coverageHeader.jobs')throw Error('Injected outage at coverage publication');
   return underlying.put(namespace,...args);
  }};
  return fn(state,{...tx,records:rejecting});
 },options);
 const first=createCompanionMemory({store:converting,now,autoStart:false,runModel:async()=>{throw Error('unexpected model');}});
 try{await assert.rejects(first.sync(id),/Injected outage at coverage publication/);}
 finally{await first.close();await converting.close();}
 const reopened=await open();
 const prior=await reopened.snapshotAsync({characterId:id});
 assert.deepEqual(prior.lives[id].memory.jobs,rows,'every legacy job remains visible before successful publication');
 const memory=createCompanionMemory({store:reopened,now,autoStart:false,runModel:async()=>{throw Error('unexpected model');}});
 try{
  await memory.sync(id);
  const view=await memory.view({characterId:id,personaId,conversationId:owner});
  assert.deepEqual(view.jobs.map(job=>({scope:job.scope,id:job.id,unknown:job.sqliteCoverageV1})),[
   {scope:'persona:'+personaId,id:rows[key].id,unknown}
  ]);
 }finally{await memory.close();await reopened.close();}
 const receipt=await exportCompanionForRollback(root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8'));
 assert.deepEqual(exported.lives[id].memory.jobs,rows);
});


test('existing SQLite Auto records migrate and stay bounded without losing durable receipts',async t=>{
 const {root,store,open,path}=await fixture(t,0);
 await store.close();
 const groupId='r16-legacy-auto',sessionId='old-session';
 const scope={characterId:id,personaId,conversationId:groupId,channel:'app-group',
  lifeId:store.state.lives[id].id,operationId:store.state.lives[id].operationId};
 const completed=Object.fromEntries(Array.from({length:200},(_,i)=>['turn-'+i,
  {requestId:'turn-'+i,characterId:id,status:'silent',evidenceId:'original-'+i,roundIndex:i,opportunityIndex:0,at:i}]));
 const auth=Object.fromEntries(Array.from({length:200},(_,i)=>['auth-'+i,{id:'session-'+i,at:i}]));
 const history=Array.from({length:20},(_,i)=>({id:'history-'+i,status:'ended',completed:{['history-turn-'+i]:{
  evidenceId:'historic-'+i,status:'silent',characterId:id,roundIndex:0,opportunityIndex:0
 }}}));
 const group={
  id:groupId,personaId,memberIds:[id],autoAuthorizations:auth,autoHistory:history,
  auto:{id:sessionId,scope,mode:'until-stopped',authorizationId:'auth-199',members:[id],groupMemberSnapshot:[id],
   status:'active',generation:1,roundIndex:200,opportunityIndex:0,completed,pending:null}
 };
 const db=new DatabaseSync(path);
 try{
  const state=JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get().value);
  state.groups[groupId]=group;
  state.r95={settings:{auto:true}};
  db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(state));
 }finally{db.close();}
 const reopened=await open(),auto=createAutoService({store:reopened,now,dispatchTurn:async()=>{}});
 assert.deepEqual(auto.view({groupId}).auto.completed,completed);
 assert.equal(reopened.state.groups[groupId].auto.completed,undefined);
 assert.equal(reopened.state.groups[groupId].autoHistory[0].completed,undefined);
 assert.equal(reopened.state.groups[groupId].autoAuthorizations,undefined);
 const turn=await auto.next({groupId});
 const result=await auto.commitOpportunity({groupId,requestId:turn.requestId,status:'silent',evidenceId:'r16-receipt'});
 assert.equal(result.auto.completed[turn.requestId].evidenceId,'r16-receipt');
 assert.equal(Object.keys(result.auto.completed).length,200);
 assert.equal(result.auto.completed['turn-0'],undefined);
 assert.equal(reopened.archive.get('auto-completed:'+sessionId,'turn-0').evidenceId,'original-0');
 assert.equal((await auto.commitOpportunity({groupId,requestId:'turn-0',status:'silent',evidenceId:'original-0'})).duplicate,true);
 await auto.stop({groupId});
 await auto.start({groupId,scope,authorizationId:'r16-new-auth'});
 assert.equal(reopened.archive.get('auto-history:'+groupId,'history-0').completed['history-turn-0'].evidenceId,'historic-0');
 assert.equal(reopened.state.groups[groupId].autoHistory.length,20);
 assert.equal(reopened.archive.get('auto-authorizations:'+groupId,'auth-0').id,'session-0');
 await assert.rejects(auto.start({groupId,scope,authorizationId:'auth-0'}),{code:'AUTO_AUTHORIZATION_REUSED'});
 await reopened.close();
 const receipt=await exportCompanionForRollback(root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8')).groups[groupId];
 assert.equal(exported.autoHistory.at(-1).id,sessionId);
 assert.deepEqual(exported.autoHistory.at(-1).completed,result.auto.completed);
 assert.equal(Object.keys(exported.autoAuthorizations).length,200);
});

test('a first daily publication interrupted before its header can roll back immediately',async t=>{
 const {root,store}=await fixture(t,1);
 const memory=createCompanionMemory({store,now,autoStart:false,runModel:async(_,request)=>JSON.stringify(dailyResponse(request,true))});
 await memory.sync(id);
 const before=await store.snapshotAsync({characterId:id}),mutate=store.mutate.bind(store);
 store.mutate=(fn,options)=>mutate((state,tx)=>{
  if(options?.operation!=='memory.consolidate')return fn(state,tx);
  const records={...tx.records,put(namespace,...args){
   if(namespace.startsWith('memory.coverageHeader.'))throw Error('Injected failure before first daily publication');
   return tx.records.put(namespace,...args);
  }};
  return fn(state,{...tx,records});
 },options);
 try{
  await assert.rejects(memory.consolidate({characterId:id,personaId,day}),/Injected failure before first daily publication/);
 }finally{await memory.close();await store.close();}
 const receipt=await exportCompanionForRollback(root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8'));
 assert.deepEqual(exported.conversations[owner].messages,before.conversations[owner].messages);
 assert.deepEqual(exported.lives[id].memory.events,before.lives[id].memory.events);
 assert.deepEqual(exported.lives[id].memory.jobs,{});
 assert.deepEqual(exported.lives[id].memory.summaries,{});
});

test('memory sync keeps source text and IDs across a record larger than the desktop write budget',async t=>{
 const trace=monitorWrites();
 t.after(trace.close);
 const {root,store,open}=await fixture(t,1);
 trace.attach(store);
 const sourceText='x'.repeat(50000)+'长消息保留 🐋';
 await store.mutate((_,tx)=>tx.messages.update('private',owner,'r16-message-0',row=>{row.text=sourceText;}));
 const memory=createCompanionMemory({store,now,autoStart:false,runModel:async()=>{throw Error('Unexpected model request');}});
 const readMemory=store.readMemory.bind(store),wireBytes=[];
 store.readMemory=(method,args,options,onModel,onBatch)=>readMemory(method,args,options,onModel,onBatch&&((batch,...handshake)=>{
  wireBytes.push(Buffer.byteLength(JSON.stringify(batch)));
  return onBatch(batch,...handshake);
 }));
 try{
  trace.begin('long-message-sync');
  await memory.sync(id);
  trace.end();
 }finally{trace.close();await memory.close();}
 const snapshot=await store.snapshotAsync({characterId:id});
 const [event]=collectMemoryEvents(snapshot,id);
 assert.equal(snapshot.lives[id].memory.events[event.id].text,sourceText);
 assert.equal(store.records.get('memory.events',id,event.id).text,sourceText);
 const memoryRows=trace.stages.flatMap(stage=>stage.writes).flatMap(write=>write.rows);
 t.diagnostic(JSON.stringify({desktopWrites:memoryRows.map(row=>row.bytes),wireBytes}));
 assert.ok(memoryRows.every(row=>row.bytes<=budget),'large derived records must bypass the desktop SQLite writer');
 assert.ok(wireBytes.every(bytes=>bytes<=budget),'large derived records must bypass desktop structured cloning');
 await store.close();
 const reopened=await open();
 assert.equal(reopened.records.get('memory.events',id,event.id).text,sourceText);
 await reopened.close();
 const receipt=await exportCompanionForRollback(root);
 const exported=JSON.parse(await readFile(receipt.exportPath,'utf8'));
 assert.deepEqual(exported.lives[id].memory.events[event.id],snapshot.lives[id].memory.events[event.id]);
 assert.equal(exported.conversations[owner].messages[0].text,sourceText);
});

test('memory sync reconciles a long record committed before its worker acknowledgement was lost',async t=>{
 const {store}=await fixture(t,1);
 const sourceText='y'.repeat(55000),originalOwner=store.state.conversations[owner];
 await store.mutate((_,tx)=>tx.messages.update('private',owner,'r16-message-0',row=>{row.text=sourceText;}));
 const memory=createCompanionMemory({store,now,autoStart:false,runModel:async()=>{throw Error('Unexpected model request');}});
 const start=channel('ai-buddy.companion.worker-start'),on=Worker.prototype.on;
 let injected=false,verificationStarted=false;
 const listener=operation=>{if(operation==='verify-prepared-memory')verificationStarted=true;};
 start.subscribe(listener);
 Worker.prototype.on=function(event,handler){
  if(event!=='message')return on.call(this,event,handler);
  return on.call(this,event,message=>{
   if(!injected&&message.result?.sha256&&Number.isInteger(message.result.revision)){
    injected=true;
    void this.terminate();
    return;
   }
   handler(message);
  });
 };
 try{
  await assert.rejects(memory.sync(id),{code:'COMPANION_WORKER_RETRY'});
  assert.equal(injected,true);
  assert.equal(verificationStarted,true);
  await store.drain();
  assert.equal(store.memorySourceRevision,store.state.revision);
  assert.equal(store.state.conversations[owner],originalOwner);
  const snapshot=await store.snapshotAsync({characterId:id}),[event]=collectMemoryEvents(snapshot,id);
  assert.equal(store.records.get('memory.events',id,event.id).text,sourceText);
  await memory.sync(id);
  assert.equal(store.records.count('memory.events',id),1);
 }finally{
  Worker.prototype.on=on;
  start.unsubscribe(listener);
  await memory.close();
 }
});

for(const change of ['mood receipt','source text','character card','life mode','pending restore'])test('daily work accepts only unchanged memory sources while receiving its final reply: '+change,async t=>{
 const {store}=await fixture(t,1);
 const {promise:started,resolve:enter}=Promise.withResolvers();
 const {promise:proceed,resolve:release}=Promise.withResolvers();
 const memory=createCompanionMemory({store,now,autoStart:false,runModel:async(_,request)=>{
  assert.equal(request.purpose,'memory-daily');
  enter();
  await proceed;
  return JSON.stringify(dailyResponse(request,true));
 }});
 await memory.sync(id);
 const pending=memory.consolidate({characterId:id,personaId,day});
 const outcome=pending.then(value=>({value}),error=>({error}));
 try{
  await started;
  const revision=store.state.revision,source=store.memorySourceRevision;
  await store.mutate((state,tx)=>{
   if(change==='mood receipt'){
    (state.lives[id].r95??={}).mood={version:1};
    state.conversations[owner].choicesStatus='ready';
   }else if(change==='source text')tx.messages.update('private',owner,'r16-message-0',row=>{row.text='edited during reply';});
   else if(change==='character card')state.cards[id].fields.personality={mode:'custom',value:'edited during reply'};
   else if(change==='life mode')state.lives[id].mode='blank';
   else state.lifeTransaction={id:'fixture-restore',characterId:id,operationId:'next-operation',phase:'prepared'};
  });
  assert.ok(store.state.revision>revision);
  assert.equal(store.memorySourceRevision===source,change==='mood receipt');
  release();
  const result=await outcome;
  const persisted=await store.snapshotAsync({characterId:id});
  const summaries=persisted.lives[id].memory.summaries;
  if(change==='mood receipt'){
   assert.equal(result.error?.code,undefined,result.error?.message);
   assert.equal(result.value.status,'committed');
   assert.equal(Object.keys(summaries).length,1);
   assert.equal(persisted.lives[id].r95.mood.version,1);
   assert.equal(persisted.conversations[owner].choicesStatus,'ready');
  }else{
   assert.equal(result.error?.code,'MEMORY_VALIDATION');
   assert.deepEqual(summaries,{});
  }
 }finally{release();await memory.close();}
});

for(const trace of [true,false])test(trace
 ?'memory conflict audit bounds source effects and omits record identities and values'
 :'memory conflict audit uses the default revision-only event without opt-in tracing',async t=>{
 const original=process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE;
 if(trace)process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE='1';
 else delete process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE;
 t.after(()=>{
  if(original===undefined)delete process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE;
  else process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE=original;
 });
 const {store}=await fixture(t,1),audit=[];
 const memory=createCompanionMemory({store,now,autoStart:false,onError:event=>audit.push(event),runModel:async()=>{throw Error('Unexpected model request');}});
 const read=store.readMemory.bind(store),changes=[];
 let readCount=0;
 store.readMemory=async(method,...args)=>{
  const result=await read(method,...args);
  if(method==='context'){
   readCount++;
   for(let index=0;index<(trace?10:1);index++){
    let effects=['messages.private'];
    await store.mutate((state,tx)=>{
     if(index===8){
      tx.records.put('life.r95.lines',id,'fixture-secret-key',{text:'fixture-secret-line '+readCount},{array:true,at:['lives',id,'r95','lines']});
      effects=['life.r95.lines'];
     }else if(index===9){
      state.cards[id].fields.personality={mode:'custom',value:'fixture-secret-card'};
      effects=['cards'];
     }else if(index===7){
      state.lives[id].growth={fixture:'fixture-secret-growth '+readCount};
      effects=['lives.growth'];
     }else tx.messages.update('private',owner,'r16-message-0',row=>{row.text='fixture-secret-body '+readCount+'-'+index;});
    },{operation:'fixture-secret-operation'});
    changes.push({revision:store.memorySourceRevision,operation:'mutate',effects});
   }
   await store.mutate(state=>{state.conversations[owner].choicesStatus='fixture-secret-receipt '+readCount;});
  }
  return result;
 };
 try{
  await assert.rejects(memory.context({characterId:id,personaId,conversationId:owner}),{code:'MEMORY_VALIDATION'});
  assert.equal(readCount,2);
  assert.equal(audit.length,1);
  const event=audit[0];
  const keys=['actualMemorySourceRevision','actualRevision','expectedMemorySourceRevision','expectedRevision','method','phase','type'];
  if(trace)keys.push('coordinated','crossedPublication','modelRequested','readAttempts','sourceChanges');
  assert.deepEqual(Object.keys(event).sort(),keys.sort());
  assert.equal(typeof store.memorySourceChanges,trace?'function':'undefined');
  assert.equal(event.type,'memory-revision-conflict');
  assert.equal(event.method,'context');
  assert.equal(event.phase,'read-final');
  assert.equal(event.actualRevision,store.state.revision);
  assert.equal(event.actualMemorySourceRevision,store.memorySourceRevision);
  assert.ok(event.expectedMemorySourceRevision<event.actualMemorySourceRevision);
  if(trace){
   assert.equal(event.modelRequested,false);
   assert.equal(event.coordinated,false);
   assert.equal(event.crossedPublication,false);
   assert.equal(event.readAttempts.length,2);
   assert.equal(event.readAttempts[0].actualMemorySourceRevision,changes[9].revision);
   assert.equal(event.readAttempts[1].expectedMemorySourceRevision,changes[9].revision);
   assert.deepEqual(event.sourceChanges,changes.slice(-8));
  }
  const serialized=JSON.stringify(event);
  for(const secret of [id,owner,'r16-message-0','fixture-secret'])assert.ok(!serialized.includes(secret));
 }finally{await memory.close();}
});

test('automatic memory maintenance cannot invalidate the active public retry of the same day',async t=>{
 const {store,root}=await fixture(t,1),audit=[],frames=[],writes=[];
 const {engine}=syntheticEngine({getStore:()=>store});
 const atFinal=Array.from({length:4},()=>Promise.withResolvers()),releaseFinal=Array.from({length:4},()=>Promise.withResolvers());
 const provider={enabled:true,resolveContextCapacity:()=>({tokens:32768,verified:true}),
  currentSelection:()=>({provider:'fixture',model:'fixture'}),runTurn:fn=>fn(),
  async *stream(request){
   frames.push(request.purpose);
   assert.equal(request.purpose,'memory-daily');
   const attempt=frames.length-1;
   atFinal[attempt].resolve();
   await releaseFinal[attempt].promise;
   const messages=request.messages.map(row=>({text:row.text??row.content[0].text}));
   yield {type:'text-delta',text:JSON.stringify(dailyResponse({...request,messages},attempt===3))};
   yield {type:'finish',reason:{kind:'stop'}};
  }};
 const setTimer=globalThis.setInterval;
 let runMemoryTimer,automaticRead;
 t.mock.method(globalThis,'setInterval',(callback,delay,...args)=>{
  if(delay===60000)runMemoryTimer=callback;
  return setTimer(callback,delay,...args);
 });
 const service=await createCompanionService({store,engine,provider,dataRoot:root,now,audit:event=>audit.push(event),
  r95Options:{tickAllowed:()=>false}});
 const baseRead=store.readMemory.bind(store),baseMutate=store.mutate.bind(store);
 store.readMemory=(method,...args)=>{
  const task=baseRead(method,...args);
  if(method==='tick')automaticRead=task;
  return task;
 };
 store.mutate=(mutate,options)=>{
  const namespaces=new Set();
  return baseMutate((state,tx)=>mutate(state,{...tx,records:{...tx.records,put(namespace,...args){
   namespaces.add(namespace);
   return tx.records.put(namespace,...args);
  }}}),options).then(result=>{
   if(options?.operation?.startsWith('memory.'))writes.push({operation:options.operation,namespaces:[...namespaces],
    revision:store.state.revision,memorySourceRevision:store.memorySourceRevision});
   return result;
  });
 };
 let outcome;
 try{
  assert.equal(typeof runMemoryTimer,'function');
  const statuses=[],epochs=[];
  for(let attempt=0;attempt<4;attempt++){
   outcome=service.action('companion-memory-retry',{characterId:id,personaId,day})
    .then(value=>({value}),error=>({error}));
   await Promise.race([atFinal[attempt].promise,outcome.then(result=>{throw result.error??Error('Retry ended before receiving final response');})]);
   const before=store.memorySourceRevision;
   runMemoryTimer();
   await new Promise(setImmediate);
   if(automaticRead)await Promise.race([automaticRead,new Promise((_,reject)=>setTimeout(()=>reject(Error('Automatic maintenance did not settle while final dispatch was pending')),1500).unref())]);
   epochs.push({before,after:store.memorySourceRevision});
   releaseFinal[attempt].resolve();
   const result=await outcome;
   if(result.error){
    t.diagnostic(JSON.stringify({epochs,writes,frames,conflicts:audit.filter(row=>row.type==='memory-revision-conflict')}));
    throw result.error;
   }
   statuses.push(result.value.memoryResult.status);
  }
  const saved=await store.snapshotAsync({characterId:id});
  t.diagnostic(JSON.stringify({epochs,writes,frames,conflicts:audit.filter(row=>row.type==='memory-revision-conflict')}));
  assert.deepEqual(statuses,['failed','failed','failed','committed']);
  assert.equal(Object.keys(saved.lives[id].memory.summaries).length,1);
  assert.deepEqual(frames,Array(4).fill('memory-daily'));
  assert.equal(automaticRead,undefined,'Periodic tick must wait for its next interval');
 }finally{
  for(const {resolve} of releaseFinal)resolve();
  await outcome;
  store.readMemory=baseRead;
  store.mutate=baseMutate;
  await service.close();
 }
});

test('a retry waits for active automatic work and reads the resulting daily summary',async t=>{
 const {store}=await fixture(t,1);
 const entered=Promise.withResolvers(),release=Promise.withResolvers(),calls=[];
 const memory=createCompanionMemory({store,now,autoStart:false,runModel:async(_,request)=>{
  calls.push(request.purpose);
  if(calls.length===1){entered.resolve();await release.promise;}
  return JSON.stringify(dailyResponse(request,true));
 }});
 const automatic=memory.tick();
 const automaticOutcome=automatic.then(value=>({value}),error=>({error}));
 let retryOutcome;
 try{
  await Promise.race([entered.promise,automaticOutcome.then(result=>{throw result.error??Error('Tick ended before dispatch');})]);
  let retrySettled=false;
  retryOutcome=memory.consolidate({characterId:id,personaId,day,retry:true})
   .then(value=>({value}),error=>({error})).finally(()=>{retrySettled=true;});
  let timeout;
  try{
   const context=await Promise.race([
    memory.context({characterId:id,personaId,conversationId:owner}),
    new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Context waited for an unresolved daily model')),1000);})
   ]);
   assert.ok(context.messages.some(row=>row.source?.messageId==='r16-message-0'));
  }finally{clearTimeout(timeout);}
  assert.equal(retrySettled,false,'The active automatic draft owns the same-day publication');
  release.resolve();
  const completed=await automaticOutcome,retried=await retryOutcome;
  assert.equal(completed.error?.code,undefined,completed.error?.message);
  assert.equal(completed.value.results[0].status,'committed');
  assert.equal(retried.error?.code,undefined,retried.error?.message);
  assert.equal(retried.value.status,'committed');
  assert.equal(retried.value.duplicate,true);
  assert.deepEqual(calls,['memory-daily']);
 }finally{release.resolve();await automaticOutcome;await retryOutcome;await memory.close();}
});

for(const closing of [false,true])test(closing?'memory close drains the active writer and stops queued work':'a queued memory write for another day runs after the active writer',async t=>{
 const {store}=await fixture(t,2);
 const priorDay='2026-10-19',entered=Promise.withResolvers(),release=Promise.withResolvers(),calls=[];
 await store.mutate((_,tx)=>tx.messages.update('private',owner,'r16-message-0',row=>{row.createdAt-=86400000;}));
 const memory=createCompanionMemory({store,now,autoStart:false,runModel:async(_,request)=>{
  calls.push(request.purpose);
  if(calls.length===1){entered.resolve();await release.promise;}
  return JSON.stringify(dailyResponse(request,true));
 }});
 const observe=task=>task.then(value=>({value}),error=>({error}));
 const active=observe(memory.consolidate({characterId:id,personaId,day:priorDay}));
 let queued,closed;
 try{
  await Promise.race([entered.promise,active.then(result=>{throw result.error??Error('Daily write ended before dispatch');})]);
  queued=observe(memory.consolidate({characterId:id,personaId,day}));
  let closeSettled=false;
  if(closing)closed=memory.close().finally(()=>{closeSettled=true;});
  await new Promise(setImmediate);
  assert.deepEqual(calls,['memory-daily']);
  assert.equal(closeSettled,false);
  release.resolve();
  assert.equal((await active).value?.status,'committed');
  const next=await queued;
  if(closing){
   await closed;
   assert.equal(next.error?.code,'MEMORY_PROVIDER_DISABLED');
   assert.deepEqual(calls,['memory-daily']);
  }else{
   assert.equal(next.value?.status,'committed',next.error?.message);
   assert.equal(next.value.summary.day,day);
   assert.deepEqual(calls,['memory-daily','memory-daily']);
  }
 }finally{release.resolve();await active;await queued;await closed;await memory.close();}
});

for(const mode of ['without a model','after compression','with unknown compression','after timeout'])test('group context crosses an automatic memory publication '+mode,async t=>{
 if(mode==='after timeout'){
  const original=process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE;
  process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE='1';
  t.after(()=>{
   if(original===undefined)delete process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE;
   else process.env.AI_BUDDY_R16_MEMORY_SOURCE_TRACE=original;
  });
 }
 const {store}=await fixture(t,140);
 const groupId='r16-context-group',groupPath=['groups',groupId];
 await store.mutate((state,tx)=>{
  state.groups[groupId]={id:groupId,personaId,memberIds:[id],seq:1,intervals:{}};
  tx.messages.define('group',groupId,groupPath);
  tx.messages.append('group',groupId,{id:'group-source',seq:1,role:'user',
   text:'Synthetic authorized group source',status:'sent',createdAt:now()});
  tx.records.put('group.intervals',JSON.stringify([groupId,id]),'current',{start:1,end:null},
   {array:true,at:[...groupPath,'intervals',id]});
  tx.records.put('life.groupIntervals',id,groupId,[{start:1,end:null}],{at:['lives',id,'groupIntervals']});
 });
 const audit=[],firstBatch=Promise.withResolvers(),releaseBatches=Promise.withResolvers();
 const steps=Array.from({length:2},()=>({allow:Promise.withResolvers(),committed:Promise.withResolvers()}));
 const compression=mode.includes('compression'),calls=[];
 const memory=createCompanionMemory({store,now,autoStart:false,onError:row=>audit.push(row),
  getCapacity:()=>({tokens:compression?6500:32768,verified:true}),runModel:async(_,request)=>{
   assert.ok(compression);
   assert.equal(request.purpose,'memory-query-compress-segment');
   calls.push(request.purpose);
   if(mode==='with unknown compression')throw Object.assign(Error('Unresolved compression dispatch'),{code:'MEMORY_CHECKPOINT_UNKNOWN'});
   const input=JSON.parse(request.messages[0].text);
   return JSON.stringify({coverageHash:input.coverageHash,text:'Compressed query',eventIds:[...new Set(input.events.map(row=>row.id))]});
  }});
 const read=store.readMemory.bind(store);
 const callsByRead=[];
 let writes=0,contextReads=0;
 store.readMemory=(method,args,options,model,onBatch)=>{
  if(method==='context'){
   const attempt=contextReads++;
   callsByRead[attempt]=0;
   return read(method,args,options,(...request)=>{callsByRead[attempt]++;return model(...request);},onBatch).then(async result=>{
    const step=steps[attempt];
    if(step){
     step.allow.resolve();
     await step.committed.promise;
    }
    if(mode==='after compression'&&attempt===1)await store.mutate((_,tx)=>
     tx.messages.update('private',owner,'r16-message-0',row=>{row.text='edited after context compression';}));
    return result;
   });
  }
  return read(method,args,options,model,async(batch,...handshake)=>{
   const index=writes++;
   if(index===0)firstBatch.resolve();
   const step=steps[index];
   if(step)await Promise.race([step.allow.promise,releaseBatches.promise]);
   const result=await onBatch(batch,...handshake);
   step?.committed.resolve();
   return result;
  });
 };
 const publishing=memory.sync(id),outcome=publishing.catch(error=>error);
 try{
  await Promise.race([firstBatch.promise,outcome.then(value=>{throw value??Error('Expected first memory batch');})]);
  const nativeTimeout=globalThis.setTimeout;
  let coordinationWaits=0;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{
   if(delay===2000){
    coordinationWaits++;
    if(mode!=='after timeout')setImmediate(()=>releaseBatches.resolve());
    return nativeTimeout(callback,mode==='after timeout'?10:delay,...args);
   }
   return nativeTimeout(callback,delay,...args);
  });
  const request=memory.context({characterId:id,personaId,groupId,requiredGroupMessage:{id:'group-source',seq:1},
   ...(compression?{query:'x'.repeat(4700),reserveTokens:3000}:{})});
  if(mode==='without a model'){
   const context=await request;
   assert.ok(context.messages.some(row=>row.source?.messageId==='group-source'));
   assert.ok(context.messages.every(row=>row.source?.type==='group'));
   assert.equal(contextReads,2);
   assert.equal(coordinationWaits,1);
   assert.deepEqual(audit,[]);
  }else if(mode==='with unknown compression'){
   await assert.rejects(request,{code:'MEMORY_CHECKPOINT_UNKNOWN'});
   assert.equal(contextReads,1);
   assert.equal(calls.length,1);
   assert.equal(coordinationWaits,0);
   assert.deepEqual(audit,[]);
  }else{
   const observed=request.finally(()=>t.diagnostic(JSON.stringify({contextReads,callsByRead,coordinationWaits})));
   await assert.rejects(observed,{code:'MEMORY_VALIDATION'});
   if(mode==='after compression'){
    assert.equal(contextReads,2);
    assert.ok(callsByRead[0]>0);
    assert.deepEqual(callsByRead,[callsByRead[0],callsByRead[0]]);
    assert.equal(coordinationWaits,0,'Paid context retains its original retry limit');
   }else{
    assert.equal(contextReads,1);
    assert.equal(coordinationWaits,1);
    assert.equal(audit[0].coordinated,true);
    assert.equal(audit[0].crossedPublication,true);
    assert.equal(audit[0].modelRequested,false);
    assert.equal(audit[0].readAttempts.length,1);
    assert.ok(audit[0].sourceChanges.some(change=>change.operation==='memory.sync'&&change.effects.includes('memory.events')));
   }
   assert.equal(audit.length,1);
   assert.equal(audit[0].phase,'read-final');
  }
 }finally{
  releaseBatches.resolve();
  await outcome;
  await memory.close();
 }
});
