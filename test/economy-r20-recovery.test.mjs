import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {Worker} from 'node:worker_threads';
import {createEconomyStore} from '../src/companion-economy-worker-client.mjs';
import {economyWrites} from '../src/companion-economy-operations.mjs';
import {importVerifiedGameRules} from '../src/voice-games/rule-artifact.mjs';

const scope={characterId:'character',personaId:'persona',lifeId:'life',operationId:'operation'};
const nodeNow=()=>1_800_000_000_000;
const operations=Object.keys(economyWrites);
const archivePath=process.env.AI_BUDDY_R18_CARD_ARTIFACT;
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'buddy-r20-receipt-'));
 const control=new Int32Array(new SharedArrayBuffer(8));
 let store;
 const open=async()=>store=await createEconomyStore(root,{now:nodeNow,workerFactory:(url,options)=>new Worker(new URL('./fixtures/economy-worker-fault.mjs',import.meta.url),{
  ...options,workerData:{...options.workerData,crash:control.buffer,...process.env.AI_BUDDY_R20_BASELINE_WORKER&&{workerModulePath:process.env.AI_BUDDY_R20_BASELINE_WORKER}}
 })});
 await open();
 t.after(async()=>{try{await store?.close();}finally{await rm(root,{recursive:true,force:true});}});
 return {get store(){return store;},root,control,open,loseErrorAck(op){Atomics.store(control,1,4);Atomics.store(control,0,operations.indexOf(op)+1);},assertLost(){assert.equal(Atomics.load(control,0),0);}};
}

test('T2 invalid packages lost ACK returns original validation and keeps the writer usable',async t=>{
 const f=await fixture(t),s=f.store;
 const request={scope,foodId:'rice',packages:0,requestId:'invalid-buy'};
 await assert.rejects(s.purchase(request),{message:'购买包数无效'});
 f.loseErrorAck('purchase');
 await assert.rejects(s.purchase(request),{code:'FOOD_PACKAGES_INVALID',message:'购买包数无效'});
 f.assertLost();
 await s.initializeRewards();
 assert.equal((await s.settings({autoEat:true})).autoEat,true);
});

test('T2 a persisted unsupported game phase keeps its rule error after lost ACK',{skip:!archivePath},async t=>{
 const f=await fixture(t);
 await f.store.initializeRewards();
 await f.store.ingestUsageFact({canonicalRequestId:'game-funds',totalTokens:500_000,scope},{trusted:true});
 const artifact=await importVerifiedGameRules({archivePath,archiveSha256:createHash('sha256').update(await readFile(archivePath)).digest('hex'),cacheRoot:join(f.root,'rules')});
 await f.store.games.registerRules(artifact);
 const table=await f.store.games.create({commandId:'game-create',tableId:'game-table',type:'doudizhu',
  players:[{id:'user',kind:'user',personaId:'persona'},{id:'ai-one',kind:'ai',...scope},
   {id:'ai-two',kind:'ai',characterId:'other-character',personaId:'persona',lifeId:'life',operationId:'operation'}]});
 const economyPath=f.store.path;
 await f.store.close();
 const db=new DatabaseSync(economyPath);
 try{
  const persisted=JSON.parse(db.prepare('SELECT value FROM game_tables WHERE id=?').get(table.id).value);
  persisted.state.phase='r20-unsupported-phase';
  db.prepare('UPDATE game_tables SET value=? WHERE id=?').run(JSON.stringify(persisted),table.id);
 }finally{db.close();}
 await f.open();await f.store.games.registerRules(artifact);
 const request={tableId:table.id,commandId:'unsupported-phase-action',expectedVersion:table.version,
  action:{type:'decline',actorId:table.state.actorId}};
 let original;
 await assert.rejects(f.store.games.action(request),error=>{original={code:error.code,message:error.message};return error.code==='GAME_PHASE_INVALID'&&error.message==='Unsupported phase';});
 f.loseErrorAck('games.action');
 await assert.rejects(f.store.games.action(request),original);
 f.assertLost();
 assert.equal((await f.store.settings({autoEat:true})).autoEat,true);
});

test('T2 every explicit economy-path code has exactly one documented disposition',async()=>{
 const {businessReceiptCodes,failClosedCodes}=await import('../src/companion-economy-error-codes.mjs');
 const {scanEconomyErrorCodes}=await import('./support/economy-r21-error-scan.mjs');
 const report=await scanEconomyErrorCodes();
 assert.ok(report.files.includes('src/companion-economy-worker.mjs'));
 assert.ok(report.files.includes('src/voice-games/rules/texas.mjs'));
 assert.deepEqual(report.codes.filter(code=>businessReceiptCodes.has(code)===failClosedCodes.has(code)),[]);
 assert.deepEqual(report.uncoded,[],'worker-executed write validation must carry stable codes');
 assert.ok([...failClosedCodes.values()].every(reason=>typeof reason==='string'&&reason.length>8));
});
