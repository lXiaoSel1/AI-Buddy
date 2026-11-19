import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {channel} from 'node:diagnostics_channel';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import {pathToFileURL} from 'node:url';
import {Worker} from 'node:worker_threads';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {economyWrites} from '../src/companion-economy-operations.mjs';
import {createCgRewardFacts} from '../src/cg-reward-facts.mjs';
import {createEconomyStore as openSync} from '../src/companion-economy-store.mjs';
import {gameRulesRegistration,importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';

const now=()=>1_800_000_000_000;
const scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
const ai={...scope,id:'ai',kind:'ai'};
const user={id:'user',kind:'user',personaId:'persona'};
const other={...ai,id:'other',characterId:'other'};
const target={...scope,lifeId:'restored',operationId:'restore-op'};
const fact=(id,units)=>({canonicalRequestId:id,totalTokens:units,scope});
const archivePath=process.env.AI_BUDDY_R18_CARD_ARTIFACT;
const operations=Object.keys(economyWrites);
const loadArtifact=async root=>importVerifiedGameRules({
 archivePath,archiveSha256:createHash('sha256').update(await readFile(archivePath)).digest('hex'),cacheRoot:join(root,'rules')
});

function contents(path){
 const db=new DatabaseSync(path,{readOnly:true});
 try{return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
  .map(({name})=>[name,db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]);}
 finally{db.close();}
}

async function runTrace(root,phase,artifact){
 const control=new Int32Array(new SharedArrayBuffer(8));
 const faulted=new Set(),commits=[],sql=channel('ai-buddy.companion.economy-sql'),record=commit=>commits.push(commit);
 sql.subscribe(record);
 const options={now,workerFactory:(_url,options)=>{
  const worker=new Worker(new URL('./fixtures/economy-worker-fault.mjs',import.meta.url),{
   ...options,workerData:{...options.workerData,crash:control.buffer}
  });
  const post=worker.postMessage.bind(worker);
  worker.postMessage=message=>post(message.seed?{...message,seed:'1'.repeat(64)}:message);
  return worker;
 }};
 let store;
 async function attempt(op,...args){
  const game=op.startsWith('games.');
  const invoke=()=> (game?store.games:store)[game?op.slice(6):op](...args);
  if(!phase)return invoke();
  Atomics.store(control,1,phase);
  Atomics.store(control,0,operations.indexOf(op)+1);
  if(economyWrites[op].retry){
   const result=await invoke();
   assert.equal(Atomics.load(control,0),0,op+' did not reach the crash point');
   faulted.add(op);
   return result;
  }
  await assert.rejects(invoke(),{code:'ECONOMY_WORKER_REOPEN'},op);
  assert.equal(Atomics.load(control,0),0,op+' did not reach the crash point');
  faulted.add(op);
  await assert.rejects(store.ensureScope(scope),{code:'ECONOMY_WORKER_REOPEN'});
  await store.close();
  store=await createEconomyStore(root,options);
  if(artifact)await store.games.registerRules(artifact);
  if(phase===1)await invoke();
 }
 try{
  store=await createEconomyStore(root,options);
  assert.equal(store.settleHunger,undefined);
  await attempt('settings',{autoEat:true,autoBuyRice:true,allowedFoods:['rice']});
  await attempt('ensureScope',scope);
  await attempt('getHunger',{...scope,lifeId:'unused'});
  await attempt('mergeHunger',scope,{requestId:'hunger',decay:30,at:now()});
  await attempt('initializeRewards');
  await attempt('ingestUsageFact',fact('fund',5_000_000),{trusted:true});
  await attempt('ingestUsageFacts',[fact('fund-extra',6_000_000)],{trusted:true});
  await attempt('purchase',{scope,foodId:'rice',requestId:'purchase'});
  await attempt('consume',{scope,foodId:'rice',requestId:'meal',hunger:{requestId:'meal-hunger',decay:5}});
  await attempt('purchaseAndConsumeRice',{scope,requestId:'auto-meal',hunger:{requestId:'auto-hunger',decay:40}});
  await attempt('updateMeal','meal',{attempts:1,retryAt:now()});
  await attempt('saveAuto',{id:'auto',scope,state:'active',at:now()});
  const rollback={transactionId:'life-rebind'};
  await store.prepareLife({...rollback,scope,target:{scope:target,satiety:33}});
  await store.recoverLife({...rollback,decision:'rollback'});
  const rollbackScope={...scope,operationId:'rollback-op'};
  await attempt('rebindPendingMeals',{...rollback,beforeScope:scope,rollbackScope});
  assert.throws(()=>store.snapshot(scope),{code:'FEEDING_STALE_SCOPE'});
  const life={scope:rollbackScope,target:{scope:target,satiety:33}};
  const first={transactionId:'life-1'};
  await attempt('prepareLife',{...life,...first});
  await attempt('applyLife',first);
  await attempt('finalizeLife',first);
  const second={transactionId:'life-2'};
  await store.prepareLife({...life,...second});
  await store.applyLife(second);
  await attempt('recoverLife',{...second,decision:'rollback'});
  await attempt('games.ensure',other);
  await attempt('games.welfare',ai,'welfare');
  await attempt('games.restoreAccount',{commandId:'restore',player:other,balance:250});
  if(artifact){
   const tableId='texas-table';
   await attempt('games.registerRules',artifact);
   await attempt('games.create',{tableId,commandId:'create',type:'texas',players:[user,ai],buyIn:200});
   let table=store.games.table(tableId);
   await attempt('games.action',{tableId,commandId:'fold',expectedVersion:table.version,action:{type:'fold',actorId:table.state.actorId}});
   table=store.games.table(tableId);
   await attempt('games.next',{tableId,commandId:'next',expectedVersion:table.version});
   table=store.games.table(tableId);
   await attempt('games.control',{tableId,commandId:'pause',expectedVersion:table.version,op:'pause'});
   await attempt('games.chat',{tableId,submissionId:'chat',text:'hello',scope});
   await attempt('games.appendChat',{tableId,id:'append',characterId:'character',text:'hi'});
   const event=store.games.outbox()[0];
   await attempt('games.acknowledge',event.id,{recorded:true,eventId:event.id});
   await attempt('games.chatPage',tableId);
  }
  await attempt('games.binding',{id:'binding',scope});
  await attempt('games.request',{id:'request',state:'queued',fingerprint:'request'});
  await attempt('games.recover');
  assert.ok(commits.length>0);
  assert.ok(commits.every(commit=>commit.thread==='economy-worker'&&commit.threadId>0));
  const path=store.path;
  await store.close();
  assert.deepEqual([...faulted].sort(),phase?operations.filter(name=>artifact||![
   'games.registerRules','games.create','games.action','games.next','games.control',
   'games.chat','games.appendChat','games.acknowledge','games.chatPage'
  ].includes(name)).sort():[]);
  return contents(path);
 }finally{
  await store?.close();
  sql.unsubscribe(record);
 }
}

test('every classified write remains consistent when the worker dies before commit or after commit before ACK',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-crashes-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const artifact=archivePath?await loadArtifact(root):null;
 t.diagnostic(artifact?'approved card bundle '+artifact.sha256:'card rules receipt fixture requires AI_BUDDY_R18_CARD_ARTIFACT');
 const control=await runTrace(join(root,'control'),0,artifact);
 assert.deepEqual(await runTrace(join(root,'before'),1,artifact),control);
 assert.deepEqual(await runTrace(join(root,'after'),2,artifact),control);
});

const testSeed='1'.repeat(64);
function fixedDraw(seed=testSeed){
 let sequence=0;
 return {
  reset(){sequence=0;},
  integer(max){
   const span=0x1_0000_0000,limit=span-span%max;
   for(;;){
    const value=createHmac('sha256',seed).update(String(sequence++)).digest().readUInt32BE(0);
    if(value<limit)return value%max;
   }
  }
 };
}
async function playHands(store,artifact,{resetDraw,deckFor},type,players){
 const {games}=store,tableId=type+'-table',hands=[];
 resetDraw();
 let current=await games.create({tableId,type,players,buyIn:200,commandId:type+':create',deck:deckFor?.(type)});
 for(let hand=1;hand<=3;hand++){
  for(let i=0;current.status==='active'&&i<100;i++){
   const state=current.state,actorId=state.actorId;
   const actions=artifact.module.legalActions(state,actorId);
   let action;
   if(type==='texas')action=actions.find(value=>value.type==='fold');
   else if(state.phase==='calling')action=actions.find(value=>value.type==='call-landlord');
   else if(state.phase==='robbing')action=actions.find(value=>value.type==='decline');
   else if(state.phase==='doubling')action=actions.find(value=>value.type==='double'&&value.factor===1);
   else action=actions.find(value=>value.type==='pass')??actions.sort((a,b)=>b.cards.length-a.cards.length)[0];
   current=await games.action({tableId,commandId:type+':'+hand+':'+i,expectedVersion:current.version,action:{...action,actorId}});
  }
  assert.equal(current.status,'completed');
  const replay=games.replay(current.state.handId);
  assert.equal(replay.settlement.completed,true);
  assert.equal(Object.values(replay.settlement.deltasByPlayer).reduce((sum,value)=>sum+value,0),0);
  hands.push(replay.handId);
  if(hand<3){
   resetDraw();
   current=await games.next({tableId,expectedVersion:current.version,commandId:type+':hand-'+(hand+1),deck:deckFor?.(type)});
  }
 }
 await games.control({tableId,expectedVersion:current.version,commandId:type+':close',op:'close'});
 assert.equal(new Set(hands).size,3);
}
async function playEconomyScenario(dataRoot,store,artifact,{resetDraw=()=>{},deckFor,legacyHunger=false}={}){
 const settle=(requestId,decay)=>legacyHunger
  ?store.settleHunger(scope,{elapsedMs:decay/8*3_600_000})
  :store.mergeHunger(scope,{requestId,decay,at:now()});
 const cg=createCgRewardFacts({dataRoot,now,onRewardFact:value=>store.ingestUsageFact(value,{trusted:true})});
 try{
  await store.ensureScope(scope);
  await store.initializeRewards({facts:[fact('baseline',25_000)],cursor:'start'});
  await store.ingestUsageFacts([fact('fund',55_000_000),fact('extra',21_150)],{trusted:true});
  await cg.initialize([]);
  cg.registerJob({id:'cg-fixture',rewardScope:scope});
  await cg.observeJob({id:'cg-fixture',status:'ready',sha256:'a'.repeat(64),assetRef:'cg-assets/fixture/image.png',completedAt:now(),rewardScope:scope});
  await cg.recordUsage({cgJobId:'cg-fixture',usageReceiptId:'cg-actual',usage:{total_tokens:47_250}});
  assert.deepEqual(cg.pending(),[]);
  await settle('hunger',70);
  await store.purchase({scope,foodId:'rice',requestId:'buy'});
  if(legacyHunger)await settle('pre-manual',4);
  assert.equal((await store.consume({scope,foodId:'rice',requestId:'manual',hunger:{requestId:'pre-manual',decay:4}})).satiety,61);
  await store.settings({autoEat:true,autoBuyRice:true,allowedFoods:['rice']});
  await store.saveAuto({id:'auto',scope,state:'active',at:now()});
  if(legacyHunger)await settle('pre-auto',9);
  assert.equal((await store.purchaseAndConsumeRice({scope,requestId:'automatic',sessionId:'auto',hunger:{requestId:'pre-auto',decay:9}})).satiety,87);
  const saved=store.snapshot(scope),target={...saved,scope:{...saved.scope,lifeId:'next-life',operationId:'next-op'},mealEvidence:[]};
  await store.prepareLife({transactionId:'life-commit',scope,target});
  await store.applyLife({transactionId:'life-commit'});
  await store.finalizeLife({transactionId:'life-commit'});
  await store.prepareLife({transactionId:'life-rollback',scope,target:{...target,satiety:5}});
  await store.applyLife({transactionId:'life-rollback'});
  await store.recoverLife({transactionId:'life-rollback',decision:'rollback'});
  assert.equal(store.getHunger(target.scope,{create:false}).satiety,87);
  await playHands(store,artifact,{resetDraw,deckFor},'doudizhu',[user,ai,other]);
  await playHands(store,artifact,{resetDraw,deckFor},'texas',[user,ai]);
  return {wallet:store.wallet(),satiety:store.getHunger(scope,{create:false}).satiety};
 }finally{try{await cg.close();}finally{await store.close();}}
}

async function openScenarioWorker(root,artifact,seed=testSeed){
 const worker=await createEconomyStore(root,{now,workerFactory:(url,options)=>{
  const thread=new Worker(url,options),post=thread.postMessage.bind(thread);
  thread.postMessage=message=>post(message.seed?{...message,seed}:message);
  return thread;
 }});
 await worker.games.registerRules(artifact);
 return worker;
}

test('in-process economy and dedicated writer persist the same CG, meals, life transactions and six completed hands',{skip:!archivePath},async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-differential-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const artifact=await loadArtifact(root);
 const referenceRoot=join(root,'reference'),workerRoot=join(root,'worker'),draw=fixedDraw();
 const reference=openSync(referenceRoot,{now,randomInt:draw.integer});
 reference.games.registerRules(gameRulesRegistration(artifact));
 const expected=await playEconomyScenario(referenceRoot,reference,artifact,{resetDraw:draw.reset});
 const worker=await openScenarioWorker(workerRoot,artifact);
 const actual=await playEconomyScenario(workerRoot,worker,artifact);
 const candidate=contents(worker.path);
 assert.deepEqual(actual,expected);
 assert.deepEqual(candidate,contents(reference.path));
 t.diagnostic('3 completed hands per game; '+candidate.length+' tables; '+candidate.reduce((total,[,rows])=>total+rows.length,0)+' matched rows');

 const r4Root=process.env.AI_BUDDY_R18_R4_ROOT;
 if(!r4Root)return;
 const {createEconomyStore:openR4}=await import(pathToFileURL(join(r4Root,'src','companion-economy-store.mjs')).href);
 const r4Fresh=openR4(join(root,'r4-fresh'),{now});
 await r4Fresh.close();
 const schema=path=>{
  const db=new DatabaseSync(path,{readOnly:true});
  try{return db.prepare("SELECT name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all();}
  finally{db.close();}
 };
 assert.deepEqual(schema(worker.path),schema(r4Fresh.path));
 const compatibility=openR4(workerRoot,{now});
 try{
  assert.equal(compatibility.view(scope).schemaVersion,2);
  assert.deepEqual(compatibility.wallet(),actual.wallet);
  assert.equal(compatibility.getHunger(scope,{create:false}).satiety,actual.satiety);
  assert.equal(compatibility.games.list().length,2);
 }finally{await compatibility.close();}
 assert.deepEqual(contents(worker.path),candidate);
 t.diagnostic('r4 opened the worker-authored DB, read current rows, and preserved existing schema and rows');
});

const r17Commit='d560256ef399646b583ebdaae7be59d973c7e510';
const r17Repo=process.env.AI_BUDDY_R18_R17_REPO;
const r17Files=[
 'src/companion-economy-store.mjs','src/companion-economy-sql.mjs',
 'src/companion-economy-wal.mjs','src/companion-economy-wal-worker.mjs',
 'src/food-catalog.mjs','src/local-day.mjs','src/reward-facts.mjs',
 'src/voice-games/game-economy.mjs','src/voice-games/game-presentation.mjs',
 'src/voice-games/next-hand.mjs','src/voice-games/prompts.mjs',
 'src/voice-games/rules/common.mjs','src/voice-games/rules/doudizhu.mjs','src/voice-games/rules/texas.mjs'
];
async function extractR17(sourceRoot){
 const manifest=[];
 for(const file of r17Files){
  const exact=execFileSync('git',['-C',r17Repo,'show',r17Commit+':'+file],{windowsHide:true});
  const path=join(sourceRoot,file);
  await mkdir(dirname(path),{recursive:true});
  await writeFile(path,exact);
  manifest.push(createHash('sha256').update(exact).digest('hex')+'  '+file);
 }
 return {manifest,module:await import(pathToFileURL(join(sourceRoot,r17Files[0])).href)};
}
function pinnedDeck(artifact,type,seed){
 const deck=[...artifact.module.STANDARD_DECK[type]],{integer}=fixedDraw(seed);
 for(let i=deck.length-1;i>0;i--){
  const j=integer(i+1);
  [deck[i],deck[j]]=[deck[j],deck[i]];
 }
 // These are the seats the frozen core chooses for an explicit synthetic deck.
 const players=type==='doudizhu'?3:2;
 assert.equal(integer(players),0);
 assert.equal(integer(players),0);
 return deck;
}
function normalizeExpectedDifferences(candidate){
 const merges={hunger:30,'pre-manual':26,'pre-auto':52};
 const links={manual:'pre-manual',automatic:'pre-auto'};
 return candidate.map(([table,rows])=>{
  if(table==='meals'){
   assert.deepEqual(rows.map(row=>row.id),['manual','automatic']);
   return [table,rows.map(row=>{
    const meal=JSON.parse(row.value);
    assert.equal(row.affection_state,'cancelled');
    assert.equal(row.retry_at,null);
    assert.equal(meal.affectionState,'cancelled');
    assert.equal(meal.retryAt,null);
    assert.equal(meal.error,'角色人生上下文已经失效');
    delete meal.error;
    meal.affectionState='pending';
    return Object.assign(Object.create(null),row,{affection_state:'pending',value:JSON.stringify(meal)});
   })];
  }
  if(table!=='commands')return [table,rows];
  const accrual=rows.filter(row=>row.kind==='hunger-merge');
  assert.deepEqual(accrual.map(row=>row.id),Object.keys(merges));
  for(const row of accrual){
   assert.equal(row.at,now());
   const decay={hunger:70,'pre-manual':4,'pre-auto':9}[row.id];
   const at=row.id==='hunger'?now():undefined;
   assert.equal(row.fingerprint,createHash('sha256').update(JSON.stringify({scope,decay,at})).digest('hex'));
   assert.deepEqual(JSON.parse(row.result),{scope,satiety:merges[row.id],updatedAt:now()});
  }
  const common=rows.filter(row=>row.kind!=='hunger-merge').map(row=>{
   if(!Object.hasOwn(links,row.id))return row;
   const {hungerRequestId,...original}=JSON.parse(row.result);
   assert.equal(hungerRequestId,links[row.id]);
   return Object.assign(Object.create(null),row,{result:JSON.stringify(original)});
  });
  return [table,common];
 });
}

test('pinned r17 process-local implementation agrees with r18 for all common persisted operations apart from the specified differences',{skip:!archivePath||!r17Repo},async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-r17-equivalence-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const artifact=await loadArtifact(root);
 const frozen=await extractR17(join(root,'source-r17'));
 const r17Root=join(root,'reference'),workerRoot=join(root,'worker');
 const r17=frozen.module.createEconomyStore(r17Root,{now});
 r17.games.registerRules({...gameRulesRegistration(artifact),synthetic:true});
 // This fixture seed gives initial caller/button zero for both games after shuffle.
 const seed='74'.padStart(64,'0');
 const expected=await playEconomyScenario(r17Root,r17,artifact,{
  legacyHunger:true,deckFor:type=>pinnedDeck(artifact,type,seed)
 });
 const worker=await openScenarioWorker(workerRoot,artifact,seed);
 const actual=await playEconomyScenario(workerRoot,worker,artifact);
 const common=normalizeExpectedDifferences(contents(worker.path)),reference=contents(r17.path);
 assert.deepEqual(actual,expected);
 assert.deepEqual(common,reference);
 t.diagnostic('Pinned r17 '+r17Commit+'; 3 completed hands per game; '+common.length+
  ' tables; '+common.reduce((total,[,rows])=>total+rows.length,0)+' exact common rows');
 t.diagnostic('Specified differences verified: 3 hunger-merge commands, 2 consume hungerRequestId receipt fields, and 2 obsolete meals cancelled by r19');
 t.diagnostic('Frozen source SHA-256 files:\n'+frozen.manifest.join('\n'));
});
