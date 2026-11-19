import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {apply} from '../src/adapted/game-core.ts';
import {createDeferredSaves} from '../src/deferred-saves.mjs';
import {restrictedFileService} from '../src/storage.mjs';
import {openCompanionStore} from '../src/companion-store.mjs';
import {createCompanionService} from '../src/companion-service.mjs';
import {createCompanionCacheStore,createCompanionNativeStore,NATIVE_WRITE_QUEUED} from '../src/companion-cache-store.mjs';
import {CodexProvider} from '../src/codex-provider.mjs';
import {codexHistoryHash} from '../src/codex-thread-wire.mjs';
import {ModelRouter} from '../src/model-router.mjs';
import {tmpDir} from './support/audit-harness.mjs';

function fakeRpc(requests){
 let sequence=0,children=0,turns=0,heldTurn;
 const spawn=()=>{
  const child=new EventEmitter(),index=++children;
  Object.assign(child,{pid:400000+index,stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill(){child.emit('exit',1);}});
  child.stdin.once('end',()=>child.emit('exit',0));
  const send=value=>child.stdout.write(JSON.stringify(value)+'\n');
  child.stdin.on('data',data=>{
   const {id,method,params}=JSON.parse(String(data));
   requests.push({method,threadId:params?.threadId,index});
   if(id===undefined)return;
   let result={};
   if(method==='account/read')result={account:{type:'chatgpt'}};
   if(method==='model/list')result={data:[{id:'gpt-5.4',defaultReasoningEffort:'low'}]};
   if(method==='thread/start')result={thread:{id:'native-'+(++sequence),modelProvider:'openai'}};
   if(method==='thread/resume')result={thread:{id:params.threadId,modelProvider:'openai'}};
   if(method==='turn/start'){
    const {threadId}=params,turnId='turn-'+(++turns);
    result={turn:{id:turnId}};
    const finish=()=>{
     send({method:'item/completed',params:{threadId,turnId,item:{id:turnId,type:'agentMessage',text:'Synthetic native reply'}}});
     send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});
    };
    if(heldTurn){heldTurn.resolve({finish,threadId});heldTurn=null;}
    else queueMicrotask(finish);
   }
   send({id,result});
  });
  queueMicrotask(()=>child.emit('spawn'));
  return child;
 };
 return {spawn,childCount:()=>children,holdTurn(){heldTurn=Promise.withResolvers();return heldTurn.promise;}};
}

async function fixture(t,{retryMs=3000,providerTiming={}}={}){
 let service,router,store,engine;
 const facades=[],providers=[],effects=[],events=[],requests=[],apiRequests=[];
 const closeHost=async()=>{
  await service?.close();await router?.close();await store?.close();
 };
 const root=tmpDir('native-r5',{t,beforeRemove:async()=>{
  await closeHost();await Promise.all(providers.map(provider=>provider.close()));
  await Promise.all(facades.map(facade=>facade.close()));
  await engine?.flushSaves();engine?.releaseDeferredSaves();for(const cleanup of effects)cleanup();
 }});
 const file=join(root,'companion-cache-r1.sqlite');
 const apiReader=()=>{const cache=createCompanionCacheStore(root,event=>events.push(event),{retryMs});facades.push(cache);return cache;};
 const nativeReader=()=>{const cache=createCompanionNativeStore(root);facades.push(cache);return cache;};
 const api=apiReader(),native=nativeReader();
 await api.ready();
 const rpc=fakeRpc(requests),binary=join(root,'fixture.exe'),codexOptions={binary,defaultModel:'gpt-5.4',dataRoot:root,
  env:{USERPROFILE:root,CODEX_HOME:join(root,'empty-home')},spawnImpl:rpc.spawn,handshakeTimeoutMs:2000,turnTimeoutMs:2000,...providerTiming,
  osProcesses:{
   async inspect(pid){return {pid,hostPid:process.pid,executable:binary,creationTime:'1000',ownerSid:'fixture-sid'};},
   async killTree(){assert.fail('the synthetic process exits via stdin');},
  },
 };
 const codex=new CodexProvider(codexOptions);
 router=await new ModelRouter({codex,dataRoot:root,legacy:true,fetchImpl:async(_url,{body})=>{
  apiRequests.push(JSON.parse(body).model);
  return Response.json({choices:[{message:{content:'Synthetic API reply'},finish_reason:'stop'}]});
 }}).ready;
 const profile=await router.save({kind:'custom',baseUrl:'http://localhost:1/v1',model:'fixture-api'});
 router.setEnabled(true);
 const header={id:'whale-companion-local',cwd:root,events:[]};
 const services={fs:restrictedFileService(root),sandboxPolicy:{resolve:()=>({workspaceRoot:root})},sessions:{list:()=>[header]},workspaceRegistry:{list:()=>[{path:root}]},agentDefaultModel:router,sessionQuery:{listSessions:async()=>[header],listEvents:async()=>[]}};
 engine=apply({
  deferredSaveRegistry:createDeferredSaves(),deferredSaveScope:root,llm:router,language:()=> 'en',
  dshHomePath:(...parts)=>join(root,'galgame',...parts),inject:(_keys,fn)=>fn(services),on(){},emit(){},
  effect(fn){const cleanup=fn();if(typeof cleanup==='function')effects.push(cleanup);},
  companionSignal:id=>service?.signalFor(id),captureCompanionDelta:value=>service?.captureDelta(value),
 },{enabled:true,singleChatSelection:true,chatModel:codex.defaultModel,strictModelErrors:true});
 await engine.handleAction('settings-get',{});
 store=await openCompanionStore(root);
 service=await createCompanionService({store,engine,provider:router,dataRoot:root,getLanguage:()=> 'en',automaticWorkAllowed:()=>false,r95Options:{tickAllowed:()=>false}});
 return {file,native,api,apiReader,nativeReader,events,service,store,codex,requests,apiRequests,closeHost,...rpc,
  async useApi(){await router.activate(profile.id);await codex.setEnabled(false);},
  async useNative(){await router.activate('codex');},
  async send(text){
   const result=await service.chat({text});
   const reply=result.companion?.messages.at(-1);
   assert.equal(reply?.role,'assistant','public chat must persist an assistant reply');
   await service.action('companion-private-present',{conversationId:result.companion.activeConversationId,id:reply.id,occurrenceId:reply.occurrenceId});
   return result.companion;
  },
  openProvider(){const provider=new CodexProvider(codexOptions);providers.push(provider);return provider;},
 };
}

const observed=promise=>promise.catch(error=>({code:error.code}));
const threadKey=id=>'thread:'+id;
const storedThread=async(native,id)=>(await native.read(threadKey(id)))?.state;
const legacyTask='legacy-dedupe';
const keptScope={key:'unrelated-cache',conversationId:'unrelated-conversation',characterId:'unrelated-character'};
const apiPayload=sessionUuid=>({sessionUuid,instructionsHash:'a'.repeat(64),parent:null,entries:[]});
async function createLegacyCopy(f,originalId){
 await f.service.action('companion-conversation-new',{});
 const duplicateId=f.store.state.activeConversationId;
 assert.notEqual(duplicateId,originalId);
 await f.store.mutate((state,tx)=>{
  for(const [position,id] of [originalId,duplicateId].entries()){
   const conversation=state.conversations[id];
   conversation.createdAt=1000+position;
   for(const [line,role] of ['user','assistant'].entries()){
    tx.messages.append('private',id,{id:id+'-fixture-'+line,role,legacy:true,text:'Synthetic legacy '+line,createdAt:2000+line,seq:++conversation.seq});
   }
  }
 });
 return duplicateId;
}

test('N3 private API and native rounds complete with a shared open SQLite write circuit',async t=>{
 const f=await fixture(t),secondNative=f.nativeReader();
 const first=await f.send('Synthetic native first round');
 const conversationId=first.activeConversationId,user=first.messages.find(row=>row.role==='user');
 await f.useApi();
 await f.service.action('companion-settings',{allowUserMessageEdit:true});
 assert.equal(await storedThread(f.native,'native-1'),'confirmed');
 assert.equal(await f.native.write('note:removed',{revision:1}),true);
 assert.equal(await f.native.write('note:retained',{revision:1}),true);
 const lock=new DatabaseSync(f.file);
 lock.exec('BEGIN IMMEDIATE');
 const accepted=[],interspersed=[];
 let reopened,apiReplyId,secondId;
 try{
  for(let revision=1;revision<=3;revision++){
   accepted.push(await observed(f.native.write('note:latest',{revision})));
   interspersed.push([await observed(secondNative.read('note:latest')),await observed(secondNative.read('note:retained'))]);
  }
  const remove=await observed(f.native.remove('note:removed'));
  const list=await observed(secondNative.list());
  const apiRound=await f.send('Synthetic API round during lock');
  apiReplyId=apiRound.messages.at(-1).id;
  await f.useNative();
  await f.send('Synthetic native round during lock');
  assert.ok(f.apiRequests.includes('fixture-api'));
  const second=(await secondNative.list()).find(({value})=>value.scope?.conversationId===conversationId&&value.state==='confirmed');
  secondId=second?.value.threadId;
  assert.ok(secondId&&secondId!=='native-1','the later private round confirms its own native thread');
  assert.equal(f.requests.filter(row=>row.method==='turn/start'&&row.threadId===secondId).length,1);
  assert.deepEqual(accepted,Array(3).fill(NATIVE_WRITE_QUEUED));
  assert.deepEqual(interspersed,[[{revision:1},{revision:1}],[{revision:2},{revision:1}],[{revision:3},{revision:1}]]);
  assert.equal(remove,false,'a memory tombstone is not a physical cleanup acknowledgement');
  assert.ok(Array.isArray(list));
  assert.equal(list.some(({key})=>key==='note:removed'),false);
  assert.equal(await secondNative.read('note:removed'),null);
  assert.equal(f.api.isDurable(),false);
  assert.equal(f.events.filter(event=>event.type==='companion-cache-memory-fallback').length,1);
  assert.equal(f.api.write(keptScope,null,apiPayload('old revision')),1);
  assert.equal(await f.api.flush(keptScope.key),false);
  assert.equal(f.api.write(keptScope,1,apiPayload('replayed revision')),2);
  await f.useApi();
  const children=f.childCount(),requests=f.requests.length;
  await f.service.action('companion-message-edit',{conversationId,id:user.id,occurrenceId:user.occurrenceId,text:'Synthetic in-circuit correction'});
  assert.equal(await storedThread(secondNative,secondId),'delete-pending');
  const duplicateId=await createLegacyCopy(f,conversationId);
  const record=await secondNative.read(threadKey(secondId));
  await f.native.write(threadKey('copy'),{...record,threadId:'copy',state:'confirmed',scope:{...record.scope,conversationId:duplicateId}});
  const planned=await f.service.maintenance.plan(legacyTask);
  assert.equal(planned.total,2);
  await f.service.maintenance.apply(legacyTask,planned.planId);
  assert.equal(await storedThread(secondNative,'copy'),'delete-pending');
  assert.equal(f.childCount(),children);
  assert.equal(f.requests.length,requests);
  assert.equal((await secondNative.list()).some(({key})=>key.startsWith('process:')),false);
  await f.closeHost();
  await Promise.all([f.native.close(),secondNative.close(),f.api.close()]);
  reopened=f.nativeReader();
  assert.equal(await reopened.read('note:removed'),null);
  assert.equal(await storedThread(reopened,'copy'),'delete-pending');
 }finally{lock.close();}
 const observer=f.apiReader();
 await observer.ready();
 assert.equal(observer.read(keptScope.key)?.revision,2);
 assert.equal(observer.write(keptScope,2,apiPayload('continued revision')),3);
 assert.equal(await observer.flush(keptScope.key),false);
 assert.deepEqual(await reopened.read('note:latest'),{revision:3});
 assert.equal(f.events.filter(event=>event.type==='companion-cache-durability-restored').length,0);
 await delay(3050);
 assert.deepEqual(await reopened.read('note:latest'),{revision:3});
 assert.equal((await reopened.list()).some(({key})=>key==='note:removed'),false);
 assert.equal(observer.isDurable(),false,'reads after the deadline must not acknowledge writes');
 assert.equal(await reopened.write('note:recovery',{done:true}),true);
 assert.equal(observer.isDurable(),true);
 assert.equal(f.events.filter(event=>event.type==='companion-cache-durability-restored').length,1);
 const reader=new DatabaseSync(f.file,{readOnly:true});
 try{
  const row=key=>reader.prepare('SELECT payload FROM native_state WHERE key=?').get(key)?.payload;
  assert.equal(JSON.parse(row('note:latest')).revision,3);
  assert.equal(row('note:removed'),undefined);
  assert.equal(JSON.parse(row(threadKey('native-1'))).state,'delete-pending');
  assert.equal(JSON.parse(row(threadKey(secondId))).state,'delete-pending');
  assert.equal(JSON.parse(row(threadKey('copy'))).state,'delete-pending');
  assert.equal(reader.prepare("SELECT count(*) AS count FROM native_state WHERE key LIKE 'process:%'").get().count,0);
  const cache=reader.prepare('SELECT revision,payload FROM api_windows WHERE scope_key=?').get(keptScope.key);
  assert.equal(cache?.revision,3);
  assert.equal(JSON.parse(cache.payload).sessionUuid,'continued revision');
  assert.equal(reader.prepare('SELECT count(*) AS count FROM api_windows WHERE instr(payload,?)>0').get(apiReplyId).count,0,
   'maintenance cleanup must not resurrect a queued API window');
 }finally{reader.close();}
});

test('N4 a changed private message marks its owned threads during API selection without starting Codex',async t=>{
 const f=await fixture(t);
 const conversation=await f.send('Synthetic original');
 const conversationId=conversation.activeConversationId,user=conversation.messages.find(row=>row.role==='user');
 await f.useApi();
 await f.service.action('companion-settings',{allowUserMessageEdit:true});
 const record=await f.native.read(threadKey('native-1'));
 const put=(threadId,fields)=>f.native.write(threadKey(threadId),{...record,threadId,...fields});
 await put('already-retired',{state:'delete-pending',retirementMarker:true});
 await put('other-scope',{scope:{...record.scope,conversationId:'other-scope'}});
 await put('other-owner',{scope:{...record.scope,characterId:'other-character'}});
 await put('waiting-host',{requestId:'stale-host-request',state:'awaiting-host-commit'});
 const children=f.childCount(),requests=f.requests.length;
 const edit=text=>f.service.action('companion-message-edit',{conversationId,id:user.id,occurrenceId:user.occurrenceId,text});
 await edit('Synthetic original');
 assert.equal(await storedThread(f.native,'native-1'),'confirmed');
 await edit('Synthetic corrected');
 assert.equal(await storedThread(f.native,'native-1'),'delete-pending');
 assert.equal(await f.codex.commitPrivateThread('stale-host-request',{lastMessageId:'synthetic'}),false);
 assert.equal(await storedThread(f.native,'waiting-host'),'delete-pending');
 assert.equal((await f.native.read(threadKey('already-retired'))).retirementMarker,true);
 assert.equal(await storedThread(f.native,'other-scope'),'confirmed');
 assert.equal(await storedThread(f.native,'other-owner'),'confirmed');
 assert.equal(f.childCount(),children);
 assert.equal(f.requests.length,requests);
});

test('N4 legacy duplicate deletion retires only the conversation whose messages were removed',async t=>{
 const f=await fixture(t);
 await f.useApi();
 await f.service.action('companion-conversation-new',{});
 const originalId=f.store.state.activeConversationId;
 const {characterId,lifeId,personaId}=f.store.state.conversations[originalId];
 const original={threadId:'native-1',scope:{conversationId:originalId,characterId,lifeId,personaId},state:'confirmed',archived:true};
 await f.native.write(threadKey(original.threadId),original);
 const duplicateId=await createLegacyCopy(f,originalId);
 await f.native.write(threadKey('copy'),{...original,threadId:'copy',scope:{...original.scope,conversationId:duplicateId}});
 const children=f.childCount(),requests=f.requests.length;
 const plan=await f.service.maintenance.plan(legacyTask);
 assert.equal(plan.total,2);
 assert.equal(await storedThread(f.native,'copy'),'confirmed');
 const removed=await f.service.maintenance.apply(legacyTask,plan.planId);
 assert.deepEqual(removed.conversations.map(row=>[row.conversationId,row.count]),[[duplicateId,2]]);
 assert.equal((await f.store.messages.history('private',duplicateId)).totalCount,0);
 assert.equal(await storedThread(f.native,'copy'),'delete-pending');
 assert.equal(await storedThread(f.native,'native-1'),'confirmed');
 assert.equal(f.childCount(),children);
 assert.equal(f.requests.length,requests);
});

test('N4 retirement fences an active native reply and the next ordinary startup drains a bounded batch',async t=>{
 const f=await fixture(t);
 await f.useApi();
 const current=await f.send('Synthetic editable original');
 await f.service.action('companion-settings',{allowUserMessageEdit:true});
 const conversationId=current.activeConversationId,user=current.messages.find(row=>row.role==='user');
 const {characterId,personaId,lifeId}=f.store.state.conversations[conversationId];
 const scope={characterId,personaId,lifeId,conversationId,operationId:f.store.state.lives[characterId].operationId};
 const requestId='fixture-late-confirmation',receipts=[];
 f.codex.setEnabled(true);
 const held=f.holdTurn();
 const stream=(async()=>{
  let finished=false;
  for await(const event of f.codex.streamForConnection('codex',{
   system:'Synthetic instructions',messages:[{role:'user',content:'Synthetic native input'}],
   cacheContext:{native:{scope,requestId,historyHash:codexHistoryHash([])}},
   onNativeThread:receipt=>receipts.push(receipt),
  }))if(event.type==='finish')finished=true;
  return finished;
 })();
 const active=await Promise.race([held,stream.then(()=>assert.fail('fixture turn was never held'))]);
 try{
  const children=f.childCount(),requests=f.requests.length;
  assert.equal(await storedThread(f.native,active.threadId),'submitting');
  await f.service.action('companion-message-edit',{conversationId,id:user.id,occurrenceId:user.occurrenceId,text:'Synthetic active correction'});
  assert.equal(await storedThread(f.native,active.threadId),'delete-pending');
  assert.equal(f.childCount(),children);
  assert.equal(f.requests.length,requests);
 }finally{active.finish();}
 assert.equal(await stream,true);
 assert.deepEqual(receipts,[]);
 assert.equal(await f.codex.commitPrivateThread(requestId,{lastMessageId:'late'}),false);
 assert.equal(await storedThread(f.native,active.threadId),'delete-pending');
 const record=await f.native.read(threadKey(active.threadId));
 await f.codex.setEnabled(false);
 assert.equal(await f.native.read(threadKey(active.threadId)),null);
 assert.deepEqual(f.requests.filter(row=>row.method==='thread/delete').map(row=>row.threadId),[active.threadId]);
 for(let index=1;index<=6;index++){
  const threadId='deletion-fixture-'+index;
  await f.native.write(threadKey(threadId),{...record,threadId});
 }
 const startup=f.openProvider();
 startup.setEnabled(true);
 await startup.start();
 let remaining=[];
 for(let attempt=0;attempt<100;attempt++){
  remaining=(await f.native.list()).filter(({value})=>value.state==='delete-pending');
  if(remaining.length===2)break;
  await delay(10);
 }
 assert.equal(remaining.length,2);
 const deleted=f.requests.filter(row=>row.method==='thread/delete');
 assert.equal(deleted.length,5);
 assert.equal(f.requests.some(row=>row.method==='thread/list'),false);
});


for(const shutdown of ['idle','explicit'])test('R6 Q1 a retired loaded thread is archived and deleted before '+shutdown+' shutdown',async t=>{
 const f=await fixture(t,{providerTiming:{threadIdleMs:shutdown==='idle'?300:30000,deleteIdleMs:100,poolIdleMs:150}});
 const scope={characterId:'character',lifeId:'life',personaId:'persona',conversationId:'conversation'};
 const requestId='fixture-retirement';
 f.codex.setEnabled(true);
 let finished=false;
 for await(const event of f.codex.streamForConnection('codex',{
  system:'Synthetic instructions',messages:[{role:'user',content:'Synthetic input'}],
  cacheContext:{native:{scope,requestId,historyHash:codexHistoryHash([])}},
 }))if(event.type==='finish')finished=true;
 assert.equal(finished,true);
 assert.equal(await f.codex.commitPrivateThread(requestId,{lastMessageId:'assistant-fixture'}),true);
 assert.equal(await storedThread(f.native,'native-1'),'confirmed');
 assert.equal(await f.codex.markPrivateThreadsForDeletion({conversationId:scope.conversationId}),1);
 assert.equal(await storedThread(f.native,'native-1'),'delete-pending');
 if(shutdown==='explicit')await f.codex.setEnabled(false);
 else for(let attempt=0;attempt<100&&f.codex.child;attempt++)await delay(20);
 assert.equal(f.codex.child,null,'the existing process should stop normally');
 assert.deepEqual(f.requests.filter(row=>['thread/archive','thread/delete'].includes(row.method)),[
  {method:'thread/archive',threadId:'native-1',index:1},
  {method:'thread/delete',threadId:'native-1',index:1},
 ]);
 assert.equal(await f.native.read(threadKey('native-1')),null);
 assert.equal(f.childCount(),1);
 assert.equal(f.requests.some(row=>row.method==='thread/list'),false);
});

for(const slowFlush of [false,true])test('R6 Q3 native prepare submits before SQLite unlock '+(slowFlush?'with a blocked API flush':'without competing writes')+' and replays the confirmed record',async t=>{
 const f=await fixture(t);
 f.codex.setEnabled(true);
 await f.codex.start();
 // Wait for initial process ownership writes before applying the external write lock.
 await f.native.list();
 const lock=new DatabaseSync(f.file);
 lock.exec('BEGIN IMMEDIATE');
 const requestId='fixture-prepare-locked',scope={characterId:'character',lifeId:'life',personaId:'persona',conversationId:'conversation'};
 const reachedTurn=f.holdTurn();
 let completed,held,flushing,flushSettled=false,submitted=false,turnFinished=false;
 try{
  if(slowFlush){
   f.api.write(keptScope,undefined,apiPayload('fixture-blocked-flush'));
   flushing=f.api.flush().finally(()=>{flushSettled=true;});
   await delay(60);
   assert.equal(flushSettled,false,'the competing write must remain in flight');
  }
  completed=(async()=>{
   for await(const event of f.codex.streamForConnection('codex',{
    system:'Synthetic instructions',messages:[{role:'user',content:'Synthetic input'}],
    cacheContext:{native:{scope,requestId,historyHash:codexHistoryHash([])}},
   }))if(event.type==='finish')return true;
   return false;
  })();
  held=await Promise.race([reachedTurn,delay(800,null,{ref:false})]);
  submitted=!!held;
  if(held){
   if(slowFlush)assert.equal(flushSettled,false,'the turn waited for the competing write');
   assert.equal(await storedThread(f.native,held.threadId),'submitting');
   assert.ok((await f.native.list()).some(({value})=>value.threadId===held.threadId&&value.state==='submitting'));
   if(slowFlush)assert.equal(flushSettled,false,'native reads waited for the competing write');
   held.finish();
   turnFinished=true;
   assert.equal(await completed,true);
   assert.equal(await f.codex.commitPrivateThread(requestId,{lastMessageId:'assistant-fixture'}),true);
   if(slowFlush)assert.equal(flushSettled,false,'native completion waited for the competing write');
  }
 }finally{
  lock.exec('ROLLBACK');
  lock.close();
  if(!held){
   held=await Promise.race([reachedTurn,completed?.then(()=>null)]);
  }
  if(!turnFinished)held?.finish();
  await completed;
  await flushing;
 }
 assert.equal(submitted,true,'prepare waited for SQLite BUSY retries before submitting the turn');
 const reader=new DatabaseSync(f.file,{readOnly:true});
 try{
  const query=reader.prepare('SELECT payload FROM native_state WHERE key=?');
  let replayed;
  for(let attempt=0;attempt<100;attempt++){
   const row=query.get(threadKey('native-1'));
   if(row){replayed=JSON.parse(row.payload);break;}
   await delay(20);
  }
  assert.equal(replayed?.state,'confirmed');
  assert.equal(replayed.lastMessageId,'assistant-fixture');
 }finally{reader.close();}
});
