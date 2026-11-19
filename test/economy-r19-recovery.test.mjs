import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {Worker} from 'node:worker_threads';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {economyWrites} from '../src/companion-economy-operations.mjs';
import {importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';

const now=()=>1_800_000_000_000;
const scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
const fact=(id,totalTokens)=>({canonicalRequestId:id,totalTokens,scope});
const trusted={trusted:true};
const operations=Object.keys(economyWrites);
const faultPhases={beforeCommit:1,afterCommit:2,beforeRequest:3,errorAck:4};
const code=error=>({message:error.message,code:error.code});

async function fixture(t,{probeFault}={}){
 const root=await mkdtemp(join(tmpdir(),'buddy-r19-economy-'));
 const control=new Int32Array(new SharedArrayBuffer(8));
 const workers=[],metrics=new Int32Array(new SharedArrayBuffer(12));
 let store;
 const open=async()=>store=await createEconomyStore(root,{now,workerFactory:(_url,options)=>{
  const worker=new Worker(new URL('./fixtures/economy-worker-fault.mjs',import.meta.url),{
   ...options,workerData:{...options.workerData,crash:control.buffer,probeMetrics:metrics.buffer,probeFault:workers.length===1?probeFault:undefined}
  });
  workers.push(worker);
  return worker;
 }});
 t.after(async()=>{try{await store?.close();}finally{await rm(root,{recursive:true,force:true});}});
 await open();
 function crash(op,phase){
  Atomics.store(control,1,faultPhases[phase]);
  Atomics.store(control,0,operations.indexOf(op)+1);
 }
 function faultReached(op,phase){assert.equal(Atomics.load(control,0),0,op+' did not reach '+phase);}
 return {get store(){return store;},get worker(){return workers.at(-1);},root,workers,metrics,open,crash,faultReached};
}

async function originalError(invoke,expectedCode){
 let original;
 await assert.rejects(invoke(),error=>{original=code(error);return error.code===expectedCode;});
 return original;
}

test('S2 a lost reward conflict ACK preserves the worker error and lets the next write commit',async t=>{
 const f=await fixture(t),s=f.store;
 await s.initializeRewards();
 await s.ingestUsageFact(fact('source',20_000),trusted);
 const invoke=()=>s.ingestUsageFacts([fact('source',10_000)],trusted);
 const original=await originalError(invoke,'REWARD_FACT_CONFLICT');
 f.crash('ingestUsageFacts','errorAck');
 await assert.rejects(invoke(),original);
 f.faultReached('ingestUsageFacts','errorAck');
 assert.equal(s.wallet().balance,2);
 await s.ingestUsageFact(fact('next',10_000),trusted);
 assert.equal(s.wallet().balance,3);
});
const tx={transactionId:'life-tx',scope,target:{scope:{...scope,lifeId:'target',operationId:'target-op'},satiety:40}};
const player={...scope,id:'ai',kind:'ai'};
const user={id:'user',kind:'user',personaId:scope.personaId};
const buy={scope,foodId:'rice',requestId:'buy'};
const eat={scope,foodId:'rice',requestId:'eat'};
const tableId='table';
const start={tableId,commandId:'create',type:'texas',players:[user,player],buyIn:200};
const move={tableId,commandId:'action',expectedVersion:1,action:{type:'fold',actorId:'user'}};
const next={tableId,commandId:'next',expectedVersion:2};
const req={id:'model-request',fingerprint:'request',state:'queued'};
const ack={recorded:true,eventId:'outbox-event'};
const hunger=(requestId,decay=60)=>({requestId,decay,at:now()});
const prepare=store=>store.prepareLife(tx);
async function initialize(store){await store.initializeRewards();}
async function hungry(store){await store.mergeHunger(scope,hunger('setup-hunger'));}
async function fund(store,points=2){
 await initialize(store);
 await store.ingestUsageFact(fact('fund',points*10_000),trusted);
}
async function setAuto(store){await store.settings({autoEat:true,autoBuyRice:true,allowedFoods:['rice']});}
async function seedFact(store){await store.ingestUsageFact(fact('conflict',10_000),trusted);}

const failures=[
 ['mergeHunger','ECONOMY_COMMAND_CONFLICT',hungry,s=>s.mergeHunger(scope,hunger('setup-hunger',5))],
 ['mergeHunger','FEEDING_LIFE_TRANSACTION_PENDING',prepare,s=>s.mergeHunger(scope,hunger('pending'))],
 ['initializeRewards','REWARD_FACT_CONFLICT',seedFact,s=>s.initializeRewards({facts:[fact('conflict',20_000)]})],
 ['ingestUsageFact','REWARD_FACT_CONFLICT',seedFact,s=>s.ingestUsageFact(fact('conflict',20_000),trusted)],
 ['ingestUsageFacts','REWARD_FACT_CONFLICT',seedFact,s=>s.ingestUsageFacts([fact('conflict',20_000)],trusted)],
 ['purchase','INSUFFICIENT_POINTS',null,s=>s.purchase(buy)],
 ['purchase','FEEDING_LIFE_TRANSACTION_PENDING',prepare,s=>s.purchase(buy)],
 ['consume','FOOD_OUT_OF_STOCK',hungry,s=>s.consume(eat)],
 ['consume','FEEDING_LIFE_TRANSACTION_PENDING',prepare,s=>s.consume(eat)],
 ['purchaseAndConsumeRice','INSUFFICIENT_POINTS',async s=>{await hungry(s);await setAuto(s);},s=>s.purchaseAndConsumeRice(eat)],
 ['prepareLife','FEEDING_LIFE_TRANSACTION_PENDING',prepare,s=>s.prepareLife({...tx,transactionId:'other-life-tx'})],
 ['applyLife','FEEDING_LIFE_TRANSACTION_NOT_FOUND',null,s=>s.applyLife(tx)],
 ['finalizeLife','FEEDING_LIFE_TRANSACTION_NOT_APPLIED',prepare,s=>s.finalizeLife(tx)],
 ['games.welfare','GAME_USER_WELFARE_DENIED',null,s=>s.games.welfare(user,'welfare')],
 ['games.create','GAME_RULES_UNAVAILABLE',null,s=>s.games.create(start)],
 ['games.action','GAME_RULES_UNAVAILABLE',null,s=>s.games.action(move)],
 ['games.control','GAME_TABLE_NOT_FOUND',null,s=>s.games.control({...move,commandId:'pause',op:'pause'})],
 ['games.next','GAME_RULES_UNAVAILABLE',null,s=>s.games.next(next)],
 ['games.chat','GAME_TABLE_NOT_FOUND',null,s=>s.games.chat({tableId,submissionId:'chat',text:'hello',scope})],
 ['games.appendChat','GAME_TABLE_NOT_FOUND',null,s=>s.games.appendChat({tableId,id:'append',characterId:scope.characterId,text:'hello'})],
 ['games.restoreAccount','GAME_USER_RESTORE_DENIED',null,s=>s.games.restoreAccount({commandId:'restore',player:user,balance:5})],
 ['games.acknowledge','GAME_OUTBOX_ACK_INVALID',null,s=>s.games.acknowledge(ack.eventId,ack)],
 ['games.request','GAME_REQUEST_CONFLICT',s=>s.games.request(req),s=>s.games.request({...req,fingerprint:'changed'})],
];

for(const [op,expected,setup,invoke] of failures){
 test('S2 '+op+' keeps '+expected+' after both lost-response boundaries',async t=>{
  const f=await fixture(t),s=f.store;
  await setup?.(s);
  const original=await originalError(()=>invoke(s),expected);
  for(const phase of ['beforeRequest','errorAck']){
   const before=s.view(scope);
   f.crash(op,phase);
   await assert.rejects(invoke(s),original);
   f.faultReached(op,phase);
   assert.deepEqual(s.view(scope),before,'failed request and probe leave no SQL changes');
   assert.equal((await s.settings({autoBuyRice:phase==='beforeRequest'})).autoBuyRice,phase==='beforeRequest');
  }
 });
}

for(const op of ['purchase','consume']){
 test('S2 '+op+' returns its existing receipt with a pending life transaction',async t=>{
  const f=await fixture(t),s=f.store;
  await fund(s);
  if(op==='consume'){await hungry(s);await s.purchase(buy);}
  const request=op==='purchase'?buy:eat,previous=await s[op](request);
  await prepare(s);
  const view=s.view(scope);
  for(const phase of ['beforeCommit','afterCommit']){
   f.crash(op,phase);
   const expected={...previous,...op==='consume'&&{newlyConsumed:false},duplicate:true};
   assert.deepEqual(await s[op](request),expected);
   f.faultReached(op,phase);
   assert.deepEqual(s.view(scope),view);
  }
 });
}
const archivePath=process.env.AI_BUDDY_R18_CARD_ARTIFACT;
const approvedArchiveSha256='96aec106a971aa2d85c9cb8d85598551c7aa40f795efd517b98a0df4aeab8552';
async function registerRules(f){
 const artifact=await importVerifiedGameRules({archivePath,archiveSha256:approvedArchiveSha256,cacheRoot:join(f.root,'rules')});
 await f.store.games.registerRules(artifact);
}
const createTable=store=>store.games.create(start);
const fold=table=>({...move,expectedVersion:table.version,action:{type:'fold',actorId:table.state.actorId}});

test('S2 create, action and next return committed receipts after rules become unavailable',{skip:!archivePath},async t=>{
 const f=await fixture(t);
 await fund(f.store,200);
 await registerRules(f);
 const created=await createTable(f.store),action=fold(created);
 const completed=await f.store.games.action(action);
 const nextSpec={...next,expectedVersion:completed.version};
 const dealt=await f.store.games.next(nextSpec);
 await f.store.close();
 const s=await f.open();
 assert.throws(()=>s.games.project(dealt,'user'),{code:'GAME_RULES_UNAVAILABLE'});
 const before=s.view(scope);
 for(const [op,arg,prior] of [['create',start,created],['action',action,completed],['next',nextSpec,dealt]]){
  for(const phase of ['beforeCommit','afterCommit']){
   f.crash('games.'+op,phase);
   assert.deepEqual(await s.games[op](arg),{...prior,duplicate:true});
   f.faultReached('games.'+op,phase);
   assert.deepEqual(s.games.table(tableId),dealt);
   assert.deepEqual(s.view(scope),before);
  }
 }
});

test('S3 an idle worker exit reconnects before binding, recovery and ordinary writes',async t=>{
 const f=await fixture(t),s=f.store;
 for(const [name,invoke,expected] of [
  ['binding',()=>s.games.binding({id:'binding',scope}),{id:'binding',scope}],
  ['recover',()=>s.games.recover(),{recovered:true,automaticRequests:false}],
  ['settings',()=>s.settings({autoEat:true}),{autoEat:true,autoBuyRice:false,allowedFoods:[],dailyAutoPurchaseLimit:'unlimited'}],
 ]){
  const prior=f.worker;
  await prior.terminate();
  assert.deepEqual(await invoke(),expected,name);
  assert.notEqual(f.worker,prior);
 }
 assert.deepEqual(s.games.binding('binding'),{id:'binding',scope});
});

test('S3 a synchronous postMessage failure is retried before a non-idempotent binding is sent',async t=>{
 const f=await fixture(t),s=f.store;
 f.worker.postMessage=()=>{throw Error('synthetic synchronous postMessage failure');};
 const binding={id:'binding',scope};
 assert.deepEqual(await s.games.binding(binding),binding);
 assert.deepEqual(s.games.binding(binding.id),binding);
 assert.equal(f.workers.length,2);
});

test('S3 a binding already posted before losing its ACK still fails closed',async t=>{
 const f=await fixture(t),s=f.store;
 const binding={id:'binding',scope};
 f.crash('games.binding','afterCommit');
 await assert.rejects(s.games.binding(binding),{code:'ECONOMY_WORKER_REOPEN'});
 f.faultReached('games.binding','afterCommit');
 assert.deepEqual(s.games.binding(binding.id),binding);
 await assert.rejects(s.settings({autoEat:true}),{code:'ECONOMY_WORKER_REOPEN'});
 assert.equal(f.workers.length,1);
});

function chatArchive(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{
  return {rows:db.prepare('SELECT seq,message_id FROM game_chat WHERE table_id=? ORDER BY seq').all(tableId),
   head:db.prepare('SELECT last_id FROM game_chat_heads WHERE table_id=?').get(tableId)?.last_id};
 }finally{db.close();}
}
test('S3 chatPage recovers from idle exit or posted lost ACK without duplicating archive rows or changing the head',{skip:!archivePath},async t=>{
 const f=await fixture(t);
 await fund(f.store,200);
 await registerRules(f);
 await createTable(f.store);
 await f.store.games.chat({tableId,submissionId:'chat-1',text:'hello',scope});
 await f.store.games.appendChat({tableId,id:'chat-2',characterId:scope.characterId,text:'reply'});
 const path=f.store.path;
 await f.store.close();
 // A legacy table can contain messages persisted before the archive head.
 const legacy=new DatabaseSync(path);
 try{
  const row=JSON.parse(legacy.prepare('SELECT value FROM game_tables WHERE id=?').get(tableId).value);
  row.chat.push({id:'legacy-unarchived',role:'user',text:'legacy',scope,at:now()});
  legacy.prepare('UPDATE game_tables SET value=? WHERE id=?').run(JSON.stringify(row),tableId);
 }finally{legacy.close();}
 assert.equal(chatArchive(path).head,'chat-2');
 const s=await f.open();
 f.crash('games.chatPage','afterCommit');
 const page=await s.games.chatPage(tableId);
 f.faultReached('games.chatPage','afterCommit');
 const archived=chatArchive(path),ids=['chat-1','chat-2','legacy-unarchived'];
 assert.deepEqual(page.messages.map(message=>message.id),ids);
 assert.deepEqual(archived.rows.map(row=>row.message_id),ids);
 assert.equal(archived.head,'legacy-unarchived');
 await f.worker.terminate();
 assert.deepEqual(await s.games.chatPage(tableId),page);
 assert.deepEqual(chatArchive(path),archived);
 assert.equal((await s.settings({autoEat:true})).autoEat,true);
});
test('S2 a live business rejection from the probe wins even if admission has since expired',async t=>{
 const f=await fixture(t),s=f.store;
 await s.initializeRewards();
 await s.ingestUsageFact(fact('source',20_000),trusted);
 let admissions=0;
 const submit=()=>s.ingestUsageFact(fact('source',10_000),trusted,{guard:()=>++admissions===1});
 f.crash('ingestUsageFact','errorAck');
 await assert.rejects(submit(),{code:'REWARD_FACT_CONFLICT',message:'同一用量版本存在冲突'});
 assert.equal(admissions,1);
 assert.deepEqual(probeCounts(f),[1,0,1]);
 assert.equal((await s.settings({autoEat:true})).autoEat,true);
});

test('S2 the probe leaves no SAVEPOINT and a failed replay rolls back the entire reward batch',async t=>{
 const f=await fixture(t),s=f.store;
 await s.initializeRewards();
 await s.ingestUsageFact(fact('source',20_000),trusted);
 const input=[fact('new',90_000),fact('source',10_000)];
 const view=s.view(scope);
 f.crash('ingestUsageFacts','errorAck');
 await assert.rejects(s.ingestUsageFacts(input,trusted),{code:'REWARD_FACT_CONFLICT'});
 f.faultReached('ingestUsageFacts','errorAck');
 assert.deepEqual(probeCounts(f),[1,0,1]);
 assert.deepEqual(s.view(scope),view);
 assert.equal(s.isRewardFactRecorded(input[0]),false);
 assert.equal((await s.ingestUsageFact(input[0],trusted)).wallet.balance,11);
});

for(const [failure,expectedCause] of [
 ['sqlite',{code:'ERR_SQLITE_ERROR',errcode:1}],
 ['sqliteReadOnly',{code:'ERR_SQLITE_ERROR',errcode:8}],
 ['unexpectedCode',{code:'GAME_TRANSACTION_ASYNC'}],
 ['secondTransport',null],
]){
 test('S2 '+failure+' during a receipt probe fails closed',async t=>{
  const f=await fixture(t,{probeFault:failure}),s=f.store;
  await s.ensureScope(scope);
  f.crash('mergeHunger','beforeCommit');
  await assert.rejects(s.mergeHunger(scope,hunger('uncertain')),error=>{
   if(expectedCause)assert.deepEqual(Object.fromEntries(Object.keys(expectedCause).map(key=>[key,error.cause?.[key]])),expectedCause);
   else assert.match(error.cause?.message??'',/did not acknowledge/);
   return error.code==='ECONOMY_WORKER_REOPEN';
  });
  f.faultReached('mergeHunger','beforeCommit');
  assert.equal(s.getHunger(scope,{create:false}).satiety,100);
  await assert.rejects(s.settings({autoEat:true}),{code:'ECONOMY_WORKER_REOPEN'});
  assert.equal(f.workers.length,2);
 });
}

function probeCounts(f){return Array.from(f.metrics);}
const batchRecoveryFailures=[
 ['late persisted fact conflict',store=>store.ingestUsageFact(fact('existing',20_000),trusted),
  [fact('new-prefix',90_000),fact('existing',10_000)]],
 ['late conflict with a prior revision in the same batch',()=>{},
  [fact('new-prefix',90_000),{...fact('same-batch',20_000),revision:2},{...fact('same-batch',10_000),revision:2}]],
];
for(const [label,setup,input] of batchRecoveryFailures){
 test('S2 review preserves '+label+' after losing the error ACK and expiring admission',async t=>{
  const f=await fixture(t),s=f.store;
  await s.initializeRewards();
  await setup(s);
  const original=await originalError(()=>s.ingestUsageFacts(input,trusted),'REWARD_FACT_CONFLICT');
  const before=s.view(scope);
  let admissions=0;
  f.crash('ingestUsageFacts','errorAck');
  await assert.rejects(s.ingestUsageFacts(input,trusted,{guard:()=>++admissions===1}),original);
  f.faultReached('ingestUsageFacts','errorAck');
  assert.equal(admissions,1);
  assert.deepEqual(probeCounts(f),[1,0,1]);
  assert.deepEqual(s.view(scope),before);
  assert.equal(s.isRewardFactRecorded(input[0]),false);
  assert.equal((await s.ingestUsageFact(input[0],trusted)).wallet.balance,before.wallet.balance+9);
 });
}
