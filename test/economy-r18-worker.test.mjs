import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {setTimeout as wait} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {block,observeEconomyRelease} from './fixtures/economy-release.mjs';
import {channel} from 'node:diagnostics_channel';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createEconomyStore as openSync} from '../src/companion-economy-store.mjs';

const scope={characterId:'person',personaId:'pet',lifeId:'life',operationId:'op'};
const player={...scope,id:'pet',kind:'ai'};
const clientUrl=new URL('../src/companion-economy-worker-client.mjs',import.meta.url);
const candidate=existsSync(clientUrl)?await import(clientUrl):null;
const openEconomy=candidate?.createEconomyStore??openSync;

test('the read-only store reads existing SQLite state without creating rows or running transactions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-reader-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const seed=openSync(root);
 seed.games.ensure(player);
 await seed.close();
 const commits=[],bus=channel('ai-buddy.companion.economy-sql'),record=event=>commits.push(event);
 bus.subscribe(record);
 let reader;
 try{
  reader=openSync(root,{readOnly:true});
  assert.equal(reader.view(scope).hunger,null);
  assert.equal(reader.getHunger(scope,{create:true}),null);
  assert.equal(reader.getHunger(scope,{create:false}),null);
  assert.equal(reader.snapshot(scope).satiety,100);
  assert.equal(reader.view(scope).hunger,null);
  assert.deepEqual(reader.wallet(),{balance:0,remainder:0,debtUnits:0});
  assert.equal(reader.settings().autoEat,false);
  assert.equal(reader.ledgerPage().total,0);
  assert.deepEqual(reader.pendingMeals(scope),[]);
  assert.equal(reader.autoSession(scope),null);
  assert.equal(reader.getMeal('absent'),null);
  assert.equal(reader.isRewardFactRecorded({canonicalRequestId:'absent',totalTokens:1}),false);
  assert.deepEqual(reader.games.list(),[]);
  assert.equal(reader.games.account(player).balance,0);
  assert.throws(()=>reader.games.table('absent'),{code:'GAME_TABLE_NOT_FOUND'});
  assert.throws(()=>reader.games.tableMetadata('absent'),{code:'GAME_TABLE_NOT_FOUND'});
  assert.deepEqual(reader.games.outbox(),[]);
  assert.deepEqual(reader.games.pendingRelationshipFacts(),[]);
  assert.equal(reader.games.relationshipProgress('texas',player).completed,0);
  assert.equal(reader.games.tableHold('absent',player),0);
  assert.equal(reader.games.entryEligibility(player).available,0);
  assert.equal(reader.games.held('user'),0);
  assert.match(reader.games.accountId(player),/^ai:/);
  assert.equal(reader.games.snapshotBalance(scope),0);
  assert.equal(reader.games.replay('absent'),null);
  assert.equal(reader.games.commandReceipt('absent'),null);
  assert.equal(reader.games.binding('absent'),null);
  assert.equal(reader.games.request('absent'),null);
  assert.doesNotThrow(()=>reader.games.assertLifeClear(scope.characterId));
  assert.throws(()=>reader.games.project({},'user'),{code:'GAME_RULES_UNAVAILABLE'});
  assert.deepEqual(commits,[]);
 }finally{
  await reader?.close();
  bus.unsubscribe(record);
 }
});

test('a 300 ms SQLite RELEASE stall leaves synchronous reads and the main event loop responsive',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-release-'));
 const workerFactory=(_url,options)=>new Worker(new URL('./fixtures/economy-worker-fault.mjs',import.meta.url),{
  ...options,workerData:{...options.workerData,fault:{op:'mergeHunger',phase:'before',ms:300}}
 });
 const economy=await openEconomy(root,{workerFactory});
 let restore=null,timer=null;
 try{
  await economy.ensureScope(scope);
  if(!candidate){
   let once=true;
   restore=observeEconomyRelease(phase=>{if(phase==='before'&&once){once=false;block(300);}});
  }
  let last=performance.now(),max=0,views=0;
  timer=setInterval(()=>{
   const at=performance.now();
   max=Math.max(max,at-last);
   last=at;
   economy.view(scope);
   views++;
  },5);
  await wait(20);
  const started=performance.now();
  await economy.mergeHunger(scope,{requestId:'stall',decay:10});
  assert.ok(performance.now()-started>=290,'the SQLite stall was injected');
  assert.equal(economy.getHunger(scope,{create:false}).satiety,90);
  await wait(20);
  t.diagnostic('max event-loop interval: '+max.toFixed(2)+' ms; views: '+views);
  assert.ok(max<=50,'event loop interval was '+max.toFixed(2)+' ms');
  assert.ok(views>=10,'reads executed while the writer was stalled');
 }finally{
  clearInterval(timer);
  restore?.();
  await economy.close();
  await rm(root,{recursive:true,force:true});
 }
});

test('queued guards run at admission to the writer and thenable guards cannot authorize a write',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-guard-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 let alive=true;
 const seen=[];
 const economy=await openEconomy(root,{audit:event=>seen.push(event),walMaintenanceIntervalMs:20});
 try{
  await economy.ensureScope(scope);
  const accepted=economy.mergeHunger(scope,{requestId:'accepted',decay:6});
  const stale=economy.mergeHunger(scope,{requestId:'stale',decay:7},{guard:()=>alive});
  const rejected=economy.mergeHunger(scope,{requestId:'rejected',decay:8},{guard:async()=>false});
  const last=economy.mergeHunger(scope,{requestId:'last',decay:9});
  alive=false;
  const closing=economy.close();
  const results=await Promise.allSettled([accepted,stale,rejected,last]);
  assert.deepEqual(results.map(row=>row.status),['fulfilled','rejected','rejected','fulfilled']);
  assert.equal(results[2].reason.code,'ECONOMY_GUARD_REJECTED');
  assert.equal(results[3].value.satiety,85);
  await assert.rejects(economy.ensureScope(scope),{code:'ECONOMY_CLOSED'});
  assert.strictEqual(economy.close(),closing);
  await closing;
  assert.ok(seen.some(event=>event.reason==='close'&&event.status==='checkpointed'&&event.thread==='economy-worker'));
 }finally{await economy.close();}
});

test('an incompatible economy is rejected before the writer mutates its database or exposes a reader',async t=>{
 const root=await mkdtemp(join(tmpdir(),'buddy-r18-incompatible-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const initial=openSync(root);
 await initial.close();
 const data=new DatabaseSync(initial.path);
 data.exec("PRAGMA journal_mode=DELETE; UPDATE meta SET value='999' WHERE key='schemaVersion'");
 data.close();
 const original=await readFile(initial.path);
 let stopped;
 const workerFactory=(url,options)=>{
  const worker=new Worker(url,options);
  stopped=new Promise(resolve=>worker.once('exit',resolve));
  return worker;
 };
 await assert.rejects(openEconomy(root,{workerFactory}),{code:'ECONOMY_SCHEMA_UNSUPPORTED'});
 assert.ok(Number.isInteger(await stopped));
 assert.deepEqual(await readFile(initial.path),original);
});
